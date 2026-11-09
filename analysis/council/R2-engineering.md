# R2. Engineering feasibility and maintenance cost

Seat R2 of the council for `polestar-mcp` 0.3.0. This review reads the brief, the five area
reports (`analysis/A-surface.md`, `B-intelligence.md`, `C-platform.md`, `D-ecosystem.md`,
`E-runtime.md`) and the lead report, then re-derives the load-bearing claims against the
checked-out source. No live Polestar credential was used, no write was attempted, and no file
outside this report was modified. All probes ran in fixture mode against
`test/fixtures/dump` or against a local stub HTTP server on loopback, and the commands and
observed lines are reproduced below.

The seat's question is not "is this useful" but "can this repository carry it". The answers are:
most of the reported defects are real and cheap, three of them are misdiagnosed in ways that
change the fix, one candidate class (multi-vehicle and distribution) cannot be tested in this
tree without new fixture infrastructure, and the largest single hidden cost is the value clock,
not any feature on the list.

## 1. Verification log

Thirty-eight claims were checked. Thirty-three are confirmed (one with a corrected count, one
with misframed evidence), one is confirmed in mechanism but overstated as written, and four are
wrong as written or as scoped. Four further items are effort or feasibility judgments rather than
facts and are listed under dissent. The commands named as `harness` below are one-off
`node --import tsx --input-type=module -` scripts that spawn `src/server.ts` through
`scripts/stdio-client.ts` with `POLESTAR_FIXTURES_DIR=test/fixtures/dump`; they write nothing.

| # | Claim and origin | Verdict | Evidence |
| --- | --- | --- | --- |
| V1 | E1: the 26-tool list is 50,718 bytes and 51.7 percent of it is one output schema copied 26 times (E-runtime.md:51) | confirmed | harness with a temp `POLESTAR_HISTORY_DIR` printed `HISTORY_TOOLS count=26 resultBytes=50718 outBytes=26234 outSharePct=51.7` and `distinctOutSchemas=1 oneOutSchemaBytes=1009`. The 23-tool default is 44,841 bytes and 51.8 percent. The schema itself is `src/tool-output.ts:70-81`, applied at `src/tools.ts:49` |
| V2 | E3: result text is duplicated in `structuredContent.message`, 44.3 percent over 20 measured calls (E-runtime.md:95) | confirmed in mechanism, overstated in generality | `src/tool-output.ts:90` sets `message: content`; in my own 20-call set, 20 of 20 results carried `structuredContent.message === content[0].text` and the duplicated share by E3's own formula was 37.1 percent. The raw call reproduced the report exactly: 904 text bytes plus a 1,734-byte envelope, 1,560 duplicated of 2,638, 59.1 percent. The 44.3 percent is a property of that call sample, not of the server |
| V3 | C1 premise and lead P0-1: the cache is keyed on the URL alone, so a delegated read can be answered from the owner's entry (C-platform.md:164-166, lead-report.md:72) | confirmed | `src/caching-transport.ts:83` (`const key = url`), headers at `src/client.ts:193-199`, one shared transport at `src/client.ts:85-88`. A stub probe printed `DELEGATION owner=["YSMTEST22PL000001"] partner=["YSMTEST22PL000001"] stubVehicleHits=1`: the partner read was the owner's cached list. Note the attribution: this premise belongs to C12 and lead item 1, not to C1 |
| V4 | C1: `POLESTAR_CACHE=off` removes `RetryingTransport`, which is the only budget and minute meter (C-platform.md:9-13, 308-316) | confirmed | `src/server.ts:78-79` composes the retry wrapper only when neither fixture mode nor `cacheDisabled` is set; `budget.consume()` and `minute.consume()` exist only in `src/retrying-transport.ts:56-68`. `buildEngine` probe printed `CACHE_OFF budgetUsed=0 minuteUsed=0 stubHits={token:1,vehicles:0,battery:2}` against `CACHE_ON budgetUsed=2 ... battery:1`. With `POLESTAR_BUDGET=2` and the cache off, three calls went out and none threw |
| V5 | B1: `get_charging_estimate` returns no number on the reference car (B-intelligence.md:41, 62) | confirmed | tool call text: `Usable-energy data not reported; showing the car's own estimate instead.` plus assumptions only. `src/aggregate-tools.ts:155` has no `capacityKwh` argument, `:188` prints the fallback sentence, `:190-191` prints the car's own estimate only when it is above zero, and the fixture value is 0. `src/charge-model.ts:61-70` derives capacity only from `dischargeInfo.energyAvailable`, which the fixture lacks |
| V6 | B1: the fixture implies a 65.71 kWh pack | confirmed | 170 km times 20.1 kWh/100 km is 34.17 kWh remaining, divided by 0.52 is 65.71 kWh (`test/fixtures/dump/dataportal/telemetry/battery.json`). `chargeModel` on the same fixture shape returns `powerKw` 13.8 but no `capacityKwh`, which is why V5 happens |
| V7 | B2 premise and lead P1-3: a stop hour above 23 collapses the planner window to one hour per night (B-intelligence.md:99, lead-report.md:108) | confirmed defect, evidence misframed | `src/planner.ts:70-73`: with start 23 and stop 28 the non-wrap branch tests `localHour < 28`, and `localHour` is always 0 to 23. Direct probe returned two steps at 23:00 on consecutive days. The report's evidence is `test/charge-model.test.ts:26`, which is an estimator payload; the planner's own tests use 23 to 6 (`test/planner.test.ts:114-115`). Whether the live API ever reports 28 is not verified here, and the shipped fixture reports 6 |
| V8 | B2/E6: block selection indexes the filtered slot list, so a cross-night plan is reported as contiguous (B-intelligence.md:100, E-runtime.md:317-320) | confirmed | Direct probe at 20 to 100 percent, 4.6 kW, window 23 to 6: 14 steps, gaps `[1,1,1,1,1,1,18,1,1,1,1,1,1]` hours, `reason` undefined. `src/planner.ts:118-125` chooses a slice of `rated`, not neighbours in time |
| V9 | B2: cost spreads energy evenly over rounded-up hours and a negative price loses the cost line (B-intelligence.md:102) | confirmed | `src/planner.ts:132-140` divides `energyNeededKwh` by `hoursInt`; `:147` includes `totalCost` only when positive. Probe: negative prices gave `totalCost=undefined`, `hasCostField=false`. Anchored tool call gave `Estimated cost: 2.73`; the true cost charging from the block start is 2.586, so this sample is 5.4 percent high rather than the report's 12.5 percent, which used a different price pair |
| V10 | E6: prices outside the 48-hour match window produce `ok: true`, `price unknown`, no cost (E-runtime.md:191-209) | confirmed | tool call with 24 prices dated February 2026 returned `isError=false`, `(price unknown)` on every step, no cost line, and the non-contiguous note. `src/planner.ts:86-92` matches only prices whose start falls in the slot hour. A 15-minute curve is mispriced by the same `find`: my probe returned a step at 00:00 priced 0.2 while the price at 00:00 was 0.1 |
| V11 | B7: `get_history` prints `{}` for domains whose payload has no kept field (B-intelligence.md:65, 186-190) | confirmed with a corrected count | Recorded all 15 domains then queried each. 11 of 15 printed `{}` (availability, exterior, health, location, parking-climatization, amp-limit, charge-locations, charge-now, global-charge-timer, parking-climate-timer, target-soc), 3 rendered data (battery, odometer, pre-cleaning), and `is-at-charge-location` recorded no row at all. The filter is the five names at `src/history-tools.ts:80-81`; an absent domain is not recorded because `src/client.ts:150-152` returns null before `onDomainRead` |
| V12 | B7: the record clock is the read clock (B-intelligence.md:83, 111) | confirmed | `src/server.ts:110-111` appends `observedAt: Date.now()`. A recorded battery line had `observedAt` 2026-11-05T21:28:38.418Z against payload `metaReceivedAt` 2026-09-18T11:10:55.531Z, a gap of 48.43 days; `src/history.ts:16` documents the field as the server's observation time |
| V13 | A5 and lead P0-3: redaction masks tool output but not resource URIs or completions (A-surface.md:348-355) | confirmed | With `POLESTAR_REDACT_VIN=true`: `resources/list` returned `polestar://vehicle/YSMTEST22PL000001/telemetry/availability`, `resources/read` echoed the full URI, `completion/complete` returned `["YSMTEST22PL000001"]`, while `get_battery` and `list_vehicles` masked. Registration at `src/server.ts:283-287` and `:306-320`; the tool-side mask is `src/vehicle-read.ts:279` |
| V14 | A4 and lead P1: `battery-health-report` names two tools the default surface does not register (A-surface.md:260-268) | confirmed | `prompts/get` returned `call get_degradation_report and get_charging_sessions`; the default 23-tool list lacks both; `npm run check-tool-refs` printed `TOOL_REFS_OK 26 registered names, 27 instruction-surface files scanned, 0 undefined names referenced`. The prompt is registered unconditionally at `src/server.ts:240`, history tools only with a store at `src/server.ts:201` |
| V15 | C5 and lead P1-10: loopback HTTP accepts an attacker Host and Origin | confirmed | `POST /` with `Host: attacker.example` and `Origin: http://attacker.example` returned 200 with the full `tools/list`; a request with no Origin also returned 200; `GET /` returned 406. `src/server.ts:421-425` checks only the bearer token, which is empty by default on loopback |
| V16 | B2: charging sessions carry no energy (B-intelligence.md:63) | confirmed | `src/history.ts:117-126`: `ChargingSession` has start, last seen, active seconds, peak power, max SoC and sample count, no kWh |
| V17 | C2: the daily budget is per process, not per credential (C-platform.md:243-246) | confirmed | `src/budget.ts:31-41` is memory only and `src/server.ts:66-67, 555` builds it per engine per process. One-liner: two meters with limit 3 each consumed 6 calls combined and both threw on the seventh |
| V18 | C3: a `DATA_NOT_AVAILABLE` 404 is never cached (C-platform.md:255-258) | confirmed | One-liner: two reads of a 404 body gave `inner_calls_404=2`; three reads of a 200 body gave `inner_calls_200=1`. `src/caching-transport.ts:113-115` stores only status below 400; `src/client.ts:150-152` maps the 404 to null |
| V19 | C8: an HTTP-date `Retry-After` is ignored (C-platform.md:173-175) | confirmed | One-liner with a 429 whose header was a UTC date 30 seconds out printed `waits=[500]`. `src/retrying-transport.ts:88-93` parses only a number |
| V20 | C10: subscriptions accept malformed VINs, have no cap, can double-notify, and lose a failed notification (C-platform.md:182-193) | confirmed by code | `src/domains.ts:390` and `:416-423` accept any non-slash VIN segment; `src/client.ts:136-148` does not validate the VIN; `src/subscriptions.ts:39` has no cap; `:44-47` starts a round with no running guard; `:105-108` stores the new id before awaiting notify |
| V21 | B2 design chapter: the humanized age uses the receive clock for settings instead of the value's own clock (B-intelligence.md:111) | confirmed | `src/domain-data.ts:120-132` reads top-level `timestamp.seconds` then `metaReceivedAt`, never nested `updatedAtTimestamp`. Fixture arithmetic: global charge timer own clock 2026-08-16T18:39:14Z against receive 2026-09-10T10:16:55Z (24.65 days); amp limit 22.90 days; climate timer 88.44 days |
| V22 | P0-4 and A: absence reads as a negative and aggregates hide missing domains (lead-report.md:75, A-surface.md:225-228) | confirmed | With exterior and health fixtures set to `DATA_NOT_AVAILABLE`, `is_car_secure` returned only `No exterior data is available for vehicle ...` with `isError=false`, and `get_car_status` printed a partial briefing with no mention that two domains were absent. Sentence at `src/vehicle-read.ts:155-158`; aggregate silent omission at `src/aggregate-tools.ts:55-76`; newest-only age at `:81-87` |
| V23 | A3: `get_car_status` prints the newest domain's age and therefore hides a stale one (A-surface.md:328-335) | confirmed by code | `src/aggregate-tools.ts:86` uses `Math.max(...ages)` and labels it newest. My absent-domain run printed `Data as of 48 d ago (newest domain).` while two constituent domains had no age at all |
| V24 | A report count: "11 of the 15 domain descriptions name at least one dropped field" (A-surface.md:54-55) | wrong count, right mechanism | The report's own table (A-surface.md:61-72) lists 12 rows, and source inspection gives 12: battery, exterior, health, location, odometer, parking-climatization, pre-cleaning, amp-limit, global-charge-timer, parking-climate-timer, target-soc, charge-locations. The prose number is one low |
| V25 | A5's proposed fix: "stop returning full VINs from `resources/list`" (A-surface.md:448-453) | wrong as scoped | `src/server.ts:306-317` reads `variables.vin` from the URI and passes it to `readDomain`; `src/client.ts:107-116` rejects anything that is not a 17-character VIN. A masked URI would make every listed resource unreadable and unsubscribable. The fix needs an opaque handle or a documented URI exception |
| V26 | E1's check: after sharing the schema, `tools/list` is "at most 28,000 bytes" (E-runtime.md:280) | wrong target | Measured parts: 50,718 total minus 26,234 output bytes plus 26 times a 288-byte compact schema is 31,972 bytes. E1 alone cannot reach 28,000; the lead's 25,300 projection (lead-report.md:124) assumes E2 and argument-description trims as well |
| V27 | E9: an unknown tool error should name valid tools (E-runtime.md:288) | wrong as a fix, confirmed as a symptom | Measured `{"code":-32602,"message":"Tool get_tyre_pressure not found"}`. The message is thrown inside the SDK at `node_modules/@modelcontextprotocol/server/dist/mcp-oHn3ureC.mjs:1605`; no hook appears in the public type surface, so the server cannot add a hint without patching or wrapping the SDK |
| V28 | E8 and lead P1-7: unknown arguments are silently dropped | confirmed | `get_battery` with `{"vinn": ...}` returned the normal answer with `isError=false`; the SDK parses against the declared zod shape and drops extras |
| V29 | A and C: the default structured result carries no `data` except `list_vehicles` | confirmed | `get_battery` structured keys were `["ok","message","vin","tool","ageSeconds"]`; `list_vehicles` had `data`. `src/tool-output.ts:75` declares `data` as `z.unknown()` and `src/vehicle-read.ts:272-283` deliberately omits it |
| V30 | C11 and D5: the server negotiates the 2025 line only | confirmed | `initialize` asking `2026-07-28` answered `2025-11-25`; `server/discover` returned `-32601`; instructions are 882 bytes. The installed SDK constant is `LATEST_PROTOCOL_VERSION = "2025-11-25"` (`node_modules/@modelcontextprotocol/core/dist/schemas-DscsoNZN.mjs:4`), so C-platform's sentence that the SDK "implements the 2026-07-28 revision" (C-platform.md:58-59) is wrong, and D-ecosystem's hybrid reading is right |
| V31 | C2: a second process starts the meter at zero and can exceed the documented limit | confirmed by code and V17 | No persisted state exists anywhere in `src/budget.ts` |
| V32 | D1: the package is unpublished, the registry has no entry, and `server.json` fails the current schema | confirmed | `curl https://registry.npmjs.org/polestar-mcp` returned 404; the MCP registry search returned `{"servers":[],"metadata":{"count":0}}`; `server.json` declares `$schema` 2025-12-01 and that URL returned 404; the 2025-12-11 schema's `definitions.Package.required` is `["registryType","identifier","transport"]`, while `server.json:10-24` uses `name` and `version`, and the version appears twice at `:9` and `:14` |
| V33 | D3 and the brief: the packed package excludes the fixture dump | confirmed | `package.json` `files` lists build, README, LICENSE, .env.example, SECURITY, CONTRIBUTING, CHANGELOG; `test/` is excluded |
| V34 | E-runtime and lead P2: `npm run demo-dump` fails on a clean checkout | confirmed | `npm run demo-dump` exited 1 with `DUMP_FAILED: expected captured dump at .../GitHub (dataportal/vehicles.json not found)`. `scripts/demo-dump.ts:14` resolves the parent of the project and `:16-19` refuses before reading `POLESTAR_FIXTURES_DIR` |
| V35 | Lead P0-5: the coverage gate cannot fail | confirmed by code | `package.json` `coverage` is `--experimental-test-coverage` with no threshold flags; CI runs that script and nothing asserts a number |
| V36 | B5: health is not sampled and the sampler derives its set from the registry | confirmed | `src/domains.ts:129-130` has `sampled: false`; the four sampled rows are at `:75`, `:100`, `:154`, `:173`; `src/sampler.ts:126` builds from `SAMPLED_DOMAINS` |
| V37 | B12 and D9: fixture mode cannot serve two VINs differently | confirmed | `src/transport.ts:100-102` resolves `dataportal/{kind}/{name}.json` with no VIN segment, so every VIN reads the same file |
| V38 | C4 and D: the container and registry story is unbuilt and unvalidated | confirmed by code | `Dockerfile` has no `USER`, `HEALTHCHECK`, `EXPOSE` or `.dockerignore`; `.github/workflows/ci.yml` has no Docker build and no publish job; nothing reads `server.json` (`grep -rn "server.json" scripts/ test/ docs/ .github/ package.json` returns nothing) |

Not verified, and recorded rather than chased: the live API's charge-window hour convention (V7),
whether the npm name is available for the project (the 404 proves unpublished, not reserved), the
real-world accuracy of geofence and degradation rules (V37 and B11), the SDK's ability to serve
the 2026-07-28 era (V30), and every external directory or protocol-policy claim in D that needs a
live client to exercise. These are marked needs-evidence where they gate a candidate.

## 2. Architecture fit

The repository's design constraints are unusually explicit, which makes "does it fit" decidable
rather than a matter of taste.

- **One deep module plus thin tools.** `docs/architecture.md:7` and `src/client.ts:63-72` put
  token lifecycle, headers, envelope unwrapping, identity checks and error normalization behind
  `vehicles()` and `domain()`. Tools are spec values with a `run` body (`src/tools.ts:18-31`), so
  a tool body is prose plus readers, not protocol.
- **The registry is the one list.** `DOMAINS` (`src/domains.ts:50-340`) is the author of route,
  scope, description, TTL, sampling and pinned fixture keys; tool names derive from it
  (`:362-364`), the route grammar does (`:346-360`), the cache TTL does
  (`src/caching-transport.ts:40-44`), the sampler does (`src/sampler.ts:126`), and resource URIs
  do (`src/domains.ts:404-423`). A candidate that adds a second list is a defect by definition;
  a candidate that adds one row plus a renderer plus tests is the intended extension.
- **Read only by construction.** The API publishes no write endpoint, `POLESTAR_ENABLE_WRITES`
  registers nothing (`src/server.ts:220-224`), and `test/posture.test.ts` holds both statements.
  None of the 52 candidates needs a write path, so the posture is not a constraint on the list;
  it is a constraint on two of them indirectly (B11 privacy, D7 network egress).
- **Every claim needs something that can fail.** AGENTS.md and the brief. This is where several
  existing checks already fall short of their own claim, and the candidates that lean on those
  checks inherit the weakness: `test/server-seams.test.ts:263-284` checks prompt tool names
  against the 26-tool union rather than the running surface (that is why A4 survives `npm test`);
  `test/contract.test.ts:50-62` checks description promises with one regex and only against the
  pinned fixture keys, not against the humanized output; `test/runtime.test.ts:345-365` checks
  redaction of the tool envelope only, not resources or completions; `package.json` has no
  coverage threshold (V35); `npm run check-tool-refs` builds the history family unconditionally
  and prints `TOOL_REFS_OK` while the default prompt surface is broken (V14).

### Module and test map

This is the home of every candidate that survives, and the test that makes it falsifiable. It is
grouped by module so the cost of a candidate is the cost of editing that module plus its test.

| Module | Candidates | Test file that must exist or change |
| --- | --- | --- |
| `src/server.ts` composition and surface | C1, C5, C4, C6, A4, A6, E10, D3 | `test/server-seams.test.ts`, `test/runtime.test.ts`; new `test/surface-composition.test.ts` for the 23-or-26 question |
| `src/caching-transport.ts` | C3, C9 (cache half), C7 (refresh ownership), C12 | `test/runtime.test.ts` cache tests; new counting-transport tests |
| `src/retrying-transport.ts` | C8, C1 (metering half), C7 (sleep abort) | `test/runtime.test.ts:86-124` |
| `src/budget.ts` | C2, C1 | `test/runtime.test.ts:70-105`; new two-engine ledger test |
| `src/charge-model.ts` | B1, E5, E4 (ETA half), B3 | `test/charge-model.test.ts`; add the fixture-backed capacity and phase cases |
| `src/planner.ts` | E6, B2 premise, B3 (window), stop-hour normalization | `test/planner.test.ts`; add stop 28, cross-night gap and out-of-window price cases |
| `src/domain-data.ts` | A3, B7 (clock), A2 (readers), B1 (capacity input), B10, B5 | `test/planner.test.ts` reader tests; new `test/clock.test.ts` |
| `src/format.ts` | A2, E4, E5, E7 | `test/contract.test.ts`, `test/planner.test.ts`; new promise-to-render map test |
| `src/tool-output.ts` and `src/tools.ts` | A1, E1, E3, E8, D6 | `scripts/smoke.ts:61-67`, `test/runtime.test.ts`; new `test/surface-budget.test.ts` |
| `src/domain-tools.ts` and `src/domains.ts` | E2, A8, B5 (one row), E7, D6 | `test/contract.test.ts`, `test/config-registry.test.ts` |
| `src/history.ts` | B5, B6, B7, B10, B2 (session energy), B4, B9 | `test/planner.test.ts` history tests; new `test/history-analytics.test.ts` |
| `src/history-tools.ts` | B7, B2, B6, B8, B9, B10, E10 | same new analytics test, plus `test/runtime.test.ts` history query test |
| New pure module beside `src/history.ts` | B11 (`geofence.ts`), B3 (`departure.ts`), B6 (`trips.ts`), B2 (`cost-ledger.ts`) | one new test file each, all clock-injected |
| `src/aggregate-tools.ts` | A3, E4, E5, A8 (composition), B8 (status seed) | `test/runtime.test.ts`, `test/charge-model.test.ts` |
| `src/advisor-tools.ts` | A7, E6, B3, B1 | `test/charge-model.test.ts`, `test/planner.test.ts`; new two-client elicitation test |
| `src/vehicle-read.ts` | A3, A5, A7 | `test/runtime.test.ts:345-365`, `:782-803` |
| Packaging, CI and docs | D1, D3, D4, D2, D5/C11, D9 (doc half) | `scripts/smoke.ts`, `scripts/smoke-bin.ts`, `.github/workflows/ci.yml`, `docs/check-docs.mjs` |

Two structural notes that decide several verdicts. First, the resource surface is not a thin
alias of the tool surface: the resource read calls `readDomain` (`src/server.ts:317`) and the
template identity is the URI, so any candidate that changes identity (A5) or adds resources (A6,
D8) is touching a second protocol contract, not one. Second, fixture mode has one payload per
domain for every VIN (`src/transport.ts:100-102`), so any candidate that is only meaningful with
two vehicles (B12, D9) needs new fixture infrastructure before its first test, which is why both
are L even where the code looks small.

### Falsifiability gate

Every candidate was tested against three questions: can its promised check fail, does it need a
write endpoint (none does), and does it add a dependency whose failure is observable in this
tree.

Killed:

- **B12 multi-vehicle comparison.** The check cannot run in fixture mode without a per-VIN dump
  layout (V37), the user is a single-car owner per the brief, and a "health" comparison has no
  denominator because the API reports no nominal capacity. Revisit only with a second car and a
  fixture rewrite.
- **D7 spot-price provider.** It adds third-party egress and a provider key to a server whose
  security posture is "only the Data Portal and the token endpoint" (`SECURITY.md`), and the
  failure that matters (a wrong price produces a confidently wrong schedule) is not observable
  from a recorded fixture, only the parser is. The useful part (persisting a caller-supplied
  curve) belongs in B2, not in a network adapter.
- **D8 MCP Apps view.** The claim that matters ("the chart renders in a host that supports it")
  cannot fail anywhere in this repository; the only in-tree assertion is that a tool declares
  `_meta.ui.resourceUri` and returns HTML, which is not evidence the extension works. It also
  depends on history being enabled.
- **D10 self-hosted OAuth connector.** A public listener with per-user credential storage changes
  the trust boundary that `SECURITY.md` and `test/posture.test.ts` protect. No part of the
  end-to-end check (a Claude custom connector completing the flow) can run here.
- **E9 unknown-tool guidance.** The error is SDK-owned (V27). The test is writable and would fail
  today, but the fix is not available through the registration API, so it is not a candidate, it
  is an SDK request.

Downgraded or rescoped:

- **A5 redaction consistency** cannot mask resource URIs without a handle map (V25). Rescope to
  names, descriptions, completions and error messages now, and make the URI rule an explicit
  documented exception or a separate handle design.
- **E1 shared output schema** is a real one-file change but its stated byte target is wrong (V26).
  Rescope to a compact inline schema with no `$ref` (client `$ref` support is untestable here)
  and a recomputed target.
- **E3 send text once** is falsifiable, but removing `message` is a contract break for
  structured-only clients and contradicts the current declared schema and `scripts/smoke.ts`.
  Keep only if the envelope change is made once, with A1 and E1, and with a documented client
  decision.
- **A1 per-tool output schemas** is two changes of very different cost: populating `data` from the
  readers already in `domain-data.ts` is cheap and testable; declaring 23 per-tool schemas is a
  new maintained contract with SDK validation failures on every drift. Split.
- **C4 packaging and health** splits into a testable half (health endpoint, version consistency,
  Docker build, CI healthcheck) and a release half (npm and registry credentials) that cannot be
  observed in CI.
- **C9 stale bound and pruning** splits: a `DATA_STALE` verdict is testable; pruning deletes
  user data and needs an explicit operator decision and a recovery story.
- **A6 aggregate resources** splits: the listing honesty defects (10-VIN cap, silent empty catch)
  are S fixes; a status resource is a new surface that mixes several domains and must not be
  subscribed, because one subscription already costs 1,440 calls a day.
- **D9 fleet story** splits: the documentation half is S and testable as a doc check; the
  multi-vehicle read is B12 and dies with it.
- **B9 service forecast** is a small function with low standalone value; merge into B6 or B8
  rather than maintain a single-purpose tool.
- **E10 history cost** is the same fix as A4 and D6 (conditional registration plus instructions);
  merge.
- **E7 vocabulary** is cheap, but its check is a lexical ranker, not a model, so it is a proxy.
  Keep it as a description-quality test, do not claim routing improvement from it.
- **C11 and D5** are one protocol-conformance project. The dependency is the installed SDK, whose
  negotiated constant is 2025-11-25 (V30); the candidate is needs-evidence until an SDK or
  handler path that can serve 2026-07-28 is demonstrated.
- **C12 fleet mode and B11 geofence** are needs-evidence on demand and privacy respectively. Both
  have writable tests; neither has a user or a review in this round.

## 3. Scored table

Scores are 1 to 5. Architecture fit rewards the one-deep-module design, the registry as one
source of truth, read-only posture and a check that can fail. Testability rewards a check this
repository can run offline, deterministically, from fixtures or pure inputs. Effort is S under a
day, M about a week including tests, L more than a week. Verdict is keep, merge, split, defer,
needs-evidence or kill.

| id | fit | test | effort | verdict | reason and home |
| --- | --- | --- | --- | --- | --- |
| A1 | 3 | 5 | L | keep, split | Data from existing readers fits `domain-data.ts`; 23 per-tool schemas are a new contract. Split at `tool-output.ts` |
| A2 | 5 | 5 | M | keep | `format.ts` is the render home; needs a promise-to-render map test. Report effort S is too low |
| A3 | 5 | 5 | M | keep | `readDomains` throws timing away; the age line is in `aggregate-tools.ts`. Prerequisite for every longitudinal item |
| A4 | 4 | 5 | S | keep | Gate prompts by the surface actually built; `test/server-seams.test.ts:263-284` currently checks the wrong surface |
| A5 | 4 | 5 | M | keep, rescope | Mask names, descriptions, completions, errors now; URI masking breaks reads (V25). Needs a handle decision |
| A6 | 3 | 4 | M | split | Honesty fixes are S in `server.ts`; a status resource is a budgeted second surface. Do the fixes, defer the resource |
| A7 | 4 | 4 | M | keep | Reuses the elicitation pattern at `vehicle-read.ts:71-113`; needs two clients, cheap to test |
| A8 | 5 | 4 | M | keep | Pure registry loop plus classification; the "15 cache keys" check needs a counting transport, not `cacheStats` |
| B1 | 5 | 5 | S | keep | One model at `charge-model.ts` feeds both tools; the fixture supports the range-times-consumption path |
| B2 | 3 | 4 | L | keep, late | New persistence beyond the history store, energy integration, depends on B1 and B7. Report effort M is optimistic |
| B3 | 4 | 5 | M | keep, scoped | Pure arithmetic with an injected clock; timer repeat semantics are unverified, so refuse ambiguous timers |
| B4 | 4 | 4 | M | keep, late | Regression is testable; temperature and wheel confounders cannot be modelled, so the interval must be named as conditional |
| B5 | 5 | 5 | S | keep | One registry row plus a transition function; sampler derives the set already |
| B6 | 4 | 5 | M | keep | New pure module over sampled odometer; needs the B7 clock |
| B7 | 5 | 5 | M | keep, prerequisite | The typed query and the value clock are the substrate for B2, B6, B8 and B10 |
| B8 | 3 | 3 | S | keep, last | Composition of six items; its prose claims are weak evidence and its dependencies are the whole program |
| B9 | 5 | 5 | S | merge | Small function; fold into B6 or B8 rather than a fourth history tool |
| B10 | 4 | 4 | S | keep | Readers already exist; needs the value clock and pending-block semantics |
| B11 | 3 | 4 | M | needs-evidence | Fence math is unit-testable; real drift and the home point need a privacy review and user data |
| B12 | 2 | 2 | L | kill | Fixture transport ignores VIN (V37); no second car; no capacity denominator |
| C1 | 5 | 5 | S | keep, first | Two lines in `buildEngine`; the chain test is the missing control. Confirmed defect (V4) |
| C2 | 4 | 4 | M | keep, next | Ledger in `budget.ts` plus a state directory; lock recovery and fail-closed read path are the work |
| C3 | 5 | 5 | S | keep | Registry field plus one branch in `caching-transport.ts`; 404 handling already exists in the client |
| C4 | 3 | 4 | M | split | Health endpoint, version gate and CI image are testable; publish needs credentials and is not |
| C5 | 5 | 5 | S | keep, first | Guard in front of the transport; SDK helpers exist; spawn test proves 403. Confirmed defect (V15) |
| C6 | 4 | 4 | M | keep | One log helper in `server.ts` plus instrumentation in the transport; privacy scan is the test |
| C7 | 4 | 4 | M | keep | Signal through `TransportRequest` and the client; shared-refresh abort semantics are the hard part |
| C8 | 5 | 5 | S | keep | `retrying-transport.ts` only; one-liner reproduces the date-header bug (V19) |
| C9 | 4 | 4 | M | split | `DATA_STALE` is testable; pruning deletes data and needs an operator decision |
| C10 | 5 | 5 | S | keep | Subscribe handler plus poller guard; all four defects are in two files (V20) |
| C11 | 2 | 3 | L | needs-evidence, merge D5 | The installed SDK constant is 2025-11-25 (V30); the check cannot pass through the current transport |
| C12 | 2 | 3 | L | needs-evidence | Credential registry and per-credential namespaces; no demand evidence and a real leak risk |
| D1 | 4 | 5 | S | keep | Metadata and CI validation are testable; publishing is a credential step. Confirmed state (V32) |
| D2 | 2 | 2 | M | defer | The pack can validate, the host install cannot be observed here; after D1 |
| D3 | 4 | 5 | S | keep, milestone candidate | CLI flag plus packaged fixtures; the tarball and zero-network checks are real. Confirmed packaging gap (V33) |
| D4 | 3 | 3 | S | keep, low | Doc checks are weak evidence; do it for review, do not count it as engineering |
| D5 | 2 | 3 | L | needs-evidence | Same SDK blocker as C11; the full 2026-07-28 surface is larger |
| D6 | 5 | 5 | S | keep | Tool metadata and deterministic order; cheap, and pairs with E1 and E2 |
| D7 | 1 | 2 | M | kill, as scoped | Third-party egress contradicts the security posture; only the parser is testable. Keep the local curve idea in B2 |
| D8 | 2 | 1 | L | kill, now | The rendering claim cannot fail in this tree and depends on opt-in history |
| D9 | 2 | 3 | M | split | Doc half is S and real; multi-vehicle read dies with B12 and V37 |
| D10 | 1 | 2 | L | kill, now | Changes the trust boundary SECURITY.md protects; end-to-end check needs a live client |
| E1 | 4 | 5 | S | keep, fix target | One constant in `tool-output.ts`; recomputed target is 31,972 bytes (V26), not 28,000. Avoid `$ref` |
| E2 | 4 | 5 | S | keep | 1,394 measured bytes of machine-irrelevant prose in `domain-tools.ts:65`; a description test is trivial |
| E3 | 3 | 5 | S | keep, decision | Mechanical duplicate confirmed (V2), but removing `message` is a contract break. Do it once with A1 and E1 |
| E4 | 5 | 5 | S | keep | One line in `aggregate-tools.ts`; target SoC is direct, ETA needs B1 |
| E5 | 5 | 5 | S | keep, first | Text-only fix in `aggregate-tools.ts`; the fixture reproduces it (V5) |
| E6 | 5 | 5 | S | keep | Planner guard plus a warning; the bug is reproduced through the tool (V10) |
| E7 | 4 | 3 | S | keep, low | String edits are trivial; the lexical ranker is a proxy, so do not overstate the evidence |
| E8 | 4 | 5 | S | keep | Strict arg schemas; confirm SDK parse behavior and client compatibility first |
| E9 | 2 | 4 | M | kill | The error and its message belong to the SDK (V27); no registration hook |
| E10 | 3 | 4 | M | merge A4 | Conditional history registration plus instruction text; same defect as A4's second half |

Counts: 5 kills (B12, D7, D8, D10, E9), 5 needs-evidence (B11, C11, C12, D2, D5), 7 splits or
merges, 35 keeps. No candidate requires a write endpoint.

## 4. Build order

This is dependency order, not priority order. Each step names what it unblocks and what would
make it slip. The first milestone is one engineer for about one working day.

### Milestone 1, one day: stop the two lies and the one safety hole

Scope: C1 (metering and retry survive `POLESTAR_CACHE=off`), E5 (the estimate says it cannot
estimate), E4 (status prints target SoC and the car's own time to full when reported), A4 (prompts
name only tools the running surface registered). Stretch: E2 (1,394 bytes of endpoint prose).

Why this is the milestone: these are four small changes in two source files (`src/server.ts`,
`src/aggregate-tools.ts`), each has a test that fails today, and they repair the two answers users
actually ask ("is it plugged in", "when will it be full") plus the documented fail-closed budget
property. Nothing else on the list is visible from outside this cheaply.

- Unblocks: every later budget-related test (the chain now meters in all live configurations) and
  every prompt or instruction change (the surface check exists).
- Slip risk: A4 needs a shared "surface from env" helper, because the existing test builds the
  26-tool union (`test/server-seams.test.ts:263-284`). If that helper is skipped, the test
  reintroduces the same blind spot. E4's ETA line needs one sentence for the case where the car
  reports 0 minutes because it is unplugged; get that wording reviewed rather than guessed.

### Step 1, prerequisites, about two days after the milestone

C5 (Host and Origin guards), C8 (Retry-After date and network retry), C10 (subscription
validation, cap, round guard, notify retry), B1 (capacity fallback chain), E6 plus the planner
normalisation (stop hour above 23, cross-night contiguity, out-of-window prices, negative prices).

- Unblocks: safe HTTP use (C5), a planner whose output can be trusted as a plan (E6, B1), and
  subscriptions that cannot be made to spend quota on a typo (C10).
- Slip risk: B1 needs one stated efficiency and phase convention that both tools share, and a
  decision on the silent 80 percent target default. The planner's hour convention needs the live
  contract checked; if the API only reports hours 0 to 23, the normalisation is still cheap but
  the bug loses urgency and must be documented as such.

### Step 2, foundation, about one week

One envelope change (A1 data population, E1 compact schema, E3 message decision, E2 prose) and
one clock change (A3 per-domain age plus B7 recorder clock), then C3 (negative caching) and D6
(deterministic, budgeted metadata), with A2's promise-to-render map.

- Unblocks: machine-readable clients (A1), every longitudinal candidate (the clock is the
  substrate for B2, B4, B6, B7, B8, B10), cheaper sessions (E1, E2, E3), and absent-domain reads
  that stop spending quota (C3).
- Slip risk: this is the step most likely to slip. The clock touches `domain-data.ts`,
  `server.ts:110-111`, `history.ts`, `history-tools.ts`, and every history expectation; existing
  stores hold read-clock records that must be labelled, not silently reinterpreted. The envelope
  touches 23 tool results, `scripts/smoke.ts`, `CONTRIBUTING.md` and the declared output schema.
  Doing A1, E1 and E3 as three separate migrations is the main avoidable cost; do them once.

### Step 3, history substrate and operations, about one week

B7 (typed timeline and the value clock in history), C9 (stale verdict and bounded history),
C2 (persistent budget ledger), C6 (structured stderr log), C7 (cancellation), A8 (availability
matrix), E8 (strict arguments).

- Unblocks: every history feature (B2, B4, B5, B6, B8, B9, B10), multi-process budget honesty
  (C2), operator diagnosability (C6), and the onboarding question (A8).
- Slip risk: C2's fail-closed ledger needs a recovery action, and pruning in C9 deletes user data.
  B7 is the gating item: if the value clock rule is not settled in Step 2, every history feature
  moves with it.

### Step 4, features, about two weeks

B5, B6, B10, B3, B2, B4, B8, A7, A6 (resource honesty and status surface), E10 folded into A4,
B9 folded into B6 or B8, A5's remaining URI decision.

- Unblocks: the user-visible analytics and the departure and cost questions.
- Slip risk: B2 and B4 depend on real history density; the sampler is off by default, so the
  feature may be correct and empty for months. Budget the empty-state message as part of each.

### Step 5, distribution and protocol, one week or more

D1 (schema, `mcpName`, CI validation, release), D3 (demo mode inside the package), D4 (reviewer
pack), D2 (bundle only after D1), D9 documentation, and only then the C11/D5 protocol project
once the SDK question is answered.

- Unblocks: installs, directory review, and the future protocol era.
- Slip risk: D1's publish half needs credentials the repository does not have, and the registry is
  in preview so a reset is possible. D5/C11 must not start before someone demonstrates that the
  installed SDK can serve 2026-07-28 (V30).

## 5. Effort realism for the top five

1. **C1, decouple metering and retry from the cache toggle. S (half a day with tests).**
   Files: `src/server.ts:78-89`. Tests: extend `test/runtime.test.ts:86-124` and add one
   `buildEngine` test that builds the real chain with the flag and counts stub calls. Hidden cost:
   proving there is exactly one meter per attempt when the cache sits on top, and keeping fixture
   mode unmetered so the offline demo stays free.
2. **A4, prompt surface that matches the running server. S (half a day).**
   Files: `src/server.ts:188-240, 338-409`, and the history family's registration decision at
   `:201`. Tests: a new `test/surface-composition.test.ts` that spawns the default and history
   surfaces and compares every tool-shaped name in `prompts/get` with `tools/list`; rewrite
   `test/server-seams.test.ts:255-285` to use the same helper. Hidden cost: the helper is the
   actual work, because the current check reads the union and would keep passing.
3. **B1 with E5 and E4, capacity fallback and an honest estimate. M (one to two days).**
   Files: `src/charge-model.ts:43-84`, `src/aggregate-tools.ts:150-197` and `:54-88`,
   `src/advisor-tools.ts:88-96`. Tests: `test/charge-model.test.ts` plus a fixture-backed tool
   test that asserts the kWh and minutes appear and that the 80 percent default is named. Hidden
   cost: the fallback's accuracy claim. Range times long-term consumption assumes the range was
   computed from that same average; the answer must name the source and the disagreement, and one
   stated efficiency and phase convention must be shared by both tools.
4. **A3 with the B7 clock rule. M (two to three days).**
   Files: `src/domain-data.ts:120-132`, `src/server.ts:110-111`, `src/aggregate-tools.ts:81-87`,
   `src/history.ts`, `src/history-tools.ts:37-40`. Tests: a new `test/clock.test.ts` covering all
   four clock fallbacks, plus updates to every history expectation and the aggregate staleness
   test. Hidden cost: this is the biggest hidden cost in the program (Section 7). Stored records
   with no value clock must be labelled, not reinterpreted, and every downstream series inherits
   the change.
5. **E1 with E2 and D6, tool-list economy. S to M (one day).**
   Files: `src/tool-output.ts:70-81` (one constant), `src/domain-tools.ts:65`,
   `src/tools.ts:41-55`. Tests: a new `test/surface-budget.test.ts` asserting the byte ceiling
   computed from measured parts, the distinct-schema count and deterministic order, plus the
   existing smoke contract. Hidden cost: no `$ref`, because client `$ref` support cannot be
   tested here; and the ceiling must be recomputed (V26), not copied from E-runtime.

Biggest hidden cost found: **the value clock**. The record clock lives in the composition root
(`src/server.ts:110-111`) while the value clock is a reader detail (`src/domain-data.ts:120-132`),
so moving to one rule touches the recorder, the humanized age, every aggregate, the degradation
series, session boundaries, the digest, and every stored sample already on disk. It is the one
change that should precede all longitudinal features, and the one most likely to be treated as a
small formatting fix and then discovered in five modules.

## 6. Dissent and corrections

1. **E3's 44.3 percent should not be quoted as a server property.** The mechanism is exact (V2),
   but my independent 20-call set measures 37.1 percent with the same formula. Report the sample
   with the number.
2. **E1 cannot hit its own target.** 50,718 minus 26,234 plus 26 times 288 is 31,972 bytes (V26).
   E1 is a one-file S change, not M, and the lead's 25,300-byte projection needs E2 and argument
   trims, not E1 alone.
3. **A5's cheapest fix breaks the resource surface.** Masked URIs cannot be read or subscribed
   (V25). Either design an opaque handle (effort M, affects subscriptions and bookmarks) or
   document the URI as the redaction exception and fix the names, descriptions, completions and
   errors. The report and the lead's open question both understate the read-path consequence.
4. **A-surface's prose count is wrong.** "11 of the 15 domain descriptions" contradicts its own
   12-row table and the source (V24). The defect is slightly larger than stated, not smaller.
5. **B-intelligence's stop-hour evidence is misframed.** The hour-28 payload is
   `test/charge-model.test.ts:26`, an estimator fixture; the planner's own tests use 23 to 6
   (`test/planner.test.ts:114-115`). The planner bug is real and cheap to fix, but its live
   frequency is unverified, and the report should not present the estimator payload as planner
   coverage.
6. **B2's effort is L, not M.** It adds a second local persistence format (price curves), energy
   integration over sessions, a confidence comparison, and the exclusion rules; it also waits on
   B1 and B7. Three to five days plus tests is the realistic size.
7. **A2's effort is M, not S.** Twelve domains need readers, renderer lines and a promise map,
   and coercing string-encoded numbers changes live output. The fixture makes the tests cheap, not
   the change.
8. **E9 is not a server candidate.** The unknown-tool error is thrown inside
   `node_modules/@modelcontextprotocol/server/dist/mcp-oHn3ureC.mjs:1605`; no public hook appears
   in the SDK types. The report's check is writable, the fix is not. This is an upstream request.
9. **A8's check overstates observability.** "Touch exactly 15 distinct cache keys" cannot be read
   from `cacheStats`, which exposes counters and entry count, not keys
   (`src/caching-transport.ts:4-13`). The test needs a counting transport or new instrumentation.
10. **C-platform overstates the SDK.** It says the installed SDK "implements the 2026-07-28
    revision" (C-platform.md:58-59); the constant is 2025-11-25
    (`node_modules/@modelcontextprotocol/core/dist/schemas-DscsoNZN.mjs:4`), and the server
    negotiates 2025-11-25 (V30). D-ecosystem's "hybrid" reading is the correct one, and C11/D5
    should both be needs-evidence until the era can actually be served.
11. **E7's evidence is a proxy.** The lexical ranker shows which words exist on the surface, not
    whether a model routes better. Keep the string fixes, do not sell the ranker result as model
    evidence.
12. **E8 needs a compatibility decision, not just `.strict()`.** The SDK currently strips unknown
    keys before the handler; rejecting them will turn a tolerant client into a failing one. That
    is the right default for a misspelled VIN, and it is a breaking change worth stating in the
    release notes.
13. **The two existing checks that most need fixing are not candidates in any report.**
    `test/server-seams.test.ts:263-284` and `test/contract.test.ts:50-62` pass while the defects
    they appear to cover are live (V14, V24). A4 and A2 must change those tests, not add new
    suites beside them, or the repository will again have a check that cannot fail.

## 7. Hygiene

`node docs/check-docs.mjs hygiene` was run after this file was written. The tree-wide run does not
reach `HYGIENE_CLEAN`, and no failing path is this file. Each detector was run separately because
the combined command stops at the first failure.

- `node docs/check-docs.mjs emdash` fails on `analysis/correctness/findings.md` (lines 1, 43, 71,
  87, 113, 126, 159, 183, 191, 222, 235, 245, 268, 278, 308, 337, 339, 356, 364, 382, 390, 413,
  430, 438, 456, 464, 491, 513, 533, 561, 578, 588 to 599, 604, 612, 623 to 627, 629).
- `node docs/check-docs.mjs buzzwords` prints `HYGIENE_BUZZWORDS_CLEAN`.
- `node docs/check-docs.mjs banners` fails on five probe scripts under `analysis/correctness/`
  (`probe-budget-window.ts` lines 12, 26; `probe-cache-clean.ts` lines 17, 30, 48, 61;
  `probe-history.ts` lines 19, 49, 65; `probe-status.ts` lines 17, 55;
  `probe-subscriptions.ts` lines 13, 41).
- `node docs/check-docs.mjs connectors` fails on `analysis/correctness/findings.md` (lines 185,
  216, 432, 466, 485).

All four failing paths are outside this seat's write scope. The four detectors were also applied
to `analysis/council/R2-engineering.md` alone, using the same script logic, and report no hit:
zero em dashes, zero spaced en dashes, no banned vocabulary, no spaced-hyphen connector. The
tree-wide check can only print `HYGIENE_CLEAN` after the correctness lane removes those notes or
the notes are excluded from the scan.
