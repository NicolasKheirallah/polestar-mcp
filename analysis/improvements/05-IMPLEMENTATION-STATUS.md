# Implementation status: Must, Should and Could

What this file is: the delivery record for [00-MOSCOW.md](00-MOSCOW.md). Every item below was
implemented from that backlog, in dependency order, on the isolated worktree and branch
`moscow-backlog`. A claim here is a claim about a committed tree, so each row names the check
that proves it. Items that cannot be finished inside this repository are marked blocked with the
exact missing dependency, not quietly dropped.

## Where the work is

| | |
| --- | --- |
| Branch | `moscow-backlog` |
| Worktree | `.agents/worktrees/moscow-backlog` |
| Base | `dc50017` (v0.3.0) |
| Commits | `95dc376` test split, `b905ac0` Must and Should, `4a65f0a` Could |
| Deliverables | this file, three lane inventories (`01-surface.md`, `02-core.md`, `04-ecosystem.md`), the backlog (`00-MOSCOW.md`), and the code. The platform lane's findings were folded into the backlog as M1 to M3, M6, M9 and M10 |

The main checkout on `master` was never modified. It was reset to `dc50017` before the branch was
cut, and the only new files there are the untracked `analysis/` notes.

## Final verification, run on the committed tree

| Check | Command | Result |
| --- | --- | --- |
| Unit and integration suite | `npm test` | 298 pass, 0 fail (was 111) |
| Types | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0 |
| Coverage, floors in the script | `npm run coverage` | 97.43 line, 85.61 branch, 92.92 functions; exits 1 below 90/80/85 |
| Fixture contract | `npm run verify-fixtures` | `FIXTURES_OK` |
| Stdio end to end | `npm run smoke` | `SMOKE_OK`, 36 tools, 34 callable with no arguments |
| Streamable HTTP | `npm run smoke-http` | `HTTP_SMOKE_OK` |
| Published launch path | `npm run smoke-bin` | `BIN_SMOKE_OK`, 0.45 s (was 20 s and could not fail) |
| Offline demo, checkout | `npm run demo-dump` | `DUMP_OK` |
| Offline demo, plain Node | `npm run demo` | `DUMP_OK` |
| Secret hygiene | `npm run check-secrets` | `SECRETS_CLEAN` |
| Instruction references | `npm run check-tool-refs` | 36 names, 33 files, 0 undefined |
| Version consistency | `npm run check-version` | `VERSION_OK 0.3.0` (six locations) |
| Registry manifest | `npm run check-server-json` | `SERVER_JSON_OK` |
| Docs tools gate | `node docs/check-docs.mjs tools` | `DOCS_TOOLS_OK tools=36 domains=15` |
| Docs env gate | `node docs/check-docs.mjs envvars` | `DOCS_ENVVARS_OK variables=29 docs=3` |
| Docs links gate | `node docs/check-docs.mjs links` | `DOCS_LINKS_OK` |
| Writing hygiene | `node docs/check-docs.mjs hygiene` | `HYGIENE_CLEAN` |
| Packed package | `npm pack --dry-run` | 136 files, includes demo script, 17 fixtures files, docs and mcpb |

## Must: 10 of 10 done

| Item | Status | What changed | Proof |
| --- | --- | --- | --- |
| M1 identity-scoped cache | done | Cache key is `[url, x-client-id, x-delegated-account-id]`, single-flight per identity | Probe: owner sees `owner-vehicle`, delegated sees `third-party-account`, 2 HTTP calls, owner re-read still cached. `test/transport-hardening.test.ts` |
| M2 metering independent of cache | done | `RetryingTransport` composed for every live mode, cache wraps it | Probe with `POLESTAR_CACHE=off`: one 429 then 200 made 2 reads and metered 3 attempts. `test/engine-chain.test.ts` |
| M3 real VIN redaction | done | Names, descriptions, completions, elicitation, `VIN_MISMATCH`, `AMBIGUOUS_VIN`, `VIN_NOT_CHOSEN` masked; resource URI, `raw` and on-disk paths documented as exceptions | Probe with redaction on: 15 resources, 0 name leaks, 0 description leaks, URI keeps identity by design; invalid-VIN error path leaks nothing. `SECURITY.md` updated |
| M4 absence is unknown | done | Single-domain tools say `No ... data`; verdicts say `Unknown, not reported`; aggregates name every unreported domain, print per-domain ages and the oldest; security verdict includes alarm and treats absent locks as unknown | `test/aggregates.test.ts`, `test/runtime.test.ts` |
| M5 charging and planning truth | done | Estimate states the assumed target and never promises a missing figure; planner returns infeasible with kWh shortfall, time-adjacent blocks, hour normalization and flooring, price coverage refusal, cost from chosen steps, negative and zero kept | Probe: 56 kWh need with 2 slots is infeasible with a reason; negative prices keep `totalCost: -1.778`. `test/planner.test.ts` |
| M6 surface matches promise | done | Strict argument schemas (`z.object(...).strict()`), history prompt only with a store, instructions generated from the running surface, `POLESTAR_CACHE` in status, skew-aware token life | Probe: `get_battery {"vinn":...}` returns `Unrecognized key: "vinn"`; valid call still answers. `test/envelope.test.ts`, `test/server-seams.test.ts` |
| M7 history answers correct | done | Per-domain rendering with fallback (no more `{}`), zero-usable-point guard, honest span wording, value clock plus read-clock fallback, paging marker, append-time prune | `test/history.test.ts`, `test/could-history.test.ts` |
| M8 demo and install truth | done | Demo defaults to the shipped dump, plain-Node `npm run demo`, package carries demo and fixtures, all claims corrected, release workflow prepared | `npm run demo` and `npm run demo-dump` print `DUMP_OK`; pack lists the demo path |
| M8 publish (external half) | blocked | `mcpName`, registry-shaped `server.json`, tag-driven release workflow with provenance and `mcp-publisher` are in place | Blocked on owner npm credentials and npm name availability; the workflow reports a skipped publish instead of failing |
| M9 HTTP Host and Origin guards | done | Origin allowlist, Host check, 16-character token floor on non-loopback, constant-time bearer compare | Probe: forged `Host`/`Origin` gets `403 FORBIDDEN`; same-origin initialize works. `test/server-seams.test.ts` |
| M10 gates can fail | done | Prompt test built from the running surface, planner assertions strengthened, redaction scan, cache identity and Origin tests, coverage floors, honest smoke-bin | Coverage run at a 99 percent floor exits 1; smoke-bin observes the real exit code. `test/envelope.test.ts`, `test/engine-chain.test.ts`, `test/transport-hardening.test.ts` |

## Should: 15 done, 1 partial

| Item | Status | Proof |
| --- | --- | --- |
| S1 charging answer in status | done | `get_car_status` prints plugged state, target SOC, car ETA and energy to target with sources |
| S2 one charge model | done | 16 A at 400 V three-phase yields 11.085 kW; capacity fallback chain named; 90 percent AC efficiency on grid energy; input bounds |
| S3 value clock | done | `valueObservedAtMs` prefers nested value timestamps; recorder stores `valueObservedAt`; settings report true age |
| S4 negative caching | done | 404 `DATA_NOT_AVAILABLE` cached 60 s; 403/429 never; body replays |
| S5 retry hardening | done | Numeric and HTTP-date `Retry-After`, 500/504, one GET network retry, `expiresIn` validation |
| S6 subscription hardening | done | Bad URI is `-32602`, cap 50, overlap guard, notify-then-advance |
| S7 token economy | done | 44,837 to 29,951 bytes at the then 23-tool surface; 34,723 at the final 26; shared schema 401 bytes |
| S8 typed data | done | Domain tools, aggregates, advisor and status carry documented `data`; `withData` helper |
| S9 history bounds and paging | done | `offset`/`before` with a more-available line; store prunes newest half past its bound |
| S10 config hardening | done | Positive numbers, `ALLOW_LOCATION` falsey vocabulary (`no`, `never`, `off`, `false`, `0`), https outside loopback, fixtures dir checked at startup |
| S11 failure presentation | done | `Server refused CODE` for local refusals, `Polestar API error` upstream, requestId only when present, hint once |
| S12 location correctness | done | String speed parsed, moving speed rendered, altitude, charge-window offset |
| S13 resource and listing honesty | done | No silent 10-VIN slice, failure is an error, labels used, unknown domain `-32602`, delegated `list_vehicles` with `{count, vehicles}` |
| S14 packaging and ops | done in files, CI-verified only | Non-root container, healthcheck, `.dockerignore`, pack-and-install job, Node matrix 20.11/22/24. Docker build not run locally: docker is not installed on this host |
| S15 release and docs gates | done | Six-location version check, docs gate scope over CONTRIBUTING/SECURITY/CHANGELOG/releases/README, digit-safe env scan over all `src`, help generated from the registry |
| S16 honest surface | partial | Instructions, capabilities, annotations, prompt set and descriptions are generated and truthful. Prompt arguments still carry names without descriptions, and prompt-reference completions are not implemented; the MCP surface has no completion handler for `ref/prompt` |

## Could: 14 done, 1 partial, 1 blocked

| Item | Status | Proof or blocker |
| --- | --- | --- |
| C1 charging setup aggregate | done | `get_charging_setup`, seven settings, per-setting ages, unsupported absence named |
| C2 domain availability matrix | done | `list_vehicle_domains`, reported/absent/failed/disallowed, location never read when disabled |
| C3 departure readiness | done | `get_departure_readiness`, deadline and energy arithmetic, one-shot timer refused |
| C4 charging cost | done | `get_charging_cost`, session energy, capacity source, price split, unpriced energy never zero |
| C5 health trend | done | OLS slope with 95 percent interval, 90-day and 8-point minimum, named confounders |
| C6 warning changes | done | `get_warning_changes`, appeared/cleared, unobserved caveat |
| C7 trips | done | `get_trips`, gaps and resets named, sparse refusal |
| C8 timeline | done | `get_timeline`, multi-domain, location excluded when disabled |
| C9 weekly digest | done | `get_weekly_digest`, empty is "not observed", sparse named |
| C10 service and settings | done | `get_service_forecast`, `get_settings_history`, value clock, limits named |
| C11 Claude Desktop bundle | partial | `mcpb/manifest.json` (sensitive secret, env map, privacy URL) and `docs/bundle.md` checklist are in place. Build blocked: no `mcpb` CLI, no desktop host, no icon in this environment |
| C12 reviewer pack and privacy | done | `docs/reviewer-pack.md`, `docs/privacy.md`, linked from README |
| C13 MCP Apps view | blocked | The installed SDK exposes no MCP Apps extension (no `ui://` resource support, no app host); shipping a chart needs a client that implements the extension. A bundle here would be untestable |
| C14 2026-07-28 protocol era | done for HTTP | The SDK does serve the modern era through `createMcpHandler`, which the first status report missed by reading only `LATEST_PROTOCOL_VERSION`. HTTP mode now serves both eras from one listener: `server/discover` advertises `["2026-07-28"]`, modern `tools/list` returns all 26 tools, a modern request without its envelope is refused with the missing keys named, and a 2025 initialize still answers on the same socket. `test/modern-protocol.test.ts` holds all three. stdio keeps the 2025 handshake |
| C15 persistent budget ledger | done | `POLESTAR_BUDGET_LEDGER`, identity-hashed, atomic write, mode 0600, fail closed, wired in `buildEngine`; rollover and corruption tested |
| C16 URI guard and caps | done | Malformed percent VIN returns `-32602`, 4 MiB request cap with 413, 4 MiB response cap, per-request rebuild measured (0.19 ms median) and documented, help generated |

## Won't: unchanged

All twelve Won't decisions in [00-MOSCOW.md](00-MOSCOW.md) stand. The new code does not add a
write path, a consumer API adapter, hosted OAuth, fleet mode, geofencing, cross-account
comparison, a price provider, truncated URI masking, a premature protocol rewrite, SDK patching,
tool renames or a tree-wide mutation gate. `test/posture.test.ts` still holds the read-only rule.

## Breaking changes, stated for the release note

1. A successful result sends its rendered text once in `content` plus `structuredContent.data`
   where a tool populates one. `structuredContent.message` is emitted only for failures.
2. Tool arguments are strict: an unknown argument is refused by name, so a misspelled `vin` no
   longer reads the default car.
3. `tools/list` is much smaller, and the endpoint/scope mapping now lives only in `list_domains`.
4. The Node floor is `>=20.11.0`.
5. New configuration: `POLESTAR_HTTP_ALLOWED_ORIGINS`, `POLESTAR_BUDGET_LEDGER`.
6. HTTP mode refuses browser origins other than the request host unless allowlisted, and a
   non-loopback bind requires a token of at least 16 characters.

## What remains, and what would unblock it

| Item | Needs | Evidence today |
| --- | --- | --- |
| M8 publish | Owner npm credentials, npm name availability, registry token | Release workflow prepared and gated; `npm view polestar-mcp` is still `E404` |
| C11 bundle build | `mcpb` CLI, a desktop host, an icon, signing identity | Manifest and checklist ready; nothing to execute here |
| C13 MCP Apps | An SDK/client with the extension | No `ui://` support in the installed SDK |
| C14 protocol era | An SDK that serves 2026-07-28 | SDK constant is 2025-11-25 |
| S16 remainder | A decision to add prompt-argument descriptions and a prompt-reference completion handler | Both are small; neither gates a user question |
| Docker verification | Docker on the build host | CI job added, unexecuted locally |

## How the work was verified

An independent read-only verifier checked the Must claims against the wave-1 checkpoint and
found M1 to M9 sound. Its M10 verdict (coverage red, smoke-bin still dishonest) describes commit
`b905ac0` at the time of that check; both were fixed before the delivered commit `4a65f0a`,
where `npm run coverage` exits 0 at 97.4/85.7/92.9 and smoke-bin observes the real exit code. The
same verifier showed that C14 was reachable through the SDK after all, which is why it is now
done rather than blocked. Every lane owner ran its own suites and recorded pre-fix failures before the fix. The Lead then
ran the full gate suite on the merged tree, and re-ran adversarial probes independently of the
implementing agents: delegated cache isolation, cache-off metering under a retry, strict argument
refusal through a real JSON-RPC exchange, redaction across resources and error paths, planner
negative prices and shortfall, HTTP Origin rejection over a real socket, and a coverage run set
above the measured value to prove the floor can fail. Two claims were corrected during
integration rather than accepted: the history test suite had to move out of the planner file to
keep ownership disjoint, and the tools/list byte ceilings were re-measured for the final 26 and
36 tool surfaces instead of being carried forward.
