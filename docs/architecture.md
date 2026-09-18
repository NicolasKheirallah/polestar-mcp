# Architecture

Who this is for: developers who want to change the server, review it, or understand why it is built the way it is. For setup instructions see [getting-started.md](getting-started.md); for the API contract see [upstream-api.md](upstream-api.md); for the domain vocabulary see [CONTRIBUTING.md](../CONTRIBUTING.md).

## The mental model in one paragraph

One deep module, `PolestarClient`, knows everything about talking to Polestar: how to resolve which car a call means, how to get and cache a token, which headers to send, how responses are wrapped, how errors are shaped, and what "this car reports nothing here" means. A transport chain under it keeps the 10,000-calls-per-day budget honest: a cache serves repeats locally, a retry wrapper handles the API's transient failures, and every live attempt is metered before it goes out. On top sit table-driven domain tools, four aggregate tools and one advisor that reuse the same data, an opt-in history store that turns the stateless API into a memory, and a humanizer that renders domain reads in short prose. The whole surface is available over stdio or stateless Streamable HTTP from the same engine.

```
MCP client (stdio)         HTTP client (Streamable HTTP, stateless)
      |                          |
      +------------+-------------+
                   v
+--------------------------------------------------------------+
| server.ts   config -> engine -> MCP surface                  |
|             engine: budget, history store, sampler, stats    |
|                                                              |
| tools:  domain reads (15) + listings (2)  aggregates (4)     |
|         advisor (1)  system (1)       history (3, opt-in)    |
|         resources + completions + metaEventId subscriptions  |
|         three prompts                                        |
|         tools.ts (one registrar), format.ts (humanizer),     |
|         domain-data.ts (payloads), charge-model.ts,          |
|         failure.ts, tool-output.ts (vin/raw)                 |
|                   |                                          |
| client.ts   PolestarClient (the deep module)                 |
|             resolveVin, unwrap, identity checks, errors      |
|                   |                                          |
| domains.ts      the Domain rows: route, scope, ttlMs,        |
|                 sampled, pinnedKeys; the URI grammar         |
| subscriptions.ts metaEventId poller, budget stand-down       |
| caching-transport   TTL from the Domain row, stale-while-    |
|                     revalidate, history hook, stats          |
|                   |                                          |
| retrying-transport  429/502/503, Retry-After, budget meter   |
|                   |                                          |
| http-transport (deadline)     fixture-transport (offline)    |
+--------------------------------------------------------------+
                   |
     Polestar Data Portal M2M API (or the captured dump)
```

## What each module does

### `config.ts`: the configuration registry

`loadConfig()` is the only place environment variables become a `Config` object, and the file also exports `KNOWN_ENV_VARIABLES`, the exact list the server reads. Three behaviors fall out of having a registry:

- Unknown variables are reported: a typo in a variable the server never reads is otherwise invisible: the value is simply absent and behavior silently stays at its default. The server warns on startup and suggests the closest real name; `POLESTAR_STRICT_ENV=1` makes it fatal.
- Invalid values fail before any request: a base URL that is not an absolute URL, a non-numeric timeout, an out-of-range port, or an unsupported unit raises `InvalidConfigError` with the variable name, the problem, and the fix.
- The Account ID is asked for, never guessed. The gateway answers 403 `AUTHZ_CLIENT_ID_MISMATCH` when `x-client-id` carries the OAuth client ID, so live mode requires `POLESTAR_ACCOUNT_ID` explicitly, and the server warns when the resolved Account ID is identical to the client ID.

The dotenv loader here handles the idioms hand-rolled parsers get wrong: a leading `export `, values quoted with either kind of quote, and trailing `#` comments, while a `#` inside a quoted value stays data.

### `server.ts`: wiring, stdio, and HTTP

`buildEngine()` constructs everything shared: config, budget meter, optional history store and sampler, the transport chain, token provider, and client. `createMcpServer()` registers the tools, resources, and prompts on an MCP server whose `instructions` field tells clients the important ground rules up front: the API is read-only, start with `list_vehicles`, prefer `get_car_status` over five domain calls, read the data age, and quote `requestId` when reporting problems.

Transport choice and modes:

- stdio (default) connects a `StdioServerTransport`; stdout carries the JSON-RPC protocol and nothing else, so diagnostics go to stderr and an unhandled rejection is logged rather than fatal.
- `POLESTAR_HTTP_PORT` switches to a stateless Streamable HTTP server: each request gets a fresh MCP server instance over one shared engine (cache, budget, history included). It binds `127.0.0.1` unless told otherwise, and refuses to bind any non-loopback address without `POLESTAR_HTTP_TOKEN`, because the server reads vehicle location and an unauthenticated listener would put that on the network. Subscriptions are a stdio feature.
- In fixture mode the secrets file is not read at all, so offline use never touches a live credential file.

Shutdown is deliberate: on `SIGTERM`/`SIGINT` the sampler stops taking quota calls, the MCP session closes so clients see a real end-of-session, and the exit code says "stopped" rather than "crashed" (with a 5-second hard exit as the backstop).

### `domains.ts`: the domain registry

The heart of the tool surface is `DOMAINS`, one entry per read Domain of the API: kind (`telemetry` or `charging`), URL path segment, OAuth scope, a description, the cache lifetime that Domain's own value can bear (`ttlMs`), whether background sampling should watch it (`sampled`), and the key set its captured fixture must hold (`pinnedKeys`). Everything else derives from those rows: tool names (`target-soc` becomes `get_target_soc`), the scope list the token request sends, the resource URI space, the sampler's schedule, the cache's freshness rules, and the contract test's expectations.

The rows are split from their registration on purpose. `domain-tools.ts` turns them into `ToolSpec` values; `caching-transport.ts`, `sampler.ts` and the fixture gate read the same rows without importing anything about tools. A Domain fact that lives only in a satellite list is how a forgotten edit becomes a wrong TTL on live quota rather than a failing test, and `domains.ts` also owns `domainPath`, `parseDomainPath` and `parseResourceUri`, the three spellings of one Domain route.

### `tool-output.ts` and `format.ts`: the humanizer

`readDomainFormatted()` is the one rendering path for domain reads: resolve the VIN, fetch through the cache, and answer with a header (vehicle, domain, data age), a humanized summary, and the raw payload when `raw: true` is requested. `format.ts` does the summarizing: enum labels lose their `CHARGING_STATUS_V2_`-style prefixes and gain readable wording ("Unplugged", "Asleep / not in use"), values get sane units, and each answer's age comes from the payload's own timestamp. A 403 answer gains a scope hint, because the M2M credential is scope-scoped per domain and the raw API message never says which scope was missing.

### `aggregate-tools.ts`, `advisor-tools.ts`, `system-tools.ts`

- The four aggregate tools answer the questions people actually ask in one call, over data the domain tools already serve. They read through the cache, so an aggregate costs at most one live call per constituent domain and usually zero. `get_car_status` reads five domains in parallel; `is_car_secure` turns the exterior domain into a true/false verdict that names anything open; `get_needs_attention` filters the health domain down to active warnings; `get_charging_estimate` combines battery, target, and amp limit, states every assumption it makes, and falls back to the car's own time-to-full estimate when the data for exact math is missing.
- `plan_cheapest_charge` is the read-only smart-charging advisor: the caller supplies hourly prices as an argument, the tool adds the car's SoC, target SoC, amp limit, and charge window from `global-charge-timer`, and `planner.ts` computes the cheapest contiguous hours that reach the target (falling back to cheapest individual hours, and saying so, when the window is too short). No writes, no external fetches.
- `polestar_status` is the server's self-observation: budget used and remaining with its reset time, cache hit rate, and token expiry. An agent that can see the budget can pace itself instead of tripping the fail-closed guard.

### `history.ts`, `sampler.ts`, `history-tools.ts`: memory for a stateless API

The API answers only "what is true right now", so any longitudinal question needs a local store. `HistoryStore` is an append-only JSONL file per vehicle and domain, deduplicated by the cloud's `metaEventId`: the cloud re-serves the same ID until the car reports something new, so unchanged snapshots cost a single line. A torn last line (a crash mid-append) is tolerated on read. Recording hooks into the cache's live-response callback, so passive recording never spends an extra call. `HistorySampler` optionally polls the four fast-moving domains on a timer (default every 10 minutes, clamped 60 to 3600 seconds) and stands down entirely once 80% of the daily budget is spent; it is off unless `POLESTAR_SAMPLE=1`. The three history tools ride on top: raw samples, a degradation series (implied full-charge range from range/SoC, implied capacity from usable energy/SoC; samples under 5% SoC are skipped as noise), and reconstructed charging sessions (a maximal run of charging samples, gaps up to 30 minutes allowed).

### `client.ts`: the deep module

`PolestarClient` exposes `vehicles()`, `domain(vin, kind, name)`, and `resolveVin()`:

- `resolveVin()` turns the optional `vin` argument into a concrete car: an omitted VIN means "the only vehicle" (the personal-credential case); a credential with several cars throws `AMBIGUOUS_VIN` listing the VINs; a malformed one throws `INVALID_VIN` (17 characters, no I/O/Q). At the tool layer the ambiguity is caught and turned into an MCP elicitation question ("This credential can see N vehicles. Which one?") when the client can answer; the reply is passed through `resolveVin` again, so untrusted client input is still validated. Delegated accounts follow the same pattern: a call may pass `delegated_account_id`, which is checked against the `POLESTAR_DELEGATED_ACCOUNT_IDS` allowlist and refused (`DELEGATION_NOT_ALLOWED`) if absent, because the API silently accepts unknown delegated IDs.
- `domain()` sends `Authorization: Bearer`, `x-client-id` (plus `x-delegated-account-id` when configured), unwraps the `{data, meta}` envelope, and maps the one special case of a 404 `DATA_NOT_AVAILABLE` to `null`. Every other failure becomes a `PolestarApiError` carrying the API's own `code`, `message`, `httpStatus`, and, when present, `requestId`, `timestamp`, and `details`.
- `assertIdentity()` checks the envelope (and the payload's own VIN field) against the requested car and domain, refusing a response labelled for a different vehicle with `VIN_MISMATCH` or `DOMAIN_MISMATCH`. Presenting one car's telemetry as another's is the one error this server must never make, whether the mislabel comes from a bad fixture or an upstream surprise.
- A 401 triggers exactly one fresh-token retry; a second 401 surfaces as an error instead of burning the rate limit forever.

### `auth.ts`: the token provider

`TokenProvider` owns the client-credentials flow: a POST to the token URL with a JSON body of `clientId`, `clientSecret`, and the space-joined scope list (overridable with `POLESTAR_SCOPES`). The token is cached until `expiresIn` minus a five-minute skew, concurrent callers share one in-flight request, `invalidate()` drops the cache but leaves the in-flight promise alone, and `expiresAt()` lets the status tool report how long the current token is still trusted. Token failures raise `AuthError` with the HTTP status and, when present, `requestId` and `timestamp`, reading both of Polestar's documented error shapes.

### The transport chain

`Transport` remains a one-method seam (`fetch(url, request)` to status, headers, and body), and the chain layers three adapters around it:

- `CachingTransport` serves repeated GETs locally. Each URL gets a TTL from how fast the value can actually change: vehicle list 1 hour; battery, location, and exterior 30 seconds; availability, odometer, and parking climatization 60 seconds; pre-cleaning 30 minutes; health 10 minutes; charging settings 5 minutes. Once an entry expires, the caller gets the last known value immediately (counted as "stale served") while a single-flight refresh runs in the background, so latency never waits on Polestar. The token POST and error responses pass straight through, and every successful live domain GET fires the history recorder.
- `RetryingTransport` retries exactly the failures the API documents: 429 (honoring `Retry-After` when present) and 502/503, with exponential backoff capped at 5 seconds and at most 3 attempts. Every attempt, including retries, is metered against the budget before it goes out. Network errors are not retried; the caller sees them immediately.
- `HttpTransport` (a 15-second default deadline per request) and `FixtureTransport` (the captured-dump adapter) sit at the bottom, unchanged in spirit: the deadline exists because one hung connection would otherwise wedge every caller queued behind it, and the fixture adapter keeps missing fixtures (`NOT_FOUND`) deliberately distinct from missing data (`DATA_NOT_AVAILABLE`), replays captured error statuses, and refuses lookups that escape the fixtures directory.

In fixture mode the retry layer is skipped (replays are free) and the cache is disabled unless history is on, so a static dump cannot cache-dedupe anything useful.

### `budget.ts`: the fail-closed meter

`BudgetMeter` counts actual live calls against the documented 10,000-per-client-per-day limit over a rolling UTC day window. Cache hits, stale re-serves, and fixture reads never consume budget. When the limit is reached, `consume()` throws `BudgetExceededError` before the request goes out: the server fails closed rather than hammering an API that will only answer 429. The status tool and the resource poller both read the same meter (subscriptions pause at 90% usage; the sampler stands down at 80%).

## Error model

| Error class | Raised by | When | Carries |
| --- | --- | --- | --- |
| `MissingConfigError` | `config.ts` | live mode without client ID, secret, or Account ID | the missing variables and every way to fix them |
| `InvalidConfigError` | `config.ts` | a variable is present but unusable | variable, problem, guidance |
| `AuthError` | `auth.ts` | the token endpoint failed or answered malformed | status, `requestId`, `timestamp` |
| `TransportError` | `transport.ts` | deadline exceeded or network failure | `causeKind`: `timeout` or `network` |
| `BudgetExceededError` | `budget.ts` | daily limit reached; fails closed | used, limit, reset time |
| `PolestarApiError` | `client.ts` | API error envelope (except DATA_NOT_AVAILABLE), unusable body, `INVALID_VIN`, `AMBIGUOUS_VIN`, `NO_VEHICLES`, `VIN_MISMATCH`, `DOMAIN_MISMATCH` | `code`, `message`, `httpStatus`, `requestId`, `timestamp`, `details` |
| `null` (not an error) | `client.ts` | 404 with code `DATA_NOT_AVAILABLE` | tools turn this into a plain sentence |

## Design decisions, and why

- **A budget meter, not polite suggestions.** The API's only hard resource is the daily call allowance. Metering before every attempt and failing closed turns "the server exceeded the rate limit" into "the server stopped and said why".
- **Stale-while-revalidate over blocking refresh.** Agents ask questions; waiting 15 seconds for a fresh value they did not need fresh is worse than an instant answer with a visible age. Every answer carries its data age.
- **History is opt-in and deduplicated.** Recording is passive (a cache hook), the sampler is a separate flag, and `metaEventId` deduplication keeps the store proportional to actual change. The degradation report presents series, not verdicts, because range is conditions-dependent.
- **One deep module, thin tools.** Token logic, headers, envelope handling, identity checks, and error rules are easy to get subtly wrong; keeping them in `PolestarClient` means the tools are a boring layer, and there is exactly one place for each API behavior.
- **The transport seam, not a fetch mock.** With real adapters, tests and offline use run the same code path as production; there is no separate "test mode" branch anywhere in the client.
- **Fixture honesty.** A missing fixture must never read as "the vehicle reports nothing", and fixture mode must never touch a live credential file. Both choices keep the null rule and the auth lifecycle falsifiable in tests.
- **Read-only by construction.** No tool mutates state because the documented v1 API publishes no write endpoints. `POLESTAR_ENABLE_WRITES` registers nothing today; it is the deliberate opt-in future write tools will slot behind.
- **HTTP mode with a loopback guard.** The same engine serves stdio and HTTP, but a server that reads vehicle location must not come up unauthenticated on a shared network, so the non-loopback bind requires a bearer token.
