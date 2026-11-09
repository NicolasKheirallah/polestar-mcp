# README review: MCP client operator and directory reviewer

Scope: `README.md` at commit `13e878e` in `polestar-mcp`, read in full. Cross-read:
`docs/getting-started.md`, `docs/tools-reference.md`, `SECURITY.md`, `docs/privacy.md`,
`docs/bundle.md`, `docs/reviewer-pack.md`, plus the source and metadata needed to check the
README's claims. No tracked file was edited, no build or install was run, and the live API was
not called. Local fixture-mode probes were used to check the default surface and the HTTP
listener; commands are listed at the end.

Result: the README is accurate about most of the server's behaviour, and its read-only posture,
demo path, two-identifier trap and budget explanation are strong. It does not yet answer the
operator questions about client configuration, startup failure, live verification, privacy
exceptions and transport choice precisely enough. There are eight must-fix findings, ten
suggestions, and two factual claims (history deduplication wording and the error timestamp) that a
directory reviewer is likely to catch.

## Operator question matrix

| Question an operator asks | Answered? | Where | Comment |
| --- | --- | --- | --- |
| Which clients work | Partial | line 7, line 46 | Names three clients, one unsubstantiated, and gives no compatibility detail |
| Exact client configuration | Partial | lines 83 to 96 | One stdio JSON snippet, no config file location, no `env` variant, no HTTP client snippet |
| Does the demo need a credential | Yes | lines 47, 51 to 67 | Clear; could state explicitly that fixture mode never reads the secrets file |
| Client ID versus Account ID trap | Yes | line 98 | Well covered, with the exact error code and the startup warning |
| When to use stdio and when HTTP | Partial | lines 232 to 238 | HTTP behaviour is explained, but there is no decision guidance and no HTTP security caveat |
| What subscriptions do and do not support | Partial | lines 191, 236 | Missing client capability requirement, the 50-subscription cap, and the exact HTTP refusal |
| How budget and quota behave | Good | lines 195 to 216 | Missing the UTC reset time and the fact that the token request and retries are metered |
| What history stores and where | Partial | lines 218 to 230 | Dedup sentence is wrong; no directory layout, no retention, no statement that position is stored |
| Privacy controls and exceptions | Partial | lines 222 to 230 | Only the `raw:true` exception; the resource URI and on-disk path exceptions are missing |
| How failures surface | Partial | lines 123, 313 | No error envelope description, and the timestamp claim is not true of the rendered output |
| What to do when the server will not start | Missing | none | Only in `docs/getting-started.md`, not linked from the README's quick start or connection check |
| How to verify a live connection | Partial | lines 102 to 104 | Names two tools; no command line, no stderr checks, no expected values |
| Package and registry distribution status | Yes, but buried | lines 331 to 337 | Accurate, but only after someone has read 330 lines and possibly tried `npx` |
| What is deliberately out of scope | Partial | lines 333 to 337 | Read-only and the consumer API are named; a crisp out-of-scope list is missing |
| Client-behaviour claims are accurate | Partial | lines 21, 136, 193 | Auto-approval is overstated for clients generally; multi-car elicitation is incomplete |

## Must-fix findings

### M1. There is no troubleshooting section and no link to the existing one

Problem: the README tells a reader to build, register and restart a client, then stops. If the
client never shows the server, the only help is a row in a document reached through the
Documentation table at the bottom. The questions "the server will not start" and "where do I see
the error" have no answer on the main page.

Evidence: `docs/getting-started.md#troubleshooting` has a 15-row table that covers missing
environment variables, invalid configuration, the Account ID trap, `AuthError` 401 and 404, budget
exhaustion, `AMBIGUOUS_VIN`, `INVALID_VIN`, timeouts, `DATA_NOT_AVAILABLE`, fixture `NOT_FOUND`,
HTTP token refusal and a client that never launches the server. The README says only
"Restart the client" (line 96) and "If something looks wrong, `polestar_status` shows..." (line 104).

Proposed change: add a `## Troubleshooting` section immediately after "Check the connection"
(before "What you can ask"), add it to the Contents list, and end it with a link to the full
table. Suggested text:

```markdown
## Troubleshooting

The server writes diagnostics to stderr; stdout carries only the MCP protocol. A startup failure
therefore appears in the client's MCP log, not in the chat.

| Symptom | Cause | Fix |
| --- | --- | --- |
| The client shows no polestar server | the client cannot launch the built server | run `npm ci && npm run build`, use the absolute path to `build/server.js` (and to `node` if the client cannot find it), then restart the client |
| `Missing environment variables: ...` | no secrets file and no client `env` block | create `~/.config/polestar-mcp/.env.secrets` or fill the `env` block |
| `403 AUTHZ_CLIENT_ID_MISMATCH` on every call | `POLESTAR_ACCOUNT_ID` holds the OAuth client ID | use the Account ID from the Data Portal page |
| `AuthError: Token request failed (HTTP 401)` | wrong client ID or secret | re-create the credential and update the file |
| `AuthError: Token request failed (HTTP 404)` | wrong base URL, or a fixture dump without a token response | check `POLESTAR_BASE_URL`; add `token.json` to the dump |
| `Daily API budget exhausted: ...` | the daily allowance is spent | wait for the 00:00 UTC reset, or raise `POLESTAR_BUDGET` only if your allowance differs |
| `AMBIGUOUS_VIN` | several cars on the credential and the client cannot be asked which one | pass an explicit `vin` from `list_vehicles` |
| `Refusing to serve on ... without POLESTAR_HTTP_TOKEN` | HTTP mode on a non-loopback address without a bearer token | bind 127.0.0.1, or set a token of at least 16 characters |
| A tool answers "No ... data is available" | the car does not report that topic | this is a normal answer, not a failure |

`node build/server.js --version` and `--help` exit before the protocol starts and prove the build
and the Node version. `POLESTAR_LOG=debug` adds verbose stderr. The full table, including invalid
configuration and fixture `NOT_FOUND`, is in
[getting started](docs/getting-started.md#troubleshooting).
```

### M2. Client configuration is incomplete for a real client

Problem: the one JSON snippet names `command` and `args`, but not where the file lives, not the
`env` form that the README itself mentions in prose (line 100), and not how an HTTP-capable client
is pointed at the listener. The README also promises "any MCP client" (line 7) without saying
which MCP capabilities change the experience. A reader with Cursor, an HTTP client, or a client
that cannot find `node` on its PATH has to leave the main page.

Evidence: `docs/getting-started.md` line 58 names `claude_desktop_config.json` and says "in other
clients look for MCP servers in their settings", and lines 60 to 76 show the `env` block variant.
The README mentions the `env` option but shows only the file form. The HTTP listener answers a
POST initialize at both `http://127.0.0.1:PORT/` and `http://127.0.0.1:PORT/mcp` (local probe),
and prints `HTTP mode: http://127.0.0.1:PORT (stateless; tools, resources and prompts; no
subscriptions)` on stderr, but none of that is in the README.

Proposed change: extend step 3 of "Connect your car" (or add a `### Client configuration`
subsection after it) with the file location pointer, the `env` variant, the HTTP form, and a short
compatibility table. Suggested text:

````markdown
The snippet above is the `mcpServers` shape used by Claude Desktop and several other clients;
where the file lives depends on the client and the platform, so use the location that client
documents ([getting started](docs/getting-started.md#step-3-build-and-register-the-server) shows
the Claude Desktop form). Keep the absolute path, and use the absolute path to your Node
executable if the client cannot find `node` on its PATH.

The credentials can ride in the client's `env` block instead of the secrets file. Use one or the
other:

```json
{
  "mcpServers": {
    "polestar": {
      "command": "node",
      "args": ["/absolute/path/to/polestar-mcp/build/server.js"],
      "env": {
        "POLESTAR_CLIENT_ID": "<client id>",
        "POLESTAR_CLIENT_SECRET": "<client secret>",
        "POLESTAR_ACCOUNT_ID": "<account id, not the client id>"
      }
    }
  }
}
```

For HTTP mode, point an HTTP-capable client at `http://127.0.0.1:8420/mcp` and send
`Authorization: Bearer <POLESTAR_HTTP_TOKEN>`; client configuration keys differ, so use the
client's remote-server form.

What changes with the client:

| Capability | Effect |
| --- | --- |
| Launches a process (stdio) | the full surface, including subscriptions |
| Speaks Streamable HTTP | the same tools, resources and prompts, but no subscriptions |
| Supports MCP prompts | sees `car-status` and `charge-plan`, plus `battery-health-report` with history |
| Honours `readOnlyHint` | may run reads without asking; clients that ignore annotations still prompt |
| Supports elicitation or the 2026 input flow | multi-car credentials get a "which car" question; otherwise the call returns `AMBIGUOUS_VIN` with the VIN list |
````

### M3. Redaction exceptions are incomplete in the two README tables

Problem: both the history table (line 227) and the configuration table (line 268) say `raw:true`
is the only redaction exception. `SECURITY.md` documents three exceptions: `raw:true`, the
resource URI identity, and on-disk history paths. A resource URI is sent to the client and is
likely to be logged there, so an operator who enables redaction for transcripts would still see
the full VIN in every resource URI and every listed resource address.

Evidence: `SECURITY.md` lines 36 to 48 list the three exceptions. The current server masks tool
text, the structured envelope, resource names, descriptions and bodies, completion values, prompt
text and error text (verified by a fixture-mode prompt probe under `POLESTAR_REDACT_VIN=1`, which
rendered the masked form), while the URI keeps the raw VIN by design.

Proposed change: replace the two table rows with one consistent wording. Suggested history table
row:

```markdown
| `POLESTAR_REDACT_VIN=1` | Masks VINs in tool text, the structured envelope, resource names, descriptions and bodies, completion values, prompt text and error text (first 3 and last 3 characters). Three documented exceptions: `raw:true` returns the upstream payload VIN included; the resource URI keeps the VIN so the resource stays readable and subscribable; the on-disk history directory and file names carry the VIN and never leave the machine |
```

Add after the table: "Resource URIs are the one client-visible surface redaction does not cover.
If the VIN must not appear in a client transcript, do not enable resource listing for that client,
or keep the transcript on a machine you control."

### M4. The deduplication sentence says the opposite of what the code does

Problem: line 220 says the store is "deduplicated by `metaEventId`; an unchanged snapshot costs
one line." The store skips the append when `metaEventId` is unchanged, so an unchanged snapshot
costs zero lines. `docs/getting-started.md` line 132 repeats the same wording ("unchanged
snapshots cost a single line").

Evidence: `src/history.ts` `append()` returns early when the incoming `metaEventId` equals the
last stored id, before writing anything. A Lane B live probe confirmed one battery record after
three read paths with the same cloud change id.

Proposed change: in the README History section and in `docs/getting-started.md`, replace with:
"deduplicated by the cloud's `metaEventId`: an unchanged snapshot appends nothing, so a file grows
only when the car reports a change."

### M5. The error field claim is not true of what the operator sees

Problem: line 313 says "Every API error preserves the requestId and timestamp Polestar support can
look up." The rendered failure text and the structured envelope carry the `requestId` when the API
sent one. They do not carry the upstream timestamp: the client parses it, `failure.ts` drops it,
and the result schema has no timestamp field. A directory reviewer who tries to find the timestamp
in a result will not.

Evidence: `src/failure.ts` `toFailure()` and the `Failure` interface expose `code`, `message`,
`httpStatus`, `requestId` and `minted`, with no timestamp. `src/tool-output.ts` `resultShape` has
`code`, `httpStatus`, `requestId` and `hint`, no timestamp. `client.ts` and `auth.ts` do parse the
upstream timestamp, which is why the internal claim exists, but it never reaches the client.

Proposed change, documentation only: replace line 313 with "Every API error keeps the upstream
`code`, `httpStatus` and, when Polestar sent one, the `requestId` that support can look up. Quote
the `requestId` in a report and do not paste the request body." If the project would rather keep
the timestamp claim, the code change is to add `timestamp` to `Failure`, to `resultShape` and to
the error text, rather than to weaken the README.

### M6. Read-only and auto-approval wording overstates client behaviour

Problem: line 21 says "Every tool is a GET ... Every tool carries `readOnlyHint: true`, so MCP
clients can auto-approve calls", and line 193 says "Nothing mutates, so clients can skip
confirmation prompts." Both sentences read as guarantees. MCP annotations are hints: a client may
use them, and support varies by client. "Every tool is a GET" is also loose because the OAuth
token request is a POST that the server makes on the operator's behalf, even though no tool
writes anything.

Evidence: `SECURITY.md` line 76 already states the precise version: "Only GET requests to the
Data Portal endpoints you configure, plus the OAuth token request." `src/tools.ts` registers
`readOnlyHint: true` and `idempotentHint: true`, and network tools also set `openWorldHint: true`,
which some clients use to warn about outside calls.

Proposed change for line 21:

```markdown
The API is read-only, and so is this server. Every request a tool makes is a GET; the only POST is
the OAuth token request, and Polestar's documented v1 API publishes no write endpoints, so nothing
here can lock the car, start the climate, or change a charge limit. Every tool carries
`readOnlyHint: true` and `idempotentHint: true`, and tools that reach the API also set
`openWorldHint: true`. Clients that honour MCP annotations may run these reads without asking;
clients that ignore them will still show a confirmation.
```

Proposed change for line 193: "Every tool is a read, so a client that honours `readOnlyHint` may
run them without asking. Whether a prompt is shown is the client's choice."

### M7. The multi-car elicitation claim is incomplete without the fallback

Problem: line 136 says the server "asks which car through MCP elicitation and checks the answer".
A client that does not support elicitation (or the 2026 multi-round-trip input flow) does not get
a question. The call is refused with `AMBIGUOUS_VIN` and a masked VIN list, and the operator has
to pass an explicit `vin`. The README never says this, so an operator with several cars and an
elicitation-less client sees an unexpected error instead of a question.

Evidence: `src/vehicle-read.ts` uses the client's elicitation hook when present and, when it is
not, throws `AMBIGUOUS_VIN` with "Pass an explicit vin." The 2026 era answers through the
per-request input flow instead of the deprecated `elicitInput()` call.

Proposed change: replace the sentence with "Omit it when the credential sees one vehicle. With
several, the server asks the client which car when the client supports MCP elicitation or the
2026 input flow, validates the answer, and otherwise refuses with `AMBIGUOUS_VIN` and the known
VINs so you can pass one explicitly."

### M8. HTTP mode lacks the security caveats and the connection detail an operator needs

Problem: the HTTP section (lines 232 to 238) explains the mechanics but not the operational
consequences. The bearer token is a single shared secret with read access to every vehicle the
credential can see, the listener speaks plain HTTP with no TLS, and the token must be at least 16
characters off loopback. The README sends an operator to "use HTTP" without saying any of that or
how a client attaches.

Evidence: `SECURITY.md` lines 92 to 100 say the token is a shared secret, not per-user
authentication, and must stay on loopback or behind something that authenticates.
`src/bind.ts` enforces the 16-character minimum for a non-loopback bind. The listener prints its
URL on stderr, and a local probe confirmed initialize works at both `/` and `/mcp`.

Proposed change: add after line 236:

```markdown
The listener speaks plain HTTP and has no TLS of its own, so keep it on loopback or put it behind
a proxy that terminates TLS and authenticates callers. `POLESTAR_HTTP_TOKEN` is a shared secret,
not per-user authentication: anyone who holds it can read every vehicle the credential can see.
A non-loopback bind requires a token of at least 16 characters. Point an HTTP-capable client at
`http://127.0.0.1:8420/mcp` (the root URL answers too) with `Authorization: Bearer <token>`; the
startup line prints the URL.
```

## Suggestions

### S1. Move or repeat the distribution status where readers decide how to install

The Project status section (lines 331 to 337) correctly says the npm package and MCP Registry entry
are prepared but not published. The Quick start assumes a clone, and a reader who skims may try
`npx polestar-mcp` and fail. Add one sentence to Requirements or the top of Quick start:
"polestar-mcp is not published to npm or the MCP Registry yet; run it from a clone (see Project
status)."

### S2. Add an explicit out-of-scope list

Project status names read-only behaviour and the unwired consumer app API. A directory reviewer
also wants the rest stated: no write or control endpoints, no hosted service or project backend,
no user accounts and no per-user authentication for HTTP, no web or mobile UI, no webhooks, no
price fetching (prices are an argument to `plan_cheapest_charge`), and no notifications over HTTP.
A four-line bullet list under Project status closes this.

### S3. Make the budget paragraph operational

Add to Rate limits (around line 214): the daily window is the UTC day and `polestar_status`
reports `resetsAtUtc`; the OAuth token request and every retry attempt are metered against the
same allowance; the per-minute ceiling is 100 and is waited out when the wait fits the request
deadline, so a burst delays rather than fails. Distinguish the daily average (about seven per
minute) from the burst ceiling (100 per minute).

### S4. Describe the history store layout and retention

The README says "a JSONL file" without saying that one directory per vehicle (named by VIN, a
documented mask exception) holds one `<kind>-<domain>.jsonl` file per domain, that position is
recorded when location reads are allowed, and that a file is rewritten with its newest half when
it would pass 64 MiB. Add two sentences to History and privacy, and say that deleting the
directory removes the history.

### S5. Complete the subscriptions paragraph

Add that the client must support `resources.subscribe`, that a session holds at most 50
subscriptions, that polling runs once a minute, that the HTTP surface answers the subscribe method
with a method-not-found error and advertises `subscribe: false`, and that the pause is temporary
while the budget is low. The current text covers the cadence, the change id and the 90 percent
pause only.

### S6. State which MCP capabilities change the experience

A small compatibility table (see M2) is the clearest fix for "which clients work". Keep the
prose list of example clients, but either link evidence for ZCode or drop the name: it appears
twice in the README and once in `docs/getting-started.md`, with no configuration example, no
version, and no compatibility note anywhere in the tree. Claude Desktop and Cursor are
substantiated enough to keep as examples; an unverified third name invites a reviewer question.

### S7. Give a concrete verification sequence

Under "Check the connection", replace the two-sentence paragraph with a sequence: run
`node build/server.js --version` to prove the build; run `npm run demo` to prove the surface
offline; check the client's MCP log for the startup lines (`live · v0.3.0 · budget 10000/day ·
cache on · history off` and `ready: 26 tools over 15 domains`); then call `polestar_status`
(expect mode live, budget used, token state) and `get_car_status` (expect a data age). This turns
"ask the client" into something an operator can check.

### S8. Note the tool count in the badge

The badge says 36 tools while a default start registers 26. The text explains this, but a badge is
often read alone. Either label it "26 default, 36 with history" or add `(36 with history)` next to
the badge. Low risk, high clarity.

### S9. Correct the retry description

Line 212 says 429 with `Retry-After` and 502/503 get up to three attempts. The retry set also
includes 500 and 504, and a transport-level failure gets one extra attempt for a GET. The current
sentence understates the policy; either widen it or say "transient 429 and 5xx responses".

### S10. State that fixture mode reads no secrets file

The README says the demo needs no credential. Make it explicit that fixture mode never reads
`~/.config/polestar-mcp/.env.secrets` and never contacts Polestar, which is also what
`docs/getting-started.md` line 47 says. One clause in "Try it without a car" removes a privacy
question.

## Cross-document fixes worth the same pass

- `docs/getting-started.md` line 132 repeats the "unchanged snapshots cost a single line" wording
  that M4 corrects.
- `docs/getting-started.md` line 95 lists the `POLESTAR_BUDGET_PER_MINUTE` default as "no" while
  the same row and the README say the default is 100. Fix the table cell to 100.
- `SECURITY.md` line 28 promises masked "prompt text"; a fixture probe under
  `POLESTAR_REDACT_VIN=1` confirms this now works at commit `13e878e`, so the README's privacy
  table can safely claim prompt masking too (M3).
- `docs/reviewer-pack.md` and `docs/bundle.md` agree with the README's distribution status and
  prompt counts; no change needed there.

## Claims checked against the source at 13e878e

| Claim in README | Verdict |
| --- | --- |
| 26 tools by default, 36 with history | Correct; fixture-mode stdio probe returned 26 tools, and 36 with a history directory |
| Two prompts by default, third with history | Correct; probe returned 2 prompts, and the history run returns 3 |
| Every tool carries `readOnlyHint: true` | Correct; probe confirmed 36 of 36 |
| Per-domain TTLs (30 s, 60 s, 5 min, 10 min, 30 min, 1 h) | Correct; matches `src/domains.ts` |
| Retries on 429 and 502/503, three attempts | Mostly correct; 500 and 504 are also retried, and GET network failures get one extra attempt (S9) |
| Subscription poller pauses at 90 percent, sampler at 80 percent | Correct; `src/subscriptions.ts` and `src/sampler.ts` |
| Sampler covers battery, odometer, location, exterior every 10 minutes | Correct; `sampled: true` on exactly those domains |
| Token cached until expiry minus five minutes, one retry on 401, shared in-flight request | Correct; `src/auth.ts` and `src/client.ts` |
| Budget fails closed and reports the reset time | Correct; `src/budget.ts` |
| Budget ledger shares the count across processes | Correct; two-start ledger probe at Lane B and the ledger identity hash |
| History files `0600`, per-vehicle directories `0700` | Correct; `src/history.ts` creates and tightens both |
| History deduplicated, unchanged snapshot "costs one line" | Wrong; unchanged snapshots append nothing (M4) |
| Redaction masks everything except `raw:true` | Incomplete; resource URI and on-disk paths are also exceptions (M3) |
| `POLESTAR_ALLOW_LOCATION=0` strips coordinates from aggregates | Correct but incomplete; it also refuses the location resource and recorded position history (M3) |
| Every API error preserves requestId and timestamp | Wrong for timestamp in rendered output (M5) |
| Multi-car question through MCP elicitation | Correct only when the client supports it; otherwise `AMBIGUOUS_VIN` (M7) |
| HTTP answers subscribe with an error and advertises `subscribe: false` | Correct; local probe got JSON-RPC `-32601` and the handshake capability was false |
| Both protocol eras on one listener, modern request without envelope refused by name | Correct; confirmed by Lane B live HTTP probes and by source |
| npm package and MCP Registry entry prepared, release workflow publishes on a tag | Correct; `server.json`, `package.json`, `.github/workflows/release.yml` |
| Claude Desktop bundle metadata exists, build blocked on CLI and host | Correct; `mcpb/manifest.json` and `docs/bundle.md` |
| Version 0.3.0 across package, badge and docs | Correct; `scripts/check-version.mjs` covers six locations |

## Method and checks

- Read `README.md` at `13e878e` in full, then the six supporting documents named in the task.
- Verified claims against `src/`, `package.json`, `server.json`, `mcpb/manifest.json` and
  `.github/workflows/`.
- Ran offline fixture-mode probes through `tsx` with the shipped synthetic dump: default tool and
  prompt counts and `readOnlyHint`; HTTP initialize at both `/` and `/mcp`, the
  `resources/subscribe` refusal and the startup URL line; and prompt rendering under
  `POLESTAR_REDACT_VIN=1`. No live API, no credential, no build, no install.
- Wrote only this report. `analysis/` is untracked in this checkout.
- Ran `node docs/check-docs.mjs hygiene` and `node docs/check-docs.mjs links` after writing this
  file; both passed.
