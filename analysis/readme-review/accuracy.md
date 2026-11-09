# README accuracy review

File under review: [README.md](../../README.md) at commit `13e878e` ("Rewrite the README for clarity and completeness"). Reviewer: readme-accuracy. Scope: factual accuracy only, not style or structure. No tracked file was edited, no build or install was run, and no live Polestar API call was made. Fixture data was read, and local source reads only.

Cross-checked against [src/](../../src), [test/](../../test), [package.json](../../package.json), [server.json](../../server.json), [.env.example](../../.env.example), [SECURITY.md](../../SECURITY.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), and [docs/](../../docs).

## Bottom line

The README is substantially accurate. Every headline number checks out: 26 tools by default and 36 with history, 15 domains split 8 telemetry and 7 charging, prompts 2 and 3, 2 resource templates, the budget constants (10,000 per day, 100 per minute, 80 and 90 percent guards), the cache TTLs, the retry attempt count, the Node 20.11 floor, all 29 configuration variables and their defaults, and the npm scripts.

Four claims need fixing before this is accurate as a reference:

1. The sample output block shows a colon after the vehicle label, while the renderer emits a comma, and the block is presented as fixture-derived although its label and age are not.
2. The redaction section names only the `raw:true` exception; the server documents three exceptions.
3. The error section says the `timestamp` is preserved for support, but only `requestId` reaches the caller.
4. The history section says an unchanged snapshot costs one line, which contradicts the deduplication described in the same sentence.

Thirteen further points are suggestions: they are incomplete or loose rather than wrong.

## Verdict counts

| Verdict | Count |
| --- | --- |
| Correct | 57 |
| Stale | 2 |
| Overstated | 6 |
| Missing | 1 |
| Unverifiable | 2 |
| Total claims checked | 68 |

Must-fix: 4. Suggestions: 13.

## Claim, verdict, evidence

Verdict key: **correct** means verified against source, tests, manifests or docs. **Stale** means the claim no longer matches the code. **Overstated** means the claim goes beyond what the code does. **Missing** means a claim the README makes omits a material exception or capability. **Unverifiable** means nothing in this tree can settle it.

| # | README claim (line) | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Read-only MCP server for the M2M API (5) | correct | [SECURITY.md](../../SECURITY.md):6-11; [test/posture.test.ts](../../test/posture.test.ts):25-38 |
| 2 | Built for any MCP client: Claude Desktop, ZCode, Cursor (7, 46) | unverifiable | No client-specific code in the tree; [docs/getting-started.md](../../docs/getting-started.md):7 repeats the list. External client names cannot be settled from this repository. |
| 3 | Badges: version 0.3.0, node >=20.11, tools 36, API read only, offline demo yes (9 to 13) | correct | [package.json](../../package.json):3,7-9; [server.json](../../server.json):9; [scripts/demo.mjs](../../scripts/demo.mjs):148 |
| 4 | One tool call yields charge, range, locks, availability, odometer, service, ages (19) | correct | [src/aggregate-tools.ts](../../src/aggregate-tools.ts):43-50,180-181; ages printed at 139-149 |
| 5 | Every tool is a GET, no write endpoints, every tool has readOnlyHint (21) | overstated | Write and annotation parts are correct: [docs/upstream-api.md](../../docs/upstream-api.md):12; [src/tools.ts](../../src/tools.ts):39-43,77-84; [test/posture.test.ts](../../test/posture.test.ts):25-38. But local tools (`list_domains`, `polestar_status`, history tools) issue no HTTP request, so not every tool is a GET. See S1. |
| 6 | 26 tools by default, 36 with history, extra ten (23) | correct | [src/server.ts](../../src/server.ts):256-283; [test/envelope.test.ts](../../test/envelope.test.ts):161-173; `node docs/check-docs.mjs tools` reports `tools=36 domains=15` |
| 7 | Node.js 20.11 or newer (45) | correct | [package.json](../../package.json):7-9 |
| 8 | Credential required live, offline demo does not need one (47) | correct | [src/config.ts](../../src/config.ts):386-396 |
| 9 | Sanitized capture under test/fixtures/dump (53) | correct | [docs/reviewer-pack.md](../../docs/reviewer-pack.md):16-18; [scripts/verify-fixtures.mjs](../../scripts/verify-fixtures.mjs):13-22 |
| 10 | Quick start: npm ci, npm run build, npm run demo (56 to 58) | correct | [package.json](../../package.json):14-19; [scripts/demo.mjs](../../scripts/demo.mjs):13-34 |
| 11 | npm run demo prints DUMP_OK when every assertion passes (61) | correct | [scripts/demo.mjs](../../scripts/demo.mjs):26-29,148-149 |
| 12 | Fixture mode command with POLESTAR_FIXTURES_DIR (64) | correct | [src/server.ts](../../src/server.ts):865-925; [scripts/demo.mjs](../../scripts/demo.mjs):22-24 |
| 13 | Fixture auth is real; missing token response gives AuthError HTTP 404 (67) | correct | [src/transport.ts](../../src/transport.ts):157-165; [src/auth.ts](../../src/auth.ts):130 |
| 14 | Fixture NOT_FOUND is distinct from DATA_NOT_AVAILABLE (67) | correct | [src/transport.ts](../../src/transport.ts):148-152,213-226; [src/client.ts](../../src/client.ts):175-178 |
| 15 | Data Portal UI steps: tab, secret, Account ID position (71) | unverifiable | External portal UI. [docs/getting-started.md](../../docs/getting-started.md):23-30 repeats the steps but cannot prove them. |
| 16 | Secrets file at ~/.config/polestar-mcp/.env.secrets (76 to 80) | correct | [src/server.ts](../../src/server.ts):40-49; [src/config.ts](../../src/config.ts):145-183 |
| 17 | Client config points at build/server.js (83 to 94) | correct | [package.json](../../package.json):10-13 |
| 18 | Client ID as Account ID fails and the server warns at startup (98) | correct | [src/config.ts](../../src/config.ts):443-445; [src/server.ts](../../src/server.ts):900-902 |
| 19 | Real environment variables win; dotenv handles export, quotes, comments (100) | correct | [src/config.ts](../../src/config.ts):145-183,179-181 |
| 20 | polestar_status shows budget, cache state, token expiry (104) | correct | [src/system-tools.ts](../../src/system-tools.ts):34-71 |
| 21 | The 12-row ask table (110 to 121) | correct | Tools exist and answer as described: [src/aggregate-tools.ts](../../src/aggregate-tools.ts):180-590; [src/advisor-tools.ts](../../src/advisor-tools.ts):192,318; [src/extra-history-tools.ts](../../src/extra-history-tools.ts):116-199 |
| 22 | Prose answers, header with data age, raw:true, structured message only on failures (123) | correct | [src/vehicle-read.ts](../../src/vehicle-read.ts):283-326; [src/tool-output.ts](../../src/tool-output.ts):82-85,255-278 |
| 23 | Sample output block, header colon, "data observed 12 min ago", My Car (126 to 132) | stale | Renderer uses a comma: [src/vehicle-read.ts](../../src/vehicle-read.ts):318-319. The shipped battery fixture clock is `2026-09-18T11:10:55.531Z` ([battery.json](../../test/fixtures/dump/dataportal/telemetry/battery.json)), which renders as weeks or days, not 12 minutes, at review time. "My Car" requires POLESTAR_VEHICLE_LABELS: [src/config.ts](../../src/config.ts):347-357. Must-fix M1. |
| 24 | Optional vin; several cars trigger MCP elicitation and a checked answer (136) | correct | [src/vehicle-read.ts](../../src/vehicle-read.ts):71-140; [docs/architecture.md](../../docs/architecture.md):98. Fallback when elicitation is unavailable is a suggestion, S3. |
| 25 | Strict argument names; delegated_account_id is allowlist checked (138) | correct | [src/tools.ts](../../src/tools.ts):68-76; [src/tool-output.ts](../../src/tool-output.ts):43-49; [src/server.ts](../../src/server.ts):296 |
| 26 | Tool table rows for discovery, domain, aggregate, system and history tools (143 to 183) | correct | [src/domain-tools.ts](../../src/domain-tools.ts):37,120,156; [src/domains.ts](../../src/domains.ts):50-340; [src/system-tools.ts](../../src/system-tools.ts):31; [src/history-tools.ts](../../src/history-tools.ts):222-597; [src/extra-history-tools.ts](../../src/extra-history-tools.ts):116-199 |
| 27 | get_charge_locations answers "Saved charge locations" (157) | overstated | The Domain description says over M2M it is typically an id and a `utc0` flag, not a list of addresses: [src/domains.ts](../../src/domains.ts):252-260. See S4. |
| 28 | 15 get_* domain tools, 8 telemetry, 7 charging (185) | correct | [src/domains.ts](../../src/domains.ts):50-340. A local count confirms 15 domains, 8 telemetry, 7 charging. |
| 29 | Resources URI, list from vehicles, completions, same view as tool, 2 templates (189) | correct | [src/server.ts](../../src/server.ts):367-372,406-440,451-490,492-520. Two templates are registered, one per kind. |
| 30 | Subscriptions stdio, re-read once a minute, metaEventId only, pause at 10 percent left (191) | correct | [src/subscriptions.ts](../../src/subscriptions.ts):60-77,133-134; [docs/tools-reference.md](../../docs/tools-reference.md):128 |
| 31 | Two prompts, names, third with history (193) | correct | [src/server.ts](../../src/server.ts):586-639; [scripts/smoke.ts](../../scripts/smoke.ts):156-159 |
| 32 | 10,000 calls per client per day, about seven per minute (197) | correct | [src/budget.ts](../../src/budget.ts):12; [docs/upstream-api.md](../../docs/upstream-api.md):14. 10000 / 1440 is 6.94. |
| 33 | Mermaid chain: tools, client, cache, retry, budget, history (199 to 208) | correct | [src/server.ts](../../src/server.ts):256-283; [src/caching-transport.ts](../../src/caching-transport.ts):91-94; [src/retrying-transport.ts](../../src/retrying-transport.ts):26; [src/budget.ts](../../src/budget.ts):259-311. The retry node's status list is incomplete; see S5. |
| 34 | Cache TTLs by domain plus stale-while-revalidate (210) | correct | [src/domains.ts](../../src/domains.ts):39-47,50-340; [src/caching-transport.ts](../../src/caching-transport.ts):129-165. TTLs confirmed by local read: battery, exterior, location 30 s; availability, odometer, parking climatization 60 s; health 10 min; pre-cleaning 30 min; charging 5 min; vehicles 1 h. |
| 35 | 429 with Retry-After and 502/503 get up to three attempts with capped backoff, metered (212) | correct | Attempts and metering: [src/retrying-transport.ts](../../src/retrying-transport.ts):58-62,87-120. Status list is incomplete; see S5. |
| 36 | Fail-closed budget, in-memory or ledger, status tool, poller 90 and sampler 80 (214) | correct | [src/budget.ts](../../src/budget.ts):259-311; [src/subscriptions.ts](../../src/subscriptions.ts):133-134; [src/sampler.ts](../../src/sampler.ts):61,120; [src/system-tools.ts](../../src/system-tools.ts):34-71 |
| 37 | One token covers union of scopes; five-minute skew; single flight; one 401 retry (216) | correct | [src/auth.ts](../../src/auth.ts):17,66-86; [src/client.ts](../../src/client.ts):226-228; [src/domains.ts](../../src/domains.ts):435-437 |
| 38 | History append, dedupe by metaEventId, "an unchanged snapshot costs one line" (220) | stale | Dedupe drops the append: [src/history.ts](../../src/history.ts):83-95; [test/history.test.ts](../../test/history.test.ts):17-29 shows two stored records from three appends with one duplicate. An unchanged snapshot costs zero lines, not one. Must-fix M2. |
| 39 | Sampler covers battery, odometer, location, exterior every 10 min, stops at 80 percent (220) | correct | [src/sampler.ts](../../src/sampler.ts):27,61,120,128-131; sampled flags in [src/domains.ts](../../src/domains.ts):50-340 |
| 40 | POLESTAR_VEHICLE_LABELS gives friendly names (226) | correct | [src/config.ts](../../src/config.ts):347-357; [src/format.ts](../../src/format.ts):138-145 |
| 41 | Redaction masks VINs; only raw:true is exempt (227, 268) | missing | [SECURITY.md](../../SECURITY.md):36-48 documents three exceptions: resource URI identity, raw:true, on-disk history paths. [docs/privacy.md](../../docs/privacy.md):31-33 says the same. [src/server.ts](../../src/server.ts):377-382 explains the URI exception. Must-fix M3. |
| 42 | POLESTAR_ALLOW_LOCATION=0 refuses location, strips coordinates, refuses position history (228) | correct | [src/client.ts](../../src/client.ts):165-172; [src/history-tools.ts](../../src/history-tools.ts):240-251; [src/timeline.ts](../../src/timeline.ts):262-293 |
| 43 | History files 0600, per-vehicle dirs 0700, get_history refuses position history (230) | correct | [src/history.ts](../../src/history.ts):83-109,165-170; [src/history-tools.ts](../../src/history-tools.ts):240-251 |
| 44 | HTTP is stateless, shares engine state, binds loopback, non-loopback needs a token (234) | correct | [src/server.ts](../../src/server.ts):687-693,743-763; [src/bind.ts](../../src/bind.ts):43-70. Token floor omitted; see S7. |
| 45 | Browser Origin accepted when it matches the request host or an allowed origin (234) | overstated | The request host is added only while the allowlist is empty: [src/bind.ts](../../src/bind.ts):136-144. With POLESTAR_HTTP_ALLOWED_ORIGINS set, the listing replaces that default. [test/server-seams.test.ts](../../test/server-seams.test.ts):139-140 confirms the allowlist admits that origin and nothing else. See S6. |
| 46 | A forged Host is refused (234) | correct | [src/bind.ts](../../src/bind.ts):104-131; [test/server-seams.test.ts](../../test/server-seams.test.ts):123-130 |
| 47 | Resources in both modes; subscriptions not; subscribe:false (236) | correct | [src/server.ts](../../src/server.ts):492-528; [test/server-seams.test.ts](../../test/server-seams.test.ts):283-291 |
| 48 | Both protocol eras, 26/36 surface, missing envelope refused (238) | correct | [test/modern-protocol.test.ts](../../test/modern-protocol.test.ts):73-108; [src/server.ts](../../src/server.ts):722-729 |
| 49 | Environment-only config, unknown variable warning, strict fatal, invalid values fail fast (242) | correct | [src/config.ts](../../src/config.ts):96-118,186-212,331-340; [src/server.ts](../../src/server.ts):888-897 |
| 50 | Full configuration reference has 29 variables (245) | correct | [src/config.ts](../../src/config.ts):96-102; `node docs/check-docs.mjs envvars` reports `variables=29` |
| 51 | All 29 defaults in the table (247 to 277) | correct | [src/config.ts](../../src/config.ts):373-435; [.env.example](../../.env.example):8-58. Every name and default matches, including timeout 15000, budget 10000, per-minute 100, sample seconds 600, port 0, host 127.0.0.1, units km, cache on. |
| 52 | POLESTAR_HISTORY_SAMPLE_SECONDS default 600, clamped 60 to 3600 (265) | correct | [src/sampler.ts](../../src/sampler.ts):128-131 |
| 53 | POLESTAR_HTTP_TOKEN required off loopback (275) | correct | [src/bind.ts](../../src/bind.ts):43-70. The 16-character minimum is omitted; see S7. |
| 54 | npm run typecheck types src, test and scripts (285) | correct | [tsconfig.dev.json](../../tsconfig.dev.json):9 |
| 55 | npm run build, test and coverage floors 90/80/85 (286 to 288) | correct | [package.json](../../package.json):15-17,27 |
| 56 | Smoke, smoke-http, smoke-bin, demo, demo-dump scripts (289 to 293) | correct | [package.json](../../package.json):18-24,36; [docs/development.md](../../docs/development.md):115-119 |
| 57 | verify-fixtures, check-secrets, check-tool-refs, check-version six locations, check-server-json, docs gate (294 to 299) | correct | [scripts/verify-fixtures.mjs](../../scripts/verify-fixtures.mjs):13-22; [scripts/check-secrets.mjs](../../scripts/check-secrets.mjs):93-100; [scripts/check-version.mjs](../../scripts/check-version.mjs):33-59; [docs/check-docs.mjs](../../docs/check-docs.mjs):12,331-339. Six checked values: package.json, server.json top level, server.json package entry, README badge, CHANGELOG heading, release note. |
| 58 | Suite runs on Node 20.11, 22 and 24 in CI (302) | correct | [.github/workflows/ci.yml](../../.github/workflows/ci.yml):54-78 |
| 59 | Every check runs on push and pull request; CONTRIBUTING has the table (304) | correct | [.github/workflows/ci.yml](../../.github/workflows/ci.yml):2-4,20-51; [CONTRIBUTING.md](../../CONTRIBUTING.md):48-67 |
| 60 | Credentials outside the tree; no .env-family file acceptable (308) | correct | [SECURITY.md](../../SECURITY.md):59-72; [scripts/check-secrets.mjs](../../scripts/check-secrets.mjs):32-40 |
| 61 | check-secrets "scans every file" for the listed shapes (308) | overstated | The scanner skips node_modules, build, .git, .npm-cache, .unlazy and dist directories, and image, map and PDF extensions: [scripts/check-secrets.mjs](../../scripts/check-secrets.mjs):22,27. See S9. |
| 62 | Every API error preserves the requestId and timestamp support can look up (313) | overstated | The failure envelope has no timestamp field: [src/failure.ts](../../src/failure.ts):52-60; [src/tool-output.ts](../../src/tool-output.ts):255-278 adds requestId only; [src/failure.ts](../../src/failure.ts):122-128 renders requestId only. [src/client.ts](../../src/client.ts):294-306 parses timestamp into the error object, where it is then dropped by normalization. Must-fix M4. |
| 63 | Documentation table links resolve and describe their files (319 to 329) | correct | All 11 linked files exist; `node docs/check-docs.mjs links` passes. |
| 64 | Tool reference covers "All 36 tools, endpoints and scopes, example responses" (320) | overstated | All 36 names are documented (the docs gate enforces this), but the endpoint and scope table covers the 16 route-bound tools: [docs/tools-reference.md](../../docs/tools-reference.md):29-50. The aggregate, advisor, system and history tools have no endpoint of their own: [docs/tools-reference.md](../../docs/tools-reference.md):108-121. See S10. |
| 65 | Read-only, no writes registered, consumer API deliberately not wired (333) | correct | [docs/write-endpoints.md](../../docs/write-endpoints.md):5; [docs/consumer-adapter-note.md](../../docs/consumer-adapter-note.md):15-18; [test/posture.test.ts](../../test/posture.test.ts):25-70 |
| 66 | npm package and Registry prepared but unpublished; release workflow on tag; mcpb blocked (335) | correct | [docs/reviewer-pack.md](../../docs/reviewer-pack.md):72-79; [.github/workflows/release.yml](../../.github/workflows/release.yml):1-6,44-69; [docs/bundle.md](../../docs/bundle.md):3-6. External publication state was not queried, only the repository claims. |
| 67 | Personal project, one owner's Polestar 2, not affiliated (337) | correct | [docs/consumer-adapter-note.md](../../docs/consumer-adapter-note.md):7; [docs/reviewer-pack.md](../../docs/reviewer-pack.md):70 |
| 68 | MIT license (341) | correct | [LICENSE](../../LICENSE):1; [package.json](../../package.json):48 |

## Must-fix

### M1. The sample output block does not match the renderer and is not literal fixture output

README lines 126 to 129 show:

```text
Vehicle My Car: telemetry/battery (data observed 12 min ago)
```

The renderer produces a comma, not a colon: [src/vehicle-read.ts](../../src/vehicle-read.ts):318-319 is `Vehicle ${vehicle.label}, ${kind}/${name} (${age})`. The same colon appears in [docs/tools-reference.md](../../docs/tools-reference.md):81, so both documents are stale on one character.

There is a second problem. README line 132 says "The example uses the project's sanitized fixtures." The shipped fixture carries a fixed `metaReceivedAt` of `2026-09-18T11:10:55.531Z` ([battery.json](../../test/fixtures/dump/dataportal/telemetry/battery.json)), which rendered as 52 days old at review time, not 12 minutes. "My Car" is also an owner label from POLESTAR_VEHICLE_LABELS, not something the fixture contains.

Recommended fix: use a comma and either present the block as an illustrative answer with values from the fixture, or regenerate it from a real fixture run and state the age the renderer actually shows. Keep the sanitized values (52 percent, 170 km, 20.1 kWh/100km), which do match the fixture.

### M2. "An unchanged snapshot costs one line" is the opposite of what dedup does

README line 220 says the store is "deduplicated by `metaEventId`; an unchanged snapshot costs one line." The append path returns before writing when the cloud change ID matches the last stored one: [src/history.ts](../../src/history.ts):83-95. [test/history.test.ts](../../test/history.test.ts):17-29 appends the same ID twice and stores one record, so the marginal cost is zero lines, not one. README line 174 already uses the correct phrasing ("one line per change").

Recommended fix: replace "an unchanged snapshot costs one line" with "an unchanged snapshot is not appended" or "one line per change". Note that [docs/getting-started.md](../../docs/getting-started.md):43 carries the same wrong wording and should change with it.

### M3. Only one of the three redaction exceptions is documented

README line 227 says redaction applies except with `raw:true`; line 268 repeats it in the configuration table. [SECURITY.md](../../SECURITY.md):36-48 documents three exceptions:

1. The resource URI identity, because a masked URI could not be read or subscribed.
2. `raw:true`, which returns the upstream payload exactly.
3. On-disk history paths, which are named by VIN.

[docs/privacy.md](../../docs/privacy.md):31-33 states all three. As written, the README implies that `raw:true` is the only place a VIN can appear, which is wrong for a user who is deciding whether to enable redaction or share a resource URI.

Recommended fix: name all three exceptions, or replace the parenthetical with a link to the SECURITY.md section that lists them. If the README keeps the short form, add a pointer on line 189 where the URI is introduced, because that is the surface that keeps the raw VIN.

### M4. The timestamp is parsed but never reaches the caller

README line 313 says "Every API error preserves the `requestId` and `timestamp` Polestar support can look up." The failure shape carries no timestamp: [src/failure.ts](../../src/failure.ts):52-60 lists code, message, httpStatus, requestId and minted, and [src/tool-output.ts](../../src/tool-output.ts):255-278 adds only requestId to `structuredContent`. The rendered failure text adds only requestId: [src/failure.ts](../../src/failure.ts):122-128. `PolestarApiError` does accept a timestamp ([src/client.ts](../../src/client.ts):14-26) and `toApiError` fills it ([src/client.ts](../../src/client.ts):294-306), but `toFailure` drops it, so a user cannot quote it.

Recommended fix, in order of preference: add `timestamp` to the failure envelope and rendered text, or change the README to say the `requestId` is preserved. [SECURITY.md](../../SECURITY.md):80-82 already says requestId only, so the README currently promises more than the security page does.

## Suggestions

These are accurate enough not to block, but each one is loose, conditional or incomplete in a way a careful reader could trip over.

| # | Location | Suggestion |
| --- | --- | --- |
| S1 | README line 21 | "Every tool is a GET" is loose: `list_domains`, `polestar_status` and the history tools read local state and send no HTTP request. Say "every network call a tool makes is a GET" or "every tool is a read". |
| S2 | README lines 126 to 132 | If M1 is fixed by keeping the block, add a sentence that the age and label are illustrative, or configure a synthetic label for the demo and regenerate the ages. Do not keep the claim that the block is literal fixture output. |
| S3 | README line 136 | Elicitation is conditional: a client that does not declare the capability gets `AMBIGUOUS_VIN` instead of a question ([src/vehicle-read.ts](../../src/vehicle-read.ts):128-137, [docs/architecture.md](../../docs/architecture.md):98). Say "asks through MCP elicitation when the client supports it, and otherwise names the VINs". |
| S4 | README line 157 | `get_charge_locations` over M2M typically returns a settings record (`id`, `utc0`) and no addresses ([src/domains.ts](../../src/domains.ts):252-260). Avoid promising "saved charge locations"; say "charge-location settings, often without addresses". |
| S5 | README lines 204 and 212 | The retryable set is 429, 500, 502, 503 and 504, plus one network retry on a GET: [src/retrying-transport.ts](../../src/retrying-transport.ts):26-29,92-100. The README lists 429 and 502/503 only. Add 500/504 or say "5xx gateway errors", and mention the single network retry if the description is meant to be complete. |
| S6 | README line 234 | Same-host Origin is admitted automatically only while POLESTAR_HTTP_ALLOWED_ORIGINS is unset; when the allowlist is set it replaces that default ([src/bind.ts](../../src/bind.ts):136-144, [test/server-seams.test.ts](../../test/server-seams.test.ts):139-140). Reword to distinguish "unset" from "configured", matching the table row at README line 276. |
| S7 | README lines 234 and 275 | A non-loopback bind also needs a token of at least 16 characters; a shorter one is refused at startup ([src/bind.ts](../../src/bind.ts):34,59-68). Add the floor to the HTTP section or the token row. |
| S8 | README line 266 | The sampler exists only when POLESTAR_HISTORY_DIR is set ([src/server.ts](../../src/server.ts):171-184). The row says "`1` actually runs the background sampler" without noting the dependency; add "(needs history)". |
| S9 | README line 308 | The scanner does not literally scan every file: it skips node_modules, build, .git, .npm-cache, .unlazy and dist, and image, map and PDF extensions ([scripts/check-secrets.mjs](../../scripts/check-secrets.mjs):22,27). Say "every scanned file" or name the exclusions. |
| S10 | README line 320 | The tool reference documents all 36 names, but endpoints and scopes belong to the 16 route-bound tools; the aggregate, advisor, system and history tools compose or read locally ([docs/tools-reference.md](../../docs/tools-reference.md):29-50,108-121). Narrow the description to "all 36 tools, with endpoint and scope for the route-bound ones". |
| S11 | README line 297 | "Six documented locations" is correct if server.json is counted twice (top level and package entry), as [scripts/check-version.mjs](../../scripts/check-version.mjs):33-59 does. [docs/development.md](../../docs/development.md):152 lists five files. Aligning the two wordings would prevent a future reader from thinking one of them is wrong. |
| S12 | README lines 7 and 46 | "ZCode" is not verifiable from this repository and is not a client the tree can exercise; confirm it is a real MCP client or replace it with a client the README can support. Claude Desktop and Cursor also appear in docs, so the list works if ZCode is intentional. |
| S13 | README line 299 | The docs gate supports more subcommands than the four listed: emdash, buzzwords, banners and connectors also exist ([docs/check-docs.mjs](../../docs/check-docs.mjs):12). The listed four are the ones CI runs, so say "the four CI gates" to avoid implying the list is complete. |

## Notes on method and limits

- Read the full README (341 lines), then the registry, tool specs, transports, budget, auth, cache, history, HTTP bind rules, config registry, scripts, workflows, tests and docs listed above. Line citations are from the reviewed checkout.
- Verified counts by reading the specs and by running the local registries: `node --import tsx scripts/list-tools.ts --detail` returns 36 tools (26 without the history family), and a local import of [src/domains.ts](../../src/domains.ts) returns 15 domains with 8 telemetry and 7 charging. `node docs/check-docs.mjs tools` prints `tools=36 domains=15`.
- No live API call was made, no build or install was run, and no tracked file was edited. The only file written is this report.
- External claims not settled: the Data Portal UI steps, the ZCode client name, and the npm and MCP Registry publication state. The repository evidence for distribution status is consistent and cited above.
- The README at this commit passes the four documentation gates before and after this report was added: `tools`, `envvars`, `links`, `hygiene` (output below).

## Gate results after adding this report

```text
$ node docs/check-docs.mjs tools
DOCS_TOOLS_OK tools=36 domains=15

$ node docs/check-docs.mjs envvars
DOCS_ENVVARS_OK variables=29 docs=3

$ node docs/check-docs.mjs links
DOCS_LINKS_OK

$ node docs/check-docs.mjs hygiene
HYGIENE_NO_EM_DASH
HYGIENE_BUZZWORDS_CLEAN
HYGIENE_NO_BANNERS
HYGIENE_NO_DASH_CONNECTORS
HYGIENE_CLEAN
```
