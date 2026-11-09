# E. Runtime surface and agent UX

Measured, not argued. Everything below was produced offline against
`test/fixtures/dump` with `POLESTAR_FIXTURES_DIR`, never with a live credential. The live capture
path (`npm run capture`) and `npm run smoke-http` were not run. Byte counts are UTF-8 bytes of the
compact JSON the server actually put on the wire, measured in memory before any evidence file was
escaped. Token figures use the repository's own estimate of 4 UTF-8 bytes per token
(`analysis/surface/capture.ts:27-28`) and are labelled as estimates. The fixture is synthetic and
its newest sample is 48 days old relative to the run date, so every humanized answer shows that
age; that is the fixture, not the server.

## What exists

### The checks, and one that fails on a clean checkout

| Command | Observed line | Reading |
| --- | --- | --- |
| `npm test` | `# tests 111`, `# pass 111`, `# fail 0` | The unit surface is green. |
| `npm run smoke` | `registry: 26 tools, 24 callable with no args` then `SMOKE_OK` | The real stdio surface works in fixture mode; 2 tools need arguments. |
| `npm run smoke-bin` | `BIN_SMOKE_OK --version, --help and the MCP handshake all work launched through the bin symlink` | The published launch path works. |
| `npm run demo-dump` | `DUMP_FAILED: expected captured dump at /Users/nicolaskheirallah/Documents/GitHub (dataportal/vehicles.json not found)`, exit 1 | Fails on this clean checkout. |
| `node docs/check-docs.mjs tools` | `DOCS_TOOLS_OK tools=26 domains=15` | Documented counts match the registry. |
| `node docs/check-docs.mjs envvars` | `DOCS_ENVVARS_OK` | Environment variables are documented. |
| `node docs/check-docs.mjs links` | `DOCS_LINKS_OK` | Local links resolve. |
| `node docs/check-docs.mjs hygiene` | em dash and buzzword detectors green, then `BANNER_CHECK_FAILED` on five files under `analysis/correctness/` that this task does not own | See the appendix; my own files pass that detector. |

`npm run demo-dump` is a genuine clean-checkout failure, not a fixture accident. `scripts/demo-dump.ts:14`
hardcodes the dump directory as the parent of the project (`path.resolve(PROJECT_ROOT, '..')`) and
`scripts/demo-dump.ts:16-19` refuses before it ever consults `POLESTAR_FIXTURES_DIR`, so setting the
environment variable to the shipped synthetic dump changes nothing. `README.md:56` presents the same
command in the offline quickstart as `runs the whole server in fixture mode, prints DUMP_OK`, while
`README.md:222` and `docs/development.md:93` say it needs the sibling captured dump. A reader acting
on the first claim gets exit 1.

Writing hygiene has a second gap worth recording: `src/domains.ts:256` embeds two em dashes as
`\u2014` escape sequences, so the source file is ASCII and `node docs/check-docs.mjs hygiene` cannot
see them, while the tool description that reaches the model at runtime does contain U+2014 twice.
Any raw capture of `tools/list` therefore fails the tree-wide em dash check even though `src/` is
green. I escaped non-ASCII in my evidence JSON so the check can read it; the raw text the model
receives still has the character.

### What a model pays before its first question

| Item | 23 tools (default) | 26 tools (history on) |
| --- | --- | --- |
| `initialize` result | 1,144 bytes | 1,144 bytes |
| Instructions | 882 bytes, 221 tokens, 141 words | same |
| `tools/list` result | 44,841 bytes, 11,210 tokens | 50,718 bytes, 12,680 tokens |
| Total description bytes | 5,164 | 5,692 |
| Total input schema bytes | 12,732 | 14,599 |
| Total output schema bytes | 23,207 (51.8% of the result) | 26,234 (51.7%) |
| Name plus description plus input schema only | 18,271 bytes, 4,568 tokens | 20,720 bytes, 5,180 tokens |
| `prompts/list` result | 612 bytes | same |
| `resources/list` result | 2,800 bytes | same |
| `resources/templates/list` result | 402 bytes | same |
| All of the above, one session | 55,676 bytes, 13,919 tokens | same |

Two measured facts dominate that cost. First, every tool declares the same output schema: 26 tools,
one distinct shape, 1,009 bytes each, 26,234 bytes total. Second, 15 domain tool descriptions end
with an M2M endpoint and OAuth scope sentence (`(M2M endpoint: /v1/vehicles/{vin}/... , scope ...)`),
1,394 bytes and 348 tokens of model context that describe an HTTP route the model never calls.

The largest single tool is `get_battery` at 2,420 bytes, of which the description is 615 bytes. The
largest input schema is `plan_cheapest_charge` at 1,041 bytes, and it is one of only two tools with a
required argument (`prices`, and `get_history` requires `domain`). Description bytes are 11.5% of the
list; schema bytes, output schema included, are 80.1%.

The instructions the model reads once per session (882 bytes) are:

> Polestar Data Portal (M2M) is READ-ONLY: every tool is a GET, no command is sent to the car. Start
> with list_vehicles. On a credential that sees exactly one vehicle the vin argument may be omitted.
> Domain data is reported by the car, not by the API: fields are absent when unreported, and a whole
> domain can answer DATA_NOT_AVAILABLE. That is normal, not an error. Prefer get_car_status or
> is_car_secure or get_needs_attention or get_charging_estimate over the 15 individual domain reads;
> every live call spends a shared allowance of 10,000 calls/day and 100/minute, and polestar_status
> reports what is left. Every payload carries an age: charging configuration can be days old while
> telemetry is minutes old, so read the age before treating a value as current. Errors come back as
> structured JSON with a code, httpStatus and requestId. Quote the requestId when reporting a problem.

Enabling history adds three tools (`get_history` 2,094 bytes, `get_degradation_report` 1,922,
`get_charging_sessions` 1,858) and 5,877 bytes, about 1,469 tokens, to every `tools/list` in every session, whether or
not the user asks a longitudinal question.

### One payload, sent twice

Every successful tool result carries the same string twice: once as `content[0].text` and once as
`structuredContent.message`. `src/tool-output.ts:72` declares the field as `Result text, identical
to the content block`, and `src/tool-output.ts:90` fills it with `{ ok: true, message: content }`.
In every call my probe measured, `structuredContent.message` was byte-identical to the text block.

| Call set | Calls | Text bytes | Structured bytes | Duplicated bytes | Share of payload | Wasted tokens (est) |
| --- | --- | --- | --- | --- | --- | --- |
| `analysis/surface/capture.ts` | 11 | 3,495 | 4,576 | 3,495 | 43.3% | 874 |
| `analysis/surface/probe-agent.ts` flow calls | 9 | 2,239 | 2,619 | 2,239 | 46.1% | 560 |
| Combined | 20 | 5,734 | 7,195 | 5,734 | 44.3% | 1,434 |

The prior audit script measures 11 tool calls, not 12; the probe adds 9 flow calls, and the combined
row covers the 20. The average duplicated payload is 71.7 tokens per call, 286.7 bytes. Per-call range: 12.5% for
`list_vehicles` (its structured `data` array is large relative to the text) up to 49.4% for
`list_domains`, whose 3,181-byte payload contains 1,571 duplicated bytes (393 tokens) of a registry
listing that the model can already see in the tool descriptions.

`raw: true` is worse than the aggregate figure because the raw payload is duplicated as well. The
measured `get_battery` raw call returns 904 text bytes and a 1,734-byte structured envelope whose
`data` is the same 656-byte payload that the text prints. That is 1,560 duplicated bytes of a
2,638-byte payload, 59.1%, about 390 wasted tokens in one call.

### Realistic questions: where the surface routes and where it stumbles

A deterministic lexical ranker over the real `tools/list` (whole-word overlap with name, title and
description) is a lower bound on what a model does, not a model. It is useful because it shows which
user words exist on the surface at all. Five questions, ranked against the 26-tool list:

| Id | User question | Lexical top pick (score) | Intended tool | Present in default 23? | What happened |
| --- | --- | --- | --- | --- | --- |
| q1 | how is my car doing | `get_car_status` (3) | `get_car_status` | yes | Answered in one call, 294 bytes. |
| q2 | is it plugged in and when will it be full | `get_car_status` (2), then `get_battery` (1) | `get_battery` | yes | Two calls needed; the second answer has no number. |
| q3 | what should I check before a long trip | `get_battery` (1), `get_odometer` (1) | `get_needs_attention` | yes | The only matching word is `trip`, and both matches mean trip meters. |
| q4 | why is my range lower than last month | `get_car_status` (1), `get_degradation_report` (1) | `get_degradation_report` | no | Default config has no longitudinal tool; history mode answers with a refusal. |
| q5 | plan cheap charging for tonight | `plan_cheapest_charge` (6) | `plan_cheapest_charge` | yes | The right tool is easy to find; the call needs two repairs before it produces a plan. |

Vocabulary coverage over the same 26 descriptions: `plugged` appears on 0 tools, `month` on 0,
`journey` on 0, `tonight` on 0. `time to full` appears on 1 (`get_battery`), `range` on 2
(`get_car_status`, `get_degradation_report`) but not on `get_battery` even though `get_battery`
returns `estimatedDistanceToEmptyKm`. `trip` appears on 2 tools (`get_battery`, `get_odometer`) and
both uses mean trip meters. `attention` appears on 1 (`get_needs_attention`), and the word a user
would say, `check`, appears on none.

The outputs, verbatim.

q1, `get_car_status`, 294 bytes:

```text
Car status, YSMTEST22PL000001
• Battery: 52% · 170 km range · Idle · Unplugged
• Exterior: everything closed · Locked · alarm idle
• Car is available (Asleep / not in use)
• Odometer: 122,953 km
• Service: in 313 days / 4150 km · no warnings
Data as of 48 d ago (newest domain).
```

q2, `get_battery`, 161 bytes, answers the plugged-in half:

```text
Vehicle YSMTEST22PL000001, telemetry/battery (data observed 48 d ago)
Charge: 52% · range 170 km
Charging: Idle · Unplugged
Average consumption: 20.1 kWh/100km
```

q2, second call, `get_charging_estimate`, 180 bytes, answers the time half with no time:

```text
Usable-energy data not reported; showing the car's own estimate instead.
Assumptions: power estimated from 20 A × 230 V assumed × 3 phase(s); the car reports no charging voltage.
```

The sentence promises the car's own estimate and then shows nothing, because
`src/aggregate-tools.ts:188` prints the fallback sentence and `src/aggregate-tools.ts:191` only
prints the estimate when it is above zero, and the fixture's `estimatedChargingTimeToFullMinutes`
is 0 on an unplugged car. The result is `ok: true`, 180 bytes, zero numbers.

q3, `get_needs_attention`, 108 bytes:

```text
Nothing needs attention, all health checks report OK.
Next service in 313 days or 4150 km (whichever first).
```

That is a good answer, but the route to it is luck: the surface has no word for a journey, and the
two lexical matches are trip meters. A model that calls `get_odometer` because the user said `trip`
gets 122,953 km and no health information.

q4, history enabled, `get_degradation_report`, 111 bytes:

```text
Only 1 battery sample(s) recorded, need at least 5. History accrues while the server runs with history enabled.
```

q4, default config, `get_battery`, 161 bytes: the same battery answer as q2, which cannot speak to
last month. The history tool that could answer is not registered at all unless
`POLESTAR_HISTORY_DIR` is set, so the default product cannot answer the question and does not say so.

q5, `plan_cheapest_charge`, first attempt, 184 bytes, is a repair request:

```text
Pack capacity is unknown (the car did not report dischargeInfo.energyAvailable and no capacityKwh argument was given). Pass capacityKwh explicitly, e.g. 78 for a long range dual motor.
```

Second attempt, `capacityKwh: 78` and 24 prices dated 2026-02-01, 593 bytes, returns a plan that
claims to be feasible while every chosen hour is unpriced:

```text
Charge plan (note: the car window is defined but INACTIVE on the car)
Need: 21.84 kWh to go 52% → 80% ≈ 1.59h at 13.8 kW

• 2026-11-05T22:00:24.416Z → 2026-11-05T23:00:24.416Z (price unknown): 10.9 kWh
• 2026-11-05T23:00:24.416Z → 2026-11-06T00:00:24.416Z (price unknown): 10.9 kWh
Note: Window too short for one contiguous block, fell back to cheapest individual hours.

Assumptions: Charging at a constant 13.8 kW; Pack capacity 78.0 kWh; From 52% to 80%; 14 window slot(s) had no price and are treated as last resorts; Hours are not contiguous, real charging may be interrupted.
```

The prices were valid ISO timestamps; they simply fell outside the next 48 hours that
`src/planner.ts:79-92` matches against. Nothing in the result says the supplied prices were never
used, no cost is rendered (`src/planner.ts:147` only includes `totalCost` when it is above zero),
and `ok` stays true. With the same 24 prices anchored to the next 24 hours and `capacityKwh: 78`,
the answer is 447 bytes, each chosen hour reads `@ 0.12`, and it ends with `Estimated cost: 2.621`.

### Error actionability

Good errors, quoted with their sizes:

- Bad VIN, 268 bytes: `Polestar API error INVALID_VIN (HTTP 400): "NOTAVIN" is not a plausible VIN (17 characters, no I/O/Q). Call list_vehicles for valid VINs.` plus `Hint: A VIN is 17 characters from the alphabet without I, O or Q. Call list_vehicles for the identifiers this credential may read.`
- Unknown domain, 233 bytes: `Polestar API error UNKNOWN_DOMAIN (HTTP 400): "telemetry/nope" is not a registered domain. This server records 15 domains, listed by kind/name.` plus a hint that `list_domains` enumerates every one.
- Ambiguous vehicle without an elicitation channel, 260 bytes: `Polestar API error AMBIGUOUS_VIN (HTTP 400): This credential has 2 vehicles; pass an explicit vin. Known VINs: YSMTEST22PL000001, YSMTEST22PL000002` plus a hint to pass a vin or call `list_vehicles`.
- Multi-vehicle with an elicitation channel works: the server sends `elicitation/create` with the message `This credential can see 2 vehicles. Which one?` and a form schema whose `vin` property is an enum of both VINs, required. Accepting it returns the 161-byte battery answer. The same call with no vehicle chosen falls back to the 260-byte `AMBIGUOUS_VIN` error above.
- Budget exhausted, reachable offline through a local HTTP stub of the upstream API, 370 bytes: `Polestar API error RATE_LIMIT_EXCEEDED (HTTP n/a): Daily API budget exhausted: 1/1 calls used (limit from the Polestar Data Portal: 10,000 calls/client/day). Budget resets at 2026-11-06T00:00:00.000Z. Reduce polling, raise POLESTAR_BUDGET if you know better, or wait for the reset.` plus `Hint: The daily call budget is spent; retry after the reset reported by polestar_status.` The follow-up `polestar_status`, 233 bytes, says `API budget: 1/1 used (0 left)`, `Per-minute ceiling: 4/100 used`, `Cache: 0 hits ... 3 live misses`.

Two errors are weaker than that.

- Unknown tool, protocol error `{"code": -32602, "message": "Tool get_tyre_pressure not found"}`. It names the bad name and nothing else. There is no list of valid tools, no pointer to `list_domains`, and no hint field, unlike the in-band errors.
- Unknown argument is not an error at all. Calling `get_battery` with `{"tyre": 1}` returns the normal 161-byte answer with `isError: false` because the schema strips unknown keys. The dangerous version is a misspelled `vin`: the argument is dropped, the default vehicle is read, and the agent gets a plausible answer about a car the user did not name.

The budget measurement exposed one accounting surprise. With `POLESTAR_BUDGET=1`, the very first
tool call, `list_vehicles`, failed with the 370-byte budget error before it could read anything. The
token POST is metered too, because `src/retrying-transport.ts:68` charges every HTTP attempt and the
token provider goes through the same transport, so one read costs at least three units: token,
vehicle list, domain. The status line reported `1/1 used` after zero successful data reads.

### Resources, templates, completions, prompts

- Resources: 15 listed for one vehicle (one per domain), 2,800 bytes of listing. Two templates,
  `polestar://vehicle/{vin}/telemetry/{domain}` and `polestar://vehicle/{vin}/charging/{domain}`,
  402 bytes. A resource read returns 277 bytes of result whose 161-byte text is byte-identical to
  the matching `get_battery` text, so the documentation claim that the resource read is the tool
  read holds. The listing caps vehicles at 10 (`src/server.ts:283`, `vins.slice(0, 10)`), so a
  credential with 12 cars silently lists 10 of them.
- Completions: `vin` with `YSM` returns the one VIN. `domain` with `bat` returns `battery`; with
  `char` returns the four charging names that contain it; with `zzz` returns `[]`. A prompt
  argument (`car-status`, `vin`) returns `[]`, so prompts have no completion values.
- Prompts: 3, listing 612 bytes. `car-status` message 176 bytes (44 tokens), `charge-plan` 292
  (73), `battery-health-report` 202 (51). All three route the model to named tools and the
  `charge-plan` prompt correctly says to ask for hours and prices before planning. None of them
  mentions `capacityKwh`, which is the argument the planner actually needs on this car.

## What is missing

Ordered by how much a user would notice.

1. **One answer to "when will it be full".** The instructions push `get_car_status`, which shows
   `Unplugged` but no time to full and no target SoC. The dedicated estimator then returns a
   promise without a number. Two calls and a confusing sentence for a two-part question.
2. **A planner that refuses or flags prices it never used.** 24 valid prices outside the 48-hour
   match window produce a feasible 593-byte plan with two `price unknown` hours and no cost, while
   the same call with anchored prices produces a priced 447-byte plan and `Estimated cost: 2.621`.
3. **Vocabulary that matches users.** `plugged` 0 tools, `month` 0, `journey` 0, `tonight` 0,
   `range` absent from the battery tool, `trip` only as a trip meter. The surface is written in
   domain vocabulary and the routing cost lands on the model.
4. **Longitudinal answers in the default configuration.** The question "why is my range lower than
   last month" has no tool unless `POLESTAR_HISTORY_DIR` is set, and when it is set the three
   history tools cost 5,877 bytes, about 1,469 tokens, per session and answer with `Only 1 battery
   sample(s) recorded, need at least 5.` without saying how long that takes.
5. **Schema strictness.** A misspelled argument is silently dropped and the default vehicle is read.
   Nothing in the result tells the agent that its argument did not apply.
6. **Unknown-tool guidance.** The protocol error names the typo and stops. Every in-band error names
   the next tool to call; this one does not.
7. **Fleet-scale resource listing.** `vins.slice(0, 10)` silently truncates the resource list for a
   credential with more than 10 cars, with no `listChanged` signal that anything is missing.
8. **A quickstart that runs.** `npm run demo-dump` fails on a clean checkout while `README.md:56`
   says it prints `DUMP_OK`.
9. **Tool list economy.** 51.8% of `tools/list` is one output schema repeated 26 times; 348 tokens
   are endpoint and scope prose the model cannot act on.

## Candidates

| Id | Name | User question | Data read | Effort | Risk | Falsifiable check |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | Share one output schema | (every call: cheaper session) | `src/tool-output.ts` result shape | M | Medium: clients that resolve `$ref` differently | `tools/list` at 26 tools is at most 28,000 bytes (now 50,718) and every tool result still validates against its declared schema |
| E2 | Move endpoint and scope out of descriptions | (routing quality) | `src/domains.ts` rows, `src/domain-tools.ts` | S | Low: docs/check-docs `tools` still covers names | A test asserts no tool description contains `M2M endpoint`; `tools/list` falls by at least 1,394 bytes |
| E3 | Send the result text once | (every call: cheaper context) | `src/tool-output.ts` envelope and every tool result | M | Medium: clients that read only `structuredContent.message` | A probe asserts no `structuredContent.message` string equals the content text and the 20-call duplicated share drops from 44.3% to at most 5% |
| E4 | Put time-to-full and target SoC in `get_car_status` | is it plugged in and when will it be full | battery, target-soc, amp-limit via `aggregate-tools.ts` | S | Low: adds one line, no new calls | A probe calls only `get_car_status` and asserts the answer contains a completion time or an explicit "not charging" sentence |
| E5 | Stop promising an estimate that is not shown | is it plugged in and when will it be full | `get_charging_estimate` on `battery`, `target-soc`, `amp-limit` | S | Low: text change plus one contract case | A test with `estimatedChargingTimeToFullMinutes: 0` asserts the answer says `Not charging` and never contains `showing the car's own estimate instead` without a following figure |
| E6 | Reject or flag prices outside the match window | plan cheap charging for tonight | `planner.ts` price matching, `plan_cheapest_charge` | S | Low: text and one guard | A unit test feeds 24 prices dated outside the next 48 hours and expects `ok: false` with a hint naming the timestamp range, or a visible warning; a probe asserts no plan step renders `price unknown` with `ok: true` |
| E7 | Align surface vocabulary with user words | all five questions | tool descriptions in `src/domains.ts`, `aggregate-tools.ts`, `advisor-tools.ts` | S | Low: string edits | A routing fixture over the 5 questions asserts the intended tool ranks first; `plugged`, `time to full` and `range` appear in `get_battery`'s description |
| E8 | Reject unknown arguments | (any question, after an agent typo) | tool argument schemas in `src/tool-output.ts`, `src/domains.ts` | S | Medium: stricter schemas can reject client-added keys | A test calls `get_battery` with `{vinn: ...}` and expects an error naming the unknown key; no tool silently drops a VIN-shaped key |
| E9 | Name the valid tools in an unknown-tool error | (agent typo) | server tool dispatch in `src/server.ts` | S | Low: error text only | A probe asserts the unknown-tool response names `list_domains` or one valid tool name |
| E10 | Make history cost visible and conditional | why is my range lower than last month | `src/history-tools.ts`, `src/history.ts` | M | Medium: tool-set changes affect docs counts | `tools/list` with history is at most 46,000 bytes (now 50,718) or the three history tools collapse into one; the insufficient-history answer states how many samples are missing and how long accrual takes |

**E1. Share one output schema.** All 26 tools declare the same 1,009-byte schema; the total is
26,234 bytes, 51.7% of the 50,718-byte `tools/list`. The check is a byte ceiling plus a test that
counts distinct output-schema shapes. The risk is client-side `$ref` handling, so a `$ref` variant
should ship only with a probe against at least the clients the repo claims; a compact inline schema
with documented `data` shapes is the fallback.

**E2. Move endpoint and scope out of descriptions.** 15 descriptions spend 1,394 bytes, 348 tokens,
on `M2M endpoint` and `scope`. The information is operator documentation, not routing material. The
check is a description test plus the byte delta; `docs/check-docs.mjs tools` keeps working because it
matches tool names, not endpoint prose.

**E3. Send the result text once.** Over 20 measured calls the duplicated string is 44.3% of the
payload, 1,434 tokens, 71.7 per call; the raw-mode call reaches 59.1% and 390 tokens. The intended
consumer of `message` is an agent that cannot read `content`, which is the same agent that cannot
read the result at all, so the duplication buys little. The check is the duplication ceiling plus a
client that reads only content still getting the humanized text.

**E4. Put time-to-full and target SoC in `get_car_status`.** The instructions rank this tool first,
and the aggregate answer, 294 bytes, omits the one charging number the fixture actually carries
(`estimatedChargingTimeToFullMinutes`) and the target SoC. The check is a one-call probe for q2.

**E5. Stop promising an estimate that is not shown.** `src/aggregate-tools.ts:188` prints the
fallback sentence and line 191 suppresses a zero estimate, producing a 180-byte answer whose only
number is `20 A × 230 V × 3`. The check is the text assertion above, with the fixture's unplugged
battery.

**E6. Reject or flag prices outside the match window.** `src/planner.ts:79-92` expands the next 48 hours and
matches a price only when its start falls inside one of them; `src/planner.ts:147` omits `totalCost` when zero; the
result still says `feasible` and `ok`. The check is a unit test on past prices plus a probe assertion
that no `ok: true` plan renders `price unknown`.

**E7. Align surface vocabulary with user words.** Measured gaps: `plugged` 0, `month` 0, `journey` 0,
`tonight` 0, `range` 2 (neither is `get_battery`), `trip` 2 false friends, `check` 0. The check is
the five-question routing fixture, which currently fails q2, q3 and q4.

**E8. Reject unknown arguments.** `get_battery` with `{tyre: 1}` returned normal data, `isError:
false`, 161 bytes. A misspelled `vin` would read the default car. The check is a strict-schema test
naming the unknown key.

**E9. Name the valid tools in an unknown-tool error.** The measured reply is `{"code": -32602,
"message": "Tool get_tyre_pressure not found"}` with no hint, while every in-band error names the next
call. The check is a probe assertion on the message.

**E10. Make history cost visible and conditional.** History adds 5,877 bytes, about 1,469 tokens, to every `tools/list`
and the insufficient-history answer is 111 bytes that names the deficit but not the accrual time.
The check is a byte ceiling or a single consolidated history tool, plus the message assertion.

## Rejected ideas

- **One generic `get_domain(kind, name)` tool instead of 15 domain tools.** It would cut the tool
  list, but tool names are the routing surface and the per-tool descriptions are what the model
  matches against; collapsing them trades measured tokens for measured misrouting. Revisit only after
  E1 and E2 have been tried, since those recover most of the bytes without touching routing.
- **A shared `$ref` input schema for the 15 identical domain schemas.** The schemas are 647 bytes
  each and 15 of them are identical, but MCP clients differ in whether they resolve `$ref` before
  showing tools, and a client that does not would show a schema the model cannot use. No
  client-compatibility probe exists in this repo, so the idea cannot be falsified yet.
- **Drop `outputSchema` entirely.** It is 51.8% of the list, and deleting it would be the largest
  single saving, but the repository relies on output-schema validation as a contract check and
  clients use it to branch on `ok`. E1 keeps the contract and removes the repetition.
- **Emit only `structuredContent` and drop `content[0].text`.** This is the mirror of E3 and breaks
  content-only clients. The design comment at `src/tool-output.ts:71-72` says `message` exists so
  those clients lose nothing; E3 keeps the text and removes the copy.
- **Fetch electricity prices inside `plan_cheapest_charge`.** It would fix the timestamp problem from
  the other side, but it adds an external network dependency to a read-only server and is explicitly
  outside the tool's design (`src/advisor-tools.ts:34-38`: prices arrive as an argument).
- **Shorten the instructions.** 882 bytes and 221 tokens against a 12,680-token tool list is not
  where the cost is.
- **Rename `get_charging_estimate` or `plan_cheapest_charge`.** Naming is not the measured failure;
  the content and the price matching are.
- **Raise the tool count with a tyre or climate domain.** Not in the registry or the documented v1
  API, so there is nothing to read and nothing to test.

## Appendix: exact commands and observed output

All run from `/Users/nicolaskheirallah/Documents/GitHub/polestar-mcp`. Fixture mode only;
`POLESTAR_FIXTURES_DIR=test/fixtures/dump` wherever a command needs it. No live credential was read
or written.

```text
$ npm test
# tests 111
# pass 111
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 423.814125

$ npm run smoke
registry: 26 tools, 24 callable with no args
SMOKE_OK

$ npm run smoke-bin
BIN_SMOKE_OK --version, --help and the MCP handshake all work launched through the bin symlink

$ npm run demo-dump
DUMP_FAILED: expected captured dump at /Users/nicolaskheirallah/Documents/GitHub (dataportal/vehicles.json not found)
[npm exit=1]

$ node docs/check-docs.mjs tools
DOCS_TOOLS_OK tools=26 domains=15

$ node docs/check-docs.mjs envvars
DOCS_ENVVARS_OK

$ node docs/check-docs.mjs links
DOCS_LINKS_OK

$ node --import tsx analysis/surface/capture.ts
(no failure; wrote analysis/surface/evidence/{initialize,tools-list,calls,resources-list,resource-templates,prompts-list,resource-read,measurements}.json)
26 tools, tools/list result 50,718 bytes, 12,680 tokens; 11 tool calls measured

$ node --import tsx analysis/surface/capture2.ts
(no failure; wrote analysis/surface/evidence/capture2.json; full fixture and a copy with
telemetry/health, telemetry/exterior and charging/is-at-charge-location deleted)

$ node --import tsx analysis/surface/probe-agent.ts
PROBE_OK tools=23/26 toolsListBytes=50718 duplicateSharePct=46.1 wastedTokensEst=560
(wrote analysis/surface/evidence/runtime-probe.json, tools-list-default.json,
tools-list-history.json; 7 flow calls plus a capacity retry and a relative-price retry,
plus 3 multi-vehicle runs and a live-mode budget run against a local 127.0.0.1 stub)

$ node docs/check-docs.mjs hygiene        # in the live tree, at the end of this task
EMDASH_CHECK_FAILED:
  analysis/correctness/findings.md lines 1, 43, 71, 87, 113, 126, 159, 183, 191, 222, 235, 245,
  268, 278, 308, 337, 339, 356, 364, 382, 390, 413, 430, 438, 456, 464, 491, 513, 533, 561, 578,
  588, 589, 590, 591, 592, 593, 594, 595, 596, 597, 598, 599, 604, 612, 623, 624, 625, 626, 627, 629
[hygiene exit=1]
```

That in-tree failure names a file outside this task's write scope. The tree is shared while the five
agents write, and `analysis/correctness/` was still changing during this run, so the live result is
not a statement about this report. To check my own writing with the repository's own script, I ran
`node docs/check-docs.mjs hygiene` in a clean export of the tracked tree plus exactly my files:

```text
$ git archive HEAD | tar -x -C /tmp/hyg-check
$ mkdir -p /tmp/hyg-check/analysis/surface/evidence
$ cp analysis/E-runtime.md /tmp/hyg-check/analysis/
$ cp analysis/surface/probe-agent.ts analysis/surface/capture.ts analysis/surface/capture2.ts \
    /tmp/hyg-check/analysis/surface/
$ cp analysis/surface/evidence/*.json /tmp/hyg-check/analysis/surface/evidence/
$ cd /tmp/hyg-check && git init -q && git add -A && node docs/check-docs.mjs hygiene
HYGIENE_NO_EM_DASH
HYGIENE_BUZZWORDS_CLEAN
HYGIENE_NO_BANNERS
HYGIENE_NO_DASH_CONNECTORS
HYGIENE_CLEAN
[export-hygiene exit=0]
```

That is the same script over the tracked tree plus this task's files only, so it is a valid check of
the deliverable and of the probe scripts, and it reaches the connector detector that the in-tree run
never reached.

The budget-exhaustion run is a local stub, not a live call: `POLESTAR_BASE_URL=http://127.0.0.1:PORT`,
`POLESTAR_M2M_TOKEN_ENDPOINT=http://127.0.0.1:PORT/token`, a token reply of
`{"accessToken":"offline-probe-token","expiresIn":3600,"tokenType":"Bearer"}`, a vehicles reply of
one synthetic VIN, one battery fixture on the domain route, and `POLESTAR_BUDGET=1`. The observed
first-call and status lines are quoted in the error section above.

Evidence files, all under `analysis/surface/evidence/` and all ASCII-escaped after capture so the
tree-wide hygiene check can read them (escaping changes bytes on disk, never the measured values
recorded in them; every number in this report was measured in memory at capture time):

| File | Contents |
| --- | --- |
| `initialize.json` | the raw `initialize` request and result |
| `tools-list.json` | 26-tool `tools/list` result |
| `tools-list-default.json` | 23-tool `tools/list` result from the probe |
| `tools-list-history.json` | 26-tool `tools/list` result from the probe |
| `calls.json` | the 11 calls measured by `capture.ts` |
| `capture2.json` | absence-path calls and the deleted-fixture runs |
| `measurements.json` | `capture.ts` aggregate measurements |
| `resources-list.json`, `resource-templates.json`, `resource-read.json` | resource surface |
| `prompts-list.json` | prompt surface |
| `runtime-probe.json` | the agent-flow, routing, vocabulary, error, multi-vehicle, budget and duplication measurements |

Reproduce the headline numbers without the evidence files:

```text
tools/list 23 tools: 44,841 bytes / 11,210 tokens est
tools/list 26 tools: 50,718 bytes / 12,680 tokens est
output schemas: 26,234 bytes (51.7%), one distinct shape, 1,009 bytes each
endpoint plus scope prose: 15 descriptions, 1,394 bytes, 348 tokens
duplication over 20 calls: 5,734 duplicated bytes of 12,929 payload, 44.3%, 1,434 tokens est
raw:true duplication: 1,560 of 2,638 bytes, 59.1%, 390 tokens est
```

The worst friction in this report, in one sentence: the two questions a driver asks most, "is it
plugged in" and "when will it be full", are split across the recommended aggregate that lacks the
ETA and an estimator that prints a promise with no number, and the charging planner will happily
return a feasible plan built from prices it never matched.
