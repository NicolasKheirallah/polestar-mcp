# A. MCP surface map and capability gaps

Scope: `src/domains.ts`, `src/domain-tools.ts`, `src/domain-data.ts`, `src/tools.ts`,
`src/tool-output.ts`, `src/format.ts`, the fixtures under `test/fixtures/dump/`, and the
surrounding registration in `src/server.ts` where the resource and prompt surface lives. All
measurements are fixture mode with no credential; no live API call was made. The tree is
`polestar-mcp` 0.3.0 at the state described in `analysis/00-brief.md`; `analysis/` is the only
untracked path.

Method: I spawned the real server over stdio (`node --import tsx src/server.ts`) with
`POLESTAR_FIXTURES_DIR=test/fixtures/dump`, spoke JSON-RPC to it, and computed field coverage
from the fixture JSON by walking every leaf under `data`. A leaf is a scalar under `data`;
`timestamp` counts as two leaves (`nanos`, `seconds`), and arrays are indexed. The "surfaced"
column means the non-raw text changes when that leaf changes, so it is readable without
`raw: true`.

## What exists

### 1. The Domain registry and the 15 Domain tools

`DOMAINS` holds one row per read Domain: kind, route segment, scope, description, `ttlMs`,
`sampled`, `pinnedKeys` (`src/domains.ts:50`, interface at `src/domains.ts:16-37`). Tool names
are derived by `get_` plus underscores (`src/domains.ts:362-364`), the route template is one
string (`src/domains.ts:346-348`), and the resource grammar reuses it
(`src/domains.ts:390-423`). The 15 rows are `src/domains.ts:51-340`.

Measured map (`node --import tsx --input-type=module -` harness, plus a Python leaf walk):

| Domain | Kind | Payload top-level keys | Leaf fields | Surfaced in text | Raw-only | Data-bearing raw-only |
| --- | --- | --- | --- | --- | --- | --- |
| availability | telemetry | 6 | 7 | 4 | 3 | 0 |
| battery | telemetry | 14 | 15 | 7 | 8 | 5 |
| exterior | telemetry | 18 | 19 | 15 | 4 | 1 |
| health | telemetry | 14 | 33 | 29 | 4 | 1 |
| location | telemetry | 8 | 10 | 6 | 4 | 1 |
| odometer | telemetry | 9 | 10 | 5 | 5 | 2 |
| parking-climatization | telemetry | 12 | 13 | 4 | 9 | 6 |
| pre-cleaning | telemetry | 12 | 15 | 5 | 10 | 3 |
| amp-limit | charging | 8 | 19 | 3 | 16 | 3 |
| charge-locations | charging | 5 | 5 | 2 | 3 | 1 |
| charge-now | charging | 5 | 7 | 2 | 5 | 0 |
| global-charge-timer | charging | 6 | 15 | 5 | 10 | 2 |
| parking-climate-timer | charging | 8 | 19 | 5 | 14 | 4 |
| target-soc | charging | 7 | 14 | 4 | 10 | 1 |
| is-at-charge-location | charging | 0 (fixture is `DATA_NOT_AVAILABLE`) | 0 | 0 | 0 | 0 |
| **Total** | | | **201** | **96 (47.8%)** | **105** | **30** |

Observed line from the field-coverage command: `TOTAL 201 96 105` and
`surfaced share: 47.8%`.

Of the 105 raw-only leaves, 71 are plumbing that no summary should print: `metaEventId`,
`metaReceivedAt`, `timestamp.nanos`, `id`, `updatedAt`, `updatedAtTimestamp`, `timerId`,
`metadata.*`, and the duplicated `vin`. Four more are event timestamps (`measurementDate`,
`startedAt` under pre-cleaning). Thirty carry a value a reader would want, and 11 of the 15
domain descriptions name at least one of them.

The full raw-only set that carries data, by domain (fixture line for the value):

| Domain | Raw-only data fields | Description that names the field |
| --- | --- | --- |
| battery | `chargerPowerStatus` (`test/fixtures/dump/dataportal/telemetry/battery.json:6`), `chargingType` (:9), `estimatedChargingTimeToFullMinutes` (:10), `estimatedDistanceToEmptyMiles` (:12), `chargingStatus` V1 when V2 is present (:7-8) | `src/domains.ts:72-73` names "charging status (V1/V2/type), charger connection and power status" and "km and miles" |
| exterior | `tailgateLock` (`.../telemetry/exterior.json:17`); `exteriorView` computes `locked` from it (`src/domain-data.ts:266`) but `summarizeDomain` prints only `centralLock` (`src/format.ts:175-180`) | `src/domains.ts:98` names "tailgate lock" |
| health | `engineHoursToService` (`.../telemetry/health.json:7`) | `src/domains.ts:126-127` names "engine-hours to service" |
| location | `altitude` (`.../telemetry/location.json:3`); `position()` never reads it (`src/domain-data.ts:142-156`) | `src/domains.ts:152` names "altitude" |
| odometer | `averageSpeedKmPerHour` (`.../telemetry/odometer.json:3`), `averageSpeedKmPerHourAutomatic` (:4) | `src/domains.ts:171` names "average speeds (km/h)" |
| parking-climatization | five `requested*` heating fields (`.../telemetry/parking-climatization.json:5-9`), `ventilation` (:16) | `src/domains.ts:190-191` names "requested seat and steering-wheel heating intensities, ventilation" |
| pre-cleaning | `lastCycleValid` (`.../telemetry/pre-cleaning.json:6`), `measuredAirQualityIndex` (:7), `runtimeLeftMinutes` (:16) | `src/domains.ts:212-214` names "measured PM2.5 / air quality index, last cycle validity" |
| amp-limit | `ampLimit.source` (`.../charging/amp-limit.json:6`), `pendingAmpLimit.ampLimit` and `pendingAmpLimit.source` (:23), plus the promised last update `updatedAt` (:19) | `src/domains.ts:236-237` names "with its source and last update"; `summarizeDomain` prints only the amp value (`src/format.ts:213`) |
| global-charge-timer | `start.timeZone.offsetMinutes` (`.../charging/global-charge-timer.json:20`), `stop.timeZone.offsetMinutes` (:26), and the whole `pendingGlobalChargeTimer` block (:33) | `src/domains.ts:281-282` names "with timezone offset" and pending changes; `chargeWindow` parses the offsets (`src/domain-data.ts:101-105`) but `src/format.ts:226-227` prints hours with no offset, and `pendingGlobalChargeTimer` is never read outside `pinnedKeys` (`src/domains.ts:290`) |
| parking-climate-timer | `repeat` (`.../charging/parking-climate-timer.json:24`), `readyAt.timeZone.offsetMinutes` (:21), plus `index` and `utc0` | `src/domains.ts:299` names "repeat flag"; `src/format.ts:232` prints hour, weekdays and activation only |
| target-soc | `targetSoc.source` (`.../charging/target-soc.json:23`), and the promised last update `targetSoc.updatedAt` (:15) | `src/domains.ts:317` names "last update"; `src/format.ts:221` prints level and setting type only |
| charge-locations | `utc0` (`.../charging/charge-locations.json:6`) | `src/domains.ts:256` mentions the `utc0` flag in prose, the summary prints "No saved charge locations reported" (`src/format.ts:238`) though the fixture is a settings record with `utc0: true` |
| availability, charge-now | none (their text covers what the fixture carries, or the data is only an id and change ids) | |

The other 19 light positions and 6 warning flags under health are surfaced in aggregate: they
are silent when `NO_WARNING` and named when set (`src/format.ts:183-191`, recursive walk at
`src/format.ts:256-290`).

For completeness, these are the 75 raw-only leaves that are plumbing or event metadata, so
that the 30 data-bearing fields above plus this list account for all 105 raw-only leaves:

| Domain | Raw-only plumbing and event metadata | Count |
| --- | --- | --- |
| availability | metaEventId, metaReceivedAt, timestamp.nanos | 3 |
| battery | metaEventId, metaReceivedAt, timestamp.nanos | 3 |
| exterior | metaEventId, metaReceivedAt, timestamp.nanos | 3 |
| health | metaEventId, metaReceivedAt, timestamp.nanos | 3 |
| location | metaEventId, metaReceivedAt, timestamp.nanos | 3 |
| odometer | metaEventId, metaReceivedAt, timestamp.nanos | 3 |
| parking-climatization | metaEventId, metaReceivedAt, timestamp.nanos | 3 |
| pre-cleaning | metaEventId, metaReceivedAt, timestamp.nanos, measurementDate.nanos, measurementDate.seconds, startedAt.nanos, startedAt.seconds | 7 |
| amp-limit | id, metaEventId, ampLimit.id, ampLimit.updatedAt, ampLimit.updatedAtTimestamp.nanos, ampLimit.updatedAtTimestamp.seconds, pendingAmpLimit.id, pendingAmpLimit.updatedAt, pendingAmpLimit.updatedAtTimestamp.nanos, pendingAmpLimit.updatedAtTimestamp.seconds, updatedAt, updatedAtTimestamp.nanos, updatedAtTimestamp.seconds | 13 |
| charge-locations | id, metaEventId | 2 |
| charge-now | id, metaEventId, syncedOverrideChargeTimer.updatedAt, syncedOverrideChargeTimer.updatedAtTimestamp.nanos, syncedOverrideChargeTimer.updatedAtTimestamp.seconds | 5 |
| global-charge-timer | id, metaEventId, globalChargeTimer.metadata.id, globalChargeTimer.metadata.source, globalChargeTimer.metadata.syncStatus.value, globalChargeTimer.metadata.updatedAt, globalChargeTimer.metadata.updatedAtTimestamp.nanos, globalChargeTimer.metadata.updatedAtTimestamp.seconds | 8 |
| parking-climate-timer | id, metaEventId, updatedAt, updatedAtTimestamp.nanos, updatedAtTimestamp.seconds, parkingClimateTimers[0].metadata.id, parkingClimateTimers[0].metadata.updatedAt, parkingClimateTimers[0].metadata.updatedAtTimestamp.nanos, parkingClimateTimers[0].metadata.updatedAtTimestamp.seconds, parkingClimateTimers[0].timerId | 10 |
| target-soc | id, metaEventId, metaReceivedAt, timestamp.nanos, updatedAt, targetSoc.id, targetSoc.timestamp.nanos, targetSoc.timestamp.seconds, targetSoc.updatedAt | 9 |
| is-at-charge-location | none (the fixture is an error, no payload) | 0 |

### 2. What the humanizer renders

`summarizeDomain` is one switch over the 15 names (`src/format.ts:139-245`). It renders:

- availability: status and usage mode (`src/format.ts:192-195`).
- battery: charge percent, range, charging status and connection, charge power when positive,
  time to full when positive, average consumption (`src/format.ts:141-159`).
- exterior: the open items collectively, central lock, alarm (`src/format.ts:173-181`).
- health: service days and distance, active warnings (`src/format.ts:183-191`).
- location: latitude, longitude, heading, speed, a Google Maps link (`src/format.ts:165-172`).
- odometer: odometer, manual and automatic trip meters (`src/format.ts:160-164`).
- parking-climatization: running status, runtime left (`src/format.ts:196-202`).
- pre-cleaning: PM2.5, running status, last cycle completed (`src/format.ts:203-209`).
- amp-limit: applied amps and a pending change when it differs (`src/format.ts:210-218`).
- target-soc: level and setting type (`src/format.ts:219-222`).
- global-charge-timer: activated flag and start/stop hour (`src/format.ts:223-228`).
- parking-climate-timer: ready hour, weekdays, activation (`src/format.ts:229-233`).
- charge-now: presence of the synced override (`src/format.ts:234-235`).
- charge-locations: a count of `chargeLocations`, which the fixture does not carry
  (`src/format.ts:236-239`).
- is-at-charge-location: the enum value (`src/format.ts:240-241`).

Shared pieces: enum prefix stripping and wording (`src/format.ts:24-59`), unit-aware distance
(`src/format.ts:70-93`), age (`src/format.ts:99-107`), VIN masking (`src/format.ts:121-123`).
The data age comes from the payload's own `timestamp.seconds` falling back to
`metaReceivedAt` (`src/domain-data.ts:120-132`), and the header prints it
(`src/vehicle-read.ts:239-242`).

Two type and unit defects visible in fixture data:

- `speed` and `altitude` are strings in the captured payload (`location.json:3`, `:11`), but
  `position()` reads them with `asNumber` (`src/domain-data.ts:150`), which rejects strings.
  Calling `summarizeDomain('location', {coordinate: {...}, speed: '55', altitude: '12'}, 'km')`
  returns `0 km/h`; the same call with numeric values returns `55 km/h`. The fixture's `"0"`
  hides this, but a moving car's string-encoded speed will print as zero.
- `global-charge-timer` hours are local to the timer's timezone; the offset is parsed
  (`src/domain-data.ts:101-105`) and then dropped from the line
  (`src/format.ts:226-227`). Measured: `["Charge window: 23:00 → 6:00 (active)"]` for a
  fixture whose offset is 120 minutes (`global-charge-timer.json:20`, `:26`).
- `plan_cheapest_charge` prints `Estimated cost: <number>` (`src/advisor-tools.ts:125`) while
  the `prices` argument describes `price` with no currency or unit
  (`src/advisor-tools.ts:12-14`). The cost is in whatever unit the caller supplied and the
  result never says so.

### 3. The tool surface as an LLM sees it

Measured over stdio with no history directory: 23 tools, `tools/list` result 44,841 bytes.
Description bytes total 5,164 (mean 224.5, largest `get_battery` at 615). Input schemas total
12,732 bytes, of which 9,705 is the identical 647-byte `{vin, raw, delegated_account_id}`
schema repeated on 15 Domain tools (`src/tool-output.ts:6-48`). Output schemas total 23,207
bytes: every tool carries the same 1,009-byte `resultShape` (51.8% of the whole list payload).

| Tool | Description bytes | Input bytes | Data on default path | Annotations |
| --- | --- | --- | --- | --- |
| list_vehicles | 75 | 33 | yes (`data.count`, `data.vehicles`, `data.note`) | readOnly, openWorld |
| list_domains | 262 | 33 | never | readOnly only |
| get_availability | 195 | 647 | raw only | readOnly, openWorld |
| get_battery | 615 | 647 | raw only | readOnly, openWorld |
| get_exterior | 192 | 647 | raw only | readOnly, openWorld |
| get_health | 253 | 647 | raw only | readOnly, openWorld |
| get_location | 168 | 647 | raw only | readOnly, openWorld |
| get_odometer | 164 | 647 | raw only | readOnly, openWorld |
| get_parking_climatization | 243 | 647 | raw only | readOnly, openWorld |
| get_pre_cleaning | 208 | 647 | raw only | readOnly, openWorld |
| get_amp_limit | 258 | 647 | raw only | readOnly, openWorld |
| get_charge_locations | 298 | 647 | raw only | readOnly, openWorld |
| get_charge_now | 230 | 647 | raw only | readOnly, openWorld |
| get_global_charge_timer | 316 | 647 | raw only | readOnly, openWorld |
| get_parking_climate_timer | 190 | 647 | raw only | readOnly, openWorld |
| get_target_soc | 164 | 647 | raw only | readOnly, openWorld |
| get_is_at_charge_location | 227 | 647 | never (fixture answers `DATA_NOT_AVAILABLE`) | readOnly, openWorld |
| get_car_status | 214 | 445 | never | readOnly, openWorld |
| is_car_secure | 129 | 445 | never | readOnly, openWorld |
| get_needs_attention | 143 | 445 | never | readOnly, openWorld |
| get_charging_estimate | 254 | 552 | never | readOnly, openWorld |
| plan_cheapest_charge | 179 | 1,041 (requires `prices`) | never | readOnly, openWorld |
| polestar_status | 187 | 33 | never | readOnly only |

Observed lines: `TOOLS totalResultBytes=44841 toolCount=23`,
`TOOLS_SUM descBytes=5164 inBytes=12732 outBytes=23207`.

Content notes:

- Every Domain description is the registry sentence plus the same mechanical suffix
  `(M2M endpoint: /v1/vehicles/{vin}/<kind>/<name>, scope <scope>).`
  (`src/domain-tools.ts:65`).
- `get_battery` carries capture provenance in a model-facing sentence: "The reference vehicle
  answered with 14 fields and none of the optional ones" (`src/domains.ts:73`). It is the
  largest description on the surface at 615 bytes and says nothing about which tool to call.
- `get_amp_limit` ends with "Measured live." (`src/domains.ts:237`), a note about how the
  contract was discovered, not about the tool.
- Titles are mechanical (`Get target-soc`, `Get is-at-charge-location`), four tools break the
  `get_` prefix (`list_vehicles`, `list_domains`, `is_car_secure`, `polestar_status`), and
  `polestar_status` is server status while `get_car_status` is car status
  (`src/system-tools.ts:30`, `src/aggregate-tools.ts:35`). The two names are one word apart
  and describe different subjects.

The input schema is honest but coarse: `vin` is optional with no enum, `raw` is a boolean,
`delegated_account_id` is a free string, and only `plan_cheapest_charge` has a required
argument (`prices`). Measured `required=[]` for the other 22 tools. `raw` is described as
"Return the full raw API payload instead of (or after) the humanized summary"
(`src/tool-output.ts:37-38`), but the implementation only ever appends it
(`src/vehicle-read.ts:247-250`), so "instead of" never happens.

The output envelope is `resultShape` (`src/tool-output.ts:70-81`): `ok`, `message`, `tool`,
`vin`, `data`, `ageSeconds`, `code`, `httpStatus`, `requestId`, `hint`; only `ok` and
`message` are required, and `data` is `z.unknown()` so its schema is `{"description": ...}`
with no type. `text()` always sets `structuredContent.message` to the same string as the
content block (`src/tool-output.ts:84-92`). `errorResult()` sets `isError: true` and the same
shape with `code`, `httpStatus`, `requestId`, `hint` (`src/tool-output.ts:158-179`), but drops
the upstream `details` and `timestamp` that `PolestarApiError` carries
(`src/client.ts:13-20`, dropped at `src/failure.ts:78-84`), even though
`docs/upstream-api.md:87` says `timestamp` and `requestId` are the fields support needs.

Measured result sizes from the 15 Domain calls with `raw: false`: text 1,973 bytes total,
structuredContent 3,436 bytes total (1.74x), with `message` duplicating the text exactly in
every call. With `raw: true`: text 11,910 bytes, structuredContent 22,836 bytes, total 34,746
bytes for 8,241 bytes of payload data, a factor of 4.2. The raw payload appears in the text
block, again inside `message`, and again in `data`; for `get_health` the result is 6,154 bytes
for a 1,752-byte payload. This duplication is deliberate for the no-raw case
(`src/tool-output.ts:67-69`) and for `raw: true` it is the main reason the envelope is large
(`src/vehicle-read.ts:247-256`).

`ageSeconds` is present on 14 of 15 Domain reads (not on `get_is_at_charge_location`, whose
fixture reports no data) and on none of the 4 aggregates, `plan_cheapest_charge`,
`polestar_status`, or the history tools. `data` is present on 1 of 23 tools by default
(`list_vehicles`), on 14 of 15 Domain tools only with `raw: true` (the fifteenth,
`get_is_at_charge_location`, has no payload on the fixture car), and never on the 7
non-Domain tools other than `list_vehicles`; the 3 history tools join that set when enabled.
Measured `structuredKeys` lines show `["ok","message"]` for `get_car_status`, `is_car_secure`,
`get_needs_attention`, `get_charging_estimate`, `plan_cheapest_charge` and `polestar_status`.

The server instructions are 882 bytes (`src/server.ts:207-214`), name the four aggregates and
the 15-domain read set, and say how to read age and errors. They do not mention the three
history tools when they are enabled, the resources or prompts, the unit setting, or the VIN
redaction and location flags. Measured: `INIT instructionsBytes=882`, and with
`POLESTAR_HISTORY_DIR` set, `HISTORY toolCount=26 instructionsMentionsHistory=false`.

### 4. Resources, prompts, completions, subscriptions

- Two resource templates, one per kind:
  `polestar://vehicle/{vin}/{telemetry|charging}/{domain}`
  (`src/server.ts:275-305`). Measured: 2 templates, 15 resources, `resources/list` result
  2,800 bytes, all `text/plain`.
- The resource read runs the same `readDomain` as the tool, so text is identical
  (`src/server.ts:306-319`, measured 277 bytes for battery).
- `resources/list` builds the list from the vehicle list and silently caps it at 10 VINs:
  `vins.slice(0, 10)` (`src/server.ts:283`) with no cursor. Measured with a 12-VIN fixture
  copy: 150 resources, 10 distinct VINs, `nextCursor=undefined`.
- If the vehicle list fails, the catch returns `{ resources: [] }`
  (`src/server.ts:292-294`). Measured with a fixture copy whose `vehicles.json` was removed:
  `resources/list result={"resources":[]} error=undefined`. A client cannot tell "no cars"
  from "could not list cars".
- Resource names and descriptions always show the last four VIN characters
  (`src/server.ts:286-287`); the URI always carries the full VIN.
- Completions are registered only for the resource template's `vin` and `domain`
  (`src/server.ts:296-303`). Measured `completion/complete` for the resource ref returns the
  VIN and `battery`; `ref/prompt` for `car-status` returns
  `{"completion":{"values":[],"hasMore":false}}`.
- Three prompts (`src/server.ts:338-410`). All prompt arguments are optional with no
  descriptions: measured `arguments:[{"name":"vin","required":false}]` for `car-status`.
  `battery-health-report` tells the model to call `get_degradation_report` and
  `get_charging_sessions` (`src/server.ts:403`) while those tools are registered only when a
  history store exists (`src/server.ts:201`). Measured without a history directory:
  `PROMPT battery-health-report ... UNREGISTERED=["get_degradation_report","get_charging_sessions"]`.
  The repo's tool-reference check does not catch it because `scripts/list-tools.ts:30-36`
  always builds the history family; `npm run check-tool-refs` prints
  `TOOL_REFS_OK 26 registered names, 27 instruction-surface files scanned, 0 undefined names
  referenced`.
- Subscriptions exist on stdio only, poll once a minute (`src/subscriptions.ts:36`), notify
  when `metaEventId` changes (`src/subscriptions.ts:96-108`), and pause at 90% of the daily
  budget (`src/subscriptions.ts:93`). HTTP mode advertises no subscribe capability
  (`src/server.ts:215`, `:433`).

### 5. Upstream contract coverage

The routes are fully covered: `GET /v1/vehicles`, the 8 telemetry domains and the 7 charging
domains (`docs/upstream-api.md:89-96`) map one to one to `VEHICLES_PATH` and the 15 rows
(`src/domains.ts:343`, `:51-340`). The envelope's `meta.domain` and `meta.vin` are consumed
for identity assertions (`src/client.ts:210` and following) but never surfaced; that is a
reasonable omission because the tool already prints VIN and domain.

Documented data the surface does not read or expose:

- `docs/upstream-api.md:121` lists optional contract fields a given car may not report:
  battery charging current and voltage, charging power, since-charge and automatic-trip
  consumption averages, an energy-consumption breakdown, odometer trip-since-charge, tyre
  pressure values, cabin temperature, a sunroof, and an availability reason.
  `batteryView` reads current and voltage (`src/domain-data.ts:200-223`) but the summary prints
  them only inside the positive-power branch (`src/format.ts:147-151`), so a car that reports
  volts and amps but not watts loses both. Tyre pressure, cabin temperature, the consumption
  breakdown, trip-since-charge and the unavailability reason have no reader at all
  (`src/domain-data.ts` has no accessor for any of them). A sunroof open status would be
  surfaced by the generic `openFields` walk (`src/domain-data.ts:231-238`), but nothing pins
  or tests it.
- `metaEventId` is in every payload and is the change signal subscriptions and history use
  (`src/subscriptions.ts:96-108`, `src/history.ts:18`), but no tool result exposes it, so a
  tool caller cannot ask "did anything change since I last looked".
- Upstream error `details` and `timestamp` are preserved on `PolestarApiError`
  (`src/client.ts:13-20`) and dropped by `toFailure` (`src/failure.ts:78-84`) and
  `errorResult` (`src/tool-output.ts:170-173`).

### 6. MCP surface features present but unused or generic

| Feature | State | Evidence |
| --- | --- | --- |
| `outputSchema` | Present on all 23 tools, but one generic 1,009-byte schema; `data` is untyped; 51.8% of `tools/list` bytes | `src/tools.ts:49`, `src/tool-output.ts:75`, measured 23,207 of 44,841 bytes |
| `structuredContent` | Present, but no `data` on the default path for 22 of 23 tools; data only on `list_vehicles` or with `raw: true` | measured `structuredKeys` |
| Resource templates | Used for Domain reads only; no status or aggregate resource; `text/plain` only | `src/server.ts:275-305` |
| Resource subscriptions | Used on stdio; one Domain per subscription | `src/subscriptions.ts` |
| Prompts | 3, one referencing tools that may not exist; no argument completions or descriptions | `src/server.ts:338-410`, measured |
| Completion | Used for resource `vin` and `domain` only, not prompt arguments | `src/server.ts:296-303`, measured |
| Elicitation | Used only for an ambiguous VIN | `src/vehicle-read.ts:71-113` |
| Logging capability | Advertised as `logging: {}` but no logging notification is ever sent | `src/server.ts:215`; no `sendLoggingMessage` in `src/` |
| `listChanged` capabilities | Advertised true for tools, prompts and resources, but the surface is static per server instance and sends no list-changed notification | `src/server.ts:215` |
| Sampling, roots | Not used; not a fit for a read-only data server | no registration in `src/server.ts` |

## What is missing

Ordered by how much a user or agent would notice.

1. **Machine-readable data is absent from almost every result.** On the default path 1 of 23
   tools returns a `data` object, and even that one has no schema for it. A client that wants
   `chargePercent = 52` must parse "Charge: 52%" out of prose. The envelope comment says
   `data` is "documented per tool" (`src/tool-output.ts:75`), but no per-tool shape exists
   anywhere. Evidence: measured `structuredKeys`; `docs/tools-reference.md:23-24` only
   promises text content.
2. **Freshness collapses to one number in the aggregates and disappears in the advisor.** The
   API promises only "last known" values (`docs/upstream-api.md:16`), and the capture shows
   charging settings 24.7 days stale while telemetry was seconds old. A Domain read carries
   its own age (`src/vehicle-read.ts:239-242`), but `get_car_status` prints one
   "newest domain" age (`src/aggregate-tools.ts:81-87`) whose description claims "data age
   for each" (`src/aggregate-tools.ts:38`). Measured with health backdated 400 days:
   `STALE get_car_status.text=... Data as of 48 d ago (newest domain).` The planner reads a
   56-day-old charge timer (`fixture global-charge-timer.json`) and never states its age
   (`src/advisor-tools.ts:63`, `:110-128`). No aggregate result carries `ageSeconds`
   (measured).
3. **Descriptions promise fields the text does not print.** 11 of 15 Domain descriptions name
   at least one field the humanizer drops (section 2 table). A model reading the description
   will ask for `get_amp_limit` expecting the source and last update and receive `20 A`; it
   will ask for `get_odometer` expecting average speeds and receive two trip meters; it will
   ask for `get_global_charge_timer` expecting a timezone offset and receive bare hours.
   `docs/tools-reference.md:54-67` repeats the same promises to users.
4. **The prompt surface contradicts the running server.** `battery-health-report` is
   registered on every start (`src/server.ts:388-409`) and instructs two calls that exist only
   with a history store (`src/server.ts:201`). Measured default mode: both names unregistered.
   The guard that should catch this (`npm run check-tool-refs`) passes because it checks the
   union of 26 tools, not the surface in front of the user (`scripts/list-tools.ts:30-36`).
5. **VIN redaction is incomplete on the resource and completion surfaces.** With
   `POLESTAR_REDACT_VIN=true`, tools print `YSM…001` (measured), but `resources/list` returns
   URIs with the full VIN, resource names and descriptions with the last four, and
   `completion/complete` returns full VINs. Measured:
   `REDACT resources[0]={"uri":"polestar://vehicle/YSMTEST22PL000001/telemetry/availability",...}`
   and `REDACT completionVin={"values":["YSMTEST22PL000001"],...}`. The tool output comment
   says redaction is a rule for the whole result (`src/vehicle-read.ts:275-283`); the resource
   surface was not included.
6. **The resource surface does not cover the questions the tool surface covers, and it fails
   silently.** Only Domain reads are resources; the four aggregates, `polestar_status` and
   `list_domains` have no resource form. The list is truncated at 10 VINs with no cursor
   (measured 150 resources for 12 VINs), and a failed vehicle list looks like zero resources
   (measured `{"resources":[]}`).
7. **There is no way to learn which Domains a car reports before spending calls.** `list_domains`
   lists the server registry (`src/domain-tools.ts:48-60`); the car's support is only
   discoverable one failed `DATA_NOT_AVAILABLE` at a time (`docs/tools-reference.md:67`,
   `docs/upstream-api.md:65-68`). This is the onboarding question "which of these can my car
   answer?" and it costs 15 reads to answer today.
8. **The tool list is heavy for the context it buys.** 44,841 bytes (about 11,200 tokens at
   four bytes per token) before the first question, half of it the same output schema repeated
   23 times, plus 615 bytes of capture provenance in one description. Every live session pays
   this on the first `tools/list`.
9. **Units and provenance are lost in places.** The charge window prints hours without its
   timezone offset (measured), `plan_cheapest_charge` prints `Estimated cost: <number>`
   (`src/advisor-tools.ts:125`) while the `prices` argument names no currency or unit
   (`src/advisor-tools.ts:12-14`), and `get_location` renders a string-encoded speed as zero
   (measured). On the fixture run with supplied prices the cost line did not appear because no
   price matched the charge window slots, which is itself a case the result reports only as
   "price unknown".
10. **Upstream error detail is dropped.** `requestId` survives; `timestamp` and the `details`
    object do not (`src/failure.ts:52-60`, `src/tool-output.ts:170-173`), although
    `docs/upstream-api.md:82-87` documents both.
11. **Prompt arguments have no completions and no descriptions.** Measured prompt arguments
    are just names; `completion/complete` with `ref/prompt` returns nothing even though the
    server knows the VIN list. Elicitation is used for VIN ambiguity but not for the two
    planner inputs the advisor ends up asking for in prose (`src/advisor-tools.ts:82-96`).

## Candidates

Eight candidates. Each answers a user question, names the data it reads, and has a check that
fails today.

| id | name | user question it answers | data it reads | effort | risk | falsifiable check |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Structured results with per-tool output schemas | "Can my client use this answer without parsing English?" | Every Domain payload already fetched; `resultShape`; per-tool promise lists | M | Medium | For each Domain fixture, a `raw: false` call must return `structuredContent.data` with every value-bearing pinned key, validated against a per-tool `outputSchema`; `raw: true` must stay under 1.5x its text bytes |
| A2 | Summary and unit coverage against the descriptions | "Why does the tool description mention fields the answer never shows?" | The 30 data-bearing raw-only fields; `chargeWindow.offsetMinutes`; price units; string-encoded numbers | S | Low | A contract test maps each description promise to a rendered value, for example `amp-limit` text contains `RCS` and the update time, `global-charge-timer` contains `+02:00`, `location` with `speed: "55"` prints `55 km/h`; currently fails on 11 domains |
| A3 | Per-Domain freshness in aggregates and the advisor | "Is the charge window the planner used three weeks old?" | `timestamp` and `metaReceivedAt` from every constituent Domain; `updatedAt` from settings payloads | M | Low | A fixture with health 400 days old and battery fresh must make `get_car_status` name the stale Domain, and `structuredContent` must carry per-Domain `ageSeconds`; the planner must state its window age; both fail today |
| A4 | Prompt surface that matches the running server | "Why did my assistant call a tool that does not exist?" | The tool registry actually registered for this server instance; prompt bodies; prompt argument schemas | S | Low | Spawn without a history directory and assert every tool-shaped name in every `prompts/get` response is in `tools/list`; `completion/complete` with `ref/prompt` for `car-status.vin` returns the VIN list; both fail today |
| A5 | Redaction-consistent resource identity | "What does POLESTAR_REDACT_VIN actually protect?" | VIN list, resource URIs, completion values | S | Medium | With `POLESTAR_REDACT_VIN=true`, no JSON-RPC result outside `raw: true` may contain the 17-character VIN; today `resources/list` and `completion/complete` do |
| A6 | Resource surface for aggregated questions with honest listing | "Can my client read the status briefing as a resource, and can I trust the list?" | The 15 Domain reads and the aggregate text; the vehicle list | M | Medium | `resources/templates/list` must include an aggregate or status template whose read equals the tool text; a 12-VIN fixture must page or report truncation; a failed vehicle list must return an error, not `{"resources":[]}`; all three fail today |
| A7 | Elicitation for planning inputs | "Can the assistant ask me for the pack capacity instead of giving up?" | Charge model inputs; charge window; elicitation channel | M | Medium | With an elicitation-capable client, `plan_cheapest_charge` on the fixture must ask for `capacityKwh` and finish; a client without elicitation must get today's text unchanged; today it returns text only |
| A8 | Domain availability matrix | "Which of these questions can my car answer before I spend calls?" | One read of each of the 15 Domains; cache and budget meters | M | Medium | With three Domain fixtures removed, the tool must report 12 reported and 3 absent without erroring, and must touch exactly 15 distinct cache keys; no such tool exists today |

### A1. Structured results with per-tool output schemas

The envelope is the right place because it is already declared as the contract
(`src/tool-output.ts:62-81`) and validated by the SDK. The change is to stop treating
`data` as an afterthought: every Domain tool builds a small normalized object (values already
read by `domain-data.ts`, plus units from `deps.units`) and forwards it on the no-raw path;
the four aggregates, the planner and `polestar_status` do the same for their own result
shapes. `raw: true` should stop echoing the payload in the text block and in `message`; it
should put it in `data` once. Per-tool `outputSchema` values replace the identical 1,009-byte
schema, with the shared envelope factored into `$defs` so `tools/list` does not grow without
bound. The design comment at `src/vehicle-read.ts:273-274` objects that the whole payload in
the envelope would re-add tokens; the answer is a compact normalized object, not the payload,
and the measurement above shows the current raw path already spends 4.2 bytes per payload
byte. The user question is the one a client developer asks first, and the check is a contract
test over the existing fixtures plus a byte-budget assertion.

### A2. Summary and unit coverage against the descriptions

Either render what the description promises or stop promising it. The fixture data already
contains every value needed for the test, so this is cheap: add the missing lines and readers
to `summarizeDomain` and `domain-data.ts`, coerce string-encoded numerics for known numeric
fields (`speed`, `altitude`, and the `updatedAt` strings), print the charge window offset,
and print the price unit in the planner or state that the cost is in the caller's price unit.
The counter-signal is real: most raw-only fields are plumbing, and only 30 carry data, so
this candidate is deliberately scoped to the values the descriptions already advertise. The
check is the promise map in the table.

### A3. Per-Domain freshness in aggregates and the advisor

A Domain read already computes an age (`src/vehicle-read.ts:239-242`); `readDomains` throws the
per-Domain timing away. The change is to return the observed time with each payload, print a
per-Domain age in `get_car_status` and the planner, and put `ageSeconds` plus an `oldest`
marker in the structured envelope. This is the highest-value candidate that needs no new data
source: the API's own "last known" rule and the capture's 24.7-day settings staleness
(`docs/upstream-api.md:16`) make freshness a correctness property, not a nicety. The measured
400-day probe shows the current text actively hides the stale Domain.

### A4. Prompt surface that matches the running server

Gate `battery-health-report` on the history store, or rewrite it to say that history tools
need `POLESTAR_HISTORY_DIR`; extend `check-tool-refs` to build the same 23-or-26 surface the
server will expose, or add a runtime check over `prompts/get`; add argument descriptions and
completions for `vin` and for the prompt arguments. This is small and it removes a failure
that a user cannot debug from the outside: the model calls a tool the client never listed.

### A5. Redaction-consistent resource identity

The resource URI is the identity a client subscribes with, so masking it needs a stable
alternative: either an opaque vehicle key mapped server-side, or a documented rule that
resource URIs are the exception and a note in the tool description. The cheapest correct
version is to stop returning full VINs from `resources/list` and `completion/complete` when
redaction is on, and to use the same mask in names and descriptions. The check is a scan of
every result for the 17-character pattern with redaction enabled.

### A6. Resource surface for aggregated questions with honest listing

Add one template for the status briefing (and optionally the other aggregates), whose read
calls the same spec body as the tool so the two surfaces cannot disagree. Do not advertise
subscriptions for those templates: one subscription already spends 1,440 calls per day at the
60-second poll (`src/subscriptions.ts:36`), and a five-Domain status subscription would spend
7,200, so a resource that mixes five Domains must be read on demand or polled at a much longer
interval. Fix the two honesty defects at the same time: page the list or report the cap, and
return an error when the vehicle list fails instead of an empty set.

### A7. Elicitation for planning inputs

`plan_cheapest_charge` already knows the exact sentence it wants to say when capacity or a
window is missing (`src/advisor-tools.ts:82-96`). Turn those sentences into a question when the
client can answer: ask for `capacityKwh` (and optionally `phases`) and continue on the retry,
with the existing text as the fallback. The VIN path in `src/vehicle-read.ts:71-113` is the
working pattern, including the "ask, validate the answer, fall back" sequence. The check is a
two-client test: elicitation-capable and not.

### A8. Domain availability matrix

A new read-only tool, for example `list_vehicle_domains`, reads the 15 Domains through the
cache and classifies each as reported, absent (`DATA_NOT_AVAILABLE`), or failed, with the
error code. It answers the onboarding question and prevents a model from retrying an
unsupported Domain. It is also the only candidate that adds a new capability rather than
repairing one. The cost is 15 cache misses on a cold call (0.15% of the daily budget) and the
answer can change when the car changes, so the tool should state its observation time and let
the cache TTLs do their work. The check is a fixture with three Domains removed, plus a cache
key count of exactly 15.

## Rejected ideas

- **Write tools.** The documented v1 API has no write endpoints (`docs/upstream-api.md:98-100`);
  `POLESTAR_ENABLE_WRITES` deliberately registers nothing (`src/server.ts:220-224`) and
  `test/posture.test.ts` holds the read-only posture. A write surface waits for Polestar.
- **Consumer-app data such as model year, registration and images.** `list_vehicles` says the
  M2M contract returns VINs only (`src/domain-tools.ts:40`), and the app API boundary is
  protected by `test/posture.test.ts`. Out of scope for this server.
- **A general history or trend command without `POLESTAR_HISTORY_DIR`.** The upstream API
  returns latest values only (`docs/upstream-api.md:15`); the three history tools already
  cover this when the store exists (`src/history-tools.ts`). A second path would duplicate
  them.
- **Renaming tools to fix the naming quirks.** `get_charge_now` versus `get_charging_*`,
  `is_car_secure` versus `get_*`, and `polestar_status` versus `get_car_status` are genuinely
  confusing, but the mechanical naming rule is documented (`docs/tools-reference.md:9`), a
  rename breaks every client, and aliases would add more tools to the 44 KB list. Fix the
  titles and the descriptions instead.
- **Proactive subscriptions to all 15 Domains.** One subscription costs 1,440 calls per day at
  the 60-second poll; the daily allowance is 10,000 (`docs/upstream-api.md:14`). Six
  subscriptions reach 86% of the allowance before any question is asked, and the poller pauses
  at 90% (`src/subscriptions.ts:93`). The current on-demand design is the right one.
- **A raw JSON resource per Domain.** `raw: true` is already one argument away on the tool,
  the resource surface is `text/plain` (`src/server.ts:319`), and a raw resource would expose
  the full VIN through a path that does not carry the redaction warning.
- **Dropping `outputSchema` altogether to shrink the tool list.** `scripts/smoke.ts:62-69`
  requires an output schema on every tool and the shape must keep `ok` and `message`;
  `CONTRIBUTING.md:54` states the same expectation. Shrink it by sharing the envelope, not by
  removing it.
- **A generic batch Domain read tool.** The four aggregates already cover the question sets the
  docs advertise (`docs/tools-reference.md:84-89`); a 24th tool that takes an arbitrary Domain
  list adds a selection decision to every call and duplicates the summaries. The availability
  matrix (A8) covers the one question the aggregates do not.
- **Embedding a spot-price lookup in `plan_cheapest_charge`.** The tool is read-only and
  network-free by design; prices arrive as an argument so no external service is contacted
  (`src/advisor-tools.ts:30-36`). That property should stay.
- **Sampling or roots support.** Neither maps to a read-only vehicle data server: there is no
  server-initiated model turn to make and no filesystem root to negotiate.

## Commands run

All probes used fixture mode only; no live API call was made. The stdio harnesses were
piped into `node --import tsx --input-type=module -` from the repository root and printed the
lines quoted below. The Python probe read the fixture JSON and printed the coverage table.

1. `node --import tsx --input-type=module -` (spawn `src/server.ts` with
   `POLESTAR_FIXTURES_DIR=test/fixtures/dump`; `initialize`, `tools/list`, every tool call,
   resources, prompts, completions). Observed:
   - `INIT instructionsBytes=882 resultBytes=1144`
   - `TOOLS totalResultBytes=44841 toolCount=23`
   - `TOOLS_SUM descBytes=5164 inBytes=12732 outBytes=23207`
   - `PROMPT battery-health-report ... UNREGISTERED=["get_degradation_report","get_charging_sessions"]`
   - `RESOURCES count=15 bytes=2800 nextCursor=undefined`
   - `COMPLETION {"completion":{"values":["YSMTEST22PL000001"],...}}`
2. Python leaf walk over `test/fixtures/dump/dataportal/*/*.json` against the rendered sets
   read from `src/format.ts`. Observed: per-domain rows and `TOTAL 201 96 105`,
   `surfaced share: 47.8%`.
3. `node --import tsx --input-type=module -` with `POLESTAR_REDACT_VIN=true`. Observed:
   `REDACT list_vehicles.text="Authorized vehicles (1):\n , YSM…001..."`,
   `REDACT resources[0]={"uri":"polestar://vehicle/YSMTEST22PL000001/telemetry/availability",...}`,
   `REDACT completionVin={"completion":{"values":["YSMTEST22PL000001"],...}}`,
   `REDACT get_battery.vin="YSM…001" textHasFullVin=false`.
4. Same harness with `POLESTAR_HISTORY_DIR` set. Observed:
   `HISTORY toolCount=26 instructionsMentionsHistory=false`,
   `HISTORY promptRefs=["get_degradation_report","get_charging_sessions"] unregistered=[]`.
5. Same harness with a `/tmp` fixture copy whose `dataportal/vehicles.json` was removed.
   Observed: `NOVEH resources/list result={"resources":[]} error=undefined`,
   `NOVEH completion={"completion":{"values":[],...}}`.
6. Same harness with a `/tmp` fixture copy listing 12 VINs. Observed:
   `FLEET vehicles=12 resourcesCount=150 distinctVins=10 nextCursor=undefined`.
7. Same harness with a `/tmp` fixture copy whose health `metaReceivedAt` was set to
   `2025-01-01T00:00:00.000Z`. Observed:
   `STALE get_car_status.text="... Data as of 48 d ago (newest domain)."` and
   `STALE keys=["ok","message"]`; `STALE plan_cheapest_charge.text` contains no age and
   `STALE plan.keys=["ok","message"]`.
8. `node --import tsx --input-type=module -e` calling `summarizeDomain` directly. Observed:
   `["Position: 47.60620, -122.33210 (heading 121°, 0 km/h)","Map: ..."]` for a string
   `speed: "55"` and `["Position: ..., 55 km/h","Map: ..."]` for a numeric one;
   `["Charge window: 23:00 → 6:00 (active)"]` for a timer with `offsetMinutes: 120`.
9. `npm run check-tool-refs`. Observed:
   `TOOL_REFS_OK 26 registered names, 27 instruction-surface files scanned, 0 undefined names
   referenced`.
10. `node docs/check-docs.mjs hygiene`. Result recorded in the next section.

## Hygiene

`node docs/check-docs.mjs hygiene` was run after this file was written. It did not reach
`HYGIENE_CLEAN`. It printed `HYGIENE_NO_EM_DASH` and `HYGIENE_BUZZWORDS_CLEAN`, then failed on
the banner detector:

```text
BANNER_CHECK_FAILED:
  analysis/correctness/probe-budget-window.ts lines 12, 26
  analysis/correctness/probe-cache-clean.ts lines 17, 30, 48, 61
  analysis/correctness/probe-history.ts lines 19, 49, 65
  analysis/correctness/probe-status.ts lines 17, 55
  analysis/correctness/probe-subscriptions.ts lines 13, 41
```

Those are the paths and line numbers observed at the time of the final run; the probe scripts
were being edited by their owners during the exercise, so the list and line numbers can move.
No failing path is this file. The checks that govern Markdown prose were also run on their own
and pass: `node docs/check-docs.mjs emdash` prints `HYGIENE_NO_EM_DASH`,
`node docs/check-docs.mjs buzzwords` prints `HYGIENE_BUZZWORDS_CLEAN`, and
`node docs/check-docs.mjs connectors` prints `HYGIENE_NO_DASH_CONNECTORS`. The banner rule
applies only to `.ts`, `.js`, `.mjs`, `.cjs` and `.py` files, so it does not scan this report;
it is failing on probe scripts under `analysis/correctness/` that are outside this task's
write scope. The tree-wide check cannot pass until their owner removes those decorative
comment banners.
