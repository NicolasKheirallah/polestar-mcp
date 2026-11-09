# Defect fixes and post-fix verification (2026-11-09)

Working tree on `master`, based on `2676223`. This file records what was fixed after the
five-lane verification and how each fix was proved. Regenerate with the commands in the last
section.

## Defects fixed

| ID | Severity | Fix | Proof |
| --- | --- | --- | --- |
| F1 | High | `get_history` refuses `telemetry/location` when `POLESTAR_ALLOW_LOCATION=0`, before the store query. | `test/security-regressions.test.ts`: refusal with `LOCATION_DISALLOWED`, no coordinates, and a positive control that the same store answers with the switch on. |
| F2 | Medium | History files created `0600`, per-vehicle directories `0700`, loose existing files tightened on append, retention rewrite keeps `0600`. | `test/history-mode.test.ts`: creation, tightening, and twenty appends across the retention bound all stay `600`. |
| F3 | Medium | Failure envelopes are masked when redaction is on: rendered text plus structured `message` and `hint`, `requestId` and `code` preserved. Resource-read failures get the same mask. | `test/security-regressions.test.ts`: crafted upstream error quoting the VIN is masked, unmasked without redaction. |
| F4 | Low | The background-refresh diagnostic masks the VIN in the request path and message. | Unit test on `refreshFailureLine` with both redaction states. |
| F5 | Low | Prompt text masks a caller-supplied VIN under redaction. | `test/security-regressions.test.ts` and a `promptSpecs` unit test, each with an unmasked control. |
| F6 | Low | `INVALID_VIN` masks the identifier it echoes, including a 17-character typo carrying a forbidden letter. | `test/security-regressions.test.ts` with the unmasked control. |
| D1 | Medium | A line filter in front of the stdio transport answers malformed JSON with `-32700` and keeps the session alive. | `test/stdio-filter.test.ts` and `test/protocol-stdio.test.ts` over a real child process. |
| D2 | Low | A JSON-RPC batch is answered with `-32600` instead of being dropped. Batching is refused, not reimplemented: MCP removed it in 2025-06-18. | Same two test files; the wire test asserts the frame. |
| D3 | Low | Malformed percent-encoding in a resource URI is `-32602`, not `-32603`. | `test/protocol-stdio.test.ts` plus a positive control read of the canonical URI. |
| F7 | Low | `hono` and `@hono/node-server` updated past the `serveStatic` advisory through the lockfile; no direct dependency changed. | `npm audit --omit=dev` reports 0 vulnerabilities; `npm ci` reinstalls clean and the suite passes. |

The doc and comment drift from lane E was already fixed in `2676223`.

## Verification after the fixes

| Check | Result |
| --- | --- |
| `npm ci` from the updated lockfile | exit 0, 14 packages |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm test` | 318 pass, 0 fail (301 existing plus 17 new) |
| `npm run coverage` | lines 97.70, branches 85.36, functions 92.96 |
| Node 20.11.1, 22.23.2, 24.22.2 | 318 pass on each, smokes pass on 20 and 24 |
| `npm run typecheck`, `npm run build` | exit 0 |
| `npm run smoke`, `smoke-http`, `smoke-bin` | `SMOKE_OK`, `HTTP_SMOKE_OK`, `BIN_SMOKE_OK` |
| `npm run demo`, `demo-dump`, `verify-fixtures` | `DUMP_OK`, `DUMP_OK`, `FIXTURES_OK` |
| secrets, tool refs, version, registry metadata | all clean |
| docs tools, envvars, links, hygiene | all clean |
| Live matrix after fixes | 48 of 48 checks pass; 36 tools, redaction, units and location switch unchanged |
| Security defect repros | F1, F2, F3, F5, F6 all report fixed |
| Protocol defect repros | `-32700`, `-32600`, `-32602` all observed on the wire |

## Behaviour changes worth knowing

- `get_history` for `telemetry/location` is refused with `LOCATION_DISALLOWED` when position is
  disabled. It does not filter records, because a filtered answer would look like a car that
  never reported position.
- JSON-RPC batching is explicitly unsupported. A batch gets one `-32600` frame naming the
  limitation; clients must send one message per line.
- Failure text can now differ between redaction on and off; `requestId` and `code` never change.

## Files

- `src/stdio-filter.ts` (new), `src/server.ts`, `src/client.ts`, `src/format.ts`,
  `src/tool-output.ts`, `src/history.ts`, `src/history-tools.ts`, `package-lock.json`.
- Tests: `test/stdio-filter.test.ts`, `test/protocol-stdio.test.ts`,
  `test/security-regressions.test.ts`, `test/history-mode.test.ts` (all new).
- Docs: `SECURITY.md`, `docs/tools-reference.md`, `docs/architecture.md`,
  `docs/development.md`, `CHANGELOG.md`.

## Regenerate

```sh
npm ci && npm run typecheck && npm run build
npm test
npm run coverage
npm run smoke && npm run smoke-http && npm run smoke-bin
npm run demo && npm run demo-dump && npm run verify-fixtures
npm run check-secrets && npm run check-tool-refs && npm run check-version && npm run check-server-json
node docs/check-docs.mjs tools && node docs/check-docs.mjs envvars && node docs/check-docs.mjs links && node docs/check-docs.mjs hygiene
npm audit --omit=dev
```
