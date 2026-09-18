/**
 * Documentation and writing gates for this repository. Each subcommand prints its
 * own success marker after every assertion passes. The negative checks (em dash,
 * buzzwords, decorative banners, dash connectors) self-test against a positive
 * control first, so a clean scan means the detector actually fires.
 *
 * The writing checks scan the whole working tree rather than only docs/, because a
 * rule that covers only docs/ is exactly how the banned dash lived in the source
 * while the gate printed green. Untracked files count: a new module is covered
 * before it is ever committed, and .gitignore still keeps build output out.
 *
 * Usage: node docs/check-docs.mjs <tools|emdash|links|buzzwords|envvars|banners|connectors|hygiene>
 *
 * CI runs tools, envvars, links and hygiene on every push. A check that passes
 * here and not there has not been verified: see .github/workflows/ci.yml.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DOCS_DIR = path.resolve(ROOT, 'docs');

const DOC_FILES = () =>
  readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(DOCS_DIR, f))
    .concat(path.join(ROOT, 'README.md'));

/**
 * Files the writing rules apply to: everything tracked, not just the docs.
 * Build output and the captured fixtures are excluded (one is generated, the
 * other holds upstream payload text we do not control), as are local tool
 * audit finding has to quote the very characters it bans.
 * Local agent working notes (anti-slop/, .unlazy/) are skipped for the same reason:
 * they are investigation scratch, not shipped prose.
 */
const HYGIENE_SKIP = /^(node_modules|build|\.git|\.npm-cache|anti-slop|test\/fixtures)[\/]/;
const HYGIENE_EXT = /(\.[mc]?js|\.ts|\.py|\.json|\.md|\.example)$/;
function hygieneFiles() {
  let listed;
  try {
    // --others with --exclude-standard: new source files are scanned the moment they
    // exist, while .gitignore still keeps build output and dependencies out.
    listed = execSync('git ls-files --cached --others --exclude-standard', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    // Not a checkout (a tarball, a container): fall back to the docs scope.
    return DOC_FILES().map((f) => path.relative(ROOT, f));
  }
  const files = listed.filter(
    (f) => !HYGIENE_SKIP.test(f) && HYGIENE_EXT.test(f) && existsSync(path.join(ROOT, f)),
  );
  if (files.length < 20) fail(`HYGIENE_SCOPE_SUSPECT: only ${files.length} files matched, the filters are wrong`);
  return files;
}

function readHygiene(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// tools: every registerTool name in src/ is documented, counts match
function checkTools() {
  // Derived from the registry itself, not from a pattern match over source text.
  const listed = JSON.parse(
    execSync('node --import tsx scripts/list-tools.ts --detail', { cwd: ROOT, encoding: 'utf8' }),
  );
  const toolNames = new Set(listed.map((s) => s.name));
  if (toolNames.size === 0) fail('TOOLS_CHECK_FAILED: the registry answered with no tools');
  const historyNames = new Set(listed.filter((s) => s.family === 'history').map((s) => s.name));
  const always = listed.filter((s) => s.family !== 'history').length;
  const withHistory = listed.length;

  const doc = readFileSync(path.join(DOCS_DIR, 'tools-reference.md'), 'utf8');
  const missing = [...toolNames].filter((t) => !new RegExp(`\\b${t}\\b`).test(doc));
  if (missing.length > 0) fail(`TOOLS_CHECK_FAILED: not documented: ${missing.join(', ')}`);

  // The stated counts must match the code, not be copied prose.
  const statedAlways = new RegExp(`(${always - 1}|\\d+) tools registered on every start`).exec(doc);
  if (!statedAlways || Number(statedAlways[1]) !== always) {
    fail(`TOOLS_CHECK_FAILED: doc must state "${always} tools registered on every start"`);
  }
  if (!doc.includes(`${withHistory} with history enabled`)) {
    fail(`TOOLS_CHECK_FAILED: doc must state "${withHistory} with history enabled"`);
  }
  const domains = listed.filter((s) => s.family === 'domain' && s.name.startsWith('get_')).length;
  const statedDomains = /(\d+) read domains/.exec(doc)?.['1'];
  if (statedDomains !== String(domains)) {
    fail(`TOOLS_CHECK_FAILED: doc says "${statedDomains ?? 'no'} read domains", the registry defines ${domains}`);
  }
  console.log(`DOCS_TOOLS_OK tools=${withHistory} domains=${domains}`);
}

// emdash: R-02, no em or en dash character anywhere in the tracked tree
const EM_DASH = '\u2014';
// An en dash between spaces is the same aside punctuation R-02 bans. An unspaced
// en dash is a range (`00:00–06:00`), which is correct typography, so only the
// spaced form is a hit here.
const SPACED_EN_DASH = ` \u2013 `;
function scanForEmDash(file, text) {
  const lines = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes(EM_DASH) || line.includes(SPACED_EN_DASH)) lines.push(i + 1);
  });
  return lines;
}
function checkEmDash() {
  // Positive control: the scanner must fire on a known em dash before a clean
  // scan is allowed to mean anything.
  if (scanForEmDash('control', `a ${EM_DASH} b`).length !== 1) {
    fail('EMDASH_CHECK_FAILED: detector did not fire on its positive control');
  }
  const hits = [];
  for (const rel of hygieneFiles()) {
    const lines = scanForEmDash(rel, readHygiene(rel));
    if (lines.length > 0) hits.push(`${rel} lines ${lines.join(', ')}`);
  }
  if (hits.length > 0) fail(`EMDASH_CHECK_FAILED:\n  ${hits.join('\n  ')}`);
  console.log('HYGIENE_NO_EM_DASH');
}

// links: every local markdown link, including its #anchor, resolves
function headingSlugs(text) {
  const slugs = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const inlineCode = m[1].replace(/`/g, '');
    const base = inlineCode.toLowerCase().replace(/[^\w\s-]/g, '').trim();
    // github-slugger maps every space to a hyphen without collapsing runs, so
    // "Foo (15 + bar)" becomes "foo-15--bar". Both spellings are accepted: a
    // renderer that collapses runs would otherwise fail a link that is fine.
    slugs.add(base.replace(/\s/g, '-'));
    slugs.add(base.replace(/\s+/g, '-'));
  }
  return slugs;
}
function checkLinks() {
  const broken = [];
  for (const file of DOC_FILES()) {
    const text = readFileSync(file, 'utf8');
    const own = headingSlugs(text);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [filePart, fragment] = target.split('#');
      if (filePart === '') {
        // Same-document anchor: the fragment has to name a heading that exists.
        if (fragment && !own.has(fragment)) {
          broken.push(`${path.relative(ROOT, file)} -> #${fragment} (no such heading in this file)`);
        }
        continue;
      }
      const resolved = path.resolve(path.dirname(file), decodeURI(filePart));
      if (!existsSync(resolved)) {
        broken.push(`${path.relative(ROOT, file)} -> ${target}`);
        continue;
      }
      if (!fragment || !resolved.endsWith('.md') || !existsSync(resolved)) continue;
      if (!headingSlugs(readFileSync(resolved, 'utf8')).has(fragment)) {
        broken.push(`${path.relative(ROOT, file)} -> ${target} (file exists, heading does not)`);
      }
    }
  }
  if (broken.length > 0) fail(`LINKS_CHECK_FAILED:\n  ${broken.join('\n  ')}`);
  console.log('DOCS_LINKS_OK');
}

// buzzwords: R-16 vocabulary ban, tree-wide, with a positive control
const BUZZWORDS = [
  'AI Powered', 'AI-powered', 'Next Generation', 'Revolutionary', 'Seamless',
  'Cutting Edge', 'Cutting-edge', 'Effortless', 'Ultimate', 'Powerful',
];
function checkBuzzwords() {
  const sample = 'This Seamless tool is Revolutionary and Cutting Edge.';
  if (!BUZZWORDS.some((w) => sample.includes(w))) {
    fail('BUZZWORDS_CHECK_FAILED: detector did not fire on its positive control');
  }
  const hits = [];
  for (const rel of hygieneFiles()) {
    // This file is the ban list; naming a word is how a checker detects it.
    if (rel === 'docs/check-docs.mjs') continue;
    const text = readHygiene(rel);
    for (const word of BUZZWORDS) {
      if (text.includes(word)) hits.push(`${rel} -> ${word}`);
    }
  }
  if (hits.length > 0) fail(`BUZZWORDS_CHECK_FAILED:\n  ${hits.join('\n  ')}`);
  console.log('HYGIENE_BUZZWORDS_CLEAN');
}

// envvars: every POLESTAR_* variable in src/ is documented
function checkEnvVars() {
  const names = new Set();
  for (const f of ['src/config.ts', 'src/server.ts']) {
    const text = readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/POLESTAR_[A-Z_]+/g)) names.add(m[0]);
  }
  if (names.size === 0) fail('ENVVARS_CHECK_FAILED: no POLESTAR_* variables found in src/');
  const doc = readFileSync(path.join(DOCS_DIR, 'getting-started.md'), 'utf8');
  const missing = [...names].filter((n) => !doc.includes(n));
  if (missing.length > 0) fail(`ENVVARS_CHECK_FAILED: not documented: ${missing.join(', ')}`);
  console.log('DOCS_ENVVARS_OK');
}


// banners: no decorative separators drawn around a label (antislop-code)
// A comment marker, then four or more rule characters (ASCII or box-drawing)
// drawn as a rule). Box characters only count on a comment line: in the PDF
// builder they are legitimate table borders in code.
const BANNER = /(^|\s)(\/\/|#)\s*(\S\s*)?[=\-*~_]{4,}|(^|\s)(\/\/|#)[^\n]*[\u2500\u2501]{4}/;
function scanForBanner(text) {
  const lines = [];
  text.split('\n').forEach((line, i) => {
    if (BANNER.test(line)) lines.push(i + 1);
  });
  return lines;
}
function checkBanners() {
  if (scanForBanner('// ---------- Authentication ----------').length !== 1) {
    fail('BANNER_CHECK_FAILED: detector did not fire on its positive control');
  }
  const hits = [];
  for (const rel of hygieneFiles()) {
    if (!/\.(ts|js|mjs|cjs|py)$/.test(rel)) continue;
    const lines = scanForBanner(readHygiene(rel));
    if (lines.length > 0) hits.push(`${rel} lines ${lines.join(', ')}`);
  }
  if (hits.length > 0) fail(`BANNER_CHECK_FAILED:\n  ${hits.join('\n  ')}`);
  console.log('HYGIENE_NO_BANNERS');
}

// connectors: a spaced hyphen doing dash punctuation in prose (R-02's tell with
// a different glyph). Markdown only, prose only: in source this pattern is
// arithmetic, and list bullets legitimately start with "- ".
const CONNECTOR = /[\w`)\]"'\u2019\u201d] - (?=[A-Za-z"'"\u201c])/;
function scanForConnector(text) {
  const lines = [];
  let fence = false;
  text.split('\n').forEach((line, i) => {
    // Code fences hold commands and sample output, not prose: a YAML "- run:" or
    // a shell range in an example is not dash punctuation.
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    if (line.trimStart().startsWith('- ') || line.includes('`---`')) return;
    if (CONNECTOR.test(line) || line.includes(' -- ')) lines.push(i + 1);
  });
  return lines;
}
function checkConnectors() {
  if (scanForConnector('the one place that mattered - server.ts still built').length !== 1) {
    fail('CONNECTOR_CHECK_FAILED: detector did not fire on its positive control');
  }
  const hits = [];
  for (const rel of hygieneFiles()) {
    if (!/\.(md|example)$/.test(rel)) continue;
    const lines = scanForConnector(readHygiene(rel));
    if (lines.length > 0) hits.push(`${rel} lines ${lines.join(', ')}`);
  }
  if (hits.length > 0) fail(`CONNECTOR_CHECK_FAILED:\n  ${hits.join('\n  ')}`);
  console.log('HYGIENE_NO_DASH_CONNECTORS');
}

// hygiene: every writing rule in one run, so the ledger needs a single CHECK line
function checkHygiene() {
  checkEmDash();
  checkBuzzwords();
  checkBanners();
  checkConnectors();
  console.log('HYGIENE_CLEAN');
}

const checks = {
  tools: checkTools,
  emdash: checkEmDash,
  links: checkLinks,
  buzzwords: checkBuzzwords,
  envvars: checkEnvVars,
  banners: checkBanners,
  connectors: checkConnectors,
  hygiene: checkHygiene,
};
const what = process.argv[2];
const check = checks[what];
if (!check) fail(`usage: node docs/check-docs.mjs <${Object.keys(checks).join('|')}>`);
check();
