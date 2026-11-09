# MCP surface and agent-product audit

**Repo:** `polestar-mcp` v0.3.0, commit `dc50017` (`@modelcontextprotocol/server` 2.4.0)
**Scope:** the MCP surface as an agent product: tool titles/descriptions/annotations, output schemas and
`structuredContent`, MCP instructions, resources/templates/completions/subscriptions, prompts, error and
absence text, and the aggregates/advisor. This is not a conformance review; the question is whether an
agent uses this surface *well*, and what every turn costs.
**Mode:** read-only. Fixture mode only (`test/fixtures/dump`), no live credential, no packages installed.
**Evidence:** raw frames and measurements under `analysis/surface/evidence/`; capture scripts under
`analysis/surface/*.ts` (reproduce with `node --import tsx analysis/surface/capture.ts`, `capture2.ts`,
`capture3.ts`). Nothing outside `analysis/surface/` was modified; the working tree stays clean.

---

## 0. Measured facts (commands and outputs)

Token figures use **bytes / 4** (English prose + JSON; ±15%). All byte counts are UTF-8 of the exact
JSON-RPC `result` the client received.

| Fact | Bytes | ~Tokens | Command / evidence |
| --- | ---: | ---: | --- |
| `initialize` result | 1,144 | 286 | `capture.ts` → `evidence/initialize.json` |
| … of which `instructions` | 882 | 221 | same |
| **`tools/list` result (26 tools)** | **50,718** | **12,680** | `capture.ts` → `evidence/tools-list.json` |
| … `outputSchema` total, 26 near-identical copies | 26,234 | 6,559 | 26 × 1,009 B identical schema |
| … `inputSchema` total | 14,599 | 3,650 | 15 tools share one 647 B schema |
| … descriptions total | 5,692 | 1,423 | 26 descriptions |
| … of which `(M2M endpoint: …, scope …)` boilerplate | 1,394 | 349 | 15 domain tools |
| … shared argument prose (`vin` ×23, `raw` ×15, `delegated_account_id` ×23) | 8,311 | 2,078 | 57% of all input-schema bytes |
| `tools/list` with history off (23 tools) | 44,847 | 11,212 | subset of the same capture |
| average bytes per tool | 1,950 | n/a | largest: `get_battery` 2,420 |
| `resources/list` (1 vehicle) | 2,800 | 700 | 15 resources |
| `resources/list` (10 listed vehicles) | 27,865 | 6,966 | 150 resources, **no `nextCursor`** |
| `resourceTemplates/list` | 402 | 100 | 2 templates |
| `prompts/list` | 612 | 153 | 3 prompts |
| `get_car_status` result (text / structured / wire) | 294 / 324 / **700** | 175 | measured on fixture |
| `get_battery` result (text / structured / wire) | 161 / 256 / **496** | 124 | 100% of `structuredContent` is duplicated prose |
| `get_battery` `raw:true` (text / structured / wire) | 904 / 1,734 / **2,772** | 693 | the 656 B payload is sent **twice** |
| failure result (`DELEGATION_NOT_ALLOWED`) text / structured | 302 / 541 | 211 | hint appears 3× |
| absence result (`get_is_at_charge_location`) | 153 (text) | 38 | `ok:true`, no `code`, no `data` |

Commands that produced these: `npm run smoke` (`SMOKE_OK`, "registry: 26 tools, 24 callable with no args"),
`npm run smoke-http` (`HTTP_SMOKE_OK`), `node --import tsx scripts/list-tools.ts` (26 names), and the
three capture scripts above. `completion/complete` on the telemetry template answered
`{"values":["YSMTEST22PL000001"],"total":1,"hasMore":false}`.

**Interpretation.** Results are cheap and good: a full car briefing costs 700 B (~175 tokens) and a domain
read ~500 B. The listing is the expensive half: ~12.7 k tokens before the agent has done anything. MCP
fetches `tools/list` once per session, but common clients (Claude Desktop/Code, Cursor, and most SDK hosts)
inject the tool definitions into **every** model request, so this is a recurring per-turn cost, and it is
re-paid on every reconnect. At 4 B/token, 52% of it is one generic schema copy-pasted 26 times and 25% of
the prose is endpoint/scope metadata the model cannot act on.

---

## 1. What already works well

These are real strengths; the findings below are about the remaining gaps, and several fixes must not
disturb these.

- **Every tool declares `outputSchema`, `title` and `readOnlyHint: true`**, and the stdio smoke test proves
  it on the wire and proves `structuredContent.message === content.text` for all 24 zero-argument tools
  (`scripts/smoke.ts`). Annotations are accurate where they are set; `openWorldHint` is explicit on every
  network tool.
- **Results are humanized and small.** Enum humanization (`src/format.ts`), operator units, data-age
  headers, and absence normalization mean the model rarely has to parse raw payloads; the briefing above
  is 294 B. `raw:true` is a real escape hatch for unsupported fields.
- **Failure normalization is deep.** `src/failure.ts` maps every thrown class into one `Failure`; the hint
  table (`src/tool-output.ts:107-151`) is keyed by a *closed* union, so a new minted code cannot ship
  without advice. `isError:true` plus `code`/`httpStatus`/`requestId` is the right shape.
- **Absence is modelled at all.** `DATA_NOT_AVAILABLE` → `null` → one shared sentence
  (`src/vehicle-read.ts:150-157`) instead of a per-tool error, and fixture NOT_FOUND is deliberately
  distinct from it (`src/transport.ts:80-83`).
- **Elicitation is implemented for the right case** (several vehicles, one call) with a validated answer,
  stable per-tool request keys, and a fallback that re-raises the actionable `AMBIGUOUS_VIN` error
  (`src/vehicle-read.ts:70-116`).
- **Transport honesty.** Subscriptions are advertised `true` on stdio and `false` over stateless HTTP,
  `resources/subscribe` is refused over HTTP, and `smoke-http.ts` asserts both, plus the 401 challenge.
- **Real completions and templates** on `polestar://vehicle/{vin}/{kind}/{domain}`, and the resource read
  reuses the exact tool read, so the two surfaces cannot drift.
- **Registry-derived prose.** Descriptions and instructions are built from the same spec table that is
  registered, and `scripts/check-tool-refs.mjs` fails CI if prose names an unregistered tool. This is why
  the description rewrite proposed below is cheap and safe.

---

## 2. Findings, ranked by leverage

Ranking weighs (a) does it change the answer the agent gives, (b) how often it is paid, (c) effort.

### F1 (HIGH): Absence text can invert the answer in yes/no tools; aggregates hide it

**Evidence.** The shared absence sentence is `No ${domain} data is available for vehicle …` 
(`src/vehicle-read.ts:156`), and it is the *entire* result of `is_car_secure` and `get_needs_attention`
when the domain is unreported (`src/aggregate-tools.ts:106`, `:133`). With health and exterior
answering `DATA_NOT_AVAILABLE` (normal live state; reproduced in `capture3.ts`):

```
is_car_secure      (140 B, isError:false): "No exterior data is available for vehicle
                    YSMTEST22PL000001 (the API returned DATA_NOT_AVAILABLE, this vehicle
                    does not report this domain)."
get_needs_attention(138 B, isError:false): "No health data is available for vehicle …"
get_car_status     (188 B, isError:false): three bullets, no mention of exterior/health,
                    then "Data as of 48 d ago (newest domain)."
```

A model asked "is my car locked?" can read the leading "No" as the verdict; asked "does anything need
attention?" it can read "No health data" as "no warnings". `get_car_status` silently drops two of its five
domains (the `if (battery)` / `if (exterior)` / … chain at `src/aggregate-tools.ts:55-78` has no `else`),
so a briefing can be confidently incomplete. The structured envelope offers no way to tell: `ok:true`, no
`code`, no `data`.

**Impact.** Wrong, safety-relevant answers (locked vs unknown; warnings vs unknown) and incomplete
briefings that look complete. This is the highest-leverage finding because it changes model conclusions,
not just cost.

**Improvement.** (a) Rewrite the shared sentence so absence is never a leading "No"; (b) name unreported
domains in `get_car_status`; (c) carry `code:"DATA_NOT_AVAILABLE"` and `data:{reported:false}` so clients
can branch; (d) per-domain ages. Concrete text/schema in §3.1.

**Effort:** S. **Risk:** low; the sentence is not asserted by smoke; `docs/tools-reference.md` quotes the
old wording and must be updated in the same change.

---

### F2 (HIGH): `tools/list` costs ~12.7 k tokens, and 52% is one schema repeated 26 times

**Evidence.** `tools/list` result = 50,718 B (`evidence/tools-list.json`). Breakdown: `outputSchema`
26,234 B (51.7%; 26 byte-identical copies of the 1,009 B `resultShape` at `src/tool-output.ts:70-82`),
`inputSchema` 14,599 B (28.8%; 15 domain tools share one identical 647 B schema), descriptions 5,692 B
(11.2%, of which 1,394 B is `(M2M endpoint: /v1/vehicles/{vin}/telemetry/battery, scope
pdp-telemetry/battery).` appended at `src/domain-tools.ts:65`), names/titles/annotations/JSON overhead
~4,200 B.

The schema's per-field `.describe()` strings are the bulk: "Result text, identical to the content block",
"Tool that produced this result", "Machine-readable error code when ok is false", etc. A model does not
need these; clients branch on field names. The endpoint/scope suffix is operator metadata the model cannot
use; `list_domains` already returns exactly that mapping (1,571 B, measured) on demand.

**Impact.** ~12.7 k tokens of context and money before the first question, re-paid on every turn in
clients that inject tool definitions, and ~50% of it is avoidable without losing a single selection cue.

**Improvement.** (a) Compact common `outputSchema` (288 B, concrete in §3.2); (b) domain descriptions =
one short summary line, no endpoint/scope (concrete template + examples in §3.2); (c) shorten the three
shared argument descriptions; (d) keep `list_domains` as the endpoint/scope source of truth. Measured
estimate: listing 50,718 B → ~25,300 B (≈12.7 k → ≈6.3 k tokens, **−50%**) with no tool removed.

**Effort:** S. **Risk:** low; `docs/check-docs.mjs tools` only requires tool names to appear in
`docs/tools-reference.md`, and `check-tool-refs.mjs` requires any tool-shaped word in prose to be
registered. Do not mention endpoints in descriptions as if they were tool names; they are paths, so they
pass anyway. Update the one quoted description in `docs/tools-reference.md` if it is restated.

---

### F3 (HIGH/MED): `structuredContent` duplicates the text and carries almost no structure

**Evidence.** `src/tool-output.ts:84-91` sets `structuredContent.message = content.text` for every success,
and the smoke test enforces it. Measured across 12 calls: the `message` field is 100% of text bytes in
every one. Probed all 24 zero-argument tools (`analysis/surface/probe-data.ts`): **1 populates `data`**
(`list_vehicles`); the other 23 return `ok/message` (+`vin`/`tool`/`ageSeconds`). `get_battery` is 161 B of text carried in a 256 B envelope whose
only non-duplicated fact is numeric `ageSeconds` (already rendered as "data observed 48 d ago"). With
`raw:true` the same 656 B payload appears in the text **and** in `structuredContent.data`; 2,772 B of
wire for a 904 B answer. `tool` repeats the name the caller just used. On failures, the hint is tripled:
text suffix, `message` copy, and `hint` field (`src/tool-output.ts:167,173`), 541 B structured for a 302 B
error.

Two inversions make it worse: the only genuinely machine-shaped, agent-relevant field is
`list_vehicles`' `data.note` (it explains that the M2M contract returns VINs only), and it exists **only**
in `structuredContent`, which text-only clients never see (text is 46 B, structured 323 B); and the MCP spec
says a tool that returns structured content SHOULD also return the *serialized JSON* in a text block, which
this server does not do (the text is prose, the structured half is prose again).

**Impact.** Clients that forward `structuredContent` to the model pay 1.5-3× the useful tokens per call;
clients that do not lose the only structured facts; none of them get a usable table to render. The
outputSchema promise ("data: structured payload; shape documented per tool") is fiction at default
arguments for 25 of the 26 tools (only `list_vehicles` populates `data`).

**Improvement.** (a) Drop `message` from `structuredContent`; the content block already carries it;
(b) drop `tool`; (c) make `data` the machine payload where one exists (`list_vehicles`, and a `domains`
map + per-domain ages for the aggregates per F1); (d) `raw:true` keeps the payload in the text only, or in
`data` only, not both; (e) on errors keep `hint` once. Update the smoke invariant from
`message === text` to `content.text.length > 0 && structuredContent.ok === true`.

**Effort:** M (touches `text()`, `errorResult`, smoke, several tests). **Risk:** low-medium; older
clients still get the humanized text; the contract change is visible in `docs/tools-reference.md`.

---

### F4 (MED): `get_charging_estimate` promises an estimate it does not produce

**Evidence.** On the fixture (idle, `estimatedChargingTimeToFullMinutes: 0`, no
`dischargeInfo.energyAvailable`) the whole 180 B result is:

```
Usable-energy data not reported; showing the car's own estimate instead.
Assumptions: power estimated from 20 A × 230 V assumed × 3 phase(s); the car reports no charging voltage.
```

There is no estimate. `src/aggregate-tools.ts:188` pushes that sentence in the `else` branch, while the
car's own estimate is only printed when `eta > 0` (`:190-191`).

**Impact.** Asked "when will it be charged?", a model can present "Assumptions: …" as the answer or
invent a number. False confidence after the tool explicitly said it would show something.

**Improvement.** Concrete replacement in §3.3: state that no estimate is possible and why, name the next
call, and return `data:{estimateable:false}`. **Effort:** S. **Risk:** low.

---

### F5 (MED): Local refusals are framed as upstream API errors, and the fallback hint points at a nonexistent `requestId`

**Evidence.** `describeFailure` always prefixes `Polestar API error <CODE> (HTTP n/a|400|403)`
(`src/failure.ts:113-117`). Measured: a local VIN validation refusal prints
`Polestar API error INVALID_VIN (HTTP 400)`; a local allowlist refusal prints
`Polestar API error DELEGATION_NOT_ALLOWED (HTTP 403)`; no HTTP request was made for either. The fallback
hint (`src/tool-output.ts:165`) is `Report the requestId with the tool you called; this code is not one
this server documents.`; measured on a code with **no** `requestId`, so the instruction is unexecutable.
The initialized instructions then promise "Errors come back as structured JSON with a code, httpStatus and
requestId" (882 B instructions), which is false for every minted local error.

**Impact.** The model blames Polestar for a local configuration/argument problem, asks the user for a
requestId that does not exist, and retries instead of fixing the call.

**Improvement.** Prefix minted codes `Server refused:` and upstream codes `Polestar API error:`; fallback
hint `This server has no extra advice for this code. Report the code and the tool you called.`; hint once.
**Effort:** S. **Risk:** low; tests assert codes/hints, not the prefix (confirm in `test/runtime.test.ts`
before changing); keep the phrase `Polestar API error` for upstream codes only.

---

### F6 (MED): `resources/list` silently truncates to 10 vehicles, has no cursor, and grows as vehicles × domains

**Evidence.** `src/server.ts:283` `vins.slice(0, 10)`. With a 12-vehicle fixture copy, `list_vehicles`
correctly reports 12 VINs, but `resources/list` returns **150** resources (10 VINs × 8 telemetry + 10 × 7
charging), 27,865 B (~7 k tokens), `nextCursor` absent, and the 11th/12th vehicles' resources are
unreachable by listing (their URIs still work if constructed). Resource `name`/`description` use
`…${vin.slice(-4)}` and ignore configured `POLESTAR_VEHICLE_LABELS`, while every tool uses labels.

**Impact.** Fleet (`delegated_account_id`) users cannot discover all their resources; any client that
lists resources on connect pays ~7 k tokens for 10 cars; and the count grows as
`vehicles × domains`, with no pagination.

**Improvement.** Return one resource per *vehicle×domain* only as template expansion (templates already
exist); list per-kind templates plus a small page of vehicle resources, honoring `nextCursor` per MCP
pagination; use labels in `name`. **Effort:** M. **Risk:** low (resources are a secondary surface; the
tools are unaffected).

---

### F7 (MED): History has `limit` but no pagination, and truncation is silent

**Evidence.** `historyArgs` (`src/history-tools.ts:23-35`) exposes `domain`, `hours`, `limit`; no offset,
no cursor, no `before`. The store returns newest-first and slices to `limit` (`src/history.ts:74-78`), and
`recordsToText` (`src/history-tools.ts:37-38`) prints the records with no "more available" marker, so a
200-record answer is indistinguishable from a complete one.

**Impact.** The one surface built for longitudinal questions cannot be walked; the agent either
under-answers (silent truncation) or re-queries with guessed `hours` buckets.

**Improvement.** Add `before` (ISO timestamp of the oldest returned record) and `offset`; return
`N of M records; older records exist, pass before=<oldest observedAt>` and `data.nextBefore`. **Effort:** S.
**Risk:** low.

---

### F8 (MED): No charging-settings aggregate: "what's my charging setup?" costs 7 calls

**Evidence.** Seven charging tools (`get_amp_limit`, `get_target_soc`, `get_global_charge_timer`,
`get_parking_climate_timer`, `get_charge_locations`, `get_charge_now`, `get_is_at_charge_location`) and no
aggregate over them. `get_car_status` covers only five *telemetry* domains
(`src/aggregate-tools.ts:44-51`), so the instructions' "prefer the aggregates" advice does not apply to
charging configuration. Each domain answer is 400-520 B, so the setup answer is ~3 KB plus six extra
round trips and six tool-selection decisions.

**Impact.** More calls, more chances to stop early and answer partially, more budget spent. This is the
most valuable *missing* tool: it is the same pattern that already made `get_car_status` the default first
call.

**Improvement.** Add `get_charging_setup` (one line per setting + age, `data.settings` map), and name it in
the instructions. With F2 applied it costs ~1.2 KB of listing and saves ~2 KB of results plus five round
trips. **Effort:** M. **Risk:** low; it is a pure composition of existing reads through the cache.

---

### F9 (MED/LOW): No progress notifications and no cancellation for multi-domain aggregates

**Evidence.** `src/tool-output.ts:184` claims `mcpReq` carries `signal`, but the `ToolContext` type
(`:189-193`) does not include it and no tool reads it; no code emits `notifications/progress` (grep over
`src/`). Aggregates issue up to five concurrent live reads (`src/aggregate-tools.ts:44-51`), each bounded
by `POLESTAR_TIMEOUT_MS` default 15 s, with no progressToken handling.

**Impact.** A slow live briefing looks hung; a client's cancel (per MCP, a `notifications/cancelled`) stops
the wait but not the upstream calls or budget spend; the model may retry and spend quota twice. The
comment is exactly the kind of unenforced claim `AGENTS.md` says is a defect.

**Improvement.** Thread `ctx.mcpReq.signal` into the transport (combine with the timeout via
`AbortSignal.any`), map abort to a `CANCELLED` code, and emit progress when the request's
`_meta.progressToken` is present. **Effort:** M/L. **Risk:** medium; needs an SDK-capability check; keep
the existing timeout as the outer bound.

---

### F10 (LOW): Annotation and capability honesty, and inconsistent titles

**Evidence.** `tools/list` shows `openWorldHint` absent on the three history tools and on
`polestar_status`; the spec default is `true`, so `polestar_status` (purely local state: budget, cache,
token clock) is advertised as open-world. No tool sets `idempotentHint`, whose default is `false`, although
every tool is a pure read. `initialize` advertises `logging: {}`, `tools.listChanged: true`,
`resources.listChanged: true`, `prompts.listChanged: true` (`evidence/initialize.json`), but `src/` never
calls `sendLoggingMessage` or any list-changed notification (grep). Titles mix machine names and prose:
"Get parking-climatization", "Get pre-cleaning", "Get is-at-charge-location" vs "Get full car status",
"Server status".

**Impact.** Auto-approval UIs get weaker hints than they could; clients may wait for list-changed events
that never arrive, or set a log level that does nothing. Naming inconsistency is a low-grade selection
signal problem.

**Improvement.** `idempotentHint:true` on all tools; `openWorldHint:false` on `polestar_status`; drop the
unused `logging`/`listChanged` capabilities; normalize titles ("Get parking climatization", "Get
pre-cleaning status", "Is the car at a charge location"). **Effort:** S. **Risk:** low.

---

### F11 (LOW): Unknown resource reads and subscribes return success

**Evidence.** `src/server.ts:311` returns resource `contents` with the text
`Unknown telemetry domain "…"` instead of an MCP error (`-32002 Resource not found`). In
`src/subscriptions.ts:55-66`, `subscribe()` with an unparseable URI starts the timer and stores nothing ;
the request succeeds and can never notify.

**Impact.** An agent reads "Unknown …" as data rather than as a failed read; a bad subscription fails
silently.

**Improvement.** Throw `McpError`/`ResourceNotFound` for an unknown domain URI; reject unparseable
subscribe URIs with `-32602`. **Effort:** S. **Risk:** low.

---

### F12 (LOW): `phases` defaults to 3 in a worldwide product

**Evidence.** `src/aggregate-tools.ts:155,166`: `phases` optional, default 3, described as "Swedish 400V
three-phase". `get_charging_estimate` and `plan_cheapest_charge` both use it. The assumption is disclosed
in the answer, but the schema default means a model will never ask a single-phase user.

**Impact.** A 3× time/power error in single-phase markets, disclosed but easy to miss; the model has no
reason to question the default.

**Improvement.** Make `phases` required for the two estimate/plan tools, or source it from a
`POLESTAR_PHASES` config with no silent default, or prefer reported volts/amps when charging. **Effort:**
S. **Risk:** low-medium (argument-shape change visible to clients).

---

### F13 (LOW): Instructions waste a call and contradict the error contract

**Evidence.** 882 B instructions (`evidence/initialize.json`), one sentence each, joined with spaces:
"Start with list_vehicles." (an avoidable budget call when the credential has one car; every tool accepts
an omitted `vin` and resolves it), and "Errors come back as structured JSON with a code, httpStatus and
requestId" (local errors have no requestId, and `httpStatus` is synthesized for several minted codes).
"Prefer get_car_status or is_car_secure or get_needs_attention or get_charging_estimate over the 15
individual domain reads" reads as "call any of these"; it does not say *which question maps to which*, and
never mentions the history tools.

**Impact.** One wasted call per session on the common single-car setup; a model may quote a requestId that
does not exist; aggregate selection stays ambiguous.

**Improvement.** Concrete rewrite in §3.4. **Effort:** S. **Risk:** low.

---

## 3. Concrete replacements for the top 2

### 3.1 F1: absence that cannot be read as a negative (top item)

**Replace `src/vehicle-read.ts:150-157` (`noData`)** with a sentence whose first clause names the *state*,
not the absence, and carry the machine signal:

```ts
export function noData(vehicle: VehicleScope, domain: DomainTarget, consequence?: string): ToolResult {
  // "not reported" is a state of the car, not an answer to the question. The old
  // sentence led with "No …", so a yes/no tool read as the negative verdict.
  const sentence =
    `${domain.name} data is unavailable: this vehicle does not report that domain ` +
    `(DATA_NOT_AVAILABLE), so the value is unknown here.`;
  return text(consequence === undefined ? sentence : `${sentence} ${consequence}`, {
    code: 'DATA_NOT_AVAILABLE',
    data: { reported: false },
  });
}
```
(`text()` gains an optional `code` in its `extra`; `resultShape` already declares `code`.)

**Consequences to add at the call sites** (the second sentence is the one that stops the inversion):

| Tool | Consequence sentence |
| --- | --- |
| `is_car_secure` | `This is missing data, not an unlocked car: locked/closed state cannot be determined.` |
| `get_needs_attention` | `This is missing data, not a clean bill of health: warnings cannot be determined.` |
| `get_charging_estimate` | `This is missing data, not a zero estimate: no time or energy can be computed.` |
| `get_history`-family | (unchanged; history is local and the absence is "no records") |

**Add to `get_car_status` (`src/aggregate-tools.ts`, after the bullet loop):**

```ts
const missing = [['exterior', exterior], ['health', health], …].filter(([, d]) => d === null).map(([n]) => n);
if (missing.length > 0) lines.push(`Not reported by this vehicle: ${missing.join(', ')} (unknown, not "nothing to report").`);
```
and replace the single newest age (`:86`) with per-domain ages:

```ts
lines.push(`Data ages: ${[battery, exterior, availability, odometer, health]
  .map((d, i) => d === null ? `${NAMES[i]} n/a` : `${NAMES[i]} ${formatAge(observedAtMs(d)!, nowMs)}`)
  .join(' · ')} (oldest reported governs the briefing).`);
```

Also put the same map in structured output (`data.domains = { battery: 'reported' | 'unavailable', … }`)
so a client can branch without parsing prose.

### 3.2 F2: a listing that costs half as much (top item)

**Replace `resultShape` (`src/tool-output.ts:70-82`)** with the 288 B compact schema (measured by
serializing exactly this; `vin` stays because `POLESTAR_REDACT_VIN` must reach the machine half, `message`
goes because the content block already carries it; that half is F3):

```ts
export const resultShape = {
  ok: z.boolean(),
  vin: z.string().optional(),
  data: z.unknown().optional(),
  ageSeconds: z.number().nonnegative().optional(),
  code: z.string().optional(),
  hint: z.string().optional(),
  requestId: z.string().optional(),
};
```

Expected: `outputSchema` total 26,234 B → 7,488 B (26 × 288 B), **−18,746 B ≈ −4,686 tokens**, with every
field a client can branch on. If F3 is deferred and `message` must stay, the schema is 326 B and the saving
is −17,758 B; either way do not put prose back in the shared shape. If a tool-specific `data` shape is
wanted later, declare it only on the aggregates and the list tools.

**Replace the domain description template (`src/domain-tools.ts:65`)** with a one-line summary and move
endpoint/scope to `list_domains` (which already carries them):

```ts
description: `${domain.summary}`,
```

`DomainSpec` gains `summary` (50-110 chars), e.g.:

| Tool | New description (exact text) |
| --- | --- |
| `get_battery` | `Battery: charge %, charging status, range, time to full, consumption, usable energy. Fields the car does not report are absent, not zero.` |
| `get_health` | `Health: service countdown (days/km/engine hours) and fluid, light and 12V warnings.` |
| `get_charge_locations` | `Saved charge locations. Over M2M this is often only an id and a utc0 flag, so no addresses is normal, not a failure.` |
| `get_global_charge_timer` | `Recurring charge window: start/stop hour, timezone offset, activation, pending changes.` |
| `get_is_at_charge_location` | `Whether the car is at a saved charge location; often not reported, which is normal.` |

For the other ten, use the first sentence of the current description (they are already 78-213 chars).
Remove "The reference vehicle answered with 14 fields and none of the optional ones." from `get_battery`:
it is an observation about one captured car, not a property of the API.

**Shorten the shared argument prose (`src/tool-output.ts:10-42`)**; measured 8,311 B today:

```ts
vin:        'Vehicle VIN. Omit when the credential has one vehicle.'
raw:        'Append the untouched API payload after the summary.'
delegated:  'Third-party credentials: read this account’s vehicles (must be allowlisted).'
```

**Measured estimate after (a)-(c):** listing 50,718 B → ~25,300 B (~12.7 k → ~6.3 k tokens, **−50%**):
18,746 B of schema copies, ~2,100 B of domain-description prose, ~4,530 B of shared-argument prose (each
figure computed by serializing the proposed replacement text). No tool removed and no selection cue lost:
`list_domains` remains the endpoint/scope answer, one 1,571 B call instead of 1,394 B paid every turn.

### 3.3 F4: an estimate answer that is honest

Replace the `else` branch at `src/aggregate-tools.ts:186-189`:

```ts
} else {
  lines.push(
    'No estimate available: the car reports no usable energy (dischargeInfo.energyAvailable) and no ' +
    'time-to-full, so energy and duration cannot be computed. Call get_car_status for the current charge ' +
    'level, or plug in and call again for the car’s own time-to-full.',
  );
}
```

and only print the car's own estimate line when it exists (as today), with the no-estimate case returning
`data:{estimateable:false}` so the client can branch.

### 3.4 F13: replacement instructions (882 B → ~824 B, same information plus explicit routing)

```
Polestar Data Portal (M2M) is READ-ONLY: every tool is a GET, no command reaches the car.
Omit vin on a one-vehicle credential; call list_vehicles only when you need the VIN or the labels.
Mapping: how is the car → get_car_status; locked/closed → is_car_secure; warnings/service →
get_needs_attention; charging time → get_charging_estimate; charging setup → get_charging_setup (one call,
not seven); cheapest hours → plan_cheapest_charge.
Domain data is reported by the car: a field can be absent and a whole domain can answer
DATA_NOT_AVAILABLE. That is missing data, not "no" and not zero.
Data has an age per domain; read it before treating a value as current.
Failures carry code, httpStatus when upstream answered, requestId when one exists, and a hint with the
next call. Quote requestId only when it is present.
```

(The `get_charging_setup` clause is contingent on F8; drop that clause if F8 is not built. Any tool name in
the instructions must be registered; `scripts/check-tool-refs.mjs` fails CI otherwise.)

---

## 4. Top 5 changes by leverage

1. **F1: absence vocabulary + aggregate disclosure.** Highest behavioural leverage: stops "No data" being
   answered as "No", and stops a 3-of-5-domain briefing looking complete. Small edit, one shared sentence,
   one line in each affected aggregate. Concrete text in §3.1.
2. **F2: halve `tools/list`.** ~6.3 k tokens recovered per turn by compacting one repeated schema and
   deleting endpoint/scope boilerplate; zero capability loss because `list_domains` holds the mapping.
   Concrete schema/descriptions in §3.2.
3. **F3: stop paying twice for the same answer.** Drop `structuredContent.message`/`tool`, stop sending
   the raw payload twice, keep `hint` once. Per-call wire bytes fall 25-60% (raw calls ~2.8 KB → ~1.1 KB)
   and the structured half becomes something a client can actually render.
4. **F8: `get_charging_setup`.** Converts the seven-call charging question into one cached aggregate,
   matching what `get_car_status` already did for telemetry; the cheapest way to raise the ceiling on
   "answer the whole question" behaviour.
5. **F4+F5: make failure and non-answer text direct the next call.** "No estimate … call
   get_car_status" and "Server refused: …" instead of "Polestar API error … report the requestId". Both are
   small text edits that change what the model does next, not just how it sounds.

---

## 5. Reproduction

```sh
# protocol facts + byte measurements (fixture mode, offline)
node --import tsx analysis/surface/capture.ts     # tools/list, 12 tool calls, resource read, completion
node --import tsx analysis/surface/capture2.ts    # raw:true duplication, failures, partial fixtures
node --import tsx analysis/surface/capture3.ts    # DATA_NOT_AVAILABLE aggregates, 12-vehicle resources/list
node --import tsx analysis/surface/probe-data.ts  # 24 zero-argument tools: 1 returns `data`
npm run smoke                                     # registry: 26 tools, 24 callable with no args; SMOKE_OK
npm run smoke-http                                # HTTP_SMOKE_OK; subscriptions refused over stateless HTTP
node --import tsx scripts/list-tools.ts           # 26 names; --detail for titles
```

Evidence files: `analysis/surface/probe-data.ts` (output: `callable=24 withData=1`),
`analysis/surface/evidence/tools-list.json`, `initialize.json`, `measurements.json`,
`calls.json`, `capture2.json`, `capture3.json`, `resource-read.json`, `resource-templates.json`,
`prompts-list.json`.

**Caveats.** Token figures are byte/4 estimates, not tokenizer output (no tokenizer is available offline
without installing one). The partial-fixture experiments substitute a captured `DATA_NOT_AVAILABLE`
envelope for whole-domain fixtures; they exercise the same `null` path the live API produces
(`src/client.ts:150-152`), but they are not a live capture. Multi-vehicle and elicitation behaviour could
not be observed over stdio beyond the unit tests: the fixture has one vehicle.
