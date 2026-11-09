# Privacy policy

Effective date: 2026-11-09. This policy describes what the `polestar-mcp` server does with
data when you run it yourself. It is a local tool, not a hosted service: there is no server
operated by this project, and the project receives nothing from your installation.

## What the server processes

- The OAuth client credentials and Account ID you configure. They are read from your
  environment or from a dotenv file outside the project tree, and are sent only to the
  Polestar token endpoint and the Polestar Data Portal endpoints you are configured to use.
- The vehicle data those endpoints return: telemetry, charging settings and, unless you turn
  it off, position. This is the same data the Polestar app and the Data Portal show to the
  account holder.
- Optionally, a local history store if you set `POLESTAR_HISTORY_DIR`. It holds the answers
  the server already fetched, in JSONL files on your machine. Nothing copies that store
  anywhere; it exists so the server can answer questions the stateless API cannot.

## Where data goes

Only to Polestar. The server makes requests to the token endpoint and the Data Portal base
URL you configure (production by default), and to nothing else. It has no analytics, no
telemetry, no error reporting service, no update check and no third-party call. Results are
returned to the MCP client you connected, which is your own assistant application; its own
privacy terms apply to anything it stores or forwards.

## What stays local

- Credentials stay in your secrets file or your client's environment block.
- The history store, when enabled, stays in the directory you chose.
- Diagnostics go to stderr. Access tokens are never logged, and the redaction switch masks
  VINs on the surfaces a client forwards to the model. `raw: true`, the resource URI identity
  and on-disk history paths are documented exceptions; see [SECURITY.md](../SECURITY.md).

## Your controls

- `POLESTAR_ALLOW_LOCATION=0` makes the server refuse position reads and strip coordinates
  from aggregate answers.
- `POLESTAR_REDACT_VIN=1` masks VINs on the model-facing surfaces described in SECURITY.md.
- `POLESTAR_HISTORY_DIR` is unset by default. Delete the directory to remove recorded history;
  the server never writes outside the directory you name.
- Your credential can be revoked at any time in the Polestar Data Portal. Removing the local
  secrets file removes the server's access on this machine.

## Who is responsible

If you run the server for yourself, you control the local data it holds. If an operator runs
it for you, that operator is responsible for the credentials, the local store and the
retention rules of the machine it runs on. This project does not receive, store or sell
personal data, and has no user accounts of its own.

## Changes and contact

Material changes to this policy appear in `CHANGELOG.md` and in this file. Questions, or a
report that would reveal a token, account identifier, real VIN or location, should follow the
private reporting route in [SECURITY.md](../SECURITY.md); anything else can be an issue at
https://github.com/nicolaskheirallah/polestar-mcp/issues.
