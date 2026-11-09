# Claude Desktop bundle

Status: **metadata and checklist only. No `.mcpb` artifact exists yet.** Building it is blocked
on the `@anthropic-ai/mcpb` CLI (not installed in this environment), a macOS and Windows
Claude Desktop host to install and test it, and the owner's distribution decision. The
manifest is [mcpb/manifest.json](../mcpb/manifest.json).

## What the manifest declares

- `manifest_version` 0.3, the current MCPB spec version.
- `name` `polestar-mcp`, `version` 0.3.0 (must stay equal to `package.json` and `server.json`;
  `test/docs-gates.test.ts` checks the manifest version against the package version).
- `server.type` `node`, entry point `server/build/server.js` inside the bundle.
- `user_config`: the OAuth client ID, the client secret (`sensitive: true`, so the host keeps
  it in the OS keychain), the Account ID and an `allow_location` boolean. These map into the
  documented `POLESTAR_*` variables; no credential is stored in the manifest or the bundle.
- `privacy_policies` points at the rendered privacy policy, which the spec requires for a
  bundle whose server contacts an external service.
- `compatibility`: macOS and Windows, Node 20.11 or newer.
- `tools_generated` and `prompts_generated` are true because the tool and prompt surface is
  built from the Domain registry at runtime, not enumerated in the manifest.

## Build checklist for the owner

1. Install the CLI: `npm install -g @anthropic-ai/mcpb` (or run it with `npx`).
2. In the repository: `npm ci && npm run build && npm test`.
3. Create a staging directory with the runtime payload only:
   - `server/build/` from this repository,
   - `server/package.json` (the server reads its version from it),
   - `server/node_modules/` installed with `npm ci --omit=dev` inside the staging directory,
   - `test/fixtures/dump/` only if the bundle should also carry the synthetic demo data.
4. Copy the manifest: `cp mcpb/manifest.json <staging>/manifest.json`.
5. Validate and pack: `mcpb pack <staging> polestar-mcp.mcpb` (the CLI validates the manifest
   and the entry point). Keep the artifact out of the repository.
6. Install the `.mcpb` in Claude Desktop on macOS and on Windows. Check that the three
   credential fields appear, that the secret field is masked and stored by the host, and that
   `car-status` and `charge-plan` appear as prompts, plus `battery-health-report` when the history store is enabled.
7. Run one live read (`get_car_status`) with a real credential, then one fixture-only check
   from a checkout with `npm run demo`, so the bundle path and the source path are both
   exercised.

## What remains blocked

- The `mcpb` CLI is not installed here, so no `.mcpb` file is produced or validated by the CLI.
- No Claude Desktop host on macOS or Windows is available to install and test a bundle.
- No icon or screenshots exist yet. Both are optional in the spec, but a curated directory may
  expect an icon, so the owner should add one before submitting.
- The npm package and MCP Registry entry are prepared but unpublished (owner credentials and
  npm name availability); the bundle is a third channel with the same owner gate.

## Doing this without a bundle

Until the bundle exists, point Claude Desktop at the built server directly, as in
[getting-started.md](getting-started.md). The bundle changes installation, not behaviour:
the same stdio server, the same tools and the same read-only posture. The bundle specification
is at https://github.com/anthropics/mcpb.
