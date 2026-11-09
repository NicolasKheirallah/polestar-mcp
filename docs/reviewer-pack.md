# Reviewer pack

This file collects what a directory reviewer, a client integrator or a cautious user needs to
judge `polestar-mcp` without installing it first. It is written for the current 0.3.0 state.

## What it is

A read-only Model Context Protocol server for the Polestar Data Portal M2M API. It answers
questions about one or more vehicles: charge and range, locks and openings, service
countdown, charging settings and windows, position when allowed, and an opt-in local history
that makes battery and charging questions answerable over time. It registers no write tool,
because the published v1 API has no write endpoint.

## Sample data and the no-credential path

The repository ships a synthetic captured dump under `test/fixtures/dump`. It contains one
`YSMTEST...` vehicle with no real VIN, no real coordinates and no credential; the marker
cannot be a real Polestar identifier. To try the server without a Polestar account:

```sh
npm ci
npm run build
npm run demo        # plain Node, no tsx, prints DUMP_OK
```

`npm run demo-dump` is the same check through the contributor toolchain. Both replay the
dump through the full token lifecycle, and both are run in CI. A real capture is never
committed; `npm run capture` writes it outside the project tree, and `npm run check-secrets`
fails if a live dump appears inside the tree.

## Three example prompts

The server registers three MCP prompts. They are the three use cases to review:

1. `car-status`: "Give me a status briefing for my Polestar." It routes to `get_car_status`,
   then `is_car_secure`, then `get_needs_attention`, and ends with a two-line summary.
2. `charge-plan`: "Plan the cheapest charging hours for tonight given spot prices." It asks
   for hourly prices in a documented shape and routes to `plan_cheapest_charge`, which is
   read-only advice: the plan is computed locally and nothing is sent to the car.
3. `battery-health-report`: "Report on my Polestar's battery health." It routes to
   `get_degradation_report` and `get_charging_sessions` when history is enabled, and says when
   there is not enough recorded history to conclude anything.

The full tool list is in [tools-reference.md](tools-reference.md); the machine registry is
`src/domains.ts`.

## Safety and data handling

- Read-only: every tool carries `readOnlyHint: true`, `POLESTAR_ENABLE_WRITES` registers
  nothing, and `test/posture.test.ts` holds both statements.
- Credentials live outside the repository by default, in `~/.config/polestar-mcp/.env.secrets`
  or the client's environment block. There is no hosted service and no project-run backend.
- Only Polestar is contacted: the token endpoint and the Data Portal base URL the operator
  configures. No analytics, telemetry, update check or third-party call.
- Location can be refused at the request layer with `POLESTAR_ALLOW_LOCATION=0`; VIN masking
  is available with `POLESTAR_REDACT_VIN=1` and documents its three exceptions.
- The privacy policy is [privacy.md](privacy.md). The threat model and credential model are in
  [SECURITY.md](../SECURITY.md).

## Directory-policy checklist

| Requirement | Where it is met |
| --- | --- |
| Accurate tool descriptions that match functionality | `src/domains.ts` and the per-tool specs; `npm run check-tool-refs` rejects prose that names a tool the registry does not define |
| Graceful errors with actionable feedback | `src/failure.ts` and the hint table in `src/tool-output.ts`; every minted code has advice and a test |
| Frugal token use | results are short prose plus structured data; `tools/list` is checked against a budget in `test/`; there is no always-on sampling |
| Sample data and a no-credential trial | the synthetic dump plus `npm run demo`, both above |
| At least three working example prompts | the three MCP prompts above |
| Privacy disclosure | [privacy.md](privacy.md), linked from the README and carried as `privacy_policies` in the bundle manifest |
| No affiliation claim | the README status section states this is a personal project, not affiliated with or endorsed by Polestar |

## Distribution status

The npm package and the MCP Registry entry are prepared in this tree and publish from a
tag-driven release workflow with provenance, but they are not published yet. Publishing is
blocked on the owner's npm credentials and on npm name availability; until then the supported
path is a repository clone with `npm ci && npm run build`. The Claude Desktop bundle metadata
is in `mcpb/manifest.json`; building the `.mcpb` file is blocked on the `mcpb` CLI and a
desktop host to test it, as described in [bundle.md](bundle.md).

## Support and reporting

Issues: https://github.com/nicolaskheirallah/polestar-mcp/issues. Security reports follow
[SECURITY.md](../SECURITY.md). Include the `requestId` from a failing Polestar call rather
than the request body, and never paste a token, Account ID or real VIN.
