# Getting started

Who this is for: anyone who wants to ask an AI assistant about their Polestar. No programming needed beyond pasting a few commands. Developers will find the internals in [architecture.md](architecture.md) and the full tool list in [tools-reference.md](tools-reference.md).

## What this is

`polestar-mcp` is a server that connects an MCP client (Claude Desktop, ZCode, or any other tool that speaks the Model Context Protocol) to the Polestar Data Portal M2M API. Once it is connected, you can ask your assistant things like "how is my car doing?" or "is everything locked?" and it will call one of the server's tools to get the answer from Polestar's servers.

The whole surface is read-only: every tool carries the MCP `readOnlyHint`, and nothing is ever sent to the car. That is a property of the API Polestar publishes today, not a choice this server made (see [upstream-api.md](upstream-api.md)).

Because the API allows only 10,000 calls per client per day, the server manages that budget for you: repeated reads are served from a cache, every live call is metered, and the server refuses (rather than fails mid-answer) once the day's budget is spent. A `polestar_status` tool lets your assistant check what is left.

## What you need

- Node.js 20 or newer (`node --version` to check).
- An MCP client, that is, an app that can connect to MCP servers.
- One of:
  - a **Polestar Data Portal credential** (for live data), or
  - **nothing at all** (for fixture mode, which replays a previously captured snapshot of responses so you can try the server offline).

## Step 1: Get a Data Portal credential

1. Log in at [data-portal.polestar.com](https://data-portal.polestar.com).
2. Open the **Data Portal API** tab.
3. Create a credential. Three values matter, and the page shows all of them:
   - the **client ID**,
   - the **client secret** (shown once, so store it somewhere safe),
   - the **Account ID**, also labeled **x-client-id**, shown near the top of the page.

The Account ID and the OAuth client ID are two different identifiers, and the API needs both. This is worth getting right: the gateway rejects every request whose `x-client-id` carries the OAuth client ID instead of the Account ID (error 403 `AUTHZ_CLIENT_ID_MISMATCH`), and the server warns at startup when it detects the two values are identical. See [upstream-api.md](upstream-api.md) for where each one is used.

## Step 2: Store the credential outside the project

The server reads a small dotenv-style file that lives in your home directory, deliberately outside any repository or download folder. Real environment variables always win over the file, and the file only fills in the blanks.

```sh
mkdir -p ~/.config/polestar-mcp
cat > ~/.config/polestar-mcp/.env.secrets <<'EOF'
POLESTAR_CLIENT_ID=paste-your-client-id-here
POLESTAR_CLIENT_SECRET=paste-your-client-secret-here
POLESTAR_ACCOUNT_ID=paste-your-account-id-here
EOF
```

Keep that file private. It is the equivalent of a password for your car's data. The loader handles the usual dotenv idioms: a leading `export` statement, values in either kind of quote, and trailing `#` comments (a `#` inside a quoted value stays data).

If you would rather keep the file somewhere else, set the `POLESTAR_ENV_FILE` environment variable to its full path. The file is never looked for inside the project tree on purpose, and in fixture mode it is not read at all, so offline use never touches a live credential file.

## Step 3: Build and register the server

From the `polestar-mcp` folder:

```sh
npm install
npm run build
```

Then add an entry like this to your MCP client's configuration (in Claude Desktop this is `claude_desktop_config.json`, in other clients look for "MCP servers" in their settings):

```json
{
  "mcpServers": {
    "polestar": {
      "command": "node",
      "args": ["/absolute/path/to/polestar-mcp/build/server.js"],
      "env": {
        "POLESTAR_CLIENT_ID": "<client id>",
        "POLESTAR_CLIENT_SECRET": "<client secret>",
        "POLESTAR_ACCOUNT_ID": "<account id / x-client-id>"
      }
    }
  }
}
```

The `env` block is optional if you created the secrets file in step 2. Use one or the other. Restart your MCP client afterwards so it picks up the new server.

## All environment variables

The server knows exactly which `POLESTAR_*` variables exist. When you set one it does not recognize, it warns on startup (and suggests the closest real name, so a typo is visible); with `POLESTAR_STRICT_ENV=1` an unknown variable is fatal instead. A value that is present but unusable (a bad URL, a non-numeric timeout, an out-of-range port) fails fast with an explanation before any request is made.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POLESTAR_CLIENT_ID` | (required live) | OAuth client ID from the Data Portal |
| `POLESTAR_CLIENT_SECRET` | (required live) | OAuth client secret from the Data Portal |
| `POLESTAR_ACCOUNT_ID` | (required live) | The Account ID, sent as `x-client-id` on every vehicle request. Distinct from the OAuth client ID |
| `POLESTAR_DELEGATED_ACCOUNT_ID` | unset | Third-party credentials only: default account whose shared vehicles you access (`x-delegated-account-id`) |
| `POLESTAR_DELEGATED_ACCOUNT_IDS` | unset | Semicolon-, comma-, or space-separated allowlist of delegated account IDs a call may select with its `delegated_account_id` argument. A requested ID outside the list is refused (`DELEGATION_NOT_ALLOWED`) instead of sent, because the API silently accepts unknown delegated IDs |
| `POLESTAR_BASE_URL` | production URL | Override the API base URL. The default is `https://pc-api.polestar.com/eu-north-1/data-portal/m2m` |
| `POLESTAR_M2M_TOKEN_ENDPOINT` | `{base URL}/token` | Override just the token endpoint |
| `POLESTAR_FIXTURES_DIR` | unset | Fixture mode: serve captured responses from this directory instead of calling the real API |
| `POLESTAR_ENV_FILE` | unset | Full path to a dotenv file to load, instead of `~/.config/polestar-mcp/.env.secrets` |
| `POLESTAR_TIMEOUT_MS` | 15000 | Hard deadline per HTTP request |
| `POLESTAR_BUDGET` | 10000 | Daily live-call ceiling. The server fails closed at the limit |
| `POLESTAR_BUDGET_PER_MINUTE` | no | Rolling per-minute ceiling the API also publishes (100 req/min). Waits it out rather than failing; `100` default |
| `POLESTAR_CACHE` | on | `off` (or `disabled`, `0`, `false`) disables the response cache |
| `POLESTAR_SCOPES` | all domain scopes | Space- or comma-separated scope override for the token request |
| `POLESTAR_HISTORY_DIR` | unset | Enable the local history store and background sampler in this directory |
| `POLESTAR_HISTORY_SAMPLE_SECONDS` | 600 | Seconds between sampler rounds (clamped 60 to 3600) |
| `POLESTAR_SAMPLE` | off | `1` (or `true`, `on`) actually runs the background sampler. Off by default: polling spends the shared quota |
| `POLESTAR_VEHICLE_LABELS` | unset | Semicolon-separated `VIN=Friendly Name` pairs; output uses the name instead of the VIN |
| `POLESTAR_REDACT_VIN` | off | `1` (or `true`, `on`) masks VINs in tool output and in the structured envelope (first 3 and last 3 characters). `raw:true` is the exception: the payload comes back exactly as the API sent it, VIN included |
| `POLESTAR_ALLOW_LOCATION` | on | `0` (or `false`, `off`, `disabled`) makes `get_location` refuse and strips coordinates from aggregates |
| `POLESTAR_UNITS` | km | `mi` (or `miles`) for humanized distances |
| `POLESTAR_LOG` | normal | `debug` enables verbose stderr diagnostics |
| `POLESTAR_ENABLE_WRITES` | off | Scaffold for future write endpoints; registers nothing today |
| `POLESTAR_HTTP_PORT` | 0 (stdio) | 1 to 65535 serves the same surface over Streamable HTTP instead of stdio |
| `POLESTAR_HTTP_HOST` | 127.0.0.1 | HTTP bind address |
| `POLESTAR_HTTP_TOKEN` | unset | Bearer token for HTTP mode; required when binding anything but loopback |
| `POLESTAR_STRICT_ENV` | off | `1` (or `true`, `on`) makes an unrecognized variable fatal |

## First calls

Ask your assistant something natural. Behind the scenes it will pick the right tool:

- "What cars can I see?" calls `list_vehicles`.
- "How is my car doing?" calls `get_car_status`, a one-call briefing over charge, range, locks, odometer, and service.
- "Is everything locked?" calls `is_car_secure`, which names anything open.
- "When will it be charged?" calls `get_charging_estimate`.
- "Plan the cheapest charging for tonight" calls `plan_cheapest_charge` after you paste hourly prices from your tariff provider.

The full list of tools, with example responses, is in [tools-reference.md](tools-reference.md). Three behaviors worth knowing before you start:

- **Missing data is not an error.** A Polestar reports each topic of data independently, and some cars simply do not report some topics. When you ask for a topic the car does not report (most often `get_is_at_charge_location`), the tool answers with a plain sentence saying no data is available for that vehicle.
- **Every answer carries a data age.** The cloud may re-serve a value the car reported minutes (or, for charging settings, days) ago. The age line tells you how fresh the answer is before you trust it.
- **One credential, several cars.** With several VINs on the credential, tools ask for an explicit `vin` rather than guessing; with exactly one, you can omit it everywhere.

## History, sampling, and privacy

Set `POLESTAR_HISTORY_DIR` to a directory and the server records every live domain answer to an append-only store there, deduplicated by the cloud's change ID so unchanged snapshots cost a single line. Passive recording costs nothing extra: it reuses answers the server already fetched. If you also want the car sampled while no client is asking, set `POLESTAR_SAMPLE=1`, which runs a background round over the fast-moving domains (battery, odometer, location, exterior) every 10 minutes by default (`POLESTAR_HISTORY_SAMPLE_SECONDS` tunes this) and stands down entirely once 80% of the daily budget is spent. Sampling is off by default because polling spends the shared quota. The history tools (degradation trend, charging sessions) only exist when history is on.

Three privacy dials are built in: `POLESTAR_VEHICLE_LABELS` gives your cars friendly names (`POLESTAR_VEHICLE_LABELS="YSMTEST22PL000001=My Car"`), so answers say "My Car" instead of printing identifiers; `POLESTAR_REDACT_VIN=1` masks VINs in rendered output and in the structured envelope (first 3 and last 3 characters), with `raw:true` deliberately left faithful to the upstream payload; and `POLESTAR_ALLOW_LOCATION=0` makes the server refuse location reads and strip coordinates from aggregate answers.

## HTTP mode

Set `POLESTAR_HTTP_PORT` (for example 8420) and the server serves the same tools, resources, and prompts over stateless Streamable HTTP instead of stdio. It binds `127.0.0.1` by default; binding any other address requires `POLESTAR_HTTP_TOKEN`, because the server reads vehicle location and an unauthenticated network listener would be a real risk. Subscriptions remain a stdio feature.

## Trying it without a Polestar credential

Fixture mode answers every tool call from a directory of captured JSON responses instead of the network. It still runs the normal token flow against a captured token response, so what you see is what live use looks like, just with recorded data. The captured dump sits one level above the project, so from inside `polestar-mcp` you can start it like this:

```sh
POLESTAR_FIXTURES_DIR=.. npm start
```

or run the scripted demo, which asserts real values from that dump and prints `DUMP_OK`:

```sh
npm run demo-dump
```

A dump without a token response fails with `AuthError: Token request failed (HTTP 404)`. That is intentional: the server does not silently skip authentication in fixture mode.

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `Missing environment variables: POLESTAR_CLIENT_ID, ...` | The server found neither environment variables nor a secrets file (note that `POLESTAR_ACCOUNT_ID` is required too, not optional) | Create the secrets file from step 2, or fill the `env` block in your client config |
| `Invalid POLESTAR_...: ...` at startup | A variable was set but cannot be used (bad URL, non-numeric number, out-of-range port) | Follow the guidance in the message; fix or remove the variable |
| `unrecognized variable: POLESTAR_... (did you mean ...?)` | You set a variable the server does not read, so it has no effect | Fix the name (the suggestion is usually right). With `POLESTAR_STRICT_ENV=1` this exits instead of warning |
| `POLESTAR_ACCOUNT_ID equals POLESTAR_CLIENT_ID` warning | The gateway rejects the OAuth client ID as `x-client-id` with 403 `AUTHZ_CLIENT_ID_MISMATCH` on every call | Set `POLESTAR_ACCOUNT_ID` to the Account ID shown next to the Base URL in the Data Portal |
| `AuthError: Token request failed (HTTP 401)` | The client ID or client secret is wrong | Re-create the credential on the Data Portal and update the secrets file |
| `AuthError: Token request failed (HTTP 404)` | The token endpoint was not found: a wrong base URL, or a fixture dump without a token response | Check `POLESTAR_BASE_URL`; in fixture mode make sure `token.json` exists in the dump |
| `Daily API budget exhausted: ...` | The 10,000 calls/day ceiling was reached; the server fails closed instead of hammering the API | Wait for the midnight UTC reset, or raise `POLESTAR_BUDGET` only if you know your allowance differs |
| `AMBIGUOUS_VIN` | The credential sees several cars and no `vin` was passed | Run `list_vehicles` and pass an explicit VIN |
| `INVALID_VIN` | The VIN passed is not a plausible VIN (17 characters, no I/O/Q) | Check for a truncated or typoed VIN |
| `Request to ... did not complete within ...ms` | Polestar did not answer within the deadline | Retry later; the deadline is `POLESTAR_TIMEOUT_MS` (default 15 seconds) |
| A tool answers "No ... data is available for vehicle ..." | The car does not report that topic. This is a normal answer, not a failure | Ask for a different topic, or check [tools-reference.md](tools-reference.md) |
| `NOT_FOUND` errors in fixture mode | A fixture file is missing or misspelled for a route the server knows | This is deliberate: a missing fixture must not masquerade as "the car reports nothing". Fix the dump layout |
| `Refusing to serve on ... without POLESTAR_HTTP_TOKEN` | HTTP mode tried to bind a non-loopback address without authentication | Keep `127.0.0.1`, or set `POLESTAR_HTTP_TOKEN` and send `Authorization: Bearer <token>` |
| The server never appears in your client | The client could not start `build/server.js` | Run `npm run build`, check the absolute path in your client config, and look at the client's MCP logs. The server writes its diagnostics to stderr only, because stdout carries the protocol |

One habit worth keeping: the API allows 10,000 calls per client per day. Interactive questions use calls at a human pace, and the cache absorbs repeats, but a script that polls the car in a tight loop will exhaust the daily allowance. The server meters every live call it makes (including retries) and refuses to spend the last call recklessly; `polestar_status` shows exactly where the budget stands.
