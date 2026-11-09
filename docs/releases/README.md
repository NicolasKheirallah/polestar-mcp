# Release process

Status: the release machinery is prepared in this tree but nothing has been published.
Publishing is blocked on two owner decisions: npm credentials for the `polestar-mcp` name,
and confirmation that the registry name `io.github.nicolaskheirallah/polestar-mcp` is
available. Do not run a publish from a development machine; the tag workflow is the only
path.

## One-time owner setup

1. Confirm the npm name is available: `npm view polestar-mcp version` must return `E404`.
   A 404 proves the name is unpublished, not reserved, so check again immediately before
   the first tag. If it is taken, pick a scoped name and update `package.json.name`,
   `server.json.packages[0].identifier` and the `mcpName` value together.
2. Create an npm automation token with publish rights and store it as the repository
   secret `NPM_TOKEN`.
3. The MCP Registry step authenticates with GitHub OIDC (`id-token: write` is already in
   the workflow), so it needs no second secret.

## Cutting a release

1. Set the version once in `package.json`. `npm run check-version` requires the same version
   in `server.json` (top level and the npm package entry), the README badge, the newest
   released `CHANGELOG.md` heading and `docs/releases/vX.Y.Z.md`.
2. Write `docs/releases/vX.Y.Z.md` and move the `Unreleased` changelog entries under a new
   `## X.Y.Z` heading.
3. Run the local gate list: `npm run typecheck`, `npm run build`, `npm test`,
   `npm run coverage`, `npm run demo`, `npm run check-version`,
   `npm run check-server-json`, and the four `node docs/check-docs.mjs` gates.
4. Push a `vX.Y.Z` tag. The `release` workflow repeats those checks, asserts the tag matches
   the package version, publishes the npm package with provenance, publishes the registry
   metadata, and creates the GitHub release.

## What the workflow does today

`.github/workflows/release.yml` runs every check on a tag. The npm publish, the
`mcp-publisher` install, the registry login and publish, and the GitHub release are gated on
`NPM_TOKEN`. Without it the tag still passes verification and the workflow prints a notice
that publishing was skipped. That is the honest state until the owner supplies credentials.

## Until the first publish

Use the repository path from the release note: clone, `npm ci`, `npm run build`, then point
the MCP client at `build/server.js`. See [v0.3.0.md](v0.3.0.md) for the exact commands, and
[SECURITY.md](../../SECURITY.md) for the credential model.
