# D. MCP ecosystem and EV data landscape

Scope: the brief, `README.md`, `CONTRIBUTING.md`, `docs/upstream-api.md`, `server.json` and
`package.json` in this repository, plus external sources read on 2026-11-05. Repository facts are
read from files or measured with the commands recorded at the end. External facts are fetched over
HTTPS from the URL cited in the same sentence. No live Polestar API call was made.

The only Polestar sources consulted were the public Data Portal login page at
[data-portal.polestar.com/se/auth](https://data-portal.polestar.com/se/auth) and the static client
assets that page loads from the same origin. The portal's OpenAPI document is fetched through an
authenticated proxy route, so the endpoint inventory behind login was not read. That limit is
carried forward into "What I could not verify".

## What exists

### 1. What this server already presents to an ecosystem client

| Fact | Evidence |
| --- | --- |
| 26 tool definitions, 23 registered without history | `analysis/00-brief.md:10`, `README.md:11`, measured `tools 26` from `scripts/list-tools.ts --detail` |
| Every tool declares `outputSchema` and returns `structuredContent` | `src/tools.ts:38-49`, `src/tool-output.ts:63-99`, `CONTRIBUTING.md:54` |
| Every read tool carries `readOnlyHint: true` | `src/domain-tools.ts:22`, `src/aggregate-tools.ts:40`, `test/runtime.test.ts:470` |
| Three prompts: `car-status`, `charge-plan`, `battery-health-report` | `src/server.ts:338-388` |
| Resources with argument completions; subscriptions only on stdio, HTTP advertises `subscribe: false` | `README.md:136-138`, `README.md:175`, `src/server.ts:215` |
| Server instruction string is 882 characters | measured with a tsx harness that rebuilds the array at `src/server.ts:207-214` |
| Longest tool name is 25 characters (`get_parking_climatization`) | measured from `scripts/list-tools.ts --detail` |
| Elicitation asks the client which vehicle to read; the retry path reads `inputResponses` | `src/vehicle-read.ts:64-105`, `test/runtime.test.ts:782-803` |
| HTTP mode is stateless Streamable HTTP on loopback, bearer token required off loopback | `README.md:175`, `src/server.ts:429` |
| Docker image runs stdio only | `Dockerfile` has no `EXPOSE` and no HTTP entrypoint |
| `server.json` declares one npm/stdio package and five environment variables | `server.json:10-24` |

So the protocol primitives that matter for discovery (tools, prompts, resources, structured
output, annotations, elicitation) are already present. The gaps in this report are about how the
server reaches a client and what a client can learn about it before installing, not about missing
protocol messages.

### 2. The current specification, verified 2026-11-05

The current protocol revision is **2026-07-28**, stated on the versioning page: "The current
protocol version is 2026-07-28"
([modelcontextprotocol.io/specification/versioning](https://modelcontextprotocol.io/specification/versioning)).
The page itself carries a modification stamp of 2026-10-30 in its structured metadata. The
next-newer page, `specification/draft`, exists and is not released.

The changes in that revision that matter for a server shaped like this one, from the official
changelog
([2026-07-28/changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)):

| Change | What it does to this server |
| --- | --- |
| MCP is made stateless: the `initialize` handshake is removed and every request carries protocol version, client info and capabilities in `_meta` | The server still handshakes. `scripts/smoke-http.ts:59` sends `protocolVersion: '2025-06-18'` |
| `server/discover` becomes a mandatory RPC advertising supported versions, capabilities and identity | Not implemented. A modern client may call it before anything else |
| `resources/subscribe` and `resources/unsubscribe` are replaced by `subscriptions/listen`, a long-lived stream with opt-in filters (`resourceSubscriptions`, `toolsListChanged`, and so on) | The server registers the removed methods at `src/server.ts:328-334` and advertises `resources.subscribe` |
| Multi Round-Trip Requests replace server-initiated requests; `tools/call` may answer `resultType: "input_required"` with `inputRequests`, and the client retries with `inputResponses` | Partially implemented. `src/vehicle-read.ts:82` reads `inputResponses`, and `test/runtime.test.ts:803` exercises it, but the installed SDK still negotiates the 2025-11-25 line |
| Every result must carry `resultType` (`"complete"` or `"input_required"`) | Not emitted by the current SDK surface |
| `ttlMs` and `cacheScope` become required on `tools/list`, `prompts/list`, `resources/list`, `resources/read` and `resources/templates/list` results | Not emitted. The server has accurate per-domain TTLs internally but cannot publish them to clients |
| Tools must be returned in deterministic order | Already satisfied by construction (`src/tools.ts` registry order); worth a test |
| Logging is deprecated, and `logging/setLevel` is removed; log level moves to request `_meta` | The server still declares `logging: {}` at `src/server.ts:215` |
| Roots and Sampling are deprecated | Neither is used, so no migration cost |
| Authorization: OAuth 2.1 draft, RFC 9728 protected resource metadata, OpenID Connect discovery, Client ID Metadata Documents; Dynamic Client Registration deprecated | Not used. HTTP mode uses a static bearer token from `POLESTAR_HTTP_TOKEN` |
| Schema rules loosen: any JSON Schema 2020-12 keyword in `inputSchema` and `outputSchema`, any JSON value in `structuredContent` | Neutral for this server, which already validates both |

The installed SDK is `@modelcontextprotocol/server` 2.4.0, published 2026-10-23
([npm](https://registry.npmjs.org/@modelcontextprotocol/server)), and its own protocol constant
still says `LATEST_PROTOCOL_VERSION = "2025-11-25"`
(`node_modules/@modelcontextprotocol/core/dist/schemas-DscsoNZN.mjs:4`, measured). Its schema module
already carries 2026-07-28 vocabulary (`input_required`, `subscriptions/listen`,
`server/discover`), so the SDK is a hybrid: the new message shapes exist, the era negotiation does
not. The server therefore sits one released revision behind the current spec, with partial forward
code, and the changelog's "modern versus legacy" split is the accurate way to describe it
([lifecycle page](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle)).

Extensions are the other half of the current spec. The
[extensions overview](https://modelcontextprotocol.io/extensions/overview) lists MCP Apps (stable),
MCP Tasks (beta), Skills over MCP (beta), MCP Server Cards (experimental) and two authorization
extensions (stable): Enterprise-Managed Authorization and OAuth Client Credentials. The client
credential extension is the one that matches Polestar's own M2M flow, and it is stable at revision
2026-07-28
([ext-auth](https://github.com/modelcontextprotocol/ext-auth/tree/main/specification/stable/oauth-client-credentials)).

### 3. Distribution state measured today

| Channel | State on 2026-11-05 | Evidence |
| --- | --- | --- |
| npm | Package name is unpublished: HTTP 404 from the registry | `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/polestar-mcp` returned `404` |
| Official MCP Registry | No entry; the API returns an empty server list for "polestar" | `curl 'https://registry.modelcontextprotocol.io/v0/servers?search=polestar'` returned `{"servers":[],"metadata":{"count":0}}` |
| Registry metadata file | Fails the current published schema, and its `$schema` URL does not exist | [2025-12-01 schema](https://static.modelcontextprotocol.io/schemas/2025-12-01/server.schema.json) returns 404; the [current 2025-12-11 schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) reports one error: `packages/0 : 'identifier' is a required property` |
| Registry package verification | `package.json` has no `mcpName` field, which the registry quickstart requires for npm packages | [registry quickstart](https://modelcontextprotocol.io/registry/quickstart), `package.json` |
| GitHub releases and tags | None, so there is nowhere to host an `.mcpb` asset | `https://api.github.com/repos/NicolasKheirallah/polestar-mcp/releases` returned `[]`, tags returned `[]` |
| CI publishing | No job publishes anything; `.github/workflows/ci.yml` only verifies | grep for `npm publish`, `mcp-publisher`, `ghcr` in the workflow returned nothing |
| Claude Desktop bundle | None shipped, and `.mcpb` is not built anywhere | repository tree has no `manifest.json` or `.mcpb` |
| Remote endpoint | None; HTTP mode binds loopback by default and has no public deployment | `README.md:175` |
| Container | A Dockerfile exists but is stdio only and not published to a registry | `Dockerfile` |

Two facts about the current registry file are worth stating precisely because they are cheap to fix
and each one blocks publishing on its own. The registry's published schema at
`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` requires
`packages[].identifier` and does not accept `packages[].name`; this repository's `server.json:12-15`
uses `name` and `version`. Validating the file against both published schema revisions
(2025-09-29 and 2025-12-11) produced the same failure, so this is not a date mismatch, it is a
shape mismatch.

The registry itself is still in preview: "The MCP Registry is currently in preview. Breaking
changes or data resets may occur before general availability"
([registry/about](https://modelcontextprotocol.io/registry/about)). It also supports more package
types than this file declares: the current schema documents `npm`, `pypi`, `oci`, `nuget` and
`mcpb`, plus a `remotes` array for streamable HTTP servers. That is the same `mcpb` format Claude
Desktop installs, so one bundle can serve two channels.

The wider directory layer moved in the last year. Smithery's home page now reads "MCP servers, now
part of Arcade" and announces that "Smithery's MCP Proxy and managed identity shut down on October
31" ([smithery.ai](https://smithery.ai)); the year is not stated on the page. Glama labels its
catalogue "116,320" servers in the page title ([glama.ai/mcp/servers](https://glama.ai/mcp/servers)).
PulseMCP returned HTTP 403 with a Cloudflare challenge when fetched
([pulsemcp.com/servers](https://pulsemcp.com/servers)), so its catalogue was not verified.

### 4. What comparable vehicle and EV servers ship

All entries below were verified by reading the project's own README or by querying the official
registry API. None of them was run. "Verified" means the artefact was read, not that its claims were
independently tested.

| Server | What it exposes | Distribution and notes | Evidence |
| --- | --- | --- | --- |
| `teslamate-mcp` | 77 tools, 12 prompts, 10 interactive charts as MCP Apps, typed inputs and outputs declared in `.toml` files, `run_sql` inside a read-only transaction, one opt-in cost-write tool that asks via elicitation | Reads a TeslaMate PostgreSQL database; GitHub 142 stars | [github.com/cobanov/teslamate-mcp](https://github.com/cobanov/teslamate-mcp) |
| `tesla-mcp` (scald) | 3 tools (`wake_up`, `refresh_vehicles`, `debug_vehicles`) | Tesla Fleet API, minimal surface | [github.com/scald/tesla-mcp](https://github.com/scald/tesla-mcp) |
| Tesla Fleet API remotes in the official registry | Charge, climate, lock, navigation and location tools | Remote streamable HTTP with OAuth, for example `app.vercel.control-your-tesla/control-your-tesla` and `io.mytesla/mytesla` | registry query `https://registry.modelcontextprotocol.io/v0/servers?search=tesla` (10 results) |
| `kia-connect-mcp` | 52 tools, including lock, climate, charge start and stop, charge limits, windows, valet mode, trip and cost analysis | CLI and PWA in the same repo; writes are normal tools | [github.com/sharozdawa/kia-connect-mcp](https://github.com/sharozdawa/kia-connect-mcp) |
| `bluelink-mcp` | Read status, location, trips, energy use; writes gated behind `BLUELINK_ALLOW_WRITES`, unlock behind a second flag; audit log; minimum refresh interval; bearer token for HTTP transport | Uses the library behind the Home Assistant integration; documents that waking the car drains the 12V battery | [github.com/mattoddie/bluelink-mcp](https://github.com/mattoddie/bluelink-mcp) |
| `unofficial-polestar-mcp` | Climate start and stop, charge limit, amp limit, charge start and stop, lock, unlock, trunk, windows, honk and flash, plus status reads. Safety-critical tools are off by default; read and destructive annotations; command pre-flight that reads state before acting | Uses the reverse-engineered consumer app API with email and password. Ships an `.mcpb` bundle for Claude Desktop, with the password stored in the OS keychain | [github.com/uint16/unofficial-polestar-mcp](https://github.com/uint16/unofficial-polestar-mcp) |
| `holger1411/polestar-mcp` | 3 tools: status, vehicle info, health | Unofficial consumer API, email and password | [github.com/holger1411/polestar-mcp](https://github.com/holger1411/polestar-mcp) |
| `vw_connect_mcp` | Read charge state, range and plug status through Tibber's Enode-based vehicle API (30+ brands) | README states that "In May 2026, VW shut down third-party access to its WeConnect API (new device-attestation requirements open-source projects can't obtain)"; the VW claim is a project claim, not a primary source | [github.com/Smengerl/vw_connect_mcp](https://github.com/Smengerl/vw_connect_mcp) |
| `abrp-mcp` | 15 tools: route planning with charging stops, multi-day trip legs, charge curves, range estimates, charger search, live telemetry | Hosted on Vercel, per-user API key with stateless OAuth | [github.com/Casperjuel/abrp-mcp](https://github.com/Casperjuel/abrp-mcp) |
| Home Assistant `ha-mcp` | 87 tools over Home Assistant entities, history and services | Distributed through HACS and the Home Assistant Marketplace; an owner's home charger state is reachable here | [github.com/homeassistant-ai/ha-mcp](https://github.com/homeassistant-ai/ha-mcp) |
| Spot-price servers | Tibber prices and consumption; ENTSO-E day-ahead prices; Danish `elpriser`; German SMARD forecasts; EU day-ahead prices | Several independent projects, plus registry entries for US electricity rates | [linkcd/tibber-mcp](https://github.com/linkcd/tibber-mcp), [antkanavos/entsoe-mcp](https://github.com/antkanavos/entsoe-mcp), [x2q/elpriser-mcp](https://github.com/x2q/elpriser-mcp), [DasClown/strompreis-mcp](https://github.com/DasClown/strompreis-mcp), [adambenhassen/euenergy-mcp](https://github.com/adambenhassen/euenergy-mcp) |
| Weather servers | Open-Meteo forecast, historical and air-quality tools | Multiple independent projects | [cmer81/open-meteo-mcp](https://github.com/cmer81/open-meteo-mcp), [weather-mcp/weather-mcp](https://github.com/weather-mcp/weather-mcp) |
| Charging-network data | European charging sites with tariffs; US station search | Official-registry remotes such as `com.solidroam.mcp/european-charging-data` and `me.chargingnear/mcp` | registry query `https://registry.modelcontextprotocol.io/v0/servers?search=charging` (7 results) |

What those servers expose that this one does not, in the order a buyer would notice: writes (climate,
charge, locks) on the consumer-API projects; interactive charts on `teslamate-mcp`; route and charger
planning on `abrp-mcp`; tariff data on the price servers; and a database-backed trip history on
`teslamate-mcp`. What this one exposes that none of the others do: the official Polestar Data Portal
M2M contract, a fail-closed daily budget with a status tool, resource subscriptions, and a documented
read-only posture with a test that enforces it.

The Polestar niche is small and has no leader. Measured with the GitHub API: this repository has 2
stars, created 2026-09-19; `uint16/unofficial-polestar-mcp` has 0 stars, created 2026-07-10;
`holger1411/polestar-mcp` has 1 star, created 2026-03-31. There is no proven demand signal in the
star counts, and there is also no incumbent to displace.

### 5. The Polestar Data Portal and the EU Data Act, as published

The regulation behind the portal is the EU Data Act, Regulation (EU) 2023/2854. The Commission's
policy page states that it "entered into force on 11 January 2024 and into application on 12
September 2025", and that it gives individuals and businesses "the right to access the data produced
through their utilisation of smart objects, machines and devices", and the right to share that data
with third parties
([digital-strategy.ec.europa.eu](https://digital-strategy.ec.europa.eu/en/policies/data-act)).
EUR-Lex returned HTTP 202 with an empty body to this client
([eur-lex.europa.eu/eli/reg/2023/2854/oj/eng](https://eur-lex.europa.eu/eli/reg/2023/2854/oj/eng)), so the regulation text itself was not read; the Commission page is the citation.

The portal is login-gated. Its public page is Swedish-localised and says, in translation, that under
the EU data regulation you have the right to access, use and share the data generated by the
connected products or related services you use, that you must log in to reach your data, and that a
nominated third party should contact `the portal support address`
([data-portal.polestar.com/se/auth](https://data-portal.polestar.com/se/auth)). The same page offers
two login methods: **Polestar ID** and **Fleet ID**. The Fleet ID option is newer than this
repository's documentation, which records one Polestar Account ID plus an OAuth client and no fleet
identity path (`docs/upstream-api.md:41-48`, `README.md:186-188`).

The portal is a single-page app whose route table is public in its client bundle. The manifest at
`https://data-portal.polestar.com/static/eu-data-act/build/manifest-60D30B32.js` enumerates routes
for API credentials (overview, a credential page, a docs viewer, an OpenAPI viewer and a docs proxy),
data export, pricing, shared access with entities, third-party data access with export and
connection management, plus an admin area and terms. This tells me what the portal offers without
telling me what the M2M endpoints are: the OpenAPI document is served through the authenticated
`docs.proxy` route.

The pricing route publishes a model that this repository's docs do not record. Its client bundle is
`https://data-portal.polestar.com/static/eu-data-act/build/routes/%24locale._eu-data-act.pricing-F7GTJAA3.js`,
and the strings it carries include: "Calculated per vehicle, per data scope, and per calendar month",
"Access to a data scope triggers a full-month charge, regardless of API call frequency", "Free access
for up to 5 vehicles per calendar month", "Invoices are issued semi-annually (every six months)",
"New data scopes may be added depending on data availability. Prices for existing Data scopes are
subject to change with thirty (30) days notice", and "All prices exclude VAT". The scope list on that
page is `battery`, `location`, `odometer`, `health`, `parking`, `preCleaning`, `exterior`,
`availability`, `charging`, which is the same nine scope families the 15 domains in
`src/domains.ts` map onto.

That last match is the reason I read the pricing page as API pricing, but it is an inference, not a
verified fact: the page sits inside the same Data Act application as the third-party export flow, and
the portal offers no public statement that ties the schedule to M2M credentials. The
[third-party access route](https://data-portal.polestar.com/static/eu-data-act/build/routes/%24locale._eu-data-act.third-party-data-access._index-B2ZEABUR.js)
describes a different mechanism, "create new data exports from any vehicles you have access to".
The distinction matters for this server's cost story and is flagged again below.

The rate limits this repository records, 10,000 calls per client per day and 100 per minute, come
from the portal's "Begränsningar" section (`docs/upstream-api.md:14`). The portal bundles I fetched
did not restate them, so I can neither confirm nor contradict them today.

On writes: I found no public evidence of a v1 M2M write endpoint, and the one Polestar MCP that ships
writes does it through the consumer app API, not the Data Portal. Nothing I verified contradicts
`docs/upstream-api.md:100` or `POLESTAR_ENABLE_WRITES` registering nothing. The portal's OpenAPI
viewer is the place where a new write endpoint would show up, and it is behind login.

### 6. What MCP clients reward

**Install friction is the first filter.** Claude Desktop installs local servers as `.mcpb` bundles:
"single-click installable packages", with a curated directory and a submission form, and the
[bundle specification](https://github.com/anthropics/mcpb) states that "Node.js ships with Claude for
macOS and Windows", so a Node server needs no runtime install
([Claude Desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)).
The bundle manifest supports `user_config` fields marked `sensitive`, mapped into the server's
environment, which is exactly the shape this server's three credentials need.

**Remote use is a separate channel with hard requirements.** Claude's custom connectors are
"brokered through your Claude account" and connect "from Anthropic's cloud infrastructure", so the
server "must be reachable over the public internet", and local servers configured in
`claude_desktop_config.json` are explicitly a different mechanism
([custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)).
The Messages API MCP connector has the same limit and is narrower: "only tool calls are currently
supported" and "local STDIO servers cannot be connected directly"
([MCP connector docs](https://docs.claude.com/en/docs/agents-and-tools/mcp-connector)).
OpenAI's plugin path is similar: public submission requires "a stable, publicly reachable HTTPS
endpoint", and a Secure MCP Tunnel "does not satisfy public submission requirements"
([OpenAI, build an MCP server](https://developers.openai.com/plugins/build/mcp-server)). ChatGPT deep
research and company knowledge additionally expect `search` and `fetch` tools
([platform.openai.com/docs/mcp](https://platform.openai.com/docs/mcp)).

**Directory review has explicit, checkable requirements.** Anthropic's Software Directory Policy
requires MCP servers to "gracefully handle errors and provide helpful feedback" and to be "frugal
with their use of tokens", caps tool names at 64 characters, requires remote authenticated servers to
"use secure OAuth 2.0 with certificates from recognized authorities", and requires a "standard
testing account with sample data" plus "at least three working examples of prompts or use cases"
([directory policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)).
The same policy requires tool descriptions that "precisely match actual functionality", which is the
reason the annotations and the read-only claim are distribution assets, not just hygiene.

**Tool-count economics changed in the dominant coding client.** Claude Code's MCP tool search now
defers tool definitions: "Only tool names and server instructions load at session start, so adding
more MCP servers has minimal impact on your context window"
([Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp)). Two limits matter for
authoring: server instructions and any tool that loads upfront are cut at 4,096 characters, and a
tool loaded through search is cut at 16,384. The same page notes that server instructions "help
Claude understand when to search for your tools", and that prompts from a server become slash
commands (`/servername:promptname`) while resources become `@` mentions. A server that relies on the
model discovering 26 tools without instructions is at a disadvantage; one whose instructions say what
the server answers and when to search is not.

**UI is now a first-class extension.** MCP Apps are stable and let a tool declare `_meta.ui.resourceUri`
that points at an HTML resource rendered in a sandboxed iframe
([MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview)). Cursor documents support for
tools, prompts, resources, roots, elicitation and the MCP Apps extension
([Cursor MCP docs](https://cursor.com/docs/context/mcp)). `teslamate-mcp` ships ten such charts and
falls back to plain rows on clients without support, which is the pattern to copy if this server
adds one.

**Directories and marketplaces are how clients surface servers.** Cursor has its own marketplace plus
`cursor.directory`; VS Code points users at "the Customization Marketplace" and at agent plugins that
"bundle MCP servers", with two configuration formats that are not interchangeable
([VS Code MCP docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)). The
official registry is upstream of those marketplaces: it is "intended to be consumed primarily by
downstream aggregators"
([registry/about](https://modelcontextprotocol.io/registry/about)). Anthropic's own tool-writing
guidance adds the authoring rules that reviews tend to quote: choose few tools, namespace them, return
high-signal context, paginate or truncate responses, and make errors actionable
([Anthropic engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)).

### 7. Adjacent data a Polestar owner could join locally

The question is which joins argue for code inside this server and which are better left to other MCP
servers the assistant already has.

| Adjacent data | Existing coverage | Verdict |
| --- | --- | --- |
| Spot electricity price | Tibber, ENTSO-E, `elpriser`, SMARD, EU day-ahead servers exist, but each needs a key, a region and a tariff shape | Partial case for building: the advisor `plan_cheapest_charge` already consumes an hourly curve as an argument, so fetching that curve is the one join that closes an existing tool's loop. A separate price server still leaves the model copying numbers between tool calls |
| Weather | Several Open-Meteo servers | Do not build. The value is a small contextual sentence, not a data problem |
| Calendar | Anthropic ships Google Workspace connectors, including Google Calendar ([support article](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)) | Do not build. Departure planning can read it from the connector |
| Home charger state | Home Assistant `ha-mcp` exposes 87 tools over entities and services | Do not build. This server cannot see the charger; Home Assistant can |
| Route and charger planning | `abrp-mcp` plans routes with charging stops, charge curves and range estimates | Do not build. Document cross-server use instead |
| Charging network prices and availability | EU and US charging-data servers in the registry, plus Open Charge Map projects | Do not build |
| Grid carbon intensity | Not verified this pass | No verdict |

The honest summary: five of the six adjacent datasets are solved by servers the assistant can already
call, and one, spot price, is only half solved because this server's own advisory tool needs the curve
in a specific shape. That is the only adjacency that argues for code here.

## What is missing

Ordered by how much a user would notice, not by implementation cost:

1. **No install path a normal user can follow.** The npm name resolves to 404, the registry has no
   entry, the registry file fails the current schema, no release exists to host a bundle, and CI never
   publishes. A Claude Desktop user has to clone, install Node dependencies, build, and hand-edit JSON.
   `unofficial-polestar-mcp` already ships an `.mcpb` and installs by double-click.
2. **No first run without credentials.** The repository has a 68K synthetic fixture dump and a
   `demo-dump` script, but `package.json:45-53` excludes `test/` from the published files, so an
   installed copy has no demo data. Every directory reviewer and every curious user hits the
   credential wall first. Anthropic's policy requires sample data for review, so this blocks review as
   well as trial.
3. **No path to claude.ai or ChatGPT.** Stdio cannot be connected to Claude's cloud connectors or to
   ChatGPT plugins; both need a public HTTPS endpoint. This server's HTTP mode is loopback-first with
   a static bearer token, which is the correct privacy default and the wrong shape for those channels.
4. **The protocol surface is one revision behind.** The current spec moved to per-request metadata,
   `server/discover`, `resultType`, `ttlMs` and `cacheScope`, and `subscriptions/listen`; this server
   still advertises `resources.subscribe` and `logging`, both of which the current revision replaced
   or deprecated. A modern client will not crash, because the backward-compatibility rules cover
   legacy servers, but the server cannot publish cache lifetimes to clients and cannot answer the
   discovery call.
5. **No UI where comparable servers have one.** `teslamate-mcp` ships charts for charging curves,
   degradation and trips. This server returns text and a structured envelope, which is right for its
   budget-conscious design, but a charging-session or degradation chart is the one place a Polestar
   owner would expect a picture.
6. **Price-aware charging still needs pasted numbers.** The advisor's contract requires the caller to
   supply the hourly curve (`docs/tools-reference.md:93`), so the best question the server can answer
   depends on the user first finding a price curve somewhere else.
7. **The fleet and cost story is not documented.** The portal now offers Fleet ID login and, on its
   pricing route, a per-vehicle, per-scope, per-month model with a five-vehicle free threshold. The
   repository documents neither, so a fleet operator reading `docs/upstream-api.md` cannot tell
   whether access is free, metered, or priced per scope.
8. **No reviewer pack.** Three prompts exist, but there is no short document that names them as the
   three example use cases, no sample-data statement, and no privacy policy link in `server.json`,
   which are the artefacts a directory submission is reviewed against.

Read-only is not on this list. It is a posture, not a gap, and the one Polestar MCP that ships writes
does so through the unofficial consumer API, which is a different product with a different credential
model.

## Candidates

Ranked by adoption leverage: how many new installs and how much retention each one unlocks per unit of
work. Effort is S (a day or two), M (a week), L (more than a week). Risk is about correctness, privacy
or maintenance cost, not schedule.

| id | Candidate | User question it answers | Data it reads | Effort | Risk | Falsifiable check |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | Make the publish path real: fix `server.json` to the current schema, add `mcpName`, tag a release, publish to npm and the official registry | "How do I install this?" | None; packaging metadata only | S | Low. Registry is preview, so a reset is possible | `npm view polestar-mcp version` returns `0.3.0`; `server.json` validates against the 2025-12-11 schema with zero errors; the registry API returns the server for `search=polestar`; CI fails when the declared `$schema` URL is not 200 |
| D2 | Ship a Claude Desktop `.mcpb` bundle with the three credentials as `user_config` fields marked `sensitive` | "Can I install this without editing JSON?" | None; bundle metadata and the existing env loader | M | Medium. Bundled `node_modules` size, secret handling, and update path need care | `mcpb pack` produces a bundle; its manifest validates against the mcpb manifest schema; installing it in Claude Desktop and calling `get_car_status` in fixture mode returns the fixture VIN; a test asserts the three credential fields are `sensitive` and mapped to the documented variables |
| D3 | Ship demo mode inside the published package: include the 68K fixture dump and a `--demo` flag | "Can I see what it does before I have credentials?" | `test/fixtures/dump/` only | S | Low. Fixture drift is already gated by `verify-fixtures` | From a clean directory, `npx polestar-mcp --demo` completes a handshake and `get_car_status` returns the fixture VIN; a test asserts the demo path makes zero network calls; the packed tarball contains the demo directory |
| D4 | Build the reviewer pack the directories actually check: sample data statement, three named example prompts, privacy policy URL in `server.json` and README | "Why should the directory list this?" | None; documents and metadata | S | Low | A checklist test asserts each directory-policy requirement maps to an artefact in the repo, and the three prompt names in the pack match `prompts/list` |
| D5 | Conform to protocol revision 2026-07-28: `server/discover`, `resultType` on every result, `ttlMs` and `cacheScope` on list and read results, `subscriptions/listen` or an explicit refusal, and drop the deprecated `logging` capability | "Will this work with a current client, and can it cache?" | No new data; the existing per-domain TTL table in `src/domains.ts` becomes client-visible | L | High. The installed SDK negotiates 2025-11-25, so this needs an SDK upgrade or a compatibility layer, and subscriptions are the trickiest part | A modern-era test client that sends per-request `_meta` and calls `server/discover` completes; every result carries `resultType`; `resources/list` and `tools/list` carry `ttlMs` and `cacheScope`; the legacy handshake smoke test still passes |
| D6 | Metadata pass for tool search and review: deterministic `tools/list` order asserted by test, instruction string kept under 4,096 characters with searchable words first, annotation audit, and one-line "when to use" per tool | "Which of these 26 tools answers my question?" | Tool metadata only | S | Low | Two consecutive `tools/list` calls return identical order; instruction length is asserted at or below 4,096 (measured 882 today); the annotation test asserts `readOnlyHint` on all reads and `openWorldHint` only where an internet call is possible |
| D7 | Add a spot-price provider behind `plan_cheapest_charge`, so the curve can be fetched instead of pasted, with the provider named and the fallback explicit | "Plan the cheapest charging tonight, without me hunting for prices" | A price provider API plus the existing battery, amp-limit and charge-timer reads | M | Medium. Regional coverage, API keys, and a wrong price produces a confidently wrong schedule | A recorded provider fixture and a pasted curve of the same values produce byte-identical schedules; a test asserts the tool fails closed with no invented prices when the provider is unreachable; the existing planner tests still pass unchanged |
| D8 | Add one MCP Apps view, charging session or degradation, with a text fallback | "Show me the charging curve, not a table" | The existing history JSONL and battery samples | L | Medium. Bundle size, CSP, and clients without support | The tool declares `_meta.ui.resourceUri`; the resource returns `text/html;profile=mcp-app`; the text result is unchanged and every existing test passes; the chart renders in a host that supports MCP Apps and is absent, not broken, in one that does not |
| D9 | Make the fleet story explicit: document Fleet ID and per-scope pricing, and add a multi-vehicle read that names each vehicle and its data age | "I have four cars; what is each doing, and what does this cost?" | `list_vehicles` plus the existing domain reads per VIN | M | Medium. A delegated read must never be answered from the owner's cache | With a two-VIN fixture the tool returns one row per VIN with its own age; a test asserts the cache key includes the delegated account, so a delegated read cannot be served from the owner's entry; `polestar_status` reports the vehicle count |
| D10 | Self-hosted remote connector with OAuth 2.1, RFC 9728 protected resource metadata and the OAuth Client Credentials extension, gated behind an explicit operator decision | "Can I reach my car from claude.ai rather than my laptop?" | The same reads, over a public HTTPS endpoint | L | High. A public endpoint holding vehicle location, plus per-user credential storage, changes the trust boundary | `/.well-known/oauth-protected-resource` returns RFC 9728 metadata; an unauthenticated request gets 401 with a `WWW-Authenticate` challenge; a Claude custom connector completes the flow; no vehicle read succeeds without a token; `SECURITY.md` states the new boundary |

Why this order. D1 to D3 remove the three walls between a curious user and a first successful tool
call, and each can be verified from outside the repo with a command. D4 is nearly free once D3 exists
and it is what a directory reviewer reads. D5 to D6 are about staying current with clients that
already changed; D5 is the largest engineering item and the least visible to a new user, so it comes
after the install path. D7 is the strongest product idea in the list because it completes an existing
tool, but it adds an external dependency to a server whose main claim is that it talks only to
Polestar. D8 is valuable and expensive, and it depends on history being enabled, which is opt-in. D9
and D10 are real opportunities with real trust costs, and both need a decision from the owner before
they are worth designing.

## Rejected ideas

- **A public multi-tenant hosted connector as a product.** Claude custom connectors require public
  reachability and OAuth, and the portal's per-scope, per-vehicle pricing means a shared host would
  carry unbounded cost while holding location data for strangers. Reject as a default; keep D10 as a
  single-tenant self-host option only.
- **Writing to the car through the unofficial consumer API.** `unofficial-polestar-mcp` shows it is
  possible with email and password, and its pre-flight checks are thoughtful. It is also a
  reverse-engineered contract, it requires the user's account password, and it can unlock the car.
  That contradicts `SECURITY.md`, `test/posture.test.ts` and the project's own read-only claim. Reject.
- **Smithery listing as a distribution goal.** The proxy and managed identity shut down on October 31
  and the site now positions itself as part of Arcade. Treat it as a redirect target, not a channel.
- **MCP Server Cards now.** The extension is experimental, its repository says so at the top, and no
  client support was verified. Revisit when it graduates.
- **Building weather, calendar, charger state, route planning or charging-network data inside this
  server.** Each is already covered by a server or connector the assistant can call, and each would
  add tools and token surface to a server whose differentiator is the Polestar contract.
- **Matching `teslamate-mcp` tool for tool.** 77 tools came from owning a database. This server does
  not own that data and should not pretend to; its aggregates and resources are the right shape, and
  Claude Code's tool search changes how much a large tool list even costs.
- **Rewriting the prompts as an MCP Skills package as the next step.** Skills over MCP is beta
  ([ext-skills](https://github.com/modelcontextprotocol/ext-skills)), while prompts already become
  slash commands in Claude Code. Low leverage compared with D1 to D3.
- **Registering under a name that implies Polestar endorsement.** The directory policy requires
  accurate descriptions, and the README already disclaims affiliation. Keep it that way.

## What I could not verify

- **Whether Polestar has added write endpoints or new Domains.** The portal's OpenAPI document is
  behind an authenticated proxy; I did not use a credential and did not make a live API call.
- **The current rate limits.** The repository records 10,000 calls per day and 100 per minute from the
  portal's restrictions section; the portal bundles fetched today did not restate them.
- **Whether the published pricing schedule applies to M2M credentials.** The strings are published in
  the portal's pricing route and their scope names match the M2M scopes, but the portal does not state
  the link publicly, and the same application also serves third-party export access.
- **The year of Smithery's proxy shutdown.** The page says October 31 without a year.
- **PulseMCP's catalogue.** HTTP 403 with a Cloudflare challenge.
- **Glama's Polestar or Tesla listings.** Its API requires a key, so only the catalogue size in the
  page title was observed.
- **Anthropic's desktop extension review criteria beyond the Software Directory Policy.** The
  submission form itself was not fetched.
- **Whether `mcp-publisher` rejects this `server.json` exactly as the JSON Schema does.** I validated
  the file against the published schema; I did not run the publisher.
- **The VW WeConnect shutdown in May 2026.** It is a claim in another project's README, and no
  primary Volkswagen source was read.
- **Whether any OEM besides Polestar ships an official MCP server.** I found none in the registry or
  on GitHub for BMW, Mercedes, Hyundai or Kia, but absence of evidence from those searches is not
  proof of absence.
- **Whether npm would accept the name `polestar-mcp`.** It currently returns 404, which means not
  published, not that the name is reserved.
- **Client-side tool limits in Cursor.** Its MCP page documents capability support, not a per-server
  tool cap.

## Commands run

Repository measurements:

```text
$ node --import tsx scripts/list-tools.ts --detail | python3 -c "..."
tools 26
max name len 25 get_parking_climatization

$ node --import tsx --input-type=module -e "... rebuild server instructions ..."
instructions length 882
```

Registry and package state:

```text
$ curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/polestar-mcp
404

$ curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=polestar'
{"servers":[],"metadata":{"count":0}}

$ curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=tesla' | ...
count 10

$ curl -s -o /dev/null -w '%{http_code}' https://static.modelcontextprotocol.io/schemas/2025-12-01/server.schema.json
404
$ curl -s -o /dev/null -w '%{http_code}' https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
200

$ python3 - <<'EOF'   # jsonschema validation of server.json against the current schema
...
errors: 1
 - packages/0 : 'identifier' is a required property
EOF

$ curl -s https://api.github.com/repos/NicolasKheirallah/polestar-mcp/releases | ...
count 0
$ curl -s https://api.github.com/repos/NicolasKheirallah/polestar-mcp/tags | ...
count 0
```

Polestar portal reads (public pages and static assets, no credential, no API host):

```text
$ curl -sL https://data-portal.polestar.com/  ->  https://data-portal.polestar.com/se/auth (200)
$ curl -sL https://data-portal.polestar.com/static/eu-data-act/build/manifest-60D30B32.js  ->  200, 88 route chunks
$ curl -sL https://data-portal.polestar.com/static/eu-data-act/build/routes/%24locale._eu-data-act.pricing-F7GTJAA3.js  ->  200
```

Writing hygiene, run as required at the end:

```text
$ node docs/check-docs.mjs hygiene
EMDASH_CHECK_FAILED:
  analysis/correctness/findings.md lines 1, 43, 71, ...

$ # same four detectors applied to analysis/D-ecosystem.md only
targeted scan of analysis/D-ecosystem.md: em dash 0, spaced en dash 0, spaced-hyphen connector 0, buzzwords 0
```

The tree-wide hygiene run fails on `analysis/correctness/findings.md`, which belongs to another lane
and is outside this task's write scope. This file was scanned separately with the same detectors and
is clean. The tree-wide result has to be re-run after that lane fixes its file.
