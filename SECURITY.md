# Security

This server reads a car. That makes it a privacy tool as much as an API client, so the
threat model here is written in those terms.

## What the server can and cannot do

- It is read-only. Every request it makes is a `GET` against the Polestar Data Portal M2M
  endpoints. There is no code path that starts climate, unlocks a door, changes a charge
  current limit or otherwise acts on a vehicle, because the published v1 contract publishes
  no write endpoints. `POLESTAR_ENABLE_WRITES` registers nothing.
- Position data is opt-out at the request layer. With `POLESTAR_ALLOW_LOCATION=false`,
  `get_location` refuses and the request is never sent, so no quota is spent on it either.
  The refusal is enforced in `PolestarClient`, not in the display layer, so a caller cannot
  reach position by another route.
- The upstream contract returns one Vehicle's data at a time and the server checks it. If a
  response is labelled a different VIN or a different Domain than the one requested, the read
  is rejected with `VIN_MISMATCH` or `DOMAIN_MISMATCH` instead of being shown. Presenting one
  car's telemetry as another's is the failure mode this server treats as unacceptable.
- Delegated reads are allowlisted. A caller may name another account per request, but the
  value must appear in `POLESTAR_DELEGATED_ACCOUNT_IDS`. The gateway answers `200` to an
  unknown delegation rather than refusing it, so the check lives here.

## What redaction does and does not do

`POLESTAR_REDACT_VIN=1` masks the VIN in rendered output and in the structured
envelope that clients forward to the model, including the resource listings. It does
not mask inside `raw: true`: that argument exists to return the upstream payload as
the API sent it, and the payload carries the VIN as a field. If you pipe tool results
into logs or a shared inbox, leave `raw` off.

## Where credentials live

Live values go in a secrets file **outside** the project tree, by default
`~/.config/polestar-mcp/.env.secrets`, overridable with `POLESTAR_ENV_FILE`. The server reads
the first candidate that exists and never writes one back. Real environment variables always
win over the file.

At startup the server stats the file and warns on stderr if group or other can read it, with
the `chmod 600` command to fix it. It warns rather than rewriting your filesystem.

`.env.example` is the only `.env*` file in the repository and holds no values. The
`npm run check-secrets` gate treats any other `.env*` path inside the tree as a finding, and
scans for structural shapes (JWT segments, credential-length opaque strings, VIN-shaped
identifiers, personal email, phone, precise coordinates) rather than embedding any real value.

## What leaves your machine

Only `GET` requests to the Data Portal endpoints you configure, plus the OAuth token request.
There is no analytics, no update check, no third-party call. Diagnostics go to `stderr` and
nothing else; in stdio mode `stdout` carries only the MCP protocol.

Access tokens are never logged. One test asserts that no log statement in the request path
mentions a token or an authorization header. When an upstream response is shown, the
`requestId` is preserved because that is the handle Polestar support can act on.

## Rate limits are treated as a safety property

The API allows 10,000 calls per client per day and 100 per minute. The server meters every
live attempt and fails closed at the ceiling rather than hammering an endpoint that will only
answer `429`. Background sampling is off by default and stands down at 80 percent of the
daily budget, because an unattended poller spending a shared quota nobody asked for is exactly
the kind of surprise this project is supposed to avoid.

## HTTP mode

`POLESTAR_HTTP_PORT` serves Streamable HTTP and binds `127.0.0.1` unless `POLESTAR_HTTP_HOST`
says otherwise. Binding a non-loopback address **requires** `POLESTAR_HTTP_TOKEN`: the server
refuses to start otherwise, because an unauthenticated listener would put vehicle location on
whatever network that interface reaches. When a token is set, every request must present
`Authorization: Bearer <token>`. That token is a shared secret, not per-user authentication:
everyone who holds it can read every Vehicle the credential can see. Keep it on loopback, or
put it behind something that authenticates.

## Test data

Fixtures under `test/fixtures/dump/` are synthetic. Test doubles use the reserved marker
`YSMTEST` plus digits, which cannot be a real Polestar identifier. Captured live dumps are
never committed; `npm run check-secrets` fails if one appears in the tree.

## Reporting a problem

Open a GitHub issue for anything that is not a live-credential exposure. For a report that
would reveal a token, an Account ID, a real VIN or a location, use the repository's private
vulnerability reporting if it is enabled, or open an issue that describes the flaw and attach
nothing. Redact `POLESTAR_*` values before pasting any configuration, and include the
`requestId` of the failing call instead of the request itself.
