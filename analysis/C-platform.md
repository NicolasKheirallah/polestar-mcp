# C. Platform, protocol and reliability

Who this is for: the council seats and the owner deciding what to build next. This report covers
the MCP protocol surface in use, the deployment and operations story, the budget, cache, retry,
subscription and history governance, and the extension seams a fleet operator or a hosted
deployment would press on. Every claim below is tied to `file:line`, a command, or a measured
number; the commands are listed in the verification log at the end. No source file was modified.

One finding dominates this report. The fail-closed budget rule that SECURITY.md and the
architecture doc describe is not applied when `POLESTAR_CACHE=off`: the retry and metering
adapters are removed from the transport chain along with the cache. Two reads of one domain then
produced five live HTTP requests and `polestar_status` reported `0/10000 used` (measured). That is
candidate C1, and it is the strongest counter-signal to the project's central safety claim.

## What exists

### Runtime composition and modes

`buildEngine()` builds one engine per process from `loadConfig(env)`: a `BudgetMeter`, a
`MinuteWindowMeter`, an optional `HistoryStore`, the transport chain, one `TokenProvider`, and one
`PolestarClient` (`src/server.ts:60-132`). `main()` builds exactly one engine and hands it to
either the stdio surface or the HTTP server (`src/server.ts:555`, `src/server.ts:569-577`).

The transport chain is assembled in this order (`src/server.ts:70-89`):

- bottom: `FixtureTransport` when `POLESTAR_FIXTURES_DIR` is set, otherwise `HttpTransport` with a
  15 second default deadline (`src/transport.ts:33-69`);
- `RetryingTransport` around the bottom adapter, but only when neither fixture mode nor
  `config.cacheDisabled` is set (`src/server.ts:78-79`);
- `CachingTransport` on top, disabled for fixture mode without a history store
  (`src/server.ts:80-87`);
- that cached transport is what `TokenProvider` and `PolestarClient` receive
  (`src/server.ts:91-114`).

So the cache is optional, and when the operator turns it off, the budget meter and the per-minute
meter leave the chain with it. Candidate C1 covers the consequence.

Surface shape: `createMcpServer()` registers 23 tools on every start and 26 when
`POLESTAR_HISTORY_DIR` is set (measured `ready: 23 tools over 15 domains`; the three history tools come
from `src/history-tools.ts` and are added at `src/server.ts:188-202`). Two resource templates cover the 15 Domains, split by kind, for each visible VIN
(`src/server.ts:263-322`), three prompts are registered
(`src/server.ts:338-409`), and the resource subscription poller is created by the same object
that closes it (`src/server.ts:231-260`).

stdio serves one surface for the process lifetime. HTTP mode builds a fresh surface per request
over the one shared engine, closes that surface when the response closes, and disables
subscriptions because the surface that would poll ends with the request
(`src/server.ts:421-444`).

### The MCP surface and protocol

Measured handshake over stdio: the server negotiates `2025-11-25` and advertises
`resources {subscribe: true, listChanged: true}`, `logging {}`, `tools {listChanged: true}`,
`completions {}`, and `prompts {listChanged: true}`, with the instructions string from
`src/server.ts:207-214`. The same handshake over HTTP advertises `subscribe: false`. Requests for
the modern revision are downgraded or rejected (measured: an `initialize` for `2026-07-28` answers
`2025-11-25`; `server/discover` with `MCP-Protocol-Version: 2026-07-28` is HTTP 400 listing
`2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07`). The installed SDK is v2 and
implements the 2026-07-28 revision (`node_modules/@modelcontextprotocol/server/README.md:5`). The
server package exports `createMcpHandler`, `PerRequestHTTPServerTransport` and
`buildOAuthProtectedResourceMetadata`; the node package exports `localhostHostValidation` and
`localhostOriginValidation` (`node_modules/@modelcontextprotocol/node/README.md:20-21`).

| Feature | State in this server | Evidence | Verdict |
| --- | --- | --- | --- |
| `initialize` instructions | Used, generated from the live registry | `src/server.ts:181-217`, measured handshake | Real: it names the aggregates and the budget before the model picks a tool |
| Tools, `inputSchema` | Used for 23 or 26 tools | `src/tools.ts:41-55`, measured `tools/list` | Real |
| `outputSchema` and `structuredContent` | On every tool, `ok`/`message` envelope | `src/tools.ts:49`, `src/tool-output.ts:62-100`, `scripts/smoke.ts:54-58` | Real: this is the strongest existing protocol choice |
| `readOnlyHint` annotations | On every tool | `src/tools.ts:24`, measured `tools/list`, `scripts/smoke.ts` | Real: clients can auto-approve reads |
| Resources and resource templates | Two templates, 15 resources per VIN | `src/server.ts:275-322`, measured 15 resources and 2 templates | Real, but listing caps at 10 VINs (`src/server.ts:283`) |
| Resource subscriptions | stdio only, 60 second poller | `src/server.ts:327-335`, `src/subscriptions.ts:36`, measured HTTP `subscribe: false` | Real on stdio; correctly refused over stateless HTTP |
| Completions | Resource URI variables only | `src/server.ts:296-303`; measured `battery` value for a resource ref, empty values for a prompt `vin` argument | Used narrowly; prompt arguments are not completable |
| Prompts | Three prompts | `src/server.ts:341-409`, measured names | Real for humans, marginal for agents that call tools directly |
| Elicitation | Used for ambiguous VIN choice | `src/vehicle-read.ts:71-113`, `scripts/runtime.test.ts` ambiguous VIN test | Real, legacy channel only |
| Cancellation | Available as `ctx.mcpReq.signal`; not carried anywhere | SDK type in `node_modules/@modelcontextprotocol/server/dist/mcp-BCJHyo7l.d.mts:2181-2182`; `src/tool-output.ts:188-194` has no signal; `src/transport.ts:5-9` has no signal in `TransportRequest` | Available and useful; unused (C7) |
| Progress | Available; no `progressToken` handling | `src/tools.ts` registrations, no `progress` reference in `src/` | Decoration: calls are bounded by the 15 second deadline |
| Sampling (server asks client for an LLM call) | Available; unused | no `requestSampling` reference in `src/` | Decoration: this server's arithmetic is deterministic |
| Tasks and `tasks/*` | Available in the SDK; no `tasks` capability | measured `tasks/list` returns `-32601` | Decoration: no work outlives a request |
| Logging notifications (`notifications/message`) | Capability declared, `logging/setLevel` accepted, nothing ever sent | `src/server.ts:215`; `grep -rn sendLoggingMessage src/` is empty; measured `logging/setLevel` returns `{}` | Inert capability; the SDK deprecates it for 2026-07-28 in favour of stderr or OpenTelemetry |
| Modern revision `2026-07-28`, `server/discover`, multi-round-trip | Available in the installed SDK; not served | measured downgrade and HTTP 400; `node_modules/@modelcontextprotocol/server/README.md:5` | Future-proofing plus one real channel (input_required); C11 |
| OAuth protected resource metadata (RFC 9728) | Absent | measured 401 `www-authenticate: Bearer` only; `/.well-known/oauth-protected-resource` answers 401 or 406, never metadata | Decoration until a hosted mode exists |
| Cache hints | Available in the SDK; unused | no `CacheHint` reference in `src/` | Decoration until the modern revision is served, then a natural fit for `ttlMs` |
| Protocol version testing | Every smoke client pins `2025-06-18` | `scripts/stdio-client.ts:85`, `scripts/smoke-http.ts:59`, `scripts/smoke-bin.ts:51` | The negotiated latest version is untested |

The features that move the needle for this server, in order: structured output with `ok`/`message`
(already shipped), `readOnlyHint` auto-approval (already shipped), cancellation (missing, and it
costs quota), the modern revision with `input_required` for VIN choice (missing, mostly
future-proofing), and resource completions (shipped narrowly). Sampling, tasks, progress, and MCP
logging notifications are decoration for a read-only request/response server. OAuth metadata and
cache hints are decoration today and real only behind a hosted or modern deployment.

### Deployment, operations and distribution

The container story is a 17 line Dockerfile that nothing builds and no document mentions
(`Dockerfile:1-17`; `grep -rn -i "docker\|container" README.md docs/ SECURITY.md CONTRIBUTING.md`
returns only a comment inside `docs/check-docs.mjs`). It runs as root with no `USER`, has no
`HEALTHCHECK`, no `EXPOSE`, no pinned base image digest, and no `.dockerignore`, so the 64 MiB
`node_modules` directory is sent as build context. The entrypoint is
`node build/server.js` (`Dockerfile:17`), and the image sets `POLESTAR_ENV_FILE` only in a comment
(`Dockerfile:15-16`).

CI is one workflow of 38 lines (`/.github/workflows/ci.yml:1-38`): typecheck, build,
verify-fixtures, test, coverage, smoke, smoke-bin, smoke-http, check-secrets, check-tool-refs, the
tools, envvars and links doc checks, and hygiene. It has no Docker build, no npm publish, no image
push, no tag trigger, and no provenance step. `package.json` has a `prepack` build
(`package.json:24`) and nothing else release related; there is no `publishConfig`. `git tag -l`
returns nothing, and `docs/releases/` holds one hand-written file, `v0.3.0.md`.

The registry manifest exists but nothing validates it: `server.json` carries the version twice
(`server.json:9`, `server.json:14`), offers the npm package for `stdio` only
(`server.json:10-24`), and no script, test or CI step reads the file
(`grep -rn "server.json" scripts/ test/ docs/ .github/ package.json` returns nothing). Meanwhile
`docs/development.md:126` says package.json is "exactly one version number to bump", which is
already false in the tree.

Operations have no health signal. Measured against a loopback server in fixture mode:

- `GET /` without an SSE `Accept` returns 406 `Client must accept text/event-stream`.
- `GET /` or `GET /healthz` with `accept: application/json, text/event-stream` returns 200 with
  `content-type: text/event-stream` and holds the connection open, so a conventional health probe
  hangs rather than returning a status.
- `HEAD /` returns 405 with `allow: GET, POST, DELETE`; `DELETE /` returns 200 with an empty body.

There is no metrics endpoint, no structured log line per request or per upstream call, and no
timing instrumentation. The only logging is `console.error("[polestar-mcp] ...")` in `engine.log`
(`src/server.ts:62-65`), the startup lines, and the background refresh warning
(`src/server.ts:81-85`). `POLESTAR_LOG=debug` gates exactly one startup line listing resolved
values (`src/config.ts:285`, `src/server.ts:562-567`); the config comment itself says "Nothing else
reads the flag" (`src/config.ts:44`), while the user docs promise "verbose stderr diagnostics"
(`docs/getting-started.md:105`). `grep -rn "sendLoggingMessage\|performance\.\|histogram\|metrics" src/`
finds nothing.

The CLI is `--version` and `--help` only (`src/server.ts:490-519`). There is no config check
command, no reload on `SIGHUP`, and no way to validate a credential without a live tool call. The
HTTP smoke script passes `--http` (`scripts/smoke-http.ts:15`), a flag the parser does not know;
mode is selected by `POLESTAR_HTTP_PORT` alone, so a user copying that command gets stdio.

### Budget, cache, retry, subscriptions and history

Budget and rate policy as read:

- `BudgetMeter` keeps `used` and `windowStart` in memory, uses a fixed UTC midnight window, and
  throws `BudgetExceededError` before the request goes out (`src/budget.ts:24-81`).
- `MinuteWindowMeter` is a second in-memory fixed window, default 100 per minute
  (`src/budget.ts:84-137`, `src/config.ts:274`).
- Every attempt through `RetryingTransport` is metered before it is sent, including retries
  (`src/retrying-transport.ts:56-69`); tests assert this (`test/runtime.test.ts:86-104`).
- The sampler stands down at 80 percent (`src/sampler.ts:120`) and subscriptions pause at 90
  percent (`src/subscriptions.ts:93`).
- Neither meter is persisted, and both are constructed per engine, which is per process
  (`src/server.ts:66-67`). Two meters with limit 3 each allowed six calls combined (measured).

Cache policy:

- TTL comes from the Domain row: 30 seconds for battery, exterior and location, 60 seconds for
  availability and odometer, 5 minutes for charging settings, 10 minutes for health, 30 minutes
  for pre-cleaning, 1 hour for the vehicle list (`src/domains.ts:36-47`, `src/domains.ts:367`).
- Expired entries are served immediately and refreshed single-flight in the background
  (`src/caching-transport.ts:87-131`).
- Only responses with status below 400 are stored (`src/caching-transport.ts:113-115`), so the
  normal `404 DATA_NOT_AVAILABLE` answer is never cached. Measured through the real tool path:
  two reads of `get_is_at_charge_location` produced three live misses and no entry, while a
  successful domain read was served once for three reads.
- The cache key is the URL string alone (`src/caching-transport.ts:83`), and the delegation
  identity travels as a request header (`src/client.ts:193-199`), so the cache has no notion of
  which credential or delegated account produced an entry.

Retry policy:

- Retryable statuses are exactly 429, 502 and 503 (`src/retrying-transport.ts:21`).
- Backoff is 500 ms times 2 per attempt, capped at 5 seconds, inside a 15 second total deadline
  (`src/retrying-transport.ts:42-46`, `src/retrying-transport.ts:75-82`).
- A numeric `Retry-After` is honoured as given; an HTTP-date `Retry-After` is not parsed
  (`src/retrying-transport.ts:88-93`). Measured: a 429 with `retry-after` set to a UTC date 30
  seconds out produced a 500 ms wait, so the server retried 29.5 seconds sooner than asked.
- There is no jitter, so concurrent processes retry in lockstep.
- Network failures are not retried at all (`src/transport.ts:50-62`; stated as design in
  `docs/architecture.md:112`).

Subscriptions:

- The poller reads every subscribed URI every 60 seconds, compares `metaEventId`, and notifies on
  change (`src/subscriptions.ts:35-113`).
- `resources/subscribe` validates nothing beyond parsing: a URI with `not-a-vin` and a URI with an
  unknown domain were both accepted with an empty result (measured). `parseResourceUri` checks the
  Domain registry but not the VIN shape (`src/domains.ts:404-423`), and `PolestarClient.domain()`
  does not validate the VIN (`src/client.ts:136-148`).
- There is no subscription count cap and no reentrancy guard on `pollOnce`. Two overlapping rounds
  both notified for one change (measured), because the interval callback starts a new async round
  without checking whether one is running (`src/subscriptions.ts:44-47`); the sampler has the
  guard that the poller lacks (`src/sampler.ts:57-59`).
- The new `metaEventId` is stored before `notify` is awaited (`src/subscriptions.ts:105-108`), so a
  failed notification is never retried. Measured: one notify attempt, then silence.

History and sampler:

- `HistoryStore` appends JSONL per vehicle and domain, deduplicates on `metaEventId`, tolerates a
  torn last line, and refuses to load a file over 64 MiB (`src/history.ts:5`, `src/history.ts:41-78`).
- Queries read and JSON-parse the whole file synchronously on the event loop
  (`src/history.ts:64-73`), so one large file stalls every other request sharing that process.
- There is no rotation, compaction or prune command; the 64 MiB refusal is the only bound, and it
  turns into an `INTERNAL_ERROR` at the tool surface (`src/failure.ts:108-109`).
- The sampler reads the four `sampled` Domains every 60 to 3600 seconds, default 600
  (`src/domains.ts:70-173`, `src/sampler.ts:123-131`), which is 576 calls per vehicle per day at the
  default cadence; captured payloads for those Domains are 491 to 935 bytes as envelopes
  (measured `wc -c`), so a vehicle produces a few hundred KB of JSONL per day before deduplication.

Auth:

- `TokenProvider` caches until `expiresIn` minus five minutes, collapses concurrent callers, and
  `invalidate()` drops the cached value but not the in-flight request (`src/auth.ts:12-13`,
  `src/auth.ts:66-93`).
- `expiresAt()` returns the raw advertised expiry, not the skew-adjusted trust horizon
  (`src/auth.ts:96-98`, `src/auth.ts:147`), so `polestar_status` can report a token as trusted for
  minutes after `token()` would refuse it.
- A 401 retries once with a fresh token (`src/client.ts:201-205`). Because `invalidate()` clears
  any cached value, a concurrent 401 that arrives after another caller refreshed can discard the
  fresh token and force one more token POST.

### Configuration and versioning

Configuration is environment and dotenv only: 27 variables in `KNOWN_ENV_VARIABLES`
(`src/config.ts:83-89`), validated at startup with actionable errors (`src/config.ts:236-296`),
unknown `POLESTAR_*` names warned or fatal under `POLESTAR_STRICT_ENV`
(`src/server.ts:544-553`). There is no config file, no hot reload, and no runtime validation of
`POLESTAR_DELEGATED_ACCOUNT_IDS` entries. The HTTP token has no minimum length or entropy check
and is compared as a plain string (`src/server.ts:422`).

Version copies exist in `package.json:3`, `server.json:9` and `server.json:14`, plus
`docs/releases/v0.3.0.md`. No check reads `server.json`; the tag list is empty.

## What is missing

Ordered by how soon a user or operator would notice.

1. The fail-closed budget rule can be switched off. `POLESTAR_CACHE=off` removes the retry and
   metering adapter from the chain (`src/server.ts:78-79`) while the docs describe the variable as
   a cache toggle only (`docs/getting-started.md:96`, `README.md:196`). Measured: with the cache
   on, two `get_battery` calls made 3 live requests and reported `3/10000 used`; with
   `POLESTAR_CACHE=off`, the same two calls made 5 live requests and reported `0/10000 used`.
   The safety claims in `SECURITY.md:59-60` and `docs/architecture.md:119` are therefore false on
   that configuration. Candidate C1.
2. The daily allowance is per process, not per credential. A second client, a restarted container,
   or a second `npx` invocation starts at zero (`src/server.ts:66-67`, `src/budget.ts:31-41`), so
   the documented 10,000 per client per day can be exceeded by a multiple, and the user sees 429s
   instead of the fail-closed message. Candidate C2.
3. There is no health, readiness, metrics or structured-log signal for an operator, and the
   container is unbuilt and undocumented (measured GET behavior, `Dockerfile:1-17`,
   `.github/workflows/ci.yml:1-38`). Candidate C4 and C6.
4. Loopback HTTP mode accepts cross-origin requests. A POST with `Host: attacker.example` and
   `Origin: http://attacker.example` returned 200 with the full tool list (measured). The SDK
   docs explicitly tell hand-wired `node:http` servers to compose its Host and Origin guards
   (`node_modules/@modelcontextprotocol/node/README.md:52`), and `src/server.ts:421-425` checks
   only the bearer token, which is absent by default on loopback. Candidate C5.
5. "No data" is a normal answer that costs a live call every time. `is-at-charge-location` and
   other absent Domains are never cached (`src/caching-transport.ts:113-115`,
   `src/client.ts:150-152`), so an agent asking about an unreported Domain spends quota on every
   repeat. Candidate C3.
6. Subscriptions can burn quota and lose updates. Unvalidated URIs are accepted, there is no cap,
   overlapping rounds double-notify, and a failed notification is dropped (measured; candidate
   C10). The 90 percent stand-down (`src/subscriptions.ts:93`) is too late for a large fan-out.
7. Cancellation, retry and staleness are unmanaged. A cancelled call keeps spending quota, a
   network blip fails the call outright, an HTTP-date `Retry-After` is ignored, and a stale cache
   entry is served forever when refresh fails (candidates C7, C8, C9).
8. The protocol target is the 2025 era only. Modern clients get a silent downgrade or a 400
   (measured), the elicitation path the code comments describe as multi-round-trip is served on
   the legacy channel (`src/vehicle-read.ts:59-64`, `src/vehicle-read.ts:90-104`), and every
   automated handshake pins `2025-06-18` (candidate C11).
9. Multi-credential and fleet operation are absent. One `Config` carries one client ID, one
   Account ID and one delegated allowlist (`src/config.ts:239-243`, `src/config.ts:288`), and the
   cache and budget cannot distinguish credentials (candidate C12).
10. Operational rough edges with no candidate of their own: `--http` is ignored
    (`scripts/smoke-http.ts:15`, `src/server.ts:490-519`), there is no config check command, no
    `SIGHUP` reload, no `.dockerignore`, no TLS or reverse-proxy recipe, and the HTTP bearer token
    is a shared secret by design (`SECURITY.md:65-73`). A local process that can reach the port
    can still drain the shared budget; the origin guard closes the browser path, not the local
    process path.

### Extension seams, cost and blast radius

| Seam | Cost | What it breaks, and what must change first |
| --- | --- | --- |
| Multi-credential or fleet mode | L | One `Config` becomes a credential registry; each credential needs its own `TokenProvider`, `BudgetMeter`, cache namespace and history root. Tool schemas gain a selector argument, the resource URI space needs the credential in it, and `polestar_status` needs per-credential budget lines. The cache key must include the credential identity (`src/caching-transport.ts:83`), and the VIN identity check is not enough across accounts. Candidate C12. |
| Plugin-style Domain registry | M | The registry is already one list and every derivative reads it (`src/domains.ts`), so a plugin loader adds a runtime extension surface and foreign code at startup. It would also bypass `docs/check-docs.mjs tools`, `npm run verify-fixtures` and the contract test, which all read the in-tree registry. Rejected below. |
| Second data source (consumer app API) | L | The `Transport` seam (`src/transport.ts:18-20`) and a new `TokenProvider` shape are the easy part; the design note already states the cost: unpublished GraphQL documents and destructively rotating refresh tokens that must be persisted atomically (`docs/consumer-adapter-note.md:20-32`). It would need a second fixture story and would sit outside the M2M scope. Rejected for now. |
| OpenAI or ChatGPT connector | L | The web connector needs a public HTTPS remote with real authentication, which is the hosted mode below plus registry listing. Local stdio is not reachable from the browser product. Rejected below. |
| Hosted mode | L | A public listener needs per-user authentication (OAuth 2.1 or equivalent), protected resource metadata (the SDK helpers are exported and unused), a per-user credential vault, per-user budget and cache namespaces, TLS termination, inbound limits and audit logging. Today's model is one owner, one credential, one shared bearer token (`SECURITY.md:65-73`), so hosted mode changes the trust boundary, not just the transport. Rejected below. |

## Candidates

| id | Candidate | User question it answers | Data it reads | Effort | Risk | Falsifiable check it needs |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Decouple metering and retry from the cache toggle | "I turned the cache off for fresh data and now the server never stops at my 10,000 call limit. Why?" | Live attempt count, minute count, existing `BudgetMeter` and `MinuteWindowMeter` | S | Low: chain composition only; a double-metering bug would fail the budget tests | With `POLESTAR_CACHE=off`, the used count equals the stub's request count (five for two reads today) and the limit still throws; a unit test on `buildEngine` proves one meter per attempt |
| C2 | Persistent credential-scoped budget ledger | "I run two clients and my daily count resets. Why did I get 429s before 10,000 calls?" | A local JSON ledger keyed by a hash of client and account id, plus a lock file | M | Medium: lock recovery, shared filesystems, and a fail-closed read path | Two processes, limit 10, six calls each, 11th global call refused; restart preserves the count; unreadable ledger fails closed |
| C3 | Negative caching for absent Domains | "My car does not report this Domain. Why does every question about it spend an API call?" | The 404 `DATA_NOT_AVAILABLE` result and the Domain's negative TTL | S | Low: a short TTL could hide the car starting to report; other 4xx must stay uncached | Counting transport: two reads inside the TTL make one live call; after the TTL, two; 403 and 429 are never stored |
| C4 | Operable packaging: health endpoint, container lifecycle, publish gate | "Is the server up and funded, can the container report healthy, and can I install the version the registry advertises?" | Version, mode, budget snapshot, cache state, token expiry, subscription count; CI metadata | M | Medium: metadata exposure on a non-loopback listener; release credentials in CI | `GET /healthz` returns 200 JSON with those fields and 401 without the token; Docker build and healthcheck run in CI; a version check fails on a package and server.json mismatch |
| C5 | Host and Origin guards for HTTP mode | "Can a web page in my browser reach the loopback server and read my car?" | `Host` and `Origin` headers, the configured allowlist | S | Low: a custom client with an unusual Origin would be refused; requests without Origin must pass | A POST with an attacker Origin and Host gets 403; a request without Origin gets 200; the allowed origin gets 200 |
| C6 | Structured stderr log with a real debug level | "What did the server do at 14:02, and why is POLESTAR_LOG=debug silent?" | One JSON event per attempt and per tool call: path template, status, duration, cache outcome, retry count, budget left | M | Medium: VIN or token leakage into logs; volume | Spawn and call a tool: stderr parses as JSON with those fields, contains no token or VIN; normal level emits no per-call lines; a test scans every log call site |
| C7 | Cancellation-aware reads | "I cancelled the question. Why did the server still spend five calls?" | `ctx.mcpReq.signal`, `TransportRequest`, retry sleep, cache refresh ownership | M | Medium: aborting a shared single-flight refresh would penalize other callers; budget must count only sent attempts | A slow scripted transport, cancel mid-call: the inner fetch aborts, at most one attempt is metered, no cache entry is written; an uncancelled call still succeeds |
| C8 | Retry policy hardening | "Why did the server retry 500 ms after Polestar asked for 30 seconds, and why did one Wi-Fi blip fail my call?" | `retry-after` in both RFC 9110 forms, backoff jitter, network error classification | S | Low: extra attempts spend budget, so cap and meter them | A 429 with an HTTP-date 30 seconds out waits at least the delta; delta-seconds behavior is unchanged; jitter stays in its bound; a network error is retried once |
| C9 | Bound local store growth and staleness | "Why is yesterday's data shown as current, and why do history tools fail with an internal error?" | Cache entry age, history file sizes, record ages | M | Medium: pruning user history; a max-stale verdict could surprise offline users | A refresh that keeps failing past max stale returns an explicit stale verdict, not a silent current answer; a prune command or cap keeps files under the bound and keeps the newest window |
| C10 | Subscription lifecycle hardening | "Why did a typo in a resource URI and a hundred subscriptions drain my budget?" | Parsed URI, VIN shape, subscription count, poll round state, notification outcome | S | Low: a previously accepted URI becomes an error; keep the error actionable | Malformed VIN or unknown Domain returns a JSON-RPC error; the configured cap refuses further subscriptions; overlapping rounds read once and notify once; a failed notify is retried next round |
| C11 | Serve the modern MCP revision and use its channels | "Will this server still work when my client moves to the next MCP revision, and can it show freshness?" | SDK handler factory, `server/discover`, `input_required`, `ttlMs` as cache hints | M | Medium: dual-era drift; multi-round-trip state is client-controlled and must not affect authorization | `server/discover` answers the modern revision over HTTP; a modern `initialize` negotiates it; VIN ambiguity returns `input_required` and completes; legacy smoke runs still pass |
| C12 | Fleet mode: several credentials in one process | "Can one server watch 50 cars across several Data Portal credentials without mixing budgets or data?" | A credential registry, per-credential token, budget, cache namespace and history root, a selector argument | L | High: cross-credential data leakage, secrets at rest, schema growth, per-credential fail-closed | Two credentials, one exhausted, the other still serves; a read for B never returns a cache entry written for A; per-credential budget and audit lines; single-credential behavior unchanged |

### C1. Decouple metering and retry from the cache toggle

Evidence: the chain is assembled with `const inner: Transport = config.fixturesDir ||
config.cacheDisabled ? base : new RetryingTransport(base, { budget, minute })` (`src/server.ts:78-79`).
When the cache is disabled, `CachingTransport` wraps the bare HTTP adapter, so neither
`budget.consume()` nor `minute.consume()` nor the retry loop runs (`src/retrying-transport.ts:56-69`).
Measured with a local stub: cache on, two `get_battery` calls made one token POST, one vehicles GET
and one battery GET, and `polestar_status` reported `3/10000 used`; cache off, the same calls made
one token POST, two vehicles GETs and two battery GETs, and `polestar_status` reported
`0/10000 used`. Docs describe the variable as cache-only (`docs/getting-started.md:96`) and claim
every live attempt is metered (`SECURITY.md:59-60`, `docs/architecture.md:119`).

Design: make the retry and metering layer unconditional in live mode and let the cache be the
optional outer adapter. Fixture mode stays unmetered and un-retried, which is correct because
replays are free. Two lines in `buildEngine()` plus one test on the composed chain.

Risk is low because the layer already exists and is tested in isolation (`test/runtime.test.ts:86-104`);
the only new failure is double counting if the adapters are ever stacked twice, and the existing
budget test catches that. This is the cheapest change in the report with the highest safety payoff.

Falsifiable check: a `buildEngine` test with a scripted live adapter asserts that
`POLESTAR_CACHE=off` still produces one meter unit per attempt and the same `BudgetExceededError`
at the limit; the stub probe in the verification log must print a nonzero used count with the cache
off.

### C2. Persistent credential-scoped budget ledger

Evidence: the meter is memory only (`src/budget.ts:31-41`), built per engine (`src/server.ts:66-67`),
and one engine exists per process (`src/server.ts:555`). Two meters with limit 3 each allowed six
calls (measured). A container restart, a second MCP client, or a second `npx` invocation resets the
count while Polestar's own counter does not. The reset boundary is a fixed UTC midnight
(`src/budget.ts:75-81`) and no quota header is read from the API (`src/transport.ts:63-67`), so a
wrong boundary assumption is invisible until 429s arrive.

Design: a small JSON ledger `{windowStartUtc, used}` written with a temp file and rename under an
operator-selected directory (reuse `POLESTAR_HISTORY_DIR` when set, otherwise
`POLESTAR_STATE_DIR`), keyed by a SHA-256 of client ID and Account ID so the file holds no secret.
A lock directory or `O_EXCL` file serializes updates; a stale lock older than the request deadline
is broken with a warning. Read failure fails closed: start in a refused state with a clear message
rather than at zero. This keeps the read-only posture and the fail-closed rule.

Risk: shared-filesystem semantics and crash recovery are the hard parts; a ledger that fails open
would recreate the current bug, so the read path must refuse. A single-process user sees no change.

Falsifiable check: a test constructs two engines over one temp directory with limit 10, issues six
calls through each, and asserts the eleventh call is refused and the snapshot says 10/10; a second
test corrupts the ledger and asserts startup or the first call fails closed; a restart test asserts
the count survives.

### C3. Negative caching for absent Domains

Evidence: only responses with status below 400 are stored (`src/caching-transport.ts:113-115`), and
`DATA_NOT_AVAILABLE` is a 404 that the client maps to `null` (`src/client.ts:150-152`). Measured
through the real tool path with history enabled so the cache was active: three live misses and zero
entries for two reads of `get_is_at_charge_location`, while a successful Domain read was served
once for three reads. The absence answer is normal and frequent (the brief and
`docs/getting-started.md:124` both say so), so every repeat costs quota.

Design: add a `negativeTtlMs` field to the Domain row, short by default (for example 60 seconds),
and teach `CachingTransport` to store a 404 whose body carries `DATA_NOT_AVAILABLE` for that TTL.
Keep the decision in the registry so a new Domain states its own negative freshness, matching the
existing `ttlMs` discipline (`src/domains.ts:20-30`). Never cache any other 4xx, and never cache a
403 from a scope or delegation failure.

Risk: a car that starts reporting a Domain stays invisible for the negative TTL. A 60 second window
bounds that, and the answer already carries an age line, so the user sees the age. The alternative
of caching nothing preserves the quota waste.

Falsifiable check: a counting transport, two reads of an absent Domain inside the TTL, one inner
call; advance the clock past the TTL, two inner calls; a 403 and a 429 are never stored; the
existing runtime cache tests still pass.

### C4. Operable packaging: health endpoint, container lifecycle, publish gate

Evidence: no health path exists. Measured: `GET /` without an SSE accept returns 406; with an SSE
accept it returns 200 and holds the stream open, so a health probe hangs; `HEAD /` returns 405. The
Dockerfile has no `USER` and no `HEALTHCHECK` (`Dockerfile:1-17`), is not built by CI
(`.github/workflows/ci.yml:1-38`), has no `.dockerignore`, and is not documented anywhere. `npm pack
--dry-run` reports a 120,059 byte tarball (436,330 unpacked), so distribution itself is small. The
registry manifest carries the version twice (`server.json:9`, `server.json:14`) and nothing checks
it, while `docs/development.md:126` claims one version number.

Design: reserve `GET /healthz` ahead of the MCP transport and answer JSON with `ok`, version, mode,
budget used and limit, cache enabled, token expiry in seconds, and subscription count. No VIN, no
coordinates, no token value. Gate it with the same bearer check when a token is set. Add a second
`GET /readyz` only if the hosted mode lands, since readiness is the same answer today. In the
container: run as the `node` user, add a `HEALTHCHECK` that calls `/healthz`, add `.dockerignore`,
and document `docker run` next to the stdio instructions. In CI: build the image on pull requests,
run the stdio smoke inside it, add a tag-triggered release job that publishes the npm package with
provenance and pushes the image, and add a `versions` doc check that fails when `package.json`,
`server.json` and the newest `docs/releases/` file disagree.

Risk: a health endpoint on a non-loopback bind leaks budget and token metadata unless it is gated
by the same bearer token; reuse `decideBind()` and the existing 401 body so the rule stays in one
place (`src/bind.ts:21-48`). Release automation introduces CI secrets; start with the version gate
and the image build, which need no secrets, before the publish step.

Falsifiable check: `scripts/smoke-http.ts` asserts `GET /healthz` is 200 JSON with the fields and
401 without the token; a Docker build and `HEALTHCHECK` run in CI; `node docs/check-docs.mjs
versions` fails on a deliberately wrong `server.json` version (positive control) and passes after
the bump.

### C5. Host and Origin guards for HTTP mode

Evidence: a POST with `Host: attacker.example` and `Origin: http://attacker.example` to a loopback
server with no token returned 200 and the full `tools/list` payload (measured). `serveHttp` checks
only `req.headers.authorization !== "Bearer ${token}"` (`src/server.ts:422`), and the token is
empty by default on loopback. The SDK documents the exact risk and the guards for it: plain
`node:http` should compose `localhostHostValidation` and `localhostOriginValidation`
(`node_modules/@modelcontextprotocol/node/README.md:52`, `node_modules/@modelcontextprotocol/node/dist/index.mjs:20-75`).
No test covers this; `test/server-seams.test.ts:18-58` tests only `decideBind`.

Design: when `decideBind` returns a loopback host, reject a `Host` outside the loopback set and an
`Origin` outside the loopback set, using the SDK guards (the Origin guard already lets requests
without an Origin through, which non-browser clients rely on). For a non-loopback bind, take the
allowed hostnames and origins from new `POLESTAR_HTTP_ALLOWED_HOSTS` and
`POLESTAR_HTTP_ALLOWED_ORIGINS` variables and document defaults that match "behind a reverse proxy".
Reject before the transport reads the body, with a 403 in the same JSON-RPC error shape the
transport already returns.

Risk: a legitimate client that sends a custom Origin would be refused until it is allowlisted. That
is the correct default for a server that reads location; the allowlist is one variable away.

Falsifiable check: a request with an attacker Origin and Host gets 403; the same request without an
Origin gets 200; an allowlisted origin gets 200; the `decideBind` tests keep passing; a spawn test
asserts the 403 body shape.

### C6. Structured stderr log with a real debug level

Evidence: the only logger is `console.error("[polestar-mcp] ${message}")` (`src/server.ts:62-65`),
used for startup, the refresh warning, HTTP failures and shutdown. There is no per-request or
per-attempt line, no duration, no status, no cache outcome, and no budget figure after startup.
`POLESTAR_LOG=debug` gates one line (`src/server.ts:562-567`) and the config comment admits nothing
else reads it (`src/config.ts:44`), while the docs promise verbose diagnostics
(`docs/getting-started.md:105`). `grep -rn "sendLoggingMessage" src/` is empty, so the declared MCP
logging capability is inert (`src/server.ts:215`); the SDK deprecates that channel for the modern
revision, so stderr is the durable target.

Design: one `logEvent(level, event, fields)` helper that writes one JSON line to stderr, with a
closed field set per event: `mode`, `method` or `path_template`, `status`, `duration_ms`,
`cache` (hit, stale, miss, refresh), `attempt`, `budget_used`, `request_id`. A path template is
`telemetry/battery`, never the VIN. Levels `debug`, `info`, `warn`, `error`, `off`; default `info`
keeps startup and warnings only, so current behavior is preserved. Add `POLESTAR_LOG_LEVEL` beside
`POLESTAR_LOG=debug` for compatibility. Do not log tokens, authorization headers, coordinates, or
raw payloads, and extend the existing token-in-logs test (`test/runtime.test.ts:300-320`) to scan
the structured fields.

Risk: log volume under a sampler or subscription fan-out. Debug level is opt-in, and the default
stays quiet. The privacy risk is the real one; a test that greps emitted lines for the token, a
VIN-shaped string and a coordinate shape is the control the house rules require.

Falsifiable check: spawn the server, call `get_battery`, capture stderr, parse each line as JSON,
assert the attempt event carries path template, status, duration and budget; assert no line
contains the token or a VIN; with the default level assert no attempt lines appear.

### C7. Cancellation-aware reads

Evidence: the SDK hands every handler an `AbortSignal` at `ctx.mcpReq.signal`
(`node_modules/@modelcontextprotocol/server/dist/mcp-BCJHyo7l.d.mts:2181-2182`). The project's
`ToolContext` declares only `sessionId`, `elicitInput` and `inputResponses`
(`src/tool-output.ts:188-194`), `TransportRequest` has no signal field (`src/transport.ts:5-9`), and
`HttpTransport` only applies `AbortSignal.timeout` (`src/transport.ts:43-46`). A client
`notifications/cancelled` therefore stops nothing: the tool runs to completion, the retry loop
keeps sleeping, the cache refresh continues, and the budget is spent for an answer nobody reads.
`grep -rn "signal" src/` finds only the timeout and unrelated words.

Design: add `signal?: AbortSignal` to `TransportRequest`; combine it with the per-request timeout
using `AbortSignal.any`; thread the context signal from `ToolSpec.run` through `readDomain` and
`PolestarClient.domain()` into the transport. Map an aborted request to a new minted code
(`CANCELLED`) with an honest hint, add it to the closed list in `src/failure.ts:22-39` and the hint
table in `src/tool-output.ts:107-124`. Stop the retry sleep when the signal aborts. In
`CachingTransport`, do not abort a refresh that other callers share; a cancelled caller stops
waiting, while the single-flight promise finishes for the others, and budget counts only attempts
actually sent.

Risk: a shared refresh aborted on behalf of one caller would hurt concurrent callers; the refcount
or "abort only the waiter" rule is the design work. Cache poisoning is avoided because a cancelled
attempt either completed or did not store.

Falsifiable check: a scripted transport that never resolves, cancel the request, assert the inner
fetch received an abort, at most one attempt was metered, and no entry was written; a second caller
that did not cancel still receives the value.

### C8. Retry policy hardening

Evidence: `retryAfterHeaderMs` parses only a number (`src/retrying-transport.ts:88-93`), so an
HTTP-date `Retry-After` becomes `undefined` and the code falls back to 500 ms. Measured: a 429 with
a date 30 seconds out produced `waits=[500]`. The backoff has no jitter
(`src/retrying-transport.ts:76`), and network failures are not retried (`src/transport.ts:50-62`,
`docs/architecture.md:112`). A home connection blip fails the tool call outright, and multiple
processes retry in lockstep against a rate-limited endpoint.

Design: parse both RFC 9110 forms, treating a date as the parsed instant minus the current clock,
clamped at zero; apply full jitter to the computed exponential wait while still honouring a server-supplied
`Retry-After` exactly; retry `TransportError` with `causeKind: 'network'` once within the total
deadline, since every read is an idempotent GET. Every attempt continues to go through
`budget.consume()` and `minute.consume()` (`src/retrying-transport.ts:56-69`), so a fail-closed
budget still wins.

Risk: an extra attempt per network failure spends one more unit of quota; the retry cap and the
deadline bound it, and a 429 or exhausted budget still short-circuits.

Falsifiable check: a scripted 429 with an HTTP-date header waits at least the delta; the existing
numeric-header test still passes (`test/runtime.test.ts:106-124`); jitter output stays in
`[0.5x, 1.5x]` of the base; a network error is attempted twice and then surfaced.

### C9. Bound local store growth and staleness

Evidence: once an entry expires, the cache serves it immediately while refreshing
(`src/caching-transport.ts:92-100`); if the refresh keeps failing (budget exhausted, network down),
the stale entry is served indefinitely and the only signal is a stderr line
(`src/server.ts:81-85`). There is no maximum stale age and no way to ask for a blocking refresh:
the read arguments are `vin`, `raw` and `delegated_account_id` only (`src/tool-output.ts:23-48`).
History is append-only JSONL with a 64 MiB read refusal and no rotation or prune
(`src/history.ts:5`, `src/history.ts:41-78`); queries parse the whole file synchronously on the
event loop (`src/history.ts:64-73`). At the default sampler cadence a vehicle writes 576 samples per
day (`src/sampler.ts:18-21`, `src/domains.ts:70-173`), so the 64 MiB cliff is distant but the
whole-file read cost is not.

Design: add a per-Domain or global `maxStaleMs`; when an entry is older than that and refresh is
failing, return an explicit stale failure (new minted code `DATA_STALE`, with the age and the
reason) instead of presenting the value as current. Add a `fresh: true` read argument that waits on
one revalidation, single-flight with any concurrent refresh, and surfaces `BudgetExceededError`
honestly. For history, add `POLESTAR_HISTORY_MAX_BYTES` and `POLESTAR_HISTORY_MAX_AGE_DAYS`, prune
the oldest lines when a file crosses the bound (atomic rewrite), and bound query reads with a
newest-window scan rather than loading the file. Pruning stays an operator action (startup or a
documented CLI step), so no tool gains a write path.

Risk: a max-stale verdict can surprise a user who prefers old data; make it a failure with the age
and an explanation, not a silent drop. Pruning deletes data, so default it off or keep the newest
window explicit.

Falsifiable check: a cache with a failing refresh past `maxStaleMs` returns the stale code and the
age; `fresh: true` makes exactly one live attempt and then returns; a history test appends past the
byte cap and asserts the file stays under it while the newest records survive; the existing history
tests pass.

### C10. Subscription lifecycle hardening

Evidence: `resources/subscribe` accepted `polestar://vehicle/not-a-vin/telemetry/battery` and an
unknown Domain with an empty result (measured). `parseResourceUri` checks the registry but not the
VIN shape (`src/domains.ts:404-423`) and `client.domain()` sends the VIN without validating it
(`src/client.ts:136-148`), so a typo becomes a live request every 60 seconds. There is no cap on
`lastEventId` (`src/subscriptions.ts:39`), and the 90 percent budget stand-down
(`src/subscriptions.ts:93`) arrives after a large fan-out has already spent the allowance. Two
overlapping `pollOnce` calls both notified for one change (measured), and a rejected notify lost
the change permanently because the new id is stored before the send
(`src/subscriptions.ts:105-108`; measured one attempt, no retry).

Design: validate in the `resources/subscribe` handler before any read: `parseResourceUri` plus the
VIN regex (move `VIN_RE` from `src/client.ts:7` into `src/domains.ts` so there is one author), and
return a JSON-RPC error for anything outside the registry or the VIN alphabet. Add
`POLESTAR_MAX_SUBSCRIPTIONS` with a documented default and a clear error. Add a `running` guard to
the poller like the sampler's (`src/sampler.ts:57-59`). Move the id update after a successful
notify, or keep a pending id that the next round retries, so a transient failure does not lose the
change. Report the subscription count in `polestar_status` so the operator can see the fan-out.

Risk: a URI that used to be accepted now errors. That is the point, and the error can name the
registry and the VIN rule. The cap must be configurable so a legitimate fleet use can raise it.

Falsifiable check: the two malformed URIs get a JSON-RPC error and no poller target; the cap
refuses the next subscription with an actionable message; two concurrent `pollOnce` calls read once
and notify once; a rejected notify is retried on the next round.

### C11. Serve the modern MCP revision and use its channels

Evidence: the installed SDK is v2, implements the 2026-07-28 revision
(`node_modules/@modelcontextprotocol/server/README.md:5`). The server package exports
`createMcpHandler`, `PerRequestHTTPServerTransport`, `inputRequired`, `inputResponse`,
`createRequestStateCodec` and `buildOAuthProtectedResourceMetadata`; the node package exports
`localhostHostValidation`, `localhostOriginValidation` and `toNodeHandler`
(`node_modules/@modelcontextprotocol/node/README.md:20-27`).
This server wires `NodeStreamableHTTPServerTransport` and `McpServer.connect` by hand
(`src/server.ts:432-438`), which serves the 2025 era only: measured `initialize` for `2026-07-28`
downgrades to `2025-11-25`, and `server/discover` is rejected with HTTP 400. The code and docs
already describe the modern flow: `src/vehicle-read.ts:59-64` says the server can ask on the
2026-07-28 multi-round-trip path and calls `elicitInput()` deprecated, but the negotiated revision
is legacy, so the elicitation channel is what actually runs (`src/vehicle-read.ts:90-104`). Every
smoke client pins `2025-06-18` (`scripts/stdio-client.ts:85`, `scripts/smoke-http.ts:59`,
`scripts/smoke-bin.ts:51`), so even the negotiated latest version is untested.

Design: replace the hand-wired HTTP composition with `toNodeHandler(createMcpHandler(() =>
createMcpServer(engine, { subscriptions: false })))`, keeping the existing bearer check in front
and adding the Host and Origin guards from C5. The factory already has the right shape, one surface
per request over one shared engine, so the stateless design carries over. Keep the legacy fallback
for current clients and pin it in the smoke runs. Convert VIN ambiguity to `inputRequired` on the
modern path while leaving `elicitInput()` for the legacy path, since the existing code already
reads `inputResponses` (`src/vehicle-read.ts:82`). Attach the Domain `ttlMs` as a cache hint on
resource reads and tool results once the modern path is live.

Risk: two eras means two behaviors to test, and multi-round-trip state is client-controlled. This
server's authorization does not depend on request state (the delegation allowlist is config and the
VIN is revalidated), so the integrity requirement is satisfiable; a test must still prove it. The
payoff is future compatibility plus one real channel (input_required), not new data.

Falsifiable check: `server/discover` answers the modern revision over HTTP; a modern `initialize`
negotiates it; an ambiguous VIN returns an `input_required` result that completes on the retry;
the legacy stdio and HTTP smoke runs still pass unchanged.

### C12. Fleet mode: several credentials in one process

Evidence: one `Config` holds one client ID, one secret, one Account ID, one delegated default and
one allowlist (`src/config.ts:239-243`, `src/config.ts:288`); one `TokenProvider`, one
`BudgetMeter` and one `PolestarClient` are built from it (`src/server.ts:66-114`). The cache key is
the URL alone (`src/caching-transport.ts:83`), so two credentials reading the same VIN would share
an entry, and the budget cannot attribute spend to a credential. Delegation is already a per-call
header on a cloned client (`src/client.ts:85-88`), which is the closest existing seam.

Design: a credential registry loaded from a new `POLESTAR_CREDENTIALS_FILE` (JSON list of id,
client ID, secret, Account ID, delegated allowlist, optional history root), an `Engine` per
credential, and a `credential` argument on every read tool that defaults to the sole credential.
Cache keys and history roots include the credential id; each credential carries its own
`BudgetMeter` and sampler, and one exhausted credential never blocks another. `polestar_status`
reports per-credential lines, and every read result names the credential the same way it names the
VIN.

Risk is the highest in this report: cross-credential exposure is exactly the failure the project
refuses to commit for VINs (`src/client.ts:215-248`, `SECURITY.md:16-19`), so the cache namespace
and the identity assertions must be tested with two credentials, not assumed. Secrets move from a
dotenv file to a JSON file that needs the same 0600 check (`src/server.ts:531-538`). Tool schemas
grow one argument, resources need a credential segment in the URI, and the fail-closed rule must
hold per credential.

Falsifiable check: a two-credential engine with separate stub transports, one credential exhausted,
the other still serves; a read for B after A cached the same path fetches from B (namespace
assertion); the cache and budget snapshots are per credential; a single-credential run is byte for
byte the current behavior.

## Rejected ideas

- **MCP sampling.** The server asks the client's model for a completion. Nothing here needs an LLM:
  the planner, the charge model and the humanizer are deterministic, and a sampling call would add
  latency and a privacy question for every answer. Rejected as decoration.
- **MCP tasks and `tasks/*`.** All work is one request bounded by a 15 second deadline
  (`src/retrying-transport.ts:45`), so there is nothing to resume. Tasks would add a state machine
  and a second cancellation surface for no user question. Rejected as decoration.
- **MCP logging notifications as the observability answer.** The capability is declared but inert
  (`src/server.ts:215`), and the SDK deprecates the channel for the modern revision in favour of
  stderr or OpenTelemetry (type comment on `ServerContext.mcpReq.log` in the SDK). Investing in
  `notifications/message` would build on a retiring channel; C6 writes stderr instead.
- **Progress notifications.** No call is long enough to need a progress bar, and the aggregate
  tools fan out concurrently, so a progress token would report noise. Rejected as decoration.
- **A Prometheus metrics endpoint now.** Budget and cache counters already reach the agent through
  `polestar_status` (`src/system-tools.ts:27-68`); an operator endpoint matters only once the server
  is hosted or fleet-run. Folded into C4 as a JSON health payload and deferred as metrics.
- **OAuth protected resource metadata now.** Measured: the 401 carries only `www-authenticate:
  Bearer`, and `/.well-known/oauth-protected-resource` serves no metadata. Publishing RFC 9728
  metadata without a real authorization server would describe an auth flow that does not exist.
  Rejected until a hosted mode is approved; the SDK helpers are ready when it is.
- **Persistent HTTP sessions so subscriptions work over HTTP.** It would trade the stateless
  design (`src/server.ts:426-437`) for session storage, a reaper and a shared notification fan-out,
  while subscriptions are already a stdio feature and docs say so (`docs/architecture.md:63`).
  Rejected: it contradicts the mode's whole shape for a feature stdio already provides.
- **A plugin style Domain registry.** The registry is already the single author of routes, scopes,
  TTLs, sampling and fixture keys (`src/domains.ts:1-47`), and the doc check, fixture verifier and
  contract test all read it. A loader would add foreign code at startup and let those checks drift.
  Rejected: the existing one-row extension is the cheaper and safer seam.
- **The consumer app API as a second data source now.** The design note documents the two blockers,
  unpublished queries and destructively rotating refresh tokens (`docs/consumer-adapter-note.md:20-32`),
  and `test/posture.test.ts` holds the boundary. Rejected for this round; revisit only if Polestar
  publishes the contract.
- **An OpenAI or ChatGPT connector now.** The browser product needs a public HTTPS remote with
  real authentication, which is the hosted mode below plus registry listing. Rejected: it is a
  deployment project, not a feature, and it would move the credential off the owner's machine.
- **Hosted multi-tenant mode now.** One shared bearer token for one owner (`SECURITY.md:65-73`),
  one credential, one budget, no per-user vault, no audit trail, no TLS termination. Hosting it
  would change the trust boundary and break the privacy posture before it produces a user benefit.
  Rejected until C1, C2, C4, C5 and C12 exist, and then only with the security seat's sign-off.
- **Caching all error responses.** A 403 scope failure or a 429 is transient or identity-specific;
  caching them would freeze a wrong answer. Only `DATA_NOT_AVAILABLE` is safe to cache, and only
  per C3.
- **Namespacing the cache by credential as a standalone fix.** With one credential today there is
  no leak; the URL-only key (`src/caching-transport.ts:83`) is a hazard only when C12 exists, and
  the change belongs with C12 rather than as a speculative patch.

## Verification log

Every command below was run from the repository root. Output is trimmed to the lines that carry the
claim.

1. Protocol negotiation and surface, stdio fixture mode. A throwaway probe under
   `/tmp/polestar-probe/probe-stdio.mjs` spawns `node --import tsx src/server.ts` with
   `POLESTAR_FIXTURES_DIR=test/fixtures/dump` and prints raw JSON-RPC results.
   Observed: `"protocolVersion": "2025-11-25"` for an `initialize` asking `2025-11-25`;
   `"protocolVersion": "2025-11-25"` for an `initialize` asking `2026-07-28`;
   `server/discover` returns `"code": -32601`; capabilities are
   `resources {subscribe, listChanged}, logging, tools {listChanged}, completions, prompts {listChanged}`.
2. HTTP mode, reproducible with curl. The server is started with
   `POLESTAR_HTTP_PORT=18507 POLESTAR_FIXTURES_DIR=test/fixtures/dump node build/server.js`.
   Observed:
   ```
   evil Host+Origin tools/list -> status=200
   initialize 2026-07-28 -> {"protocolVersion":"2025-11-25", ...}
   server/discover with mcp-protocol-version 2026-07-28 -> status=400
   GET / -> status=406
   GET /healthz with SSE accept -> status=200 time=2.002524 (held open)
   well-known oauth-protected-resource -> status=406
   ```
   The 400 body reads: `Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25,
   2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)`.
3. Budget metering and the cache toggle, against a local stub HTTP server that answers the token,
   vehicles and battery routes. A throwaway probe under
   `/tmp/polestar-probe/probe-cache-off-budget2.mjs` starts the server in live mode with
   `POLESTAR_BASE_URL` pointed at the stub, `POLESTAR_M2M_TOKEN_ENDPOINT` pointed at the stub,
   `POLESTAR_ENV_FILE=/nonexistent` so no real secrets file loads, and dummy credentials. It calls
   `get_battery` twice and then `polestar_status`.
   Observed:
   ```
   cache on  -> API budget: 3/10000 used; stub hits token=1 vehicles=1 battery=1
   cache off -> API budget: 0/10000 used; stub hits token=1 vehicles=2 battery=2
   ```
4. Negative caching, one-liner:
   ```
   node --import tsx --input-type=module -e "import {CachingTransport} from './src/caching-transport.ts'; let n=0; const t=new CachingTransport({fetch:async()=>{n++;return{status:404,body:'{\"error\":{\"code\":\"DATA_NOT_AVAILABLE\"}}'}}}); const u='https://x/e/vehicles/V/telemetry/is-at-charge-location'; await t.fetch(u); await t.fetch(u); console.log('inner_calls='+n)"
   ```
   Observed: `inner_calls=2`. The same command with a 200 body observed `inner_calls=1` for three
   reads.
5. Negative caching through the real tool path, fixture mode with `POLESTAR_HISTORY_DIR` set so the
   cache is active, two calls to `get_is_at_charge_location` then `polestar_status`.
   Observed: `Cache: 1 hits + 0 stale-served of 4 reads (25%), 3 live misses, 3 refreshes, 1 entries`.
6. Retry-After date form, one-liner:
   ```
   node --import tsx --input-type=module -e "import {RetryingTransport} from './src/retrying-transport.ts'; const s=[]; const t=new RetryingTransport({fetch:async()=>({status:429,body:'{}',headers:{'retry-after':new Date(Date.now()+30000).toUTCString()}})},{sleep:async ms=>s.push(ms),maxAttempts:2,now:()=>0}); await t.fetch('https://x'); console.log('waits='+JSON.stringify(s))"
   ```
   Observed: `waits=[500]`.
7. Two in-memory budget meters, one-liner:
   ```
   node --import tsx --input-type=module -e "import {BudgetMeter} from './src/budget.ts'; const a=new BudgetMeter(3),b=new BudgetMeter(3); for(let i=0;i<3;i++){a.consume();b.consume()} let t=0; try{a.consume()}catch{t++} try{b.consume()}catch{t++} console.log('thrown='+t+' (each process allowed 3, combined 6)')"
   ```
   Observed: `thrown=2 (each process allowed 3, combined 6)`.
8. Subscriptions, stdio probe. Observed: `resources/subscribe` with
   `polestar://vehicle/not-a-vin/telemetry/battery` returns `{}` and with
   `polestar://vehicle/YSMTEST22PL000001/telemetry/not-a-domain` returns `{}`; the valid URI also
   returns `{}`. `completion/complete` for the resource template returns `["battery"]`; for the
   `car-status` prompt argument `vin` it returns `[]`.
9. Subscription reliability, direct module probe under
   `/tmp/polestar-probe/probe-subscriptions-reliability.mjs`. Observed:
   `{"rejected_notify":{"reads":3,"notify_attempts":1,"retried":false}}` and
   `{"overlapping_rounds":{"reads":3,"notifies":2}}`.
10. Hygiene, tree-wide: `node docs/check-docs.mjs hygiene` exits 1, and the failure is in another
    agent's untracked file, not this report. Latest observed output:
    ```
    EMDASH_CHECK_FAILED:
      analysis/correctness/findings.md lines 1, 43, 71, 87, 113, ...
    ```
    The analysis tree is being written concurrently by the other lanes, so the failing file changes
    between runs; an earlier run failed on `analysis/surface/findings.md` and
    `analysis/surface/evidence/tools-list.json`. The same detectors (em dash, spaced en dash,
    marketing vocabulary, decorative banners, spaced-hyphen connector) run against
    `analysis/C-platform.md` alone report no hit: `{emdash_lines: [], spaced_hyphen_lines: []}` and
    no buzzword match.
11. Packaging facts: `npm pack --dry-run --json` reports `"size": 120059, "unpackedSize": 436330`;
    `git tag -l` prints nothing; `grep -rn "server.json" scripts/ test/ docs/ .github/ package.json`
    prints nothing.
12. Logging facts: `grep -rn "sendLoggingMessage\|performance\.\|histogram\|metrics" src/` prints
    nothing; `grep -rn "console\." src/` prints only `src/server.ts` call sites.
13. Payload sizes for the growth estimate: `wc -c` on the four sampled fixtures prints 852
    (battery), 935 (exterior), 555 (odometer), 491 (location) bytes.

The council should re-run the one-liners and the stub probe before scoring C1, C2, C3 and C8; they
are the four claims with measured counter-evidence in this report.
