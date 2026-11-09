# Surface and protocol audit: polestar-mcp 0.3.0

Scope: the MCP surface a client and its model actually see. Files read in full: `src/server.ts`,
`src/tools.ts`, `src/bind.ts`, `src/domain-tools.ts`, `src/system-tools.ts`,
`src/aggregate-tools.ts`, `src/advisor-tools.ts`, `src/history-tools.ts`, `src/tool-output.ts`,
`src/subscriptions.ts`, `src/domains.ts`, `docs/tools-reference.md`, plus the resource, completion,
subscription and prompt registration in `server.ts`. Supporting reads: `src/vehicle-read.ts`,
`src/domain-data.ts`, `src/format.ts`, `src/failure.ts`, `src/planner.ts`, `src/history.ts`,
`src/client.ts`, `src/charge-model.ts`, `src/config.ts`, `src/auth.ts`, `SECURITY.md`,
`docs/getting-started.md`, the test suite and the gate scripts.

Prior work was read and re-verified: `analysis/00-brief.md`, `analysis/A-surface.md`,
`analysis/E-runtime.md`, `analysis/surface/findings.md`, `analysis/correctness/findings.md`, and the
candidate and verdict sections of `analysis/council/R1-product.md`, `R2-engineering.md`,
`R3-security.md`. Two corrections are recorded here because they affect candidate counts:
`analysis/A-surface.md:337` says "11 of the 15" domain descriptions promise fields the prose omits;
the registry table at `src/domains.ts:72` through `:317` has 12 such rows, which matches
`analysis/council/R2-engineering.md:402`. The same file's byte counts (`tools/list` 44,841 bytes at
23 tools, 50,718 at 26) reproduce exactly in this audit.

State of the tree at audit time: Node v22.23.2, commit `dc50017`, `analysis/` the only untracked
path. Fixture mode (`POLESTAR_FIXTURES_DIR=test/fixtures/dump`) only; no live credential and no
Polestar API call. The one HTTP probe binds a loopback port in fixture mode. No tracked file was
modified; the only write is this file.

Severity rule used below: a defect is ordered by whether it can change a user's answer or leak data,
not by how many lines the fix touches.

## Verified defects

### D1. `POLESTAR_REDACT_VIN` leaks the full VIN through resource identity, completions, errors and elicitation (security)

Candidate A-05. Evidence: `src/server.ts:285` (resource URI built from the raw VIN),
`src/server.ts:286-287` (name and description use the last four characters),
`src/server.ts:298-299` (completion returns raw VINs), `src/client.ts:125` (`AMBIGUOUS_VIN`
joins raw VINs), `src/client.ts:227` and `src/client.ts:246` (`VIN_MISMATCH` prints both VINs),
`src/vehicle-read.ts:94` (elicitation enum lists raw VINs) and `src/vehicle-read.ts:109`
(`VIN_NOT_CHOSEN` joins them). `SECURITY.md:26-27` claims redaction covers "the resource
listings"; it does not.

Proof (real server, `POLESTAR_REDACT_VIN=1`): `REDACT_RESOURCE` returns
`"uri":"polestar://vehicle/YSMTEST22PL000001/telemetry/availability"`, `REDACT_COMPLETION` returns
`"values":["YSMTEST22PL000001"]`, and `REDACT_MISMATCH_TEXT` contains both full VINs. The tool text
and `structuredContent.vin` are masked (`REDACT_LIST` shows `YSM…001`), so the promise holds only on
the one path a test covers (`test/runtime.test.ts:345-365`).

### D2. HTTP mode accepts any Host and Origin, so the default loopback listener is reachable by DNS rebinding (security)

Candidate A-06. Evidence: `src/server.ts:421-425` checks only `authorization`;
`src/bind.ts:19-26` allows loopback with no token; `src/config.ts:278-279` makes that the default;
`SECURITY.md:65-73` presents loopback as the safe mode. No Origin or Host validation exists in
`src/` (grep for `origin`, `hostHeader` finds only `httpHost`).

Proof: HTTP mode started in fixture mode on `127.0.0.1`; a POST of a valid `initialize` with
`Host: attacker.example` and `Origin: http://attacker.example` returned `HTTP_REBIND_STATUS 200`,
and the same headers on `tools/list` returned `HTTP_REBIND_TOOLS_STATUS 200` with the full tool
list. `smoke-http.ts` and `test/server-seams.test.ts:18-41` never send either header.

### D3. Absence text can invert a yes/no answer, and aggregates omit domains that did not answer (bug, safety relevant)

Candidate A-01. Evidence: `src/vehicle-read.ts:155-158` (`noData` leads with "No <domain>
data"), used as the entire result by `src/aggregate-tools.ts:106` (`is_car_secure`) and
`src/aggregate-tools.ts:133` (`get_needs_attention`). `src/aggregate-tools.ts:55-76` is an
`if (domain)` chain with no `else`, so `get_car_status` silently drops an unreported domain.

Proof: `J_SECURE_ABSENT` is `"No exterior data is available for vehicle ..."` with `ok: true`, so
a model asked "is my car locked?" reads a leading negative; `K_ATTENTION_ABSENT` is the same for
"anything wrong?". `G_STATUS_PARTIAL` shows three bullets for five domains and no mention of the
two that did not answer. A partial exterior (`{alarm:'ALARM_STATUS_OK'}` with lock fields absent)
returns `PARTIAL_EXTERIOR "No, not fully locked."`, asserting a state from unreported fields.
`get_charging_estimate` and `plan_cheapest_charge` also lose the structured absence signal
(`ok: true`, no `code`, no `data`).

### D4. `get_car_status` reports only the newest domain age and hides a stale domain, although the tool description promises an age for each (bug)

Candidate A-08. Evidence: `src/aggregate-tools.ts:38` says "data age for each"; the code computes
one `Math.max` at `src/aggregate-tools.ts:81-87` and prints "Data as of ... (newest domain)".
`readDomains` discards the per-domain observation time (`src/vehicle-read.ts:167-178`).
`docs/tools-reference.md:86` repeats the newest-age behaviour, so the description and the reference
contradict each other.

Proof: with battery fresh and health dated 2025-01-01, `G_STATUS_PARTIAL` ends
`"Data as of 1 min ago (newest domain)."`, and the two-year-old service countdown is presented
without an age. The registry itself says settings can be a month old while telemetry is minutes old
(`src/server.ts:212`, `docs/upstream-api.md:16`).

### D5. `battery-health-report` is registered on every start but instructs calls to two tools that exist only when history is enabled (bug)

Candidate A-02. Evidence: the prompt is always registered at `src/server.ts:388-409`; the history
tools are conditional at `src/server.ts:201`. The check that should catch it,
`test/server-seams.test.ts:255-286`, builds the 26-tool union at `:263-275`, and
`scripts/check-tool-refs.mjs:97-100` scans only the union produced by `scripts/list-tools.ts:29-35`.

Proof (default fixture surface, no history): `PROMPT battery-health-report ... UNREGISTERED
["get_degradation_report","get_charging_sessions"]`. With `POLESTAR_HISTORY_DIR` set the prompt is
correct (`PROMPT_H battery-health-report unregistered []`), so the defect is specific to the
default configuration the README documents.

### D6. `get_charging_estimate` promises an estimate and then prints none, and it silently assumes an 80 percent target (bug)

Candidate A-03. Evidence: `src/aggregate-tools.ts:186-189` pushes "showing the car's own estimate
instead", while `src/aggregate-tools.ts:190-191` prints that estimate only when
`timeToFullMinutes > 0`; the target default is `?? 80` at `src/aggregate-tools.ts:170` and
`:178` with no assumption line, and `:191` labels the car's number "to 100%" beside an 80 percent
calculation without reconciling the two.

Proof (real fixture surface): `CALL get_charging_estimate ... isError false keys
["ok","message"] textBytes 180`, text exactly `"Usable-energy data not reported; showing the car's
own estimate instead.\nAssumptions: power estimated from 20 A × 230 V assumed × 3 phase(s); the car
reports no charging voltage."`. With a synthetic battery reporting a 45 minute ETA and target-soc
absent, `I_ESTIMATE_NO_TARGET` is byte-identical to the case where the car reports 80, so the caller
cannot tell a real target from the default.

### D7. `POLESTAR_CACHE=off` silently removes the retry layer, the daily budget meter and the per-minute meter (bug, safety property)

Candidate A-04. Evidence: `src/server.ts:78-79` wraps the base transport in `RetryingTransport`
only when `!fixturesDir && !cacheDisabled`; `RetryingTransport` is the only caller of
`budget.consume()` and `minute.consume()` (`src/retrying-transport.ts:56-69`). The flag is documented
as a cache setting (`docs/getting-started.md:96`, `README.md:196`), and
`docs/getting-started.md:173` says "The server meters every live call it makes (including
retries)", which is false in this configuration.

Proof, stubbed upstream answering 429 twice then 200: `CACHE_OFF_RETRY on httpCalls 4 budgetUsed 4
outcome ["YSMTEST22PL000001"]`; `CACHE_OFF_RETRY off httpCalls 2 budgetUsed 0 outcome ERR
PolestarApiError: Request failed (HTTP 429).` The fail-closed 10,000/day guard does not exist with
caching off.

### D8. `get_history` prints `{}` for most domains because it keeps five hardcoded field names (bug)

Candidate A-07. Evidence: `src/history-tools.ts:79-82` filters every record through
`['batteryChargeLevelPercentage','estimatedDistanceToEmptyKm','odometerMeters','chargingPowerWatts',
'measuredParticulateMatter25']`. The description calls the answer "Raw recorded samples"
(`src/history-tools.ts:53-54`) and `docs/tools-reference.md:103` repeats it.
`test/runtime.test.ts:838-839` asserts an unrelated field is removed for battery, so the filter is
tested only on the one domain where it works.

Proof: a `charging/amp-limit` record carrying `ampLimit` and `id` renders
`L_HISTORY_AMP "2026-11-01T00:00:00.000Z {}\n2026-11-01T01:00:00.000Z
{\"odometerMeters\":12345}"`. For health, target-soc, global-charge-timer and the other domains the
same `{}` appears, so 10 or more of the 15 registered domains answer with timestamps and no data.

### D9. `is_car_secure` ignores the alarm state, and reports "not fully locked" from missing lock fields (bug)

Candidate A-10. Evidence: the description at `src/aggregate-tools.ts:98` asks "alarm OK?", but the
verdict at `src/aggregate-tools.ts:110-114` is `seen.locked && open.length === 0`;
`alarm` is only printed. `src/domain-data.ts:266` computes `locked` from two fields, so a payload
that omits `tailgateLock` reads as unlocked rather than unknown.

Proof: `F_ALARM_TRIGGERED "Yes, car is secure (locked, all closed). Alarm: triggered."` with
`ok: true`; `PARTIAL_EXTERIOR "No, not fully locked."` with both lock fields absent.
`test/server-seams.test.ts:298-327` tests only `ALARM_STATUS_OK`.

### D10. Planner schedule arithmetic: steps are not hour-aligned, a stop hour above 23 is truncated, "contiguous" blocks cross day gaps, and a short window can claim feasible while delivering a fraction of the energy (bug)

Candidate A-15. Evidence: `src/planner.ts:77` builds the first slot from `now` including seconds and
milliseconds; `src/planner.ts:70-73` tests `localHour < 28` in the non-wrapping branch;
`src/planner.ts:118-125` slices the filtered in-window array without checking time adjacency;
`src/planner.ts:126-138` divides needed energy by `hoursInt` while taking only `rated.length` slots,
and leaves `feasible: true`.

Proof: `P1_PLAN_STARTS ["2026-11-09T20:00:45.678Z","2026-11-09T21:00:45.678Z"]` for a clock at
19:23:45.678; the real fixture surface printed `21:00:01.821Z → 22:00:01.821Z` steps.
`P2_STOP28 {"feasible":true,"steps":2}` for a 22:00 to 28:00 window (00:00 to 03:00 never
scheduled). `P3_SHORTFALL {"feasible":true,"energyNeededKwh":100,"hoursNeeded":10,"steps":2,
planned":20}`. `analysis/correctness/findings.md:159-187` argues the same three arithmetic defects
from a separate lane; the independence is noted, not treated as corroboration.

### D11. Planner price and cost honesty: unmatched prices still produce `ok: true` steps marked "price unknown", the cost has no unit, and a negative or zero cost is omitted (bug)

Candidate A-16. Evidence: `src/planner.ts:86-92` matches a price only inside the next 48 hours and
silently leaves the rest unmatched; `src/planner.ts:140-147` computes a sum but includes
`totalCost` only when it is above zero; `src/advisor-tools.ts:125` prints `Estimated cost:`
with no currency or unit, while the `prices` argument at `src/advisor-tools.ts:12-14` names no
unit. The repair sentence at `src/advisor-tools.ts:79-81` returns `ok: true` with no `code` and
does not say which input is missing.

Proof (real fixture surface, 24 hourly prices dated 2026-02-01):
`PLAN past isError false ok true ... (price unknown) ...`, no cost line. With 24 prices anchored to
the next 24 hours: `PLAN anchored ... Estimated cost: 2.621` and still
`7 window slot(s) had no price and are treated as last resorts`. `O_NEGATIVE_COST
{"feasible":true,"steps":2}` has no `totalCost`; `Q_PLAN_MISSING "Missing required data (battery
SoC, target SoC, or amp limit), cannot plan."` is `ok: true`.

### D12. Failure presentation: local refusals are labelled as upstream API errors, every 403 is rewritten as a scope problem, and the fallback hint asks for a requestId that does not exist (bug, docs)

Candidate A-17. Evidence: `src/failure.ts:113-117` prefixes every failure with "Polestar API
error"; `src/vehicle-read.ts:226-231` replaces the code-specific hint with a scope hint whenever
`httpStatus === 403`, although `src/tool-output.ts:127-136` documents that 403 is an authorization
code; `src/tool-output.ts:121-123` tells the caller to report a `requestId` for `INTERNAL_ERROR`,
which no minted failure carries; `src/tool-output.ts:167-178` puts the hint in the text suffix, in
`message`, and in the `hint` field.

Proof: real fixture call with `vin: "NOTAVIN"` returns
`"Polestar API error INVALID_VIN (HTTP 400): ..."` (no HTTP request was made), `ERR_HINT_SEEN 3`
occurrences of the same hint string, `wireBytes 786` for a 268-byte message. A synthetic
`AUTHZ_CLIENT_ID_MISMATCH`: `P_403_HINT_DOMAIN "this domain needs the OAuth scope
`pdp-telemetry/battery` on the credential"` from `get_battery`, while `get_car_status` gives
`P_403_HINT_AGGREGATE "x-client-id carried the OAuth client id..."`. `M_DEGRADE_LOWSOC` shows the
`INTERNAL_ERROR` hint: "Report the requestId and the tool you called", with no requestId present.

### D13. Unknown arguments are silently stripped, so a misspelled `vin` reads the default car (bug, security relevant)

Candidate A-18. Evidence: `src/tools.ts:48` passes a raw shape to the SDK; Zod strips unknown keys
before `spec.run`, and no schema is `.strict()` (`src/tool-output.ts:6-48`).

Proof (real fixture surface): `CALL get_battery {"tyre":1}` and
`CALL get_battery {"vinn":"YSMTEST22PL000002"}` both return `isError false`, `textBytes 161`, the
normal single-car answer. A wrong-car answer is the failure mode `SECURITY.md:16-19` calls
unacceptable for a different mechanism.

### D14. Subscription lifecycle: invalid URIs are accepted, a failed notification loses the change forever, overlapping rounds double-notify, and there is no subscription cap (bug, security)

Candidate A-19. Evidence: `src/server.ts:328-335` forwards the raw URI;
`src/subscriptions.ts:55-66` parses, ignores an unparseable URI and starts the timer;
`src/subscriptions.ts:105-107` writes the new `metaEventId` before awaiting `notify`, and
`src/subscriptions.ts:109-111` swallows the rejection; `src/subscriptions.ts:37` uses
`setInterval`, so a round can overlap the next; nothing caps `lastEventId.size`, so 150
subscriptions cost up to 9,000 reads/day before the 90 percent pause at `:93`.

Proof: `SUBSCRIBE_UNPARSEABLE {"result":{}}` with no error and nothing polled;
`S1_NOTIFY_FAILURE notified []` (the change is never re-detected); `S2_OVERLAP notified 2` for one
cloud change. `analysis/correctness/findings.md:278-304` reports the same two lifecycle defects from
a separate lane.

### D15. History output correctness: a low-SoC store crashes the degradation report, the session "duration" includes internal gaps, and every history timestamp is the read clock rather than the car clock (bug)

Candidate A-14. Evidence: `src/history-tools.ts:104-111` gates on raw sample count, then
`points[0]!.observedAt` assumes `degradationSeries` returned a point; `src/history.ts:211` drops
every sample at or below 5 percent SoC, so a store of five low-SoC battery samples produces zero
points. `src/history-tools.ts:155` prints `Math.round(s.activeSeconds / 60) min`, where
`src/history.ts:118-122` documents `activeSeconds` as the span including gaps. The record clock is
`Date.now()` at `src/server.ts:110-112`, while `src/history.ts:216` and
`src/history-tools.ts:111` and `:155` present `record.observedAt` as the sample time.

Proof: five records at 3 percent SoC return `M_DEGRADE_LOWSOC isError true code INTERNAL_ERROR
text "Polestar API error INTERNAL_ERROR (HTTP n/a): Cannot read properties of undefined (reading
'observedAt')"`. Two charging samples 29 minutes apart produce `D2_SESSION ... activeSeconds:1740`
labelled "min" as the session duration. `D1_SERIES_TIMES` lists 2026-11-09 timestamps while the
payload's own observation is `payloadTimestamp 2026-09-18T11:00:00.000Z`, the 52 day gap the
fixture exposes.

### D16. Resource listing is silently truncated, treats a failed vehicle list as zero resources, ignores configured labels, and answers an unknown domain as content (bug)

Candidate A-22. Evidence: `src/server.ts:283` (`vins.slice(0, 10)`, no cursor);
`src/server.ts:292-294` (`catch { return { resources: [] } }`); `src/server.ts:286-287` builds names
from `vin.slice(-4)` rather than `POLESTAR_VEHICLE_LABELS`; `src/server.ts:309-312` returns
`contents` with "Unknown <kind> domain" text instead of an MCP error.

Proof: fake engine listing 12 VINs gives `A_RESOURCES_12VIN count 150 distinctVins 10
nextCursor undefined`; a throwing vehicle list gives
`B_RESOURCES_FAILURE {"result":{"resources":[]},...}`; redaction plus labels gives
`C_RESOURCE_REDACT {"uri":"...full VIN...","name":"availability (…0001)",...}`. Real server:
`RESOURCE_UNKNOWN_DOMAIN {"result":{"contents":[{...,"text":"Unknown telemetry domain \"nope\"."}]}}`.

### D17. `list_vehicles` has no delegation argument and returns `ok: true` with no structured data for an empty credential (bug)

Candidate A-20. Evidence: `src/domain-tools.ts:19-46` declares no `args` and its `run` takes no
arguments, so `delegated_account_id` is not in the schema and is dropped before the body; the empty
branch at `src/domain-tools.ts:26` returns text only. `docs/tools-reference.md:21` says every
car-reading tool takes the delegation; the VIN list is the most identity-sensitive read of all.
`test/runtime.test.ts:689-690` selects the tools that must declare delegation with
`'vin' in argsOf(spec)`, which structurally excludes `list_vehicles`.

Proof: `R_EMPTY_LIST "This credential is not authorized for any vehicle." ok true keys
["ok","message"] declaredArgs undefined`. `analysis/correctness/findings.md:337-360` reports the
delegation half from a separate probe.

### D18. 12 of 15 domain descriptions, and the reference doc that repeats them, name values the humanized summary never prints (docs)

Candidate A-21. Evidence: `src/domains.ts:72-73` (battery power status, type, miles),
`:98` (tailgate lock), `:126-127` (engine hours), `:152` (altitude), `:171` (average speeds),
`:190-191` (requested heating, ventilation), `:212-214` (air quality index, cycle validity),
`:236-237` (amp source, last update), `:256` (utc0), `:281-282` (timezone offset, pending changes),
`:299` (repeat flag), `:317` (last update). The summaries are in `src/format.ts:139-245`;
`docs/tools-reference.md:54-67` repeats the same promises.

Proof against the shipped fixtures: `SUMMARY amp-limit ["AC charge current limit: 20 A"]` (no
source, no update), `SUMMARY global-charge-timer ["Charge window: 23:00 → 6:00 (defined but
inactive)"]` while `TIMER_OFFSET {"offsetMinutes":120}` is parsed and dropped at
`src/format.ts:226-227`, `SUMMARY odometer` has no average speeds, `SUMMARY health` has no engine
hours, `SUMMARY parking-climatization` has no requested heating. `LOCATION_STRING_SPEED` with
`speed:"55"` prints `0 km/h` because `src/domain-data.ts:150` reads it with `asNumber`, and the
captured fixture stores speed as a string (`test/fixtures/dump/dataportal/telemetry/location.json`,
field `speed: "0"`).

### D19. Every result carries its text twice, a raw result carries the payload twice, the identical output schema is repeated on every tool, and failure hints are repeated three times (perf)

Candidate A-12. Evidence: `src/tool-output.ts:84-92` sets `structuredContent.message` to the exact
content text; `src/tool-output.ts:70-81` is one 1,009-byte shape used by every tool through
`src/tools.ts:49`; `src/vehicle-read.ts:247-256` appends the raw payload to the text and also puts
it in `data`; `src/tool-output.ts:167-178` triples the hint.

Proof: `TOOLS 23 bytes 44841 ... outSchemaBytes 23207` (23 copies of 1,009 bytes);
`CALL get_battery {"raw":true} isError false ... textBytes 904 wireBytes 2729`;
`ERR_HINT_SEEN 3 wireBytes 786`. Over the 20-call set in `analysis/E-runtime.md:91-95` the duplicate
share is 44.3 percent; this audit reproduces the per-call shape, not that exact sample.

### D20. `initialize` instructions describe a different surface than the one the process serves (docs, DX)

Candidate A-09. Evidence: `src/server.ts:207-214` is a fixed string. It tells the model to "Start
with list_vehicles" even though every car tool resolves an omitted VIN
(`src/vehicle-read.ts:121-143`), says errors carry a `requestId` although minted failures do not
(D12), and never mentions the history tools, the unit setting, redaction, delegation or the
resources and prompts.

Proof: `INSTRUCTIONS_BYTES 882`; with `POLESTAR_HISTORY_DIR` set,
`HISTORY_TOOLS 26 ... INSTRUCTIONS_MENTION_HISTORY false`, and the instructions string is byte
identical with and without history. `docs/architecture.md:58` describes the instruction text as the
ground rules.

### D21. `polestar_status` names a settings variable that does not exist and reports the token as trusted past its skew (bug, docs)

Candidate A-23. Evidence: `src/system-tools.ts:54` prints `POLESTAR_CACHE_DISABLED`; the real
variable is `POLESTAR_CACHE` (`src/config.ts:280`, `src/config.ts:83-89`), and the loader would
report the wrong name as unrecognized. `src/system-tools.ts:56-64` uses `expiresAt()` raw while
`src/auth.ts:13` and `:76-82` stop trusting the token five minutes early.
`test/server-seams.test.ts:251` pins the wrong variable name.

Proof: `CALL polestar_status` text contains
`"Cache: off (POLESTAR_CACHE_DISABLED, or fixture mode without a history store)"` and
`"Token: trusted ~60 more min"` for a token that `token()` would refetch after 55 minutes.
`analysis/correctness/findings.md:464-509` reports both from a separate lane.

### D22. Capabilities and annotations overclaim: `logging` and `listChanged` are advertised with no notification ever sent, `polestar_status` and the history tools inherit the open-world default, and no tool declares `idempotentHint` (quality)

Candidate A-24. Evidence: `src/server.ts:215` declares `{ resources: { subscribe, listChanged: true
}, logging: {} }`; a grep of `src/` finds no `sendLoggingMessage`, `sendToolListChanged`,
`sendResourceListChanged` or `sendPromptListChanged`. `src/system-tools.ts:34` and
`src/history-tools.ts:56`, `:96`, `:142` omit `openWorldHint`, whose specification default is true,
although all four tools are local or read-only in a closed world. `src/tools.ts:24` has no
`idempotentHint` field, so every pure read advertises the default false.

Proof: `CAPS {"resources":{"subscribe":true,"listChanged":true},"logging":{},...
"tools":{"listChanged":true},...}`; `ANNOTATIONS polestar_status {"readOnlyHint":true}` (no
`openWorldHint`, no `idempotentHint`). `analysis/surface/findings.md:303-320` records the same
mismatch.

### D23. The checks that appear to cover the surface cannot fail on the defects above (quality)

Candidate A-26. Evidence: `test/server-seams.test.ts:263-275` builds the 26-tool union instead of
the running surface, which is why D5 passes CI; `test/contract.test.ts:50-62` tests only whether a
description disclaims optional fields, never whether a promised value is rendered, which is why D18
passes; `test/planner.test.ts:125-142` is titled "falls back" but its scenario takes the contiguous
path and its assertion `reason !== undefined || steps.length > 0` accepts any plan, which is why D10
passes; `scripts/smoke-http.ts` sends no `Origin` or `Host`, which is why D2 passes;
`test/runtime.test.ts:345-365` checks the domain-read envelope only, which is why D1 passes.

Proof: `PLANNER_TEST_SCENARIO {"feasible":true,"steps":1,"testAssertionWouldPass":true}` for the
exact inputs of the fallback test; `npm run check-tool-refs` prints
`TOOL_REFS_OK 26 registered names, 27 instruction-surface files scanned, 0 undefined names
referenced` while D5 is live.

## Missing capabilities

Ordered by how much a user or client would notice.

1. **Machine-readable result data (A-11).** On the default path only `list_vehicles` populates
   `structuredContent.data`; measured keys for the other six non-domain tools are `["ok","message"]`
   or `["ok","message","vin","tool","ageSeconds"]`. A client that wants `chargePercent = 52`,
   `remainingCalls`, or the planner's steps must parse prose. The envelope claims "shape documented
   per tool" at `src/tool-output.ts:75`, but no per-tool shape exists.
2. **One charging-setup aggregate (A-27).** Seven charging settings reads are seven tool choices
   and seven calls (`get_amp_limit`, `get_target_soc`, `get_global_charge_timer`,
   `get_parking_climate_timer`, `get_charge_locations`, `get_charge_now`,
   `get_is_at_charge_location`), and `get_car_status` covers only five telemetry domains
   (`src/aggregate-tools.ts:45-52`). The instructions tell the model to prefer aggregates, but there
   is no aggregate for the second-most-asked question.
3. **History windowing (A-13).** `get_history` has `hours` and `limit` but no offset, cursor or
   "before"; the store slices to `limit` at `src/history.ts:74-78` and `recordsToText` prints no
   marker (`src/history-tools.ts:37-40`), so a truncated 200-record answer is indistinguishable
   from a complete one.
4. **Prompt argument descriptions and completions (A-25).** Prompt arguments carry only names and
   `required` flags (`src/server.ts:341-409`; measured `args [[{"name":"vin","required":false}]]`),
   and `completion/complete` with `ref/prompt` returns `{"values":[],"hasMore":false}` although the
   server knows the VIN list and the domain registry. The `charge-plan` prompt also never mentions
   `capacityKwh` or `phases`, the two inputs the planner asks for in prose
   (`src/advisor-tools.ts:92-96`).
5. **Domain availability before spending calls (A-28).** `list_domains` lists the server registry,
   not what the car reports (`src/domain-tools.ts:48-61`); support is discoverable only by one
   `DATA_NOT_AVAILABLE` per domain, so the onboarding question "which of these can my car answer?"
   costs up to 15 live calls.

## Candidate table

30 candidates. IDs match the sections above. Effort: S under a day, M about a week including tests,
L more than a week. "Risk" is the chance the fix itself regresses something.

| ID | Improvement | Category | Evidence (file:line) | User impact | Effort | Risk | Falsifiable check | MoSCoW suggestion |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A-01 | Rewrite absence as unknown, name unreported domains in `get_car_status`, carry `code: DATA_NOT_AVAILABLE` and `data.reported: false` | bug | `src/vehicle-read.ts:155-158`, `src/aggregate-tools.ts:55-76`, `:106`, `:133` | A model can answer "not locked" or "nothing wrong" from missing data | S | low | With every domain returning null, neither `is_car_secure` nor `get_needs_attention` text starts with "No"; `get_car_status` names each unreported domain; `structuredContent.code === "DATA_NOT_AVAILABLE"`. Today `J_SECURE_ABSENT` and `K_ATTENTION_ABSENT` fail it | Must: safety-relevant inversion in the two yes/no tools |
| A-02 | Register `battery-health-report` only when history tools exist, or rewrite it to name the prerequisite | bug | `src/server.ts:388-409`, `:201`, `test/server-seams.test.ts:263-275` | Default-mode models are told to call two tools that do not exist | S | low | Spawn without a history directory, `prompts/get` battery-health-report, assert every tool-shaped name is in `tools/list`. Today `UNREGISTERED=["get_degradation_report","get_charging_sessions"]` | Must: broken prompt on every default start |
| A-03 | Return an explicit no-estimate sentence and `data.estimateable`, and name the assumed 80 percent target when target-soc is absent | bug | `src/aggregate-tools.ts:170`, `:178`, `:186-191` | The tool says it will show an estimate and shows none, while a default target is presented as the car's setting | S | low | Unplugged fixture: text must never contain "showing the car's own estimate instead" without a following figure, and a missing target-soc must be disclosed as assumed; today text is 180 bytes with no number | Must: false promise in the recommended charging answer |
| A-04 | Select `RetryingTransport` independently of the cache flag | bug | `src/server.ts:78-79`, `src/config.ts:280`, `src/retrying-transport.ts:56-69`, `docs/getting-started.md:173` | A cache setting silently disables the fail-closed budget and all retries | S | low | `buildEngine` with `POLESTAR_CACHE=off`, stub 429 then 200: assert one retry and `budget.snapshot().used > 0`. Today `CACHE_OFF_RETRY off httpCalls 2 budgetUsed 0` | Must: documented quota safety property is off under a supported flag |
| A-05 | Mask the VIN in resource names, descriptions, completions, `AMBIGUOUS_VIN`, `VIN_MISMATCH`, `VIN_NOT_CHOSEN` and the elicitation enum; document the resource URI as the remaining exception (truncation breaks reads) | security | `src/server.ts:285-299`, `src/client.ts:125`, `:227`, `:246`, `src/vehicle-read.ts:94`, `:109`, `SECURITY.md:26-27` | A flag set to keep VINs out of transcripts still sends full VINs to the model | M | medium | With `POLESTAR_REDACT_VIN=1`, no non-raw JSON-RPC result matches `/[A-HJ-NPR-Z0-9]{17}/`. Today `REDACT_RESOURCE`, `REDACT_COMPLETION` and `REDACT_MISMATCH_TEXT` fail it | Must: documented privacy promise is false |
| A-06 | Compose the SDK Host and Origin guards, reject before reading the body, and add a token length floor | security | `src/server.ts:421-425`, `src/bind.ts:19-36`, `SECURITY.md:65-73` | Any web page that resolves to 127.0.0.1 can read vehicle data in the default HTTP mode | S | low | POST `initialize` with `Host: attacker.example` and `Origin: http://attacker.example` must be 401 or 403; today `HTTP_REBIND_STATUS 200` and `HTTP_REBIND_TOOLS_STATUS 200` | Must: default listener exposed to DNS rebinding |
| A-07 | Render every domain's payload in `get_history` (per-domain allowlist, or all keys when none match) | bug | `src/history-tools.ts:79-82`, `:53-54`, `docs/tools-reference.md:103` | The opt-in history feature returns no data for 10 or more of the 15 domains | S | low | Record one `charging/amp-limit` sample and call `get_history`; text must contain `ampLimit`, not `{}`. Today `L_HISTORY_AMP` shows `{}` | Must: the tool's only output is empty for most domains |
| A-08 | Return each constituent domain's age from `readDomains`, print per-domain ages and an oldest marker, and add `ageSeconds` for the aggregate | bug | `src/aggregate-tools.ts:38`, `:81-87`, `src/vehicle-read.ts:167-178`, `docs/tools-reference.md:86` | A two-year-old service countdown is presented as a one-minute-old briefing | M | low | Battery fresh plus health 400 days old: `get_car_status` must name the stale domain and the oldest age; today `G_STATUS_PARTIAL` says "Data as of 1 min ago (newest domain)" and `G_STATUS_KEYS ["ok","message"]` | Must: the recommended first tool hides staleness and unreported domains |
| A-09 | Generate the instructions from the running surface: no mandatory `list_vehicles`, mention history when enabled, conditional requestId, units and delegation | docs | `src/server.ts:207-214`, `docs/architecture.md:58` | The model is told to spend a call it does not need and to expect a field that is absent | S | low | With and without `POLESTAR_HISTORY_DIR`, the instructions must differ in the documented way and must not claim every error has a requestId; today both are 882 identical bytes and `INSTRUCTIONS_MENTION_HISTORY false` | Should: high-visibility text, cheap fix |
| A-10 | Make the security verdict include alarm state and treat absent lock fields as unknown, not unlocked | bug | `src/aggregate-tools.ts:98`, `:110-114`, `src/domain-data.ts:261-270` | A triggered alarm can be reported as "car is secure"; absent fields become "not fully locked" | S | low | `is_car_secure` with `alarm: ALARM_STATUS_TRIGGERED` must not answer "Yes, car is secure"; today `F_ALARM_TRIGGERED` fails it | Should: safety wording, narrower reach than A-01 |
| A-11 | Populate a typed `data` object on the default path for every tool and declare per-tool output shapes | missing-feature | `src/tool-output.ts:70-81`, `:84-92`, measured keys | Client developers must parse prose to render or branch | M | medium | Every tool result contains a `data` object validated by its declared output schema; today 25 of 26 tools return `["ok","message"]` style keys | Should: unlocks structured clients, larger change |
| A-12 | Send text once, send the raw payload once, share one envelope schema, and trim endpoint and scope prose to `list_domains` | perf | `src/tool-output.ts:84-92`, `:70-81`, `src/tools.ts:49`, `src/domain-tools.ts:65`, `src/vehicle-read.ts:247-256`, `src/tool-output.ts:167-178` | Every session re-pays 44,841 to 50,718 bytes before the first question, and every call pays duplicated text | M | medium | `tools/list` at 26 tools must be under 32,000 bytes, no `structuredContent.message` equals the content text, and a raw read is under 1.5 times its text bytes; today 50,718, duplicated `message`, 2,729 wire bytes for 904 text bytes | Should: large recurring cost, risk is client contract |
| A-13 | Add `before`/`offset` and a visible truncation marker with a `nextBefore` field to `get_history` | missing-feature | `src/history-tools.ts:28`, `:37-40`, `:77`, `src/history.ts:74-78` | A long history cannot be walked, and a truncated answer looks complete | S | low | Three records with `limit: 2` must include a "more available" sentence and a next pointer; today `N_HISTORY_TRUNC ... hasMoreMarker false` | Should: the first longitudinal tool needs it |
| A-14 | Guard the degradation report against zero usable points, label the session span honestly, and record and display the car's own timestamp | bug | `src/history-tools.ts:104-111`, `:155`, `src/server.ts:110-112`, `src/history.ts:216`, `src/history.ts:118-122` | An opt-in tool crashes on a valid low-SoC store and prints the wrong date for every sample | M | medium | Five samples at 3 percent SoC must return a sentence, not `isError: true`; a session with a 29 minute internal gap must not print 29 minutes as charging duration; sample time must equal the payload timestamp. Today `M_DEGRADE_LOWSOC`, `D2_SESSION` and `D1_SERIES_TIMES` fail | Should: correctness of the longitudinal answers |
| A-15 | Hour-align plan steps, normalize stop hours above 23, check time adjacency, and refuse infeasible energy | bug | `src/planner.ts:77`, `:70-73`, `:118-138` | A schedule that starts at 20:00:45.678 and delivers 20 of 100 kWh is presented as feasible | M | low | Plan with `now` at 19:23:45.678 must emit `:00` starts; a 22 to 28 window must schedule 00:00 to 03:00; a 100 kWh need with two available hours must be infeasible or state the shortfall; today `P1_PLAN_STARTS`, `P2_STOP28` and `P3_SHORTFALL` fail | Should: the advisor's core arithmetic, edge windows |
| A-16 | Reject or flag prices outside the planning window, name the cost unit, keep negative and zero costs, and return `isError` with a code for missing planner inputs | bug | `src/planner.ts:86-92`, `:140-147`, `src/advisor-tools.ts:12-14`, `:79-81`, `:125` | A feasible plan built from prices the server never used is presented as an answer | S | low | 24 prices outside 48 hours must not yield `ok: true` steps with "price unknown"; the cost line must name the caller's unit; a negative-price plan must report its cost; missing SoC must carry a code; today the past-price plan is `ok: true` and `O_NEGATIVE_COST` has no `totalCost` | Should: trust in the one advisory tool |
| A-17 | Present minted failures as server refusals, keep the code-specific hint for 403, mention requestId only when present, and stop tripling the hint | bug | `src/failure.ts:113-117`, `src/vehicle-read.ts:226-231`, `src/tool-output.ts:121-123`, `:167-178` | The model blames Polestar for local problems and asks for a handle that does not exist | S | low | `get_battery` with `AUTHZ_CLIENT_ID_MISMATCH` must mention `POLESTAR_ACCOUNT_ID`; `INVALID_VIN` must not start "Polestar API error"; the fallback hint must not name requestId when absent; the hint string appears once; today `P_403_HINT_DOMAIN`, `ERR_INVALID_VIN`, `ERR_HINT_SEEN 3` fail | Should: operator-facing misdirection, cheap fix |
| A-18 | Make every tool schema strict so an unknown key is refused with the key name | bug | `src/tools.ts:48`, `src/tool-output.ts:6-48` | A misspelled `vin` silently reads the default car and answers about the wrong vehicle | S | medium | `get_battery {"vinn":"YSMTEST22PL000002"}` must be an error naming `vinn`; today it returns the normal 161-byte answer | Should: wrong-car answer requires a model typo |
| A-19 | Validate subscribe URIs, cap subscriptions, advance the change id only after notify resolves, and guard against overlapping rounds | bug | `src/server.ts:328-335`, `src/subscriptions.ts:37`, `:55-66`, `:97-112` | A typo costs a 60 second poll, one failed notify loses a change, one cloud change can notify twice, and many subscriptions can drain quota | S | low | Garbage URI must be a JSON-RPC error; a rejected notify must be retried next round; two concurrent `pollOnce` calls must notify once; a subscription above the cap must be refused; today `SUBSCRIBE_UNPARSEABLE`, `S1_NOTIFY_FAILURE` and `S2_OVERLAP` fail | Should: subscriber-only, all defects are small |
| A-20 | Add `delegated_account_id` to `list_vehicles` and return `data: { count, vehicles }` for the empty case | bug | `src/domain-tools.ts:19-46`, `docs/tools-reference.md:21`, `test/runtime.test.ts:689-690` | A third-party credential cannot list the account it is reading and cannot branch on zero vehicles | S | low | A delegated `list_vehicles` must route through `forDelegation` and return the partner list; an empty credential must return `data.count === 0`; today `R_EMPTY_LIST` has no `data` and no declared args | Should: identity-sensitive read on the recommended first call |
| A-21 | Render or stop promising the named values, print the charge-window offset, and accept string-encoded numbers where the contract sends them | docs | `src/domains.ts:72-73`, `:98`, `:126-127`, `:152`, `:171`, `:190-191`, `:212-214`, `:236-237`, `:256`, `:281-282`, `:299`, `:317`, `src/format.ts:139-245`, `src/domain-data.ts:150`, `docs/tools-reference.md:54-67` | The model asks for a domain expecting fields the answer never shows, and a moving car's speed can print as 0 km/h | M | low | A promise-to-render test: each value named by a registry description must appear for the fixture payload, or the description must not name it; `summarizeDomain` with `speed:"55"` must print 55 km/h; the charge-window line must carry the offset. Today `SUMMARY`, `LOCATION_STRING_SPEED` and `TIMER_OFFSET` show the gaps | Should: routing and trust in the per-domain answers |
| A-22 | Page the resource list or report its cap, return an error when the vehicle list fails, use configured labels in names, and reject an unknown domain URI as an MCP error | bug | `src/server.ts:283-299`, `:309-312` | Fleet users cannot discover all their vehicles, a failed list looks like zero cars, and a bad read looks like data | M | low | 12 VINs must page or report truncation; a throwing vehicle list must be an error; names must use `POLESTAR_VEHICLE_LABELS`; unknown domain must be `-32002`; today the four probes behind D16 fail | Should: resource surface correctness bug, secondary surface |
| A-23 | Fix `polestar_status`: name `POLESTAR_CACHE`, report the skew-adjusted token life, and add structured budget counters | bug | `src/system-tools.ts:51-65`, `src/auth.ts:13`, `:76-82`, `src/config.ts:280`, `test/server-seams.test.ts:251` | An operator follows the tool's advice to a variable the server does not read, and an agent overestimates token life | S | low | Status text names `POLESTAR_CACHE`, token minutes match `expiresAt` minus 300000, and `data.budget` is present; today the text names the wrong variable and `~60 more min` for a 55 minute trust window | Could: one wrong string and a cosmetic clock, no answer changes |
| A-24 | Make capabilities and annotations honest: drop `logging` and `listChanged` or emit them, set explicit `openWorldHint` on local tools, add `idempotentHint: true` | quality | `src/server.ts:215`, `src/tools.ts:24`, `src/system-tools.ts:34`, `src/history-tools.ts:56`, `:96`, `:142` | Clients auto-approve weaker hints and wait for notifications that never arrive | S | low | `initialize` advertises no logging or listChanged capabilities that the server never sends; every tool has explicit `openWorldHint` and `idempotentHint`; today `CAPS` and `ANNOTATIONS` fail | Could: client-side hints only, no data wrong |
| A-25 | Add argument descriptions and VIN completions to prompts, and have `charge-plan` mention `capacityKwh` and `phases` | missing-feature | `src/server.ts:341-409`, `src/advisor-tools.ts:92-96` | Clients cannot complete prompt arguments, and the planner prompt sets up the same two repair turns the tool produces | S | low | `prompts/list` arguments carry descriptions; `completion/complete` for `car-status.vin` returns the VIN list; the charge-plan text names both arguments; today `PROMPT_COMPLETION` is empty and arguments carry only `name`/`required` | Could: quality of a secondary surface |
| A-26 | Repair the checks that cannot fail: build the prompt test from the running surface, add a promise-to-render map test, make the planner fallback test reach the fallback, and add resource, redaction and HTTP guard tests | quality | `test/server-seams.test.ts:263-275`, `test/contract.test.ts:50-62`, `test/planner.test.ts:125-142`, `scripts/smoke-http.ts` | Every defect above can return without a red test | M | low | The new prompt test fails on today's D5; the promise map fails on D18; the fixed planner test fails on D10; the resource and HTTP tests fail on D1, D2 and D16 | Could: house rule violation, but fixes follow the defects |
| A-27 | Add `get_charging_setup`, one cached aggregate over the seven charging settings | missing-feature | `src/aggregate-tools.ts:45-52`, `src/domains.ts:232-340` | "What is my charging setup?" costs seven tool choices and seven calls | M | low | One call returns one line per charging setting with its age and `data.settings`; a counting transport records at most seven reads and repeats cost zero; no such tool exists today | Could: real user value, but a feature after the defects |
| A-28 | Add `list_vehicle_domains`, classifying each of the 15 domains as reported, absent or failed | missing-feature | `src/domain-tools.ts:48-61`, `src/domains.ts:50-340` | The onboarding question "which of these can my car answer?" costs up to 15 failed reads | M | medium | With three domain fixtures removed, the tool reports 12 reported and 3 absent without erroring and touches 15 cache entries; no such tool exists today | Could: useful onboarding, new surface and budget cost |
| A-29 | Rename tools and titles for consistency (`get_charge_now` vs `get_charging_*`, `is_car_secure`, `polestar_status` vs `get_car_status`) | DX | `src/domains.ts:362-364`, `src/aggregate-tools.ts:35`, `src/system-tools.ts:30` | A name is confusing, but renaming breaks every saved prompt and client | S | high | All current tool names remain aliases for one release and a migration note exists; otherwise clients fail. Renaming without aliases fails a compatibility test | Won't: mechanical naming is documented, a rename is a breaking change; fix titles and descriptions instead (A-21) |
| A-30 | Drop `outputSchema`, or replace the 15 domain tools with one `get_domain(kind, name)` | perf | `src/tool-output.ts:70-81`, `src/domain-tools.ts:62-69`, `scripts/smoke.ts:56-69` | A larger saving on the tool list, bought by losing the checked contract or the per-domain routing cue | M | high | Any variant must keep a validation contract and route the five sample questions to the intended tool; today the contract test and `analysis/E-runtime.md:110-127` argue against both | Won't: shrink the list via A-12 instead, not by deleting the contract or the routing surface |

## Rejected ideas

- **Mask the resource URI by truncating the VIN.** `src/server.ts:306-319` feeds the URI's VIN back
  through `resolveVin`, which rejects anything not 17 characters (`src/client.ts:7`,
  `:106-116`), so a masked URI would turn every resource read into `INVALID_VIN`. A correct fix
  needs an opaque handle mapped server-side (effort M, changes subscription identity), which is a
  separate design from the mask-everywhere-else fix in A-05.
- **Mask only the URI and leave names and completions raw.** This is the current state, and it is
  the leak in D1. Either the flag is a display control with the URI documented as an exception, or
  the resource surface gets a handle. A per-path exception is defensible; an undocumented one is
  not.
- **Add write tools.** The documented v1 API has no write endpoint (`docs/upstream-api.md:98-100`),
  `POLESTAR_ENABLE_WRITES` deliberately registers nothing (`src/server.ts:220-224`), and
  `test/posture.test.ts:25-39` holds the posture. Out of scope until Polestar publishes writes.
- **Fetch spot prices inside `plan_cheapest_charge`.** It would fix the timestamp mismatch from the
  other side, but it adds third-party egress to a server whose stated property is "no third-party
  call" (`SECURITY.md:47-51`), and the tool's design keeps prices as an argument
  (`src/advisor-tools.ts:30-36`). Fix A-16 instead.
- **A subscription for every domain, or aggregate resources that poll five domains.** One poll per
  minute is 1,440 calls/day; six subscriptions exceed 86 percent of the shared 10,000/day allowance
  before a user asks anything (`src/subscriptions.ts:36`, `analysis/A-surface.md:502-505`). Keep
  subscriptions on-demand and fix their lifecycle (A-19).
- **Cancellation and progress notifications for the multi-domain aggregates.** The information is
  real (`src/tool-output.ts:181-193` claims `mcpReq` carries a signal it does not type or read), but
  it is invisible to the user, needs transport-wide abort plumbing, and the council product seat
  kills it as not a reason to use the product (`analysis/council/R1-product.md:62`). Recorded here
  rather than as a candidate.
- **A general `get_domain(kind, name)` tool, or dropping `outputSchema` to shrink the list.** See
  A-30: the first trades measured tokens for measured misrouting, the second deletes the checked
  contract the smoke run and clients rely on (`scripts/smoke.ts:56-69`). A-12 recovers most of the
  bytes without either loss.

## Commands run

All commands ran from `/Users/nicolaskheirallah/Documents/GitHub/polestar-mcp`. Fixture mode only;
no live credential was read or written. Where a probe needed a one-off fixture or HTTP port, the
probe carried its own fake engine or a throwaway loopback port; no file in the tree was written.

1. `node --version && npm --version && npm test` (tail):
   `# tests 111`, `# pass 111`, `# fail 0`.
2. `node docs/check-docs.mjs tools` -> `DOCS_TOOLS_OK tools=26 domains=15`.
   `node docs/check-docs.mjs envvars` -> `DOCS_ENVVARS_OK`.
   `node docs/check-docs.mjs links` -> `DOCS_LINKS_OK`.
3. `npm run check-tool-refs` ->
   `TOOL_REFS_OK 26 registered names, 27 instruction-surface files scanned, 0 undefined names referenced`.
4. Inline stdio harness (`node --import tsx --input-type=module -` importing
   `scripts/stdio-client.ts`, spawning `src/server.ts` with `POLESTAR_FIXTURES_DIR=test/fixtures/dump`):
   - `TOOLS 23 bytes 44841 descBytes 5164 outSchemaBytes 23207`
   - `PROMPT battery-health-report ... UNREGISTERED ["get_degradation_report","get_charging_sessions"]`
   - `CALL get_charging_estimate ... keys ["ok","message"] textBytes 180`
   - `CALL get_battery {"vinn":"YSMTEST22PL000002"} isError false ... textBytes 161`
   - `CALL get_battery {"raw":true} ... textBytes 904 wireBytes 2729`
   - `PLAN past isError false ok true ... (price unknown)`
   - `RESOURCE_UNKNOWN_DOMAIN {"result":{"contents":[...]}}`
   - `SUBSCRIBE_UNPARSEABLE {"result":{}}`
5. Same harness with `POLESTAR_HISTORY_DIR` set (directory never created; confirmed absent after
   the run): `HISTORY_TOOLS 26 bytes 50718 hasHistory true`,
   `INSTRUCTIONS_MENTION_HISTORY false`, `PROMPT_H battery-health-report unregistered []`.
6. Inline fake-engine harness over `InMemoryTransport` and `createMcpServer`:
   `A_RESOURCES_12VIN count 150 distinctVins 10 nextCursor undefined`;
   `B_RESOURCES_FAILURE {"result":{"resources":[]},"jsonrpc":"2.0","id":2}`.
7. Inline HTTP probe (spawn `src/server.ts` in fixture mode with `POLESTAR_HTTP_PORT`, POST over
   `node:http`): `HTTP_REBIND_STATUS 200`, `HTTP_REBIND_TOOLS_STATUS 200`,
   `HTTP_HOST_HEADER_STATUS 200`,
   `HTTP_CAPABILITIES {"resources":{"subscribe":false,"listChanged":true},"logging":{},...}`,
   `HTTP_SUBSCRIBE 200 {"error":{"code":-32601,...}}`.
8. Inline unit harness over `aggregateToolSpecs`, `advisorToolSpecs`, `historyToolSpecs`,
   `toolSpec` with scripted clients and stores:
   - `F_ALARM_TRIGGERED "Yes, car is secure (locked, all closed). Alarm: triggered."`
   - `PARTIAL_EXTERIOR "No, not fully locked."`
   - `G_STATUS_PARTIAL "... Data as of 1 min ago (newest domain)."`, `G_STATUS_KEYS ["ok","message"]`
   - `H_ESTIMATE`, `I_ESTIMATE_NO_TARGET` identical without a reported target
   - `J_SECURE_ABSENT`, `K_ATTENTION_ABSENT`, both `ok: true`
   - `P_403_HINT_DOMAIN`, `P_403_HINT_AGGREGATE`
   - `Q_PLAN_MISSING "Missing required data ..." ok true`
   - `R_EMPTY_LIST "This credential is not authorized for any vehicle." ... declaredArgs undefined`
   - `L_HISTORY_AMP "2026-11-01T00:00:00.000Z {}\n2026-11-01T01:00:00.000Z {\"odometerMeters\":12345}"`
   - `M_DEGRADE_LOWSOC isError true code INTERNAL_ERROR ...`
   - `N_HISTORY_TRUNC ... hasMoreMarker false`
   - `O_NEGATIVE_COST {"feasible":true,"steps":2}` (no `totalCost`)
9. Inline subscription and planner harness:
   `S1_NOTIFY_FAILURE notified []`, `S2_OVERLAP notified 2`,
   `P1_PLAN_STARTS ["2026-11-09T20:00:45.678Z","2026-11-09T21:00:45.678Z"]`,
   `P2_STOP28 {"feasible":true,"reason":"Window too short ...","steps":2}`,
   `P3_SHORTFALL {"feasible":true,"energyNeededKwh":100,"hoursNeeded":10,"steps":2,"planned":20}`,
   `D1_SERIES_TIMES ["2026-11-09T12:00:00.000Z",...] payloadTimestamp 2026-09-18T11:00:00.000Z`,
   `D2_SESSION ... activeSeconds:1740`.
10. Inline `buildEngine` probe with stub `globalThis.fetch` and a 429 then 200 sequence:
    `CACHE_OFF_RETRY on httpCalls 4 budgetUsed 4 outcome ["YSMTEST22PL000001"]`;
    `CACHE_OFF_RETRY off httpCalls 2 budgetUsed 0 outcome ERR PolestarApiError: Request failed (HTTP 429).`
11. Inline `planCheapestCharge` replay of `test/planner.test.ts:125-142`:
    `PLANNER_TEST_SCENARIO {"feasible":true,"steps":1,"testAssertionWouldPass":true}`.
12. Inline summary harness over the shipped fixtures:
    `SUMMARY amp-limit ["AC charge current limit: 20 A"]`; `SUMMARY health ["Service in 313 days / 4150 km","No warnings"]`;
    `SUMMARY global-charge-timer ["Charge window: 23:00 → 6:00 (defined but inactive)"]`;
    `TIMER_OFFSET {"offsetMinutes":120}`; `LOCATION_STRING_SPEED [... "heading 121°, 0 km/h"]`.
13. Real-server redaction probe with `POLESTAR_REDACT_VIN=1`:
    `REDACT_RESOURCE {"uri":"polestar://vehicle/YSMTEST22PL000001/telemetry/availability",...}`;
    `REDACT_COMPLETION {"completion":{"values":["YSMTEST22PL000001"],...}}`;
    `REDACT_MISMATCH_TEXT "Polestar API error VIN_MISMATCH (HTTP 200): Requested YSMTEST22PL000002 but ... labelled YSMTEST22PL000001."`;
    `REDACT_LIST ... "YSM…001"` (the masked path works).
14. Real-server invalid VIN and unknown arguments:
    `ERR_INVALID_VIN ... "Polestar API error INVALID_VIN (HTTP 400)..."`,
    `ERR_HINT_SEEN 3 wireBytes 786`,
    `CALL get_battery {"tyre":1} isError false`.
15. `node docs/check-docs.mjs hygiene` -> `HYGIENE_NO_EM_DASH`, `HYGIENE_BUZZWORDS_CLEAN`,
    `HYGIENE_NO_BANNERS`, `HYGIENE_NO_DASH_CONNECTORS`, `HYGIENE_CLEAN` (run after this file was
    written; the same four detectors also pass on the whole tree).
