# Tool reference

Who this is for: everyone. Users can skim the tables to see what questions their assistant can answer. Developers will find the exact endpoint, OAuth scope, and output shape behind each tool.

There are 23 tools registered on every start, and 26 with history enabled (three history tools join when the server runs with a history directory). All of them are reads: every tool carries the MCP `readOnlyHint` annotation, so clients can auto-approve calls without prompting you. There is no tool that changes anything on the car, because the documented v1 API publishes no write endpoints (see [upstream-api.md](upstream-api.md)).

## How tools map to the API

Each `get_*` tool wraps exactly one GET endpoint of the Polestar Data Portal M2M API. The naming rule is mechanical: for an API domain named `target-soc`, the tool is `get_target_soc`. The tool's description (what your assistant reads when deciding which tool to call) includes the endpoint path and the OAuth scope, so the mapping stays visible to the AI client too.

The 15 domain tools (one for each of the 15 read domains of the v1 API) are table-driven: one `DOMAINS` entry per read domain, from which the tool name, registration, scope collection, and resource URIs all derive. The aggregate, advisor, system, and history tools are hand-registered in their own modules and read the same data through the client (so they share the cache and the daily budget).

Two arguments are shared by most tools:

| Argument | Type | Meaning |
| --- | --- | --- |
| `vin` | string, optional | The Vehicle Identification Number, case-insensitive. Omit it on a credential with exactly one car and that car is used; with several cars the tool asks you to pick (from `list_vehicles`) |
| `raw` | boolean, optional | Domain tools only: append the untouched API payload after the humanized summary |

All tools return text content. Domain reads answer with a short humanized summary plus a data age ("data observed 5 min ago"); the raw JSON is one `raw: true` away.

## The domain tools (15 + list_vehicles + list_domains)

| Tool | Endpoint (after the base URL) | OAuth scope |
| --- | --- | --- |
| `list_vehicles` | `GET /v1/vehicles` | (none, the token call carries all scopes) |
| `list_domains` | (reads the server's own registry) | (none) |
| `get_availability` | `GET /v1/vehicles/{vin}/telemetry/availability` | `pdp-telemetry/availability` |
| `get_battery` | `GET /v1/vehicles/{vin}/telemetry/battery` | `pdp-telemetry/battery` |
| `get_exterior` | `GET /v1/vehicles/{vin}/telemetry/exterior` | `pdp-telemetry/exterior` |
| `get_health` | `GET /v1/vehicles/{vin}/telemetry/health` | `pdp-telemetry/health` |
| `get_location` | `GET /v1/vehicles/{vin}/telemetry/location` | `pdp-telemetry/location` |
| `get_odometer` | `GET /v1/vehicles/{vin}/telemetry/odometer` | `pdp-telemetry/odometer` |
| `get_parking_climatization` | `GET /v1/vehicles/{vin}/telemetry/parking-climatization` | `pdp-telemetry/parkingClimatization` |
| `get_pre_cleaning` | `GET /v1/vehicles/{vin}/telemetry/pre-cleaning` | `pdp-telemetry/preCleaning` |
| `get_amp_limit` | `GET /v1/vehicles/{vin}/charging/amp-limit` | `pdp-charging/ampLimit` |
| `get_charge_locations` | `GET /v1/vehicles/{vin}/charging/charge-locations` | `pdp-charging/chargeLocations` |
| `get_charge_now` | `GET /v1/vehicles/{vin}/charging/charge-now` | `pdp-charging/overrideChargeTimer` |
| `get_global_charge_timer` | `GET /v1/vehicles/{vin}/charging/global-charge-timer` | `pdp-charging/globalChargeTimer` |
| `get_parking_climate_timer` | `GET /v1/vehicles/{vin}/charging/parking-climate-timer` | `pdp-charging/parkingClimateTimer` |
| `get_target_soc` | `GET /v1/vehicles/{vin}/charging/target-soc` | `pdp-charging/targetSoc` |
| `get_is_at_charge_location` | `GET /v1/vehicles/{vin}/charging/is-at-charge-location` | `pdp-charging/isAtChargeLocation` |

`list_domains` needs no vehicle and no network call: it prints the server's own registry, every domain with its endpoint, OAuth scope, and tool name. Its description tells the assistant to answer domain questions from here rather than guessing a name, because a mistyped domain is a 404 `VALIDATION_RESOURCE_NOT_FOUND` from the API, which is a different thing from a vehicle reporting no data.

One naming quirk to be aware of: `get_charge_now` reads the charge-now override state, and its scope is `pdp-charging/overrideChargeTimer`, not a scope named after charge-now. That is how Polestar scopes it, and the server keeps the API's vocabulary rather than inventing its own.

What each domain contains:

- `get_availability`: whether the car is currently reachable, the availability status and usage mode. A sleeping car may be listed but not awake.
- `get_battery`: the richest domain. Charge level in percent, charging status, charger connection and power status, charging volts, amps and watts, estimated distance to empty, estimated time to full, average consumption, and the usable energy (`dischargeInfo.energyAvailable`) that feeds the charging estimate and planner.
- `get_exterior`: doors, windows, hood, tailgate and tank lid open or closed, central lock, tailgate lock, and alarm state.
- `get_health`: service countdown in days, distance, and engine hours, the service warning flag, and fluid and light warnings: brake fluid, coolant, oil, washer fluid, and 19 exterior light positions.
- `get_location`: last known latitude, longitude, altitude, heading, and speed, with a timestamp.
- `get_odometer`: odometer in meters, trip meters (manual and automatic) in km, and average speeds in km/h.
- `get_parking_climatization`: whether parking climate (preheat or pre-cool) is running, runtime left, and the requested seat and steering-wheel heating intensities and ventilation.
- `get_pre_cleaning`: cabin air pre-cleaning status, measured PM2.5 and air quality index, and the validity and completion time of the last cycle.
- `get_amp_limit`: the configured maximum AC charging current in amps, its source, and when it was last updated.
- `get_charge_locations`: the charge locations saved for the vehicle.
- `get_charge_now`: the charge-now override state, that is, the override charge timer sync status.
- `get_global_charge_timer`: the recurring charge window: start and stop hour with timezone offset, activation flag, pending changes, and sync status.
- `get_parking_climate_timer`: scheduled parking-climate timers: ready-at hour, weekdays, repeat flag, and activation.
- `get_target_soc`: the target battery state of charge in percent, the setting type (for example `CUSTOM` or `PRESET`), and the last update time.
- `get_is_at_charge_location`: whether the car is currently at a saved charge location. This is the domain most often unsupported by a vehicle.

### Example: `get_battery` (humanized)

This is what a domain answer looks like, rendered from the project's sanitized test fixture (synthetic values):

```text
Vehicle YSMTEST22PL000001: telemetry/battery (data observed 12 min ago)
Charge: 52% · range 170 km
Charging: Idle · Unplugged
Average consumption: 20.1 kWh/100km
```

With `raw: true` the untouched payload is appended after the summary, so nothing the humanizer does not yet cover is ever lost.

## Aggregate tools (4)

The aggregates exist because the questions people actually ask span several domains. Each one reads its constituent domains through the cache, so it costs at most one live call per constituent and usually zero.

- `get_car_status`: a one-call briefing: charge level and state, range, what is open and locked, availability, odometer, service countdown, and the newest data age across the five domains it reads. Use this instead of five separate `get_*` calls.
- `is_car_secure`: a true/false security check. Names anything open (doors, windows, hood, tailgate), whether the central lock is engaged, and the alarm state.
- `get_needs_attention`: only the active warnings from the health domain (fluids, lights, 12V, service) plus the service countdown. An empty answer means nothing needs attention.
- `get_charging_estimate`: energy and time needed to reach the target charge level. Uses the car's live charging power when plugged in, otherwise the configured amp limit times your AC phases (default 3), and derives pack capacity from the reported usable energy when available. Every assumption is stated in the answer.

## Advisor tool (1)

- `plan_cheapest_charge`: the read-only smart-charging advisor. You supply an hourly spot-price curve as an argument (so no external service is contacted); the tool combines it with the car's current charge level, target level, amp limit, and the charge window configured in the car's global charge timer, and computes the cheapest contiguous hours that deliver enough energy to reach the target. If the window is too short it falls back to the cheapest individual hours and says so. It never sends anything to the car.

## System tool (1)

- `polestar_status`: the server's self-report: daily API budget (used, limit, and when it resets), cache hit rate, token expiry, and mode. Call it when you suspect the daily API budget is running low. See [getting-started.md](getting-started.md) for why the budget exists.

## History tools (3, opt-in)

Registered only when the server runs with a history directory (`POLESTAR_HISTORY_DIR`). They answer the longitudinal questions the stateless API cannot:

- `get_history`: raw recorded samples for one domain, one line per change, newest first. Duplicates (same cloud `metaEventId`) are never stored twice.
- `get_degradation_report`: the trend of the battery's implied full-charge range (range divided by SoC) and implied pack capacity over recorded history, presented as a series of estimates rather than a single verdict. Needs at least 5 recorded samples.
- `get_charging_sessions`: charging sessions reconstructed from recorded battery samples: start, duration, peak power, and the maximum charge level reached.

## Resources, prompts, and annotations

Beyond tools, the server exposes:

- **Resources**: `polestar://vehicle/{vin}/{telemetry|charging}/{domain}`. The list is derived from the credential's vehicles and the domain registry, VIN and domain arguments support completions, and a resource read returns the same humanized view as the matching tool.
- **Subscriptions**: a client can subscribe to a resource URI. The server re-reads it once a minute through the cache and notifies the client only when the cloud's `metaEventId` changed, which happens only when the car actually reported something new. Subscriptions pause rather than spend the last 10% of the daily budget.
- **Prompts**: three starter prompts (`car-status`, `charge-plan`, `battery-health-report`) that wire common questions to the right tool sequence.

## When data is missing: DATA_NOT_AVAILABLE

A Polestar reports each domain independently, and "not reported" is a normal state, not a fault. If a car reports nothing at all for a domain, the API answers with HTTP 404 and the error code `DATA_NOT_AVAILABLE`, and the tool turns that into a plain sentence instead of an error result:

```text
No is-at-charge-location data is available for vehicle YSMTEST22PL000001
(the API returned DATA_NOT_AVAILABLE: this vehicle does not report this domain).
```

Your assistant will read that sentence and can tell you the car does not report the topic. This is why asking "is my car at a charging station?" sometimes has no answer: it depends on whether that car reports the domain at all.
