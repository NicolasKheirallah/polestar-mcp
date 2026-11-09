# 04. Ecosystem, packaging, tests and docs inventory

Scope: `test/*.ts`, `test/helpers.ts`, fixtures, `scripts/*`, `docs/check-docs.mjs`, `package.json`,
`tsconfig.json`, `tsconfig.dev.json`, `.github/workflows/ci.yml`, `CONTRIBUTING.md`, `README.md`,
`CHANGELOG.md`, `docs/getting-started.md`, `docs/development.md`, `docs/releases/v0.3.0.md`,
`server.json`, `.env.example`, `.github/dependabot.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, and the
`Dockerfile` for distribution only. Container runtime behaviour is platform-analyst's lane.

Method: files and commands only, no live Polestar credential, no tracked file modified. Prior work
read and re-checked: `analysis/00-brief.md`, `analysis/D-ecosystem.md`, `analysis/E-runtime.md`,
`analysis/council/R1-product.md` sections 1, 3 and 4, `R2-engineering.md` verification log and
falsifiability gate, `R3-security.md` sections 2 and 3, `analysis/surface/findings.md` section 0.
External state was re-fetched on 2026-11-09 (see "External checks" at the end of section 1).

## 1. Verified defects

Ordered by severity. Every item has a file:line and a reproduction or code proof.

### P1. The release note tells users to install a package that does not exist (false published claim)

`docs/releases/v0.3.0.md:11` prints `npm install -g polestar-mcp` and `:15` prints `polestar-mcp`.
The registry has no such package:

```text
$ npm view polestar-mcp version
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/polestar-mcp - Not found
```

`package.json:3` is `0.3.0`, so this is not a stale version claim: there is no installable artifact
behind the release note. This also contradicts D-ecosystem's "npm is the first wall" finding, now
re-verified. Severity: high, because the first command in a release note fails.

### P2. The offline quickstart fails on a clean checkout, and the shipped dump is not the one it uses

`README.md:51` says "The repository ships a sanitized captured dump, and the demo asserts real
values"; `README.md:56` says `npm run demo-dump` "runs the whole server in fixture mode, prints
DUMP_OK"; `README.md:57` says `POLESTAR_FIXTURES_DIR=.. npm start`. The same claim appears in
`docs/getting-started.md:140-150` and `docs/development.md:69,93`. Reproduced:

```text
$ npm run demo-dump
DUMP_FAILED: expected captured dump at /Users/nicolaskheirallah/Documents/GitHub (dataportal/vehicles.json not found)
demo_exit=1
```

Cause: `scripts/demo-dump.ts:14` resolves the parent of the project, `:16-19` refuses before any
environment override is read, so `POLESTAR_FIXTURES_DIR` cannot point the script at the shipped
`test/fixtures/dump` (68K, tracked, verified by `ls test/fixtures/dump` and `npm run verify-fixtures`
printing `FIXTURES_OK`). A reader who follows the README gets exit 1.

### P3. The published tarball's README instructs commands whose files it does not contain

`package.json:45-53` lists `build`, `README.md`, `LICENSE`, `.env.example`, `SECURITY.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`. `npm pack --dry-run --json` reports 85 files and 436,330 unpacked
bytes, with no `scripts/` and no `test/` entry. The tarball is the document an npm user reads:

```text
$ npm pack; tar -xzf polestar-mcp-0.3.0.tgz -C /tmp/polestar-pack
$ ls /tmp/polestar-pack/package
CHANGELOG.md CONTRIBUTING.md LICENSE README.md SECURITY.md build package.json
$ ls /tmp/polestar-pack/package/scripts
No such file or directory
$ grep -n demo-dump /tmp/polestar-pack/package/README.md
56:npm run demo-dump                       # runs the whole server in fixture mode, prints DUMP_OK
222:npm run demo-dump      # stdio end-to-end against the real captured dump
```

`README.md:13` also advertises an `offline_demo-yes` badge. The installed package has no fixture
data and no demo script, so the badge and both commands are false for every npm or npx install.

### P4. Registry metadata cannot validate or publish: wrong schema URL, wrong package key, no mcpName

`server.json:2` declares `$schema` `https://static.modelcontextprotocol.io/schemas/2025-12-01/server.schema.json`;
that URL returns 404. The current published schema (`2025-12-11`) returns 200, and validating the file
against it gives exactly one error:

```text
$ python3 -c "... jsonschema.Draft202012Validator(schema).iter_errors(doc) ..."
errors: 1
 - packages/0 : 'identifier' is a required property
```

`server.json:12-15` uses `name`, but `definitions.Package.required` is
`[registryType, identifier, transport]`. `package.json` has no `mcpName`; the registry quickstart
states: "For npm packages, this requires adding an `mcpName` property to `package.json`" and "The
`name` property in `server.json` must match the `mcpName` property". The registry search is empty:

```text
$ curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=polestar'
{"servers":[],"metadata":{"count":0}}
```

`server.json:9` and `:14` also duplicate the version, so a bump can miss one.

### P5. The coverage job cannot fail; there is no threshold and the report includes test files

`package.json:25` runs `--experimental-test-coverage` with no `--test-coverage-lines`,
`--test-coverage-branches` or `--test-coverage-functions`. This violates the house rule that a check
must be able to reject something. Measured output: all files 95.54 line, 86.50 branch, 89.94 funcs;
`src/server.ts` 69.44 line, `history-tools.ts` 76.05 line, `advisor-tools.ts` 33.33 branch. Node 22
supports the threshold flags, so the missing gate is a choice, not a platform limit:

```text
$ node --import tsx --test --experimental-test-coverage --test-coverage-lines=99 --test-reporter=spec "test/"*.test.ts
Error: 95.54% line coverage does not meet threshold of 99%.
[exit 1]
```

### P6. `scripts/smoke-bin.ts` passes while its handshake child hangs until a 20 second kill, and it hides launch failures

`scripts/smoke-bin.ts:39-42` writes stdin, never ends it, and resolves `{ code: 0 }` from the `exit`
handler regardless of the real exit code. The handshake run therefore waits for the 20,000 ms
SIGKILL timer. Measured:

```text
$ time npm run smoke-bin
BIN_SMOKE_OK --version, --help and the MCP handshake all work launched through the bin symlink
real 0m20.300s
```

`scripts/smoke-bin.ts:28` also runs `chmodSync(SERVER, 0o755)` inside the test, so
`CONTRIBUTING.md:51`'s claim that `npm run build` proves the published file "is executable" is not
tested: the test creates the mode it later assumes. `--version` and `--help` exit codes are ignored
because `run()` always resolves 0.

### P7. The documentation gates are narrower than the claims they carry

All four probes were run on a throwaway copy of the tracked tree (`git archive HEAD` to `/tmp/eco-copy`,
node_modules symlinked), then reverted there. Each gate printed OK against a defect it should catch.

- `docs/check-docs.mjs:25-29` builds `DOC_FILES()` from `docs/*.md` plus `README.md` only.
  `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `AGENTS.md` and `docs/releases/**` are never
  scanned. Proof: appending `[missing](docs/does-not-exist.md)` to `CONTRIBUTING.md` and
  `[missing](does-not-exist.md)` to `docs/releases/v0.3.0.md` still prints `DOCS_LINKS_OK`
  (exit 0), while `CONTRIBUTING.md:61` claims "No link points at a file or heading that does not
  exist".
- `docs/check-docs.mjs:79` reads only `docs/tools-reference.md`. Deleting the `get_pre_cleaning` row
  from `README.md` still prints `DOCS_TOOLS_OK tools=26 domains=15`.
- `docs/check-docs.mjs:196-207` collects names from `src/config.ts` and `src/server.ts` with
  `/POLESTAR_[A-Z_]+/g` and only tests that `docs/getting-started.md` contains each name. The regex
  stops at a digit, so an undocumented variable read in `config.ts` as
  `POLESTAR_TIMEOUT_2_MS` passes (proved: `DOCS_ENVVARS_OK`, exit 0). Removing
  `POLESTAR_M2M_TOKEN_ENDPOINT` from the doc fails with the wrong name:
  `ENVVARS_CHECK_FAILED: not documented: POLESTAR_M`. `CONTRIBUTING.md:60` claims the check is
  bidirectional ("and vice versa"): adding a doc-only variable `POLESTAR_DOC_ONLY_NOT_READ_ANYWHERE`
  passes, and appending a read of `process.env.POLESTAR_UNREAD_UNLISTED` to `src/bind.ts` also passes.
- `scripts/check-tool-refs.mjs:97-100` scans `src/*.ts` plus `.env.example` only. Adding an
  unregistered `get_tyre_pressure` to `docs/tools-reference.md` still prints
  `TOOL_REFS_OK 26 registered names, 27 instruction-surface files scanned, 0 undefined names referenced`;
  the same name in `src/bind.ts` fails, so the detector works but the scope is source-only while
  `CONTRIBUTING.md:58` says "Prose an agent or operator acts on never names a tool the registry does
  not define". The script also has no positive control, unlike `docs/check-docs.mjs`.

### P8. Version numbers live in six places and one document claims there is only one

`docs/development.md:126`: "The server reports its version in the MCP handshake from `package.json`
(currently 0.3.0), so there is exactly one version number to bump." Actual locations:
`package.json:3`, `server.json:9`, `server.json:14`, `README.md:9`, `CHANGELOG.md:70`,
`docs/releases/v0.3.0.md:1`, plus the hardcoded `0.3.0` in `docs/development.md:126`. Nothing checks
that `build/server.js --version` (observed `0.3.0`), the packed `package.json`, the registry file and
the changelog agree.

### P9. The documented Node floor is below what the developer scripts require, and CI never tests the floor

`package.json:6-8` says `"node": ">=20.6.0"`. `README.md:10` advertises `>=20`, `README.md:227` and
`docs/getting-started.md:15` say "Node 20 or newer", while `docs/releases/v0.3.0.md:7` says 20.6.
Three scripts use `import.meta.dirname`: `scripts/capture.ts:20`, `scripts/verify-fixtures.mjs:8`,
`scripts/server-for-inspector.ts:4`. Node's own v20 documentation says `import.meta.dirname` was
added in v20.11.0, so `npm run verify-fixtures` and `npm run capture` cannot work on 20.6 through
20.10. `.github/workflows/ci.yml:12` pins Node 22 only, so no job ever runs the claimed floor.

### P10. The shipped `--help` claims `.env.example` lists every variable; five of 27 are missing

`src/server.ts:508-513` prints "Every variable the server reads is listed there" for `.env.example`.
`README.md:178` says "Full configuration reference (27 variables)". Counting `.env.example:1-43`:
`POLESTAR_ENV_FILE`, `POLESTAR_HISTORY_SAMPLE_SECONDS`, `POLESTAR_ENABLE_WRITES` and
`POLESTAR_STRICT_ENV` have no entry at all, and `POLESTAR_HISTORY_DIR` appears only inside a comment
at `.env.example:27`, not as a settable line. That is five variables the help text promises.

### P11. The changelog's 0.3.0 verification claims are not true of the tree

- `CHANGELOG.md:90` lists "logging notifications" as added. `grep -rn "sendLoggingMessage" src/`
  returns nothing; `src/server.ts:215` only declares `logging: {}` in capabilities. No logging
  notification is ever emitted.
- `CHANGELOG.md:138` names gates "G2 unit suites, G3 stdio smoke, G4 secret hygiene, G5 real-dump
  compatibility, G6 HTTP smoke, G7 typecheck plus fixture completeness plus coverage". Those gate
  names exist nowhere else: `grep -rn "G[2-7]" .github/ docs/ scripts/` returns only this changelog.
  G5 is the demo-dump path that fails on a clean checkout and is explicitly not run in CI
  (`.github/workflows/ci.yml:38`).
- `CHANGELOG.md:139` says "The smoke runs exercise all 26 registered tools". `npm run smoke` prints
  `registry: 26 tools, 24 callable with no args` and calls the 24 callable tools plus `get_history`;
  `plan_cheapest_charge` is never called (grep shows it only in the expected-name list at
  `scripts/smoke.ts:27`). That is 25 of 26.
- `CHANGELOG.md:6-68` keeps an `Unreleased` section while `package.json:3`, `server.json:9,14` and
  `docs/releases/v0.3.0.md` all say 0.3.0. Publishing this tree would ship changes the 0.3.0 section
  does not describe.

### P12. The smoke test locks in the duplicated result envelope, so the measured cost fix would break CI

`scripts/smoke.ts:64-67` requires every `outputSchema` to contain `ok` and `message`;
`scripts/smoke.ts:78` asserts `structuredContent.message === content text`. Measured today:
`get_battery` text 161 bytes, structured 256 bytes, duplicate `true`; `tools/list` 44,841 bytes at
23 tools and 50,718 at 26, of which 26,234 bytes (51.7 percent) is one output schema repeated
(E-runtime.md:51-56 re-measured: `distinctOutputSchemas 1`, `oneSchemaBytes 1009`). The test that
CONTRIBUTING.md:54 cites as proof is therefore the reason candidate E3 (send the text once) cannot
land without editing the proof.

### P13. The default 23-tool surface is never composed in a test, so a prompt names unregistered tools

`test/server-seams.test.ts:255-286` builds the prompt name set from `historyToolSpecs` unconditionally,
so `battery-health-report` passes against the 26-tool union. The prompt is registered unconditionally
at `src/server.ts:389-403` and names `get_degradation_report` and `get_charging_sessions`. Measured
default surface: `tools 23` when `POLESTAR_HISTORY_DIR` is unset. A model following that prompt on a
default install calls two tools that are not registered. The same gap is why the `tools/list`
default-vs-history question has no composition test (R2 V14).

### P14. Redaction is tested only on the tool envelope; the resource surface leaks the VIN (test gap for a known defect)

`test/runtime.test.ts:345-365` asserts the tool envelope is masked. With
`POLESTAR_REDACT_VIN=1` on the fixture, measured through the real stdio server:

```text
toolTextHasFullVin false
vinField YSM...001
resourceUrisWithFullVin 15 of 15
completion {"values":["YSMTEST22PL000001"],"total":1,"hasMore":false}
readUriHasFullVin true
```

The builders are `src/server.ts:283-300` and `:306-317`. This is lead P0-3 and A5 material; the
ecosystem failure is that no test can fail on it, so the surface lane's fix has no regression gate.

### P15. The delegated-account cache key has no regression test

`src/caching-transport.ts:83` keys entries on the URL alone; `test/client.test.ts:405-419` tests only
that a delegated read sends one request through the client, not that two identities do not share a
cache entry. R2 V3 reproduced `DELEGATION owner=[...] partner=[...] stubVehicleHits=1`. A suite that
passes while a delegated read can be answered from the owner's cache is a test gap around a known
cross-owner defect.

### P16. The packaged README's relative links point outside the tarball

Extracted tarball check: 14 relative links in the packaged `README.md`, 11 missing from the package,
including `docs/tools-reference.md`, `docs/architecture.md`, `docs/getting-started.md`,
`docs/upstream-api.md`, `docs/write-endpoints.md` and `docs/development.md`. `package.json:45-53`
does not include `docs/`, and npm serves this README from the tarball. The extracted-tarball command
and result are in section 5.

## 2. Missing capabilities

Ordered by adoption impact, not by effort.

1. A published package and a registry entry. Today npm returns 404, the official registry search is
   empty, `server.json` fails its declared schema and the current one, and `package.json` lacks the
   `mcpName` the quickstart requires. This blocks every install path, including directory reviews.
2. A demo that exists inside the installed artifact. The repo ships `test/fixtures/dump` and a demo
   script, but the tarball excludes both and the README badge promises an offline demo. A reviewer or
   curious user hits the credential wall first.
3. A release process: tags, GitHub Releases, npm provenance, and a publisher step. GitHub reports no
   releases and no tags; CI only verifies. Without this, every update is manual and unattested.
4. A Claude Desktop `.mcpb` bundle with the three credentials as sensitive `user_config` fields.
   Comparable Polestar servers already ship one; this repo has no bundle manifest and no pack step.
5. Tarball-level release verification in CI. Both smoke modes launch the repo build; `smoke-bin`
   symlinks to `build/server.js` in the checkout. No job proves the packed package installs and
   starts, so missing `files` entries and broken `main`/`bin` paths ship silently.
6. Documentation gates that cover the documents users and reviewers read: README, CONTRIBUTING,
   SECURITY, CHANGELOG and `docs/releases/**`. Today the `links`, `tools` and `envvars` gates skip
   most of them and three of the skips are provable.
7. A single version source and a release gate that compares it across `package.json`, `server.json`,
   the README badge, the changelog and the packed artifact.
8. A coverage and negative-test floor that can fail. The suite is strong (111 tests, 95.54 line) but
   the gate is decorative and five known defects have no failing test (P13 to P15, planner edges,
   unknown arguments).
9. A published container image with build verification, OCI labels and a `.dockerignore`. The
   Dockerfile exists but no CI job builds it and no registry publish path exists. Container runtime
   hardening belongs to platform-analyst; distribution metadata is listed in D-23.
10. Protocol-era capability: the installed SDK negotiates `2025-11-25`, `server/discover` answers
    `-32601`, and the current specification revision is `2026-07-28`. This is a real gap for future
    clients but the council killed it as a build item (R1 C11 and D5); it stays recorded, not planned.

## 3. Candidate table

Effort: S is one or two days, M is about a week, L is more than a week. Risk is about correctness,
privacy or maintenance cost, not schedule. Every falsifiable check is a command, a CI step or an
exact assertion.

| ID | Improvement | Category | Evidence | Impact | Effort | Risk | Falsifiable check | MoSCoW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-01 | Make `npm run demo-dump` use the shipped `test/fixtures/dump` by default (honour `POLESTAR_FIXTURES_DIR`, add a separate flag for the sibling live capture) and point README and getting-started at that path | bug/docs/DX | `scripts/demo-dump.ts:14-19`; `README.md:51-57`; `docs/getting-started.md:140-150`; `npm run demo-dump` exits 1 with `DUMP_FAILED` | The first offline command in the README fails for every new user, and the demo never proves the shipped fixtures work | S | Low | `npm run demo-dump` exits 0 and prints `DUMP_OK` on a clean checkout; CI adds the step | Must: false claim in the published README |
| D-02 | Make the packaged README true: add a `--demo` path plus the fixture dump to the published `files` (or delete the offline-demo badge and the two demo commands from the README) | bug/ecosystem | `package.json:45-53`; `npm pack --dry-run` gives 85 files, no `test/` or `scripts/`; tarball README lines 56 and 222 | Every npm and npx install is told to run commands the tarball does not contain, and directory reviewers have no sample data | M | Low | Extract the tarball, run `node build/server.js --version` and a handshake against the packaged demo directory; assert the tarball contains fixture JSON | Must: false claim shipped to npm |
| D-03 | Replace the `npm install -g polestar-mcp` line in the release note with a path that exists today (repo clone or `npx` from the repo), or publish before claiming it | docs/release | `docs/releases/v0.3.0.md:11,15`; `npm view polestar-mcp version` returns `E404` | The first command in the release note fails, which discredits the rest of the note | S | Low | A docs check asserts no registry install claim unless `npm view polestar-mcp version` resolves, or the note names the repo path | Must: false published claim |
| D-04 | Fix `server.json` to the current registry schema (`identifier` instead of `name`, `$schema` 2025-12-11 URL, one version) and add `mcpName` to `package.json` | release/ecosystem | `server.json:2,9,10-15`; schema URL 404 versus 200; jsonschema `errors: 1`; quickstart requires `mcpName`; registry search count 0 | The server cannot appear in the MCP Registry, so directory aggregators and one-command clients cannot find it | S | Low | jsonschema validation returns 0 errors; `package.json.mcpName` equals `server.json.name`; `mcp-publisher publish` succeeds; registry search returns the server | Must: blocks the only discovery channel |
| D-05 | Add a CI pack-and-install job: `npm pack`, install the tarball into a temp directory, run the bin and a fixture handshake from the installed package | test/release | `.github/workflows/ci.yml:22-24`; `scripts/smoke-bin.ts:19,27-28` | Catches missing `files` entries, broken `main`/`bin`, and packaged-README regressions before a publish instead of after | S | Low | The job fails when `build` is removed from `files` or `bin` points at a missing path | Should: prevents the D-02 class of release defect |
| D-06 | Give coverage a threshold that can fail, exclude test files from the denominator and add per-file floors for the pure modules | test/ops | `package.json:25`; measured 95.54 line, 86.50 branch, 89.94 funcs; `--test-coverage-lines=99` exits 1 | A gate that cannot fail is a comment, not a check; regressions in `history-tools.ts` and `advisor-tools.ts` branch coverage are invisible | S | Low | CI fails when a test is deleted or a pure module drops below its floor | Should: house rule and cheap |
| D-07 | Declare the real minimum Node (20.11 because of `import.meta.dirname`), align `engines`, the README badge, getting-started and the release note, and add a CI matrix at the floor and current LTS | test/docs/ops | `package.json:6-8`; `scripts/capture.ts:20`; `scripts/verify-fixtures.mjs:8`; `scripts/server-for-inspector.ts:4`; Node v20 docs: `import.meta.dirname` added v20.11.0; `README.md:10,227`; `docs/getting-started.md:15`; `.github/workflows/ci.yml:12` | The documented floor cannot run the repo's own verification scripts, and CI never tests either the floor or a second Node line | S | Low | CI matrix runs 20.11, 22 and 24; docs state 20.11; a 20.6 job fails `verify-fixtures` today | Should: a support claim nobody tests is a trap |
| D-08 | Fix `smoke-bin`: end stdin after the handshake request, assert every exit code, fail on the 20 second kill, and stop chmod-ing the build output inside the test | test/bug | `scripts/smoke-bin.ts:28,39-42`; measured `real 0m20.300s` with `BIN_SMOKE_OK` | CI spends 20 seconds per run on a test that can pass while the launch path hangs, and the executable-bit claim is self-fulfilling | S | Low | `npm run smoke-bin` finishes in under 3 seconds; it fails when the server exits nonzero | Should: slow CI and a weak launch gate |
| D-09 | Extend the docs gates to every user-facing document (README, CONTRIBUTING, SECURITY, CHANGELOG, `docs/releases/**`) and add a scanned-file floor for `links`, `tools` and `envvars` like the one hygiene has | test/docs | `docs/check-docs.mjs:25-29,79`; proven: broken links in CONTRIBUTING and the release note still print `DOCS_LINKS_OK`, a deleted README tool row still prints `DOCS_TOOLS_OK` | Three claims in CONTRIBUTING and README cannot fail for the documents users read first | S | Low | A broken link in CONTRIBUTING fails `links`; a missing README tool or env row fails `tools`/`envvars`; fewer than N scanned files fails | Should: the gates are the product's documentation contract |
| D-10 | Harden the envvars gate: full variable names including digits, all `src` readers, both directions, and `.env.example` plus the README table | test/docs | `docs/check-docs.mjs:196-207`; proven: `POLESTAR_TIMEOUT_2_MS` read in `config.ts` passes undocumented; doc-only variable passes; `src/bind.ts` read passes; `POLESTAR_M2M_TOKEN_ENDPOINT` removal reports `POLESTAR_M` | Documented configuration can drift silently, including variables the server reads at startup | S | Low | A variable with a digit in its name fails when undocumented; a doc-only name fails; `.env.example` and README are in scope | Should: same gate, correct scope |
| D-11 | Introduce one version source and a gate that compares `package.json`, both `server.json` fields, the README badge, the newest CHANGELOG heading, the release note and `build/server.js --version` | release/DX | six locations in P8; `docs/development.md:126`; observed `--version` prints `0.3.0` | Version bumps can leave the registry, badge and release notes inconsistent, and the one-bump claim is false | S | Low | A script fails when any of the six sources disagrees; bumping only `package.json` fails CI | Should: release safety for a one-person project |
| D-12 | Add a release workflow: tag-driven GitHub Release, `npm publish --provenance`, `mcp-publisher publish`, and the packed-tarball check from D-05 | release/ops | `.github/workflows/ci.yml:1-38` has no publish or tag job; GitHub releases and tags return `[]`; npm 404 | Updates are manual, unattested and undocumented, and buyers cannot verify provenance | M | Medium: registry is in preview and credentials are owner-held | A tag run produces a GitHub Release, an npm version with a provenance attestation, and a registry entry | Should: the publish program is the point of D-04 |
| D-13 | Add a surface budget test for `tools/list` bytes, distinct output schemas and instructions length | test/DX | measured `tools 23 toolsListBytes 44841`, `tools 26 bytes 50718`, `outputSchemaBytes 26234`, `distinctOutputSchemas 1`, `oneSchemaBytes 1009`; `README.md:19` claims read-only efficiency | The largest per-session cost (about 12.7k tokens with history) has no ceiling, so it can grow silently | S | Low | A test fails when 26-tool `tools/list` exceeds a stated ceiling or when a second output-schema shape appears | Should: makes the cost work falsifiable |
| D-14 | Stop the smoke test enforcing the duplicated envelope: require `content[0].text` and `structuredContent.ok`, not `message === text`, and add an envelope contract test | test/DX | `scripts/smoke.ts:64-67,78`; measured duplicate `true`, text 161 bytes, structured 256 bytes; `analysis/surface/findings.md:155-186` | The test blocks the measured 44 percent payload saving and freezes a schema field the surface lane wants to remove | S | Low | After removing `structuredContent.message`, smoke still passes and a result contract test still validates `ok` and the text | Should: the test is currently an obstacle |
| D-15 | Add a default-surface composition test: build the server with no history store, assert 23 tools, and assert every tool name in every prompt is registered on that surface | test/bug | `test/server-seams.test.ts:255-286`; `src/server.ts:389-403`; measured default `tools 23` | `battery-health-report` tells the model to call two tools absent from a default install, and no test can notice | S | Low | The new test fails on `get_degradation_report` and `get_charging_sessions` today; after the fix it passes | Should: user-visible bad instruction plus a gate |
| D-16 | Add redaction tests across the resource surface: list, read, completions and error text must not contain a full VIN when `POLESTAR_REDACT_VIN=1` | test/security | `test/runtime.test.ts:345-365`; measured 15 of 15 resource URIs and completions with the full VIN; `src/server.ts:283-300,306-317`; lead P0-3 | A masked tool answer and an unmasked resource URI in the same session is a privacy claim that is false | S | Low | The redaction test fails on the current resource surface and passes after the surface lane's fix | Should: coordinate with the security lane; the test is the missing gate |
| D-17 | Add a delegated-cache isolation regression test with two identities on one cache | test/bug | `src/caching-transport.ts:83`; `test/client.test.ts:405-419`; R2 V3 measured `stubVehicleHits=1` | A cross-owner read can be served from cache while the suite stays green | S | Low | Two-identity stub asserts two requests and two distinct cache entries; fails today | Should: gates lead P0-1 |
| D-18 | Fix and gate the changelog: remove the logging-notifications claim, replace the G2 to G7 names with the real CI step list, correct the all-26 smoke claim, and fail a release when `Unreleased` is non-empty at a tag | docs/release | `CHANGELOG.md:6-68,90,138,139`; `grep sendLoggingMessage src/` empty; `npm run smoke` prints 24 callable and never calls `plan_cheapest_charge`; G names only in CHANGELOG | Published release notes claim verification and a feature the code does not have | S | Low | A changelog check fails at tag time with an `Unreleased` section; each corrected sentence matches a CI step or command | Should: the changelog ships in the tarball |
| D-19 | Make the shipped help text honest and complete: add the five missing variables to `.env.example` or drop the "Every variable is listed there" sentence, and test both | docs/bug | `src/server.ts:508-513`; `.env.example:1-43`; `README.md:178`; five variables missing in P10 | Installed operators are told a false completeness claim and cannot find five variables in the template | S | Low | A test parses the config registry and asserts every variable appears in `.env.example`; fails today | Should: shipped output, cheap fix |
| D-20 | Extend `check-tool-refs` to user docs and give it a positive control | test/docs | `scripts/check-tool-refs.mjs:97-100`; proven: docs addition passes, `src` addition fails; no control | A doc can tell an operator to call a tool that does not exist and CI stays green | S | Low | An unregistered tool name in `docs/tools-reference.md` fails; the control string proves the regex fires | Could: docs-only exposure, but cheap |
| D-21 | Fix packaged README links: either include `docs/` in `files` or convert the documentation table to absolute repository URLs | packaging/docs | 11 of 14 relative README links missing from the tarball; `package.json:45-53` | The npm package page links to documentation that is not in the package | S | Low | Extracted tarball link check exits 0; or all README links are absolute https URLs | Could: GitHub still has the docs |
| D-22 | Harden CI: `permissions: contents: read`, `timeout-minutes`, a concurrency group, SHA-pinned actions and an actionlint step | ops | `.github/workflows/ci.yml:1-38` has none of these | A compromised or updated action runs with default token scope and no job deadline | S | Low | actionlint passes; workflow contains the four settings; a job exceeding its timeout is killed | Could: best practice, no current failure |
| D-23 | Finish container distribution: `.dockerignore`, OCI source/version/license labels, a digest-pinned base image and a CI `docker build` job (image publish optional) | ops/release | `Dockerfile:1-17`; no `.dockerignore`; `grep` for docker in ci returns nothing; docker is not installed on this machine so the build is unverified | The container channel cannot be trusted or discovered, and the build may break unnoticed | M | Medium: alpine and TypeScript 7 native binaries unverified; coordinate platform-analyst | CI builds the image and runs `docker run ... --version`; labels present; `.dockerignore` excludes node_modules and build | Could: secondary channel, but the file advertises a channel that does not exist |
| D-24 | Package build hygiene: clean `build/` before compile, decide between shipping `.d.ts`/source maps (536K build, 180K maps, 120K declarations) and exposing `types`/`exports`, and ignore `*.tgz` | packaging | `tsconfig.json:12-14`; `du -sh build` 536K; `package.json` has no `types` or `exports`; `.gitignore` has no `*.tgz` | Stale or orphaned build files can be packed, and the tarball carries 300K of files nothing consumes | S | Low | A deleted source module leaves no orphan in `build/` or the tarball; tarball unpacked size is under a stated ceiling | Could: bloat, not a correctness risk |
| D-25 | Add negative self-tests for the gate scripts (`verify-fixtures`, `check-tool-refs`, `check-docs` scope floors) and a small mutation pilot for `format.ts`, `planner.ts`, `charge-model.ts` and `caching-transport.ts` | test | `scripts/verify-fixtures.mjs:1-24` is never imported or invoked by a test; gate scripts rely on internal controls; 111 tests run in about 0.4s | A gate that silently stops looking passes CI, and the pure modules that carry the arithmetic have no mutation signal | M | Medium: mutation runs add CI time and can be noisy | Each gate test runs the script on a broken temp tree and expects exit 1; a mutation run reports a score baseline and fails under a threshold | Could: targeted negative tests first; see D-28 |
| D-26 | Sweep command and checklist drift: development.md command table versus `package.json` scripts, the smoke-bin "same surface" overclaim, the release note's CI list missing smoke-bin, and the budget default cell `no` | docs | `docs/development.md:59-73`; `package.json:13-33`; `docs/development.md:67`; `docs/releases/v0.3.0.md:69-72`; `docs/getting-started.md:95` | Contributors read a stale command map and reviewers read a stale CI list | S | Low | A generated command table equals `package.json.scripts`; a doc check asserts smoke-bin performs zero tool calls or the sentence is corrected | Could: accuracy polish |
| D-27 | Add negative tests for the known planner and clock defects (stop hour above 23, cross-night contiguity, out-of-window prices, nested `updatedAtTimestamp` preference) | test | `test/planner.test.ts:107-151` covers only 23 to 06; R2 V7, V8, V21 | Known wrong answers stay unfalsifiable, so a fix cannot be reviewed by its failing test | S | Low | New tests fail on the current code and pass after the intelligence lane's fixes | Could: coordinate with the intelligence lane |
| D-28 | Full-tree mutation testing gate with Stryker on every push | test | no mutation tooling in `package.json`; 27 test files; all-files line coverage 95.54 | Marginal value over the targeted negative tests in D-06, D-25 and D-27, at a large run-time and threshold-maintenance cost | L | Medium: noisy survivors and slow CI | A pilot score exists and beats the targeted-test baseline before adoption | Won't: run the pilot in D-25 first, then decide |

## 4. Rejected ideas

- **Full mutation score as a release gate now (maps to D-28).** No mutation tooling exists, and the
  known test gaps are specific (P13 to P15 plus R2 V7, V8, V21). A targeted negative test is cheaper
  and more diagnostic than a survivable-mutant threshold. Revisit after D-25 has a baseline.
- **MCP protocol era migration (2026-07-28) as a candidate.** Verified not implemented: initialize
  asking for `2026-07-28` negotiated `2025-11-25`, `server/discover` returned `{"code":-32601}`, and
  the current spec page states the current version is 2026-07-28 with per-request `_meta` and
  `server/discover`. R1 killed C11 and D5 because the installed SDK pins `LATEST_PROTOCOL_VERSION =
  "2025-11-25"` and no client-compatibility probe exists in the tree. Recorded as capability 10, not
  planned this round.
- **Publishing a public hosted or remote connector.** R1 and R3 killed D10: a public listener that
  holds location and spends a per-vehicle, per-scope allowance is a different product with a
  different trust and compliance story. The loopback-first posture in README.md:175 is the product.
- **Reserving the npm name with a placeholder package.** A placeholder publish is a real public
  artifact and cannot be unpublished cleanly; publish the real 0.3.x release after P4 and D-02.
- **Shipping the owner's real captured dump as the demo.** It holds a real VIN and position history;
  the synthetic 68K dump already exists and is gated by `verify-fixtures`.
- **Rewriting the gate scripts as TypeScript modules or importing them in tests.** They are `.mjs`
  with top-level side effects; child-process tests on a temp tree are simpler and test the real CLI.
  D-25 covers the value without a rewrite.
- **A static documentation site or generated API docs from TypeScript types.** The four gates plus
  D-09 and D-10 cover the drift that matters; a generator adds a build dependency and a second source
  of truth for prose that is deliberately hand-written.
- **Golden or snapshot tests of humanized output.** They would freeze wording that E-runtime and
  surface findings want to change, and the current targeted assertions already catch value errors.
- **Windows and macOS CI matrix for developer scripts.** No Windows contributor or issue is in
  evidence, the npm test glob and fixed HTTP smoke port are POSIX assumptions, and the published
  server is Node-only. Document POSIX for development and revisit with a real report.
- **Codecov or a coverage badge service.** It adds an external dependency and a token to a project
  whose selling point is that it talks only to Polestar and npm; local thresholds in D-06 are enough.
- **MCP Server Cards, Skills over MCP, or an MCP Apps chart now.** R1 and R3 killed D8 and deferred
  the extensions; none has a client-compatibility probe in this repository.

## 5. Commands run

All commands ran in `/Users/nicolaskheirallah/Documents/GitHub/polestar-mcp` unless a `/tmp` copy is
named. Fixture mode only; no live credential was read or written; no tracked file was modified.

Baseline and current gates:

```text
$ npm test
# tests 111
# pass 111
# fail 0

$ npm run typecheck
[exit 0, no output]

$ npm run build
[exit 0]
$ stat -f 'server_mode=%Lp' build/server.js
server_mode=755
$ node build/server.js --version
0.3.0

$ npm run smoke
registry: 26 tools, 24 callable with no args
SMOKE_OK

$ npm run smoke-http
HTTP_SMOKE_OK

$ npm run verify-fixtures
FIXTURES_OK

$ npm run check-secrets
SECRETS_CLEAN

$ npm run check-tool-refs
TOOL_REFS_OK 26 registered names, 27 instruction-surface files scanned, 0 undefined names referenced

$ node docs/check-docs.mjs tools
DOCS_TOOLS_OK tools=26 domains=15
$ node docs/check-docs.mjs envvars
DOCS_ENVVARS_OK
$ node docs/check-docs.mjs links
DOCS_LINKS_OK
$ node docs/check-docs.mjs hygiene
HYGIENE_NO_EM_DASH / HYGIENE_BUZZWORDS_CLEAN / HYGIENE_NO_BANNERS / HYGIENE_NO_DASH_CONNECTORS / HYGIENE_CLEAN
```

The failing clean-checkout and timing checks:

```text
$ npm run demo-dump
DUMP_FAILED: expected captured dump at /Users/nicolaskheirallah/Documents/GitHub (dataportal/vehicles.json not found)
demo_exit=1

$ time npm run smoke-bin
BIN_SMOKE_OK --version, --help and the MCP handshake all work launched through the bin symlink
real 0m20.300s
bin_exit=0
```

Coverage and its missing threshold:

```text
$ npm run coverage
all files | 95.54 | 86.50 | 89.94
src/server.ts | 69.44 | 53.57 | 32.43
src/history-tools.ts | 76.05 | 79.17 | 77.78
src/advisor-tools.ts | 93.38 | 33.33 | 100.00

$ node --import tsx --test --experimental-test-coverage --test-coverage-lines=99 --test-reporter=spec "test/"*.test.ts
Error: 95.54% line coverage does not meet threshold of 99%.
[exit 1]
```

Packaging and distribution:

```text
$ npm pack --dry-run --json
files: 85
unpackedSize 436330
filename polestar-mcp-0.3.0.tgz
[no entry under test/ or scripts/]

$ npm pack; tar -xzf polestar-mcp-0.3.0.tgz -C /tmp/polestar-pack
$ ls /tmp/polestar-pack/package
CHANGELOG.md CONTRIBUTING.md LICENSE README.md SECURITY.md build package.json
$ ls /tmp/polestar-pack/package/scripts
ls: /tmp/polestar-pack/package/scripts: No such file or directory
$ grep -n demo-dump /tmp/polestar-pack/package/README.md
56:npm run demo-dump                       # runs the whole server in fixture mode, prints DUMP_OK
222:npm run demo-dump      # stdio end-to-end against the real captured dump

$ cd /tmp/polestar-pack/package && node -e "check each relative README link"
relative links 14 missing in tarball 11

$ npm view polestar-mcp version
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/polestar-mcp - Not found
```

Protocol and metadata probes (real stdio server, fixture mode, measured in memory):

```text
negotiated 2025-11-25            (initialize asked 2026-07-28)
instructions_chars 882
tools 23 toolsListBytes 44841
distinctOutputSchemas 1 oneSchemaBytes 1009
server/discover {"code":-32601,"message":"Method not found"}
unknown-arg isError undefined textHasCharge true        (tools/call get_battery with {vinn:"NOTAVIN"})
unknown-tool {"code":-32602,"message":"Tool no_such_tool not found"}
duplicateMessage true textBytes 161 structuredBytes 256

tools 26 bytes 50718
outputSchemaBytes 26234 inputSchemaBytes 14599 descriptionBytes 5692
historyTools get_history,get_degradation_report,get_charging_sessions

toolTextHasFullVin false; vinField YSM...001
resourceUrisWithFullVin 15 of 15
completion {"values":["YSMTEST22PL000001"],"total":1,"hasMore":false}
readUriHasFullVin true
```

External checks (network; external pages treated as data):

```text
$ npm view polestar-mcp version
E404

$ curl -s -o /dev/null -w '%{http_code}' https://static.modelcontextprotocol.io/schemas/2025-12-01/server.schema.json
404
$ curl -s -o /dev/null -w '%{http_code}' https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
200
[2026-01-01, 2026-06-01, 2026-07-28, 2026-10-01 and 2026-11-01 schema URLs all returned 404]

$ python3 jsonschema validation of server.json against the 2025-12-11 schema
errors: 1
 - packages/0 : 'identifier' is a required property

$ curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=polestar'
{"servers":[],"metadata":{"count":0}}

$ curl -s https://api.github.com/repos/NicolasKheirallah/polestar-mcp/releases   -> []
$ curl -s https://api.github.com/repos/NicolasKheirallah/polestar-mcp/tags       -> []
[repo: stars 2, created 2026-09-19, default branch master]

$ web_fetch https://modelcontextprotocol.io/specification/versioning
current protocol version is 2026-07-28; negotiation via per-request _meta; server/discover is a mandatory RPC
$ web_fetch https://modelcontextprotocol.io/registry/quickstart
"For npm packages, this requires adding an mcpName property to package.json"
"The name property in server.json must match the mcpName property in package.json"
$ web_fetch https://nodejs.org/docs/latest-v20.x/api/esm.html#importmetadirname
import.meta.dirname: Added in v20.11.0
```

Documentation-gate falsification on the throwaway copy (`/tmp/eco-copy` from `git archive HEAD`,
node_modules symlinked, all edits reverted with `git checkout`):

```text
$ node docs/check-docs.mjs links      # after broken links in CONTRIBUTING.md and docs/releases/v0.3.0.md
DOCS_LINKS_OK

$ node docs/check-docs.mjs tools      # after deleting the get_pre_cleaning row from README.md
DOCS_TOOLS_OK tools=26 domains=15
$ node docs/check-docs.mjs envvars    # after deleting POLESTAR_HISTORY_SAMPLE_SECONDS from README.md
DOCS_ENVVARS_OK

$ node docs/check-docs.mjs envvars    # after adding a doc-only variable and process.env.POLESTAR_UNREAD_UNLISTED in src/bind.ts
DOCS_ENVVARS_OK
$ node docs/check-docs.mjs envvars    # after renaming every POLESTAR_HISTORY_DIR in getting-started.md
ENVVARS_CHECK_FAILED: not documented: POLESTAR_HISTORY_DIR
[exit 1, proves the detector works when the name is a plain uppercase token]

$ node docs/check-docs.mjs envvars    # after adding process.env.POLESTAR_TIMEOUT_2_MS to src/config.ts
DOCS_ENVVARS_OK
$ node docs/check-docs.mjs envvars    # after removing POLESTAR_M2M_TOKEN_ENDPOINT from getting-started.md
ENVVARS_CHECK_FAILED: not documented: POLESTAR_M
[exit 1, wrong name because the regex stops at the digit]

$ node scripts/check-tool-refs.mjs    # after adding get_tyre_pressure to docs/tools-reference.md
TOOL_REFS_OK 26 registered names, 27 instruction-surface files scanned, 0 undefined names referenced
$ node scripts/check-tool-refs.mjs    # after adding get_tyre_pressure to src/bind.ts
TOOL_REFS_FAILED
  "get_tyre_pressure" referenced at src/bind.ts:42 is not registered
```

### Could not verify

- The Docker build and the alpine/musl behaviour of TypeScript 7 native binaries: `docker` is not
  installed on this machine. D-23 keeps that check unproven.
- `mcp-publisher` behaviour on a corrected `server.json`: the file was validated against the published
  JSON Schema and the quickstart requirements, but the publisher was not run because it needs a
  GitHub-authenticated owner step.
- Whether npm would accept the name `polestar-mcp`: the 404 proves unpublished, not reserved.
- Runtime behaviour on Node 20.6 through 20.10: the floor claim was checked against Node's v20
  documentation for `import.meta.dirname`, not by executing that LTS line.
- How npmjs.com renders relative README links: only the tarball contents were checked, which is
  enough to prove the linked files are not in the package.
- Live Polestar API behaviour, pricing, and write endpoints: no live credential was used, so the
  external state claims in D-ecosystem that need the authenticated portal remain unverified here.
