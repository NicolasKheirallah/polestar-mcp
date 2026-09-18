# Contributing

Everything a change needs to be checkable lives in this repository: the tests, the fixture
dump, and the checks CI runs. There is no private verification step.

## Before you start

[docs/architecture.md](docs/architecture.md) explains why the server is shaped the way it is.
The domain words, which the code and the docs use consistently:

| Term | Meaning |
| --- | --- |
| **Vehicle**, **VIN** | One car the credential may see, named by its 17-character VIN. `list_vehicles` discovers the set. |
| **Account ID** | The caller identity sent as `x-client-id`. Not the OAuth client ID. |
| **Domain** | One topic of vehicle data, `telemetry/battery`. The registry in `src/domains.ts` holds one row each. |
| **Envelope** | Every Domain response arrives as `{ data, meta }`; callers see only `data`. |
| **Availability** | A field the car did not report is absent, and an empty Domain answers `404 DATA_NOT_AVAILABLE`, which means `null` here, not an error. |
| **Token Provider** | The client-credentials lifecycle: cache, skew, single-flight, invalidate on `401`. |
| **Transport** | The seam below the client. Two adapters: live HTTP with a deadline, and a captured dump. |
| **PolestarClient** | The deep module: `vehicles()`, `domain(vin, kind, name)`, `resolveVin()`. |
| **Fixture mode** | Running against the captured dump: no network, no credential. |

When you write about a module, use **module**, **interface**, **depth**, **seam**, **adapter**,
**leverage** and **locality** with their usual meanings; do not drift into "component",
"service" or "boundary" for the same idea.

## Running it

```bash
npm ci
npm run build
npm test
npm run smoke        # full MCP surface over stdio, against the synthetic dump
npm run smoke-http   # the same surface over Streamable HTTP
```

You do not need Polestar credentials for any of that. Fixture mode replays
`test/fixtures/dump/`, which contains one synthetic Vehicle and no live data.

To work against your own car, put `POLESTAR_CLIENT_ID`, `POLESTAR_CLIENT_SECRET` and
`POLESTAR_ACCOUNT_ID` in `~/.config/polestar-mcp/.env.secrets` (see
[.env.example](.env.example)). The Account ID is not the OAuth client ID; the gateway answers
`403 AUTHZ_CLIENT_ID_MISMATCH` when they are confused, which is why the loader asks for it
explicitly instead of guessing.

## The checks CI runs, and what each one is for

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | `src`, `test` and `scripts` all compile under `strict` plus `exactOptionalPropertyTypes`. `tsx` never typechecks, so without this a red build can hide behind green tests. |
| `npm run build` | The published `build/server.js` exists and is executable. |
| `npm test` | Unit behaviour: token lifecycle, Envelope and identity checks, error normalization, budget metering, retry and cache policy, the humanizer, the planner, the tool registry. |
| `npm run coverage` | How much of the source the unit suite reaches. |
| `npm run smoke` / `npm run smoke-http` | The real MCP surface end to end: handshake, every tool registered, `outputSchema` on all of them, resources, prompts, elicitation. |
| `npm run smoke-bin` | The published launch path: `--version`, `--help` and a handshake against `build/server.js` through its bin symlink, the way a global install and `npx` run it. |
| `npm run verify-fixtures` | Every Domain in the registry has a fixture and each fixture is a valid Envelope. |
| `npm run check-secrets` | No credential file in the tree, and no JWT, opaque secret, VIN-shaped identifier, personal email, phone number or precise coordinate in any scanned file. |
| `npm run check-tool-refs` | Prose an agent or operator acts on never names a tool the registry does not define. |
| `node docs/check-docs.mjs tools` | Documented tool counts match the registry, which is derived from the code rather than restated. |
| `node docs/check-docs.mjs envvars` | Every `POLESTAR_*` variable the code reads is documented, and vice versa. |
| `node docs/check-docs.mjs links` | No link points at a file or heading that does not exist. |
| `node docs/check-docs.mjs hygiene` | Writing hygiene across the whole tree: banned dashes and connector hyphens, marketing vocabulary, decorative comment banners. Each detector proves itself on a positive control first, and the walk fails if it matches too few files, so a green run cannot mean the scope quietly narrowed. |

Run them before you open a pull request. A green `npm test` alone does not mean the change is
done; the point of the table above is that each claim has something that can fail.

## Adding or changing a Domain

The registry is `src/domains.ts`. One row states the route segment, the OAuth scope, the
description, the cache lifetime that value can bear (`ttlMs`), whether background sampling
should watch it (`sampled`) and the key set its fixture must hold (`pinnedKeys`). Tool names,
the scope list sent to the token endpoint, the resource URI space, the cache policy and the
contract test all derive from that row, so a new Domain is one edit plus a captured fixture:

1. Add the row to `DOMAINS`.
2. Run `npm run capture` against your own credential, or add a synthetic fixture under
   `test/fixtures/dump/dataportal/<kind>/<name>.json` matching the `pinnedKeys` you stated.
3. Run `node docs/check-docs.mjs tools` and `npm run verify-fixtures`. If the tool count in
   `docs/tools-reference.md` no longer matches, the check tells you the number to write.

A row with no summarizer used to fail quietly by dumping raw payloads into the model's
context. `test/contract.test.ts` now refuses that, and every distance a summary renders has to
honour `POLESTAR_UNITS` or the same test fails.

## House rules this codebase already follows

- **A comment that describes protection nothing applies is a defect.** Either wire it or delete
  it. The size guard in `src/history.ts` is applied on the read path, not just promised above
  it, because it was once the other way around.
- **Every claim needs something that can fail.** New behaviour arrives with a test, a probe or a
  check. Where a check is only meaningful if it can reject something, it ships with a positive
  control that proves it fires.
- **No write endpoints.** If Polestar ships them, `POLESTAR_ENABLE_WRITES` is the opt-in they
  slot behind and the tool table in `src/tools.ts` is where a `readOnlyHint: false` row goes.
- **Never commit a live captured dump.** It holds real VINs. The default capture directory sits
  outside the project tree for that reason.
- **Writing hygiene is enforced, not advisory.** `node docs/check-docs.mjs hygiene` covers the
  whole tree; run it before CI does. Its detectors prove themselves on positive controls, so a
  green run cannot mean the scope quietly narrowed.

## Pull requests

Describe the behaviour change, not the diff. If a bug fix, name the failing check that now
passes. If a claim about what the API does changed, say how it was measured: live probes are
welcome, guesses dressed as documentation are not.
