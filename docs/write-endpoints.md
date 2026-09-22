# Write endpoints (designed, waiting for Polestar)

Who this is for: developers planning for the day the API publishes writes. The read-only contract is in [upstream-api.md](upstream-api.md); what the read-only posture means operationally is in [SECURITY.md](../SECURITY.md).

The M2M token already carries the write scopes (`pdp-charging/targetSoc`, `pdp-charging/overrideChargeTimer`, `pdp-charging/ampLimit`, `pdp-charging/globalChargeTimer`, `pdp-charging/parkingClimateTimer`), but the documented v1 API publishes no write endpoints: every operation is a GET. This server therefore ships read-only, and `POLESTAR_ENABLE_WRITES=1` currently registers nothing; it exists so the day Polestar documents writes, the tools land behind the deliberate opt-in that is already wired.

## What slots in where

Every expected call is a `PUT /v1/vehicles/{vin}/charging/<name>` (a guess, unconfirmed); the table lists the `<name>` that would sit at that spot.

| Scope | Expected `<name>` (guess, unconfirmed) | Tool |
| --- | --- | --- |
| `pdp-charging/targetSoc` | `target-soc` | `set_target_soc {vin, percent}` |
| `pdp-charging/overrideChargeTimer` | `charge-now` | `start_charging` / `stop_charging` |
| `pdp-charging/ampLimit` | `amp-limit` | `set_amp_limit {vin, amps}` |
| `pdp-charging/globalChargeTimer` | `global-charge-timer` | `set_charge_window {vin, startHour, endHour, activated}` |
| `pdp-charging/parkingClimateTimer` | `parking-climate-timer` | `set_climate_timer {vin, ...}` |

## Safety design (non-negotiable when writes land)

1. Writes stay behind `POLESTAR_ENABLE_WRITES=1`; reads never ask for confirmation, writes always carry `destructiveHint: true` annotations so MCP clients prompt the user.
2. Every write tool takes an explicit `vin`: no single-vehicle defaulting, no "the only car" guessing on mutating calls.
3. `PolestarClient` gains `writeDomain(vin, kind, name, body)` next to `domain()`; writes bypass the cache and invalidate the entry they mutate.
