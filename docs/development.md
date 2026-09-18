# Development and verification

Who this is for: developers working on the server itself. Setup for users is in [getting-started.md](getting-started.md), the design rationale in [architecture.md](architecture.md).

## Repository layout

```
polestar-mcp/
  src/
    server.ts            wiring: config, engine, MCP surface, modes
    tools.ts             the one registrar; ToolSpec values, no side effects
    domains.ts           the Domain registry: routes, scopes, ttlMs, sampled, pinnedKeys
    domain-data.ts       reading a Domain payload: SoC, target, amps, window, timestamps
    charge-model.ts      power, capacity and energy maths shared by estimate and planner
    failure.ts           one declared shape for failures crossing to the tools
    subscriptions.ts     metaEventId polling, budget stand-down, injected clock
    bind.ts              the loopback-and-token decision for HTTP mode
    config.ts            configuration registry, validation, dotenv loader
    client.ts            PolestarClient: VINs, envelope, identity, errors
    auth.ts              TokenProvider: client-credentials lifecycle
    domain-tools.ts      the Domain tools as specs: list_vehicles, list_domains, 15 get_*
    aggregate-tools.ts   car status, security, attention, charge estimate
    advisor-tools.ts     plan_cheapest_charge (prices in, schedule out)
    system-tools.ts      polestar_status (budget, cache, token)
    history-tools.ts     history/degradation/sessions (opt-in)
    tool-output.ts       shared plumbing: vin/raw args, 403 scope hint
    format.ts            humanizer: enum labels, units, ages, summaries
    planner.ts           cheapest-hours arithmetic for the advisor
    history.ts           JSONL store, sessions, degradation series
    sampler.ts           optional background sampler, budget guard
    budget.ts            fail-closed daily-call meter
    caching-transport.ts TTLs, stale-while-revalidate, history hook
    retrying-transport.ts 429/502/503, Retry-After, backoff
    transport.ts         the seam: HttpTransport, FixtureTransport
  test/
    auth.test.ts         token lifecycle
    client.test.ts       envelope, headers, VINs, identity, errors
    runtime.test.ts      cache, retry, budget behavior
    planner.test.ts      charge-window math including wrap-around
    config-registry.test.ts  variables, validation, unknown detection
    helpers.ts           ScriptedTransport for scripted responses
    fixtures/dump/       a small sanitized dump for tests
  scripts/
    smoke.ts             stdio end-to-end: registry, tools, resources
    smoke-http.ts        Streamable HTTP end-to-end over POSTs
    demo-dump.ts         stdio checks against the real captured dump
    stdio-client.ts      minimal MCP stdio test client
    check-secrets.mjs    the secret-hygiene check
  docs/                  this documentation set
```

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Installs dependencies (MCP SDK v2, zod; TypeScript and tsx for development) |
| `npm run build` | Strict TypeScript compile into `build/`, the entrypoint your MCP client runs |
| `npm start` | Runs `build/server.js` (stdio, or HTTP when `POLESTAR_HTTP_PORT` is set) |
| `npm run dev` | Runs `src/server.ts` directly through tsx, no build step |
| `npm test` | The unit suites through the Node test runner (TAP output) |
| `npm run smoke` | Full stdio integration test against the sanitized fixtures |
| `npm run smoke-bin` | The same surface reached the way an install reaches it: through the bin symlink, plus `--version` and `--help`. |
| `npm run smoke-http` | Full Streamable HTTP integration test |
| `npm run demo-dump` | Full stdio integration test against the real captured dump one level up |
| `npm run check-secrets` | The secret-hygiene check |
| `npm run typecheck` | Types src, test, and scripts together with no emit |

Node 20 or newer is required (the engine field enforces it). The production build targets ES2022 with strict settings turned up: `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. The dev typecheck covers `test/` and `scripts/` under the same settings, so no source file is exempt from the declared contract.

## What the unit tests prove

The suites run through a `ScriptedTransport` that hands out pre-written responses and records every call, so each test can assert both the outcome and the exact wire behavior.

- `auth.test.ts`: concurrent `token()` callers collapse into a single request; a cached token is reused; refresh happens only after `expiresIn` minus the five minute skew and the request body carries the exact scope list; a token-endpoint failure surfaces as an `AuthError` with the OAuth error text, `requestId`, and `timestamp`.
- `client.test.ts`: envelope unwrapping; the exact headers (`authorization`, `x-client-id`, `accept`, and `x-delegated-account-id` when configured); VIN resolution (omitted with one vehicle, ambiguous with several, malformed rejected); identity checks that refuse a response labelled for a different vehicle or domain; error normalization preserving `code`, `httpStatus`, `requestId`, and `details`; the 404 `DATA_NOT_AVAILABLE` to `null` rule; exactly one fresh-token retry on 401.
- `runtime.test.ts`: cache TTL and stale-while-revalidate behavior (expired entries serve the last value and refresh single-flight in the background; POSTs and errors bypass the cache); retry behavior (429 honoring `Retry-After`, 502/503 backoff, non-retryable errors pass through); budget metering including the fail-closed stop.
- `planner.test.ts`: the cheapest-hours math, including a charge window that wraps midnight, unpriced slots treated as last resorts, and the contiguous-block fallback.
- `config-registry.test.ts`: the variable registry, validation failures (bad URL, non-numeric numbers, out-of-range ports, unsupported units), and unknown-variable detection with suggestions.

## End-to-end scripts

`scripts/stdio-client.ts` is a minimal MCP client: it spawns the server as a child process, speaks newline-delimited JSON-RPC on stdio, and offers typed helpers for the handshake, `tools/list`, `tools/call`, and resource reads. Both stdio test scripts are built on it.

`npm run smoke` starts the server in fixture mode against the sanitized test fixtures and asserts, in order: the handshake completes with the expected server name, the tool registry is complete (every domain tool plus the aggregate, advisor, system, and history tools), tools carry their `readOnlyHint` annotations, the optional-vin resolution works, `get_car_status` produces a humanized briefing, resources list and read, the three prompts exist, the history recorder feeds `get_history`, a `DATA_NOT_AVAILABLE` domain degrades into a plain sentence, and an unknown tool is rejected cleanly. Only after every assertion does it print `SMOKE_OK`.

`npm run smoke-http` starts the server with `POLESTAR_HTTP_PORT` set and speaks plain JSON-RPC over HTTP POSTs (stateless mode): handshake, tool registry, a `get_battery` call, and a resource read. It prints `HTTP_SMOKE_OK`.

`npm run demo-dump` runs the stdio checks against the real captured dump in the parent directory (the `api_endpoints` folder this project lives in), which proves the fixture layout matches reality. It prints `DUMP_OK` on success and never prints VINs or data values beyond existence checks.

## Verification

Verification is the CI workflow, not a ledger in the tree: `typecheck`, `build`, `verify-fixtures`, `test`, `coverage`, both smoke runs, `check-secrets`, `check-tool-refs` and the four `docs/check-docs.mjs` checks. Each one prints a success marker only after every assertion passes, and each is described in [CONTRIBUTING.md](../CONTRIBUTING.md). Where a check is only meaningful if it can reject something, it runs a positive control first, so a green result cannot mean the detector quietly stopped looking.


Run the checks rather than trusting any summary in these pages.

## Secret hygiene

Credentials live outside the project tree by design (the search order is in [getting-started.md](getting-started.md)). The scanner in `scripts/check-secrets.mjs` enforces the other half of the discipline:

- A credential file inside the tree is itself a finding, whatever it holds. The rule is a pattern, not a list of names: `.env.production` holds a live token just as well as `.env.secrets` does, so anything matching the `.env` family (or an env/secrets/credentials suffix) is flagged. `.gitignore` ignores the whole `.env` family, and the scanner catches files git would track.
- Three structural detectors run over every text file (skipping `node_modules`, `build`, `.git`, images, and source maps): three-segment JWT shapes, opaque lowercase credential blobs of 25 to 40 characters (the shape Apigee consumer keys take), and any 17-character VIN-shaped identifier.
- Detectors match shapes, never values. A scanner that embedded the owner's real VIN or client ID would become the leak it exists to catch, and its output reports only file and line, never matched text.
- Every detector must first fire on a synthetic positive control, or the scan exits with `CONTROL_FAIL` and a clean result means nothing.
- The one allow-listed VIN shape is the synthetic test marker `YSMTEST...` (regex `^YSMTEST\d{2}PL\d+$`), which cannot be a real Polestar identifier. Every other VIN-shaped match is treated as genuine.

Treat captured dumps like passwords. The dump in the parent directory contains long-lived refresh tokens and location history; do not commit it, email it, or paste its contents into issues.

## Adding a tool

Domain tools are table-driven: a new read domain is one new row in the `DOMAINS` registry in `src/domains.ts` (kind, URL path segment, OAuth scope, description, `ttlMs`, `sampled`, `pinnedKeys`). The tool name, registration, token scope, resource URI, and fixture layout follow automatically:

1. Add the row, plus a fixture file at the matching path under `test/fixtures/dump/dataportal/` wrapped in the `{data, meta}` envelope (an error envelope with `"httpStatus": 404` and code `DATA_NOT_AVAILABLE` tests the missing-data path).
2. Give the row a summarizer: `src/format.ts` renders each Domain, and a row without one is a failing test rather than a silent raw-payload dump.
3. Extend the unit tests for new wire behavior; the smoke script derives its expected registry from the code.

A tool outside the domain table (like the aggregates) lives in its own module as a list of `ToolSpec` values, each with a zod argument shape, the `readOnlyHint` annotation and a `run(args, ctx)` function. `registerTools` in `src/tools.ts` is the only place that touches the SDK, so a handler is callable from a test without starting a server. A write tool, if Polestar ever publishes v1 writes, would additionally require `POLESTAR_ENABLE_WRITES`, an explicit `vin` argument, and a `destructiveHint` annotation.

## Versioning

The server reports its version in the MCP handshake from `package.json` (currently 0.3.0), so there is exactly one version number to bump.
