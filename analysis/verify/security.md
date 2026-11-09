# Lane D: security and privacy verification

Verification of the security and privacy behaviour of `polestar-mcp` at commit `098b8c3` on
`master`, using offline fixture mode and crafted local inputs only. The live Polestar API was
never called, the real secrets file was never read, and no raw VIN, coordinate or credential
value appears in this report.

## Environment and method

| Fact | Value |
| --- | --- |
| Host | macOS arm64 |
| Node and npm | v22.23.2 and 10.9.8 |
| Repository | `/Users/nicolaskheirallah/Documents/GitHub/polestar-mcp`, `098b8c3`, branch `master` |
| Runtime under test | `node --import tsx src/server.ts` (the development launch path) |
| Fixture dump | `test/fixtures/dump`, synthetic, no credential needed |
| Live API | not called |
| Real secrets file | never read; the default candidate was exercised only under a fake `HOME` under `/tmp` |
| Temp trees and stores | `/tmp/verify-security` only |
| Tracked files | none modified by this lane; only this untracked report was added |
| Shared worktree note | another lane edited six `docs/` and `README.md` files during this run; `git diff --stat` shows `src/` and `package.json` unchanged, so the behavioural probes ran against `098b8c3` source |

Every check below was executed. The probe scripts live under `/tmp/verify-security/` (outside
the repository) and are listed in the reproduction section.

## Verdict

**380 probe checks passed, 13 failed, across 6 distinct behavioural defects.** One additional
dependency-hygiene finding is present but not reachable from this server's code path. No
credential exposure, no write path, no authentication bypass and no cross-vehicle data
disclosure was found. The defects are privacy-control and local-hardening issues:

| ID | Severity | Defect |
| --- | --- | --- |
| F1 | High | `get_history` returns recorded coordinates while `POLESTAR_ALLOW_LOCATION=0` |
| F2 | Medium | History store files and directories are created `0644`/`0755`, not `0600`/`0700` |
| F3 | Medium | Upstream error `message` is passed through unmasked, so a crafted or real upstream error that echoes the VIN leaks it despite `POLESTAR_REDACT_VIN=1` |
| F4 | Low | A failed background cache refresh logs the request path containing the raw VIN to stderr |
| F5 | Low | Prompt results echo a caller-supplied VIN unmasked, so redaction is not end to end |
| F6 | Low | `INVALID_VIN` echoes the caller-supplied identifier unmasked, so a typo'd real VIN lands in the transcript |
| F7 | Low (unreachable) | `npm audit --omit=dev` reports 2 moderate advisories in `hono` and `@hono/node-server` (`serveStatic` path double-decode); the MCP packages here do not import `serveStatic` |
| N1 | Info | Dependency manifests use caret ranges; exact versions are pinned by `package-lock.json` with integrity hashes, and CI uses `npm ci` |
| N2 | Info | `polestar_status` does not report the location switch; not a security property, noted for operator clarity |

## Defects with repro

The fixture VIN is referred to as `YSM…001` throughout. The raw value is the first element of
`test/fixtures/dump/dataportal/vehicles.json`; none of the commands below prints it.

### F1 (High): `get_history` bypasses `POLESTAR_ALLOW_LOCATION=0`

`src/history-tools.ts` `get_history` resolves the domain through the registry and then queries
the store, with no location check. `POLESTAR_ALLOW_LOCATION=0` is enforced in three other
places (`PolestarClient.domain`, `timelineSources`, `extra-history-tools`), so historical
position is the one history surface that ignores the operator's switch. `--help` states the
switch means "never request or return vehicle position".

Repro, with a store that already holds a location sample (either recorded earlier or seeded):

```bash
VIN=$(node -p "require('./test/fixtures/dump/dataportal/vehicles.json').data[0]")
mkdir -p "/tmp/hist/$VIN"
node -e '
const fs = require("node:fs");
const [vin] = require("./test/fixtures/dump/dataportal/vehicles.json").data;
const loc = require("./test/fixtures/dump/dataportal/telemetry/location.json").data;
fs.writeFileSync(`/tmp/hist/${vin}/telemetry-location.jsonl`,
  JSON.stringify({ observedAt: Date.now(), valueObservedAt: Date.now(), data: loc }) + "\n");
'
POLESTAR_FIXTURES_DIR=test/fixtures/dump POLESTAR_HISTORY_DIR=/tmp/hist POLESTAR_ALLOW_LOCATION=0 \
POLESTAR_REDACT_VIN=1 node --import tsx /tmp/verify-security/probe3-location.mts
```

Observed before the fix: `get_history` with `{ "domain": "telemetry/location" }` answers
`ok: true` and renders the fixture latitude and longitude (values omitted here), and the
`no position` scan fails with `coord:` matches. The timeline and the weekly digest both say
`Excluded: location (POLESTAR_ALLOW_LOCATION=false ...)`, which shows the intended behaviour
and makes `get_history` the inconsistent surface. Fix direction: refuse or filter
`telemetry/location` in `get_history` when `allowLocation` is false, as `extra-history-tools.ts`
already does with `TIMELINE_LOCATION_LABEL`.

### F2 (Medium): history store is not created `0600`

`HistoryStore.append` calls `mkdirSync` and `appendFileSync` with no `mode`, so the store
inherits the umask (host umask was `022`). The retention rewrite writes a sibling temp file
with `writeFileSync` and renames it, also with no mode.

Repro:

```bash
node --import tsx --input-type=module -e '
import { HistoryStore } from "./src/history.ts";
import { statSync } from "node:fs";
const s = new HistoryStore("/tmp/hist-mode");
const [vin] = JSON.parse((await import("node:fs")).readFileSync("./test/fixtures/dump/dataportal/vehicles.json","utf8")).data;
s.append(vin, "telemetry", "battery", { observedAt: Date.now(), data: { batteryChargeLevelPercentage: 50 } });
const file = `/tmp/hist-mode/${vin}/telemetry-battery.jsonl`;
console.log((statSync(file).mode & 0o777).toString(8), (statSync(`/tmp/hist-mode/${vin}`).mode & 0o777).toString(8), (statSync("/tmp/hist-mode").mode & 0o777).toString(8));
'
```

Observed: `644 755 755`. There is no documented `0600` promise for the history store
(`SECURITY.md` only discusses `.env` mode), so this is a gap against the verification criterion
and against the privacy posture rather than a broken claim. It matters because the store can
contain position and telemetry, and because a retention rewrite resets any manual `chmod 600`
back to the umask default. Fix direction: create the directory `0700` and the file `0600` in
`history.ts`, and set the same mode on the retention temp file.

### F3 (Medium): upstream error text is forwarded unmasked

`PolestarClient` builds `PolestarApiError` from the upstream `error` object and
`toFailure`/`describeFailure` render `message` verbatim. `POLESTAR_REDACT_VIN` masks the VIN in
errors the client mints itself (`INVALID_VIN`, `AMBIGUOUS_VIN`, `VIN_MISMATCH`,
`VIN_NOT_CHOSEN`) but not in an upstream message that contains it. `SECURITY.md` lists
"client-facing error messages" as a masked surface. The existing runtime test already states
that if the API echoes a secret in a message the server surfaces it, so this class is known for
tokens; the crafted probe shows the VIN case.

Repro: copy the dump, replace `dataportal/telemetry/battery.json` with an error envelope whose
`message` contains the fixture VIN, then call `get_battery` with `POLESTAR_REDACT_VIN=1`.
Observed: code `VALIDATION_INVALID_PARAMETER`, `requestId` preserved, and the raw VIN present in
both the content text and `structuredContent.message`. Fix direction: mask VIN-shaped substrings
in upstream `message`/`details` when redaction is on, or do not render upstream free text.

### F4 (Low): stderr diagnostic carries the raw VIN

`server.ts` logs `background refresh failed for ${new URL(url).pathname}`. The domain path
contains the VIN, so one failed stale-while-revalidate refresh writes the raw VIN to stderr even
with `POLESTAR_REDACT_VIN=1` and without `POLESTAR_LOG=debug`.

Repro: enable history so the cache is on, read `get_battery` once, wait past the 30 s battery
TTL, replace the battery fixture file with a directory (which makes the read throw `EISDIR`
rather than resolve a 404), and read again. Observed line shape:

```
[polestar-mcp] background refresh failed for /eu-north-1/data-portal/m2m/v1/vehicles/<VIN>/telemetry/battery: EISDIR ...
```

Command: `node --import tsx /tmp/verify-security/probe6-stderr.mts`. Fix direction: mask the VIN
segment in the logged path, or log the domain name instead of the URL path.

### F5 (Low): prompt results echo a caller-supplied VIN unmasked

`promptSpecs` interpolates `(VIN ${vin})` into the prompt message from the caller's own
argument. `SECURITY.md` does not list prompts as a masked surface, so this is a gap in the
end-to-end redaction story rather than a broken promise: the client already supplied the value.
It still defeats the stated purpose of keeping the identifier out of a transcript when the
caller copies it from a resource URI.

Repro: send `prompts/get` with `{ "name": "car-status", "arguments": { "vin": "<fixture VIN>" } }`
and `POLESTAR_REDACT_VIN=1`. Observed: the message text contains the raw VIN. Same for
`charge-plan` and, with history enabled, `battery-health-report`. No-argument prompt results are
clean. Fix direction: mask the argument the same way tool results do, or omit it from the
message and pass it as a tool argument only.

### F6 (Low): `INVALID_VIN` echoes the caller input

`src/client.ts` `resolveVin` builds `"${vin}" is not a plausible VIN ...` from the raw argument.
With redaction on, a caller that supplies a 17-character VIN containing a forbidden letter
(`I`, `O`, `Q`) gets that identifier back verbatim.

Repro: call `get_battery` with `{ "vin": "<fixture VIN with one character replaced by O>" }` and
`POLESTAR_REDACT_VIN=1`. Observed: `INVALID_VIN`, and both the text and `message` contain the
caller's 17 characters. This is input echo, not a server-held identifier, but a real VIN typo
would reach the transcript. Fix direction: render a masked form of the rejected argument.

### F7 (Low, unreachable): dependency advisories

`npm audit --omit=dev` reports 2 moderate advisories: `@hono/node-server` 1.19.17
(GHSA-rmxm-3fg6-px4f) and `hono` 4.13.8 (GHSA-5r4p-p66f-jhc7), both the `serveStatic` path
double-decode class. No high or critical advisory. `npm audit fix` reports a fix is available.
This server imports only `toNodeHandler` from `@modelcontextprotocol/node` and never mounts a
Hono static middleware; `grep -rn serveStatic node_modules/@modelcontextprotocol` finds no
import, so the vulnerable code path is not reachable through the MCP ingress. It remains a
supply-chain hygiene item and a bar that "zero advisories" does not meet.

## Check tables

Commands are run from the repository root unless stated. Probe IDs map to
`/tmp/verify-security/<probe>.mts`.

### 1. VIN redaction with `POLESTAR_REDACT_VIN=1`

Probes: `probe1-redaction.mts` (166 pass, 5 fail), `probe2-failures.mts` (13 pass, 1 fail),
`probe9-resources.mts` (all 15 resource bodies, 0 leaks).

| ID | Check | Command | Observed |
| --- | --- | --- | --- |
| R1 | `tools/list` free of the VIN and VIN-shaped substrings in names, descriptions, argument and output schemas | `probe1-redaction` | PASS |
| R2 | Every registered tool (36 with history on): content text and `structuredContent` free of the VIN, second pass warms cache | `probe1-redaction` | PASS (72 checks) |
| R3 | `raw: true` returns the upstream payload with the VIN; the same call without `raw` is masked | `probe1-redaction` | PASS, documented exemption confirmed |
| R4 | Resource listing names and descriptions masked; the resource URI keeps the raw VIN on all 15 resources | `probe1-redaction` | PASS, documented exception confirmed |
| R5 | Every one of the 15 resource bodies free of the VIN | `probe9-resources` | PASS, `checked=15 leaks=0` |
| R6 | VIN completion values masked; domain completions clean | `probe1-redaction` | PASS, `YSM…001` |
| R7 | `prompts/list` clean; no-argument prompt results clean; caller-supplied VIN echoed unmasked | `probe1-redaction` | PARTIAL, F5 |
| R8 | `VIN_MISMATCH` on a crafted mislabelled response: correct code, masked identifiers, mask present in text | `probe2-failures` | PASS |
| R9 | `AMBIGUOUS_VIN` with two crafted vehicles: masked listing, both choices masked | `probe2-failures` | PASS |
| R10 | `VIN_NOT_CHOSEN` after a declined elicitation: refusal and elicitation message and enum all masked | `probe2-failures` | PASS, `YSM…001,YSM…002` |
| R11 | Crafted upstream error whose message contains the VIN | `probe2-failures` | FAIL, F3 |
| R12 | `INVALID_VIN` refuses and names the reason; caller input echoed | `probe1-redaction` | PARTIAL, F6 |

### 2. Location privacy with `POLESTAR_ALLOW_LOCATION=0`

Probe: `probe3-location.mts` (97 pass, 2 fail). Store seeded with location, battery, exterior
and odometer records; scan covers the fixture coordinate at 3 to 7 decimal places, latitude and
longitude field names, and map links, in every tool's text and structured data and in all 15
resource bodies.

| ID | Check | Command | Observed |
| --- | --- | --- | --- |
| L1 | `get_location` refuses with `LOCATION_DISALLOWED` and says the request was never sent | `probe3-location` | PASS |
| L2 | `get_location` with an explicit VIN still refuses | `probe3-location` | PASS |
| L3 | All 36 tools: no coordinate, coordinate field or map link in text or structured data | `probe3-location` | PASS for live-read tools and aggregates |
| L4 | `get_timeline` states `Excluded: location` and contains no position | `probe3-location` | PASS |
| L5 | `get_weekly_digest` states location excluded and contains no position | `probe3-location` | PASS |
| L6 | `get_history` for `telemetry/location` while location is off | `probe3-location` | FAIL, F1 |
| L7 | All 15 resource bodies free of position | `probe3-location` | PASS |
| L8 | Location resource still listed by identity but its read refuses rather than serving position | `probe3-location` | PASS |

### 3. Filesystem and configuration

Probe: `probe4-files.mts` (28 pass, 4 fail). All trees under `/tmp`; ledger and history modules
imported directly so the failure paths are reachable without a live API.

| ID | Check | Command | Observed |
| --- | --- | --- | --- |
| S1 | History store path and file are created | `probe4-files` | PASS |
| S2 | History file mode `0600`; vehicle directory `0700`; root `0700` | `probe4-files` | FAIL, `644`/`755`/`755`, F2 |
| S3 | Retention rewrite keeps the newest half, leaves no temp file, tolerates a torn last line on read | `probe4-files` | PASS, atomic rewrite confirmed |
| S4 | Retention rewrite preserves `0600` | `probe4-files` | FAIL, F2 (rewrite writes umask default) |
| S5 | VIN and domain path segments cannot escape the store: `../../evil`, absolute paths, `..`, percent-encoded traversal, NUL | `probe4-files` | PASS, 18 files, `escaped=0` |
| S6 | Budget ledger file created `0600` and leaves no temp file | `probe4-files` | PASS |
| S7 | Ledger stores a SHA-256 per identity, never the client ID or Account ID | `probe4-files` | PASS |
| S8 | Corrupt ledger fails closed at startup: invalid JSON, wrong version, missing identities, negative count, string version | `probe4-files` | PASS (5 cases) |
| S9 | Ledger corrupted mid-run refuses the next call instead of starting at zero | `probe4-files` | PASS |
| S10 | Ledger refusal names the file and a recovery action | `probe4-files` | PASS |
| S11 | `.env`, `.env.secrets` placed in the working tree are not loaded (fake `HOME`, debug line shows `redactVin=false`, `allowLocation=true`, marker absent) | `probe4-files`, `/tmp/verify-security/envtree.mts` | PASS |
| S12 | Default candidate `HOME/.config/polestar-mcp/.env.secrets` is loaded and its values take effect | `probe4-files` | PASS |
| S13 | `POLESTAR_ENV_FILE` override is loaded and its values take effect | `probe4-files` | PASS |
| S14 | `POLESTAR_STRICT_ENV=1` makes an unrecognized `POLESTAR_*` name fatal (exit 1); without it, warn only | `probe4-files` | PASS |
| S15 | Group/world-readable secrets file gets the `chmod 600` warning; a `0600` file does not | `probe4-files` | PASS |
| S16 | Fixture mode never reads a secrets file | `probe4-files` | PASS |

### 4. HTTP boundary

Probes: `probe5-http.mts` (52 pass, 0 fail), `probe6-stderr.mts` for the diagnostic leak.

| ID | Check | Command | Observed |
| --- | --- | --- | --- |
| H1 | Loopback bind allowed with no token; loopback short token allowed (floor is for non-loopback only) | `probe5-http` | PASS |
| H2 | Non-loopback with no token refused at startup, message names the variable; 15-character token refused with the 16-character floor; 16 and longer accepted | `probe5-http` | PASS, exit 1 for both refusals |
| H3 | Loopback aliases `127.0.0.1`, `localhost`, `::1`, `[::1]` recognised | `probe5-http` | PASS |
| H4 | Missing Host refused; foreign Host refused (DNS rebinding); own Host and `localhost` accepted | `probe5-http` | PASS |
| H5 | Foreign Origin refused; own Origin accepted; absent Origin accepted; configured allowlist honoured both ways | `probe5-http` | PASS |
| H6 | Bearer compare: exact and lower-case scheme accepted; wrong, same-length-wrong, short, long, missing header, empty configured token and non-Bearer scheme rejected | `probe5-http` | PASS |
| H7 | Constant-time compare is `timingSafeEqual` on equal-length utf8 buffers; a 200k-iteration timing probe shows first-byte-wrong vs last-byte-wrong ratio 1.025 (no first-byte short-circuit signal) | `probe5-http`, `/tmp/verify-security/timing.mts` | PASS by inspection and behaviour; timing is statistical, not proof |
| H8 | Missing and wrong bearer get 401 with `www-authenticate: Bearer`; the body names `POLESTAR_HTTP_TOKEN` but not the token | `probe5-http` | PASS |
| H9 | Valid token: initialize and `tools/list` answered 200 | `probe5-http` | PASS |
| H10 | Foreign Host and foreign Origin over a real socket get 403 with no token and no VIN in the body | `probe5-http` | PASS |
| H11 | Declared `Content-Length` of `4 MiB + 1` gets 413 from the header alone; chunked 5 MiB is also refused with 413 | `probe5-http` | PASS |
| H12 | A real `get_battery` tool call over HTTP with redaction on returns no raw VIN in the response body | `probe5-http` | PASS |
| H13 | stderr with `POLESTAR_LOG=debug` carries neither the token nor the VIN during normal operation | `probe5-http` | PASS |
| H14 | A failed background refresh writes the raw VIN path to stderr | `probe6-stderr` | FAIL, F4 |

### 5. Secrets gate, write posture and prompt-injection surface

Probes: `probe7-writes.mts` (9 pass, 0 fail), `probe8-injection.mts` (10 pass, 0 fail).
Commands: `npm run check-secrets`.

| ID | Check | Command | Observed |
| --- | --- | --- | --- |
| P1 | Repository secrets gate | `npm run check-secrets` | PASS, `SECRETS_CLEAN`, exit 0 |
| P2 | Positive control: a `.env.production` planted in a `/tmp` copy is caught | `node scripts/check-secrets.mjs` in `/tmp/verify-security/secrets-tree` | PASS, `SECRETS_FOUND`, exit 1 |
| P3 | `tools/list` byte-identical with and without `POLESTAR_ENABLE_WRITES=1` | `probe7-writes` | PASS |
| P4 | `resources/list` and `prompts/list` identical with the flag | `probe7-writes` | PASS |
| P5 | Flag logs that nothing was registered; quiet when unset | `probe7-writes` | PASS |
| P6 | No tool name is a write verb; every tool declares `readOnlyHint: true` | `probe7-writes` | PASS, 26 tools |
| P7 | Model-facing descriptions contain no executable instruction (curl/wget/rm/eval/child_process/ignore-previous/send-secret patterns) | `probe7-writes` | PASS |
| P8 | Upstream instruction-like text is returned as data, not executed: crafted payload with "ignore previous instructions", a markdown image and a shell pipe is rendered verbatim only in `raw` output, inert in the plain summary | `probe8-injection` | PASS |
| P9 | `src/` has no `eval`, `new Function`, `vm`, or `child_process`; the only filesystem writes are the opt-in history store and the budget ledger | `probe8-injection` + source review | PASS |
| P10 | No third-party runtime endpoint is embedded: hosts found are `pc-api.polestar.com`, `www.google.com` (a rendered map link), and loopback or example hosts in comments and error text | `probe8-injection` | PASS |

### 6. Supply chain

| ID | Check | Command | Observed |
| --- | --- | --- | --- |
| C1 | Production dependency audit | `npm audit --omit=dev` | FINDING, F7: 0 info/low/high/critical, 2 moderate (`hono`, `@hono/node-server`, `serveStatic`), fix available |
| C2 | Lockfile integrity: every resolved entry has an integrity hash and a registry URL, no git or file dependencies | `node -e` over `package-lock.json` | PASS, 59 packages, `resolved without integrity 0`, `non-registry resolved 0` |
| C3 | Clean install from the lockfile | `npm ci --ignore-scripts` in `/tmp/verify-security/ci` | PASS, `added 14 packages`, exit 0 |
| C4 | Production install from the lockfile | `npm ci --omit=dev` in `/tmp/verify-security/prod` | PASS, `added 6 packages`, exit 0 |
| C5 | Install scripts in the production tree | scan of installed `node_modules` | PASS, 0 production packages with `preinstall`/`install`/`postinstall` |
| C6 | Install scripts in the full dev tree | scan of `node_modules` | `esbuild` (dev, binary fetch) and `fsevents` (dev, optional); neither ships in the production tree |
| C7 | Existing dependency tree consistent | `npm ls --all` | PASS, exit 0; one platform-specific optional dependency unmet, which is normal |
| C8 | Versions pinned | `package.json` and `package-lock.json` | N1: manifest ranges are caret (`^`), lockfile pins exact resolved versions (for example `@modelcontextprotocol/server@2.4.0`, `zod@4.6.7`, `hono@4.13.8`) and CI uses `npm ci` |

## Corroborating test runs

Existing suites were run as a cross-check, not as the primary evidence:

| Command | Observed |
| --- | --- |
| `node --import tsx --test test/posture.test.ts test/budget-ledger.test.ts test/history.test.ts` | 34 pass, 0 fail |
| `node --import tsx --test test/runtime.test.ts test/transport-hardening.test.ts test/config-registry.test.ts` | 59 pass, 0 fail |

## Documented exceptions verified

The three exceptions stated in `SECURITY.md` were each checked and hold:

1. Resource URI identity: all 15 listed resources carry the raw VIN in the URI and the names and descriptions are masked (R4). Reading a resource returns the same URI identity, and the body remains masked.
2. `raw: true`: returns the upstream payload with the VIN, while the same call without `raw` is masked (R3).
3. On-disk history paths: the store directory is named by the raw VIN (observed under `/tmp`, never sent to a client). F2 concerns the permissions of those local paths, not their naming.

## Probe inventory

| Probe | Focus | Result |
| --- | --- | --- |
| `probe1-redaction.mts` | VIN on all tools, resources, completions, prompts, failures | 166 pass, 5 fail (F5, F6) |
| `probe2-failures.mts` | VIN_MISMATCH, AMBIGUOUS_VIN, VIN_NOT_CHOSEN, crafted upstream error | 13 pass, 1 fail (F3) |
| `probe3-location.mts` | `POLESTAR_ALLOW_LOCATION=0` across tools, resources, history | 97 pass, 2 fail (F1) |
| `probe4-files.mts` | History modes, containment, ledger fail-closed, env loading | 28 pass, 4 fail (F2) |
| `probe5-http.mts` | Bind floor, Host/Origin, bearer, body cap, response and stderr scans | 52 pass, 0 fail |
| `probe6-stderr.mts` | Diagnostic VIN leak on failed refresh | 5 pass, 1 fail (F4) |
| `probe7-writes.mts` | Read-only posture, `POLESTAR_ENABLE_WRITES`, description review | 9 pass, 0 fail |
| `probe8-injection.mts` | Upstream text treated as data, no execution paths | 10 pass, 0 fail |
| `probe9-resources.mts` | All 15 resource bodies scanned for the VIN | 0 leaks |

## Limits of this verification

- Timing equality is a statistical observation over 200k comparisons, not a proof; the stronger
  evidence is the source read of `timingSafeEqual` with an equal-length pre-check.
- The Hono advisory reachability conclusion is based on import inspection of the MCP packages,
  not on exercising a `serveStatic` route (this server mounts none).
- File modes were measured under umask `022`. The defect is that no explicit mode is set, so the
  result is umask-dependent; a stricter umask would hide it and a looser one would widen it.
- The prompt and `INVALID_VIN` echo findings are input echoes. They are reported because the
  redaction promise is about transcripts, but they do not disclose an identifier the caller did
  not already send.
- No live API behaviour, real credential, real VIN or real position was involved.
