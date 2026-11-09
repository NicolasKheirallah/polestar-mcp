# Architecture and domain-depth audit

Lane 1 of the polestar-mcp deep dive. Scope: `src/domains.ts`, `src/server.ts`, `src/client.ts`,
`src/vehicle-read.ts`, `src/tool-output.ts`, `src/config.ts`, `src/bind.ts`, `src/tools.ts`, and
the tests that touch them, judged against `AGENTS.md`, `docs/architecture.md`,
`CONTRIBUTING.md` and the design vocabulary those files declare (module, interface, depth, seam,
adapter, leverage, locality, deletion test).

- Repo: `/Users/nicolaskheirallah/Documents/GitHub/polestar-mcp`
- Baseline: `master` at `dc50017` ("Bump @modelcontextprotocol/server from 2.3.1 to 2.4.0 (#16)"), working tree clean before this audit
- Node 22.23.2, dependency set as installed (`@modelcontextprotocol/server` 2.4.0)
- Read-only audit: no tracked file was edited. Only `analysis/arch/` was written.

## Verdict

The two claims the design rests on are mostly true but not fully true, and the gap is where the
next bug lives.

`PolestarClient` is a genuinely deep module: three public methods, and behind them the token
lifecycle, the headers, the envelope, the identity check, the null rule and the error shape.
`failure.ts` and `tool-output.ts` carry real depth in a small interface. The Domain registry is a
real registry: the TTL, the sampler set, the tool names, the scopes and the contract test all read
the rows rather than restating them.

What is not true is the sentence in `docs/architecture.md:70` that "everything else derives from
those rows". The Domain *kind* is spelled in six places, including two places that decide whether
a route works at all. The *resource URI space* is built by hand in `server.ts:278,285` and parsed
in `domains.ts:404`, so the grammar the registry claims to own has a second author. And the
"one deep module, thin tools" claim is weakened at the tool interface: `ToolSpec.run` is typed
narrower than the SDK callback it is passed to, so the protocol's multi-round-trip shape cannot be
expressed at the seam that would need it.

`server.ts` is not a god module in the usual sense: the composition root is correctly the only
place wiring lives. It is two modules in one file. About 180 lines are composition, about 250 are
process entrypoint, and 147 lines are surface content (resource registration and three prompt
bodies) that are neither. Those 147 lines are the only behaviour in the tree that can be exercised
only by spawning a server.

Nothing here is critical: the suite is green (111 tests), `npm run smoke` passes, and the security
rules that matter (location refusal at the request layer, delegation allowlist, HTTP bind rule,
fail-closed budget) are in the right modules. The findings are about leverage being left on the
table and about a few claims that have stopped being enforced.

## Answers to the brief's seven questions

1. **Where is the design carrying real depth?** `client.ts:72-207` (envelope, identity, null rule,
   401-once, delegation as an immutable view), `failure.ts:19-116` (one closed tuple, three
   derivations, hint table keyed by the union), `tool-output.ts:70-179` (one result envelope plus
   one advice table), `domains.ts:50-340` (rows), `bind.ts:21-37` (the whole HTTP risk decision as
   one pure function). Where it is shallow or duplicated: F1, F2, F11 and the deletion ledger.
2. **Does every seam earn its keep?** Most do. `bind.ts` and the `ToolSpec` value seam clearly do.
   Three do not: the sampler's `sample` callback (F12), `caching-transport.ts:40-43`'s throwing
   lookup (F12), and `client.ts:181-189`'s private `request` helper with one call site (F12).
   The transport seam itself is sound but the cache adapter drops half of its request contract
   (F4).
3. **Is `server.ts` doing too much?** The wiring is in the right place; the file is doing three
   jobs (F6). Split prompts and resources out as values, keep `buildEngine`/`createMcpServer`/
   `serveHttp`/`main` here.
4. **Is the Domain registry one source of truth?** For tool names, scopes, TTLs, sampling and the
   contract test, yes (verified: `contract.test.ts:126-149` derives them). Not for the kind (F1)
   and not for the resource URI space (F2). Both are silent-failure directions.
5. **Cycles, leaks, modules reaching past their neighbour?** One real import cycle
   `client.ts -> domains.ts -> client.ts` (F1). One module of the read layer imports the MCP SDK
   (`vehicle-read.ts:1`) to read multi-round-trip input (F3). `server.ts` does not use the
   registry's own lookup function for resources, and disagrees with it on case (F2). The cache
   adapter ignores the identity headers the seam passes it (F4).
6. **What behaviour can only be checked through a live protocol or a large harness?** Prompt text
   and resource registration (F6: no unit test calls `resources/read` or `prompts/list`; only
   `scripts/smoke.ts:100-140`). The real SDK callback context shape (F3, mirrored by hand at
   `tool-output.ts:181-194`). The fixture containment refusal (F12a): no route can reach it.
7. **Comments that describe protection nothing applies?** Four: `transport.ts:128` (says no route
   reaches the guard), `docs/check-docs.mjs:195` (says "every POLESTAR_* variable in src/" while
   reading two files), `server.ts:37-40`+`SECURITY.md:36` (candidate files, plural, one path),
   `caching-transport.ts:36-37` (names the vehicle list as a default-TTL case while `ttlFor`
   handles it earlier). Details in F7 and F12.

## Findings at a glance

Ranked by severity first, then by how much behaviour a fix restores per line changed. Effort:
S under an hour, M a focused change with test updates, L a multi-module refactor.

| # | Sev | Effort | Finding | Primary evidence |
| --- | --- | --- | --- | --- |
| F1 | high | S | Domain kind is spelled six times; `client.ts` and `domains.ts` import each other; a new kind fails silently in cache and fixtures | `client.ts:5`, `domains.ts:11-14,390`, `server.ts:263`, `subscriptions.ts:13`, `sampler.ts:126`, `transport.ts:75` |
| F2 | high | S | Resource URI grammar and registry lookup are duplicated in `server.ts`; the registry's parser and the resource handler disagree on case | `server.ts:278,285,307,309` vs `domains.ts:376-379,404-423` |
| F3 | medium | M | `ToolSpec.run` is narrower than the SDK tool-result union; the documented multi-round-trip elicit cannot be expressed; SDK context re-declared by hand | `tools.ts:18-31,41-55`, `vehicle-read.ts:1,62-112`, `tool-output.ts:181-194`, `docs/architecture.md:98` |
| F4 | medium | S | The cache adapter ignores `request` headers in its key, so one identity's payload can be served to another identity's call | `caching-transport.ts:83,114`, `client.ts:193-200`, `server.ts:97-114` |
| F5 | medium | M | `ToolDeps.client` is the concrete `PolestarClient`; 20 `as unknown as` casts switch off the typecheck gate in tool tests | `tool-output.ts:51`, 20 sites in `test/` |
| F6 | medium | M | `server.ts` is composition plus entrypoint plus 147 lines of surface content; prompts and resources are only reachable over the protocol | `server.ts:263-336,338-410`, no unit test calls them |
| F7 | medium | S | `polestar_status` names a variable the server never reads; the env doc gate scans two files and claims all of `src/`; "vice versa" is not checked | `system-tools.ts:54`, `docs/check-docs.mjs:195-205`, `CONTRIBUTING.md:60` |
| F8 | medium | S | `DATA_NOT_AVAILABLE` is not cached, so every read of an absent Domain spends live quota; the aggregate "usually zero" claim is false there | `caching-transport.ts:114`, `client.ts:150`, `runtime.test.ts:201-213`, `docs/architecture.md:86,111` |
| F9 | low | S | Location privacy policy is a Domain-specific fact in two modules instead of a registry row | `client.ts:140`, `server.ts:123`, `domains.ts:147-165` |
| F10 | low | S | URI parsers throw `URIError` on untrusted percent escapes instead of returning `undefined`; the subscription path rejects | `domains.ts:416-423`, `server.ts:307`, `subscriptions.ts:42,57` |
| F11 | low | S | Tool name derivation has two spellings; the structured envelope does not use the registry function | `domains.ts:362-364`, `vehicle-read.ts:280` |
| F12 | low | S | Unreachable guards, no-op code, test-only exports, and comments that promise more than the code applies | `transport.ts:128-141`, `caching-transport.ts:40-43`, `domains.ts:413`, `server.ts:445,41-45` |

## F1 (high, S): the Domain kind is not a registry row, it is a union in six places

**Evidence**

- `client.ts:5` declares `export type DomainKind = 'telemetry' | 'charging'`.
- `domains.ts:11-14` imports that type from `client.ts` and re-exports it, while `client.ts:1`
  imports `domainRequestPath` and `VEHICLES_PATH` from `domains.ts`. The graph probe reports one
  cycle: `client.ts -> domains.ts -> client.ts`.
- The same closed union is spelled again at `domains.ts:390` (the route regex
  `/vehicles?\/([^/]+)\/(telemetry|charging)\/([a-z-]+)$/i`), `server.ts:263`
  (`RESOURCE_KINDS`), `subscriptions.ts:13` (the `read` signature), `sampler.ts:126`
  (`SAMPLED_DOMAINS`), and in prose at `transport.ts:75`.
- A kind the regex does not know degrades silently: `caching-transport.ts:134-139` falls back to
  `DEFAULT_TTL_MS` (60 s at `:38`) when `parseDomainPath` returns undefined, and
  `transport.ts:100-102` answers `unhandled route` for the fixture adapter. Neither is an error
  the registry can fail on; both are quiet wrong behaviour, which is the exact failure mode
  `domains.ts:1-10` was written to eliminate.

**Verification**

```
node analysis/arch/probe-graph.mjs
# modules: 26
# cycles: client.ts -> domains.ts -> client.ts

git grep -n "'telemetry' | 'charging'\|RESOURCE_KINDS\|(telemetry|charging)" -- src/
# client.ts:5, domains.ts:390, sampler.ts:126, subscriptions.ts:13, server.ts:263
```

**Why it matters.** `docs/architecture.md:70` and `CONTRIBUTING.md:96-102` present "add one row" as
the extension path. Adding a Domain inside an existing kind really is one row. Adding a *kind*
(for example a read-only `software` or `vehicle-state` family) is six edits and at least two of
them fail without a failing test: the route grammar and the resource list. The type cycle also
means the registry cannot be read or reasoned about without the deep client, which inverts the
dependency direction the diagram shows.

**Improvement.** Move the kind vocabulary to the registry module: `export const KINDS =
['telemetry', 'charging'] as const; export type DomainKind = (typeof KINDS)[number];` in
`domains.ts`, delete the re-export at `domains.ts:11-14`, have `client.ts` import the type from
`domains.ts` (the runtime edge stays one-way: client imports the path builder, domains imports
nothing from the client). Derive `RESOURCE_KINDS`, the `DOMAIN_ROUTE` alternation, the
`subscriptions.ts` signature and `sampler.ts`'s literal from `KINDS`.

**Risk.** Low. The only runtime behaviour touched is the regex alternation, and the contract test
already pins `domainPath`/`parseDomainPath` (see the failure test below).

**How the improvement could fail (test or probe).** Add a contract test that iterates `KINDS` and
asserts for a synthetic row of each kind: `domainPath` round-trips through `parseDomainPath`, the
resource template parses through `parseResourceUri`, and `RESOURCE_KINDS` deep-equals `KINDS`. If
deriving the regex from `KINDS` loses the optional plural `vehicles?`, `contract.test.ts:152-156`
fails. If someone deletes the cycle but leaves `client.ts` exporting a second union, the probe
command above still prints the two declarations; make that grep the check.

**Deletion test.** Delete `RESOURCE_KINDS` and the literal unions in `subscriptions.ts` and
`sampler.ts`: complexity concentrates in one declaration. Keep the regex, but derive its
alternation. Delete the type re-export; it is an indirection that hides where the fact lives.

## F2 (high, S): the resource URI space has a second author, and the two lookups disagree

**Evidence**

- The resource template string is built by hand: `server.ts:278`
  (`polestar://vehicle/{vin}/${kind}/{domain}`).
- The `list` callback builds the same URI again, also by hand: `server.ts:285`, and the
  template variable names (`{vin}`, `{domain}`) are literal there and read at `server.ts:307-308`.
- The read handler decodes the VIN by hand (`server.ts:307`) and looks the Domain up with
  `DOMAINS.find((d) => d.kind === kind && d.name === domain)` (`server.ts:309`), an exact-match
  lookup that bypasses `findDomain` (`domains.ts:376-379`), which is case-insensitive.
- `domains.ts:381-403` says the resource URI "arrives here" and `parseResourceUri`
  (`domains.ts:404-414`) parses the other side. Construction has no equivalent. The parse is
  case-insensitive and canonicalising; the resource handler is not.

**Verification**

```
node --import tsx --input-type=module -e "
const {DOMAINS,findDomain}=await import('./src/domains.ts');
console.log(DOMAINS.find(d=>d.kind==='Telemetry'&&d.name==='Battery')===undefined ? 'exact match: undefined' : 'found');
console.log(findDomain('Telemetry','Battery')?.name ?? 'findDomain: undefined');
"
# exact match: undefined
# findDomain: battery
```

**Why it matters.** This is the same defect class `domains.ts:381-389` documents as fixed for
paths ("Three regexes used to spell this, one of them differently"). For resources the count is
four: the template, the list builder, the read decode, and the parser in `domains.ts`. A change to
the resource shape is a four-site edit and the smoke run only checks the builder against a
hand-copied literal (`scripts/smoke.ts:104,107,121`), not against the parser. The case divergence
is observable today: `polestar://vehicle/<vin>/Telemetry/Battery` parses through
`parseResourceUri` and subscriptions, but the resource read answers "Unknown telemetry domain
Battery". `docs/architecture.md:70` lists "the resource URI space" as derived from the rows.

**Improvement.** Add `resourceTemplate(kind)` and `resourceUri(vin, kind, name)` to `domains.ts`
next to `domainPath`, use both in `server.ts`, and use `findDomain(kind, domain)` in the read
handler. Keep the template variable names in the same function so `list`, `complete` and the
handler cannot drift.

**Risk.** Low. One string shape changes in one module; subscriptions parse the same grammar.

**How the improvement could fail.** A contract test that iterates `DOMAINS` asserting
`parseResourceUri(resourceUri(vin, d.kind, d.name))` deep-equals `{vin, kind, name}`, plus one
assertion that the template string equals `resourceTemplate(kind)`. A smoke call to
`resources/read` with mixed case should now answer data, not "Unknown". If `ResourceTemplate`
requires a different brace syntax than `{vin}`, the template assertion is the first thing to fail.

**Deletion test.** Delete the hand-built URI at `server.ts:285` and the literal template at
`:278`: the grammar concentrates in `domains.ts`. Do not delete the parsers instead, that spreads
parsing back across the cache, the fixture adapter and subscriptions.

## F3 (medium, M): the tool interface is narrower than the SDK callback, so the documented elicit flow cannot exist

**Evidence**

- `tools.ts:30` types `run(args, ctx): Promise<ToolResult>`; `tools.ts:41-55` registers it directly
  as the SDK handler and casts at `:52`.
- The installed SDK types the handler result as a union:
  `node_modules/@modelcontextprotocol/server/dist/mcp-BCJHyo7l.d.mts:3540`
  `type ToolCallback<Args> = BaseToolCallback<CallToolResult | InputRequiredResult, ...>`.
- The SDK also documents `elicitInput` as throwing on the 2026-07-28 era and tells servers to
  return `inputRequired(...)` instead (`.../mcp-BCJHyo7l.d.mts:2232-2242`). The installed core
  still negotiates at most 2025-11-25
  (`node_modules/@modelcontextprotocol/core/dist/schemas-DscsoNZN.mjs:4-11`), so this is a
  forward-compatibility gap and an interface-depth gap, not a live bug.
- `vehicle-read.ts:62-64` and `docs/architecture.md:98` say the server can ask the client to pick
  through the 2026-07-28 multi-round-trip flow. The code reads `inputResponses`
  (`vehicle-read.ts:82`) and falls back to `elicitInput` (`:90-97`); the catch at `:98-104`
  rethrows the original `AMBIGUOUS_VIN`. Nothing in `src/` ever returns `InputRequiredResult`:
  `git grep -n "inputRequired" src/` matches nothing.
- `runtime.test.ts:781-810` tests a hand-built `inputResponses` state the server has no way to
  create, which is why the gap is invisible to the suite.
- The same narrowing forces the SDK context to be re-declared by hand at `tool-output.ts:181-194`
  ("Verified against the real runtime shape rather than assumed"), so SDK drift cannot fail
  typecheck.

**Verification**

```
git grep -n "inputRequired\|acceptedContent\|inputResponses" -- src/
# src/tool-output.ts:192, src/vehicle-read.ts:82 only (no inputRequired)

grep -n "type ToolCallback<" -A 1 node_modules/@modelcontextprotocol/server/dist/mcp-BCJHyo7l.d.mts
# 3540:type ToolCallback<Args ...> = BaseToolCallback<CallToolResult | InputRequiredResult, ...>

grep -n "LATEST_PROTOCOL_VERSION = " node_modules/@modelcontextprotocol/core/dist/schemas-DscsoNZN.mjs
# 4:const LATEST_PROTOCOL_VERSION = "2025-11-25";
```

**Why it matters.** `tools.ts:5-17` argues that the spec seam is the shared interface of caller,
test and registrar. That is the right argument, and it is why narrowing it matters: the one
protocol capability the docs promise at the tool layer is exactly the thing the interface cannot
carry. When the SDK starts serving the modern era, this server silently degrades to an
`AMBIGUOUS_VIN` error where the docs promise a question, and the manual context mirror means the
compiler will not say so.

**Improvement.** Widen the spec result to the SDK's union (or to a small `ToolOutcome` with a
`needsInput` variant that `registerTools` maps to `inputRequired(...)`), have `vehicleFor` return
that third outcome, and map it in `domain-tools.ts:68`. Keep the legacy `elicitInput` branch for
old clients. Type `ToolContext` from the SDK's exported context type where possible, or keep the
manual type but add a protocol-level test that exercises a real handler context (the smoke run
already does for legacy).

**Risk.** Medium. The SDK validates tool results, and `structuredContent` has to stay valid for
the normal path. The smoke loop (`scripts/smoke.ts:69-80`) calls every no-argument tool and
asserts `ok/message`, so a widened result shape needs that loop to handle an input-required
answer, which is also the proof it works.

**How the improvement could fail.** A probe that negotiates a modern revision with a two-VIN
fixture must observe an input request, not `AMBIGUOUS_VIN`. Today no such client exists in the
tree, so the test is only meaningful once the SDK serves that era; until then the honest check is
that `ToolSpec.run` accepts `InputRequiredResult` and `registerTools` forwards it, asserted by a
unit test that registers a fake spec returning one. If the SDK rejects the result, that unit test
fails first.

## F4 (medium, S): the cache adapter drops half of the Transport seam's request, so identity stops at the cache

**Evidence**

- The seam is `Transport.fetch(url, request)` (`transport.ts:21-23`); `request` carries headers
  (`transport.ts:6-10`).
- `CachingTransport` keys only on the URL (`caching-transport.ts:83`) and never inspects
  `request.headers`. It caches every response below 400 (`:114`).
- The client puts identity in headers, not in the URL: `authorization`, `x-client-id`,
  `x-delegated-account-id` (`client.ts:193-200`), and a delegated call gets a new client view that
  shares the same transport (`client.ts:85-88`, wired at `server.ts:97-114`).
- Probe: two identical URLs, different headers, one inner call; the second identity receives the
  first identity's body.

**Verification**

```
node --import tsx --input-type=module -e "
const {CachingTransport}=await import('./src/caching-transport.ts');
const {domainRequestPath}=await import('./src/domains.ts');
let calls=0; const seen=[];
const inner={async fetch(url,req){calls++;seen.push(req.headers);return {status:200,body:JSON.stringify({data:{batteryChargeLevelPercentage:11}})}}};
const cache=new CachingTransport(inner,{now:()=>1000});
const url='https://x'+domainRequestPath('YSMTEST22PL000001','telemetry','battery');
await cache.fetch(url,{headers:{'x-client-id':'self'}});
await cache.fetch(url,{headers:{'x-client-id':'self','x-delegated-account-id':'partner-a'}});
console.log('inner calls =',calls, '| second headers sent =', seen[1] ?? 'cache hit');
"
# inner calls = 1 | second headers sent = cache hit
```

**Why it matters.** This is a leaky abstraction, not just a cache detail: the adapter silently
narrows the interface it implements by treating `request` as irrelevant. The consequence, which
lane 2 owns end to end, is that an allowlisted delegated read can seed the cache for a VIN and a
later call without that delegation can be served the cached payload. The delegation allowlist and
the API's own authorization answer are both above the cache, so a cache hit bypasses them. I
confirmed the adapter behaviour; the exploit path needs the lane 2 harness (a credential that can
see the VIN and a credential that cannot).

**Improvement.** Either key the cache on the identity-bearing headers (or a hash of them), or
document the transport contract as URL-only and have the composition root place the cache below
a per-identity client instance. The first is smaller: add `request.headers` to the key, and add a
test that two identities get two inner calls.

**Risk.** Medium. Cache hit rates fall for the delegated case (rare), and the token POST is
already excluded by method (`caching-transport.ts:79`). The wrong fix is caching per URL and per
token, which would defeat the cache on every token rotation.

**How the improvement could fail.** A test must show (a) same identity: one inner call, (b)
different delegated account: two inner calls, (c) token rotation only (same identity, new
Authorization): still one inner call, because the token is not identity. If the key includes the
whole header map, (c) regresses and the cache hit rate collapses silently, so assert the stats.

## F5 (medium, M): the tool layer depends on the concrete client class, so tests switch typecheck off

**Evidence**

- `ToolDeps.client` is `PolestarClient`, the class (`tool-output.ts:50-60`); `VehicleScope.client`
  repeats it (`vehicle-read.ts:26`); `HistorySampler` takes it (`sampler.ts:41`).
- Tests fake it by assertion, 20 times: `git grep -c "as unknown as PolestarClient" test/` gives
  charge-model 1, runtime 14, server-seams 5. Examples: `runtime.test.ts:217,354,442`,
  `server-seams.test.ts:182,196`.
- Contrast the seam that does earn its keep: `Transport` is a one-method interface
  (`transport.ts:21-23`) and the tests implement it without casts (`test/helpers.ts:8-19`).

**Verification**

```
git grep -c "as unknown as PolestarClient" -- test/
# test/charge-model.test.ts:1  test/runtime.test.ts:14  test/server-seams.test.ts:5

git grep -n "client: PolestarClient" -- src/
# src/tool-output.ts:51
```

**Why it matters.** `CONTRIBUTING.md:44` lists `npm run typecheck` as a CI gate precisely because
"a red build can hide behind green tests". At the tool layer those casts are where the gate stops:
a renamed client method, or a tool body that starts calling a method its fake does not have,
compiles and fails at runtime. It also makes the tests larger than the behaviour: to test one
tool body you must fake the whole client surface, which is why `runtime.test.ts` is 48 KB.

**Improvement.** Declare a narrow interface in `client.ts` (`VehicleReads`: `vehicles()`,
`resolveVin()`, `domain()`, `forDelegation()`) that `PolestarClient` implements, and type
`ToolDeps.client`, `VehicleScope.client` and `HistorySampler`'s first parameter as it. The
interface belongs next to the class, not in the tool modules, so the dependency still points at
the deep module.

**Risk.** Low. It is a type-only change; the class already satisfies it.

**How the improvement could fail.** Remove the casts from two test files and run `npm run
typecheck`: any fake missing a method must now be a compile error, which is the point. Add one
deliberately incomplete fake under `@ts-expect-error` as a positive control so the check cannot go
quiet if the interface is widened to `any`. If a tool genuinely needs a method outside the
interface, the typecheck failure names it, and that is the interface being wrong, not the test.

## F6 (medium, M): server.ts is composition plus entrypoint plus surface content, and the surface content is not locally testable

**Evidence**

- One file, 612 lines (`wc -l src/server.ts`), with these responsibilities: engine composition
  `:60-132`; surface factory `:177-261`; resource registration `:263-336`; three prompt bodies
  `:338-410`; HTTP lifecycle `:413-451`; signal shutdown `:453-470`; sampler start `:472-487`;
  CLI parsing `:489-519`; env bootstrap and startup logging `:521-584`; bin detection `:586-612`.
- Only six exports (`grep -n "^export " src/server.ts`): `Engine`, `buildEngine`, `McpSurface`,
  `McpSurfaceOptions`, `createMcpServer`, `main`. `registerResources` (`:265`) and
  `registerPrompts` (`:338`) are module-private.
- Unit tests never touch them: `git grep -n "resources/read\|prompts/list\|registerResource(" test/`
  returns nothing. Only `scripts/smoke.ts:100-140` exercises them, by spawning a server.
- The prompts are string content inside closures (`server.ts:341-409`), while the repo already
  made tools a value for exactly this reason (`tools.ts:5-17`: "A spec is a value, so the caller's
  interface and the test's interface are now the same seam").

**Verification**

```
wc -l src/server.ts
grep -n "^export " src/server.ts
git grep -n "resources/read\|prompts/list\|registerResource(" -- test/ || echo "no unit test reaches the resource/prompt surface"
# no unit test reaches the resource/prompt surface
```

**Why it matters.** The question "is the composition root correctly the only place wiring lives"
has a split answer. It is the only place wiring lives, and that is right. But the file also owns
presentation policy (prompt text, resource listing shape) and process lifecycle, and the
presentation half is the part the suite cannot see. That is why F2's resource handler divergence
survived: `runtime.test.ts:432` tests `readDomain` directly, so the handler around it is only
covered by the one happy path in the smoke run.

**Improvement.** Two extractions, both keeping `server.ts` as composition root:
`prompts.ts` exporting `PromptSpec[]` (name, title, description, argsSchema, render) registered by
the same registrar pattern as tools, and `resources.ts` exporting
`registerResources(server, {readDomain, listVehicles})` so the handler can be called with a fake
read. Move `handleCliArgs` and `secretsFileCandidates` beside `main` if the entrypoint split is
still wanted; they are already testable through `main(env)`.

**Risk.** Low. The moves are mechanical and the smoke run covers the wired surface. The one real
risk is duplicating `readDomain`'s dependency bag; pass the same `ToolDeps` rather than inventing a
second one.

**How the improvement could fail.** A unit test that calls the new `registerResources` with a fake
server and asserts two registrations per kind plus the mixed-case lookup from F2. If the fake
cannot represent `ResourceTemplate`'s `list`/`complete` callbacks, that is the seam saying the
handler still depends on too much; that failure is information, not noise.

## F7 (medium, S): operator advice names a variable the server never reads, and the gate that should catch it scans two files

**Evidence**

- `system-tools.ts:54` prints "Cache: off (POLESTAR_CACHE_DISABLED, ...)".
  `git grep -n POLESTAR_CACHE_DISABLED` finds exactly two hits: that line and the test that
  locks it in (`test/server-seams.test.ts:251`). The real variable is `POLESTAR_CACHE`
  (`config.ts:86,280`, documented in `docs/getting-started.md:96` and `README.md:196`).
- The gate's own comment says "every POLESTAR_* variable in src/ is documented", but the
  implementation reads only `src/config.ts` and `src/server.ts`
  (`docs/check-docs.mjs:195-205`). It prints `DOCS_ENVVARS_OK` while the phantom exists.
- `CONTRIBUTING.md:60` claims the gate proves the reverse direction too ("and vice versa"); the
  implementation only checks code names against the doc, never doc names against
  `KNOWN_ENV_VARIABLES`.
- Probe: an operator who follows the advice gets the unrecognized-variable warning the registry
  exists to make loud, and the cache stays on.

**Verification**

```
node docs/check-docs.mjs envvars
# DOCS_ENVVARS_OK   (green despite the phantom)

node --import tsx --input-type=module -e "
const {unknownEnvVariables,loadConfig}=await import('./src/config.ts');
console.log(JSON.stringify(unknownEnvVariables({POLESTAR_CACHE_DISABLED:'1'})));
console.log('cacheDisabled from POLESTAR_CACHE_DISABLED=1:',loadConfig({POLESTAR_FIXTURES_DIR:'/tmp',POLESTAR_CACHE_DISABLED:'1'}).cacheDisabled);
"
# [{"name":"POLESTAR_CACHE_DISABLED","suggests":"POLESTAR_CACHE"}]
# cacheDisabled from POLESTAR_CACHE_DISABLED=1: false
```

**Why it matters.** It is a user-facing defect in the self-observation tool, and it makes the
envvar gate's comment a claim nothing enforces, which `AGENTS.md` calls a defect in its own right.
It also shows the gate's scope can narrow without the green result changing, the failure mode the
hygiene gate guards against with a file-count assertion.

**Improvement.** Print `POLESTAR_CACHE=off`. Derive the gate's names by scanning every
`src/**/*.ts` (or by reading `KNOWN_ENV_VARIABLES` plus scanning for names outside it), check both
directions, and give the gate a positive control (a temporary file with a planted name) so a green
run proves it fires. Update `test/server-seams.test.ts:251` to the real variable.

**Risk.** Low.

**How the improvement could fail.** Plant a fake name in a scratch copy and assert the gate exits
non-zero; then remove it. If scanning all of `src/` produces names that are prose rather than real
variables (the current scan already would, e.g. comments), the check needs to read names from
`process.env.X` and `env.X` accesses plus `KNOWN_ENV_VARIABLES`, and the positive control is what
keeps that honest.

## F8 (medium, S): absence is an error to the cache and not an error to the client, so absent Domains spend quota forever

**Evidence**

- `client.ts:150-152` maps a 404 whose code is `DATA_NOT_AVAILABLE` to `null`, and
  `docs/architecture.md:130` lists it as "not an error".
- `caching-transport.ts:114` caches only `response.status < 400`, so that 404 is never stored;
  `caching-transport.ts:83-110` therefore goes to the network on every read of an absent Domain.
- The test that touches this asserts only that a 500 is not cached (`runtime.test.ts:201-213`);
  nothing asserts or decides the absence case.
- `aggregate-tools.ts:23-25` promises "an aggregate costs at most one live call per constituent
  domain and usually zero", and `docs/architecture.md:86` repeats it; `get_car_status` reads five
  Domains (`aggregate-tools.ts:45-51`).
- Probe: two identical absent reads, two inner calls; two identical present reads, one inner call.

**Verification**

```
node --import tsx --input-type=module -e "
const {CachingTransport}=await import('./src/caching-transport.ts');
const {domainRequestPath}=await import('./src/domains.ts');
let calls=0;
const absent={async fetch(){calls++;return {status:404,body:JSON.stringify({error:{code:'DATA_NOT_AVAILABLE',message:'none',httpStatus:404}})}}};
const url='https://x'+domainRequestPath('YSMTEST22PL000001','charging','target-soc');
const cache=new CachingTransport(absent,{now:()=>1000});
await cache.fetch(url); await cache.fetch(url);
console.log('absent reads -> inner calls', calls, '| entries', cache.stats.entries);
"
# absent reads -> inner calls 2 | entries 0
```

**Why it matters.** The daily allowance is the API's only hard resource (`docs/architecture.md:135`,
`SECURITY.md:57-72`), and the server fails closed to protect it. A car that does not report
`target-soc`, `is-at-charge-location`, or one of the five status Domains turns "usually zero" into
"one live call per aggregate call", forever, and `polestar_status` shows it as ordinary misses.
The docs are internally inconsistent: `docs/architecture.md:111` says "error responses pass
straight through", while `docs/architecture.md:130` and `client.ts:150` say absence is not an
error.

**Improvement.** In `CachingTransport`, cache a 404 whose parsed code is `DATA_NOT_AVAILABLE` for
the Domain's row TTL (the same `ttlFor` value), and keep every other 4xx uncached. That is one
branch in `revalidate` plus one parse helper, and it makes the TTL row mean what `domains.ts:22-27`
says it means.

**Risk.** Medium, because of fixture honesty: `transport.ts:88-96` keeps a missing fixture
(`NOT_FOUND`) distinct from absence (`DATA_NOT_AVAILABLE`) on purpose. If the negative cache is
keyed on status alone, a missing fixture would be frozen as "the car reports nothing", which is the
exact defect that comment forbids.

**How the improvement could fail.** Two tests: (a) two absent reads with the same body hit the
cache and the entry expires after `ttlMs` (advance the injected clock), (b) `NOT_FOUND` and 500 are
still not cached. If (b) fails, the fixture path regressed. Also assert `polestar_status`'s hit
rate includes the negative hits, or the operator cannot see the improvement.

## F9 (low, S): a Domain-specific privacy rule lives in two modules instead of a registry row

**Evidence**

- `client.ts:140` refuses `location` when `allowLocation === false` (request layer, correct layer).
- `server.ts:123` re-checks the same fact in the sampler loop (`domain.name === 'location'`).
- The fact itself is in the row at `domains.ts:147-165` but the row has no field for it, so both
  modules spell the Domain name.

**Verification**

```
git grep -n "name === 'location'\|domain.name === 'location'" -- src/
# src/client.ts:140  src/server.ts:123
```

**Why it matters.** The two copies agree today, so this is a cost, not a bug. The cost is that a
second privacy-sensitive Domain (a future personal-data family) needs two edits, and the forgotten
one is silent: either sampling spends refusals, or a display path sends data the operator disabled.
The registry exists to hold this kind of fact.

**Improvement.** Add `requiresLocationOptIn: true` (or a general `private: true`) to `DomainSpec`;
have `client.ts` refuse when the requested row is flagged (the client can take the flag per
request from its caller, or from a set derived in `domains.ts`), and have the sampler filter by the
same field.

**Risk.** Low. The enforcement stays where the security doc says it is (`SECURITY.md:22-28`), only
the source of the fact moves.

**How the improvement could fail.** A contract test asserting the flagged rows deep-equal a
derived set, plus a probe that loops all rows through `client.domain` with `allowLocation: false`
and asserts exactly the flagged rows refuse. If the flag is wired into the client as a constructor
set, a row added without the flag would sample location while `POLESTAR_ALLOW_LOCATION=false`, so
the contract test must fail for an unflagged row that is not in the set.

## F10 (low, S): untrusted URIs can throw out of parsers documented to return undefined

**Evidence**

- `domains.ts:416-423` runs `decodeURIComponent(rawVin)` on the regex capture and returns
  `DomainRef | undefined`; a malformed escape throws `URIError`.
- `server.ts:307` does the same decode in the resource read handler.
- `subscriptions.ts:42` calls `parseResourceUri` inside `subscribe`/`pollOnce`; the throw escapes
  `subscribe` (the poller's own contract at `subscriptions.ts:6-10` is four methods, none throwing).
- Probe: `%ZZ` and a truncated UTF-8 escape both throw; `poller.subscribe` rejects.

**Verification**

```
node --import tsx --input-type=module -e "
const d=await import('./src/domains.ts');
for (const u of ['polestar://vehicle/%ZZ/telemetry/battery']) {
  try { console.log(u,'=>',JSON.stringify(d.parseResourceUri(u))); }
  catch(e) { console.log(u,'THREW',e.constructor.name); }
}
const s=await import('./src/subscriptions.ts');
const p=s.createSubscriptionPoller({read:async()=>null,budget:{isLow:()=>false},notify:async()=>{},log:()=>{}});
try { await p.subscribe('polestar://vehicle/%ZZ/telemetry/battery'); console.log('subscribe resolved'); }
catch(e){ console.log('subscribe THREW', e.constructor.name); }
"
# polestar://vehicle/%ZZ/telemetry/battery THREW URIError
# subscribe THREW URIError
```

**Why it matters.** An MCP client can send any URI. The parser's contract says an unknown URI is
`undefined`; a malformed one is a protocol error instead of the "Unknown domain" text the resource
handler already has a branch for. It is small, but it is the kind of edge the rest of the codebase
handles deliberately (the router returns `undefined` for unknown Domains, the fixture adapter
distinguishes missing from absent).

**Improvement.** Decode through a helper that returns `undefined` on `URIError`, and use it in
`domains.ts:422` and `server.ts:307`.

**Risk.** Low.

**How the improvement could fail.** Contract tests with `%ZZ`, a lone `%`, and a truncated
multi-byte escape, asserting `undefined`; a poller test asserting `subscribe` resolves and `size`
stays 0. If the try/catch swallows a genuinely double-encoded VIN, the round-trip test in F2
catches it because canonical VINs are not percent-encoded.

## F11 (low, S): tool-name derivation has two spellings and the envelope does not use the registry function

**Evidence**

- `domains.ts:362-364` is the derivation: `get_${domain.name.replace(/-/g, '_')}`.
- `vehicle-read.ts:280` repeats it inline for `structuredContent.tool`.
- `server.ts:313` repeats it again, in a comment.
- Probe: for the battery row the two agree today; nothing fails if one drifts.

**Verification**

```
node --import tsx --input-type=module -e "
const {DOMAINS,toolName}=await import('./src/domains.ts');
const {readDomainFormatted}=await import('./src/vehicle-read.ts');
const vin='YSMTEST22PL000001';
const deps={client:{resolveVin:async(v)=>v??vin,vehicles:async()=>[vin],domain:async()=>({batteryChargeLevelPercentage:50,metaReceivedAt:'2026-01-01T00:00:00.000Z'})},redactVin:false,vehicleLabels:{},delegatedAccounts:[],units:'km',nowMs:()=>Date.parse('2026-01-01T01:00:00Z')};
const row=DOMAINS.find(d=>d.name==='battery');
const out=await readDomainFormatted(deps,row,{}, {});
console.log(out.structuredContent.tool === toolName(row), out.structuredContent.tool);
"
# true get_battery
```

**Why it matters.** `get_target_soc` vs `get_target-soc` in a structured field is a client-visible
break, and the registry function exists precisely so the name is one value. This is the smallest
instance of the duplication pattern behind F1/F2; fixing it is one line and one test.

**Improvement.** Call `toolName(domain)` in `vehicle-read.ts:280`; widen `DomainReader` to include
the name derivation (or pass the spec). Add a contract test over `DOMAINS` asserting the formatted
result's `tool` equals `toolName(row)`.

**Risk.** Low.

**How the improvement could fail.** The contract test above runs every row, so a future Domain with
a new separator fails before a client sees it. If `readDomain` is called with a hand-made
`DomainTarget` (runtime.test.ts:776 does), the widened type must still accept
`{kind, name, scope}`, so keep `toolName`'s parameter structural (`Pick<DomainSpec, 'name'>`).

## F12 (low, S): dead code, unreachable guards, and comments that promise more than the code applies

Each of these is small; together they are the "comment describes protection nothing applies"
category `AGENTS.md` calls a defect, plus two indirections the deletion test rejects.

**Evidence and deletion-test answer**

- a) Fixture containment guard, `transport.ts:124-141`. The comment at `:128` says "No route reaches
  this refusal today", and it is right: every segment is a literal or a registry name, so the
  guard can never fire. `isInside` is tested directly (`runtime.test.ts:929-932`), which proves the
  predicate, not the protection. Decide: either delete the throw and keep the predicate, or
  validate the fixtures root once at construction so the refusal is reachable. Keeping a guard
  plus a comment that it is inert is the pattern the house rule forbids.
- b) `caching-transport.ts:40-43`: `findDomainTtl` throws for an unknown row, but `ttlFor`
  (`:134-139`) only calls it after `parseDomainPath` returned a row, so the throw is unreachable.
  The comment at `:36-37` also names the vehicle list as a default-TTL case while `ttlFor` handles
  it at `:136`. Delete the throw (return `DEFAULT_TTL_MS`), fix the comment.
- c) `domains.ts:413`: `{ ...ref, name: ref.name }` is a no-op spread. Delete it; the probe in F2
  shows the result already equals `parseDomainPath`'s.
- d) `server.ts:445`: `const guarded = httpServer;` is an alias with no purpose. Delete it.
- e) `server.ts:37-40` says "Candidate secrets files, in order" and `SECURITY.md:36` says "the
  first candidate that exists", but `secretsFileCandidates` returns exactly one path (plus the
  override). Either add the candidates the prose implies, or make both singular. Right now the
  loop with `break` at `server.ts:525-541` reads as if more are tried.
- f) Test-only seams in `src/`: `domains.ts:370-372` `domainToolNames` has no production caller
  (`test/config-registry.test.ts:128` only) and `tools.ts:63-67` `toolSpec` is test-only. They are
  reasonable seams, but they should be labelled as test seams or moved under `test/`; otherwise
  the next reader has to grep to learn they are dead in the shipped build. Keep both, mark them.

**Verification**

```
grep -n "No route reaches\|containedPath\|isInside" src/transport.ts
grep -n "findDomainTtl\|DEFAULT_TTL_MS\|private ttlFor" src/caching-transport.ts
grep -n "\.\.\.ref, name: ref.name" src/domains.ts
grep -n "const guarded" src/server.ts
grep -n "domainToolNames(" -r src/ test/
node analysis/arch/probe-graph.mjs   # fan-out and fan-in, unchanged by these deletions
```

**Why it matters.** The repo's own rule is that a claim needs something that can fail. Each item
here is a place where a reader is told a protection exists and nothing can observe it, or a lookup
that can only throw in theory. None of them is dangerous; all of them cost trust in the comment
style that is otherwise this codebase's strongest habit.

**Improvement.** Apply each decision above. For (a), prefer making the refusal reachable over
deleting it, because the fixture root is operator configuration; validate it once in the
constructor and drop the per-lookup comment.

**Risk.** Low.

**How the improvement could fail.** After deleting `findDomainTtl`'s throw, a contract test that
feeds an unregistered path through `ttlFor` (today impossible) asserts `DEFAULT_TTL_MS`; that test
is the documentation. For (a), a constructor rejection test with a fixtures root that is a file or
escapes the tree. If the constructor check never fails, it is the same decoration with a new home.

## Deletion-test ledger

Every seam, adapter or indirection in the scoped modules, and the verdict.

| Indirection | Verdict | Why |
| --- | --- | --- |
| `Transport` one-method seam (`transport.ts:21-23`) | keep | Two real adapters; tests and offline mode run the production path. Deleting it spreads fetch logic into the client and makes fixtures a branch. |
| `CachingTransport` | keep | Owns TTL, single-flight and stale-while-revalidate; the row TTL is its only policy input. Deleting it moves budget policy into the client. |
| `RetryingTransport` | keep | Owns retryable statuses, Retry-After and the minute-window wait; every attempt metered (`retrying-transport.ts:59,68`). Deleting it spreads the wait into every caller. |
| `bind.ts` | keep | 48 lines, a pure decision plus the 401 body; deleting it spreads the HTTP risk rule into an untestable listen path (`server.seams` test at `server-seams.test.ts:5-27`). |
| `ToolSpec` + `registerTools` (`tools.ts:18-55`) | keep | The value seam that makes a handler callable without a protocol client. The result type must widen (F3). |
| `toolSpec()` lookup (`tools.ts:63-67`) | keep, mark test-only | Loud typo handling in tests; no production caller. |
| `vehicleFor`/`readDomains`/`readDomain` (`vehicle-read.ts`) | keep | Three surfaces share one read; `runtime.test.ts:432` proves the tool text and the resource text are the same string. Deleting it reintroduces the four copied epilogues the module documents. |
| `readDomainFormatted` | keep | Thin adapter from `DomainReading` to the result envelope. Deleting it spreads envelope construction into 15 tools. |
| `client.request` private helper (`client.ts:181-189`) | delete | One caller (`vehicles()`); inlining concentrates 8 lines in one body and removes a hop. |
| `findDomainTtl` throw (`caching-transport.ts:40-43`) | delete | Unreachable throw; return the default (F12b). |
| Fixture containment guard (`transport.ts:134-141`) | make reachable, then keep | Otherwise the comment is the defect (F12a). |
| Sampler `sample(vin)` callback (`sampler.ts:25-33`, built at `server.ts:118-128`) | delete | The sampler already takes the client and the registry exports `SAMPLED_DOMAINS`; looping inside `HistorySampler` concentrates the policy in the module named after it and removes a closure from the composition root. Testability is unaffected: the tests fake the client anyway. |
| Hand-built resource URI (`server.ts:278,285`) | delete | Replace with `resourceTemplate`/`resourceUri` from the registry (F2). |
| `RESOURCE_KINDS` (`server.ts:263`) | delete | Derive from `KINDS` (F1). |
| `domainToolNames` (`domains.ts:370-372`) | keep, mark test-only | Same class as `toolSpec`. |

## What is already good

Short list, with evidence, so the report is not only criticism.

- **The Domain rows do real work.** TTL, sampling, scopes, names and descriptions are read from the
  rows, and the contract test proves it rather than restating it: `contract.test.ts:126-149`
  asserts `SAMPLED_DOMAINS` equals the filtered registry and `domainPath` equals the expected
  template. This is the leverage the design claims, and for everything except kind it holds.
- **`client.ts` has real depth.** Three public methods, and behind them the token, headers,
  envelope, identity, null rule, error normalisation and the single 401 retry
  (`client.ts:91-207`). `forDelegation` returns a new view rather than mutating, which is the right
  call for concurrent calls (`client.ts:85-88`).
- **`failure.ts` is a small deep interface.** One tuple, three derivations, and the advice table
  keyed by the closed union so a new minted code without advice is a type error
  (`failure.ts:19-116`, `tool-output.ts:107-124`).
- **`tool-output.ts` puts the output contract in one place**, and `registerTools` attaches it as
  `outputSchema` to every tool (`tools.ts:41-55`), which is why the smoke run can assert
  `outputSchema` on all 26 names and why the envelope cannot quietly change shape.
- **`bind.ts` is a model seam.** The HTTP risk decision is a pure function with the 401 body, and
  the test exercises loopback, routable-without-token, whitespace token and routable-with-token
  (`server-seams.test.ts:5-27`).
- **Budget fails closed before the request goes out**, and every retry attempt is metered
  (`retrying-transport.ts:59,68`, `budget.ts:37-43`). `MinuteWindowMeter` is a separate, real
  ceiling rather than a comment (`budget.ts:96-138`).
- **Posture is checked, not asserted.** `test/posture.test.ts` proves `POLESTAR_ENABLE_WRITES`
  registers nothing and that the consumer-app API has no code path, with a positive control on the
  detector.
- **The gates have positive controls** (`docs/check-docs.mjs` hygiene detectors, the smoke scripts)
  and the CI runs typecheck before tests for the documented reason. The gap is the envvar gate's
  scope (F7), not the idea.
- **History records from the client, not the cache** (`client.ts:167-177`), which is why the cache
  can stay envelope-blind as `docs/architecture.md` claims.

## Top 5 changes by leverage

Leverage here means behaviour restored or failure class removed per unit of change.

1. **F1, make the Domain kind a registry value (S).** One declaration, six deletions, one cycle
   gone, and the documented "add a row" story becomes true for a new kind as well. Highest ratio in
   the report.
2. **F2, derive the resource URI space from the registry (S).** Deletes three duplicate spellings
   of the URI grammar and makes `parseResourceUri` and the read handler agree on case. This is the
   claim in `docs/architecture.md:70` that is currently false.
3. **F4, stop the cache dropping identity (S).** The seam passes headers; the adapter ignores
   them. Until this is fixed, a delegated read can seed a URL for an identity-less call. Highest
   consequence of the small fixes, and lane 2 is the right owner of the end-to-end proof.
4. **F5, type the tool layer against a narrow read interface (M).** Removes 20 unsound casts and
   makes `npm run typecheck` a real gate for the tool modules and their tests. Every later change
   to a tool body gets checked again.
5. **F3, widen the spec result to the SDK tool-result union (M).** The only way the documented
   multi-round-trip elicit can ever exist, and it deletes the pressure that produced the
   hand-mirrored SDK context at `tool-output.ts:181-194`.

Next in line if capacity remains: F8 (negative caching, protects the only hard resource, S) and
F6 (split prompts and resources out of `server.ts`, M, unlocks local tests for the surface).

## Verification log

Baseline, run before any analysis and again at the end:

```
npm run typecheck                     # tsc -p tsconfig.dev.json, exit 0
npm test                              # 111 tests, 111 pass, 0 fail (335 ms)
npm run smoke                         # registry: 26 tools, 24 callable with no args; SMOKE_OK
node docs/check-docs.mjs envvars      # DOCS_ENVVARS_OK
```

Audit commands whose output is quoted above:

```
node analysis/arch/probe-graph.mjs
git grep -n "from '@modelcontextprotocol" -- src/
git grep -n "replace(/-/g" -- src/ test/ scripts/ docs/
git grep -n "inputRequired\|acceptedContent\|inputResponses" -- src/
git grep -c "as unknown as PolestarClient" -- test/
git grep -n "resources/read\|prompts/list\|registerResource(" -- test/
git grep -n "POLESTAR_CACHE_DISABLED" -- .
wc -l src/server.ts
```

The probes in F2, F4, F8, F10 and F11 are inline `node --import tsx` commands, reproduced under
each finding with their observed output. No live Polestar API call was made: every probe uses a
fake transport or a registry fixture.

## Caveats and limits

- **I did not run the whole CI list.** `npm run coverage`, `npm run build`, `smoke-bin`,
  `smoke-http`, `check-secrets`, `check-tool-refs`, `verify-fixtures`, `links` and `hygiene` were
  not run by me. The brief states CI is green on master; the four gates I did run agree.
- **SDK line numbers are dependency-local.** Citations to
  `node_modules/@modelcontextprotocol/...` are for the installed 2.4.0 tree, which is not part of
  the repo. The claim they support is the *type* of the handler result, which is what matters;
  re-check the line numbers after the next dependency bump (the repo is on a dependabot cadence).
- **F3 is forward-looking, not a live bug.** The installed core negotiates at most 2025-11-25, so
  legacy elicitation works today. The finding is that the interface cannot express the modern
  flow the comments and architecture doc already promise; it becomes a live defect when the SDK
  serves that era. I did not run a modern-era client, because the installed SDK cannot negotiate
  one.
- **F4's end-to-end consequence is not proven here.** I confirmed the adapter ignores
  identity-bearing headers and serves the first body to the second identity. Whether a given
  credential pairing can turn that into an unauthorized read depends on the fixture and the
  allowlist, which is lane 2's harness; my claim is limited to the seam and the probe output.
- **Line numbers are at commit `dc50017`.** The tree is clean; if a lane edits files, re-grep
  rather than trusting these numbers.
- **The deletion verdicts are design judgements, stated as such.** The repo's own words for them
  are module, interface, depth, seam, adapter, leverage, locality, deletion test; that vocabulary
  is used here deliberately, and not "component", "service" or "boundary".
- **Read-only respected.** `git status --short` before this audit showed only other lanes'
  untracked `analysis/` directories; nothing tracked was modified. This report and
  `analysis/arch/probe-graph.mjs` are the only files this lane wrote.
