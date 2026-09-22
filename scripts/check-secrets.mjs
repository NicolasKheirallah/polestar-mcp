/**
 * Secret-hygiene gate.
 *
 * Needles are generic shapes, never values. A scanner that embeds the owner's
 * real email, VIN or client id becomes the leak it exists to catch, so this
 * file matches structure only: JWT segments, long opaque credential strings,
 * VIN-shaped identifiers. It also flags a live captured dump parked inside the
 * project tree, by path, never by content.
 *
 * Positive control runs first: every shape detector must fire on a synthetic
 * sample, otherwise a clean scan would mean nothing. Prints SECRETS_CLEAN only
 * when all controls passed and the scan found nothing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// Dependency and tool stores: third-party content that no project edit controls,
// where hash-like blobs match the credential shapes by accident. `.npm-cache`
// appears because CI may run npm with a workspace-local cache.
const SKIP_DIRS = new Set(['node_modules', 'build', '.git', '.npm-cache', '.unlazy', 'dist']);
// A PDF is a binary container. Its bytes decoded as text are noise that matches
// the shape detectors by accident, and its real text can sit in compressed
// streams the detectors can never see, so a scan proves nothing in either
// direction. Same class as the image formats next to it.
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.ico', '.map', '.pdf']);
// The checker necessarily holds the patterns; excluding it is not a loophole,
// it carries the needles and never the secrets.
const SELF = path.resolve(fileURLToPath(import.meta.url));

// Sanctioned homes for credentials: never scanned, and reported if committed.
// A pattern, not a list: `.env.production` holds a live token just as well as
// `.env.secrets` does, and naming each file is how the next one slips through.
const SECRET_FILE_PATTERN = /^\.env([.-]|$)|\.(env|secrets|credentials)$/i;

// Templates are the one class of `.env*` file that belongs in the tree: their job
// is to tell a reader which variables to set. Matched by suffix class, not by
// filename, so the next `.env.sample` added is covered without editing this line.
const TEMPLATE_SUFFIX_PATTERN = /\.(example|sample|template)$/i;

const JWT_LIKE = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
// Lowercase alnum blobs of 25-40 chars are the shape Apigee consumer keys and
// secrets take. The trailing boundary stops base64 image payloads matching.
const OPAQUE_CREDENTIAL = /\b[a-z0-9]{25,40}\b(?=["',\s]|$)/g;
// Any 17-char vehicle identifier, not one specific car.
const VIN_SHAPE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
// A run longer than a VIN, which is how the boundary-anchored shape above stays
// blind: a spec code beginning with a real VIN has no word boundary after those
// 17 characters, so it matched nothing while the gate printed clean.
const VIN_RUN = /\b[A-HJ-NPR-Z0-9]{18,}\b/g;
// Test doubles are declared synthetic by prefix, and a VIN-shaped suffix carried on
// a synthetic value is still a test double.
const SYNTHETIC_PREFIX = /^YSMTEST|YSMTEST$/;
// A field of one repeated character is padding. The synthetic dump is full of
// zero-filled identifiers, and reading them as vehicle ids would bury real hits.
const REPETITIVE_RUN = /^(.)\1*$/;

function vinInsideLongerToken(content) {
  const runs = [];
  for (const m of content.matchAll(VIN_RUN)) {
    const run = m[0];
    if (REPETITIVE_RUN.test(run) || SYNTHETIC_PREFIX.test(run)) continue;
    runs.push(run);
  }
  return runs;
}

// Test doubles need a VIN-shaped constant to exercise the API contract. The
// YSMTEST prefix is this project's declared synthetic marker and cannot be a
// real Polestar identifier, so it is allowed; every other 17-char match is
// treated as a genuine VIN. A credential file or JWT in a test is still caught.
const SYNTHETIC_VIN = /^YSMTEST\d{2}PL\d+$/;

// A person's address. Test doubles use reserved example domains and are allowed.
// The final label must be alphabetic: without that, npm pins read as addresses
// (`zod@4.6.5` looks like a name at a two-dot host) and a rule that cries wolf
// on the project's own documentation is a rule that gets switched off.
const EMAIL_SHAPE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
// E.164-ish dial strings: plus, then 8+ digits with optional separators.
const PHONE_SHAPE = /\+\d[\d\s().-]{7,}\d/g;
// A position precise enough to find a driveway. Bound to coordinate key names,
// because float artifacts elsewhere (odometres, kWh averages) legitimately
// reach five decimals and would otherwise bury the finding in noise.
const PRECISE_COORDINATE = /"(?:latitude|longitude|lat|lon|lng)":\s*-?\d+\.\d{5,}/g;
const RESERVED_EMAIL_DOMAIN = /@(example\.(com|org|net|edu)|localhost|test|invalid)\b/i;
// A live endpoint capture is itself a credential: refresh token plus weeks of
// position history. Its manifest names it, so this stays content-shaped and
// never embeds a value from the capture it guards against.
const DUMP_CONTENT_MARKERS = /"(dump_created_at|target_vin)"\s*:/g;
const DUMP_PATH = /(?:^|\/)consumer\/userinfo\.json$/;

const DETECTORS = [
  ['jwt-like-token', JWT_LIKE],
  ['opaque-credential-shape', OPAQUE_CREDENTIAL],
  ['vin-shaped-identifier', VIN_SHAPE, { allow: SYNTHETIC_VIN }],
  ['personal-email-address', EMAIL_SHAPE, { allow: RESERVED_EMAIL_DOMAIN }],
  ['phone-number', PHONE_SHAPE],
  ['precise-coordinate', PRECISE_COORDINATE],
];

// Synthetic positives. Fake by construction, so they leak nothing while proving
// each detector can actually fire.
const CONTROLS = [
  // Header and payload are real base64url JSON; the signature is filler. All
  // three segments must clear their minimum length for this to be a fair test.
  ['jwt-like-token', 'header eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMtdGVzdC10b2tlbiIsImF1ZCI6ImNvbnRyb2wifQ.Y3l0aGVuZXNpZy1maWxsZXItZm9yLWNvbnRyb2w'],
  ['opaque-credential-shape', 'client_id: "abcdefghij1234567890klmnopqrst"'],
  // A 17-char identifier from the VIN alphabet that the allow-rule does NOT
  // exempt, so this proves the detector as it actually runs. The old control
  // used the synthetic YSMTEST fixture value, which the allow-rule permits: the
  // positive control passed while the effective detector was never exercised.
  ['vin-shaped-identifier', 'vin: "TESTCNTRL12345678"'],
  ['personal-email-address', 'owner: "someone.person@domainholder.se"'],
  ['phone-number', 'mobile: "+46 70 555 0123"'],
  ['precise-coordinate', '"latitude": 57.74275836282063'],
];

// Each allow-rule is proven too: an over-broad exemption would silently turn a
// detector off, which is the failure mode that matters most here.
const NEGATIVE_CONTROLS = [
  ['personal-email-address', 'contact: "fleet-partner@example.com"'],
  // Verbatim from this repo's own upgrade research: version pins are not people.
  ['personal-email-address', 'depends on `@modelcontextprotocol/sdk@2.0.0` and `zod@4.6.5`'],
  ['vin-shaped-identifier', 'fixture: "YSMTEST22PL000001"'],
];

for (const [name, sample] of CONTROLS) {
  const found = DETECTORS.find(([n]) => n === name);
  const [, re, opts] = found ?? [];
  if (!re || matchedLines(sample, re, opts?.allow).length === 0) {
    console.error(`CONTROL_FAIL: ${name} does not fire on its synthetic sample, scan results are untrustworthy.`);
    process.exit(1);
  }
}

// The window rule is not a single regex match against a line, so it proves itself
// here: it must fire on the shape that escaped and stay quiet on three that merely
// look like it.
{
  const escaped = 'this car: TESTCNTRL12345678RFA000XPLUSS, trim and pack';
  if (vinInsideLongerToken(escaped).length === 0) {
    console.error('CONTROL_FAIL: vin-inside-longer-token does not fire on a VIN with a suffix, so it is not a detector.');
    process.exit(1);
  }
  for (const benign of [
    '"id": "0000000000000000000000000000"',
    'dump: "YSMTEST22PL000001RFA000"',
    'a commit: ABCDEF1234567890abcdef1234567890',
  ]) {
    if (vinInsideLongerToken(benign).length !== 0) {
      console.error('CONTROL_FAIL: vin-inside-longer-token fires on a value it is meant to allow, so it cannot tell padding and identifiers apart.');
      process.exit(1);
    }
  }
}

for (const [name, sample] of NEGATIVE_CONTROLS) {
  const [, re, opts] = DETECTORS.find(([n]) => n === name) ?? [];
  if (!re || matchedLines(sample, re, opts?.allow).length !== 0) {
    console.error(`CONTROL_FAIL: ${name} fires on a value it is meant to allow, so it cannot distinguish real from test data.`);
    process.exit(1);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(full);
    } else if (!SKIP_EXTENSIONS.has(path.extname(entry))) {
      yield full;
    }
  }
}

/** Line numbers and rule names only, so output never echoes a secret value. */
function matchedLines(content, re, allow) {
  const lines = [];
  let match;
  re.lastIndex = 0;
  while ((match = re.exec(content)) !== null) {
    if (!allow || !allow.test(match[0])) {
      lines.push(content.slice(0, match.index).split('\n').length);
    }
    if (lines.length >= 6) break;
  }
  return [...new Set(lines)];
}

const hits = [];
for (const file of walk(PROJECT_ROOT)) {
  if (path.resolve(file) === SELF) continue;
  const rel = path.relative(PROJECT_ROOT, file);
  const base = path.basename(file);

  // A credential file inside the tree is itself the finding, whatever it holds.
  // Templates are exempt from that *location* rule only, the content detectors
  // below still run on them, so a real token pasted into `.env.example` is caught.
  if (SECRET_FILE_PATTERN.test(base) && !TEMPLATE_SUFFIX_PATTERN.test(base)) {
    hits.push(`${rel} -> credential file inside the project tree (move it out and keep it untracked)`);
    continue;
  }

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [name, re, opts] of DETECTORS) {
    const lines = matchedLines(content, re, opts?.allow);
    if (lines.length > 0) hits.push(`${rel} -> ${name} (line ${lines.join(', ')})`);
  }
  for (const run of vinInsideLongerToken(content)) {
    // Location and length only: a suspected identifier is never echoed, which is
    // the same reason the needles above are shapes rather than values.
    hits.push(`${rel} -> vin-inside-longer-token (${run.length}-char run)`);
  }

  // A captured dump in the tree is the finding, whatever else it holds: one
  // `git init` one directory up would otherwise put a live refresh token and
  // weeks of position history in the first commit of a public repository.
  if (DUMP_PATH.test(rel)) hits.push(`${rel} -> consumer identity capture inside the project tree`);
  if (path.extname(base) === '.json') {
    const dumpLines = matchedLines(content, DUMP_CONTENT_MARKERS);
    if (dumpLines.length > 0) hits.push(`${rel} -> endpoint dump manifest inside the project tree`);
  }
}

if (hits.length > 0) {
  console.error('SECRETS_FOUND:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log('SECRETS_CLEAN');
