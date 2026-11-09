# Correctness and reliability audit, polestar-mcp lane 2

Auditor: correctness-hunter (delegated teammate). Task: `task-2`.

- Repo: `/Users/nicolaskheirallah/Documents/GitHub/polestar-mcp`
- Node v22.23.2, dependencies already installed. Baseline before any probe: `npm test` → **111 pass, 0 fail**.
- No tracked file was modified. Everything below is reproducible offline from `analysis/correctness/`:
  - probe sources: `analysis/correctness/probe-*.ts`
  - captured outputs: `analysis/correctness/out/probe-*.txt`
  - command form: `node --import tsx analysis/correctness/probe-<name>.ts`
- No live Polestar API call was made. The one probe that needs HTTP (`probe-cache-off-budget.ts`) stubs `globalThis.fetch`.

Severity = impact × reachability today. "Fix risk" = chance the suggested fix itself regresses something.

---

## Summary table

| # | Severity | Finding | File |
|---|----------|---------|------|
| C1 | **High** | Cache key is the URL alone, so a delegated account is served the owner's cached `/v1/vehicles` list (and wrong default VIN / another identity's payload) | `src/caching-transport.ts:83`, `src/client.ts:87`, `src/server.ts:80` |
| C2 | **High** | `POLESTAR_CACHE=off` removes the retry wrapper, which is also the only budget and per-minute meter → no fail-closed guard, no retries | `src/server.ts:78-79` |
| C3 | Medium | Three-phase power model multiplies a reported 400 V by the phase count: 19.2 kW reported; if 400 V is line-to-line (as the repo's own fixture assumes) physics gives 11.1 kW (1.73×). Test pins 19.2 | `src/charge-model.ts:53`, `test/charge-model.test.ts:68-84` |
| C4 | Medium | Planner reports `feasible: true` with a schedule that delivers a fraction of the energy when the window has fewer slots than needed | `src/planner.ts:126-138` |
| C5 | Medium | Planner calls a block "contiguous" when its slots straddle a 20-hour day gap; no `reason`, no non-contiguous assumption | `src/planner.ts:118-125` |
| C6 | Medium | Charge-window stop hour expressed as >23 (`28` = 04:00 next day) is silently truncated to 22:00-24:00 | `src/planner.ts:70-73` |
| C7 | Medium | Every 403 is rewritten as "this domain needs the OAuth scope …", contradicting the repo's live finding that 403 is account-id/VIN authorization | `src/vehicle-read.ts:229` |
| C8 | Medium | Subscription poller loses a change forever when `notify()` rejects, and duplicate-notifies on overlapping rounds | `src/subscriptions.ts:105-107`, `:97` |
| C9 | Medium | A semantic 404 (`DATA_NOT_AVAILABLE` → `null`) is never cached: every read of a permanently absent domain is a live call | `src/caching-transport.ts:114` |
| C10 | Medium | `list_vehicles` declares no `delegated_account_id`; the argument is silently dropped and the owner's list is returned | `src/domain-tools.ts:19-45` |
| C11 | Low | `HistoryStore.append` records the dedupe id before the write; after a failed write the same event is silently skipped forever | `src/history.ts:50-53` |
| C12 | Low | `Math.max(...array)` in `extractChargingSessions` throws `RangeError` at ≥~130k samples, reachable inside the legal 64 MB history file | `src/history.ts:190-191` |
| C13 | Low | `Retry-After` HTTP-date form is ignored and a negative value yields a negative sleep (retry immediately) | `src/retrying-transport.ts:88-92` |
| C14 | Low | Concurrent 401s: each `invalidate()` drops the token a previous retry just minted → N+1 token POSTs, all budget-metered | `src/auth.ts:91-93`, `src/client.ts:201-204` |
| C15 | Low | `polestar_status` token clock ignores the 5-minute skew, reporting a token as trusted while `token()` already refetches | `src/system-tools.ts:62-68` |
| C16 | Low | `polestar_status` names `POLESTAR_CACHE_DISABLED`, a variable the loader reports as unknown; a test pins the wrong name | `src/system-tools.ts:54`, `test/server-seams.test.ts:251` |
| C17 | Low | A negative-price plan omits `totalCost` (`>0` guard) even though the cost is computable | `src/planner.ts:147` |
| C18 | Low | A corrupt future timestamp makes `formatAge` say "0s ago" and makes the pre-cleaning summary throw `RangeError` → `INTERNAL_ERROR` | `src/format.ts:99-106`, `:207`, `src/domain-data.ts:159-163` |
| C19 | Low | Budget "rolling UTC day" comment/doc is a fixed UTC-midnight window; a backward clock step after the roll is metered into the stale window | `src/budget.ts:28`, `docs/architecture.md:119` |

---

## C1 (High), Cache key is the URL alone, so delegation does not isolate the cache

**File:line** `src/caching-transport.ts:83` (`const key = url;`), `src/client.ts:85-88` (`forDelegation` reuses `this.transport`), `src/server.ts:80-97` (one `CachingTransport` instance for every client).

**Probe**
```
node --import tsx analysis/correctness/probe-cache-delegation.ts
```

**Observed output** (`out/probe-cache-delegation.txt`)
```json
{
  "ownerVehicles": ["YSMTEST22PL000001"],
  "callsAfterOwnerVehicles": 2,
  "partnerVehicles": ["YSMTEST22PL000001"],
  "callsAfterPartnerVehicles": 2,
  "vehicleCalls": [{ "url": "https://api.test/m2m/v1/vehicles" }],
  "partnerResolvedVin": "YSMTEST22PL000001",
  "ownerResolvedVin": "YSMTEST22PL000001",
  "partnerBattery": { "vin": "YSM-PARTNER-VIN-01", "batteryChargeLevelPercentage": 42 },
  "callsAfterPartnerBattery": 3,
  "ownerBatteryAfterPartner": { "vin": "YSM-PARTNER-VIN-01", "batteryChargeLevelPercentage": 42 },
  "callsAfterOwnerBattery": 3
}
```

The stub upstream answers `/v1/vehicles` per identity (`partner-a` → `YSM-PARTNER-VIN-01`, owner → `YSMTEST22PL000001`), yet the partner client received the owner's list and **no second HTTP call was made**: the cache hit answered the delegated read locally, so the request that would have carried `x-delegated-account-id` was never sent. Consequences, in order of importance:

1. `list_vehicles` for a delegated call shows the operator's VINs, cross-account identity leak.
2. `resolveVin(undefined)` on a delegated client returned the **owner's** VIN (`partnerResolvedVin`), so a delegated tool call with an omitted VIN targets the wrong car. If the partner happens to share that VIN the read silently succeeds under the wrong identity; otherwise the caller gets a confusing 403 for a VIN it never named.
3. A payload fetched under one identity is served under another (`ownerBatteryAfterPartner` got the partner-shaped payload).

The cache cannot see headers, and every delegated client shares the one instance, so this is structural, not a timing race. `test/runtime.test.ts:629-658` ("an allowlisted delegated account serves the read") builds fake clients with no cache, and `test/client.test.ts` uses one client only, which is why 111 green tests do not see it.

**Impact** Cross-account data/identity leak on a product whose whole delegation feature exists because "the API does not reject an unknown delegation, so this server checks it" (`tool-output.ts:115`). The API answers **200** for an unknown `x-delegated-account-id` (`docs/live-contract-findings.md:14`), so a wrong-identity cache hit is indistinguishable from a correct answer.

**Fix** Make the key identity-scoped: `key = `${x-client-id}\u0000${x-delegated-account-id ?? ''}\u0000${url}``, taking the values from `request.headers` (or pass an identity token into `CachingTransport`). Alternatively, disable caching for delegated reads, but that costs quota. Also key the vehicles list by identity even if domains stay URL-keyed.

**Effort** M. **Fix risk** Low (cache key change; add a test that a partner call after an owner call goes out with the header).

**Regression test** In `test/runtime.test.ts` (or a new `test/cache-delegation.test.ts`): real `PolestarClient` + `TokenProvider` + one `CachingTransport` over a scripted transport that varies its answer by `x-delegated-account-id`; assert owner then partner `vehicles()` makes **two** GETs and returns two different lists, and that `partner.resolveVin(undefined)` is the partner VIN.

---

## C2 (High), `POLESTAR_CACHE=off` silently disables budget metering, the minute ceiling, and retries

**File:line** `src/server.ts:78-79`
```ts
const inner: Transport =
  config.fixturesDir || config.cacheDisabled ? base : new RetryingTransport(base, { budget, minute });
```
`RetryingTransport` is the only budget (`budget.consume()`) and per-minute (`minute.consume()`) meter and the only retry layer. `cacheDisabled` comes from `POLESTAR_CACHE=off` (`src/config.ts:280`), documented as "disables the response cache" (`docs/getting-started.md:96`, `README.md:196`). Fixture mode is a legitimate reason to skip the wrapper; cache-off is not.

**Probe** (offline; `globalThis.fetch` stubbed; upstream answers 429 twice then 200)
```
node --import tsx analysis/correctness/probe-cache-off-budget.ts
```

**Observed output** (`out/probe-cache-off-budget.txt`)
```json
{
  "off": { "label": "POLESTAR_CACHE=off", "cacheEnabled": false, "budgetUsed": 0, "minuteUsed": 0,
           "httpRequests": 2, "vehiclesOutcome": "PolestarApiError: Request failed (HTTP 429)." },
  "on":  { "label": "cache default (on)", "cacheEnabled": true, "budgetUsed": 4, "minuteUsed": 4,
           "httpRequests": 4, "vehiclesOutcome": "[\"YSMTEST22PL000001\"]" }
}
```

With the cache off, the 429 is surfaced to the tool; nothing is metered and nothing is retried. With the cache on, the same 429 is retried and all four HTTP attempts (token + 3 GETs) are metered. So the fail-closed 10,000/day guard, the 100/minute guard and the documented 429/502/503 handling all disappear when an operator turns off caching.

**Impact** The one safety property this server exists to add over the raw API (quota discipline) can be switched off by a performance setting, silently. `docs/getting-started.md:173` promises "The server meters every live call it makes (including retries)", false in this configuration. A caller with the cache off can burn the credential's daily allowance and hammer 429s.

**Fix** Select the retry wrapper independently of the cache:
```ts
const metered: Transport = config.fixturesDir ? base : new RetryingTransport(base, { budget, minute });
const cache = new CachingTransport(metered, { disabled: config.cacheDisabled || ... });
```
and add a `buildEngine` assertion on the wiring. **Effort** S. **Fix risk** Low.

**Regression test** In `test/server-seams.test.ts`, build the engine with `POLESTAR_CACHE=off` and a stubbed fetch; assert a 429 is retried and `budget.snapshot().used > 0` after one read. (A unit test of the expression alone would not catch a future re-ordering.)

---

## C3 (Medium), Three-phase power estimate is 1.73× too high for a reported 400 V line-to-line voltage

**File:line** `src/charge-model.ts:50-58` (formula at `:53`). `phases` is described as "AC phases at your charger (default 3, Swedish 400V three-phase)" (`src/advisor-tools.ts:15`). The fallback path assumes 230 V *per phase* (`ASSUMED_LINE_VOLTS = 230`, × 3 phases = 11.04 kW at 16 A), but a reported 400 V is line-to-line and three-phase power is `√3 · 400 · 16 = 11.09 kW`, not `3 · 400 · 16 = 19.2 kW`.

**Probe**
```
node --import tsx analysis/correctness/probe-charge-model.ts
```

**Observed output** (`out/probe-charge-model.txt`)
```json
{
  "model": {
    "assumed_230V_x_3phases_kW": 11.04,
    "reported_400V_x_3phases_kW": 19.2,
    "physical_3x16A_at_400V_line_to_line_kW": 11.085,
    "physical_3x16A_at_230V_per_phase_kW": 11.04,
    "ratio_400V_path_vs_physical": 1.73
  },
  "get_charging_estimate_text": "Energy to 80%: 31.2 kWh (now 40%).\nTime at 19.2 kW: ~1h 38m.\nAssumptions: power estimated from 16 A × 400 V (reported) × 3 phase(s); …"
}
```

The same `powerKw` feeds `plan_cheapest_charge` (`src/advisor-tools.ts:90-90`), so the plan schedules ~1.7× fewer charging hours than the car actually needs. The repo's own test payload reports 400 V (`test/charge-model.test.ts:19`, `test/contract.test.ts:74`) and `test/charge-model.test.ts:68-84` asserts `19.2` is correct, so the suite protects the bug.

**Impact** Wrong charging-time estimate and a charge plan that under-charges (or, once C4 is fixed, would declare the target unreachable late). Only bites cars that report `chargingVoltageVolts`; the reference car does not (`docs/live-contract-findings.md:38`), so it is a data-dependent but real path.

**Fix** Pick one volt convention and use it everywhere: if `chargingVoltageVolts` is line-to-line, `powerKw = (√3 · volts · amps · phases>1) / 1000`; if it is per-phase, keep `amps · volts · phases` and state "per-phase" in the assumption. Re-derive `ASSUMED_LINE_VOLTS` consistently. **Effort** S. **Fix risk** Low, but needs a decision on upstream semantics.

**Regression test** Unit-test both paths against the physics: 3-phase 16 A at 400 V line-to-line = 11.1 ± 0.1 kW; the `get_charging_estimate` test should assert a physical number instead of `19.2`.

---

## C4 (Medium), Planner claims feasibility while delivering a fraction of the needed energy

**File:line** `src/planner.ts:114-138`. When `hoursInt > rated.length` the fallback takes `rated.length` slots but still splits `energyNeededKwh / hoursInt` per step, so total planned energy = `energyNeeded · slots / hoursNeeded < energyNeeded`. `feasible` stays `true` and no assumption mentions the shortfall.

**Probe**
```
node --import tsx analysis/correctness/probe-planner.ts
```

**Observed output** (case A in `out/probe-planner.txt`)
```json
"A_scarce_window": {
  "feasible": true,
  "reason": "Window too short for one contiguous block, fell back to cheapest individual hours.",
  "energyNeededKwh": 64,
  "hoursNeeded": 6.4,
  "steps": 2,
  "energyPlannedKwh": 18.285714285714285,
  "shortfallKwh": 45.71
}
```

A 1-hour nightly window (2 slots in 48 h) with 64 kWh needed returns `feasible: true` and a 2-step plan delivering 18.3 kWh. The reason sentence talks about contiguity, not about the 45.7 kWh that will never be delivered.

**Impact** The agent reads "feasible" and presents a schedule that misses the target by 70%. The tool is advisory/read-only, so the harm is a wrong answer, not a wrong car command, but it is the tool's core arithmetic.

**Fix** If `chosen.length * (energyNeededKwh / hoursInt) < energyNeededKwh, epsilon`, return `feasible: false` with a reason naming the deliverable energy and the needed window length; or keep `feasible: true` only when the remaining energy can be delivered and state the shortfall in `reason`/`assumptions`. Also report energy per step from the actual schedule. **Effort** S. **Fix risk** Low.

**Regression test** `test/planner.test.ts`: 1-hour window, 64 kWh needed, 10 kW → assert `feasible === false` or `steps.reduce(energy) >= energyNeeded`; today the named fallback test (`:125-142`) never reaches the branch (see "Tests that assert the wrong thing").

---

## C5 (Medium), "Contiguous" block is contiguous in the filtered slot array, not in time

**File:line** `src/planner.ts:118-125` (block over `rated`, the in-window-only slot list), `:143`, `:148` (reason/assumption only on the `contiguous` flag).

**Probe**
```
node --import tsx analysis/correctness/probe-planner-contiguity.ts
```

**Observed output**
```json
{
  "feasible": true,
  "hoursNeeded": 4.8,
  "steps": ["2026-01-01T22:00:00.000Z","2026-01-01T23:00:00.000Z","2026-01-02T00:00:00.000Z","2026-01-02T01:00:00.000Z","2026-01-02T22:00:00.000Z"],
  "gapHoursBetweenSteps": [0, 0, 0, 20],
  "reason": null,
  "saysNonContiguous": false
}
```

A 22:00→02:00 window (4 h/night) with 4.8 h needed picks five slots including one **20 hours later**, and reports the block as contiguous: no `reason`, no "Hours are not contiguous" assumption. The agent is told the car can charge in one stretch.

**Impact** Misleading schedule; the same "contiguous" label is what the advisor prints and what a caller would act on. Combined with C6 it is also how the >23 window produced a schedule spanning a day.

**Fix** Treat a block as contiguous only if every consecutive pair of slots is exactly one slot-duration apart (`start[i+1], end[i] === 0`); otherwise fall through to the existing fallback and set `contiguous = false`. **Effort** S. **Fix risk** Low.

**Regression test** The probe scenario as a unit test: a 4 h/night window needing 5 h must not yield a `reason === undefined` plan containing a >1 h gap.

---

## C6 (Medium), A stop hour above 23 truncates the window instead of wrapping it

**File:line** `src/planner.ts:70-73` (`inWindow`), `:79-84` (slot expansion). The window contract in the header says "0-23", but the repo's own accepted payload shape uses `stop.hour = 28` (`test/charge-model.test.ts:19-22`, and `chargeWindow` passes it through unvalidated: `src/domain-data.ts:91-110`).

**Probe** case C in `out/probe-planner.txt`
```json
"C_stop_hour_28": {
  "plannedLocalHours": [22, 23, 22],
  "plannedUtcTimes": ["2026-01-01T22:00:00.000Z","2026-01-01T23:00:00.000Z","2026-01-02T22:00:00.000Z"],
  "note": "window 22:00-28:00 means 22:00-04:00; 00:00-03:00 never appears"
}
```

With `start=22`, `stop=28`, `inWindow` takes the `start <= end` branch and tests `localHour < 28`, so only 22 and 23 are ever in-window; 00:00-03:00 is dropped. (The same probe also shows the chosen 3-slot "block" jumping a day, because the filtered array hides the gap, C5.)

**Impact** A car whose timer is expressed as 22→28 gets a plan that ignores four of its six charging hours, and if more energy is needed than 22:00-24:00 can deliver it hits C4's silent shortfall. The humanizer also prints `22:00 → 28:00`, which no reader can interpret.

**Fix** Normalize hours at the boundary: if `endHour > 23`, convert to `(start, endHour - 24)` and use the wrap branch; or accept an absolute end (`start + duration`). Normalize in `chargeWindow()` so every consumer (humanizer, planner) sees one convention, and reject/annotate anything outside 0-47. **Effort** S/M. **Fix risk** Medium: the upstream convention is inferred from repo fixtures, not documented; confirm against a live payload before hard-coding.

**Regression test** `planCheapestCharge({windowStartHour:22, windowEndHour:28, ...})` must schedule hours 22,23,0,1,2,3 and never a 22-hour jump; `chargeWindow` must normalize or reject the value.

---

## C7 (Medium), Every 403 is misdiagnosed as a missing OAuth scope

**File:line** `src/vehicle-read.ts:224-231` passes a fixed scope hint whenever `httpStatus === 403`, overriding the code-specific hint in `errorResult()`.

**Probe**
```
node --import tsx analysis/correctness/probe-error-hints.ts
```

**Observed output**
```json
{
  "403_AUTHZ_CLIENT_ID_MISMATCH": {
    "get_battery_hint": "this domain needs the OAuth scope `pdp-telemetry/battery` on the credential",
    "get_car_status_hint": "x-client-id carried the OAuth client id. Set POLESTAR_ACCOUNT_ID to the Account ID shown next to the Base URL in the Data Portal."
  },
  "403_AUTHZ_VIN_UNAUTHORIZED": {
    "get_battery_hint": "this domain needs the OAuth scope `pdp-telemetry/battery` on the credential",
    "get_car_status_hint": "This credential cannot see that VIN. Call list_vehicles for the authorized set; …"
  }
}
```

`src/tool-output.ts:130-136` states the opposite: "403 is `AUTHZ_VIN_UNAUTHORIZED` … or `AUTHZ_CLIENT_ID_MISMATCH` … Neither is a scope problem; a 401 is what a bad credential looks like", and `docs/live-contract-findings.md:12, :21` confirms both live 403 codes. So the domain tools send the operator to `POLESTAR_SCOPES` for a problem that is account-ID/VIN authorization, and the aggregate tools answer the same failure correctly, one API, two diagnoses.

**Impact** Operator wastes time on scopes; the actionable fix (`POLESTAR_ACCOUNT_ID`, VIN sharing) is suppressed exactly on the tools most likely to be called first.

**Fix** Only add the scope hint for `AUTHZ_SCOPE_MISSING` (the one documented scope code), or append it as a secondary sentence instead of replacing the hint. **Effort** S. **Fix risk** Low.

**Regression test** `runtime.test.ts`: for `AUTHZ_CLIENT_ID_MISMATCH` the `get_battery` hint must mention `POLESTAR_ACCOUNT_ID`; for `AUTHZ_SCOPE_MISSING` it must mention the scope. Today only the 403→scope direction is implied by existing tests (none assert the text).

---

## C8 (Medium), Subscription poller: a rejected notify loses the change forever; overlapping rounds double-notify

**File:line** `src/subscriptions.ts:105-107` (`lastEventId.set` before `await deps.notify`), `:97` (`seen` destructured from a snapshot, no re-entrancy guard on the default `setInterval` clock).

**Probe**
```
node --import tsx analysis/correctness/probe-subscriptions.ts
```

**Observed output**
```json
{
  "A_notify_failure": { "reads": ["e1","e2","e2","e2"], "notified": [],
    "note": "e2 was never delivered; later rounds see no change" },
  "B_overlapping_rounds": { "reads": ["e2","e2"],
    "notified": ["polestar://vehicle/…/telemetry/battery","polestar://vehicle/…/telemetry/battery"],
    "note": "one cloud change, two notifications" }
}
```

A: the state is advanced before `notify()` is awaited; when `sendResourceUpdated` rejects (e.g. transport closing), the `catch` swallows it and the change can never be re-detected. B: the default clock is `setInterval`, and one round can outlast 60 s when several subscriptions each take up to the 15 s HTTP deadline; the second round's `seen` came from a snapshot taken before the first round wrote, so both notify. `test/server-seams.test.ts:74-105` runs rounds strictly sequentially and always-resolving notifies, so neither case is covered.

**Impact** A subscribed client can silently stop receiving updates for a resource (stale display with no error), or receive a duplicate update for one cloud event. Low per-event cost, but subscriptions are advertised as working.

**Fix** Set the id only after `notify()` resolves (or restore the previous id on failure); add a `polling` boolean guard so a tick is skipped while a round is in flight (`setTimeout` chain instead of `setInterval` also removes overlap). **Effort** S. **Fix risk** Low.

**Regression test** Two cases in `test/server-seams.test.ts`: notify rejects once → a later round must notify again for the same id; two concurrent `pollOnce()` calls resolving reads out of order → exactly one notification.

---

## C9 (Medium), Absent domains are never cached ("no data" is treated as an error response)

**File:line** `src/caching-transport.ts:111-119` stores only `status < 400`; the 404 `DATA_NOT_AVAILABLE` is mapped to `null` *above* the cache (`src/client.ts:150-153`), so the cache never sees a cacheable "absent".

**Probe**
```
node --import tsx analysis/correctness/probe-absent-domain-cache.ts
```

**Observed output**
```json
{
  "results": [null, null, null],
  "cacheStats": { "enabled": true, "hits": 0, "misses": 3, "staleServed": 0, "refreshes": 3, "entries": 0 },
  "domainCalls": 3,
  "note": "three reads of an absent domain -> three live calls; a 200 response would be served from cache after one"
}
```

`docs/live-contract-findings.md:38` says the reference car answers `is-at-charge-location` with exactly this 404, and the registry comments say it is "often unsupported". So a permanently absent Domain costs one live call per read forever: `get_car_status` reads five domains concurrently, and for a car absent in one of them every status call spends that call. The design intent is the opposite ("repeated reads are served locally", `docs/upstream-api.md:108`). `test/runtime.test.ts:201-212` ("error responses are not cached") pins the general rule but does not distinguish a semantic absence from a 5xx.

**Impact** Quota burn; with a 10,000/day budget, a handful of agents polling `get_car_status` can exhaust the day on domains that will never answer.

**Fix** Cache a small marker for the `DATA_NOT_AVAILABLE` 404 under the same domain TTL (e.g. store `{response, fetchedAt, ttlMs}` and let the client map it again, or store a `null` result at the domain level). Do not cache other error statuses. **Effort** S/M. **Fix risk** Low-Medium: changes stale semantics for absent data; guard with a regression test.

**Regression test** Two `client.domain()` reads of an absent domain → exactly one inner HTTP call; an unrelated 500 is still not cached.

---

## C10 (Medium), `list_vehicles` takes no delegation, so a delegating caller is answered from the operator's identity

**File:line** `src/domain-tools.ts:19-45` (`run: async () => …` with no args object). The repo already fixed this class of bug for the other tools ("The SDK drops an undeclared argument rather than refusing it, so the aggregate silently answered from the operator's own account while looking like a scoped read", `src/aggregate-tools.ts:27-33`), but the VIN list, the most identity-sensitive read, was excluded because the test selects candidates with `'vin' in argsOf(spec)` (`test/runtime.test.ts:689`).

**Probe**
```
node --import tsx analysis/correctness/probe-list-vehicles-delegation.ts
```

**Observed output**
```json
{
  "list_vehicles_declared_args": [],
  "caller_passed": { "delegated_account_id": "partner-a" },
  "client_calls": ["owner.vehicles"],
  "resultText": "Authorized vehicles (1):\n  - YSMTEST22PL000001"
}
```

**Impact** A third-party operator cannot list a delegated account's vehicles; passing the argument is silently ignored, and the answer looks like the requested account's list. In combination with C1, the list may also be the owner's cached list, the two defects compose.

**Fix** Add `...delegatedAccountArg` to `list_vehicles` and resolve the client through `clientFor()` (the pattern in `vehicleFor`). **Effort** S. **Fix risk** Low.

**Regression test** A delegated `list_vehicles` call must go through `forDelegation('partner-a')` and return the partner's list; assert `x-delegated-account-id` reached the transport (once C1 is fixed).

---

## C11 (Low), A failed history append poisons the dedupe map and silently drops the retry

**File:line** `src/history.ts:50-53`: `lastEventId.set(file, id)` happens before `appendFileSync`.

**Probe**
```
node --import tsx analysis/correctness/probe-history.ts
```

**Observed output**
```json
"A_append_failure": {
  "firstError": "EISDIR: … open '…/YSMTEST22PL000001/telemetry-battery.jsonl'",
  "retryOfSameEvent": "silently skipped",
  "recordsAfterRetry": 0
}
```

After any write failure (ENOSPC, EACCES, a stray directory, a crash mid-append), the in-memory map claims the event is stored. The caller's retry of the same `metaEventId` returns without writing and without throwing: silent data loss. (The first failure itself also propagates out of `onDomainRead` and turns an otherwise successful read into a tool error, `src/client.ts:170-176`, so a full disk breaks reads, not just recording.)

**Fix** Set the map entry only after `appendFileSync` returns; catch/annotate the write error so history failure does not fail the read (log once, keep serving). **Effort** S. **Fix risk** Low.

**Regression test** Force a write failure (path is a directory), repair it, retry the same event → the record must be present; assert a failed write does not fail `client.domain()`.

---

## C12 (Low), `extractChargingSessions` crashes with `RangeError` on a long-but-legal history

**File:line** `src/history.ts:190-191`: `Math.max(...s.map(...))` / `Math.max(...levels)` spread one argument per sample.

**Probe** case B in `out/probe-history.txt`
```json
"B_spread_limit": [
  { "samples": 50000, "ok": true, "sessions": 1 },
  { "samples": 130000, "ok": false, "error": "RangeError: Maximum call stack size exceeded" },
  { "samples": 200000, "ok": false, "error": "RangeError: Maximum call stack size exceeded" }
]
```

The history file cap is 64 MB (`MAX_HISTORY_FILE_BYTES`), and a compact battery record is a few hundred bytes, so >130k samples are legal; the sampler alone adds ~144/day, plus every tool read. The threshold is Node-version-dependent (50k is fine, 130k is not).

**Impact** `get_charging_sessions` (and only that tool) throws `INTERNAL_ERROR` on a mature store; the larger the historical value, the more likely the failure, and the error message points at nothing actionable.

**Fix** Reduce instead of spread: `s.reduce((m, x) => Math.max(m, x.power), 0)`. **Effort** S. **Fix risk** Very low.

**Regression test** 200k synthetic charging samples → one session, no throw.

---

## C13 (Low), `Retry-After` HTTP-date form is ignored, negative values retry immediately

**File:line** `src/retrying-transport.ts:88-92`: `const seconds = Number(raw); return Number.isFinite(seconds) ? seconds * 1000 : undefined;` while the comment at `:72-74` says "a server-supplied Retry-After is honoured as given".

**Probe**
```
node --import tsx analysis/correctness/probe-retry-after.ts
```

**Observed output**
```json
[ { "label": "HTTP-date in the future", "header": "Tue, 01 Jan 2030 00:00:00 GMT", "waits": [500], "calls": 2 },
  { "label": "negative integer", "header": "-5", "waits": [-5000], "calls": 2 },
  { "label": "integer seconds", "header": "30", "waits": [30000], "calls": 2 },
  { "label": "non-numeric", "header": "soon", "waits": [500], "calls": 2 } ]
```

The HTTP-date form (RFC 7231 allows `Retry-After` as either a delay-seconds integer or an HTTP-date) falls back to 500 ms exponential backoff; a negative value yields `sleep(-5000)` (`setTimeout` clamps to 0 → immediate retry). A server explicitly asking for delay is retried far sooner, which is the one thing the header exists to prevent, and the server budget/429 behaviour depends on it.

**Fix** Parse both forms: `Number.isFinite(seconds) ? max(0, seconds)*1000 : Date.parse(raw), now` with a `now` available inside `retryAfterHeaderMs` (the transport already has `this.now`); clamp negatives to 0 (or treat as absent) and refuse absurd values (`> totalDeadlineMs` is already handled by the deadline check). **Effort** S. **Fix risk** Low.

**Regression test** 429 with an HTTP-date 30 s in the future → wait 30 s (injected clock/sleep); `"-5"` → wait 0, not -5000; add to `test/runtime.test.ts`.

---

## C14 (Low), Concurrent 401s wipe freshly minted tokens (N+1 token POSTs, all metered)

**File:line** `src/auth.ts:91-93` (`invalidate()` clears whatever is cached now), `src/client.ts:201-204` (every 401 calls it, then retries).

**Probe**
```
node --import tsx analysis/correctness/probe-auth-invalidate-race.ts
```

**Observed output**
```json
{
  "requests": 3, "allFailedWith401": true, "tokenPosts": 4, "getAttempts": 6,
  "authorizationUsed": ["Bearer tok-1","Bearer tok-1","Bearer tok-1","Bearer tok-2","Bearer tok-3","Bearer tok-4"],
  "note": "each 401 wipes the token that the previous retry had just minted, so 3 requests spent 4 token POSTs instead of 2"
}
```

The three requests correctly shared `tok-1` (single-flight works), but each 401 invalidated the token the previous retry had already fetched, so the retries used three different fresh tokens. Correctness is preserved (each request retried once and failed), but under a 401 storm (revoked/rotated credential) every concurrent request can add a token POST, and token POSTs are budget-metered and go through the minute ceiling too.

**Fix** Stamp the cache token with a generation/epoch: `invalidate(token?: string)` clears only if the cached token is the one that failed, or capture the failing token in `requestRaw` and pass it. Also skip the extra refetch if a token minted after the request started is already cached. **Effort** M. **Fix risk** Medium (token lifecycle), so combine with a test for the concurrent-401 case.

**Regression test** The probe scenario: three concurrent 401s → at most 2 token POSTs, and no request retries with a token minted before its own 401.

---

## C15 (Low), `polestar_status` reports the token trusted past the 5-minute skew

**File:line** `src/system-tools.ts:62-68` uses `expiresAt()` raw; `TokenProvider` stops trusting at `expiresAt, EXPIRY_SKEW_MS` (`src/auth.ts:13,76`).

**Probe**
```
node --import tsx analysis/correctness/probe-status.ts
```

**Observed output**
```json
"A_token_clock": {
  "statusLine": "Token: trusted ~3 more min",
  "tokenRequestsBefore": 1,
  "tokenRequestsAfterCallingToken": 2,
  "note": "status said \"trusted\", the provider refetched because the 300s skew had started"
}
```

**Impact** The self-observation tool (whose stated purpose is pacing) overstates usable token life by up to 5 minutes; an agent told "trusted ~3 min" will not expect a refresh. Cosmetic for correctness, misleading for the tool's purpose.

**Fix** Report `expiresAt, EXPIRY_SKEW_MS` (expose `trustedUntil()` or subtract in the status tool via the provider) and say "refetches in N min". **Effort** S. **Fix risk** Low.

**Regression test** The existing `polestar_status` arithmetic test (`test/server-seams.test.ts:213-266`) should assert the skew-adjusted number, not `12 more min` for a 12-minute expiry.

---

## C16 (Low), `polestar_status` names a settings variable that does not exist; a test pins the wrong name

**File:line** `src/system-tools.ts:54` prints `POLESTAR_CACHE_DISABLED`; the real switch is `POLESTAR_CACHE` (`src/config.ts:280`, `KNOWN_ENV_VARIABLES`). `test/server-seams.test.ts:251` asserts the wrong name, so the suite protects it. The same regex is reused at `:262` for the hit-rate assertion.

**Probe** (case B in `out/probe-status.txt`)
```json
{
  "B_cache_off_line": "Cache: off (POLESTAR_CACHE_DISABLED, or fixture mode without a history store)",
  "B_named_variable_is_recognized": false,
  "B_named_variable_unknown_report": [{ "name": "POLESTAR_CACHE_DISABLED", "suggests": "POLESTAR_CACHE" }],
  "B_real_switch": { "POLESTAR_CACHE_off_disables_cache": true }
}
```

**Impact** An operator following the tool's own advice sets an unrecognized variable, gets no cache change, and (in strict mode) a startup failure; the suggestion machinery exists precisely to prevent this.

**Fix** Print `POLESTAR_CACHE=off`; update the test. **Effort** S. **Fix risk** Very low.

**Regression test** Assert the message names `POLESTAR_CACHE`, and assert `unknownEnvVariables({POLESTAR_CACHE_DISABLED:'1'})` is non-empty (it already is) so a renamed variable is caught.

---

## C17 (Low), Negative-price plans omit `totalCost`

**File:line** `src/planner.ts:147`: `...(totalCost > 0 ? { totalCost: … } : {})`.

**Probe** case B in `out/probe-planner.txt`
```json
"B_negative_prices": {
  "feasible": true, "steps": 3, "stepPrices": [-0.1,-0.1,-0.1],
  "totalCost": null, "sumPriceXEnergy": -2.4
}
```

**Impact** The advisor prints "Estimated cost" only when positive; when the cheapest hours pay the owner, the number that makes the plan attractive is missing (the tool `src/advisor-tools.ts:125` guards on `!== undefined`). Not wrong data, just an absent answer in the case the feature exists for.

**Fix** Emit `totalCost` whenever it is finite (`Number.isFinite(totalCost)`), including 0 and negatives; keep the rounding. **Effort** S. **Fix risk** Very low.

**Regression test** Negative-price curve → `typeof plan.totalCost === 'number' && plan.totalCost < 0`.

---

## C18 (Low), A corrupt future timestamp reports as fresh, and one summarizer throws

**File:line** `src/format.ts:99-106` (`formatAge` clamps to 0), `src/format.ts:207` (`new Date(...).toISOString()` on an unvalidated epoch), `src/domain-data.ts:159-163` (`epochSecondsMs` accepts any digit string and returns `Number(seconds) * 1000`).

**Probe**
```
node --import tsx analysis/correctness/probe-format.ts
```

**Observed output**
```json
{
  "corrupt_timestamp": { "epochSecondsMs": 1e+23, "observedAtMs": 1e+23, "formatAgeOfIt": "0s ago",
    "note": "a timestamp 3e12 years in the future reports as fresh" },
  "corrupt_timestamp_summarizer": { "summarizeError": "RangeError: Invalid time value" },
  "latent_nan_and_infinity": { "pct_NaN": "NaN%", "distance_Infinity_mi": "Infinity km (Infinity mi)",
    "fromKm_NaN_mi": "NaN mi", "km_Infinity_mi": "∞ mi", "formatAge_NaN": "NaN d ago" }
}
```

The pre-cleaning summarizer (`src/format.ts:203-208`) turns a bad `lastCycleCompleted.seconds` into a thrown `RangeError`, which the tool layer normalizes to `INTERNAL_ERROR` (`src/failure.ts:108`). `formatAge` says "0s ago" for a wildly future epoch instead of "freshness unknown", which is the opposite of conservative. The NaN/Infinity formatting itself is **latent**: every domain reader funnels through `asNumber` (`src/domain-data.ts:18`) which drops non-finite values, so only a future caller/computed value would surface it.

**Fix** Validate the converted epoch: `Number.isFinite(ms) && Math.abs(ms) < 8.64e15`, else `undefined`; make the pre-cleaning line say "timestamp unusable"; make `formatAge` treat a negative age as unknown. Optionally have `formatAge`/`pct` render "n/a" for non-finite input.

**Effort** S. **Fix risk** Low. **Regression test** `observedAtMs({timestamp:{seconds:'1e400'}})` → undefined; `summarizeDomain('pre-cleaning', {lastCycleCompleted:{seconds:'99999999999999999999'}})` does not throw; `formatAge(Infinity, now)` is not "0s ago".

---

## C19 (Low), "Rolling UTC day" is a fixed UTC-midnight window

**File:line** `src/budget.ts:28` comment and `docs/architecture.md:119` say "rolling UTC day window"; `dayStart = floor(t/DAY_MS)*DAY_MS` (`src/budget.ts:75-77`) is a calendar-day window that resets at 00:00 UTC (which `docs/getting-started.md:164` correctly calls "the midnight UTC reset").

**Probe**
```
node --import tsx analysis/correctness/probe-budget-window.ts
```
```json
"boundary": {
  "at_23_59_59": { "used": 2, "resetsAtUtc": "2026-01-02T00:00:00.000Z" },
  "at_00_00_00": { "used": 0, "resetsAtUtc": "2026-01-03T00:00:00.000Z" },
  "note": "the whole budget resets at the UTC midnight instant; a rolling 24h window would not" },
"backward_clock": { "used_after_roll": 0, "used_after_backward_step": 1,
  "note": "dayStart < windowStart so no re-roll: the post-midnight call is metered against the previous day window" }
```

The reset itself matches the API's daily allowance; only the word "rolling" is wrong (and a backward clock step after the roll leaves the meter anchored a day ahead, negligible in practice). Per AGENTS.md a comment describing behaviour nothing implements is a defect, so this is worth a one-line fix; do not change the window itself without evidence about the API's reset rule.

**Fix** Say "calendar day (UTC), resets at 00:00Z" in the comment and docs. **Effort** S. **Fix risk** None.

---

# Probed and found clean (hypotheses refuted)

Each item below was exercised; the code behaves as documented. Evidence is in `analysis/correctness/out/`.

1. **Cache single-flight and TTL boundary**, three concurrent misses for one URL → **1** live call (`refreshes: 1`); at exactly `fetchedAt+ttl` the entry is stale (2nd live call) and 1 ms inside is a hit; two different VINs never share an entry; a stale serve plus a concurrent joiner produce exactly one refresh. Output: `out/probe-cache-clean.txt`.
2. **Token single-flight under load**, three concurrent requests all sent `Bearer tok-1` from one token POST (`out/probe-auth-invalidate-race.txt`, first three authorizations); cached reuse and the expiry-minus-skew refetch are covered by `test/auth.test.ts:29-68`. `invalidate()` during an in-flight request leaves that promise alone by design, and the resolved token is fresh.
3. **`Retry-After` integer form and per-attempt budget**, `"30"` → 30 000 ms wait (`out/probe-retry-after.txt`); cache-on probe shows 1 token POST + 3 GET attempts all metered (`used: 4`, `out/probe-cache-off-budget.txt`), matching `test/runtime.test.ts:86-104`.
4. **UTC-midnight budget rollover**, 2 calls at 23:59:59, snapshot at 00:00:00 → `used: 0`, reset pushed one day (`out/probe-budget-window.txt`).
5. **Torn JSONL line**, a truncated last line is skipped on read; the earlier records survive (`readableRecords: 3`, `out/probe-history.txt`). Restart dedupe by `metaEventId` is covered by `test/runtime.test.ts:703-720`.
6. **400/500 responses are not cached; POSTs bypass the cache**, `test/runtime.test.ts:201-212` and the `disabled`-mode test; the only gap found is the semantic 404 (C9).
7. **Planner midnight wrap**, a 23→06 window schedules 23:00 then 00:00 (the existing `test/planner.test.ts:107-122` passes; `probe/planner` case C only breaks for the >23 shape).
8. **Subscription bookkeeping**, `subscribe` primes the detector, an unchanged `metaEventId` does not notify, `unsubscribe`/`stop` clear the timer and map, and the 90% budget pause fires (`test/server-seams.test.ts:96-160`). A notify rejection and overlapping rounds are the two defects (C8).
9. **Sampler**, stand-down at the configured fraction (no calls issued), `stop()` prevents further rounds, cadence clamp and `describe()` match what runs (`test/runtime.test.ts:215-240, :883-933`). Timer drift (interval measured from round completion) is real but the docs say "every N seconds" loosely; not counted as a defect.
10. **401 retry is bounded to one per request**, `test/client.test.ts:218-238`; the cost/rate issue is C14, not an unbounded loop.
11. **NaN/Infinity formatting**, the format functions themselves print `NaN%`/`∞ mi`, but every domain value passes through `asNumber`/finite checks first, so it is unreachable from real payloads today; recorded as latent (C18).
12. **Identity checks**, `assertIdentity` refuses a response labelled for another VIN/domain, case-insensitively (`test/client.test.ts:307-370`). Note this cannot catch C1, because delegation changes identity, not VIN.

# Probed, unresolved / limitations (not claimed as defects)

- **Budget is per process, not persisted.** `buildEngine` constructs a fresh `BudgetMeter` at 0 (`src/server.ts:66`); restarting the server (MCP clients restart servers on config changes) restores the full daily allowance, so "10,000/day per credential" is really "per process incarnation". Docs never promise persistence, and fixing it needs a durable counter in the history dir; flagged as a high-risk gap if a host restarts frequently, not counted as a confirmed defect.
- **DST.** The planner receives a fixed `windowOffsetMinutes` from the car and cannot follow a DST transition; on the transition night the planned local hours can be an hour off. The payload carries no IANA zone, so this is a documented data limitation, not a code bug, but the assumption list should say it.
- **History growth.** There is no prune path: past 64 MB every history tool throws "prune it before querying" and an operator must delete files by hand; `Math.max` crashes earlier (C12). The store is operator-managed by design; a `prune` tool/script is missing, worth considering.
- **Stale entries are not "marked stale" as the comments say.** `src/caching-transport.ts:50-51` and `README.md:156` promise a marker; the stale response is returned byte-identical with no flag (`out/probe-cache-clean.txt`, `staleBody: "old"`). The only signal is payload age, and when the payload carries no timestamp the caller sees "freshness unknown". Behaviour is defensible; the comment overclaims.
- **`HTTP_401` from a non-JSON 401 body** loses the `UNAUTHORIZED` hint (`out/probe-error-hints.txt`: `"code": "HTTP_401"` → generic hint). Only reachable for non-conforming bodies; a table keyed by status class would fix it.
- **`forDelegation` returns `this` when the requested account equals the configured one**, so a caller cannot force a "no delegation" read when `POLESTAR_DELEGATED_ACCOUNT_ID` is configured. Arguably intended (the configured account is the server's identity); noted, not counted.

# Tests that assert the wrong thing

1. `test/server-seams.test.ts:251` pins `POLESTAR_CACHE_DISABLED`, a variable that does not exist (C16).
2. `test/planner.test.ts:125-142` is titled "planner falls back to cheapest individual hours when the window is too short" but the scenario (0.9 h needed, 3 h/day window) takes the **contiguous** path; the assertion `reason !== undefined || steps.length > 0` is satisfied by any successful plan. Probe D (`out/probe-planner.txt`): `"reason": null, "steps": 1, "fellBackToIndividualHours": false, "testAssertionWouldPass": true`. The real fallback path is exercised by C4's probe.
3. `test/charge-model.test.ts:68-84` asserts `19.2` kW is the correct figure for 16 A × 400 V × 3 phases and `:84` calls it "the reported voltage must be used"; 19.2 kW is 1.73× what 3-phase 400 V can deliver (C3).
4. `test/runtime.test.ts:629-658` / `:660-711` assert delegation is honoured using hand-built fake clients that never construct `CachingTransport`; they cannot observe C1, so the suite's delegation story is only true of the client layer.
5. `test/runtime.test.ts:689` selects tools with `'vin' in argsOf(spec)`, which structurally excludes `list_vehicles` from the "every tool that reads a car takes a delegation" rule (C10).
6. `test/runtime.test.ts:201-212` ("error responses are not cached") treats all non-2xx alike and implicitly pins the absence of negative caching for `DATA_NOT_AVAILABLE` (C9).

# Top 5 fixes by risk × effort

Ranked by (risk removed) ÷ (effort). All are S–M.

1. **C2, keep the retry/budget wrapper independent of `POLESTAR_CACHE`** (`src/server.ts:78-79`). Effort S, removes the largest safety hole: an operator can currently disable the 10k/day fail-closed guard with a cache flag. Add the `buildEngine` regression test.
2. **C1, make the cache key identity-scoped** (`src/caching-transport.ts:83` + `src/client.ts:87`). Effort M, removes cross-account vehicle-list/payload leaks and the wrong-default-VIN bug. Key on `x-client-id` + `x-delegated-account-id` + URL; test owner-then-partner.
3. **C7 + C10 + C16, fix the three small-surface lies** (403 hint, `list_vehicles` delegation, `POLESTAR_CACHE` name) (`src/vehicle-read.ts:229`, `src/domain-tools.ts:19`, `src/system-tools.ts:54`). Effort S each; all are operator-facing misdirection in a security-sensitive area.
4. **C3, settle the volts convention in `chargeModel`** (`src/charge-model.ts:53`) and correct the test. Effort S/M; the charging estimate and the plan are both 1.73× optimistic whenever a car reports 400 V.
5. **C4 + C5 + C6, repair the planner's window expansion and feasibility reporting** (`src/planner.ts:70-73,112-138`). Effort M: normalize >23 stop hours, check contiguity in time, and return infeasible (with the shortfall) instead of a plan that silently under-delivers.

Close behind: C8 (subscription notify ordering + poll guard) and C9 (negative caching of `DATA_NOT_AVAILABLE`), both S and both remove a silent-failure budget/subscription behaviour.
