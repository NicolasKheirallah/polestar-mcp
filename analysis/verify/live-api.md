# Lane B: live API verification

Date: 2026-11-09. Repository `polestar-mcp`, branch `master`, commit `098b8c3`. The server under
test is `src/server.ts` run through `tsx` (the shared `build/` checkout was not rebuilt). The
server reads its own credential from `~/.config/polestar-mcp/.env.secrets`; no credential value
was read, printed, copied or reported by this lane.

## Result

- Live checks: 133 passed, 0 failed across four runs (stdio surface 88, configuration variants
  20, Streamable HTTP 19, local refusal paths 6).
- Functional defects: 0.
- Observations: 5, one low presentation note and four informational (section 7).
- Live calls: approximately 92 metered attempts in total (final main ledger 73, second ledger 2,
  plus 17 from an initial surface run whose ledger was reset before the corrected re-run),
  against a 10,000/day and 100/minute ceiling. Peak per-minute use observed: 17.
- `polestar_status` was read before the live work (0/10000 used, no token, empty cache) and
  after it (73/10000 used, token issued, cache warm).
- VINs are written as `VIN_MASKED`. No address, coordinate, odometer or other personal value is
  quoted; numeric car values in the evidence lines below are replaced with `N`.

## Method and safety

- This was the only lane allowed to touch the live API. Calls went through the server: stdio
  via the repository client pattern in `scripts/stdio-client.ts`, spawned as
  `node --import tsx src/server.ts`, and Streamable HTTP on a loopback port.
- Temporary state lives under `/tmp/polestar-live` (history directory, two budget ledgers,
  result JSON). Nothing under `~/.config` was touched, no tracked repository file was changed
  by this lane, and no build was run in the shared checkout.
- The four delivered drivers pass every printed line through a mask helper that replaces
  VIN-shaped strings, token-shaped strings and decimals with six or more fraction digits. One
  throwaway debug probe printed a header line with its digits normalized but without that mask;
  the line was not carried into this report or any message, and the probe was replaced by the
  masked drivers.
- Credential failures: none. A short contention window was expected because the Lead ran a
  short live matrix concurrently; no tool call returned an error result and no auth failure
  appeared (see observation O3).
- `git status` showed modifications to `README.md` and several `docs/` files during the lane
  that this lane did not make; another teammate shares the checkout. Lane B wrote only
  `/tmp/polestar-live/**` and this report.
- Driver scripts were assertion-corrected during the lane when a check was stricter than the
  documented behaviour; the corrections are listed at the end so the evidence trail is honest.

## 1. Handshake and surface (stdio, history enabled)

| Check | Result | Evidence |
| --- | --- | --- |
| `initialize` identity | PASS | `serverInfo.name` `polestar-mcp`, version `0.3.0` |
| stdio capabilities | PASS | `resources.subscribe` true |
| instructions | PASS | names READ-ONLY, the history tool set and kilometres as the default unit |
| `tools/list` size | PASS | exactly 36 names, matching the expected registry |
| `outputSchema` on every tool | PASS | every tool declares `ok` and `message` properties |
| `readOnlyHint` on every tool | PASS | 36 of 36 true |
| strict argument schema | PASS | 36 of 36 `inputSchema.additionalProperties` false |
| `openWorldHint` honesty | PASS | true on 24 network tools (17 domain family, 5 aggregates, 2 advisors), false on the 12 local ones (`list_domains`, `polestar_status`, 10 history tools) |
| `resources/templates/list` | PASS | two templates: `polestar://vehicle/{vin}/telemetry/{domain}` and `polestar://vehicle/{vin}/charging/{domain}` |
| `resources/list` | PASS | 15 entries for the one vehicle: 8 telemetry and 7 charging domains |
| `resources/read` one resource | PASS | telemetry/battery body uses the shared header with a data age |
| `prompts/list` | PASS | car-status, charge-plan, battery-health-report |
| `prompts/get` all three | PASS | each renders a message naming the tools the prompt chains |

## 2. The 36-tool call matrix

Every call below returned `isError: false`, no JSON-RPC protocol error, and a
`structuredContent` envelope with `ok: true`. The per-tool `isError` flag, masked first text line
and `structuredContent` presence are recorded row by row in the `matrix` array of
`/tmp/polestar-live/surface.json`. All values were read with valid arguments
(`prices` for `plan_cheapest_charge` and `get_charging_cost`, `departureAt` for
`get_departure_readiness`, `domain` for `get_history`, and explicit look-back windows).

| Tool | Result | Note |
| --- | --- | --- |
| `get_availability` | PASS | header with data age |
| `get_battery` | PASS | header with data age; typed `data` view present |
| `get_exterior` | PASS | header with data age |
| `get_health` | PASS | header with data age |
| `get_location` | PASS | answered; output deliberately withheld from this log |
| `get_odometer` | PASS | header with data age |
| `get_parking_climatization` | PASS | header with data age |
| `get_pre_cleaning` | PASS | header with data age |
| `get_amp_limit` | PASS | header with data age |
| `get_charge_locations` | PASS | header with data age |
| `get_charge_now` | PASS | header with data age |
| `get_global_charge_timer` | PASS | header with data age |
| `get_parking_climate_timer` | PASS | header with data age |
| `get_target_soc` | PASS | header with data age |
| `get_is_at_charge_location` | PASS | honest absence: `No is-at-charge-location data is available for vehicle VIN_MASKED (the API returned DATA_NOT_AVAILABLE ...)`, not an error |
| `list_vehicles` | PASS | structured `count` 1 agrees with the array |
| `list_domains` | PASS | registry listing, no network read |
| `list_vehicle_domains` | PASS | 15 status rows, "14 of 15 domains reported" |
| `get_car_status` | PASS | aggregate answered from cached domain reads |
| `is_car_secure` | PASS | answered from the cached exterior domain |
| `get_needs_attention` | PASS | named one active warning category (service) |
| `get_charging_estimate` | PASS | energy and time stated with the assumptions |
| `get_charging_setup` | PASS | seven-setting view with per-setting ages |
| `plan_cheapest_charge` | PASS | accepted a 24-hour hourly price curve and returned a plan |
| `get_departure_readiness` | PASS | accepted an ISO 8601 departure with offset |
| `polestar_status` | PASS | mode, budget, minute, cache, token fields |
| `get_history` | PASS | returned the recorded battery sample with the value clock |
| `get_degradation_report` | PASS | "Only 1 battery sample(s) recorded, need at least 5." |
| `get_charging_sessions` | PASS | "No charging sessions in the recorded history." |
| `get_charging_cost` | PASS | "No charging session in the 1 recorded battery sample(s)." |
| `get_warning_changes` | PASS | "Only one health sample is recorded, and a change needs two." |
| `get_service_forecast` | PASS | car countdown plus the recorded age |
| `get_settings_history` | PASS | recorded charging-settings changes |
| `get_trips` | PASS | "only 1 odometer sample is recorded and at least 3 are needed" |
| `get_timeline` | PASS | 4 events from 4 records in the 24-hour window |
| `get_weekly_digest` | PASS | seven-day digest with its own sample counts |

## 3. Parameters and presentation

| Check | Result | Evidence |
| --- | --- | --- |
| unknown argument refused by name | PASS | `Input validation error: ... Unrecognized key: "vinn"` in an `isError` result, before any handler ran |
| invalid VIN refused locally | PASS | `Server refused INVALID_VIN: "NOTAVALIDVIN1234567" is not a plausible VIN (17 characters, no I/O/Q). Call list_vehicles for valid VINs.` |
| explicit `vin` for the real vehicle | PASS | answered from the cache, no extra live call |
| `raw:true` passes the payload through | PASS | summary 161 chars, raw 904 chars, `Raw payload:` appended, `structuredContent.data` present |
| `POLESTAR_UNITS=mi` | PASS | battery range `N km (N mi)`, odometer `N mi`; miles are rendered (see O1) |
| `POLESTAR_REDACT_VIN=1` text and structured data | PASS | `list_vehicles` text and `structuredContent.data[].vin` carry the masked form, no raw VIN |
| `POLESTAR_REDACT_VIN=1` resource names and descriptions | PASS | 15 entries, masked names and descriptions, no raw VIN |
| `POLESTAR_REDACT_VIN=1` resource URI exception | PASS | the URI still contains the raw VIN by design |
| `POLESTAR_REDACT_VIN=1` resource body | PASS | masked body, no raw VIN |
| `POLESTAR_REDACT_VIN=1` completions | PASS | one VIN completion, masked; response JSON contains no raw VIN |
| `POLESTAR_REDACT_VIN=1` errors | PASS | invalid-VIN error masked and names the resource URI exception; unknown-domain protocol error contains no raw VIN |
| `POLESTAR_REDACT_VIN=1` and `raw:true` | PASS | raw payload still carries the raw VIN, which the `raw` argument description documents as the deliberate exception (O2) |
| `POLESTAR_ALLOW_LOCATION=0` refuses `get_location` | PASS | `Server refused LOCATION_DISALLOWED: ... the request was never sent.` |
| `POLESTAR_ALLOW_LOCATION=0` refuses the location resource | PASS | same refusal through `resources/read` |
| `POLESTAR_ALLOW_LOCATION=0` support matrix | PASS | `telemetry/location: disallowed (POLESTAR_ALLOW_LOCATION=false, so no position request was sent)` |
| `POLESTAR_ALLOW_LOCATION=0` aggregate stripping | PASS | `get_timeline` names location as excluded and its structured `excluded` field contains location; `get_weekly_digest` still answers |

No-live-call evidence: after the 36-tool matrix and all parameter checks above, the daily count
was still 17, which is exactly one token POST, one vehicle list and 15 first domain reads. Every
refusal and every cache-hit path above therefore spent nothing.

## 4. Budget, cache, token and ledger

| Check | Result | Evidence |
| --- | --- | --- |
| starting budget | PASS | used 0, limit 10000, remaining 10000, reset `2026-11-10T00:00:00.000Z` |
| starting token and cache | PASS | `Token: not yet issued`; cache entries 0 |
| budget arithmetic after work | PASS | used 17 + remaining 9983 = limit 10000 |
| per-minute meter | PASS | limit 100, peak observed 17 used |
| token trusted expiry | PASS | token issued with `expiresAt` and `trustedUntil` 300000 ms apart (5 min skew), `trustedMinutes` 55; text line `Token: trusted ~55 more min` |
| cache warm after the matrix | PASS | enabled, 81 hits + 0 stale-served of 97 reads (84%), 16 misses, 16 refreshes, 16 entries |
| cache hit counters after repeats | PASS | two more battery reads raised hits to 85 with used unchanged at 17 |
| ledger persistence, first start | PASS | start A: used 0, then 2 after one `list_vehicles`; ledger file created |
| ledger persistence, second start | PASS | start B read used 2 before making a call and had not issued a token |
| ledger contents | PASS | one identity hash plus `used` and `windowStartUtc`; no credential or VIN |
| closing budget | PASS | main ledger used 73, second ledger used 2, total 75 metered attempts |

## 5. Live Streamable HTTP

| Check | Result | Evidence |
| --- | --- | --- |
| listener starts on `POLESTAR_HTTP_PORT` | PASS | port 18497, loopback |
| 2025-era `initialize` | PASS | `serverInfo.name` `polestar-mcp`, status 200 |
| stateless capability honesty | PASS | `resources.subscribe` false over HTTP |
| 2025-era `tools/list` | PASS | 36 tools, every one with `outputSchema` and `readOnlyHint` |
| 2025-era live `tools/call` | PASS | `get_battery` answered with text and `structuredContent.ok` true |
| 2025-era `resources/list` | PASS | 15 entries |
| 2025-era `prompts/list` | PASS | 3 prompts |
| 2026-07-28 `server/discover` | PASS | status 200, `supportedVersions` `["2026-07-28"]` |
| 2026-07-28 `tools/list` | PASS | status 200, 36 tools |
| 2026-07-28 live `tools/call` | PASS | status 200 with the required `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers |
| foreign `Origin` | PASS | 403 `FORBIDDEN`, names the origin |
| foreign `Host` | PASS | 403 `FORBIDDEN`, names the host and DNS-rebind rationale |
| missing bearer token | PASS | 401, `www-authenticate: Bearer`, `UNAUTHENTICATED` body |
| missing per-request envelope | PASS | 400, `-32602`, message names the missing `_meta` envelope |
| partial envelope | PASS | 400, `-32602`, names `io.modelcontextprotocol/protocolVersion` and the client capabilities key |
| modern `tools/call` without `Mcp-Name` | PASS | 400 before dispatch, message says the required `Mcp-Name` header is absent |
| valid request after the guard tests | PASS | 200 with the tool list |

## 6. History accrual

| Check | Result | Evidence |
| --- | --- | --- |
| recorder writes while the server answers | PASS | 14 store files, 14 records, one per reported domain |
| battery sample recorded | PASS | one battery record; `get_history` returns its fields with the value clock |
| duplicate suppression | PASS | three battery read paths left one battery record, because the cloud `metaEventId` did not change |
| thin battery history | PASS | `get_degradation_report`: "Only 1 battery sample(s) recorded, need at least 5." |
| thin charging history | PASS | `get_charging_sessions`: "No charging sessions in the recorded history."; `get_charging_cost` names the one recorded sample and claims no cost |
| thin health history | PASS | `get_warning_changes`: "Only one health sample is recorded, and a change needs two." |
| thin odometer history | PASS | `get_trips`: "only 1 odometer sample is recorded and at least 3 are needed" |
| no invented values | PASS | every sparse-history tool stated the sample count or span instead of a number |
| unknown domain in `get_history` | PASS | `Server refused UNKNOWN_DOMAIN: "telemetry/no-such-domain" is not a registered domain.` |

## 7. Defects and observations

Defects found: none.

- O1, low, presentation only: under `POLESTAR_UNITS=mi`, the battery range renders the reported
  kilometres with miles in parentheses (`range N km (N mi)`) while the odometer renders miles
  alone (`Odometer: N mi`). This matches the two helpers in `src/format.ts`: `distance()` keeps
  the reported value with a conversion, `fromKm()` renders the preferred unit alone. The
  preference is honoured, so this is a consistency note for a reviewer, not a failed claim.
  Repro: `POLESTAR_UNITS=mi`, then `get_battery` and `get_odometer`.
- O2, informational: `raw:true` carries the raw payload including the VIN even with
  `POLESTAR_REDACT_VIN=1`. The `raw` argument description in `src/tool-output.ts` states this
  exception, and the lane confirmed it. Redaction is therefore narrower than "everywhere".
- O3, informational: the closing main ledger holds 73 metered attempts in its window while this
  lane can account for 65 expected network calls there. The difference is consistent with retry
  attempts during the concurrent Lead live matrix (429 contention). No call returned an error
  and no auth failure occurred, so this is noted rather than treated as a defect.
- O4, informational: `get_is_at_charge_location` answered with the DATA_NOT_AVAILABLE absence
  sentence, `list_vehicle_domains` reported 14 of 15 domains, and the history store held 14
  records. The three agree, which is the documented normal state for a car that does not report
  that domain.
- O5, informational: the first `polestar_status` of a fresh process says "Token: not yet issued"
  and the first live read then issues a token whose trusted life is 5 minutes shorter than the
  advertised expiry (`EXPIRY_SKEW_MS`). Both matched the source and the text.

## 8. Coverage not exercised

- stdio resource subscriptions (`resources/subscribe` and the once-a-minute poller) were not
  exercised live: a notification needs the car to report a new `metaEventId`, and this lane was
  time-boxed. HTTP mode correctly refuses to advertise the capability.
- `delegated_account_id`: no delegated credentials were configured, so the allowlist path was
  not exercised.
- Fixture mode, the offline test suite and the other lanes' surfaces were out of scope here.

## Evidence

Result JSON, ledgers and the history directory are under `/tmp/polestar-live` (local, untracked):

- `surface.json`: 88 checks, the 36-row matrix, budget, cache and store counts.
- `variants.json`: 20 checks for units, redaction, location and ledger persistence.
- `http.json`: 19 checks for both HTTP protocol eras and the guard refusals.
- `extra.json`: 6 checks for local refusals and the closing budget reading.
- `budget-main.json` and `budget-persist.json`: daily-count ledgers holding an identity hash,
  `used` and `windowStartUtc`, no credential and no VIN.
- `history-main`: 14 record files. Its directory name carries the VIN, so it is not quoted.

Reproduction (drivers are outside the repository, so they cannot leak into the tree):

```bash
node --import tsx /tmp/polestar-live/surface.ts
node --import tsx /tmp/polestar-live/variants.ts
node --import tsx /tmp/polestar-live/http.ts
node --import tsx /tmp/polestar-live/extra.ts
```

Each driver prints PASS or FAIL per check and writes its JSON beside it. The server reads the
live credential itself; no driver sets a credential variable.

## Assertion corrections during the lane

These checks failed on their first run because the assertion was stricter than the documented
behaviour. Each was corrected to the documented behaviour and re-run; none corresponds to a
product defect.

1. `resources/list` was expected to return 30 entries; the correct count for one vehicle is 15
   (8 telemetry plus 7 charging domains).
2. `raw:true` was expected to embed a `{data, meta}` envelope in the text; it appends the
   already-unwrapped Domain payload under a `Raw payload:` heading and mirrors it in
   `structuredContent.data`.
3. The token object was expected to carry `issued: true`; a live token carries `expiresAt`,
   `trustedUntil` and `trustedMinutes`, and only the not-yet-issued case carries `issued: false`.
4. `POLESTAR_UNITS=mi` was expected to suppress every `km` spelling; the battery range keeps the
   reported kilometres with miles in parentheses (O1).
5. The 2026-07-28 `tools/call` request was initially sent without `Mcp-Name`; the modern era
   requires that header, and the server refused it correctly with 400 before dispatch.
6. The missing-envelope refusal names `_meta` when `_meta` is absent; a partial-envelope case was
   added to observe the individual key names.
