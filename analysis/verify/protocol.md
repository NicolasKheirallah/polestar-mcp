# Lane C: protocol conformance and transport robustness

Verification of the MCP protocol surface and the transport layer of `polestar-mcp` at
baseline commit `098b8c3` on `master`. All probes ran offline: fixture mode
(`POLESTAR_FIXTURES_DIR=test/fixtures/dump`) plus loopback HTTP mocks used as the upstream Data
Portal and token endpoint. The live Polestar API was never contacted. The shared checkout was not
rebuilt; the server ran from source through `tsx`, the same entry point `npm run dev` uses.

Node v22.23.2, `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2,
`@modelcontextprotocol/core` 2.4.0.

## Verdict

| Area | Checks | PASS | FAIL | Observations |
| --- | --- | --- | --- | --- |
| stdio conformance and error codes | 18 | 16 | 2 | 3 |
| Resources and subscriptions | 23 | 21 | 1 | 1 |
| HTTP and Streamable HTTP, both eras | 38 | 37 | 0 | 2 |
| Upstream fault injection | 14 | 14 | 0 | 0 |
| Elicitation on a multi-vehicle dump | 9 | 9 | 0 | 0 |
| Total | 102 | 97 | 3 | 6 |

Four defects were found: three failed probe checks (D1, D2, D3) and one documentation defect
(D4) found by comparing behaviour with the shipped docs. D4 is already resolved in the
uncommitted working tree by a concurrent edit; see the note under D4. Six behaviours are
recorded as observations, not defects, because the current docs and tests either intend them or
do not claim otherwise. Two are table rows (O3, O4), so 102 check rows are 97 PASS, 3 FAIL and 2
observation rows; the other four observations are notes on passing checks.

## Defects

### D1: A malformed JSON line on stdio gets no reply and no diagnostic

Severity: Medium. Conformance.

Repro:

```bash
cd /Users/nicolaskheirallah/Documents/GitHub/polestar-mcp
node --import tsx /tmp/protocol-lane/diag-parse.mjs
```

The probe initializes a real stdio server in fixture mode, then writes the literal line
`{"jsonrpc":"2.0","id":900,"method":"tools/list"` (the terminating `}` is missing).

Observed:

```text
AFTER MALFORMED: []
AFTER UNKNOWN METHOD: [{"jsonrpc":"2.0","id":903,"error":{"code":-32601,"message":"Method not found"}}]
STDERR TAIL: "[polestar-mcp] fixture mode ... ready: 26 tools over 15 domains ..."
```

No JSON-RPC response, no stderr line, and the session still answers later requests. Repeated on a
2024-11-05 session with the same result: no reply, no parse diagnostic in stderr
(`/tmp/protocol-lane/final-check.mjs`).

Expected: JSON-RPC 2.0 section 5 requires a Parse error response with code `-32700` and `id: null`
when a message is not valid JSON, and the MCP base protocol requires all messages to follow
JSON-RPC 2.0. A client that sends one bad line currently gets nothing to react to.

Cause: the stdio transport's `ReadBuffer` throws on the line, `processReadBuffer()` catches the
throw and calls `onerror` without writing a response
(`node_modules/@modelcontextprotocol/server/dist/stdio.mjs`, the `processReadBuffer` loop). The
server attaches no `onerror` handler at `src/server.ts:863`, so the throw is silent.

Suggested fix: attach `onerror` to `StdioServerTransport` and emit the `-32700` response plus one
stderr line, or adopt the SDK release that does this. The fix belongs in the repo's transport
wiring because the SDK deliberately reports the error instead of answering.

### D2: JSON-RPC batches are silently dropped on every revision, including revisions that support batching

Severity: Low. Conformance, legacy clients.

Repro:

```bash
node --import tsx /tmp/protocol-lane/diag-batch-era.mjs
```

The probe initializes on each revision, then writes
`[{"jsonrpc":"2.0","id":41,"method":"ping"},{"jsonrpc":"2.0","id":42,"method":"tools/list"}]`.

Observed:

```text
2024-11-05 batch replies: []
2025-03-26 batch replies: []
2025-06-18 batch replies: []
```

Every revision negotiates successfully and then ignores the batch entirely; the session survives.

Expected: JSON-RPC 2.0 defines batch requests, and MCP 2024-11-05 and 2025-03-26 inherit it. The
server advertises and echoes those revisions, so a client batching on them is entitled to one
reply per request or one batch array. MCP 2025-06-18 removed batching, so for that revision an
explicit invalid-request error is the useful answer; silence is not.

Cause: the same stdio `ReadBuffer` path as D1, which only accepts a single JSON-RPC object per
line, and the HTTP path is not the issue here. Fix route is the same: an `onerror` bridge that
answers `-32600` for an array (or implements batching for the legacy revisions).

### D3: Malformed percent-encoding in `resources/read` returns internal error `-32603` instead of invalid params `-32602`

Severity: Low. Error classification.

Repro:

```bash
node --import tsx /tmp/protocol-lane/diag-resources.mjs
```

Request: `resources/read` with `{"uri":"polestar://vehicle/%E0%A4%A/telemetry/battery"}`.

Observed:

```text
malformed percent {"error":{"code":-32603,"message":"URI malformed"}}
```

The same class of input on the subscription path is classified correctly and with a useful
message (`resources/subscribe` on the same malformed escape returns `-32602`). The server survives
either way.

Expected: a malformed percent escape is client input, so `-32602` Invalid params. `-32603`
Internal error tells a client the server broke and invites a retry of the same bad request.

Cause: the SDK's URI-template matcher decodes the URI segment before the repo handler runs
(`src/server.ts:450-452` registers the template); `decodeURIComponent` throws `URIError` and
the SDK maps it to internal error. The repo's own resource-path parser already handles this case
deliberately and returns undefined so the subscription path can answer invalid params
(`src/domains.ts:426-429`).

Suggested fix: pre-validate the percent escapes at the resource handler boundary, or upgrade the
SDK when it classifies template-match failures as invalid params.

### D4: The docs claimed three prompts on every start; a default start registers two

Severity: Low. Documentation and bundle checklist.

Status: already fixed in the uncommitted working tree while this verification ran. Baseline
`098b8c3` is the state reported here; the fix is listed so it is kept and covered.

Baseline claim locations: `README.md:156`, `docs/tools-reference.md:129`,
`docs/architecture.md:21`, `docs/reviewer-pack.md:33`, `docs/bundle.md:37`. The bundle manifest
sets only the four credential and location variables (`mcpb/manifest.json:36-41`) and no history
directory, so the bundle path can never show the third prompt described by its own checklist.

Observed on baseline, default fixture mode:

```text
prompts/list => ["car-status","charge-plan"]
```

With `POLESTAR_HISTORY_DIR` set, the same command returns three, because
`battery-health-report` is built only with the history store (`src/server.ts:536` and
`src/server.ts:570`; `scripts/smoke.ts:158` asserts three because that run enables history).

Expected: the docs qualify the count, or the bundle enables the history store. The current
working tree does qualify it: README, tools-reference, architecture, reviewer-pack and bundle now
say two by default and three with history. Keep that change, and consider whether the bundle
should ship a history directory so its checklist step 6 matches what the user sees.

## Check evidence

Command column uses the probe file name; every probe is run from the repo root as
`node --import tsx /tmp/protocol-lane/<file>`. Fixture mode means
`POLESTAR_FIXTURES_DIR=test/fixtures/dump`; mock means the child was pointed at a loopback mock
through `POLESTAR_BASE_URL` and `POLESTAR_M2M_TOKEN_ENDPOINT` with dummy credentials.

### 1. stdio conformance and error codes

| # | Check | Command | Observed | Status |
| --- | --- | --- | --- | --- |
| 1 | initialize 2024-11-05 | `stdio-conformance.mjs` | echoes `2024-11-05`, serverInfo polestar-mcp 0.3.0, `resources.subscribe` true | PASS |
| 2 | initialize 2025-03-26 | `stdio-conformance.mjs` | echoes `2025-03-26`, same serverInfo and capabilities | PASS |
| 3 | initialize 2025-06-18 | `stdio-conformance.mjs` | echoes `2025-06-18`, same serverInfo and capabilities | PASS |
| 4 | ping on all three revisions | `stdio-conformance.mjs` | empty result on each | PASS |
| 5 | notifications/initialized | `diag-initialized.mjs` | no reply, then ping returns `{}` | PASS |
| 6 | tools/list on all three revisions | `stdio-conformance.mjs` | 26 tools on each | PASS |
| 7 | resources/list | `stdio-conformance.mjs` | 15 resources | PASS |
| 8 | resources/templates/list | `stdio-conformance.mjs` | 2 templates (telemetry and charging) | PASS |
| 9 | resources/read concrete URI | `stdio-conformance.mjs` | text content returned | PASS |
| 10 | prompts/list, default start | `stdio-conformance.mjs` | `car-status`, `charge-plan` (see D4) | PASS |
| 11 | prompts/get car-status | `stdio-conformance.mjs` | one message, VIN argument present | PASS |
| 12 | unknown method | `stdio-conformance.mjs` | `-32601 Method not found` | PASS |
| 13 | unknown tool | `stdio-conformance.mjs` | `-32602 Tool no_such_tool not found` | PASS |
| 14 | malformed JSON line | `diag-parse.mjs`, `final-check.mjs` | no reply, no stderr, server survives (D1) | FAIL |
| 15 | response to an unknown request id | `stdio-conformance.mjs` | ignored, ping still answered | PASS |
| 16 | request without an id | `diag-noid.mjs` | no reply, treated as a notification | PASS |
| 17 | JSON-RPC batch | `diag-batch-era.mjs` | no reply on 2024-11-05, 2025-03-26 or 2025-06-18 (D2) | FAIL |
| 18 | tool call aborted by notifications/cancelled | `stdio-conformance.mjs` | no response for the cancelled id, ping answered afterwards, upstream attempt already sent | PASS |

Observed cancellation detail: the mock received one data request and the cancelled call produced
no JSON-RPC response within 6 s. MCP requires no response for a cancelled request, so that part is
correct; the in-flight upstream read is not aborted. See observation O5.

Request before initialize (observation O1): a `tools/list` sent as the first message is answered
with 26 tools instead of being refused. An `initialize` afterwards still succeeds. Also observed:
initialize with an unsupported revision (`1999-01-01`) negotiates `2025-11-25` instead of
failing (observation O2).

### 2. Resources and subscriptions

| # | Check | Command | Observed | Status |
| --- | --- | --- | --- | --- |
| 1 | read all 15 listed resources | `resources.mjs` | 15 read, 0 failures | PASS |
| 2 | read a template-shaped URI | `resources.mjs` | text returned for charging/target-soc | PASS |
| 3 | completion, domain on telemetry template | `diag-completion.mjs` | `["battery"]` for value `bat` | PASS |
| 4 | completion, domain on charging template | `diag-completion.mjs` | `["target-soc"]` for value `soc` | PASS |
| 5 | completion, VIN on template | `diag-completion.mjs` | the single fixture VIN | PASS |
| 6 | completion ref with a concrete VIN in the URI | `diag-completion.mjs` | `-32602 Resource template ... not found`, correct refusal | PASS |
| 7 | malformed percent-encoding in the VIN segment | `diag-resources.mjs` | `-32603 URI malformed` (D3) | FAIL |
| 8 | unknown domain in a registered template | `resources.mjs` | `-32602 Unknown telemetry domain ...` | PASS |
| 9 | wrong kind segment | `resources.mjs` | `-32602 Resource not found: polestar://...` | PASS |
| 10 | charging domain under the telemetry kind | `resources.mjs` | `-32602 Unknown telemetry domain "amp-limit"` | PASS |
| 11 | traversal in the VIN segment, 3 variants | `resources.mjs`, `diag-resources.mjs` | refused but as successful resource contents carrying `INVALID_VIN` text (O4); no fixture file read | OBS |
| 12 | traversal in the domain segment, 2 variants | `resources.mjs` | `-32602 Unknown telemetry domain ...` | PASS |
| 13 | session survives traversal attempts | `resources.mjs` | ping answered | PASS |
| 14 | subscribe with an invalid VIN | `resources.mjs` | `-32602` with the URI grammar and the 17-character VIN rule named | PASS |
| 15 | subscribe with an unknown domain | `resources.mjs` | `-32602`, same actionable message | PASS |
| 16 | subscribe valid URI | `resources.mjs` | accepted | PASS |
| 17 | unsubscribe | `resources.mjs` | accepted | PASS |
| 18 | subscription cap accepts 50 | `resources.mjs` | 50 accepted | PASS |
| 19 | subscription cap refuses the 51st | `resources.mjs` | `-32602 ... already holds 50 subscriptions, the cap` | PASS |
| 20 | re-subscribe an existing URI | `resources.mjs` | accepted, not a new entry | PASS |
| 21 | live subscribe, first poll after an upstream change | `resources.mjs` | no notification while the primed `metaEventId` was unchanged | PASS |
| 22 | `metaEventId` change delivers a notification | `resources.mjs` | `notifications/resources/updated` for the exact URI | PASS |
| 23 | no notification after unsubscribe | `resources.mjs` | 0 notifications in the next 70 s | PASS |

Subscription timing from `/tmp/protocol-lane/subscriptions-result.json`: subscribe at t=0, mock
changed to a new `metaEventId` at t=1 s, no notification at the t=71 s poll, notification at
t=120 s, unsubscribe at t=120 s, no notification by t=190 s. The cache layer (battery TTL 30 s,
stale-while-revalidate) means a change becomes visible on a poll after the refresh, not on the
same poll; that matches the documented "through the cache" behaviour.

Fixture-mode cap probe: 50 subscriptions were accepted against 50 distinct well-formed VINs. Each
subscribe performs a priming read, and a failed read does not prevent the subscription from being
counted, which is what let the cap be reached with one fixture vehicle. No notification is
possible for those 50 because the session was closed after the check.

### 3. HTTP and Streamable HTTP

| # | Check | Command | Observed | Status |
| --- | --- | --- | --- | --- |
| 1 | decideBind, loopback, no token | `http-probe.mjs` | `ok: true`, unauthenticated | PASS |
| 2 | decideBind, wildcard, no token | `http-probe.mjs` | refused with the "reads vehicle location" reason | PASS |
| 3 | decideBind, wildcard, 15-character token | `http-probe.mjs` | refused, names the 16-character floor | PASS |
| 4 | decideBind, wildcard, 16-character token | `http-probe.mjs` | `ok: true`, authenticated | PASS |
| 5 | decideBind, IPv6 wildcard, no token | `http-probe.mjs` | refused | PASS |
| 6 | real process, `0.0.0.0`, no token | `http-probe.mjs` | exits 1 with "Refusing to serve on 0.0.0.0 without POLESTAR_HTTP_TOKEN" | PASS |
| 7 | real process, `0.0.0.0`, 15-character token | `corrected.mjs` | exits 1 with "shorter than 16 characters" | PASS |
| 8 | real process, `0.0.0.0`, 16-character token | `http-probe.mjs` | listens, serves 200 with the bearer | PASS |
| 9 | missing bearer on a token-protected listener | `http-probe.mjs` | 401, `www-authenticate: Bearer`, `UNAUTHENTICATED` body | PASS |
| 10 | wrong bearer | `http-probe.mjs` | 401 | PASS |
| 11 | valid bearer | `http-probe.mjs` | 200, 26 tools | PASS |
| 12 | loopback bind without a token | `http-probe.mjs` | serves the full surface without an Authorization header | PASS |
| 13 | 2025-era initialize over HTTP | `http-probe.mjs` | 200, echoes 2025-06-18, `resources.subscribe` false | PASS |
| 14 | 2025-era tools/list | `http-probe.mjs` | 200, 26 tools | PASS |
| 15 | resources/subscribe over stateless HTTP | `http-probe.mjs` | SSE error `-32601 Method not found` | PASS |
| 16 | GET on the endpoint | `http-probe.mjs` | 405, `Allow: POST` | PASS |
| 17 | DELETE on the endpoint | `http-probe.mjs` | 405, `Allow: POST` | PASS |
| 18 | modern `server/discover` | `http-probe.mjs` | 200, `supportedVersions: ["2026-07-28"]`, instructions present | PASS |
| 19 | modern tools/list with the envelope | `http-probe.mjs` | 200, 26 tools, response `_meta` carries serverInfo | PASS |
| 20 | modern tools/call with the envelope and `Mcp-Name` | `http-probe.mjs` | 200, get_battery result with Charge 52% | PASS |
| 21 | modern tools/call missing `Mcp-Name` | `http-probe.mjs` | 400 `-32020`, names the absent header | PASS |
| 22 | modern request missing the per-request envelope | `http-probe.mjs` | 400 `-32602`, names the missing `_meta` | PASS |
| 23 | modern envelope with a legacy `MCP-Protocol-Version` header | `http-probe.mjs` | 400 `-32020`, header and body versions named | PASS |
| 24 | unsupported revision inside the envelope | `http-probe.mjs` | 400 `-32020`, header and body versions named | PASS |
| 25 | `Mcp-Method` header disagreeing with the body | `http-probe.mjs` | 400 `-32020`, both method names shown | PASS |
| 26 | legacy request with `MCP-Protocol-Version: 2024-11-05` | `final-check.mjs` | 200, header tolerated on the stateless legacy path | PASS |
| 27 | legacy request with an unsupported version header | `final-check.mjs` | 400 `-32602` | PASS |
| 28 | HTTP initialize with an unsupported revision | `final-check.mjs` | 200, negotiates `2025-11-25` | PASS |
| 29 | HTTP initialize with 2024-11-05 | `final-check.mjs` | 200, echoes 2024-11-05 | PASS |
| 30 | POST on an unknown path | `http-probe.mjs` | 200 and a normal tools/list answer (O3) | OBS |
| 31 | Origin mismatch | `http-probe.mjs` | 403 `FORBIDDEN`, names the origin rule | PASS |
| 32 | same-origin Origin | `http-probe.mjs` | 200 | PASS |
| 33 | forged Host over a raw socket | `http-probe.mjs` | 403 `FORBIDDEN` | PASS |
| 34 | legitimate Host over a raw socket | `http-probe.mjs` | 200 | PASS |
| 35 | 4 MiB cap, declared Content-Length | `http-probe.mjs` | 413, `-32000`, "must not exceed 4194304 bytes" | PASS |
| 36 | 4 MiB cap, chunked body | `diag-corrected.mjs` | 413, `-32000`, "Request body must not exceed 4194304 bytes" | PASS |
| 37 | listener survives an oversized body | `http-probe.mjs` | next tools/list returns 200 | PASS |
| 38 | Origin checked before the bearer | `http-probe.mjs` | bad Origin with no token gets 403, not 401 | PASS |

### 4. Upstream fault injection

The mock records every request. Attempt counts below are mock-observed hits, not tool output.

| # | Check | Command | Observed | Status |
| --- | --- | --- | --- | --- |
| 1 | 401 then exactly one fresh-token retry | `faults.mjs` | 2 token hits, 2 data hits, second data request used the new token, tool succeeded | PASS |
| 2 | persistent 401 | `faults.mjs` | 2 data hits, then `UNAUTHENTICATED` HTTP 401 surfaced, no further retry | PASS |
| 3 | 403 not retried | `faults.mjs` | 1 data hit, `AUTHZ_CLIENT_ID_MISMATCH` 403 with the account-id hint | PASS |
| 4 | 429 with `Retry-After: 1` | `corrected.mjs` | 2 data hits, 1021 ms elapsed, success | PASS |
| 5 | 429 with an HTTP-date `Retry-After` | `faults.mjs` | 2 data hits, 961 ms elapsed, success | PASS |
| 6 | 429 without `Retry-After` | `faults.mjs` | 2 data hits, 522 ms elapsed (own backoff), success | PASS |
| 7 | 500 retried with exponential backoff | `faults.mjs` | 3 data hits, 1530 ms elapsed, success | PASS |
| 8 | 504 retried | `faults.mjs` | 2 data hits, 523 ms elapsed, success | PASS |
| 9 | malformed JSON on a 200 | `faults.mjs` | 1 data hit, `BAD_RESPONSE` "returned a non-JSON body" | PASS |
| 10 | timeout via `POLESTAR_TIMEOUT_MS=300` | `faults.mjs` | 1 data hit, `TRANSPORT_TIMEOUT`, message names 300 ms, 318 ms elapsed | PASS |
| 11 | connection reset | `faults.mjs` | 2 data hits (one transport retry on GET), `TRANSPORT_NETWORK` | PASS |
| 12 | token endpoint HTTP 500 | `faults.mjs` | 3 token hits (retried), 0 data hits, `AUTH_ERROR` HTTP 500 carrying the server message | PASS |
| 13 | token endpoint HTTP 400 | `faults.mjs` | 1 token hit, no retry, `AUTH_ERROR` HTTP 400 | PASS |
| 14 | 404 DATA_NOT_AVAILABLE negative cache | `corrected.mjs` | 1 hit for two immediate calls, a refresh after 60 s, then 2 hits total, no third hit | PASS |

Negative-cache detail: two immediate `get_battery` calls against a 404 `DATA_NOT_AVAILABLE` mock
produced one upstream hit. After a 61 s wait, the third call was answered from the expired entry
while the background refresh ran, taking the hit count to 2; a fourth call stayed at 2. The tool
text is the shared absence sentence, and the structured half carries `data.reported: false`.

### 5. Elicitation on a multi-vehicle dump

Crafted dump: `test/fixtures/dump` copied under `/tmp`, `dataportal/vehicles.json` replaced with
two well-formed VINs; the domain payloads keep the first VIN's label so a mismatched choice can be
observed. The stdio client answered `elicitation/create` requests directly.

| # | Check | Command | Observed | Status |
| --- | --- | --- | --- | --- |
| 1 | single vehicle, no elicitation | `elicitation.mjs` | no server request, read succeeds | PASS |
| 2 | several vehicles triggers elicitation | `elicitation.mjs` | one `elicitation/create`, enum of the two VINs, prompt names the count | PASS |
| 3 | accept the labelled VIN | `elicitation.mjs` | read succeeds | PASS |
| 4 | accept an answer outside the offered enum | `elicitation.mjs`, `diag-elicitation-read.mjs` | refused with `AMBIGUOUS_VIN`, 0 upstream data reads (the answer never reaches a read) | PASS |
| 5 | accept the other VIN whose payload is labelled differently | `elicitation.mjs` | `VIN_MISMATCH` refusal, payload not shown | PASS |
| 6 | decline | `elicitation.mjs` | `VIN_NOT_CHOSEN` refusal naming the visible vehicles | PASS |
| 7 | accept with no content | `elicitation.mjs` | `VIN_NOT_CHOSEN` refusal | PASS |
| 8 | client without the elicitation capability | `elicitation.mjs` | no server request, `AMBIGUOUS_VIN` | PASS |
| 9 | 2024-11-05 client | `elicitation.mjs` | no server request, `AMBIGUOUS_VIN` | PASS |

Note on check 4: an invalid answer is refused, but the code is `AMBIGUOUS_VIN` (the original
error is rethrown after the elicitation attempt fails), not `INVALID_VIN`. The refusal is correct;
the code is less specific than the input error would allow. A mock-upstream run confirmed that a
well-formed VIN outside the offered enum and a malformed VIN both produce 0 data reads, while the
labelled VIN produces 1.

## Observations, not defects

- O1. stdio answers requests before initialize. A `tools/list` sent as the first message returns 26
  tools, and a later `initialize` still succeeds. MCP says the client should not send other
  requests before the handshake; a lenient server is not a violation, but a strict conformance
  suite may record it.
- O2. Unsupported revisions negotiate instead of failing. stdio `initialize` with `1999-01-01`
  returns `2025-11-25`, and HTTP does the same. That matches the lifecycle rule that the server
  answers with a version it supports and the client decides whether to continue.
- O3. The HTTP listener serves every path. A 2025-era `tools/list` POSTed to `/not-the-mcp-path`
  returns 200 with the full tool list. No documented endpoint path exists, so this is not a
  contradiction, but a path-based reverse-proxy allowlist gains nothing from this listener.
- O4. `resources/read` renders vehicle-read failures as successful resource contents. An invalid
  VIN (including the traversal attempts) and a payload labelled for another VIN both return
  `contents` whose text is `Server refused INVALID_VIN ...` or `Server refused VIN_MISMATCH ...`,
  with no JSON-RPC error. `scripts/smoke.ts` deliberately accepts this shape, so it is intended,
  but it is inconsistent with the unknown-domain path in the same handler, which was made a
  `-32602` exactly because a success-shaped error text cannot be branched on
  (`src/server.ts:415-438`). The traversal attempts do not reach the fixtures directory: the VIN is
  rejected before any transport read.
- O5. Cancellation is protocol-only. `notifications/cancelled` suppresses the response for the
  cancelled request (correct, MCP requires no response) and the session survives, but the
  in-flight upstream GET is not aborted: the transport has only its own
  `AbortSignal.timeout` (`src/transport.ts:57`), and nothing plumbs the request signal from
  `ctx.mcpReq.signal` into `PolestarClient`. The metered attempt therefore runs to completion in
  the background. MCP says the receiver should stop processing.
- O6. Stateless HTTP resource surfaces close with the response. This is documented, and it is the
  reason `resources/subscribe` is not registered there (`-32601`) and the handshake advertises
  `subscribe: false`. Verified, not a defect.

## Method, hygiene and limitations

- Probes live in `/tmp/protocol-lane/` and write only under `/tmp`; no tracked repo file was
  modified by this lane. The report is the only repo write.
- The server ran from `src/server.ts` through `tsx`, never from `build/`, because the checkout
  must not be rebuilt during verification. Behaviour under `build/server.js` should match, but it
  was not measured.
- Fixture mode uses the shipped synthetic dump. Multi-vehicle elicitation used a copy of that dump
  with a second synthetic VIN. Upstream faults used a loopback mock; no live Polestar endpoint was
  contacted and no credential file was read.
- Timing numbers are one-shot measurements on loopback and are reported with their thresholds, not
  as benchmarks. The 429 seconds case waited 1021 ms for `Retry-After: 1`, the HTTP-date case
  961 ms, the 500 case 1530 ms across three attempts.
- The 4 MiB cap was tested with a declared `Content-Length` and with a chunked body. A body of
  exactly 4 MiB was not tested.
- The subscription change-detection probe needs the 60 s poller, so that case took about 190 s of
  wall clock and was run once. `dataHits: 3` and the timeline are recorded in
  `/tmp/protocol-lane/subscriptions-result.json`.
- Concurrent tracked-file edits appeared in the working tree during this verification (docs only).
  The probe results above are from the source at `098b8c3`; the docs defects section says which
  claim has already been fixed.
- Writing gates pass with this report in the tree: `node docs/check-docs.mjs hygiene` prints
  `HYGIENE_CLEAN`, `node docs/check-docs.mjs links` prints `DOCS_LINKS_OK`, and
  `node scripts/check-secrets.mjs` prints `SECRETS_CLEAN`. The report contains no raw VIN and no
  secret value.

## Evidence index

| Artifact | Path |
| --- | --- |
| stdio conformance | `/tmp/protocol-lane/stdio-conformance.mjs` |
| resources and subscriptions | `/tmp/protocol-lane/resources.mjs`, `/tmp/protocol-lane/resources.log`, `/tmp/protocol-lane/subscriptions-result.json` |
| HTTP and guards | `/tmp/protocol-lane/http-probe.mjs`, `/tmp/protocol-lane/http.log` |
| upstream faults | `/tmp/protocol-lane/faults.mjs`, `/tmp/protocol-lane/faults.log` |
| elicitation | `/tmp/protocol-lane/elicitation.mjs` |
| follow-up cases | `/tmp/protocol-lane/corrected.mjs`, `/tmp/protocol-lane/corrected.log`, `/tmp/protocol-lane/final-check.mjs` |
| focused diagnostics | `/tmp/protocol-lane/diag-parse.mjs`, `diag-batch-era.mjs`, `diag-resources.mjs`, `diag-completion.mjs`, `diag-noid.mjs`, `diag-initialized.mjs`, `diag-corrected.mjs`, `diag-elicitation-read.mjs` |
| harness | `/tmp/protocol-lane/harness.mjs` |
