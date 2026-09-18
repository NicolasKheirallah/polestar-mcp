# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow SemVer.

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
  subscriptions, prompts, logging notifications, graceful shutdown, `--help` / `--version`.
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

Proven by the CI checks rather than restated here: build,
G2 unit suites, G3 stdio smoke, G4 secret hygiene, G5 real-dump compatibility, G6 HTTP smoke,
G7 typecheck plus fixture completeness plus coverage. The smoke runs exercise all 26
registered tools, fixtures cover 15/15 domains with real response shapes, and the secrets
gate also detects personal email, phone numbers, precise coordinates and an endpoint dump
parked in the tree.
