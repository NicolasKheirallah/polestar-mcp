# Lane A: offline gates and packaged artifact

Verification of the documented contributor path, the packed npm artifact, and the CI,
release and container configuration at commit `098b8c3` on `master`.

## Test environment

| Fact | Value |
| --- | --- |
| Host | macOS 27.0.1, arm64 |
| Host Node and npm | v22.23.2 and 10.9.8 (`/Users/nicolaskheirallah/.local/bin/node`) |
| Other installed runtimes | v22.23.4 under nvm only |
| Docker | not installed (`docker: NOT INSTALLED`) |
| Clean copy | `/tmp/ops-gates-A/repo`, HEAD `098b8c3`, branch `master`, 123 tracked files |
| Live API | not called; every run was fixture mode |
| Shared checkout | not modified; only the untracked report you are reading was added |

## Method

- The repository was copied with `rsync` to `/tmp/ops-gates-A/repo`, excluding
  `node_modules`, `build`, `analysis` and `.agents`, and including `.git` so the docs gates
  enumerate files through `git ls-files` exactly as CI does.
- `npm ci` ran once in that copy. No build or install ran in the shared checkout.
- Every check below was run as its own command with output captured to
  `/tmp/ops-gates-A/logs/`, and exit codes were recorded from the shell.
- The packaged artifact was installed into `/tmp/ops-gates-A/prefix`, a prefix with no
  relationship to the repository tree. A standalone client
  (`/tmp/ops-gates-A/handshake.mjs`, not in the repo) performed the MCP handshake.
- Git usage was read-only: `git rev-parse`, `git status`, `git ls-files`.

## 1. Dependency install and documented offline gates

Run from the clean copy. All commands exit 0.

| ID | Check | Command | Result |
| --- | --- | --- | --- |
| A1 | Clean install | `npm ci` | PASS, exit 0, `added 14 packages`, 2s |
| A2 | Typecheck | `npm run typecheck` | PASS, exit 0 |
| A3 | Build | `npm run build` | PASS, exit 0, `build/server.js` mode `-rwxr-xr-x` |
| A4 | Unit tests | `npm test` | PASS, exit 0, `# pass 301`, `# fail 0`, 5733ms |
| A5 | Coverage floors | `npm run coverage` | PASS, exit 0, lines 97.43, branches 85.75, functions 92.91 (floors 90, 80, 85) |
| A6 | stdio smoke | `npm run smoke` | PASS, exit 0, `SMOKE_OK`, registry 36 tools |
| A7 | HTTP smoke | `npm run smoke-http` | PASS, exit 0, `HTTP_SMOKE_OK` |
| A8 | Published bin smoke | `npm run smoke-bin` | PASS, exit 0, `BIN_SMOKE_OK version 0.3.0` |
| A9 | Offline demo | `npm run demo` | PASS, exit 0, `DUMP_OK` |
| A10 | Contributor demo | `npm run demo-dump` | PASS, exit 0, `DUMP_OK` |
| A11 | Fixture envelopes | `npm run verify-fixtures` | PASS, exit 0, `FIXTURES_OK` |
| A12 | Secret hygiene | `npm run check-secrets` | PASS, exit 0, `SECRETS_CLEAN` |
| A13 | Tool references | `npm run check-tool-refs` | PASS, exit 0, `TOOL_REFS_OK` 36 names, 33 files, 0 undefined |
| A14 | Version agreement | `npm run check-version` | PASS, exit 0, `VERSION_OK 0.3.0` |
| A15 | Registry metadata | `npm run check-server-json` | PASS, exit 0, `SERVER_JSON_OK packages=1` |
| A16 | Docs tool counts | `node docs/check-docs.mjs tools` | PASS, exit 0, `DOCS_TOOLS_OK tools=36 domains=15` |
| A17 | Docs env vars | `node docs/check-docs.mjs envvars` | PASS, exit 0, `DOCS_ENVVARS_OK variables=29 docs=3` |
| A18 | Docs links | `node docs/check-docs.mjs links` | PASS, exit 0, `DOCS_LINKS_OK` |
| A19 | Writing hygiene | `node docs/check-docs.mjs hygiene` | PASS, exit 0, `HYGIENE_CLEAN` (four detector markers) |

The gate suite matches the table in
[CONTRIBUTING.md](../../CONTRIBUTING.md) and the verification section of
[docs/development.md](../../docs/development.md). No gate was skipped and no failure was
observed.

## 2. Packaged artifact

| ID | Check | Command | Result |
| --- | --- | --- | --- |
| B1 | Pack manifest | `npm pack --dry-run` | PASS, exit 0, 136 files, package size 274.9 kB, unpacked 1.0 MB |
| B2 | Real tarball | `npm pack --pack-destination /tmp/ops-gates-A/pack` | PASS, exit 0, `polestar-mcp-0.3.0.tgz`, 274,878 bytes |
| B3 | Clean-prefix install | `npm install --no-audit --no-fund <tarball>` in `/tmp/ops-gates-A/prefix` | PASS, exit 0, `added 7 packages` |
| B4 | Installed version | `<prefix>/node_modules/.bin/polestar-mcp --version` | PASS, exit 0, prints `0.3.0` |
| B5 | Installed help | `<prefix>/node_modules/.bin/polestar-mcp --help` | PASS, exit 0, usage text lists the 29 variables |
| B6 | Installed offline demo | `npm run demo` inside `node_modules/polestar-mcp` | PASS, exit 0, `DUMP_OK` |
| B7 | MCP handshake via installed bin | `node /tmp/ops-gates-A/handshake.mjs <bin> <fixtures>` | PASS, exit 0, `HANDSHAKE_OK name=polestar-mcp version=0.3.0 tools=26 all_readOnly=true` |
| B8 | Works without the repo tree | moved `/tmp/ops-gates-A/repo` aside, reran B4, B5, B6, B7, restored | PASS, all exit 0, `DUMP_OK` and `HANDSHAKE_OK` with the tree absent |

Tarball identity: sha256 `5cb8f8d39e07effe695b9e28167ff896eff9432013403f978ad4fe72c9e01543`.
The installed bin is a symlink to `../polestar-mcp/build/server.js`; both the tarball entry
and the installed file carry mode `-rwxr-xr-x`, so the executable bit survives packing.
`build/server.js` begins `#!/usr/bin/env node`. Running the bin from `/` with the repository
copy renamed demonstrates the package does not read the checkout.

## 3. Package contents

| ID | Required content | Evidence | Result |
| --- | --- | --- | --- |
| C1 | `build/` | 96 entries, including `build/server.js` (37,485 bytes) | PASS |
| C2 | `scripts/demo.mjs` | present, the only `scripts/` entry in the tarball | PASS |
| C3 | `test/fixtures/dump` | 17 entries including `dataportal/vehicles.json` | PASS |
| C4 | `docs` | 14 entries including `docs/check-docs.mjs` and `docs/releases/v0.3.0.md` | PASS |
| C5 | `mcpb` | `mcpb/manifest.json` | PASS |
| C6 | No source or workspace leakage | 0 matches for `src/`, `*.test.ts`, `node_modules/`, `analysis/`, `.git/` | PASS |

Root files in the tarball: `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `.env.example`. The `files` list in
[package.json](../../package.json) and the actual archive agree.

## 4. CI, release and container configuration (static review)

Docker is not installed, so the image build and the container runtime assertions are
recorded as not run. Everything else below was read from the files and cross-checked
against [package.json](../../package.json).

| ID | Check | Evidence | Result |
| --- | --- | --- | --- |
| D1 | `ci.yml` script references exist | 13 distinct `npm run` names, all present in `scripts` | PASS |
| D2 | `release.yml` script references exist | 11 distinct `npm run` names, all present in `scripts` | PASS |
| D3 | `node` paths referenced exist | `docs/check-docs.mjs` resolves | PASS |
| D4 | Docs subcommands valid | uses `tools`, `envvars`, `links`, `hygiene`, all supported | PASS |
| D5 | Node matrix matches the floor | matrix `[20.11, 22, 24]`, `engines.node` is `>=20.11.0` | PASS |
| D6 | Action pins resolve | `actions/checkout@v7` and `actions/setup-node@v7` tags return HTTP 200 from the GitHub API | PASS |
| D7 | Container is non-root | [Dockerfile](../../Dockerfile) has `USER node` | PASS, static |
| D8 | Container has a healthcheck | `HEALTHCHECK ... CMD ["node", "build/server.js", "--version"]` | PASS, static |
| D9 | Container base meets the floor | `node:22-alpine` both stages, 22 is above 20.11 | PASS, static |
| D10 | `.dockerignore` is coherent | excludes `.git`, `.agents`, `.github`, `node_modules`, `build`, `coverage`, `test`, `analysis`, `docs`, `*.tgz`, `*.log`, `.tsbuildinfo`, and the `.env` family with `!.env.example` restored; excludes nothing the Dockerfile copies (`package.json`, `package-lock.json`, `tsconfig.json`, `src`) | PASS, static |
| D11 | Image builds | `docker build` | NOT RUN, Docker absent |
| D12 | Container runs non-root with a healthcheck | `docker run` uid check and `docker inspect` Healthcheck | NOT RUN, Docker absent |

Notes on the configuration itself:

- The `verify` job runs `npm ci` plus all 18 checks in section 1, in the documented order.
- The `node-floor` job runs a support subset (typecheck, build, verify-fixtures, test, smoke,
  smoke-bin, check-version, check-server-json and three docs gates) on 20.11, 22 and 24.
- The `pack-install` job installs the real tarball into `/tmp/polestar-install` and runs
  `npm run demo`, `--version` and `--help`. The demo itself performs an MCP handshake, so the
  packaged launcher is exercised end to end.
- The `docker` job asserts `--version` exits 0, that the process uid is not 0, and that a
  Healthcheck test is present.
- [release.yml](../../.github/workflows/release.yml) repeats the verification suite, adds a
  tag-equals-version step (`v$(package.json version)` against the ref name), publishes with
  provenance gated on the npm token, publishes registry metadata with GitHub OIDC, and
  creates the GitHub release. A token-less run reports the skip instead of publishing.
- `.github/workflows/` contains exactly the two workflows reviewed.

## 5. Node floor

No 20.x runtime was installed on the host. To avoid reporting the floor as unverified, the
official Node v20.11.1 darwin-arm64 archive was downloaded to `/tmp` and used explicitly.

| ID | Check | Command | Result |
| --- | --- | --- | --- |
| E1 | Documented floor subset on Node 20.11.1 | `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `npm run smoke`, `npm run smoke-bin`, `npm run verify-fixtures` with the 20.11.1 bin first on PATH | PASS, all exit 0, 301 tests pass, 0 fail, `SMOKE_OK`, `BIN_SMOKE_OK`, `FIXTURES_OK` |
| E2 | Packaged artifact on the floor runtime | handshake client with Node 20.11.1 against the installed bin | PASS, exit 0, `HANDSHAKE_OK name=polestar-mcp version=0.3.0 tools=26 all_readOnly=true` |

Node 24 was not exercised locally. The floor claim (`>=20.11.0`) and the 20.11 matrix entry
are supported by E1 and E2 on exactly 20.11.1.

## Failures and incidents

No gate, packaging step or installed-package check failed. Two environmental events are
recorded for completeness:

1. The host volume filled while the first independence pass (B8) ran. The affected run
   reported an empty version capture and `indep-demo EXIT=228`, and restoring the moved
   directory failed with the exact stderr:

   ```
   mv: rename /tmp/ops-gates-A/repo.hidden to /tmp/ops-gates-A/repo: No space left on device
   ```

   The copy was restored after the volume recovered to roughly 8 GiB free, and the whole
   independence pass was rerun from scratch with all four checks exiting 0. This was host
   disk pressure, not a repository defect, and no tracked file was involved.
2. `npm ci` prints `2 moderate severity vulnerabilities`. This is not part of any gate; see
   observation 1.

## Observations, not defects

1. `npm audit` reports 2 moderate advisories: `@hono/node-server` and `hono`, for a
   `serveStatic` path-decode bypass. The path is `@modelcontextprotocol/node@2.1.2` then
   `@hono/node-server@1.19.17` and `hono@4.13.8`. This server does not serve static files
   and does not register `serveStatic`, so exposure appears low. No repository gate covers
   dependency audit. Severity: informational.
2. [release.yml](../../.github/workflows/release.yml) omits `smoke-http` and `demo-dump`,
   which the `verify` job runs. The release still runs `smoke` and the full check set that
   matters for publishing. Severity: informational.
3. The installed bin registers 26 tools by default. The docs gate expects 36 with history
   enabled and 26 on every start, because the 10 history tools require
   `POLESTAR_HISTORY_DIR`. This is documented behaviour, not a count mismatch.
4. Actions are pinned by major tag (`@v7`), not by commit SHA. Standard for these actions,
   but not immutable. Severity: informational.

## Defects

None found in the Lane A scope. High: 0, Medium: 0, Low: 0.

## Verdict

PASS for Lane A. 45 checks passed, 0 failed, 2 not run because Docker is absent.

The documented contributor path is reproducible from a clean copy: `npm ci`, typecheck,
build, 301 tests, coverage above every floor, both smokes, both demos, the bin smoke, fixture
verification, secret, tool-reference, version and registry checks, and the four docs gates
all pass. The packed tarball contains the build, demo script, fixtures, docs and mcpb
manifest, excludes source and workspace files, installs into an unrelated prefix, and serves
`--version`, `--help`, the offline demo and a real MCP handshake with the repository tree
moved away. The same packaged artifact passes on Node 20.11.1, the declared floor. CI and
release reference only scripts that exist, the Node matrix matches `engines.node`, and the
Dockerfile is non-root with a healthcheck on a base image above the floor. The image build
and the container uid and healthcheck assertions remain unverified locally.

## Limitations

- Docker is not installed, so D11 and D12 rely on static review only; CI covers the runtime
  assertions.
- The floor was exercised on 20.11.1 and 22.23.2. Node 24, also in the CI matrix, was not
  run locally.
- Action tag existence and `npm audit` data were fetched over the network on 2026-11-09;
  they describe the registry state at that time.
- All temporary evidence lives under `/tmp/ops-gates-A` and is disposable. The shared
  checkout has no tracked modifications.
