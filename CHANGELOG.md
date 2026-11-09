# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow SemVer.

## Unreleased

### Added

- The handbook's live probe findings, consumer API design note, and write endpoint
  safety design as markdown docs: `docs/live-contract-findings.md`,
  `docs/consumer-adapter-note.md`, `docs/write-endpoints.md`.
- `test/posture.test.ts`, which holds the two rules this server is defined by: that
  `POLESTAR_ENABLE_WRITES` still registers nothing, and that the consumer app API the
  captured dump proves works stays a design note. Both carry positive controls.
- `UNKNOWN_DOMAIN`, a minted code for a Domain named to `get_history` that the registry
  does not have. `list_domains` is named in its hint, as for every minted code.

- An offline demo that works from a checkout and from the packed package:
  `npm run demo` (plain Node, no tsx, spawning `build/server.js` against the shipped
  synthetic dump) and `npm run demo-dump` (the contributor variant, which now defaults to
  `test/fixtures/dump` instead of the parent directory). The published `files` list now
  carries the demo script and the synthetic dump, so the packaged README command is real.
- A tag-driven release workflow with `npm publish --provenance` and an MCP Registry publish
  step, plus `mcpName` in `package.json` and `server.json` in the current 2025-12-11
  registry shape. Publishing is prepared but blocked on owner npm credentials and on npm
  name availability; the workflow reports the skipped publish instead of failing the tag.
- `scripts/check-version.mjs` and `scripts/validate-server-json.mjs`, wired into CI and
  covered by `test/docs-gates.test.ts`.
- CI jobs for a Node floor matrix at 20.11, 22 and 24, a pack-and-install smoke of the real
  tarball, and a Docker build that checks the image runs as a non-root user with a
  healthcheck. The `Dockerfile` gained `USER node`, a `HEALTHCHECK`, OCI labels and a
  `.dockerignore`.
- Coverage floors in `npm run coverage`: lines 90, branches 80, functions 85.

### Changed

- Which vehicle a call is about, and how its domains are read, now come from one module
  (`src/vehicle-read.ts`). Every tool that takes a `vin` asks the client which vehicle to read
  when the credential sees several, instead of answering `AMBIGUOUS_VIN` the way the
  aggregates, the advisor and the history tools used to.
- `delegated_account_id` is accepted by every tool that reads a car, not by the fifteen
  domain tools alone, where the SDK dropped the argument rather than refusing it.
- A `polestar://` resource read is now the same read as the `get_*` tool for that domain, so
  it carries the data age, the owner label and the VIN redaction rule it lacked, and a
  domain the car does not report reads the same through both surfaces.

- The Node floor is now `>=20.11.0` because `scripts/capture.ts`,
  `scripts/verify-fixtures.mjs` and `scripts/server-for-inspector.ts` use
  `import.meta.dirname`; the README badge, getting started, development notes and the
  v0.3.0 release note now match.
- `docs/check-docs.mjs` links gate scans CONTRIBUTING, SECURITY, CHANGELOG,
  `docs/releases/**` and README instead of only `docs/*.md`; the envvars gate reads every
  `src` file with a digit-safe name pattern and checks README as well as getting started.
- `SECURITY.md` states which surfaces `POLESTAR_REDACT_VIN` masks and names the three
  exceptions: the resource URI identity, `raw: true`, and on-disk history paths.

- **Breaking for clients that read `structuredContent.message`:** a successful result sends
  its rendered text once in `content`, plus structured data in `structuredContent.data` where
  a tool populates one. `structuredContent.message` is emitted only for failures, where it
  differs from the text. Clients should read the content text or the structured data.
  `list_vehicles` returns `{count, vehicles}` and the stdio smoke asserts the count matches.
- Tool arguments are validated strictly: an unknown argument is now refused by name instead
  of being dropped, so a misspelled `vin` no longer reads the default car in silence.
- The 15 domain tool descriptions are short routing text again; `list_domains` remains the
  endpoint and OAuth scope map. `docs/tools-reference.md` says so instead of claiming every
  description embeds the route.
- History answers state their clock and their span: `get_history` dates a line by the value
  clock when recorded and shows a paging marker, the degradation report requires at least
  5 samples over at least 7 days before calling the result an estimate, and charging sessions
  label the with-gaps interval a span rather than a duration.

### Fixed

- `resources/subscribe` was accepted over stateless HTTP and could never be delivered: the
  surface that would poll is closed as its response ends, so its first tick a minute later
  fired into a closed transport. HTTP mode now advertises `subscribe: false` and does not
  register the two handlers. The smoke run asserts the refusal, and the stdio run now
  subscribes and unsubscribes for real.
- `polestar_status` reported `Cache: off (fixture mode serves local files)` from a branch that
  could not be reached: the engine always had a cache, so the test for `undefined` never
  succeeded, and the sentence was wrong anyway (fixture mode with history on caches). The
  cache now says whether it is on, and the arithmetic in that line, the budget line and the
  token clock are asserted rather than only the tool's name.
- `get_history` answered "No history records matched." for a Domain the registry does not
  have, because it re-spelled the Domain route with its own regex instead of asking the
  registry. It is now an `UNKNOWN_DOMAIN` error, distinct from a car that reported nothing.
- Two clocks bypassed the injected one: the token expiry in `polestar_status` and the three
  look-back windows in the history tools read `Date.now()` directly, so no test could place
  them. Both read `ToolDeps.nowMs` now.
- HTTP mode appended a subscription poller per request to a module-level list that only
  `SIGTERM` could drain. An MCP surface now owns the pollers it starts and stops them when it
  closes, which is what the response teardown already did for the transport.
- A stopped subscription poller left its targets in the map, so a restarted poller for the
  same URI was treated as still subscribed.

- The README, getting started, development notes and release note no longer promise an
  npm install or an offline demo that fails on a clean checkout. The release note uses the
  repository build path until the package is published.
- The 0.3.0 changelog no longer claims a logging notification the code never sends,
  undefined G2 to G7 gate names, or that the smoke run exercises all 26 tools.

### Verification

- Twelve claims that had nothing that could fail now do. Each new check was confirmed by
  breaking the protection it describes and watching it fail, one at a time.
- The fixtures containment refusal is kept and now testable: `isInside` is exported and
  asserted directly, with an honest note that no route reaches it today, because every path
  segment is a literal or a registry name.

### Removed

- `polestar-mcp-handbook.pdf`. Its other chapters already exist as the markdown
  docs set (getting started, tool reference, architecture, upstream API,
  development), which the CI gates keep in sync with the code; the PDF was a
  rendered snapshot of those plus the three new files.

## 0.3.0

Surface and reliability work against the Polestar Data Portal M2M API, verified with live
authenticated calls.

### Added

- `get_car_status`, `is_car_secure`, `get_needs_attention`, `get_charging_estimate`,
  `plan_cheapest_charge`, `list_domains`, `polestar_status`: aggregate and decision tools
  that replace sequences of individual domain reads.
- Opt-in local history store (`POLESTAR_HISTORY_DIR`) with `get_history`,
  `get_charging_sessions` and `get_degradation_report`, plus an opt-in background sampler
  (`POLESTAR_SAMPLE`) that never runs unless asked and stands down at 80 % of the daily budget.
- Per-minute request ceiling (`POLESTAR_BUDGET_PER_MINUTE`, default 100) alongside the daily
  budget; transient minute windows are waited out rather than surfaced, within the deadline.
- Response cache with per-domain TTLs, single-flight refresh and stale-while-revalidate.
- Streamable HTTP mode (`POLESTAR_HTTP_PORT`) with bearer authentication
  (`POLESTAR_HTTP_TOKEN`); refuses to bind a non-loopback interface without a token.
- MCP protocol surface: server `instructions`, `outputSchema` on every tool with a
  structured result envelope, `readOnlyHint` annotations, resources with VIN completion and
  subscriptions, prompts, graceful shutdown, `--help` / `--version`.
- An ambiguous VIN asks the client which vehicle to read through server-initiated
  elicitation, degrading to `AMBIGUOUS_VIN` when the client cannot be asked and
  `VIN_NOT_CHOSEN` when it declines.
- Per-call `delegated_account_id`, accepted only if allowlisted via
  `POLESTAR_DELEGATED_ACCOUNT_IDS`.
- `POLESTAR_ALLOW_LOCATION=false` blocks position at the request layer, not just its display.
- `POLESTAR_VEHICLE_LABELS` to name your cars; `POLESTAR_UNITS` for km/mi.
- `scripts/capture.ts` (refresh a capture and regenerate sanitized fixtures),
  `scripts/verify-fixtures.mjs`, `server.json`, Dockerfile, CI, `LICENSE` (MIT), `.env.example`.

### Changed

- Domain tools answer with a humanized summary and the data's age instead of a raw payload;
  `raw: true` returns the untouched API response.
- Tools are declarative specs registered by one module (`src/tools.ts`), so a handler is
  callable in a test without starting a server, and the domain read takes a registry row and
  an argument record instead of eight positional parameters.
- Each Domain's route, scope, cache lifetime, sampling decision and pinned key set live in
  one registry (`src/domains.ts`); the cache, the sampler, the fixture gate and the docs gate
  derive from it instead of keeping parallel lists.
- Payload shape is read through `src/domain-data.ts` and charging maths through
  `src/charge-model.ts`, so `get_charging_estimate` and `plan_cheapest_charge` can no longer
  disagree about kilowatts for the same vehicle.
- Failures return `isError: true` with a structured `{code, httpStatus, requestId, hint}`
  envelope instead of plain prose.
- `POLESTAR_ACCOUNT_ID` is now required in live mode. The gateway answers
  `403 AUTHZ_CLIENT_ID_MISMATCH` when `x-client-id` carries the OAuth client id, so the old
  fallback could not work.
- Secrets live outside the project tree (`~/.config/polestar-mcp/.env.secrets`); the
  hygiene gate treats any `.env*` file inside the repo as a finding.
- Fixture misses answer `NOT_FOUND`, deliberately distinct from a vehicle reporting no data.

### Fixed

- `activeWarnings()` missed nested warning objects, so `health.lightWarnings` (nineteen
  bulb positions) never reached `get_needs_attention`; it now walks nested structures.
- `Retry-After` was clamped to the local backoff cap, retrying sooner than the API asked.
- The background sampler was constructed but never started.
- The dotenv loader mishandled `export KEY=`, inline comments and quoted values containing
  `#`, which could make a complete-looking configuration fail.
- A trailing slash in `POLESTAR_BASE_URL` produced `//token`; invalid values now fail at
  startup rather than as an unexplained 404.
- Token expiry now respects the returned `tokenType`.

### Verification

Proven by the CI checks rather than restated here: typecheck, build, the unit suites, the
stdio, HTTP and bin smokes, the offline demo, fixture completeness, secret hygiene and the
documentation gates. The smoke run calls the 24 zero-argument tools plus `get_history`;
`plan_cheapest_charge` is covered by the planner unit tests. Fixtures cover 15/15 domains with
real response shapes, and the secrets gate also detects personal email, phone numbers,
precise coordinates and an endpoint dump parked in the tree.
