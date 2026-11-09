# Ops, security, docs and developer-experience audit

Repo: `polestar-mcp` at `/Users/nicolaskheirallah/Documents/GitHub/polestar-mcp`
Commit audited: `dc50017` (master, 2026-11-05). Host: macOS, Node `v22.23.2`, npm `10.9.8`.
Method: read the workflow, the gate scripts and the docs; run every gate and the packaging
commands for real; derive counts from code rather than from prose; probe the detectors with
synthetic, non-secret inputs. Nothing tracked was modified, nothing installed or upgraded.

## Verdict in one paragraph

The verification story is unusually good for a project this size: the gates derive facts from
the registry, the secret scanner carries real positive controls that prove it fires, the smoke
runs exercise the actual MCP surface through both transports and through the installed bin
symlink, and the HTTP bearer check is covered end to end. The weak seam is not effort, it is
**shape**: several gates answer a narrower question than the document next to them claims, two
checks can only fail on inputs they do not read, and the coverage gate cannot fail at all. The
one claim with real privacy consequence, `POLESTAR_REDACT_VIN`, is narrower than `SECURITY.md`
says and the uncovered part sits in the least unit-covered file.

## Working tree state (read this before committing anything)

The committed tree is green on all 14 CI commands. The **current working tree is red on two**
because audit artifacts under `analysis/` are inside the scan scope:

```
$ node scripts/check-secrets.mjs
SECRETS_FOUND:
  analysis/correctness/probe-cache-delegation.ts -> vin-shaped-identifier (line 14)
$ node docs/check-docs.mjs hygiene
EMDASH_CHECK_FAILED:
  analysis/surface/evidence/tools-list.json lines 837
  analysis/surface/findings.md lines 31, 91, 121, ...
```

Two consequences. First, `analysis/` is not in `.gitignore` (`.unlazy/` and `anti-slop/` are),
so committing the audit output turns CI red. Second, this is positive evidence that both gates
do scan untracked files as their comments claim: a probe file containing an em dash and a
spaced hyphen was caught the moment it existed under `analysis/ops/probes/`. Anyone landing
this audit should keep `analysis/` out of the commit, or add it to `.gitignore`.

## The CI gate truth table

`ci.yml` runs 14 commands, not the 11 the brief assumed. Node 22 only. `npm ci` before
everything. Every command below was run twice: once at HEAD, once with probe files to see
whether the failure is observable.

| Command | What it actually proves | How it can silently pass | Observed |
| --- | --- | --- | --- |
| `npm run typecheck` | src, test and `scripts/*.ts` compile under strict plus exactOptionalPropertyTypes | `.mjs` gate scripts are untypechecked (`allowJs` off), so the three most safety-critical checkers have no static checking at all | exit 0 |
| `npm run build` | tsc emits `build/`; `postbuild` chmods `build/server.js` | The chmod would throw if the file were missing, so this one is honest. It does not prove the file runs | exit 0 |
| `npm run verify-fixtures` | Every registry Domain has a fixture, valid JSON, `{data}` or error envelope, `meta.domain` matches, `meta.vin` is a string | Does not check `pinnedKeys` (contract test does) and skips envelope checks for error fixtures; `token.json` and `vehicles.json` are only checked for existence | `FIXTURES_OK` |
| `npm test` | 111 tests pass through the Node test runner | Glob is `"test/"*.test.ts`, so a new `*.spec.ts` or any nested test file never runs and nothing fails. No minimum test count | 111 pass, 0 fail, 395 ms |
| `npm run coverage` | Node prints per-file coverage and exits 0 if tests pass | **No threshold anywhere.** Deleting tests lowers the number and CI stays green. The headline also includes the test files in the total | exit 0, all files 95.54 line / 86.50 branch |
| `npm run smoke` | Full stdio surface: handshake, exact registry set, outputSchema and readOnlyHint on every tool, no-arg calls returning structured ok/message, resources, prompts, DATA_NOT_AVAILABLE, unknown tool | Registry set is derived from code, so it cannot detect that a tool is documented wrongly. No elicitation is exercised: the fixture has one vehicle, so the ambiguity path never runs. `CONTRIBUTING.md:54` claims smoke proves elicitation | `SMOKE_OK`, 26 tools, 24 callable |
| `npm run smoke-bin` | `--version`, `--help`, handshake reached through a bin symlink from a temp dir | **The script chmods the artifact itself** (`chmodSync(SERVER, 0o755)`, smoke-bin.ts:28), so it repairs the executability it is supposed to verify. It also discards real exit codes: the exit handler resolves `code: 0` regardless (smoke-bin.ts:41) | `BIN_SMOKE_OK` |
| `npm run smoke-http` | Bearer challenge, 401 body, valid token accepted, stateless subscribe refusal, tools and resources over POST | Readiness probe is a bad-body POST that is satisfied by the 401 handler, so it proves the listener is up, not that requests are handled. Fixed port 18493 can collide. No Origin check is tested | `HTTP_SMOKE_OK` |
| `npm run check-secrets` | No credential file in tree; 6 shape detectors plus embedded-VIN runs over every non-skipped file; positive and negative controls run first | Skips by extension (`.pdf`, `.map`, images), so content in a file named `.pdf` is invisible (proved). The opaque detector stops at 40 chars (proved). `.git` is skipped, so history is never scanned. A dump in `dist/` or `.unlazy/` is skipped | exit 0 at HEAD; exit 1 with the analysis artifact |
| `npm run check-tool-refs` | No unregistered tool-shaped name inside `src/*.ts` (root only) or `.env.example` | Docs are not scanned at all, so `README` and `docs/` prose is unchecked. The regex misses names ending in a digit or containing capitals (proved). `docs/write-endpoints.md` intentionally names six future tools, which is why a blanket docs scan needs an exemption | `TOOL_REFS_OK 26 names, 27 files` |
| `node docs/check-docs.mjs tools` | Every registered tool appears in `tools-reference.md`, and the three stated counts match the registry (23 / 26 / 15) | Only that one file, and only one direction. A documented tool that does not exist is not caught. No positive control | `DOCS_TOOLS_OK tools=26 domains=15` |
| `node docs/check-docs.mjs envvars` | Every `POLESTAR_*` name appearing in `src/config.ts` and `src/server.ts` also appears in `getting-started.md` | One direction only, two files only, one doc only. `README.md`, `.env.example` and the other docs are unchecked. Documented-but-unread variables are unchecked, which `CONTRIBUTING.md:60` promises ("and vice versa") | `DOCS_ENVVARS_OK` |
| `node docs/check-docs.mjs links` | Local links and anchors resolve in 9 files (README plus `docs/*.md`) | 5 markdown files are outside the walk: `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/releases/v0.3.0.md` (6 links today). `CONTRIBUTING.md:61` says no link is broken, without qualification | `DOCS_LINKS_OK` |
| `node docs/check-docs.mjs hygiene` | Four writing rules across git-visible plus untracked files, each with a positive control, with a 20-file scope floor | The floor only runs on the git path; the non-git fallback silently narrows to README plus `docs/*.md` with no floor. Skip list is hardcoded and includes agent scratch dirs | red only because of `analysis/`; passes on the tracked tree |

Not in CI at all: `npm audit`, `npm pack --dry-run`, any Docker build, any Node version other
than 22, any validation of `server.json`, `npm run demo-dump` (the only check against real
captured shapes, excluded because the dump lives outside the repo), actionlint, a lint or
format step, and any history-level secret scan.

## Coverage, as measured

`npm run coverage` at HEAD exits 0 with no threshold:

```
all files   | 95.54 line | 86.50 branch | 89.94 funcs   (includes test/ files)
src (26 files) mean | 95.71 line | 81.17 branch | 92.40 funcs
```

Lowest src files by line coverage:

| File | line % | branch % | funcs % | Uncovered |
| --- | --- | --- | --- | --- |
| `src/server.ts` | 69.44 | 53.57 | 32.43 | resource list and read handlers, prompt handlers, serveHttp, shutdown, CLI |
| `src/history-tools.ts` | 76.05 | 79.17 | 77.78 | 67-95, 103-113 (degradation and sessions tool bodies) |
| `src/failure.ts` | 87.18 | 81.82 | 80.00 | 25-32, 35-40, 45 |
| `src/auth.ts` | 91.33 | 79.41 | 92.86 | 53-59 |
| `src/advisor-tools.ts` | 93.38 | 33.33 | 100.00 | 52, 55-56, 61-64, 73-74 |

The least-covered behaviour that matters is the resource surface in `src/server.ts`: the
listing and read closures are the code that returns VINs with redaction on (finding 1), and the
only automated check that exercises them is the smoke run, which does not look at redaction or
at the URI. `history-tools.ts` is second: the math in `history.ts` is well covered (96.96) but
two of the three tool bodies that read it are not, and the smoke script calls only `get_history`.

## Ranked findings

Severity considers consequence for an operator or for the project's own honesty rule; effort and
risk are for the fix.

### 1. HIGH. `POLESTAR_REDACT_VIN` leaks full VINs through three undocumented paths

Evidence (probe with `POLESTAR_REDACT_VIN=1` against `build/server.js`, fixture VIN is the
synthetic marker):

```
masked            tools/call get_battery (no raw)
FULL-VIN-PRESENT  tools/call get_battery raw:true        <- documented exception
FULL-VIN-PRESENT  resources/list entry uri
masked            resources/list entry name
masked            resources/read content text
FULL-VIN-PRESENT  resources/read echoed uri
masked            tools/call list_vehicles
```

and for errors, with no redaction applied to the message:

```
errorResult contains requested VIN: true
errorResult contains other VIN    : true
VIN_MISMATCH (HTTP 200): Requested <vin A> but the telemetry/battery response is labelled <vin B>.
```

Code: `src/server.ts:285` builds resource URIs from the raw VIN and only masks the `name`;
`src/client.ts:125` lists raw VINs in `AMBIGUOUS_VIN`; `src/client.ts:228` and `:246` put raw
VINs in `VIN_MISMATCH`; `src/vehicle-read.ts:94` puts raw VINs in the elicitation `enum` and
`:109` in the `VIN_NOT_CHOSEN` message. `SECURITY.md:26-30` says redaction covers rendered
output and the structured envelope "including the resource listings", with `raw: true` as the
only exception. That is false in four places. `src/config.ts:36-41` repeats the same two-path
story.

Consequence: an operator who sets the flag to keep VINs out of a shared transcript still sends
VINs to the model on a resource listing, on any identity mismatch, and whenever a credential
sees several cars. The mismatch path is exactly the event a privacy-minded operator is watching.

Improvement: pass the redaction rule into the error and elicitation builders (`maskVin` for
`VIN_MISMATCH`, `AMBIGUOUS_VIN`, `VIN_NOT_CHOSEN`, and mask the elicitation enum while keeping
the value map), and either document the URI exception or change the resource template to a
masked handle with a lookup. Add one assertion in `runtime.test.ts` and one in `smoke.ts` for
the resource listing and the mismatch error.

Effort: M. Risk: low, plus one compatibility decision on resource URIs.

### 2. HIGH. The coverage gate cannot fail, and the two thinnest areas are the ones the claims lean on

Evidence: `package.json:25` is
`node --import tsx --test --experimental-test-coverage --test-reporter=spec "test/"*.test.ts`
with no `--test-coverage-lines`, `--test-coverage-branches` or `--test-coverage-functions`, and
no `.c8rc`. Running it at HEAD exits 0. Deleting a test file, or a test inside a file, changes
no exit code. `CONTRIBUTING.md:53` describes this gate only as "How much of the source the unit
suite reaches", which is honest prose, but the gate is listed in a table whose framing is
"every claim has something that can fail" (`CONTRIBUTING.md:64-65`).

Consequence: the one measurement designed to detect erosion has no threshold, so coverage can
fall until the suite is decorative and every gate stays green. Today `server.ts` is at 69.44
line and 32.43 funcs with CI green.

Improvement: add `--test-coverage-lines=92 --test-coverage-branches=78 --test-coverage-functions=88`
or a small assertion script that parses the report and fails on any src file below a floor;
publish the number in the PR template. Effort: S. Risk: low, but it will fail until
`server.ts` and `history-tools.ts` get tests, which is the point.

### 3. MEDIUM. Two moderate advisories sit in the production dependency path, but the vulnerable code path is not reachable

Evidence:

```
$ npm audit
@hono/node-server 1.19.10 - 2.1.2  moderate  GHSA-rmxm-3fg6-px4f (serveStatic path decode bypass)
hono 4.12.4 - 4.13.10             moderate  GHSA-5r4p-p66f-jhc7 (same class)
2 moderate severity vulnerabilities
$ npm audit; echo $?   -> 1
```

`npm ls` shows `@modelcontextprotocol/node@2.1.2` pulling `hono@4.13.8` and a nested
`@hono/node-server@1.19.17`, both inside the reported ranges. Both are production dependencies,
so `npm audit --omit=dev` still reports them. Actual exposure in this codebase: none found.
`node_modules/@modelcontextprotocol/node/dist/index.mjs:2,153,239` imports only
`getRequestListener`; a grep for `serveStatic` in that package's dist returns 0 matches, and
this repo never imports `hono` at all (`src/` has no hono import). HTTP mode is a raw
`node:http` server (`src/server.ts:421`) feeding `NodeStreamableHTTPServerTransport`; there is
no static-file middleware to bypass. The advisory needs `serveStatic` registered, which nothing
here registers.

Consequence: not "we are vulnerable today", but "we cannot claim a clean audit", and no gate
watches the property so the next transitive bump could matter. `npm audit fix` is reported
available; the fix is a version bump of a transitive dependency.

Improvement: add an `npm audit --omit=dev --audit-level=moderate` step (or `npm audit --json`
with a small parser so the gate is explicit), and take the fix in the same PR. Effort: S.
Risk: low.

### 4. MEDIUM. HTTP mode has no Origin or Host validation, so loopback mode is reachable by DNS rebinding

Evidence: `src/bind.ts:19` allows `127.0.0.1`, `localhost` and `::1` with no token, by design.
`src/server.ts:421-424` is the whole request gate: when a token is configured it compares
`authorization`; when no token is configured (the default loopback case) nothing is checked.
A grep for `origin` across `src/` returns nothing. `scripts/smoke-http.ts` tests the bearer
challenge but never sends an `Origin` header.

Consequence: a browser page that resolves its own hostname to `127.0.0.1` can POST JSON-RPC to
the loopback listener and read vehicle data with no credential, because CORS does not apply to
same-origin after rebinding. The token path closes this; the default path does not. `SECURITY.md`
discusses the token rule but not origin binding.

Improvement: for loopback mode, reject requests whose `Origin` is present and not loopback, and
whose `Host` is not the bound authority; add two assertions to `smoke-http.ts`. Effort: S.
Risk: low, with a small compatibility cost for clients that send an `Origin` header.

### 5. MEDIUM. The Dockerfile is unbuilt, unvalidated, runs as root, and is undocumented

Evidence: `Dockerfile:2,9` use `node:22-alpine` twice with no digest pin; there is no `USER`
line, so the published runtime is root. No `.dockerignore` exists. Nothing in `.github/`,
`README.md` or `docs/` mentions Docker, so the file is invisible to both the docs gates and the
release notes. `docker` is not installed on the audit host, so the image was not built; it is
not built in CI either.

Consequence: the one artifact that runs with elevated privilege is the one no check touches. A
base-image drift, a broken `npm ci --omit=dev`, or a missing runtime file would be found by a
user, not by CI. `SECURITY.md` has no container section at all.

Improvement: add `USER node`, pin the base image by digest, add a `docker build` plus a
`--version` run to CI, and add `.dockerignore`. Or delete the file if the container is not a
supported path. Effort: S to M. Risk: low.

### 6. MEDIUM. The secret gate has three proven blind spots, two of them content-based

Evidence, each produced by a probe file under `analysis/ops/probes/` and removed afterwards:

* Extension skip hides content. A file named `_probe-secret.pdf` containing the same VIN shape,
  email shape and coordinate shape as a `.txt` probe produced `SECRETS_CLEAN`, while the `.txt`
  produced three findings. `scripts/check-secrets.mjs:27` skips `.png .jpg .ico .map .pdf` by
  extension and never inspects content.
* Opaque credential length ceiling. A 31-character lowercase alnum blob was flagged
  (`opaque-credential-shape`, line 2); a 41-character blob in the same file was not.
  `scripts/check-secrets.mjs:45` matches 25 to 40 characters with word boundaries, so anything
  longer has no boundary at 40 and is invisible.
* History is never scanned. The walk starts at the project root and skips `.git`
  (`scripts/check-secrets.mjs:22,166-177`). A live dump committed and then deleted leaves the
  working tree clean forever.

Consequence: the gate's own docs are careful ("any scanned file"), but the README and
`CONTRIBUTING.md:57` read as broad assurances. `.pdf` and `.map` in particular are ordinary
places a captured report or a build artifact could carry a VIN.

Improvement: keep the extension skip only for files that are not text (sniff the first bytes),
add a `git grep`/gitleaks pass over history in CI, and widen the opaque rule to a length floor
with no ceiling. Effort: M. Risk: low, but a history scan will produce a baseline to triage.

### 7. MEDIUM. `check-tool-refs` does not read the prose it claims to protect, and its regex has a hole

Evidence: `scripts/check-tool-refs.mjs:97-100` builds `sources` from `src/*.ts` (top level only)
plus `.env.example`. `docs/`, `README.md` and `scripts/` are not scanned. Meanwhile
`docs/consumer-adapter-note.md` names `get_car_details` and `get_car_images`, and
`docs/write-endpoints.md` names six future write tools; none are registered. The regex at
`scripts/check-tool-refs.mjs:30` is `\b(?:get|list|is|plan|polestar)_[a-z][a-z_]*\b`, and it
returns no match for names with a digit or a capital:

```
"call get_battery_typo now" -> ["get_battery_typo"]   (caught)
"call get_battery_2 now"    -> null                    (missed)
"call get_battery2 now"     -> null                    (missed)
"call get_batterY now"      -> null                    (missed)
```

Consequence: `CONTRIBUTING.md:58` says "Prose an agent or operator acts on never names a tool the
registry does not define". The prose an operator reads most, the docs, is out of scope. Today
the only undefined names are deliberate future-tense ones, so this is a latent gap, not a live
drift, but any typo in the tool table ships silently.

Improvement: scan `docs/**` and `README.md` with an explicit allowlist for names under a
"future" heading (or a per-file exemption list), and make the regex tolerate digits. Add a
positive control that proves a doc hit fails. Effort: S. Risk: low, with one decision about how
future tool names are marked.

### 8. MEDIUM. The env-var gate is one-directional, and two shipped surfaces already contradict it

Evidence: `docs/check-docs.mjs:196-207` reads `POLESTAR_*` names from `src/config.ts` and
`src/server.ts` only, and checks only that `docs/getting-started.md` contains them.
`CONTRIBUTING.md:60` promises "and vice versa"; that direction does not exist in the code.
Derived drift:

* `--help` prints "Every variable the server reads is listed there" while pointing at
  `.env.example` (`src/server.ts:511`). Four registry variables are absent from that file:
  `POLESTAR_ENV_FILE`, `POLESTAR_HISTORY_SAMPLE_SECONDS`, `POLESTAR_ENABLE_WRITES`,
  `POLESTAR_STRICT_ENV`.
* `polestar_status` prints `Cache: off (POLESTAR_CACHE_DISABLED, ...)`.
  `POLESTAR_CACHE_DISABLED` is not an environment variable: cache off is `POLESTAR_CACHE=off`.
  `src/system-tools.ts:54` ships the wrong name and `test/server-seams.test.ts:251` asserts it,
  so the test locks the defect in. A user following the tool's own output gets the
  "unrecognized variable" warning, which at least suggests `POLESTAR_CACHE`.
* README has the complete 27-variable table and it matches the registry, but no gate reads it,
  so it can drift freely.

Consequence: the "unknown variable" safety net is good, and the docs next to it send users to
names the server does not read. This is the exact class AGENTS.md calls a defect: a claim that
nothing applies.

Improvement: derive the check from `KNOWN_ENV_VARIABLES`, check both directions across
`README.md`, `docs/getting-started.md` and `.env.example`, fix the status line, and assert the
real variable name in the test. Effort: S. Risk: low.

### 9. MEDIUM. Documented checks overstate their detectors, and one safety test is a source grep

Evidence:

* `CONTRIBUTING.md:54` says `npm run smoke` proves elicitation. `scripts/smoke.ts` never elicits:
  the fixture has one vehicle, so `resolveVin` short-circuits and `elicitInput` is never called.
  Elicitation is covered by `test/runtime.test.ts:513-529` and `:800`, not by the smoke run.
* `docs/development.md:107` says "Three structural detectors" run over every text file,
  listing JWT, opaque blob and VIN. `scripts/check-secrets.mjs:93-100` has six detectors plus
  the embedded-VIN run and two dump markers, and it also detects email, phone and coordinates.
  The same page also lists "both smoke runs" (`docs/development.md:97`) while CI runs three.
* The token-leak test (`test/runtime.test.ts:300-313`) reads six source files and greps for log
  lines mentioning token or authorization. It excludes `src/server.ts`, which holds most of the
  logging calls, and it carries no positive control, so a broken filter line would still pass.
* `docs/development.md:73` says the `engines` field enforces the Node floor. `npm config get
  engine-strict` returns `false`, so npm warns and proceeds.

Consequence: every one of these is a claim about a check, not a behaviour, so no test can fail
when the claim stops being true. They are exactly what the project's house rule targets.

Improvement: correct the four sentences, and give the token-leak test a positive control (scan
a synthetic violating line and assert the filter catches it) and include `src/server.ts`.
Effort: S. Risk: low.

### 10. MEDIUM. The declared Node floor is untested, partly wrong, and below end of life

Evidence: `package.json:6-8` declares `>=20.6.0`; CI (`ci.yml:12`) and both Docker stages use
Node 22 only, so the floor is never executed. Three dev scripts use `import.meta.dirname`
(`scripts/verify-fixtures.mjs:8`, `scripts/capture.ts:20`, `scripts/server-for-inspector.ts:4`),
which Node added in 20.11, so the documented contributor workflow fails on the declared minimum
with a `path.resolve(undefined)` TypeError. `README.md:227`, `docs/getting-started.md:15` and
`docs/development.md:73` say "Node 20", `docs/releases/v0.3.0.md:7` says 20.6, and no two agree
with the others exactly. Node 20 reached end of life in April 2026.

Consequence: the supported range is a guess. Users on the declared floor either get a warning
and a working server, or a confusing crash in `verify-fixtures`, depending on which command they
run.

Improvement: either raise `engines` to `>=22` and say Node 22 everywhere, or add a 20 and 22
job matrix to CI; replace `import.meta.dirname` in scripts if 20.6 is meant to stay; add
`engine-strict=true` in `.npmrc` so the field means what the docs say. Effort: S. Risk: low.

### 11. LOW to MEDIUM. Packaging ships a README whose doc links are not in the package, and `server.json` is validated by nothing

Evidence: `npm pack --dry-run` reports 85 files, 120.1 kB, including `README.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `.env.example` and `build/`, with no `docs/`. `README.md` links
to eight files under `docs/`, and `CONTRIBUTING.md` links to three, so an installed copy or a
tarball reader gets dead relative links. `server.json` is referenced by no check and no doc; it
uses `packages[0].name`; the registry schema for the declared epoch, as far as this audit can
tell offline, uses `packages[0].identifier`, and `package.json` carries no `mcpName` binding.
The top-level and package `version` fields must match `package.json`, and nothing asserts that.
`main` points at a module that starts a server on import.

Consequence: publishing is the first validation of `server.json`, and a schema or version
mismatch is discovered by the registry, not by CI. The dead links are cosmetic but they are the
first thing an npm browser sees.

Improvement: add `docs` to `files` (or ship a single flattened page), add a small check that
`server.json` version and name match `package.json`, validate it against a vendored schema, and
add `mcpName`. Effort: S to M. Risk: low.

### 12. LOW. Two checks that can pass while their property is broken, and test discovery has a silent skip

Evidence:

* `scripts/smoke-bin.ts:28` chmods `build/server.js` before testing the installed launch path
  (`postbuild` is supposed to set that mode), and `:41` resolves every child exit with
  `code: 0`, so the check cannot observe a nonzero exit. The property "the published artifact is
  executable" is repaired rather than tested.
* `package.json:16,25` discover tests as `"test/"*.test.ts`. A file named `foo.spec.ts`, a nested
  `test/unit/foo.test.ts`, or a renamed file simply does not run, and no count floor fails.
* `verify-fixtures` checks `pinnedKeys` nowhere; `contract.test.ts` does, so this one is only a
  duplicated-scope note.

Improvement: read the mode instead of setting it; capture and assert exit codes; use
`node --test "test/**/*.test.ts"` or a count floor. Effort: S. Risk: low.

## Supply chain, containers, secrets: the detail behind findings 3, 5 and 6

* Lockfile: `lockfileVersion 3`, 58 packages, every resolved entry has an `integrity` hash, no
  `overrides`, no git dependencies, no `file:` dependencies. `npm ci` is used in CI, so drift
  between manifest and lock fails before anything else runs. This part is solid.
* Production closure: `zod`, `@modelcontextprotocol/server`, `@modelcontextprotocol/core`,
  `@modelcontextprotocol/node`, `hono`, `@hono/node-server`. That is a small, plausible set. No
  postinstall-heavy transitive dependencies were observed in the audit run.
* Dependabot is present (`.github/dependabot.yml`: weekly npm, monthly actions, limit 5). This
  contradicts the brief's hypothesis. It has no grouping and no security-only rule, which is
  acceptable, but it means advisory bumps arrive as ordinary PRs and nothing forces the audit to
  be read.
* Workflow hardening: no `permissions:` block (default token permissions apply), no
  `concurrency`, no `timeout-minutes`, and actions are on mutable major tags
  (`actions/checkout@v7`, `actions/setup-node@v7`). The v7 tags could not be verified offline;
  whatever the current major is, a tag is mutable and a commit SHA is not. `on: push` plus
  `pull_request` with no branch filter runs twice per internal PR.
* Docker: findings 5. No `USER`, no digest pin, no `.dockerignore`, no CI build, no docs mention.
* Redaction: finding 1. `raw: true` is a documented exception and is implemented correctly;
  the undocumented leaks are the interesting part.
* Allowlist checks: both are enforced in code, not prose. `src/vehicle-read.ts:47-56` refuses a
  delegated account not in `POLESTAR_DELEGATED_ACCOUNT_IDS` with `DELEGATION_NOT_ALLOWED`, and
  `src/client.ts:140-146` refuses location before any transport call, so the "no quota spent"
  claim holds for that path. `assertIdentity` (`src/client.ts:224-248`) does refuse a mismatched
  envelope, though its error text is the leak in finding 1.
* Fixture capture path: `scripts/capture.ts:47` writes the raw capture to `ROOT/../capture-<utc>`,
  outside the tree, and sanitizes VINs, coordinates, ids, timestamps and emails before writing
  fixtures. This matches `AGENTS.md`.
* `.gitignore` covers the whole `.env` family with a `.env.example` exception, and the scanner
  scans filesystem-wide rather than git-wide, so ignored files are still seen. That is stronger
  than the usual setup; the gaps are the extension list and history.

## Docs drift table, derived

| Claim | Where | Derived truth | Gate that would catch it |
| --- | --- | --- | --- |
| "Every variable the server reads is listed there" (`.env.example`) | `src/server.ts:511` | 4 of 27 absent: `POLESTAR_ENV_FILE`, `POLESTAR_HISTORY_SAMPLE_SECONDS`, `POLESTAR_ENABLE_WRITES`, `POLESTAR_STRICT_ENV` | none |
| `polestar_status` names `POLESTAR_CACHE_DISABLED` | `src/system-tools.ts:54` | no such variable; the switch is `POLESTAR_CACHE` | none; the test asserts the wrong name |
| "Three structural detectors" | `docs/development.md:107` | six shape detectors plus two derived runs | none |
| CI list "both smoke runs" | `docs/development.md:97` | three smoke commands in `ci.yml` | none |
| smoke proves elicitation | `CONTRIBUTING.md:54` | smoke never elicits; runtime tests do | none |
| "and vice versa" for env vars | `CONTRIBUTING.md:60` | check is one-directional | none |
| no broken link anywhere | `CONTRIBUTING.md:61` | 6 links in 5 files are unchecked | none, they are outside the walk |
| "the engine field enforces it" | `docs/development.md:73` | `engine-strict` is false, so it warns | none |
| Node 20 / 20.6 / Node 22 | README, getting-started, release notes, engines, CI | four statements, two values, one EOL line | none |
| "Every tool carries `readOnlyHint`" | README, tools-reference, release notes | true at HEAD: 26 of 26, asserted by smoke | smoke |
| tool counts 23 / 26 / 15 | tools-reference | true at HEAD, derived | check-docs tools |
| server.json version and fields | `server.json` | matches `package.json` today; schema unvalidated | none |

## Developer experience and process gaps (lower priority, no finding number)

* No linter and no formatter. `devDependencies` is `@types/node`, `tsx`, `typescript`. There is
  no ESLint, Biome or Prettier config, so rules that tsc cannot express (floating promises,
  unsafe casts, unused promise chains) have no gate.
* The three gate scripts (`check-secrets.mjs`, `check-tool-refs.mjs`, `check-docs.mjs`) are
  plain `.mjs`, outside the typecheck (`allowJs` is off), so the most trusted code in the repo
  has no static checking. Their embedded controls partly compensate.
* No performance budget. Nothing asserts a call latency or a summary size, so a summarizer that
  grows a payload by an order of magnitude passes.
* No recorded live contract snapshot in CI. `contract.test.ts` checks the synthetic dump, and
  `demo-dump` (the real dump) is deliberately excluded, so `docs/live-contract-findings.md`
  cannot be re-verified by a push. That is a defensible trade, but it means the live-shape
  claims age silently.
* `smoke.ts` creates a temp history directory with `mkdtempSync` and never removes it, so each
  run leaks a directory under the system temp root.
* Issue templates exist, but `.github/ISSUE_TEMPLATE/config.yml` does not, so security reports
  have no private channel entry point. `SECURITY.md:83-86` points at "the repository's private
  vulnerability reporting if it is enabled", which nothing verifies.

## Top 5 changes by leverage

1. **Give coverage a threshold and put the resource and history-tool bodies under test**
   (findings 1 and 2 together). One `--test-coverage-lines` flag plus two tests turns the
   weakest file from an unknown into a guarded one, and the tests you must write are the ones
   that would have caught the redaction leak.
2. **Fix the redaction boundary and make it checkable** (finding 1). Mask VINs in `VIN_MISMATCH`,
   `AMBIGUOUS_VIN`, `VIN_NOT_CHOSEN` and the elicitation enum, decide the resource-URI rule,
   then assert all four in `runtime.test.ts` plus the smoke run. This is the only finding with a
   live privacy consequence.
3. **Make the docs gates match their sentences** (findings 7, 8, 9). Scan `docs/` and the root
   markdown files, derive env vars from `KNOWN_ENV_VARIABLES` in both directions, fix the four
   sentences that overstate detectors, and add the missing positive controls. Effort is small
   because the machinery already exists; the value is that the project's own honesty rule starts
   applying to its own documentation.
4. **Add the three missing supply-chain gates** (findings 3, 5, 6): audit at moderate, a Docker
   build with a non-root `USER` and a digest pin, and a history-level secret scan. Each is a
   small workflow edit; together they cover the classes the current gates cannot see.
5. **Bind HTTP mode to its origin** (finding 4). Two header checks and two smoke assertions
   close a hole that the token rule leaves open in the default loopback configuration.

## Appendix: how the probes were run

All probes are in `analysis/ops/probes/` and use the synthetic fixture VIN only; the secret
probe files were deleted after use and the tree was re-checked clean.

```
node analysis/ops/probes/redact-probe.mjs          # resource URI and raw payload redaction
node --import tsx analysis/ops/probes/redact-error-probe.ts   # VIN_MISMATCH text
node scripts/check-secrets.mjs                     # probe .txt caught, probe .pdf missed
node docs/check-docs.mjs emdash|connectors         # untracked probe file fires the detector
node --import tsx scripts/list-tools.ts --detail    # registry derived, 26 tools
node -e '<tool-refs regex demo>'                   # digit and capital names escape the regex
```

Derivations used the real commands, not the docs: `npm run coverage` for the numbers,
`npm ls --all` and `npm audit --json` for the dependency graph, `npm pack --dry-run` for the
file list, `node docs/check-docs.mjs <subcommand>` for each docs gate, and
`git ls-files --cached --others --exclude-standard` for what the hygiene walk actually sees.
