# polestar-mcp: latest full run (2026-11-09)

> Status note: the defects recorded below have been fixed and re-verified; see
> `analysis/verify/fixes-verified.md`.

Captured by the Lead on `master` at commit `2676223`, host macOS arm64, Node v22.23.2 and npm
10.9.8. Everything below was executed for this run; no figure is copied from an earlier pass.

## 1. Offline gate ladder

| Gate | Exit | Time | Marker |
| --- | --- | --- | --- |
| `npm run typecheck` | 0 | 522 ms | clean |
| `npm run build` | 0 | 345 ms | `build/server.js` executable |
| `npm test` | 0 | 1,767 ms | 301 pass, 0 fail |
| `npm run coverage` | 0 | 2,605 ms | lines 97.43, branches 85.66, functions 92.91 |
| `npm run smoke` | 0 | 478 ms | `SMOKE_OK`, 36 tools |
| `npm run smoke-http` | 0 | 466 ms | `HTTP_SMOKE_OK` |
| `npm run smoke-bin` | 0 | 452 ms | `BIN_SMOKE_OK` version 0.3.0 |
| `npm run demo` | 0 | 227 ms | `DUMP_OK` |
| `npm run demo-dump` | 0 | 341 ms | `DUMP_OK` |
| `npm run verify-fixtures` | 0 | 142 ms | `FIXTURES_OK` |
| `npm run check-secrets` | 0 | 162 ms | `SECRETS_CLEAN` |
| `npm run check-tool-refs` | 0 | 285 ms | 36 names, 33 files, 0 undefined |
| `npm run check-version` | 0 | 110 ms | `VERSION_OK 0.3.0` |
| `npm run check-server-json` | 0 | 111 ms | `SERVER_JSON_OK`, 1 package |
| docs tools | 0 | 191 ms | `tools=36 domains=15` |
| docs envvars | 0 | 29 ms | `variables=29 docs=3` |
| docs links | 0 | 45 ms | `DOCS_LINKS_OK` |
| docs hygiene | 0 | 97 ms | `HYGIENE_CLEAN` |

Total wall clock for the ladder is about 8 seconds. Log: `/tmp/lead-run/gates.txt`.

## 2. Runtime matrix

| Runtime | Tests | Smoke | Demo |
| --- | --- | --- | --- |
| Node 20.11.1 | 301 pass, 0 fail | `SMOKE_OK` | not run |
| Node 22.23.2 (host) | 301 pass, 0 fail | `SMOKE_OK` | `DUMP_OK` |
| Node 24.22.2 | 301 pass, 0 fail | `SMOKE_OK` | not run |

Node 20.11.1 and 24.22.2 were fetched with `npx node@<version>` for this run. The documented
floor is >= 20.11.0 and both ends of the CI matrix now have local evidence.

## 3. Package

| Fact | Value |
| --- | --- |
| Tarball files | 136 |
| Package size | 275.2 kB |
| Unpacked size | 1.0 MB |
| Pack shasum | `79534c9de692c90c61480b10efb34b133fc10856` |
| Contents | build, scripts/demo.mjs, test/fixtures/dump, docs, mcpb; no src or tests |

## 4. Live data pulled through the MCP

One stdio session, live credential, history enabled, all 36 tools called once: 36 of 36 returned
`ok`, total 972 ms. VIN masked, position withheld. The car data below is the owner's own vehicle.

| Reading | Value | Age |
| --- | --- | --- |
| Battery charge | 65 percent, 210 km estimated range, idle, unplugged | 31 min |
| Consumption | 21.3 kWh/100 km | 31 min |
| Odometer | 126,965 km; manual trip 6,875 km; automatic trip 55 km | 38 min |
| Exterior | all doors/windows/hood/tailgate closed, locked, alarm idle | 38 min |
| Health | service in 261 days or 138 km, engine hours 688, warning: service | 38 min |
| Availability | available, asleep / not in use | 31 min |
| Target charge | 100 percent, Custom | 7 d |
| Amp limit | 20 A (source RCS) | 20 d |
| Charge window | 05:00 to 07:00 UTC+1, defined but inactive | 31 h |
| Charge-now | override present, synced | 31 h |
| Climate timers | Sunday 13:00 inactive; Monday to Friday 05:00 active; Thursday 07:00 inactive | 14 d |
| Charge locations | none reported | 60 d |
| At-charge-location | `DATA_NOT_AVAILABLE` on this car | n/a |
| Energy to target | 24.1 kWh at the battery, 26.8 kWh from the grid, capacity 68.8 kWh from range and consumption, 90 percent AC efficiency | current |
| Location | reported, text withheld from this report | current |

Runtime state at the end: budget 17 of 10,000 used, minute 17 of 100, cache 80 percent hit rate
(65 hits, 16 misses, 16 entries), token trusted about 55 more minutes, sampling off, history on.
The 17 metered calls are one token POST, one vehicle list and 15 first domain reads; every
aggregate answered from that cache. History recorded one battery, one odometer and one health
sample, and the thin-data tools said so rather than inventing values. Raw capture (masked):
`/tmp/lead-run/live-data.json`.

## 5. Defect repros re-run

These are the open findings from the five-lane pass, re-executed for this run:

| ID | Severity | Observed now |
| --- | --- | --- |
| F1 | High | With `POLESTAR_ALLOW_LOCATION=0`, `get_history` for `telemetry/location` returns the recorded sample and renders the latitude and longitude; `get_timeline` in the same session says location is excluded. |
| F2 | Medium | History file mode 644, VIN directory 755, store root 700. The budget ledger is 600. |
| F3 | Medium | A crafted upstream error message containing the VIN is forwarded verbatim to text and `structuredContent.message` while `POLESTAR_REDACT_VIN=1`. |
| F4 | Low | Not re-run this pass; lane D's probe plus a source read of the background-refresh log line. |
| F5 | Low | `prompts/get` for `car-status` with a caller-supplied VIN echoes it unmasked under redaction. |
| F6 | Low | `INVALID_VIN` echoes the caller's 17-character input, and the same message says redaction hides VINs. |
| D1 | Medium | One malformed JSON line on stdio gets no `-32700` and no stderr diagnostic; the session survives and later requests answer. |
| D2 | Low | A JSON-RPC batch of two `ping` requests gets no reply. |
| D3 | Low | `resources/read` with `%ZZ` returns `-32603` "URI malformed" instead of `-32602`. |
| F7 | Low | `npm audit --omit=dev` reports 2 moderate advisories (`hono`, `@hono/node-server`, serveStatic double-decode); fix available; `serveStatic` is not imported here. |

Logs: `/tmp/lead-run/defects.txt` and `/tmp/lead-run/protocol-defects.txt`.

## 6. Official SDK interoperability

An independent client, `@modelcontextprotocol/sdk` 1.32.2, connected to the built server:

| Check | Result |
| --- | --- |
| stdio handshake | server `polestar-mcp` 0.3.0 |
| tools/list, tools/call, tool error surface | 26 tools, text plus `isError` on a rejected argument |
| resources/list, resources/read, templates | 15 resources, 2 templates, body read |
| prompts/list default | 2 prompts |
| prompts/list with history | 3 prompts |
| prompts/get | one message |
| Streamable HTTP handshake and call | 26 tools, live fixture call answered |

12 of 12 checks pass. `npm run inspect` was not run because it downloads the inspector on first
use; the SDK client covers the same wire surface.

## 7. Artifacts

| Path | Contents |
| --- | --- |
| `analysis/verify/ops-gates.md` | lane A report |
| `analysis/verify/live-api.md` | lane B report |
| `analysis/verify/protocol.md` | lane C report |
| `analysis/verify/security.md` | lane D report |
| `analysis/verify/correctness.md` | lane E report |
| `/tmp/lead-run/live-data.json` | this run's masked 36-tool live capture |
| `/tmp/lead-run/gates.txt` | this run's gate timings |
| `/tmp/lead-run/defects.txt` | security defect repro output |
| `/tmp/lead-run/protocol-defects.txt` | protocol defect repro output |
| `/tmp/lead-run/node-versions.txt` | Node 20 and 24 results |

## 8. What this run does not cover

- Docker image build and container runtime: Docker is not installed.
- Live delegated-account reads: no delegated credential configured.
- A live subscription notification: it needs the car to report a new `metaEventId`.
- A `.mcpb` bundle build: no `mcpb` CLI and no desktop host.
- A sustained load test beyond the 50 concurrent request probe in lane E.
