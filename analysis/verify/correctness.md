# Lane E: analytics correctness, honesty rules, documentation claims, performance

Verification of `polestar-mcp` at `098b8c3` (branch `master`). Every check below is offline:
fixture mode (`POLESTAR_FIXTURES_DIR=test/fixtures/dump`), synthetic JSONL history stores written
under `/tmp`, and direct imports of the TypeScript modules. The live Polestar API was never
contacted, and no raw VIN appears in this report: the fixture VIN is written as `VIN_MASKED`
where a command or output would otherwise print it.

Working-tree note: `git status` was clean for `src/`, `test/` and `scripts/` during this lane.
Another lane concurrently edited tracked docs (`README.md`, `docs/architecture.md`,
`docs/bundle.md`, `docs/development.md`, `docs/reviewer-pack.md`, `docs/tools-reference.md`).
This report audits the audited commit for claims, and records which findings that concurrent
edit already corrected. This lane changed no tracked file; the only write is this report.

## Verdict

| Area | Checks | Pass | Fail |
| --- | --- | --- | --- |
| Charge model and planner hand checks | 37 | 37 | 0 |
| History analytics, pure functions (store, sessions, degradation, cost ledger, odometer, trips, timeline, digest) | 63 | 63 | 0 |
| History tools end to end over stdio with synthetic stores | 38 | 38 | 0 |
| Honesty and refusal paths | 18 | 17 | 1 |
| Degradation gate edge cases (usable samples, 8 points, 90 days) | 4 | 4 | 0 |
| Documentation claims (probed, current working tree) | 47 | 47 | 0 |
| Protocol eras (repo test `test/modern-protocol.test.ts`) | 3 | 3 | 0 |
| **Probe totals** | **210** | **209** | **1** |

Eight defects are recorded in the defect register: the one probe failure above, plus seven
documentation or code-comment claims that a probe or a source read contradicts. Six additional
stale claims existed at the audited commit and were corrected in the working tree by the
concurrent docs lane while this lane was measuring; they are listed separately so they are not
re-reported as open.

No correctness defect was found in the charge arithmetic, the planner, the history math, the
cost ledger, the trip/timeline/digest composition, or the privacy and absence behaviour. The
findings are documentation drift and one comment that promises an envelope field the domain tool
path does not emit.

## Method and evidence

Probes are in `/tmp/laneE/` for this run (temporary, not committed):

| Probe | What it covers |
| --- | --- |
| `/tmp/laneE/probe-charge.mjs` | charge model arithmetic and planner edge cases, imported from [charge-model.ts](../../src/charge-model.ts) and [planner.ts](../../src/planner.ts) |
| `/tmp/laneE/probe-history-pure.mjs` | store dedup and prune, session extraction, OLS, capacity chain, cost ledger, odometer rate, trips, timeline, digest, imported from the modules directly |
| `/tmp/laneE/probe-tools.mjs` | the ten history tools over stdio with synthetic JSONL stores, through [stdio-client.ts](../../scripts/stdio-client.ts) |
| `/tmp/laneE/probe-honesty.mjs` | crafted fixture copies under `/tmp` for absent domains, unknown lock data, VIN mismatch and ambiguity |
| `/tmp/laneE/probe-docs.mjs` | registry, `tools/list`, resource templates, prompts, README and docs count claims |
| `/tmp/laneE/probe-degradation-gates.mjs` | the 5-sample, 8-point and 90-day gates through the real tool |
| `/tmp/laneE/probe-perf.mjs` | startup, latency, payload bytes, HTTP cap, concurrency, RSS, per-request surface rebuild |
| `/tmp/laneE/probe-message.mjs`, `/tmp/laneE/probe-message2.mjs` | success versus failure structured envelopes |

Each probe is a standalone script run with `node --import tsx <path>` from the repository root.
Synthetic stores use the documented layout `<root>/<VIN>/<kind>-<name>.jsonl` with records of the
shape `{observedAt, valueObservedAt?, metaEventId?, data}` read by [history.ts](../../src/history.ts).

## Area 1: history analytics

### Store, dedup and prune

| Check | Command | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| same `metaEventId` twice | `probe-history-pure.mjs` | one line stored | one record | PASS |
| new `metaEventId` | same | appended | two records | PASS |
| dedup across a restart | new `HistoryStore` on the same directory | tail ID seeds the map | still two records | PASS |
| older ID re-served after a different ID | same | appended again (documented limitation) | three records | PASS |
| `sinceMs` / `untilMs` / `limit` / newest-first / chronological | same | filters and order as named | matched | PASS |
| append bound | store with `maxFileBytes=300`, 30 appends | file pruned to newest half, newest record kept | 300 to 400 bytes, newest SoC 29 present | PASS |
| 64 MiB read guard | sparse file of `64 MiB + 1` bytes | query throws naming the size limit | threw `larger than 67108864 bytes` | PASS |

### Degradation report

| Check | Command | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| fewer than 5 battery samples | `probe-tools.mjs` scenario s2a, 4 samples | refusal naming the count | `Only 4 battery sample(s) recorded, need at least 5.` | PASS |
| 5 samples over 3 days | s2b | series, not estimate, names the 7-day need | `a trend needs at least 7 days of history` | PASS |
| 12 samples over 100 days, 8+ range points, 3+ SoC levels | s2c | slope line and 95% interval | `Implied full-charge range trend: ... 95% interval ... 12 points over 100 days` | PASS |
| OLS slope against hand computation | s2c recomputes the same x/y in the probe from the recorded values and applies the OLS formula | reported monthly slope within 0.11 of hand value | matched | PASS |
| 95% interval against hand computation | same, with the module's integer rounding of implied range (`Math.round(range/SoC*100)`) | reported endpoints within 0.11 | matched | PASS |
| exactly 8 points over 90 days | `probe-degradation-gates.mjs` | interval trend appears | `... 8 points over 90 days` | PASS |
| 8 points over 60 days | same | interval not claimed | `needs at least 90 days of history` | PASS |
| 2 distinct SoC levels over 90+ days | s2d | asks for 3 distinct levels | `3 or more distinct charge levels` | PASS |
| confounders | s2c | temperature, speed, wheels, model change, outlier, no SoH claim | all named | PASS |
| usable-sample wording | `probe-degradation-gates.mjs`, 5 raw samples of which 2 carry range/energy | see defect D8 | tool reports `2 usable samples`, no 5-usable refusal | FAIL (docs, D8) |

Hand computation used for the OLS and interval: the probe recomputes `meanX`, `meanY`, `sxx`,
`sxy`, the residual standard error and `t(0.975, n-2)` from the same numbers the store holds,
then compares to one decimal against the rendered line. A second exact-line series (8 points,
90 days, slope `-0.1` per day) gives a zero-width interval and excludes zero, which the module
reports as `-3.0` km/month.

### Charging sessions

| Check | Command | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| start, end, span over two charging samples | `probe-tools.mjs` scenario s3 | start, last seen, 10 min span, 2 samples | `2026-06-01T00:00:00.000Z ... span 10 min over 2 samples (gaps included)` | PASS |
| peak power | same | `peak 7.0 kW` | `peak 7.0 kW` | PASS |
| missing power | second session, no power reported | unknown, not 0 kW | `peak unknown, the car reported no charging power` | PASS |
| gap over 30 minutes splits a session | `probe-history-pure.mjs`, samples 31 minutes apart | two single-sample sessions | two sessions, `activeSeconds` 0 | PASS |
| one-sample session | same | no invented span | `sampleCount 1`, `activeSeconds 0`; the tool says `single sample, no span observed` | PASS |
| `CHARGING_STATUS_V2_IDLE` is not charging | same | no session | no session | PASS |

### Charging cost

| Check | Command | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| capacity from `dischargeInfo.energyAvailable` | `probe-history-pure.mjs`, 31.2 kWh at 40 percent | 78 kWh, source named | 78 kWh, `dischargeInfo.energyAvailable` | PASS |
| SoC-delta energy | 40 to 60 percent at 78 kWh over 10 minutes | 15.6 kWh at the battery | 15.6 kWh, source `soc-delta` | PASS |
| grid energy and cost | same, 90 percent efficiency, price 0.4 per kWh | 17.333 kWh grid, 6.933 cost | 17.333 kWh, 6.933 | PASS |
| session straddling an hour with one hour priced | session 00:45 to 01:05, price only for 00:00 | priced 13.0, unpriced 4.333, cost 5.2, unpriced named | matched, `missing` names the unpriced energy | PASS |
| negative price | price -0.5 | negative cost kept | -8.666 | PASS |
| zero price | price 0 | cost present and zero | cost 0, priced energy positive | PASS |
| no prices supplied | empty price list | no total cost, unpriced energy named | `totalCost` absent, `sessionsWithoutPrice` 1 | PASS |
| session with no energy estimate | samples without delta or power | counted, not costed | `sessionsWithoutEnergy` 1, no cost | PASS |
| hour-boundary split | `splitSessionCost` over two hours with prices 1 and 2 | halves at 10 kWh each, cost 30 | matched | PASS |
| boundary lookup | `priceAt` at an hour boundary | undefined outside the containing hour | matched | PASS |

### Trips, timeline, digest, warnings, settings, service

| Check | Command | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| gap over 24 hours | `probe-tools.mjs` scenario s5 | named, distance included | `unobserved gap(s) longer than 24 h` | PASS |
| odometer reset | same | reported, no negative distance | `odometer reset(s); the interval contributes no distance` | PASS |
| fewer than 3 readings | `probe-history-pure.mjs` | refused with the count | `only 2 odometer samples are recorded ...` | PASS |
| unchanged reading splits a trip | same | two movement spans | two trips, 20000 m total | PASS |
| timeline window | `probe-tools.mjs`, 48 h | window in the header, newest first | matched | PASS |
| location excluded | `POLESTAR_ALLOW_LOCATION=0` | excluded and not rendered | `Excluded: location`, no position row | PASS |
| empty timeline | `probe-history-pure.mjs` | nothing observed, not nothing happened | `No history records ... That means nothing was observed, not that nothing happened` | PASS |
| empty weekly digest | `probe-tools.mjs` | week not observed rather than quiet | `No history was recorded in this window, so the week was not observed rather than quiet.` | PASS |
| sparse digest | `probe-history-pure.mjs`, 1 record | sparse named | `Sparse record: only 1 sample(s) in the window` | PASS |
| digest per-item not observed | same, empty store | digest stops at the not-observed sentence without inventing item lines | header plus the sentence plus the sampling line | PASS |
| warnings appeared and cleared | `probe-tools.mjs` scenario s4 | both transitions named | `appeared: brake fluid`, `cleared: brake fluid` | PASS |
| unobserved caveat | same | periods between samples unobserved | `a quiet answer means not observed, not absent` | PASS |
| settings value clock | s4, `valueObservedAt` one day before `observedAt` | lines dated by the value clock | `2026-06-02T00:00:00.000Z`, `2026-06-03T00:00:00.000Z` | PASS |
| pending amp limit | s4 | unconfirmed change named | `pending: change to 10 A is recorded but the car has not confirmed it` | PASS |
| read clock caveat | s4, target-soc record without a value clock | caveat counted | `predate the vehicle clock` | PASS |
| service forecast | s4, 298 days and 14600 km at 5.0 km/day | rate, and which limit first | `Odometer rate: 5.0 km/day`, `limit arrives first` | PASS |
| thin odometer history | s4 with `days: 1` | named thin, countdown not a forecast | `too thin for a rate` | PASS |

### get_history paging and validation

| Check | Command | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| default order | `probe-tools.mjs` scenario s1 | newest first | newest record first | PASS |
| `limit` plus paging hint | limit 2 of 6 | two rows and a hint | `pass offset=2 or before=...` | PASS |
| `offset` | offset 2 | older page only | matched | PASS |
| `before` | ISO timestamp of the third record | exclusive cutoff | matched | PASS |
| invalid `before` | `not-a-date` | `INVALID_BEFORE` | `INVALID_BEFORE` | PASS |
| unknown domain name | `telemetry/nope` | `UNKNOWN_DOMAIN` naming `list_domains` | matched | PASS |
| domain without a kind | `telemetry` | `UNKNOWN_DOMAIN` | matched | PASS |
| `hours` window | 200-day window over June records | all six | six rows | PASS |

## Area 2: charge model and planner

| Check | Command | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| 16 A at reported 400 V, 3 phases | `probe-charge.mjs` | `sqrt(3) x 400 x 16 = 11.085 kW` | 11.085 kW | PASS |
| that convention is stated | same | line-to-line wording | `the reported 400 V is treated as line-to-line` | PASS |
| 16 A, no reported volts, 3 phases | same | `16 x 230 x 3 = 11.04 kW` | 11.04 kW | PASS |
| 16 A at 230 V, 1 phase | same | 3.68 kW | 3.68 kW | PASS |
| live power wins | same | 7.4 kW | 7.4 kW | PASS |
| default AC efficiency | same | 0.9 | 0.9 | PASS |
| energy and grid energy to target | 39 kWh available at 50 percent, target 100 | 78 kWh capacity, 39 kWh battery, 43.333 kWh grid | matched | PASS |
| capacity fallback, range times consumption | no usable energy, 300 km and 20 kWh/100 km at 50 percent | 120 kWh, source named | 120 kWh, `estimatedDistanceToEmptyKm ...` | PASS |
| car-reported range beats caller capacity | both supplied | range estimate wins | 120 kWh | PASS |
| caller capacity used last | only caller supplied | 82 kWh, source named | matched | PASS |
| implausible capacity | 4 kWh at 50 percent implies 8 kWh | refused as outside 10 to 300 kWh | `outside the 10 to 300 kWh plausibility range` | PASS |
| invalid SoC, target, phases, efficiency | 120 percent, -1, 4 phases, 0 or 1.5 efficiency | each named as a problem | all four named | PASS |
| target below current SoC | 80 to 50 percent | zero energy and an assumption | `there is no energy to add` | PASS |
| planner 56 kWh need, 2 slots | 80 kWh pack, 30 to 100 percent, 11.0851 kW, window 22:00 to 23:00 (one slot per night over the 48 h horizon) | infeasible, shortfall stated | `delivering at most 22.17 kWh of the 56 kWh needed. Shortfall 33.83 kWh` | PASS |
| hour normalization | window 28 to 30 | read as 04:00 to 06:00 | matched, assumption stated | PASS |
| whole-hour flooring | plan at 20:00:55 | first step starts 22:00:00 | `2026-09-18T22:00:00.000Z` to `23:00:00.000Z` | PASS |
| window wraps midnight | 22:00 to 06:00 | 8 slots, feasible | feasible over 8 slots | PASS |
| negative prices | -0.1 and -0.2 in the window | negative total kept | -1.778 | PASS |
| zero price | 0 for the chosen hours | total cost present and zero | 0 | PASS |
| unpriced scheduled hours | only one hour priced | refused, not costed at zero | `Price data does not cover the scheduled hours` | PASS |
| stale price curve | prices from the previous day | refused as not covering the scheduled hours | same refusal | PASS |
| non-finite price | `NaN` price and a bad `startsAt` | ignored and named | `unparseable startsAt or a non-finite price and were ignored` | PASS |
| capacity, power, SoC validation | 0 kWh, 0 kW, 101 percent | each refused with a reason | matched | PASS |
| target already reached | 90 to 80 percent | feasible with nothing to charge | matched | PASS |

Observation, not a defect: the planner scans a 48-hour horizon, so a two-clock-hour window is
four slots over two nights. The shortfall sentence states the slot count it used, so the answer
is honest; the 2-slot scenario in the brief requires a one-clock-hour window.

## Area 3: honesty and refusal paths

| Check | Command | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| absent domain, domain tool | `probe-honesty.mjs`, exterior fixture replaced with a `DATA_NOT_AVAILABLE` envelope | `No exterior data is available ...` | matched exactly | PASS |
| absent domain, absence code | same | see D1: the code comment claims the envelope carries the code | domain tool envelope is `{ok, vin, tool, data:{reported:false}}`, no `code`; aggregates do carry it | FAIL (D1) |
| absent exterior, security verdict | same | unknown, never a yes or a no | `Unknown, not reported: ...`, `neither reported secure nor reported insecure` | PASS |
| absent exterior, structured verdict | same | never `secure: true` | `secure` absent, `reported: false` | PASS |
| locks unreported, exterior present | fixture with `centralLock`, `tailgateLock`, `alarm` removed | unknown, not secure | `Unknown, not reported: ... The answer is not a no.` and `secure: null` | PASS |
| absent health, needs attention | health replaced with `DATA_NOT_AVAILABLE` | unknown, not "nothing needs attention" | `Unknown, not reported: ...` and no `Nothing needs attention` | PASS |
| aggregate names every unreported domain | exterior and health both absent | both named | `Not reported: exterior, health (the API returned DATA_NOT_AVAILABLE; absence is not a negative).` | PASS |
| aggregate oldest age | same | per-domain ages and the oldest | `Domain ages: ... battery 52 d ago ...`, `Oldest: target-soc (52 d ago)` | PASS |
| aggregate structured unreported list | same | both names | `["exterior","health"]` | PASS |
| seven charging settings | `get_charging_setup` | seven setting rows | seven rows, including the unsupported is-at-charge-location | PASS |
| unsupported setting wording | same | normal absence, not failure | `unsupported on this vehicle ... this is not a failure` | PASS |
| missing fixture route | battery fixture removed | `NOT_FOUND`, not the absence sentence | `NOT_FOUND`, no absence sentence | PASS |
| VIN mismatch | battery payload labelled a different VIN | refused, payload not shown | `VIN_MISMATCH`, no `Charge: 52%` | PASS |
| ambiguous credential, declined | two VINs, no `vin`, elicitation declined | refused with an actionable code | `VIN_NOT_CHOSEN` or `AMBIGUOUS_VIN` | PASS |
| ambiguous credential, accepted | elicitation accepts the fixture VIN | reads that car | `Charge: 52%` | PASS |
| success envelope has no message | `get_battery` | no `structuredContent.message` | absent | PASS |
| failure envelope message differs from text | `get_history` with an unknown domain | `message` present and different | present, differs | PASS |
| every tool read-only | `tools/list` in both modes | `readOnlyHint: true` | all 26 and all 36 | PASS |

## Area 4: documentation and README claims

All 47 automated claim checks pass on the current working tree, after the concurrent docs lane
corrected the prompt-count claims listed under "Corrected at the audited commit" below. The
manual checks that still fail are the defect register entries D2 to D8.

| Claim (source) | Check | Expected | Observed | Verdict |
| --- | --- | --- | --- | --- |
| 15 domains, 8 telemetry + 7 charging | registry import | 15, 8, 7 | 15, 8, 7 | PASS |
| TTL table: 30 s fast, 60 s minute, 5 min settings, 10 min slow, 30 min rare, 1 h vehicle list | registry plus [domains.ts](../../src/domains.ts) | table matches | every domain row matches; vehicle list uses the hour TTL | PASS |
| 26 tools on every start | `tools/list` | 26 | 26 | PASS |
| 36 tools with history | `tools/list` with a history dir | 36 | 36, and exactly the ten documented history tools join | PASS |
| every tool carries `readOnlyHint` | both `tools/list` results | all | all | PASS |
| every tool has an `outputSchema` | both `tools/list` results | all | all | PASS |
| 26 equals 15 domain + 3 discovery + 5 aggregate + 2 advisor + 1 system | names in `tools/list` | composition matches | matched | PASS |
| two resource templates | `resources/templates/list` | 2 | 2 | PASS |
| prompts: two on a default start, third with history | `prompts/list` in both modes | `car-status`, `charge-plan`, plus `battery-health-report` | matched | PASS |
| 29 configuration variables | README table rows plus `node docs/check-docs.mjs envvars` | 29 rows, gate `variables=29 docs=3` | matched | PASS |
| `docs/check-docs.mjs tools` | repo gate | `tools=36 domains=15` | `DOCS_TOOLS_OK tools=36 domains=15` | PASS |
| `docs/check-docs.mjs envvars` | repo gate | all variables documented | `DOCS_ENVVARS_OK variables=29 docs=3` | PASS |
| `docs/check-docs.mjs links` | repo gate | no broken link | `DOCS_LINKS_OK` | PASS |
| coverage floors 90 lines, 80 branches, 85 functions | `package.json` scripts and CONTRIBUTING | match | match | PASS |
| Node floor matrix 20.11, 22, 24 | `engines`, CI matrix, CONTRIBUTING | match | match | PASS |
| sampler stands down at 80 percent | [sampler.ts](../../src/sampler.ts) | `SAMPLER_BUDGET_GUARD = 0.8` | 0.8 | PASS |
| subscriptions pause at 90 percent | [subscriptions.ts](../../src/subscriptions.ts) | `isLow(0.9)` | matched | PASS |
| sampler default 600 s, clamped 60 to 3600 | config plus `intervalSeconds` | 600, 60, 3600 | matched | PASS |
| subscription poll once a minute | `subscriptions.ts` | 60 000 ms | 60 000 ms | PASS |
| retry up to three times | [retrying-transport.ts](../../src/retrying-transport.ts) | see D7 | `maxAttempts` is 3 attempts total, i.e. two retries | FAIL (D7) |
| token skew 5 minutes, one 401 retry | [auth.ts](../../src/auth.ts) | 300 000 ms, one retry | matched | PASS |
| both protocol eras, 2026-07-28 modern | `node --import tsx --test test/modern-protocol.test.ts` | 3 tests | 3 pass: discovery, envelope refusal, 2025 initialize on one listener | PASS |
| documented error codes exist | search of `src` | all named codes present | `DATA_NOT_AVAILABLE`, `VIN_MISMATCH`, `DOMAIN_MISMATCH`, `DELEGATION_NOT_ALLOWED`, `VALIDATION_RESOURCE_NOT_FOUND`, `AUTHZ_CLIENT_ID_MISMATCH`, `UNKNOWN_DOMAIN`, `INVALID_BEFORE`, `VIN_NOT_CHOSEN`, `AMBIGUOUS_VIN`, `NOT_FOUND` | PASS |
| every minted code has advice | `MintedCode` union typed into `MINTED_HINTS` | type-checked complete | `Record<MintedCode, string>` in [tool-output.ts](../../src/tool-output.ts) | PASS |
| successful results carry no `message` | `get_battery` | absent | absent | PASS |
| absence sentence wording | domain tool and docs/tools-reference | same sentence | identical | PASS |
| raw mode appends the payload | `get_battery` with `raw: true` | `Raw payload:` plus data | matched | PASS |
| 29,950 bytes for `tools/list` | CHANGELOG | scoped to the 23-tool surface | wording is explicitly scoped; current measurement is 34,723 at 26 tools and 50,420 at 36 | PASS (historical, not a current claim) |

The current `tools/list` measurements are the same numbers recorded in
[envelope.test.ts](../../test/envelope.test.ts): 34,723 bytes for the default surface and
50,420 with history. My independent measurement matched both exactly.

Corrected at the audited commit (stale at `098b8c3`, fixed in the working tree by the concurrent
docs lane; re-verify before merge, not open defects of this lane):

| Location at `098b8c3` | Stale claim | Current fact |
| --- | --- | --- |
| `README.md:155` | three ready-made conversations including `battery-health-report` on a default start | two on a default start, third with history |
| `docs/tools-reference.md:129` | three starter prompts | two, third with history |
| `docs/bundle.md:37` | three prompts appear | two, third with history |
| `docs/reviewer-pack.md:31,68` | three example prompts | two, third with history |
| `docs/architecture.md:18-21` | aggregates (4), advisor (1), history (3), listings (2), three prompts | 5, 2, 10, 3, two or three |
| `docs/reviewer-pack.md:65` | at least three working example prompts | at least two (three with history) |

## Area 5: performance

Measured on the verification host (Node 22.23.2, macOS). Commands: `/tmp/laneE/probe-perf.mjs`,
plus `node --import tsx --test test/modern-protocol.test.ts`.

| Check | Expected or documented | Observed | Verdict |
| --- | --- | --- | --- |
| startup to first `ready:` line, tsx source (5 runs) | not documented | 179 ms median, 169 to 192 ms range | PASS (measured) |
| startup to first `ready:` line, `build/server.js` | not documented | 96 ms | PASS (measured) |
| `tools/list` bytes, default surface | test comment records 34,723 | 34,723 over stdio, 34,757 as an HTTP JSON-RPC body (framing fields differ) | PASS |
| `tools/list` bytes, history surface | test comment records 50,420 | 50,420 | PASS |
| fixture-mode call latency, stdio, warm (120 calls) | not documented | 0.34 ms median, 0.73 ms p95 | PASS (measured) |
| 4 MiB request cap | README-adjacent code comment and `test/server-seams.test.ts`; cap is `MAX_HTTP_REQUEST_BYTES` in [server.ts](../../src/server.ts) | body of 4,194,404 bytes answered `HTTP 413` with `Payload Too Large: one request body must not exceed 4194304`; a normal request after it still returns 26 tools | PASS |
| 50 concurrent HTTP calls | no documented target | 50 of 50 succeeded in 66 ms wall; per-call 57.0 ms median, 63.4 ms p95 under full concurrency | PASS |
| RSS, stdio default after warm calls | not documented | 121 MB | PASS (measured) |
| RSS, stdio with history after warm calls | not documented | 106 MB | PASS (measured) |
| RSS, HTTP after a 50-call load | not documented | 142 MB | PASS (measured) |
| per-request surface rebuild | source comment claims `createMcpServer` median 0.19 ms, p95 1.10 ms | 0.206 ms median, 0.677 ms p95 over 200 runs | PASS (claim holds; median 8 percent above the comment, p95 below it) |

No tracked documentation makes a current startup, latency or RSS claim, so those rows are
measurements rather than claim audits. The 29,950-byte figure exists only in the CHANGELOG and is
explicitly scoped to the older 23-tool surface; the only current byte figures are in the test
comment, and both matched.

## Defect register

Severities: Low for documentation drift and comment-only claims; Medium would be required if a
consumer or an operator could act wrongly on the claim. None of these change a numeric answer.

### D1 (Low): the absence envelope comment promises a code the domain tool path drops

Claim: [vehicle-read.ts](../../src/vehicle-read.ts) lines 193 to 195 state that absence is
carried in the envelope as `data.reported: false` and the `DATA_NOT_AVAILABLE` code. The helper
`withAbsenceEnvelope` does set both, and the aggregate tools expose the code, but the domain tool
path calls `readDomain` (line 311 of the same file), which keeps only the sentence from `noData`
and lets `readDomainFormatted` rebuild `structuredContent` without `code`.

Repro: copy `test/fixtures/dump` to `/tmp`, replace `dataportal/telemetry/exterior.json` with a
`DATA_NOT_AVAILABLE` error envelope, run the server with `POLESTAR_FIXTURES_DIR` pointing at the
copy, call `get_exterior`, and inspect `structuredContent`. Expected per the comment,
`{ok, code: 'DATA_NOT_AVAILABLE', data: {reported: false}}`; observed,
`{ok, vin, tool, data: {reported: false}}`. Calling `is_car_secure` with the same fixture shows
the code, so the two surfaces disagree. This is the house-rule case of a comment describing
protection nothing applies. Fix is either to carry the code through `readDomain` or to narrow
the comment.

### D2 (Low): architecture prose still says four aggregates and one advisor

[docs/architecture.md](../../docs/architecture.md) line 7 says "four aggregate tools and one
advisor that reuse the same data". The registry at [aggregate-tools.ts](../../src/aggregate-tools.ts)
registers five (`get_car_status`, `is_car_secure`, `get_needs_attention`,
`get_charging_estimate`, `get_charging_setup`) and [advisor-tools.ts](../../src/advisor-tools.ts)
registers two (`plan_cheapest_charge`, `get_departure_readiness`). The concurrent docs lane fixed
the ASCII diagram in the same file but not this sentence.

Repro: `grep -n "four aggregate tools and one advisor" docs/architecture.md` and compare with
`node --import tsx /tmp/laneE/probe-docs.mjs` (26 equals 15 + 3 + 5 + 2 + 1).

### D3 (Low): architecture says four aggregates and five domains for get_car_status

[docs/architecture.md](../../docs/architecture.md) line 86 says "The four aggregate tools" and
"`get_car_status` reads five domains in parallel". There are five aggregates, and
`get_car_status` reads six domains: the `STATUS_READS` map and the destructure at
[aggregate-tools.ts](../../src/aggregate-tools.ts) lines 190 and 280 cover battery, exterior,
availability, odometer, health and target-soc.

Repro: `grep -n "reads five domains" docs/architecture.md`; the tool description itself says
"plus ... target charge level" and the reported "Domain ages" line lists six domains when all
are present.

### D4 (Low): architecture says three history tools

[docs/architecture.md](../../docs/architecture.md) line 92 says "The three history tools ride on
top". History registers ten: seven in [history-tools.ts](../../src/history-tools.ts) and three in
[extra-history-tools.ts](../../src/extra-history-tools.ts). The following sentences describe only
the first three.

Repro: `grep -n "three history tools" docs/architecture.md`; `tools/list` with a history
directory returns 36 tools and the ten names listed in Area 4.

### D5 (Low): tool reference says get_car_status reads five domains

[docs/tools-reference.md](../../docs/tools-reference.md) line 93 says "the newest data age across
the five domains it reads" and "instead of five separate `get_*` calls". The tool reads six
domains (same evidence as D3).

Repro: `grep -n "five domains it reads" docs/tools-reference.md`.

### D6 (Low): the v0.3.0 release note describes a smaller surface than the code ships

[docs/releases/v0.3.0.md](../../docs/releases/v0.3.0.md) lines 37 to 42 say "Twenty-six tools,
all reads", then enumerate `list_vehicles` and `list_domains` first, fifteen domain tools, "four
aggregates (`get_car_status`, `is_car_secure`, `get_needs_attention`,
`get_charging_estimate`)", `plan_cheapest_charge` and `polestar_status`, and close with "Three
history tools join". That composition is 23 tools, not 26: `list_vehicle_domains`,
`get_charging_setup` and `get_departure_readiness` are missing, and history adds ten tools, not
three. `package.json` version is 0.3.0 and `scripts/check-version.mjs` treats
`docs/releases/v0.3.0.md` as the note for that version, so the released note does not describe
the shipped surface. CHANGELOG's Unreleased section does list the additions.

Repro: `grep -n "four aggregates\|Three history tools\|Twenty-six tools" docs/releases/v0.3.0.md`
and compare with the Area 4 composition check.

### D7 (Low): "retried up to three times" means two retries in code

[README.md](../../README.md) line 174 and
[docs/upstream-api.md](../../docs/upstream-api.md) line 107 say transient 429 and 502/503
responses are "retried up to three times". [retrying-transport.ts](../../src/retrying-transport.ts)
defaults `maxAttempts` to 3 and loops `attempt` from 1 through `maxAttempts`, returning on the
last attempt instead of retrying again, so the transport makes at most three attempts total and
two retries. A test comment in [transport-hardening.test.ts](../../test/transport-hardening.test.ts)
confirms the semantics: one 500 costs two attempts.

Repro: `grep -n "maxAttempts" src/retrying-transport.ts` and
`grep -n "retried up to three times" README.md docs/upstream-api.md`. Fix is wording: "up to
three attempts" or "up to twice".

### D8 (Low): the degradation "5 usable samples" claim is enforced on raw samples

[docs/tools-reference.md](../../docs/tools-reference.md) line 113 says the report "Needs at least
5 usable samples". [history-tools.ts](../../src/history-tools.ts) line 292 refuses on
`battery samples` (`samples.length < 5`), and only checks that usable points are not zero; with
more than zero points the report proceeds. A store with 5 raw samples where 2 carry a range or a
usable energy reports "2 usable samples from ..." and a series, not a 5-usable refusal.

Repro: `/tmp/laneE/probe-degradation-gates.mjs` case 1. Expected per docs, a refusal below five
usable samples; observed, a series built from 2 usable points.

## Limitations

- Fixture mode and synthetic stores only. No live API call, so a live-only contract behaviour
  is out of scope for this lane.
- The synthetic store timestamps are chosen to hit the gates; they do not model a real car's
  sampling density.
- The 50-concurrent figure is one host and one warm process, not a load test.
- Performance numbers are single-host measurements; the startup figures include Node and tsx
  startup, which is why the built server is reported separately.
- The `src/vehicle-read.ts` finding is a claim-versus-behaviour mismatch. The documented consumer
  contract is `data.reported: false`, which the domain tools do emit, so no documented consumer
  breaks today.
