# Core domain data and analytical models: improvement inventory

Task `task-2`, teammate core-analyst. Scope read in code: `src/domains.ts`, `src/domain-data.ts`,
`src/vehicle-read.ts`, `src/format.ts`, `src/planner.ts`, `src/charge-model.ts`, `src/sampler.ts`,
`src/history.ts`, `test/fixtures/dump/**`, `docs/upstream-api.md`, `docs/live-contract-findings.md`.
Consumers read for evidence: `src/aggregate-tools.ts`, `src/advisor-tools.ts`, `src/history-tools.ts`,
`src/server.ts`, `test/contract.test.ts`, `test/charge-model.test.ts`, `test/planner.test.ts`.

Prior work was re-checked rather than trusted: the five correctness probes in my area were re-run and
reproduce exactly, and one prior magnitude claim is qualified below. No tracked file was modified and
nothing outside `analysis/improvements/` was written. Baseline confirmed: `npm test` 111 pass, 0 fail.

Severity = user-visible wrongness times reachability today.

## Verified defects

1. **High. Planner reports `feasible: true` while the schedule delivers a fraction of the energy
   needed.** `src/planner.ts:114-138`: when `hoursInt > rated.length` the fallback keeps
   `rated.length` slots but still divides `energyNeededKwh / hoursInt`, so planned energy is
   `energyNeeded * slots / hoursNeeded`, and `feasible` is never recomputed. Lead independently
   reproduced this (need 56 kWh, steps total 18.67 kWh, `feasible: true`); my re-run of
   `analysis/correctness/probe-planner.ts` case A reports `energyNeededKwh 64`, `steps 2`,
   `energyPlannedKwh 18.285714285714285`, `shortfallKwh 45.71`, `feasible true`, and the `reason`
   text talks about contiguity, not the missing 45.7 kWh.

2. **High. Charge-model power is 1.73x too high whenever the car reports a line-to-line voltage.**
   `src/charge-model.ts:50-58` computes `ampLimitA * volts * phases / 1000`. That identity is correct
   only if `chargingVoltageVolts` is a per-phase voltage. For the 400 V value the repo's own test
   invents (`test/charge-model.test.ts:19,68-84`, which asserts 19.2 is correct), three-phase power
   is `sqrt(3) * 400 * 16 = 11.09 kW`, not `3 * 400 * 16 = 19.2 kW`. Re-ran
   `probe-charge-model.ts`: `assumed_230V_x_3phases_kW 11.04`, `reported_400V_x_3phases_kW 19.2`,
   `physical_3x16A_at_400V_line_to_line_kW 11.085`, `ratio_400V_path_vs_physical 1.73`. The same
   `powerKw` feeds the planner (`src/advisor-tools.ts:66-74,90`), so the plan schedules 1.73x fewer
   hours than the car needs. Upstream semantics of the field are not established by any capture
   (`docs/live-contract-findings.md:43` says the reference car reports no volts), so the fix is a
   decided, documented convention plus a physical test, not a guess.

3. **High. `is_car_secure` can say "Yes, car is secure" while reporting a triggered alarm.**
   Description promises "central lock engaged, alarm OK?" (`src/aggregate-tools.ts:98`), but the
   verdict at `src/aggregate-tools.ts:110-113` tests only `seen.locked` and `open.length`; the alarm
   is printed afterwards at `:112`. `exteriorView` exposes the alarm (`src/domain-data.ts:268`) and
   nothing consumes it in the verdict. Lead verified this independently. Falsifiable: an exterior
   payload with `centralLock` and `tailgateLock` locked, all apertures closed, and
   `alarm: ALARM_STATUS_TRIGGERED` must not produce a "secure" sentence; today it does.

4. **High. `get_charging_estimate` silently assumes 80% target and promises a car estimate it never
   shows.** `src/aggregate-tools.ts:170,178` do `targetSoc(target).levelPct ?? 80` and nothing states
   the assumption. `src/aggregate-tools.ts:188` prints "showing the car's own estimate instead", but
   `:190-191` prints the car's estimate only when `eta > 0`, and the shipped fixture value is 0
   (`test/fixtures/dump/dataportal/telemetry/battery.json`, `estimatedChargingTimeToFullMinutes: 0`).
   Fixture-backed tool run with the shipped dump and `target-soc` present prints literally
   "Usable-energy data not reported; showing the car's own estimate instead." with no figure after
   it. With `target-soc` null the tool prints "Energy to 80%" and never says 80 was assumed, while
   `plan_cheapest_charge` refuses the same car (`src/advisor-tools.ts:79-81`): two tools, two
   answers, one unstated default.

5. **High. Location summary prints a wrong speed of 0 km/h for a moving car and never reads
   altitude.** `docs/live-contract-findings.md:45` records `speed` and `altitude` as JSON strings;
   the fixture has `"0"` for both (`test/fixtures/dump/dataportal/telemetry/location.json`).
   `src/domain-data.ts:150` reads `speed` through `asNumber`, so a numeric string is always
   `undefined`; `src/format.ts:169` then renders `coordinate.speedKmh ?? 0`, a false value. Verified:
   `summary('location', fixture with speed "45")` prints `Position: 47.60620, -122.33210 (heading
   121°, 0 km/h)`. `position()` (`src/domain-data.ts:142-156`) has no altitude member at all, so the
   description promise at `src/domains.ts:151-152` is unrenderable. A missing heading renders as
   `heading °` (`src/format.ts:169`).

6. **Medium. Staleness for charging settings uses the cloud receive clock, not the value's own
   clock.** `src/domain-data.ts:120-132` reads top-level `timestamp.seconds` then `metaReceivedAt`,
   and never the nested `updatedAtTimestamp` or `updatedAt` that settings payloads carry. Measured
   with the fixtures: `global-charge-timer` value clock 2026-08-16T18:39:14Z against receive
   2026-09-10T10:16:55Z (24.65 d); `amp-limit` 2026-08-18T12:41:14Z against 2026-09-10T10:16:03Z
   (22.90 d); `parking-climate-timer` timer metadata 2026-06-21T12:00:04Z against 2026-09-17T22:40:02Z
   (88.44 d). `docs/upstream-api.md:16` already documents this skew. Re-ran the per-domain table: 4
   of 7 charging domains fall back to `metaReceivedAt`; all 8 telemetry domains and `target-soc` use
   a value clock.

7. **Medium. History records the read clock, so longitudinal models are dated by when a tool call
   happened.** `src/server.ts:110-111` appends `{ observedAt: Date.now(), data }`; the payload's own
   `timestamp.seconds` or `metaReceivedAt` is available at that point and dropped. A recorded fixture
   battery line had `observedAt` 2026-11-05T21:28Z against `metaReceivedAt` 2026-09-18T11:10Z (R2
   confirmed 48.43 d; I reproduced the same gap). Every consumer of `HistoryRecord.observedAt`
   inherits it: `get_history` lines, `extractChargingSessions` boundaries (`src/history.ts:160,189`),
   and `degradationSeries` points (`src/history.ts:215`). The record also cannot be re-dated later
   because the value clock is not stored.

8. **Medium. `get_history` discards most payloads, so 11 of 15 domains print `{}`.**
   `src/history-tools.ts:80-81` keeps five hardcoded field names. Reproduced end to end: appending a
   real `global-charge-timer` payload and calling `get_history` with `domain:
   "charging/global-charge-timer"` prints `"2026-09-10T10:16:55.687Z {}"`. R2 measured the full
   count (11 of 15 domains; `is-at-charge-location` records no row at all). The same tool rejects an
   unknown domain properly (`src/history-tools.ts:66-75`), so the failure is silent empty data, not
   an error.

9. **Medium. Planner calls a block "contiguous" when the slots straddle a 20 hour gap.**
   `src/planner.ts:118-125` indexes the filtered in-window slot list, not the clock. Re-ran
   `probe-planner-contiguity.ts`: 4 h/night window, 4.8 h needed, `gapHoursBetweenSteps [0,0,0,20]`,
   `reason null`, `saysNonContiguous false`. `test/planner.test.ts:125-142` claims to cover the
   fallback but takes the contiguous path (probe case D: `fellBackToIndividualHours false`,
   `testAssertionWouldPass true`), so the suite protects neither behaviour.

10. **Medium. A stop hour above 23 truncates the window instead of wrapping.** `src/planner.ts:70-73`
    treats hours 0 to 23; `src/domain-data.ts:99-100` passes `stop.hour` through unvalidated, and the
    repo's own accepted payload shape uses 28 (`test/charge-model.test.ts:26`,
    `test/planner.test.ts` uses 23 to 6). Re-ran `probe-planner.ts` case C: window 22 to 28 schedules
    local hours `[22, 23, 22]`, so 00:00 to 03:00 never appears. The humanizer prints `22:00 → 28:00`,
    which no reader can interpret (`src/format.ts:226-227`).

11. **Medium. Planner slot starts inherit the call's seconds.** `src/planner.ts:77` computes the first
    whole-hour boundary from `now` without flooring, so a call at 12:00:55 produces
    `startsAt 2026-01-01T12:00:55.000Z`, a slot that straddles two price hours while being billed at
    the earlier one. `priceFor` (`:86-92`) then matches by containment, so the plan and the price
    disagree about the boundary.

12. **Medium. Planner cost spreads energy evenly over rounded-up hours, overstating boundary cost.**
    `src/planner.ts:132-140` books `energyNeeded / hoursInt` in every step. Probe re-run: 20.7 kWh at
    13.8 kW needs 1.5 h and is booked as two hours of 10.35 kWh; `totalCost 3.105` against `2.76` for
    charging from the block start. The percentage is scenario dependent (R2 measured 5.4 percent on a
    different price pair, my probe shows 12.5 percent on its pair); both reproduce, so the correct
    claim is that the arithmetic cannot attribute energy inside a partially used hour, not a fixed
    error size.

13. **Medium. Planner drops `totalCost` for a negative price and silently costs unpriced slots at
    zero.** `src/planner.ts:147` emits the field only when positive; probe case B gives
    `stepPrices [-0.1,-0.1,-0.1]`, `totalCost null`, sum `-2.4`. Separately, unpriced slots are
    labelled "last resorts" (`:106-110`) but contribute `(s.price ?? 0)` at `:140`, so a mixed plan
    reports a cost that omits some of its energy.

14. **Medium. Charging-session and degradation outputs overstate what they measured.**
    `src/history.ts:155` sets `power = view.powerWatts ?? 0` and `:190` peaks over it, so a car that
    reports charging status but no power gets `peakPowerWatts 0`; verified output
    `[{startedAt:0,lastSeenAt:0,activeSeconds:0,peakPowerWatts:0,sampleCount:1}]`, printed as
    `peak 0.0 kW` at `src/history-tools.ts:155`. A single sample becomes a session with
    `activeSeconds 0` and no minimum gate. `degradationSeries` (`src/history.ts:204-229`) pushes a
    point for a record that has only SoC, and `src/history-tools.ts:111` counts `points.length` as
    "usable samples": verified `[{observedAt:1,socPct:50}]` from a payload with no range and no
    energy.

15. **Medium. `parseResourceUri` throws instead of returning undefined on a malformed percent-encoded
    VIN.** `src/domains.ts:422` calls `decodeURIComponent(rawVin)` with no try. Verified:
    `parseResourceUri('polestar://vehicle/%E0%A4%A/telemetry/battery')` throws `URIError: URI
    malformed`, and `%ZZ` does the same, where every other invalid URI returns `undefined`
    (`src/domains.ts:404-414`). The only caller is `src/subscriptions.ts:42,59,100`, reached from
    `resources/subscribe` (`src/server.ts:328-330`), so a bad URI becomes INTERNAL_ERROR instead of
    an unknown-resource answer.

16. **Medium. Model inputs are unvalidated, and nonsense in produces a confident plan.**
    `src/charge-model.ts:43-70` accepts `phases: 0` (power 0, assumption "0 phase(s)"), `ampLimitA:
    0` (power 0), and any magnitude of `energyAvailableKwh`. Verified:
    `chargeModel({socPct:52,targetPct:80,energyAvailableKwh:34.17})` gives 65.7 kWh, but
    `chargeModel({socPct:6,targetPct:80,energyAvailableKwh:200})` gives 3333.3 kWh capacity and
    2466.7 kWh to target with no flag. `src/planner.ts:52-75,114` accepts `powerKw: 0` and returns
    `feasible true`, `hoursNeeded Infinity`, 46 steps of 0 kWh; `capacityKwh: -70` returns
    `feasible true`, `energyNeededKwh -3.5`, 0 steps. The tool layer validates `capacityKwh` and
    `phases` but amp limit comes from the car, so the zero-power path is payload-reachable.

17. **Medium. `formatAge` rounds up across hour and day boundaries and treats a future epoch as
    fresh.** `src/format.ts:99-107`: `formatAge(now - 90 min)` prints "2 h ago" (round of 1.5);
    `formatAge(now - 47.5 h)` prints "2 d ago" (hours round to 48, then the `< 48` test fails);
    a corrupt future epoch prints "0s ago" (`probe-format.ts`: `formatAgeOfIt "0s ago"`, epoch 1e+23).
    Every domain header and `get_car_status` uses this function (`src/vehicle-read.ts:241`,
    `src/aggregate-tools.ts:86`), so the data-age promise is systematically coarse and can claim
    freshness that is wrong by orders of magnitude.

18. **Low. The humanizer presents unreported state as a concrete fact.**
    `src/format.ts:234-235` prints `Charge-now override: present (synced)` for the shipped payload,
    whose only content is a sync timestamp (verified); `src/domains.ts:266` says it carries "not an
    active/inactive boolean", so the line asserts a state the payload does not contain.
    `src/format.ts:236-239` prints `No saved charge locations reported` for a payload that is a
    settings record with `utc0` and no list (`src/domains.ts:256`), implying none are saved rather
    than not returned over M2M. `src/advisor-tools.ts:111` prints "defined but INACTIVE on the car"
    whenever `window.activated !== true`, so an unreported flag is reported as inactive;
    `chargeWindow` drops a non-boolean `activated` (`src/domain-data.ts:98-102`).

19. **Low. History reads silently drop malformed records and accept wrong shapes.** `src/history.ts:64-73`
    does `JSON.parse(line) as HistoryRecord` with no shape check and no schema version.
    Verified by appending three hand-written lines to a store: a record with an ISO-string
    `observedAt` and a record with no `observedAt` are both silently absent from `query()` (count 4
    of 6 lines), while a record with `data: []` is accepted and reaches `degradationSeries`, which
    skips it by type luck. No record carries its schema version, so a future field rename has no
    migration path.

20. **Low. Sampler lifecycle and status misreport.** `src/sampler.ts:93-99` sets `stopped` and never
    clears it; `start()` does not reset it, so a stop then start returns a target count and schedules
    nothing while `describe()` still says "on, every 600s". Verified with an injected sleep: after
    stop and restart, resolving every sleep produced `ticks 0`. Also `src/sampler.ts:53` swallows a
    `vehicles()` failure into `[]`, and `:112` then reports "on, but this credential reports no
    vehicle to sample"; verified with a client whose `vehicles()` throws `AUTH_ERROR`: `start()` 0,
    `describe()` "on, but this credential reports no vehicle to sample". `src/server.ts:122-128`
    swallows every per-domain sampler error with `.catch(() => undefined)`, so gaps in history cannot
    be attributed.

21. **Low. Two payload-shape assumptions throw inside the humanizer.** `src/format.ts:230-232` casts
    `parkingClimateTimers` to an array and calls `.map`; `{parkingClimateTimers: {}}` throws
    `TypeError: timers.map is not a function` (verified), which the tool layer turns into
    INTERNAL_ERROR. `src/format.ts:207` calls `new Date(...).toISOString()` on an unvalidated epoch;
    a corrupt `lastCycleCompleted` throws `RangeError: Invalid time value` (`probe-format.ts`).
    `src/format.ts:237-238` renders `Saved charge locations: undefined` for a non-array value.

22. **Low. `humanizeEnum` turns a nested enum object into `[object Object]`.** `src/format.ts:25`
    stringifies any non-string. Verified: `summarizeDomain('availability', {availabilityStatus:
    {value: 'AVAILABILITY_STATUS_AVAILABLE'}})` prints `Availability: [object Object] · n/a`. The API
    already uses a wrapped `{value}` shape for `syncStatus` (`test/fixtures/dump/dataportal/charging/
    global-charge-timer.json`), so the shape is plausible upstream.

23. **Low. Reader symmetry gap: `ampLimitA` accepts nested and flat shapes, `pendingAmpLimitA` only
    nested.** `src/domain-data.ts:69-81`. Verified: `pendingAmpLimitA({pendingAmpLimit: 7})` is
    `undefined` while `ampLimitA({ampLimit: 7})` is 7. The fixture uses the nested shape, so this is
    a contract-shape assumption with no captured evidence either way.

24. **Low. `chargeWindow` reads the start boundary's timezone only.** `src/domain-data.ts:96-101`
    takes `zone` from `timer.start` and ignores `timer.stop.timeZone`, so a window whose boundaries
    differ across a DST transition keeps the start offset for both. Verified:
    `chargeWindow({start h22 offset 60, stop h6 offset 120})` returns `offsetMinutes: 60`.

## Missing capabilities

Ordered by how much a user would notice; evidence in the candidate table.

1. A numeric charging answer on the reference car. Capacity comes only from
   `dischargeInfo.energyAvailable` (`src/charge-model.ts:61-70`), which the fixture battery payload
   does not contain (14 keys, verified), so `get_charging_estimate` prints no kWh and no time and
   `plan_cheapest_charge` refuses (`src/advisor-tools.ts:92-96`). The battery payload's own fields
   imply 65.7 kWh (170 km x 20.1 kWh/100 km / 0.52 = 65.71), and nothing computes it.
2. Cost and grid energy. No charging efficiency is modelled anywhere
   (`src/charge-model.ts:47-59`, `src/planner.ts:132-140`), so a 90 percent wall-to-battery efficiency
   understates cost and grid energy by 11.1 percent (verified arithmetic: 18.4 kWh becomes 20.44 kWh).
3. Truthful freshness. Settings age is understated by up to 88 days (defect 6) and history is dated
   by read time (defect 7).
4. History answers that are not `{}` (defect 8), and a way to ask for a domain's payload in typed
   form rather than five field names.
5. Planner answers that are feasible only when they can deliver the energy (defect 1), and a window
   contract that handles the payload shape the repo itself accepts (defect 10).
6. A charging-session and degradation report that says what it measured: no peak power when power was
   never reported, no one-sample sessions, no "usable sample" that has no usable value (defect 14),
   and a span/interval before calling a trend (B4 in `analysis/B-intelligence.md`).
7. A humanizer that matches its own descriptions and docs: `docs/tools-reference.md:54-67` promises
   charger power status, usable energy, altitude, average speeds, ventilation, air quality index,
   timer offsets, repeat flags, amp source and update times, target update time; the renderers cover
   none of those. Falsifiable promise-to-render check exists for the whole registry; today it fails
   on 11 description items.
8. A second synthetic capture that exercises the optional-field paths: `dischargeInfo`,
   `chargingVoltageVolts`, `chargingCurrentAmps`, `chargingPowerWatts`, `pendingAmpLimit` change and
   `activated: true`. Verified: `grep -rl "dischargeInfo\|chargingVoltageVolts\|chargingPowerWatts\|
   chargingCurrentAmps" test/fixtures/dump` returns nothing, so the capacity and live-power branches
   have no fixture and only a hand-built unit payload (`test/charge-model.test.ts:16-22`).
9. Fixture mode that can demonstrate history: all 14 fixture payloads that carry an id share one
   `metaEventId` (`grep -h '"metaEventId"' -r test/fixtures/dump | sort | uniq -c` -> `14` identical
   lines), so dedupe (`src/history.ts:50-52`) keeps one record however often a domain is read and no
   session, trend or change event can be demoed or tested from the shipped dump.
10. History retention: no prune tool, no rotation; the only bound is a 64 MiB per-file read refusal
    whose message says to prune without naming how (`src/history.ts:5,61-62`).
11. A registry row that owns its reader and its renderer. Today a new Domain needs a row
    (`src/domains.ts:50-340`), a reader in `src/domain-data.ts`, a case in `src/format.ts:139-245`,
    and a fixture; the contract test forces the third edit (`test/contract.test.ts:54-77`), so the
    "one list" claim in `src/domains.ts:1-10` covers route, TTL and scope but not payload handling.
12. VIN validation at the resource boundary: `src/domains.ts:416-423` accepts any non-slash segment,
    so `resources/subscribe` on a malformed VIN spends a live call to earn a 403
    (`docs/live-contract-findings.md:22-25`).

## Candidate table

IDs are local to this report. MoSCoW: Must means a release blocker or a broken user promise; Should
means high value soon; Could means worthwhile but not now; Won't means deliberately not doing it.

| ID | Improvement | Category | Evidence (file:line) | User impact (one sentence) | Effort | Risk | Falsifiable check | MoSCoW suggestion |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B-01 | Planner returns infeasible (or states the shortfall) when in-window slots cannot deliver the energy; report energy actually scheduled | bug | `src/planner.ts:114-138`, `:140-148`; probe A | A caller acts on a schedule that cannot reach the target, with `feasible: true` | S | Low | 1 h/night window, 64 kWh needed, 10 kW: `steps.reduce(e) >= energyNeeded` or `feasible === false`; today feasible true with 18.29 kWh | Must: the planner's core promise is a plan that reaches the target |
| B-02 | Decide and document the reported-voltage convention; use `sqrt(3)` for line-to-line three-phase and test the physics | bug | `src/charge-model.ts:50-58`; `test/charge-model.test.ts:68-84`; probe | Charging time is 1.73x optimistic and the plan under-schedules whenever a car reports volts | S | Low (needs one decision) | 16 A, 400 V, 3 phases must be 11.1 kW plus or minus 0.1 in the model and in `get_charging_estimate`; today 19.2 | Must: a headline number is wrong by a factor, and a test pins it |
| B-03 | State the 80% target assumption, and never print "showing the car's own estimate" unless a figure follows | bug | `src/aggregate-tools.ts:170,178,188,190-191`; fixture run | Two tools answer the same car differently and the text promises data it omits | S | Low | `target-soc` null: output contains "80%" and "assumed"; fixture with eta 0: no sentence "showing the car's own estimate instead" | Must: documented behaviour is contradicted on the shipped fixture |
| B-04 | Include alarm in the `is_car_secure` verdict, or remove "alarm OK" from the promise | bug | `src/aggregate-tools.ts:98,110-113`; `src/domain-data.ts:268` | The security tool can say the car is secure while reporting a triggered alarm | S | Low | Locked, closed, `alarm: ALARM_STATUS_TRIGGERED` must not yield "Yes, car is secure" | Must: a false security verdict is the worst wrong answer this server can give |
| B-05 | Read string-encoded numbers and altitude in the location reader; render speed only when known; omit an absent heading | bug | `src/domain-data.ts:142-156`; `src/format.ts:165-172`; live findings :45 | A moving car is reported at 0 km/h and altitude is never available | S | Low | `summary('location', {coordinate, speed: "45", heading absent})` contains 45 and no "heading °"; `position().altitude` reads "12" | Must: the output contradicts a value the API delivered |
| B-06 | Capacity fallback chain: `dischargeInfo.energyAvailable`, else range x average consumption / SoC, else caller argument, else refuse and name the paths | missing-feature | `src/charge-model.ts:61-70`; `src/aggregate-tools.ts:181-189`; fixture arithmetic | "When will it be charged" has no numeric answer on a fully populated reference car | S | Low | Shipped fixture: estimate prints kWh and minutes; derived capacity 65.7 plus or minus 1 kWh; both tools agree | Should: highest user value, but the current message is at least honest |
| B-07 | Add a charge-efficiency assumption (single stated figure) and apply it to grid energy and cost | missing-feature | `src/charge-model.ts:47-59`; `src/planner.ts:132-140` | Cost and time are systematically low by the wall-to-battery loss | S | Low | 18.4 kWh battery-side at 90% prints 20.4 kWh grid energy; planner cost uses grid energy | Should: advisory numbers are wrong by 10 percent in the same direction |
| B-08 | Record and render the value clock: store payload `timestamp.seconds` or `metaReceivedAt` beside the read time, use it for settings age, sessions and trends | bug | `src/domain-data.ts:120-132`; `src/server.ts:110-111`; `src/history.ts:15-24` | A setting changed 88 days ago is shown as days old and a session is dated by tool use | M | Medium (record shape) | `observedAtMs(global-charge-timer fixture)` is 2026-08-16T18:39:14Z or the header says "received"; a stored record carries both clocks and sessions use the value clock | Should: trust in every age line and trend |
| B-09 | Replace the five-field history filter with typed per-domain rendering through `src/domain-data.ts` readers | bug | `src/history-tools.ts:80-81`; reproduced `{}` | 11 of 15 domains answer with an empty object that looks like "nothing changed" | M | Low | `get_history charging/global-charge-timer` prints 23 and 6; every registry domain with a record renders at least one field | Should: the tool is effectively broken for most domains |
| B-10 | Normalize hours above 23 and check block contiguity in time, not list index | bug | `src/planner.ts:70-73,118-125`; `src/domain-data.ts:99-100`; probes | A plan claims one stretch across a 20 hour gap and ignores four window hours | S | Medium (upstream hour convention unverified) | Window 22 to 28 schedules local hours 22,23,0,1,2,3; 4 h/night needing 5 h yields `reason` naming a gap | Should: misleading schedules, but the shipped fixture uses 23 to 6 |
| B-11 | Compute cost from the actual schedule (split the partial hour at the price boundary) rather than spreading energy evenly | bug | `src/planner.ts:132-140`; probe | The cost figure is wrong at every window or price boundary | S | Low | 20.7 kWh at 13.8 kW with two hourly prices: cost equals charging from block start (2.76 in the probe), not 3.105 | Should: cost is the planner's differentiator |
| B-12 | Floor the first slot to a whole local hour; never inherit the call's seconds | bug | `src/planner.ts:75-84`; `:86-92` | Step timestamps do not line up with the price hours a caller supplies | S | Low | With now 12:00:55, first `startsAt` is 12:00:00.000Z or 13:00:00.000Z, never 12:00:55.000Z | Should: cheap fix for an obvious mismatch |
| B-13 | Session and degradation quality gates: unknown peak power stays undefined, sessions need 2 or more samples or an explicit zero-duration marker, degradation drops points with no range or energy | bug | `src/history.ts:155,189-190,204-229`; `src/history-tools.ts:111,155` | Reports claim 0.0 kW peak, 0 min sessions and "usable samples" that carry no signal | S | Low | Status-only charging sample gives `peakPowerWatts === undefined`; one-sample run is not a session or says 0 usable samples; SoC-only record gives 0 degradation points | Should: every history answer becomes more honest for little cost |
| B-14 | Promise-to-render contract test, then render the actionable subset and delete the rest of the promises | docs | `docs/tools-reference.md:54-67`; `src/format.ts:139-245`; `src/domains.ts:50-340` | Tool descriptions name fields the answer never shows, so a model cannot trust either | M | Low | For each description promise, the fixture summary contains the value or the description no longer claims it; today 11 items fail | Should: the shipped descriptions are the routing surface |
| B-15 | Replace false state claims: charge-now says "state not reported", charge-locations says "not listed over M2M", activation unknown is not "INACTIVE" | bug | `src/format.ts:234-239`; `src/advisor-tools.ts:111`; `src/domains.ts:256,266` | Three answered questions assert states the payload does not contain | S | Low | `summarizeDomain('charge-now', fixture)` contains no "present"; `charge-locations` says not reported; a timer without `activated` is called unknown, not inactive | Should: small, clear lies in the most-read summaries |
| B-16 | Validate model inputs and bound derived capacity: SoC, phases, amps, power and capacity ranges, and refuse or flag implausible values | bug | `src/charge-model.ts:43-70`; `src/planner.ts:52-75,114`; reproduced zero-power plan | Bad or absent inputs produce a confident plan instead of a refusal | S | Low | `powerKw: 0` gives `feasible: false` with a reason; 200 kWh reported at 6% SoC is refused or flagged, not 3333 kWh capacity | Should: reachable from a payload, not only from a caller |
| B-17 | `parseResourceUri` returns undefined for a malformed percent-encoded VIN | bug | `src/domains.ts:422`; `src/subscriptions.ts:42`; `src/server.ts:328-330` | A bad subscription URI becomes INTERNAL_ERROR instead of an unknown-resource answer | S | Very low | `parseResourceUri('polestar://vehicle/%E0%A4%A/telemetry/battery') === undefined`; today throws URIError | Should: unhandled throw at a protocol boundary, one line to fix |
| B-18 | Add a second synthetic capture with the optional fields and distinct `metaEventId` values | quality | `test/fixtures/dump/dataportal/telemetry/battery.json`; `src/domain-data.ts:32-50`; grep result | The capacity and live-power paths have no captured-payload test and history cannot be demoed offline | M | Low | Fixture-backed estimate prints kWh; `grep` finds 2 or more distinct `metaEventId` values; an optional-field fixture renders charger power | Should: this is the only way the primary arithmetic is provably correct |
| B-19 | Fix `formatAge` boundaries (floor rather than round) and treat future epochs as unknown | quality | `src/format.ts:99-107`; `probe-format.ts` | Every data-age line overstates staleness near a boundary and a corrupt clock reads as fresh | S | Low | 90 min is "1 h ago" not "2 h ago"; 47.5 h is "1 d ago" not "2 d ago"; 1e+23 epoch is "freshness unknown" | Should: one function behind every header |
| B-20 | Emit `totalCost` for zero and negative prices, and omit it (or mark unknown) when any chosen slot has no price | bug | `src/planner.ts:106-110,140,147`; probe B | The cheapest plan is the one whose cost line disappears, and mixed plans understate cost | S | Low | Negative price curve gives a numeric `totalCost < 0`; a plan with one unpriced step has no `totalCost` or names the unpriced energy | Could: correct, but a niche tariff case |
| B-21 | Change dedupe from last id to a bounded seen-set per file | quality | `src/history.ts:50-52`; reproduced `['a','b','a']` | A re-served older event is stored twice, inflating every count and trend | S | Low | Append a, b, a gives 2 records; a restart followed by the same id gives no new record | Could: only matters when the cloud reorders events |
| B-22 | Validate record shape on read and add a schema version to each record | quality | `src/history.ts:64-73`; reproduced dropped malformed lines | Corrupt records vanish silently and a future field change has no migration path | M | Low | An ISO-string `observedAt` record is reported as malformed or migrated, not silently absent; every record has `version` | Could: operator-managed store, but silent loss is bad |
| B-23 | Sampler lifecycle: reset `stopped` on start, distinguish "no vehicle" from "list failed", report last round time and per-domain failures | quality | `src/sampler.ts:53,93-99,110-116`; `src/server.ts:122-128`; reproduced | A sampler that is not running can report itself on, and history gaps cannot be explained | S | Low | After stop then start, a resolved sleep produces a tick; a failing `vehicles()` is described as a failure; `describe()` carries last round and error count | Could: observability for an opt-in background feature |
| B-24 | Add a prune or rotation path and make the 64 MiB message name the command | missing-feature | `src/history.ts:5,61-62` | A long-lived install eventually refuses every history query with instructions it cannot follow | M | Low | After prune the file is under the cap and queries answer; the refusal text contains a runnable command | Could: default cadence takes hundreds of days to get there |
| B-25 | Move the reader and summarizer onto the Domain row, or add a registry-derived check that both exist | quality | `src/domains.ts:1-10,50-340`; `src/format.ts:139-245`; `test/contract.test.ts:54-77` | A new Domain still needs three file edits, so the "one list" claim is partial | M | Medium (refactor) | A test enumerates DOMAINS and finds a reader and summarizer per row; adding a row without either fails | Could: maintenance cost, no user-visible defect today |
| B-26 | Validate the VIN (17 characters, standard alphabet) before a subscription spends a call | quality | `src/domains.ts:416-423`; `docs/live-contract-findings.md:22-25` | A typo'd subscription URI costs quota and returns an authorization error instead of a usage error | S | Low | `resources/subscribe` with VIN "BAD" is refused with no transport call; the VIN regex is the client's `VIN_RE` | Could: overlaps the platform lane's subscription hardening |
| B-27 | Make the humanizer shape-tolerant: non-array timer lists, wrapped enum values, corrupt epochs, non-numeric fields | quality | `src/format.ts:25,207,230-232,237-238`; reproduced TypeError and RangeError | A malformed upstream payload becomes INTERNAL_ERROR or `[object Object]` instead of a readable answer | S | Low | `summarizeDomain('parking-climate-timer', {parkingClimateTimers: {}})` returns a line; wrapped enum renders its value; corrupt epoch renders "n/a" | Could: upstream shape is stable in the capture; defensive only |
| B-28 | Make `pendingAmpLimitA` accept the flat shape `ampLimitA` already accepts, or state one shape for both | quality | `src/domain-data.ts:69-81`; reproduced | A payload variant silently loses the pending-change notice | S | Very low | `pendingAmpLimitA({pendingAmpLimit: 7}) === 7` and the nested fixture still gives 7 | Could: no captured evidence the flat shape occurs |
| B-29 | Compute a state-of-health percentage or failure prediction | missing-feature | `src/history.ts:204-229`; `docs/architecture.md:137` no nominal capacity in the API | A percentage would be a fabricated denominator presented as health | M | High | Cannot be falsified against ground truth because the API reports no nominal capacity; any test would pin the guess | Won't: the honest version is a trend with an interval, already B4 in the intelligence report |
| B-30 | Fetch tariffs or weather inside the server, or schedule background digests | missing-feature | `SECURITY.md` offline claim; `src/planner.ts:1-6` prices arrive as an argument | It would add egress and a credential the project does not control, and the server is request-driven | M | High | The security posture test (`test/posture.test.ts`) and the no-third-party-call claim would have to be weakened | Won't: contradicts the offline and read-only design decisions stated in the docs |

## Rejected ideas

- **Shrink `domains.ts` by deleting `pinnedKeys` and the long descriptions.** The key sets are the
  fixture contract (`test/contract.test.ts:10-18`) and the descriptions are the routing surface read
  by the model (`src/domain-tools.ts:72-77`). Deleting them removes a real guard and a real prompt,
  not maintenance. The genuine maintenance item is B-25 only.
- **Have the planner infer phases from reported volts.** Whether `chargingVoltageVolts` is per-phase
  or line-to-line is unverified (`docs/live-contract-findings.md:43`), so a heuristic would convert
  one unstated assumption into another. B-02 needs a decided convention, not an inference.
- **Cache the `is-at-charge-location` null in the domain reader layer.** It is real, but the fix
  belongs to the transport cache lane (`src/caching-transport.ts`), not to `domain-data.ts`; the
  reader must keep returning `undefined` for unreported.
- **Replace JSONL history with SQLite now.** The store is opt-in and operator-managed; the observed
  defects are record shape and clock, which B-08 and B-22 fix without a migration.
- **Add a second distance/unit convention for odometer.** The contract test already pins one
  convention per summary (`test/contract.test.ts` fourth test); the remaining rounding difference
  between `distance` and `fromKm` is deliberate (dual-unit range versus single-unit odometer).
- **Surface every raw payload field in the humanizer.** The council product seat already resolved
  this: render the short actionable list and delete the other description promises (B-14), because
  raw is always available.
- **Correct `totalCost` by adding an efficiency factor only in the planner.** Grid energy belongs in
  the charge model (B-07) so the estimate and the plan share one figure, which is the reason the
  module exists (`src/charge-model.ts:1-9`).

## Commands run

All commands ran offline against `test/fixtures/dump`; temporary history directories were under
`/tmp` and deleted. Working tree before my writes: only `M .gitignore`, which I did not touch.

1. `npm test` -> `# tests 111`, `# pass 111`, `# fail 0`, `# duration_ms 339.54`.
2. `node --import tsx analysis/correctness/probe-charge-model.ts` -> `"reported_400V_x_3phases_kW": 19.2`, `"physical_3x16A_at_400V_line_to_line_kW": 11.085`, `"ratio_400V_path_vs_physical": 1.73`, estimate text `Time at 19.2 kW: ~1h 38m`.
3. `node --import tsx analysis/correctness/probe-planner.ts` -> `"energyPlannedKwh": 18.285714285714285`, `"shortfallKwh": 45.71`, `"totalCost": null` for the negative-price case, `"plannedLocalHours": [22,23,22]` for stop hour 28, `"fellBackToIndividualHours": false` for the named fallback test.
4. `node --import tsx analysis/correctness/probe-planner-contiguity.ts` -> `"gapHoursBetweenSteps": [0,0,0,20]`, `"reason": null`, `"saysNonContiguous": false`.
5. `node --import tsx analysis/correctness/probe-format.ts` -> `"formatAgeOfIt": "0s ago"`, `"summarizeError": "RangeError: Invalid time value"`, `"pct_NaN": "NaN%"`.
6. `node --import tsx analysis/correctness/probe-history.ts` -> `"retryOfSameEvent": "silently skipped"`, `"recordsAfterRetry": 0`, 130000 samples `"error": "RangeError: Maximum call stack size exceeded"`, torn line `"readableRecords": 3`.
7. Custom probe (`node --import tsx /tmp/verify-core.mjs`) observed: `polestar://vehicle/%E0%A4%A/telemetry/battery => THREW URIError URI malformed`; per-domain observedAtMs table where `amp-limit`, `charge-locations`, `charge-now`, `global-charge-timer`, `parking-climate-timer` equal `metaReceivedAt`; `moving car speed "45"` summary `["Position: 47.60620, -122.33210 (heading 121°, 0 km/h)", ...]`; `no heading` summary contains `heading °`; `charge-now` summary `["Charge-now override: present (synced)"]`; `tailgate unreported => locked false`; `degradationSeries([{SoC 50}])` -> `[{"observedAt":1,"socPct":50}]`; status-only session `peakPowerWatts 0`; `amp 0` model power 0; `phases 0` power 0; `now 12:00:55 -> first startsAt 2026-01-01T12:00:55.000Z`; `power 0 -> feasible true hoursNeeded Infinity steps 46`; `negative capacity -> feasible true energy -3.5 steps 0`; `formatAge 90min = 2 h ago`; `formatAge 47.5h = 2 d ago`; `chargeWindow` stop offset 120 ignored (returned 60); `pendingAmpLimitA flat undefined`.
8. Custom probe (`node --import tsx /tmp/verify-core2.mjs`) observed: sampler `start()` 0 and `describe()` "on, but this credential reports no vehicle to sample" for a throwing `vehicles()`; `get_history` for a stored `global-charge-timer` record printed `"2026-09-10T10:16:55.687Z {}"`; estimate with null `target-soc` printed `Energy to 80%: 32.0 kWh` with no assumed-target sentence while the planner printed `Missing required data`.
9. Custom probe (`node --import tsx /tmp/verify-core3.mjs`) observed: restart after stop gave `ticks after restart + resolving every sleep: 0` while `describe()` said "on"; settings clocks `amp-limit 2026-08-18T12:41:14.000Z vs metaReceivedAt 2026-09-10T10:16:03.215Z`, `global-charge-timer 2026-08-16T18:39:14.000Z vs 2026-09-10T10:16:55.687Z`, `parking-climate-timer 2026-06-21T12:00:04.000Z vs 2026-09-17T22:40:02.647Z`.
10. Custom probe (`node --import tsx /tmp/verify-core4.mjs`) observed: `fixture battery keys: 14`, all three optional readers `undefined`; capacity sweep `soc 53% energy 34.17 -> capacity 64.5` and `soc 6% energy 200 -> capacity 3333.3 kWh, energyNeeded 2466.7`; `16A 400V 3 phases => powerKw 19.2`; `parking-climate-timer => THREW TypeError timers.map is not a function`; `charge-locations => ["Saved charge locations: undefined"]`; `pre-cleaning => THREW RangeError Invalid time value`; `availability => ["Availability: [object Object] · n/a"]`; odometer summary omits 43 and 88 km/h; battery summary omits `CHARGER_POWER_STATUS_NO_POWER_AVAILABLE` and `CHARGING_TYPE_NONE`.
11. Custom probe (`node --import tsx /tmp/verify-core5.mjs`) observed: `A,B,A records: [ 'a', 'b', 'a' ]`; `records after malformed lines: 4 ids: [ 'a', 'b', 'a', 'z' ]` with two malformed lines silently dropped; `degradation over them` returned three SoC-only points.
12. Fixture-backed tool run (`node --import tsx /tmp/verify-core6.mjs`) with the shipped dump observed: `### get_charging_estimate isError=false` then `Usable-energy data not reported; showing the car's own estimate instead.` and no figure; `### get_car_status isError=false` then `Data as of 48 d ago (newest domain).`; plan printed `Pack capacity is unknown ...`.
13. `grep -h '"metaEventId"' -r test/fixtures/dump | sort | uniq -c` -> `14` identical `shardId-000000000000:...` lines.
14. `grep -rl "dischargeInfo\|chargingPowerWatts\|chargingVoltageVolts\|chargingCurrentAmps" test/fixtures/dump` -> no matches.
15. `grep -rh '"updatedAt"' test/fixtures/dump | sort | uniq -c` -> every occurrence is `1767225600000` (2026-01-01T00:00:00Z), the same constant in every payload that carries one.
16. `git status --porcelain` -> only ` M .gitignore` before my writes.
17. `node docs/check-docs.mjs hygiene` -> `HYGIENE_NO_EM_DASH`, `HYGIENE_BUZZWORDS_CLEAN`,
    `HYGIENE_NO_BANNERS`, `HYGIENE_NO_DASH_CONNECTORS`, `HYGIENE_CLEAN`, exit 0 (tree-wide,
    untracked analysis files included; run after this file was written on 2026-11-09).
18. `git status --porcelain` after the write -> the only entry is the untracked `analysis/` directory;
    no tracked file is modified by this task.

### Prior-work re-verification

- All five correctness probes I re-ran reproduce their recorded output exactly, so C3, C4, C5, C6,
  C11, C12, C17 and C18 stand as written.
- One prior magnitude claim is qualified, not refuted: `analysis/B-intelligence.md:102` gives the
  planner cost error as 12.5 percent and R2 gives 5.4 percent for a different price pair. Both
  probes are reproducible; the error depends on where the price boundary falls inside the last hour,
  so B-11 must be argued from the arithmetic, not from a fixed percentage.
- `analysis/B-intelligence.md:99` says the 23 to 28 window "collapses to one hour per day"; my
  re-run of the probe (22 to 28) and R2's direct run (23 to 28) both show the truncation, with the
  exact slot count depending on start hour. The defect stands; the count should not be quoted as a
  constant.
- `analysis/B-intelligence.md:113` says any trip reconstruction "cannot use" location speed. That is
  correct today for string payloads, but it is a reader bug (B-05), not an API limit: the value is
  present, and only the numeric conversion is missing. The docs are right; the conclusion that the
  field is unusable should not be carried forward once B-05 lands.
- New defects not in the prior reports: the URIError on a malformed VIN (B-17), the sampler restart
  and describe defects (B-23), the `pendingAmpLimit` reader asymmetry (B-28), the
  `parking-climate-timers` non-array throw (B-27), and the `charge-now` false state claim (B-15).
