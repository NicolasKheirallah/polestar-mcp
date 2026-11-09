# B. Intelligence and analytics

Area report for the five-agent deep dive. Scope: the analytical layer over the Polestar Data Portal M2M API in this repository at version 0.3.0, read in fixture mode only. No live API calls were made. Everything below cites `src/` with a line, a fixture path with a value, a doc with a line, or a command whose output is reproduced in the last section.

The short version: the server already has a charge model, a price planner, a history store and three longitudinal reports. On the reference car the charge model has no input it needs, the planner refuses to plan, the history tools silently return `{}` for eleven of fifteen domains, and the record timestamp is the time the server read the value rather than the time the car reported it. The data that would make the analytics worth having is mostly already in the payloads. The exceptions are listed in Rejected ideas.

## What exists

### The analytical modules

| Module | What it computes today | Inputs | The limit that matters |
| --- | --- | --- | --- |
| `src/charge-model.ts` | Charging power, implied pack capacity, energy to target | live power, amp limit, reported volts, phases, `dischargeInfo.energyAvailable`, SoC | Capacity exists only when the car reports `dischargeInfo.energyAvailable` (`src/charge-model.ts:61-70`). |
| `src/planner.ts` | Cheapest hours and estimated cost inside the charge window | caller-supplied hourly prices, SoC, target, capacity, power, window hours | Constant power, hourly prices, capacity required (`src/planner.ts:114-140`). |
| `src/history.ts` | Charging sessions, degradation points | battery records from the local JSONL store | Record time is the read time; sessions carry no energy (`src/history.ts:117-126`). |
| `src/history-tools.ts` | Three reports over the store | the store and one VIN | `get_history` filters every payload to five field names (`src/history-tools.ts:80-81`). |
| `src/sampler.ts` | Accrues four domains on a timer | `sampled: true` Domain rows | Off unless `POLESTAR_SAMPLE` (`src/server.ts:477-481`); 600 s default (`src/sampler.ts:129-131`). |
| `src/subscriptions.ts` | Notifies on `metaEventId` change | a subscribed resource URI | 60 s poll (`src/subscriptions.ts:36`), pauses at 90 percent budget (`src/subscriptions.ts:93-96`). |
| `src/format.ts` | Humanized summaries, active warnings, data age | one payload | Data age comes from `observedAtMs` (`src/domain-data.ts:120-132`). |

### The fixture baseline these tools see

One synthetic vehicle, `YSMTEST22PL000001` (`test/fixtures/dump/dataportal/vehicles.json`). The values below are used throughout this report.

- Battery: `batteryChargeLevelPercentage` 52, `estimatedDistanceToEmptyKm` 170, `averageEnergyConsumptionKwhPer100Km` 20.1, `chargingStatusV2` `CHARGING_STATUS_V2_IDLE`, `chargerConnectionStatus` `CHARGER_CONNECTION_STATUS_DISCONNECTED`, `estimatedChargingTimeToFullMinutes` 0 (`test/fixtures/dump/dataportal/telemetry/battery.json`). The payload has 14 keys and no `dischargeInfo`, no `chargingVoltageVolts`, no `chargingCurrentAmps`, no `chargingPowerWatts`.
- Odometer: `odometerMeters` 122952704 (122,952.7 km), `tripMeterAutomaticKm` 136.3, `tripMeterManualKm` 2863.2, `averageSpeedKmPerHour` 43, `averageSpeedKmPerHourAutomatic` 88 (`test/fixtures/dump/dataportal/telemetry/odometer.json`).
- Health: `daysToService` 313, `distanceToServiceKm` 4150, `engineHoursToService` 773, `lowVoltageBatteryWarning` `LOW_VOLTAGE_BATTERY_WARNING_NO_WARNING`, and 19 `lightWarnings` entries, all `EXTERIOR_LIGHT_WARNING_NO_WARNING` (`test/fixtures/dump/dataportal/telemetry/health.json`).
- Location: `coordinate.latitude` 47.6062, `coordinate.longitude` -122.3321, `heading` 121, `speed` `"0"` (string), `altitude` `"0"` (string) (`test/fixtures/dump/dataportal/telemetry/location.json`).
- Charge window: `globalChargeTimer.start.hour` 23, `stop.hour` 6, `start.timeZone.offsetMinutes` 120, `activated` false (`test/fixtures/dump/dataportal/charging/global-charge-timer.json`).
- Target: `targetSoc.batteryChargeTargetLevel` 80, `chargeTargetLevelSettingType` `CUSTOM` (`test/fixtures/dump/dataportal/charging/target-soc.json`).
- Amp limit: 20 A, and `pendingAmpLimit.ampLimit` is also 20 A (`test/fixtures/dump/dataportal/charging/amp-limit.json`).
- Climate timer: one timer, `readyAt.hour` 14, `weekdays` `["SUNDAY"]`, `repeat` false, `activated` false, `timeZone.offsetMinutes` 120 (`test/fixtures/dump/dataportal/charging/parking-climate-timer.json`).
- `charge-locations` carries only `id` and `utc0`; `is-at-charge-location` is a 404 `DATA_NOT_AVAILABLE` envelope (`test/fixtures/dump/dataportal/charging/charge-locations.json`, `test/fixtures/dump/dataportal/charging/is-at-charge-location.json`).

Two computed facts from the battery payload, because they recur below: 170 km times 20.1 kWh/100 km is 34.17 kWh remaining, divided by 0.52 is an implied pack of 65.71 kWh. The car's own range implies 326.9 km at 100 percent. These numbers are not in the server anywhere; they are the missing arithmetic.

### Measured behaviour on the shipped fixture

With `POLESTAR_FIXTURES_DIR=test/fixtures/dump` and a fresh history directory, these are the observed answers (full commands in the last section):

- `get_charging_estimate` prints `Usable-energy data not reported; showing the car's own estimate instead.` and then only the power assumption. No kWh, no time. The tool has no `capacityKwh` argument to rescue it (`src/aggregate-tools.ts:155`), unlike the planner (`src/advisor-tools.ts:16-20`).
- `plan_cheapest_charge` prints `Pack capacity is unknown (the car did not report dischargeInfo.energyAvailable and no capacityKwh argument was given).`
- `get_car_status` reports charge, range, locks, odometer and service correctly, then `Data as of 48 d ago (newest domain)`, which is the wall clock minus the fixture capture date, not a defect in the tool.
- `get_degradation_report` after those reads prints `Only 1 battery sample(s) recorded, need at least 5.` The fixture returns one constant `metaEventId`, so repeated reads dedupe to one line forever (`src/history.ts:51`).
- `get_history` for `charging/global-charge-timer` prints a timestamp followed by `{}`, and the same for `charging/target-soc`. The data is in the store; the five-field filter at `src/history-tools.ts:80` drops it.
- Every record written during that run has `observedAt` 2026-11-05T21:08:13Z while the payload `metaReceivedAt` values are 2026-09-10 to 2026-09-18. The gap is 48 to 56 days.

### Questions the current data answers today

- Instant state: charge, range, lock and open state, availability and usage mode, odometer, service countdown and warnings (`get_car_status`, `src/aggregate-tools.ts:35-93`).
- Charging energy and time: only when the caller supplies a capacity to the planner. The estimator has no such argument, and the reference car reports no usable energy, so the headline question "when will it be charged" has no numeric answer in the shipped product.
- Cheapest hours: yes, given a price curve, a configured window and a capacity the caller passes (`src/planner.ts:52-150`).
- Raw battery range and SoC over time: yes, if history is on and the car changes `metaEventId` (`get_history`, `src/history-tools.ts:51-88`).
- Raw odometer metres over time: yes, same condition, because `odometerMeters` is one of the five kept fields.
- Charging session boundaries at the sampler resolution: yes, if sampling is on (`src/history.ts:143-196`).
- Everything else in this report's candidate list: no, not today.

## What is missing

Ordered by how much a user would notice. Each gap names the design choice behind it.

1. **A numeric answer to "when will it be charged" on the reference car.** The estimator returns no energy and no time, because capacity comes only from `dischargeInfo.energyAvailable` (`src/charge-model.ts:61-70`) and the reference battery payload has no such key (fixture, 14 keys). The planner has a `capacityKwh` override (`src/advisor-tools.ts:16-20`) but the estimator does not (`src/aggregate-tools.ts:155`). Cause: one capacity source and two tool surfaces.
2. **A cost answer at all.** Sessions carry start, span, peak power and max SoC but no energy (`src/history.ts:117-126`), and prices are an argument that is never stored (`src/planner.ts:1-6`). There is no way to ask what a month of charging cost.
3. **Longitudinal answers by default.** History requires `POLESTAR_HISTORY_DIR` (`src/server.ts:68`), the three history tools are absent without it (`src/server.ts:201`), and the sampler is off unless `POLESTAR_SAMPLE` (`src/server.ts:477-481`). A default install records only what some tool call happened to read, so a user who asks once a day has one sample a day.
4. **History answers that are silently empty.** `get_history` accepts any registered domain (`src/history-tools.ts:66-75`) but keeps five field names (`src/history-tools.ts:80-81`): `batteryChargeLevelPercentage`, `estimatedDistanceToEmptyKm`, `odometerMeters`, `chargingPowerWatts`, `measuredParticulateMatter25`. Eleven of the fifteen domains therefore print `{}` when they have a record (measured for the charge timer and target SoC), health, location and every charging setting among them. The twelfth, `is-at-charge-location`, never records a row at all, because the car answers `DATA_NOT_AVAILABLE` and the client does not record an absent Domain (`src/client.ts:167-177`). An empty object reads like "nothing changed".
5. **A departure answer.** The climate timer is read and humanized (`src/format.ts:229-233`) but never combined with the charge window in `plan_cheapest_charge` (`src/advisor-tools.ts:51-56`), so "warm and charged by 14:00 Sunday" is two unrelated facts.
6. **A distance answer.** Odometer records are stored (`src/domains.ts:173`) and printed raw (`src/history-tools.ts:80`), but nothing subtracts two readings. The trip meters are rendered (`src/format.ts:160-164`) and not stored in any report.
7. **A trend with any statistical claim.** `get_degradation_report` prints first and last implied range (`src/history-tools.ts:112-116`) with no slope, no interval, no time-span requirement and no outlier rule. Six samples inside five minutes produce `327 km` to `327 km` and an agent can read that as "no degradation".
8. **A warning history.** Health is not sampled (`src/domains.ts:129-130`), `get_history` drops health fields (`src/history-tools.ts:80`), and the 12V and light warnings are enum states with no numeric series. A warning that appears between two tool calls is never recorded.
9. **A cross-domain "what happened" answer.** The store is one file per vehicle and domain (`src/history.ts:86-91`), `query()` takes one kind and name (`src/history.ts:56`), and every history tool names one domain (`src/history-tools.ts:26`). There is no join and no unified timeline.
10. **Fleet, geofence and digest answers.** Every tool resolves exactly one Vehicle (`src/vehicle-read.ts:71-143`); there is no coordinate in `charge-locations` and `is-at-charge-location` is unavailable, so a geofence needs user-supplied points; nothing in the server runs on a weekly schedule.

### Why these are missing: design choices, not data limits

| Design choice | What it blocks | Evidence |
| --- | --- | --- |
| History is opt-in | Every longitudinal question in a default install | `src/server.ts:68`, `src/server.ts:201` |
| Sampler is off by default, 600 s, clamped 60 to 3600 | Sample density and therefore sessions, trips and trends | `src/server.ts:477-481`, `src/sampler.ts:129-131` |
| Sampled domain set is 4 of 15 | Health, climate, all charging settings, pre-cleaning | `src/domains.ts` `sampled: true` at lines 75, 100, 154, 173 only |
| Dedupe is last-ID equality, not a set | Fixture history never grows; A, B, A stores A twice | `src/history.ts:18-21`, `src/history.ts:50-52`; measured A, B, A gives 3 records |
| No cross-domain joins | Timeline, digest, any "what changed together" | `src/history.ts:56-79`, `src/history-tools.ts:26` |
| `get_history` has a five-field filter | 11 of 15 domains render `{}` | `src/history-tools.ts:80-81`; measured `{}` |
| Record time is the read time | Value ages, backfill, correct sessions | `src/server.ts:110-111`; measured 48 to 56 day gap |
| No retention or prune | The store eventually refuses to be read | `src/history.ts:5`, `src/history.ts:61-62` |
| Fixture transport ignores the VIN and every fixture shares one `metaEventId` | Any offline demo of a trend, a session or two cars | `src/transport.ts:100-103`; all 14 domain payloads that carry an id use the same `shardId-...` string (17 JSON files in the dump, 14 with an id) |

The sampler budget arithmetic is worth stating because it bounds how much history any of these features can assume. Four domains at 600 s is 576 calls per vehicle per day, 5.8 percent of the 10,000 budget. At 60 s it is 5,760 per vehicle per day, and two vehicles at 60 s is 11,520, more than the daily limit, so a two-car credential cannot finish a day at the fastest allowed cadence. A single subscription is worse: it polls every 60 s (`src/subscriptions.ts:36`), battery TTL is 30 s (`src/domains.ts:74-75`), so every poll is a live refresh, 1,440 calls per day per subscribed URI.

Retention follows from the same numbers. A recorded battery line from the fixture is 786 bytes. At one record per minute while the car reports, 1,440 records is 1.13 MB a day, so the 64 MiB read refusal (`src/history.ts:61-62`) arrives in about 59 days. At the default 600 s sampler it is about 593 days. Nothing prunes, and the refusal message tells the user to prune without naming a tool.

### Where the existing models are weak

These are quantitative, and they are the reason several candidates below are framed as replacement logic rather than new surface.

**Charge model.** Power is live power, else amp limit times volts times phases (`src/charge-model.ts:47-59`). The reference car reports no volts and no live power, so the load-bearing assumption is 230 V line-to-neutral (`src/charge-model.ts:11`) and three phases by default at both call sites (`src/aggregate-tools.ts:166`, `src/advisor-tools.ts:57`). At 20 A that is 13.8 kW three-phase or 4.6 kW single-phase, a factor of three. For the 18.4 kWh the fixture needs to reach 80 percent, that is 1.33 h versus 4.00 h. Nothing in the answer states the phase default as an assumption beyond the arithmetic string, and no charge efficiency is modelled: at 90 percent wall-to-battery efficiency the grid energy is 20.44 kWh, 11.1 percent more than the answer implies. Capacity ignores SoC rounding: at 52 percent a one-point error is 1.9 percent; at 10 percent it is 10 percent. The target fallback is inconsistent between the two tools: `get_charging_estimate` silently uses 80 percent when `target-soc` is null (`src/aggregate-tools.ts:170,178`), while `plan_cheapest_charge` refuses the same car (`src/advisor-tools.ts:79`). Measured with target-soc null: the estimator prints `Energy to 80%` and its assumptions line never says 80 was assumed; the planner prints `Missing required data`. Finally the car's own estimate is labelled `to 100%` (`src/aggregate-tools.ts:191`) although the field is `estimatedChargingTimeToFullMinutes` and its relation to the configured target is not established by any fixture (the fixture value is 0).

**Planner.** Four independent problems, all measured:

- The window is treated as hours 0 to 23. `windowEndHour` is documented 0 to 23 (`src/planner.ts:18-21`) and `chargeWindow` passes the payload hour through unchanged (`src/domain-data.ts:99-100`), but the project's own test payload uses stop hour 28 (`test/charge-model.test.ts:26`). With start 23 and stop 28, the non-wrap branch `localHour >= 23 && localHour < 28` (`src/planner.ts:70-73`) matches only hour 23, so the window collapses to one hour per day. Measured: two slots 24 hours apart, billed as one contiguous block because block detection indexes the filtered slot list, not the clock (`src/planner.ts:118-125`).
- Block contiguity ignores time. Slots from different nights are adjacent in the filtered list. Measured: a one-phase car needing 11.43 h produced 12 steps spanning two nights with an 18-hour gap and `reason` undefined, so the answer claims a contiguous plan that cannot happen.
- Price curves are assumed hourly and matched by first `find` (`src/planner.ts:86-92`). A 15-minute curve is mispriced: measured one step for the whole hour at the first quarter's price.
- Cost spreads energy evenly over the rounded-up hours (`src/planner.ts:132-140`). For 20.7 kWh at 13.8 kW the need is 1.5 h, so the planner books two hours of 10.35 kWh each at the two hours' prices. Measured total 3.105 against a true 2.76 from charging from the block start, 12.5 percent high. Negative prices are real in the Nordic market and `totalCost` is only emitted when positive (`src/planner.ts:147`), so a negative-price plan loses its cost line. Slot starts inherit the call's seconds: measured start `2026-09-19T00:00:55.000Z`.
- The offset is fixed (`src/planner.ts:67`), so a plan across a daylight-saving change is an hour out twice a year.

**Degradation.** The signal is range divided by SoC (`src/history.ts:217-222`), so its noise gain is 100 divided by SoC kilometres of implied range per kilometre of reported range: 1.92 at the fixture's 52 percent, 5 at 20 percent, 10 at 10 percent, 16.67 at 6 percent. The only gate is `soc <= 5` (`src/history.ts:211`), so the noisiest admissible points get the largest weight. There is no minimum time span: six identical samples five minutes apart give `327` to `327` and pass the five-sample gate (`src/history-tools.ts:104`). The first and last points set the whole conclusion (`src/history-tools.ts:112-116`), with no slope, no interval and no exclusion of a single outlier. The `points.length` in the header counts points without a range value too (`src/history-tools.ts:111`), so "usable samples" overstates what was usable. Conditions are not controlled: the car's range estimate already reflects temperature, speed and wheel choice, and there is no temperature field to correct with (see Rejected ideas). On the reference car the capacity line can never appear, because it needs `dischargeInfo.energyAvailable`, which the car does not report.

**Charging sessions.** A session is a maximal run of charging samples with gaps up to 30 minutes counted as active (`src/history.ts:143,168`), and `activeSeconds` is last minus first (`src/history.ts:189`). Measured: a 29-minute gap inside a run yields 2,940 active seconds for four samples spanning 49 minutes. A single sample yields a session with `activeSeconds` 0, printed as `0 min` (`src/history-tools.ts:155`). Peak power defaults to 0 when the car reports no power, so a status-only car shows `peak 0.0 kW`; measured. There is no energy, no start or end SoC separate from the max, no charger type, no cost, and no minimum duration, so one spurious charging sample becomes a session. At the default 600 s cadence a session shorter than ten minutes can be missed entirely, and the tail is undercounted by up to one interval. `get_charging_sessions` says `No charging sessions in the recorded history.` for zero samples and for a car that never charged (`src/history-tools.ts:151`), which is the same sentence for two different facts; the degradation report by contrast names its sample count (`src/history-tools.ts:104-106`).

**History store.** Three structural weaknesses beyond the read clock: dedupe remembers only the last ID (`src/history.ts:51`), so a re-served older event is appended again; `query()` loads the whole file and filters in memory (`src/history.ts:64-78`), so cost grows with history size and the 64 MiB guard is the only ceiling; and there is no compaction, index or schema version, so a future record shape change has no migration path.

**Data ages.** `observedAtMs` prefers the payload's own `timestamp.seconds` and falls back to `metaReceivedAt` (`src/domain-data.ts:120-132`). For charging settings that is the wrong clock: `globalChargeTimer.metadata.updatedAtTimestamp` is 2026-08-16T18:39:14Z while `metaReceivedAt` is 2026-09-10T10:16:55Z, a 24.65-day difference; `ampLimit.updatedAtTimestamp` is 2026-08-18T12:41:14Z against the same 2026-09-10 receive time, 22.90 days. The parking climate timer's own `metadata.updatedAtTimestamp` is 2026-06-21T12:00:04Z, 88 days before its 2026-09-17 `metaReceivedAt`. The humanized age line therefore understates how old a setting is, by exactly the amount `docs/upstream-api.md:16` already documents. The age line is one of the server's advertised behaviours, and it is wrong for the settings most likely to be stale.

**Location.** The live contract findings record that `speed` and `altitude` are strings (`docs/live-contract-findings.md:45`), and the fixture has `"0"` for both. `position()` reads speed through `asNumber` (`src/domain-data.ts:150`), so the value is always `undefined` for a string, and the summary then prints `0 km/h` through `?? 0` (`src/format.ts:169`). Altitude has no reader at all. Any trip reconstruction that wanted speed cannot use it, and the rendered 0 km/h is a false value rather than an absent one.

## Candidates

Twelve candidates. Order in the table is recommendation order, which is also dependency order for most of them. Each has a falsifiable check that can fail, a named module, and a production failure mode.

| id | name | user question | data it reads | effort | risk | falsifiable check |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Capacity fallback chain for estimate and plan | How much energy do I need, and when will it be charged? | `estimatedDistanceToEmptyKm`, `averageEnergyConsumptionKwhPer100Km`, `batteryChargeLevelPercentage`, `dischargeInfo.energyAvailable`, amp limit, volts, phases, target | S | low | With the shipped fixture, estimate prints kWh and minutes; implied capacity is 65.7 kWh plus or minus 1; phases=1 gives 4.6 kW; a null target is stated as assumed and both tools agree |
| B2 | Charging energy and cost ledger | What did charging cost, and did the cheap hours save anything? | battery history (SoC, power, `dischargeInfo`), session boundaries, caller price curve | M | medium | 40 to 70 percent on a 65.7 kWh pack yields 19.7 kWh plus or minus 0.2; a session across a price boundary splits at the hour; empty prices produce no cost claim; savings against a stated baseline equals the arithmetic difference and is zero at the average price |
| B3 | Departure readiness from the climate timer | Will the car be warm and charged by 14:00 Sunday? | `parkingClimateTimers[].readyAt.hour`, `weekdays`, `activated`, `repeat`, `timeZone.offsetMinutes`, charge window, target, SoC, power | M | medium | Tuesday 10:00 plus Sunday 14:00 means the charge deadline is Sunday 06:00 and 18.4 kWh fits the 7-hour window; `activated:false` is reported as "the car will not precondition"; a date-less one-shot timer is refused as ambiguous |
| B4 | Battery health trend with confidence bounds | Is the battery degrading, and by how much per year? | `estimatedDistanceToEmptyKm`, `batteryChargeLevelPercentage`, `dischargeInfo.energyAvailable` over history | M | medium | Synthetic 2 km/month slope with noise yields an interval that contains 2 and excludes 0; a span under 90 days is refused; SoC under 20 percent is excluded; five samples in one hour are refused |
| B7 | Cross-domain timeline and typed history query | What happened to my car yesterday? | `metaEventId`, `metaReceivedAt`, `timestamp.seconds`, and the per-domain readers in `src/domain-data.ts` | M | low to medium | Two domains 60 s apart join into one ordered row; `get_history charging/global-charge-timer` prints start 23 and stop 6, not `{}`; a record read 48 days after its `metaReceivedAt` is dated by its own clock |
| B6 | Trip and odometer reconstruction | How far did I drive this week? | `odometerMeters`, `tripMeterAutomaticKm`, `tripMeterManualKm` over history | M | medium | 122,952,704 to 122,987,704 m reports 35.0 km; a decreasing odometer is a reset event, not negative distance; a gap over 24 h is not interpolated; three samples are the minimum |
| B5 | Warning transition detector on health | Did a new warning appear? | `lowVoltageBatteryWarning`, 19 `lightWarnings` keys, `brakeFluidLevelWarning`, `engineCoolantLevelWarning`, `oilLevelWarning`, `washerFluidLevelWarning`, `serviceWarning` | S | low to medium | `NO_WARNING` to a warning produces exactly one event; an unchanged state produces none; a warning that appears and clears between samples is reported as unobserved, not absent; health is added to the sampled set |
| B10 | Settings change and confirmation timeline | Did my charge limit change actually reach the car? | `ampLimit.ampLimit`, `pendingAmpLimit.ampLimit`, `pendingGlobalChargeTimer`, `globalChargeTimer`, `targetSoc`, `updatedAtTimestamp` | S | low | 20 A to pending 7 A to applied 7 A produces one change with two events; the fixture's pending 20 A against applied 20 A produces none; `pendingGlobalChargeTimer` with only `metadata` means nothing queued |
| B9 | Service due forecast | When will the car need service? | `daysToService`, `distanceToServiceKm`, `engineHoursToService`, `odometerMeters` over history | S | low | 500 km per week against 4,150 km is 8.3 weeks against 44.7 weeks from 313 days, so distance wins; under three odometer samples returns "insufficient history" |
| B8 | Weekly digest | What changed this week? | the outputs of B2, B4, B5, B6, B9, B10 | S | medium | A synthetic 7-day store names each changed item once; an empty store says "no history recorded", not "nothing changed"; a store with sampling off says so |
| B11 | Geofence arrival and departure | Tell me when the car arrives home | `coordinate.latitude`, `coordinate.longitude`, `heading`, `timestamp.seconds` over location history | M | high | 149 m from a 150 m fence is inside and 151 m is outside (haversine); a transition across a sampling gap carries an "uncertain between T1 and T2" marker; `POLESTAR_ALLOW_LOCATION=false` refuses rather than answering "not home" |
| B12 | Multi-vehicle comparison | Which of my cars is cheaper and healthier? | per-VIN battery, odometer, health and history; `list_vehicles` | L | high | Two synthetic stores with 65.7 and 78 kWh capacity produce a table without any "health percent" claim; one VIN refuses to compare; fixture mode needs a per-VIN dump layout to run at all |

### B1. Capacity fallback chain for estimate and plan

Question: the headline "when will it be charged" currently has no number on the reference car.

Where it lives: `src/charge-model.ts`, in `chargeModel` or a new `capacityEstimate` beside it. The two call sites already share the model (`src/aggregate-tools.ts:168-176`, `src/advisor-tools.ts:66-74`), so a fallback added there reaches both without new surface. `get_charging_estimate` gains a `capacityKwh` argument for symmetry with the planner (`src/advisor-tools.ts:16-20`).

Fields and the chain: `dischargeInfo.energyAvailable` divided by SoC wins when present; else `estimatedDistanceToEmptyKm` times `averageEnergyConsumptionKwhPer100Km` divided by 100 divided by SoC; else a learned capacity from charging sessions in history; else the caller's argument; else refuse and say which paths were empty. The fixture supports the second path at 65.71 kWh. The answer must name the source and the disagreement when two sources exist, and add a charge-efficiency assumption (a single stated figure) and the phase count to `assumptions`.

Falsifiable check, in `test/charge-model.test.ts` plus a fixture-driven assertion in `scripts/demo-dump.ts`: with the shipped fixture, `get_charging_estimate` must print an energy in kWh and a time in minutes; the implied capacity must be 65.7 plus or minus 1 kWh; `phases: 1` must produce 4.6 kW and 4.00 h; a null `target-soc` must print that 80 percent was assumed, and `plan_cheapest_charge` with the same fixture must not refuse for capacity. Break the fallback and the estimate returns to the measured no-answer text.

What would make it wrong in production: the car's range estimate and its long-term consumption average are computed over different windows, so multiplying them assumes the range was computed with that same average; if the car uses recent consumption instead, the implied capacity is biased and nothing in the API cross-checks it. If `dischargeInfo.energyAvailable` ever means gross rather than usable energy, the capacity is gross while targets are usable. SoC rounding limits accuracy at low charge. And an unstated efficiency is a systematic understatement of cost and time, not a random error.

### B2. Charging energy and cost ledger

Question: what did charging cost last month, and did charging in the cheap hours actually save money?

Where it lives: energy per session belongs in `src/history.ts` beside `ChargingSession` (`src/history.ts:117-126`); the ledger itself is a small new `src/cost-ledger.ts`; the tool joins `src/history-tools.ts`. Price curves should be persisted as a local JSONL file next to the history directory, because the planner currently takes them as an ephemeral argument (`src/planner.ts:1-6`) and a ledger cannot reconstruct what a past plan was worth without the curve it used. This is the one candidate that adds local persistence beyond the existing store, and it should be stated as such.

Fields: session start and end from battery `timestamp.seconds` or `metaReceivedAt`, `batteryChargeLevelPercentage` at both ends, capacity from B1, `chargingPowerWatts` to integrate when present, `dischargeInfo.energyAvailable` when present, and the price slot `startsAt`/`price`. Two energy methods should be computed and compared: capacity times SoC delta, and the trapezoid of reported power over sample times. Their disagreement is the confidence signal.

Falsifiable check, in a new `test/history-analytics.test.ts` with synthetic records: a session from 40 to 70 percent on 65.71 kWh must yield 19.7 kWh plus or minus 0.2; a session crossing a price boundary at the hour must split its energy at the sample or interpolation point; no prices must mean no cost claim rather than zero cost; the savings figure against a stated baseline (charging immediately at the session start price) must equal the arithmetic difference and must be exactly zero when the session price equals the baseline price. A second check with the fixture's constant `metaEventId` proves the ledger refuses rather than inventing sessions.

What would make it wrong in production: the sampler resolution. A 12-minute charge at the 600 s cadence can be one sample, which yields no energy; the ledger must therefore exclude sessions with fewer than two usable samples and say how many it excluded. Capacity drift, price curves pasted by a model rather than a tariff file, spot prices that exclude grid fees and tax, fixed-price contracts where "savings" is meaningless, and daylight saving at the price boundary all distort it. Negative prices are legitimate and must not be dropped as `totalCost` does today (`src/planner.ts:147`).

### B3. Departure readiness from the climate timer

Question: will the car be warm and charged by 14:00 Sunday?

Where it lives: pure arithmetic in a new `src/departure.ts`, exposed through `src/advisor-tools.ts` next to `plan_cheapest_charge`. It reads the climate timer domain that is currently only humanized (`src/format.ts:229-233`) and the charge window the planner already reads (`src/advisor-tools.ts:51-56`).

Fields: `parkingClimateTimers[].readyAt.hour` 14, `.weekdays` `["SUNDAY"]`, `.activated` false, `.repeat` false, `.timeZone.offsetMinutes` 120; `globalChargeTimer.start.hour` 23, `.stop.hour` 6, `.activated` false, offsets 120; `targetSoc.batteryChargeTargetLevel` 80; `batteryChargeLevelPercentage` 52; power from the charge model.

Falsifiable check, in a new `test/departure.test.ts` with injected clock: with now Tuesday 10:00 local, the deadline is Sunday 06:00 because the window ends at 06:00 and the ready-at is 14:00; 18.4 kWh needs 1.34 h at 13.8 kW inside the 7-hour window and the answer must say feasible; `activated:false` on either timer must produce an explicit "the car will not do this on its own" sentence; a one-shot timer with no date must be refused as ambiguous rather than guessed; a single-phase charger must still be feasible (4.0 h of 7). Break the window-end rule and the check must fail on the deadline.

What would make it wrong in production: the timer has a weekday and an hour but no date, so "next Sunday" is an assumption that is wrong on Sunday itself. `repeat:false` semantics are not established. Fixed offsets mis-time DST weeks. The car may precondition only when plugged in or above a charge threshold, and the payload does not report that condition. Most importantly the API is read-only, so this is advice the user must act on in the Polestar app; it cannot start anything.

### B4. Battery health trend with confidence bounds

Question: is the battery degrading, and at what rate per year?

Where it lives: `src/history.ts` gains a regression over `DegradationPoint` with an interval and a guarded sample selection; `src/history-tools.ts` renders slope, interval, span and the number of excluded points.

Fields: `estimatedDistanceToEmptyKm`, `batteryChargeLevelPercentage`, `averageEnergyConsumptionKwhPer100Km` as a covariate, and `dischargeInfo.energyAvailable` when present. Selection: SoC at or above 20 percent (noise gain 5 or less), at least 90 days between the first and last usable point, at least 8 points, and at least 3 distinct SoC values. Report the slope in km per month with an interval, and refuse otherwise.

Falsifiable check, in `test/history-analytics.test.ts`: a synthetic 12-month series with a 2 km/month slope and 5 km noise must produce an interval containing 2 and excluding 0; a 6-sample one-hour series must be refused with the reason; a series whose only low-SoC points are at 6 percent and shift by 1 km must not move the slope beyond the interval (the point moves 16.7 km, measured); a series with `dischargeInfo` absent must not print a capacity trend.

What would make it wrong in production: range is conditions-dependent and the API has no temperature field, so a winter series looks like degradation and a summer series looks like recovery; a wheel or tyre change moves every point; an over-the-air range-model change is a step, not degradation; and a single outlier sets the current first-or-last report (`src/history-tools.ts:112-116`). The confidence interval is only honest if those confounders are named in the answer, and seasonality cannot be corrected without a temperature series the server does not have.

### B7. Cross-domain timeline and typed history query

Question: what happened to my car yesterday?

Where it lives: `src/history.ts` gains a multi-domain `queryTimeline(vin, domains[], range)`; a new `src/timeline.ts` owns the ordering and the per-domain field map; `src/history-tools.ts` gains a tool and replaces the five-name filter (`src/history-tools.ts:80-81`) with the readers already in `src/domain-data.ts`. This is the substrate for B2, B6, B8 and B10; it should land before them.

Fields: `metaEventId`, `metaReceivedAt`, `timestamp.seconds` for every domain, plus the reader output per domain. The record clock must be the value's own clock: `timestamp.seconds`, else `metaReceivedAt`, else the nested `updatedAtTimestamp` for settings, else the read time with the fact stated.

Falsifiable check, in `test/history-analytics.test.ts`: synthetic battery and odometer records 60 seconds apart must produce one ordered row carrying both domains; a record whose `metaReceivedAt` is 48 days before its `observedAt` must be dated 48 days earlier; `get_history charging/global-charge-timer` must print `23` and `6` instead of `{}`; a requested domain with no records must be absent from the row, not rendered as zeros; a query for two domains must not fail because one file is missing.

What would make it wrong in production: different domains have different clocks and TTLs, so "the same minute" is not the same event; a time join is not causality and the answer must not imply it; a 64 MiB file is loaded whole per domain per call, so a multi-domain query multiplies the memory and the cap; and the `metaEventId` space is not global, so two domains can change for one underlying car event or for unrelated ones and the join cannot tell.

### B6. Trip and odometer reconstruction

Question: how far did I drive this week, and when?

Where it lives: a new `src/trips.ts` over odometer history, rendered in `src/history-tools.ts`. Odometer is already sampled (`src/domains.ts:173`), so the input exists whenever sampling is on.

Fields: `odometerMeters` (122952704 in the fixture), `tripMeterAutomaticKm` 136.3, `tripMeterManualKm` 2863.2, `averageSpeedKmPerHour` 43, and the record clock. Explicitly not `speed`, which is a string and unreadable (`src/domain-data.ts:150`, `docs/live-contract-findings.md:45`).

Falsifiable check, in `test/history-analytics.test.ts`: 122,952,704 to 122,987,704 m is 35.0 km; a decreasing odometer is a reset event and never negative distance; a gap over 24 h is not interpolated and is named as a gap; fewer than three records returns "insufficient history"; the weekly total under a timezone with a DST change is still a difference of integers.

What would make it wrong in production: the odometer only changes when the car reports, so a week parked is one record and zero distance, which is correct but easy to misread as a missing week. Sampling at 10 minutes cannot separate a trip from being towed or ferried. Trip meters are per the car's own reset semantics and are not the same window as the report. A module replacement resets the odometer. Location is the only way to attribute distance to places, and it is opt-out.

### B5. Warning transition detector on health

Question: did a new warning appear, and when?

Where it lives: a transition function in `src/history.ts` over `activeWarnings` (`src/format.ts:256-289`), a tool in `src/history-tools.ts`, and one registry edit: `sampled: true` for health (`src/domains.ts:129-130`). The sampler derives its set from that flag (`src/sampler.ts:126`), so no sampler edit is needed. Cost: 144 calls per vehicle per day, taking a one-car install with sampling on from 576 to 720, and a three-car credential from 1,728 to 2,160, about 22 percent of the daily budget.

Fields: `lowVoltageBatteryWarning`, the 19 `lightWarnings` positions, `brakeFluidLevelWarning`, `engineCoolantLevelWarning`, `oilLevelWarning`, `washerFluidLevelWarning`, `serviceWarning`, plus `daysToService` and `distanceToServiceKm` for a trend on the countdown.

Falsifiable check, in `test/history-analytics.test.ts`: synthetic health records `NO_WARNING` then `BRAKE_FLUID_LEVEL_WARNING_LOW` must produce exactly one transition at the second observation; an unchanged sequence must produce none; a warning present at one sample and absent at the next must be reported as cleared, and one that appears and clears between two samples cannot be claimed either way; the fixture's all-OK payload must produce no events; adding `sampled: true` must appear in `SAMPLED_DOMAINS` and change the sampled list from four to five in a runtime test.

What would make it wrong in production: a warning that comes and goes within one 10-minute interval is invisible, so silence means "not observed", not "not present", and the answer must say which. The car's warning enum is already its own diagnosis, so the marginal value over `get_needs_attention` is timing, not detection. If sampling is off, only tool calls record health, so the feature's usefulness depends on the user asking. And a low washer-fluid warning is not an anomaly worth an alert; the transition list needs a severity order, or it becomes noise.

### B10. Settings change and confirmation timeline

Question: did my charge limit change actually reach the car, and when?

Where it lives: `src/history.ts` over the charging settings records, rendered in `src/history-tools.ts`. The readers already exist: `ampLimitA`, `pendingAmpLimitA`, `chargeWindow`, `targetSoc` (`src/domain-data.ts:52-107`), and the humanizer already diffs pending against applied (`src/format.ts:210-217`).

Fields: `ampLimit.ampLimit` 20, `pendingAmpLimit.ampLimit` 20, `pendingGlobalChargeTimer` containing only `metadata`, `globalChargeTimer.activated` false, `start.hour` 23, `stop.hour` 6, `targetSoc.batteryChargeTargetLevel` 80, `chargeTargetLevelSettingType` `CUSTOM`, and `updatedAtTimestamp` for the value clock.

Falsifiable check, in `test/history-analytics.test.ts`: a sequence with applied 20, pending 7, applied 7 must produce one change event with a "recorded" and a "confirmed" time; the fixture pair where pending and applied are both 20 must produce none (the humanizer test at `test/planner.test.ts:20-36` covers the single-payload case, not the history); a `pendingGlobalChargeTimer` with an empty `metadata` object must mean nothing queued; the event time must come from `updatedAtTimestamp` (2026-08-16 for the timer) rather than `metaReceivedAt` (2026-09-10), and the 24.65-day difference must appear in the output.

What would make it wrong in production: `pendingAmpLimit` is present even when it equals the applied value, so presence is not a change and the fixture proves it. A pending change the car never confirms would be reported as pending forever. The M2M view is stale by weeks (`docs/upstream-api.md:16`), so a change made in the app may be observed long after it happened, and the "when" is the API's receive time, not the user's action time. `syncStatus` values are unverified beyond `SYNCED`.

### B9. Service due forecast

Question: when will the car need service?

Where it lives: a small function in `src/history.ts` or a new `src/service-forecast.ts`, with the answer added to `get_needs_attention` (`src/aggregate-tools.ts:122-148`) or a history tool. Cheap, because the countdown is already read and rendered (`src/format.ts:183-191`).

Fields: `daysToService` 313, `distanceToServiceKm` 4150, `engineHoursToService` 773, `odometerMeters` over history, `odometerMeters` delta per day.

Falsifiable check, in `test/history-analytics.test.ts`: odometer records showing 500 km per week against 4,150 km remaining give 8.3 weeks; 313 days gives 44.7 weeks; the answer must name the earlier limit; a car with fewer than three odometer samples returns "insufficient history" rather than a date; a decrease in odometer must not produce a negative rate. The fixture baseline of 313 days and 4,150 km is the seed for a known-answer test.

What would make it wrong in production: the countdown is itself an estimate maintained by the car and may be annual rather than mileage-based, in which case the days value matters more than any extrapolation; the weekly rate from sparse samples is noisy; a long trip distorts it; and `engineHoursToService` is reported on the reference car (773) though it is a battery-electric vehicle, so its meaning for this car is unverified. The answer should present the two limits and the rate, not a single predicted date.

### B8. Weekly digest

Question: what changed this week?

Where it lives: a composition tool in `src/history-tools.ts` plus a fourth prompt beside the existing three (`src/server.ts:338-412`). It must not be a push notification: nothing in the server runs on a weekly schedule. `POLESTAR_SAMPLE` is a sampling timer (`src/sampler.ts:74-89`), not a scheduler, and the MCP server is request-driven. A digest is a prompt the client runs, or an external scheduler calling the server.

Fields: the outputs of B2, B4, B5, B6, B9 and B10, plus the current state from `get_car_status`. Each item must carry its own time window and its own value age.

Falsifiable check, in `test/history-analytics.test.ts`: a synthetic store spanning seven days names each changed item exactly once; a store with zero records says "no history recorded", not "nothing changed"; a store with sampling off and zero tool reads says history is empty and names the variable that turns it on; a settings item whose `updatedAtTimestamp` predates the window by 88 days is not reported as a change in the window.

What would make it wrong in production: a sparse store makes an eventless week look quiet when it is unobserved; the stale settings (24.65 days for the timer, 88 days for the climate timer) can be presented as if they were new; a digest built on read-clock timestamps would place old events in the current week. It is also the candidate most likely to overstate certainty, because a prose digest hides how few samples it had.

### B11. Geofence arrival and departure

Question: tell me when the car arrives home, or leaves a place.

Where it lives: a new `src/geofence.ts` over location history, rendered in `src/history-tools.ts`. Location is sampled (`src/domains.ts:154`) and blocked at the request layer when `POLESTAR_ALLOW_LOCATION=false` (`src/client.ts:140-146`), so the privacy switch already exists and must be honoured by the new tool.

Fields: `coordinate.latitude` 47.6062, `coordinate.longitude` -122.3321, `heading` 121, `timestamp.seconds`, and a user-supplied fence centre and radius. No data source supplies the home point: `charge-locations` has no coordinates and `is-at-charge-location` answers `DATA_NOT_AVAILABLE` (both fixture).

Falsifiable check, in a new `test/geofence.test.ts`: haversine places 149 m inside and 151 m outside a 150 m fence; a sequence inside, inside, outside produces one departure at the boundary between the second and third samples; a transition across a gap longer than the cadence carries an "occurred between T1 and T2" marker; `POLESTAR_ALLOW_LOCATION=false` returns the existing refusal rather than "not home"; the fixture coordinate is classified correctly.

What would make it wrong in production: GPS drift of tens of metres makes small fences noisy, indoor parking leaves the last known position stale for hours, a 10-minute cadence misses short visits and produces false departures, and location history is the most sensitive data the server holds. The fixture coordinate is in Seattle while the rest of the fixture suggests Sweden (`docs/upstream-api.md` region EU/EEA), which is a reminder that the fixture is synthetic and cannot validate a geographic rule. This candidate should wait for a privacy review.

### B12. Multi-vehicle comparison

Question: which of my cars is cheaper to run, and which is healthier?

Where it lives: a new `src/fleet.ts` with a multi-VIN read, plus a change in `src/vehicle-read.ts`, which today returns one `VehicleScope` (`src/vehicle-read.ts:121-143`). History is already per VIN (`src/history.ts:86-91`), so the store needs no change.

Fields: per VIN `batteryChargeLevelPercentage`, `averageEnergyConsumptionKwhPer100Km`, `odometerMeters` deltas, `daysToService`, warning states, and B1/B2/B4 outputs. Not "state of health", because the M2M API reports no nominal pack capacity, so a health percentage has no denominator.

Falsifiable check, in `test/fleet.test.ts` with two fake clients and two stores: 65.7 and 78 kWh packs produce a table with per-car consumption and no health percentage; one VIN refuses to compare rather than comparing a car to itself; a VIN the credential cannot see is refused through `AUTHZ_VIN_UNAUTHORIZED` handling; fixture mode cannot run this test at all until `FixtureTransport` learns a per-VIN layout (`src/transport.ts:100-103`) and the fixtures stop sharing one `metaEventId`, and the test must assert that limitation rather than hide it.

What would make it wrong in production: different models have different pack sizes and consumption, so any ranking of "health" is invalid without spec data; the consumer app API that carries model details is deliberately unwired (README, Status; `docs/consumer-adapter-note.md`); a delegated account may belong to another owner, so a fleet view can cross a privacy line; and `list_vehicles` is cached for an hour (`src/domains.ts:366-367`), so a newly added car is missing from a comparison. For the owner's single-car project (README, Status) the user value is close to zero today.

## Rejected ideas

- **Temperature-conditioned range forecast.** No domain reports a temperature. The battery payload has 14 keys and none is a temperature (fixture; `docs/live-contract-findings.md:43-45`), and the live contract notes say cabin temperature in parking climatization never appeared (`docs/upstream-api.md:121`). A forecast "under temperature" would need a caller-supplied temperature or a new upstream field. The consumption part of the idea is kept in B1, where `averageEnergyConsumptionKwhPer100Km` is real.
- **Tire-pressure anomaly detection.** The contract lists tyre pressure values for health, and the live scan says they did not appear (`docs/upstream-api.md:121`). The health fixture has no pressure field, only the 19 light-warning enums and the fluid warnings. Nothing to trend.
- **12V voltage trend.** The only 12V signal is `lowVoltageBatteryWarning`, an enum (fixture), not a voltage. A trend needs a numeric series the API does not publish. The honest version is the warning transition in B5, and it should not be sold as battery health.
- **Server-side natural-language query layer ("ask my car").** The MCP client already turns language into tool calls, which is the premise of the tool surface (`README.md:5`, `docs/tools-reference.md:9`). Putting a language model inside the server would add a dependency and a network call, and `SECURITY.md` states there is no third-party call and nothing leaves the machine except the Data Portal GETs and the token request. It is also untestable as a query: the same question could return different windows. The testable part of the idea is B7, a typed query with exact filters.
- **Write-side features: start climate now, charge now, set target, set window.** The API publishes no write endpoint; `POLESTAR_ENABLE_WRITES` registers nothing (`src/server.ts:220-224`, `test/posture.test.ts`, `docs/write-endpoints.md`). B3 is advice only for that reason.
- **A savings leaderboard or gamified efficiency score.** The baseline is arbitrary, the sample is one household, and a score would present a tariff choice as a comparable achievement. The falsifiable part (did cheap-hour charging cost less than the stated counterfactual) is in B2 and should stay there.
- **External tariff or weather fetch inside the server.** Prices arrive as an argument (`src/planner.ts:1-6`) precisely so the server stays offline and credential-free (`SECURITY.md`). Fetching them would add egress, a provider key and a contract the project does not control.
- **State-of-health percentage or failure prediction from five samples.** The M2M API reports no nominal capacity, and the degradation signal at low SoC is dominated by noise (16.67 km of implied range per km reported at 6 percent). B4 gives a trend with an interval and refuses short spans; a health percentage or a failure prediction would be false confidence, and `docs/architecture.md:137` already states the report presents series, not verdicts.
- **Cabin air-quality trend from pre-cleaning.** The domain is not sampled (`src/domains.ts:216`), its TTL is 30 minutes (`src/domains.ts:215`), the fixture reports PM2.5 0 and AQI 0, and there is no outside-air or location context to make a claim actionable. Low value, and sampling it would spend quota on a number that is zero.
- **Charge-location geofencing from `charge-locations`.** The domain answers with an id and `utc0` only, with no coordinates (fixture; `docs/upstream-api.md:121`), and `is-at-charge-location` is `DATA_NOT_AVAILABLE` on this vehicle (fixture). A charger arrival rule must be a user-defined fence, which is B11.
- **Trip-since-charge from the battery payload.** The contract mentions a since-charge consumption average and the reference car did not report it (`docs/upstream-api.md:121`; battery fixture has no such key). A "since last charge" distance needs odometer plus session boundaries, which is B2 plus B6, not a battery field.

## Commands run and observed output

All commands ran against `test/fixtures/dump` with no credential and no network. History commands used a temporary directory under `/tmp`, deleted afterwards; nothing in the repository was written except this file.

1. Fixture-mode tool calls through the real stdio server (abridged; each call printed its tool name and text). Observed lines:

```text
### get_charging_estimate isError=false
Usable-energy data not reported; showing the car's own estimate instead.
Assumptions: power estimated from 20 A × 230 V assumed × 3 phase(s); the car reports no charging voltage.

### plan_cheapest_charge isError=false
Pack capacity is unknown (the car did not report dischargeInfo.energyAvailable and no capacityKwh argument was given). Pass capacityKwh explicitly, e.g. 78 for a long range dual motor.

### get_degradation_report isError=false
Only 1 battery sample(s) recorded, need at least 5. History accrues while the server runs with history enabled.

### get_charging_sessions isError=false
No charging sessions in the recorded history.
```

2. `get_history` for three domains, same server run. Observed lines, showing the read clock and the five-field filter:

```text
### get_history telemetry/battery isError=false
2026-11-05T21:08:13.592Z {"batteryChargeLevelPercentage":52,"estimatedDistanceToEmptyKm":170}

### get_history charging/global-charge-timer isError=false
2026-11-05T21:08:13.596Z {}

### get_history charging/target-soc isError=false
2026-11-05T21:08:13.592Z {}
```

3. Record inspection of that history directory. Every record's `observedAt` was 2026-11-05T21:08:13Z while the payload `metaReceivedAt` values were 2026-09-10T10:16:55.687Z (charge timer) and 2026-09-18T11:10:55.531Z (battery). The gap is 48 to 56 days.

4. Planner probes, importing the built module. Observed lines:

```text
stopHour28 steps 2 first 2026-09-19T21:00:55.000Z last 2026-09-19T22:00:55.000Z
quarter-hour curve steps [{"startsAt":"2026-09-18T12:00:55.000Z","endsAt":"2026-09-18T13:00:55.000Z","price":0.1,"energyKwh":0.6571}]
energy 20.7 hoursNeeded 1.5 steps [{"price":0.1,"energyKwh":10.349},{"price":0.2,"energyKwh":10.349}] totalCost 3.105
true cost if charging starts at the block start: 2.760 planner: 3.105
```

A later probe with 20 percent SoC and 100 percent target at 4.6 kW printed 12 steps spanning two nights with the gap between `2026-09-18T03:00:00.000Z` and `2026-09-18T21:00:00.000Z`, `hoursNeeded` 11.43, and `reason` undefined.

5. Target-default probe with an injected client where `charging/target-soc` is null. Observed lines:

```text
### estimate with target-soc null
Energy to 80%: 32.0 kWh (now 40%).
Time at 11.0 kW: ~2h 54m.
Assumptions: power estimated from 16 A × 230 V assumed × 3 phase(s); the car reports no charging voltage; capacity 80.0 kWh derived from dischargeInfo.energyAvailable at 40%.

### plan with target-soc null
Missing required data (battery SoC, target SoC, or amp limit), cannot plan.
```

6. Dedupe and size probe. Observed lines:

```text
A,B,A -> records A,B,A
bytes per line [ 49, 49, 49 ]
fixture battery JSON bytes 786
```

7. Arithmetic probe (fixture values only). Observed lines:

```text
capacity from range*cons 34.17 kWh left; implied pack 65.71
range at 80% from cap/cons 261.5 km
time 3ph 1.33 h; 1ph 4.00 h
grid energy at 90% eff 20.44 kWh; extra 11.1 %
degradation gain at soc 6 16.67
global timer updatedAt 2026-08-16T18:39:14.000Z metaReceivedAt 2026-09-10T10:16:55.687Z
amp updatedAt 2026-08-18T12:41:14.000Z metaReceivedAt 2026-09-10T10:16:03.215Z
interval 60 calls/day/vehicle 5760; interval 600 calls/day/vehicle 576; interval 3600 calls/day/vehicle 96
60s 2 vehicles calls/day 11520 vs limit 10000
```

8. Writing hygiene, run after this file was written. The tree-wide command does not pass, and the failure is not in this file:

```text
node docs/check-docs.mjs hygiene
HYGIENE_NO_EM_DASH
HYGIENE_BUZZWORDS_CLEAN
BANNER_CHECK_FAILED:
  analysis/correctness/probe-budget-window.ts lines 12, 26
  analysis/correctness/probe-cache-clean.ts lines 17, 30, 48, 61
  analysis/correctness/probe-history.ts lines 19, 49, 65
  analysis/correctness/probe-status.ts lines 17, 55
  analysis/correctness/probe-subscriptions.ts lines 13, 41
  analysis/surface/probe-agent.ts lines 341
```

The banner rule applies only to `.ts` and `.js` files, and those probe files belong to other area agents and are outside this report's write scope. The three detectors that apply to markdown all pass on the whole tree including this file:

```text
node docs/check-docs.mjs emdash      -> HYGIENE_NO_EM_DASH
node docs/check-docs.mjs buzzwords   -> HYGIENE_BUZZWORDS_CLEAN
node docs/check-docs.mjs connectors  -> HYGIENE_NO_DASH_CONNECTORS
```
