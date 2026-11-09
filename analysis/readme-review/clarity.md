# README clarity review

Reviewed: `README.md` at commit `13e878e` (341 lines), with `CONTRIBUTING.md` and `docs/getting-started.md` read as context.
Reviewer: readme-clarity. Scope: structure, information hierarchy, first-run clarity, contents and heading design, quick start flow, table scannability, repetition, missing sections, jargon, prose and list balance, narrow-screen rendering.

Adjacent lanes: technical accuracy is covered by `analysis/readme-review/accuracy.md`, prose style by `analysis/readme-review/prose.md`, and MCP operator detail by `analysis/readme-review/operator.md`. Findings that overlap those lanes are marked as such, so the Lead can de-duplicate when merging.

Method: read the README in full as a first-time reader, measured table sizes, cell lengths and paragraph lengths, and ran the documentation gates listed at the end. Every quote is verbatim from the reviewed commit.

## Bottom line

The content is strong. The order is not. A reader can learn what the project does in one sentence, but cannot act on it in one screen: there is no clone step, the offline path stops at a test script instead of reaching a client, the first screen promises 36 tools when the default is 26, and the facts a stranger needs to judge fit (personal project, one owner's Polestar 2, not affiliated, not yet published) sit at lines 335 to 337. The 36-tool table is the single biggest block on the page and repeats twelve descriptions that already appear above it. Fix the front of the page and collapse the tables, and the README moves from "good reference" to "good first run".

## What already works

Keep these through the rewrite.

- The one-line answer at line 5, `Read-only MCP server for the Polestar Data Portal M2M API.`, plus the plain-language promise at line 19. Together they pass the what-does-it-do test.
- Offline first, live second (lines 51 to 104). That is the right order for a reader who has no credential yet.
- The two-identifier warning at line 98, including the exact failure `403 AUTHZ_CLIENT_ID_MISMATCH`. That is the most useful paragraph on the page.
- The example answer block at lines 125 to 130. It shows what "humanized" output actually looks like, which no other section does.
- Honest limits: read-only, unpublished, personal project, no affiliation. The facts are right, they are just placed too late.
- Short headings and a shallow hierarchy. No heading is longer than four words, and only Quick start uses subheadings.

## The 20-second test

Judged as a reader who has never used the project.

| Question | Verdict | Where it is answered today | Gap |
| --- | --- | --- | --- |
| What does it do? | Pass | line 5, line 19 | None. One sentence plus one example. |
| Does it fit my setup? | Partial | Requirements at lines 43 to 47 | Scope (one owner's Polestar 2, not affiliated, unpublished) is at lines 335 and 337; no OS support statement. |
| What do I need? | Partial | lines 45 to 47 | No git, no npm, no clone step, no link to `.env.example`. |
| How do I try it without a credential? | Partial | lines 51 to 67 | The demo prints `DUMP_OK` and `npm start` waits on stdio, but nothing shows how to attach a client to fixture mode, so the reader never gets to ask a question. |
| How do I connect a real client? | Partial | lines 69 to 100 | No config file location per client, no expected result, no log hint. |
| How do I check it works? | Partial | lines 102 to 104 | Names two tools but shows no expected output and no failure symptom. |
| Where do I go next? | Partial | Documentation table at line 315 | No next-step pointer at the end of Quick start; the docs table is about 210 lines later. |

Verdict: content pass, first-run fail. The answers exist, but not in the order a new reader asks for them.

## Proposed outline

Target: the same content, about 250 to 300 lines, with the 36-tool table collapsed and the duplicated descriptions removed. Headings below are proposed names, not final copy.

| # | Section | What it must do | Source in the current README |
| --- | --- | --- | --- |
| 0 | Front matter | H1, one-line description, badges (version, Node, tools by default, offline demo), and a two-sentence scope line: personal project for one Polestar 2, read-only, not affiliated, not yet on npm, run from a clone | lines 1 to 15, scope from lines 335 and 337 |
| 1 | What it is | Plain-language promise, read-only in one sentence, what a tool is in one clause; the tool counts move to Tools | lines 17 to 23 |
| 2 | Requirements | Node 20.11, git and npm, an MCP client, one of credential or sample data, OS note, link to `.env.example` | lines 43 to 47 |
| 3 | Quick start | Three subsections: try it with sample data in two minutes, connect your car, check it works | lines 49 to 104, rewritten |
| 3a | Try it with sample data | Clone, `npm ci`, `npm run build`, `npm run demo`, then a second client config block that points at `test/fixtures/dump`; say what `npm start` does and does not do | lines 51 to 67 |
| 3b | Connect your car | Credential, where to store it, one client config block with a named location per client, restart, the two-identifier warning | lines 69 to 100 |
| 3c | Check it works | Expected demo line, short expected status output, the three most likely failure symptoms and a link forward to Troubleshooting | lines 102 to 104 plus new material from `docs/getting-started.md` lines 159 to 177 |
| 4 | What you can ask | Keep the 12-row example table, trim cells to about 8 words, keep the example output, move the mechanics paragraph into a `details` block or below the example | lines 106 to 132 |
| 5 | Tools | Group summary plus 6 to 8 headline tools inline; state 26 by default and 36 with history; the full 36 in a collapsed block or delegated to `docs/tools-reference.md`; define Domain at first use | lines 134 to 185 |
| 6 | History and privacy | Keep, move above Configuration, gloss JSONL and `metaEventId` once, add the two-sentence privacy summary | lines 218 to 230, plus `docs/privacy.md` |
| 7 | Configuration | Lead with the two or three variables a user actually sets, then the collapsed 29-row table; keep it because the envvars gate reads this file | lines 240 to 279 |
| 8 | Troubleshooting | New table, 6 to 10 rows, most likely first; link to getting started for the rest | new, from `docs/getting-started.md` lines 159 to 177 |
| 9 | Rate limits and caching | Two short paragraphs, a TTL table or three bullets, then retry and fail-closed in bullets | lines 195 to 216 |
| 10 | Advanced MCP surface | Merge HTTP mode with resources, prompts and subscriptions; keep the safety rules and the stdio-only subscription rule; rename the heading | lines 187 to 193 and lines 232 to 238 |
| 11 | Development and testing | Five commands inline, then a link to the check table in `CONTRIBUTING.md`; keep `npm run demo` because CI runs it from the packed tarball | lines 281 to 304, trimmed |
| 12 | Contributing | Two to four lines: issues and PRs welcome, read `CONTRIBUTING.md`, run the checks, never commit a capture | new |
| 13 | Security | Keep the warning and the requestId note; drop the credential-path duplicate; link `SECURITY.md` and `docs/privacy.md` | lines 306 to 313 |
| 14 | Documentation | Split by audience: user docs first, developer and reviewer docs second; keep the three links the gates require | lines 315 to 329 |
| 15 | Project status | Publication blockers and the read-only rationale; scope stays in the front matter | lines 331 to 337 |
| 16 | License | Keep | lines 339 to 341 |

Ordering rationale: Requirements before Quick start is fine, but the first command in Quick start has to be obtainable, so "get the code" must be in Requirements or the first line of Quick start. Troubleshooting must follow Quick start and What you can ask, not hide in a table at line 319. Protocol and transport internals (resources, prompts, subscriptions, HTTP) come after the user paths. History and privacy comes before Configuration because a user decides whether to opt in before reading 29 variables.

## Must-fix findings

Worst first. Each quote is current text; each label says whether the Lead should treat it as blocking.

### M1. The no-credential path never reaches a client

**Must-fix.** Overlaps with the operator lane.

Current text, lines 61 to 65:

> `npm run demo` prints `DUMP_OK` when every assertion passes. To browse the same data interactively, start the server in fixture mode:
>
> ```sh
> POLESTAR_FIXTURES_DIR=test/fixtures/dump npm start
> ```

Why it fails: `npm start` launches a stdio MCP server. With no client attached it waits, and the README gives no client configuration that points at the fixture directory, so "browse the same data interactively" has no next step. The reader who has no car can run an assertion script but cannot ask a question, which is the one thing the page promises. `docs/getting-started.md` lines 140 to 155 has the same gap.

Recommendation: add a second client JSON block in this subsection, identical to the live one except for `"env": {"POLESTAR_FIXTURES_DIR": "/absolute/path/to/polestar-mcp/test/fixtures/dump"}`, then say "restart the client and ask `How is my car doing?`". Keep `npm run demo` as the automated check and say that `npm start` waits for an MCP client on stdio, so it is not a web page.

### M2. There is no step that gets the code

**Must-fix.**

Current text, lines 55 to 59:

> ```sh
> npm ci
> npm run build
> npm run demo
> ```

Why it fails: the first command in Quick start assumes the reader is already inside a clone. Requirements at lines 45 to 47 names Node, an MCP client and a credential, but not git, npm, or the clone. The only sentence that tells the reader how to obtain the project is line 335, `Until those land, run the server from a clone with npm ci && npm run build.` A reader who is not published-aware will run `npm ci` in a random directory and get an error with no context. The package is not on npm yet, so clone is the only path.

Recommendation: make "Get the code" the first Quick start step or the first Requirements line, with `git clone` using the repository URL already in `package.json` and `cd polestar-mcp`. Add git and npm to Requirements.

### M3. The first screen promises 36 tools, but the default is 26, and the fit question is answered at the bottom

**Must-fix.**

Current text, line 11:

> `![tools](https://img.shields.io/badge/tools-36-blueviolet)`

Current text, line 23:

> A default start registers 26 tools. Enable the optional local history store and it registers 36. The extra ten answer questions the API cannot, such as how the battery has aged, what a charging session cost, which trips the odometer implies, and what changed this week.

Current text, line 335:

> The npm package and MCP Registry entry are prepared in this tree, and the release workflow checks, packs, and publishes on a version tag, but neither is published yet.

Current text, line 337:

> polestar-mcp is a personal project for one owner's Polestar 2. It is not affiliated with or endorsed by Polestar.

Why it fails: the badge is the first count on the page and it disagrees with the first paragraph twelve lines later. A reader cannot tell whether they get 26 or 36 tools. Separately, the facts that decide fit (one owner's Polestar 2, no affiliation, unpublished, clone only) arrive after 330 lines; a reader evaluating whether to spend time on the project may leave before reaching them.

Recommendation: change the tools badge to the default count or a clear pair (for example `26 tools by default`), and move a two-sentence scope line into the top matter. The badge is free text: only the version badge is parsed by `scripts/check-version.mjs` line 46, so the tools badge can change without touching a gate. Keep the detailed publication status in Project status.

### M4. The 36-tool table is the longest block on the page and repeats the section above it

**Must-fix.**

Measurements: the table at lines 140 to 183 has 36 tool rows plus 6 category rows; cells reach 17 words; twelve of the thirty-six descriptions already appear in the What you can ask table.

Current text, line 164:

> `| get_car_status | One-call briefing: charge, range, locks, availability, odometer, service, ages |`

Current text, line 110, same tool, earlier:

> `| "How is my car doing?" | get_car_status | One briefing: charge, range, locks, availability, odometer, service countdown, data ages |`

Why it fails: the reader meets the same twelve tools twice, in two slightly different wordings, before learning configuration or troubleshooting. On a narrow screen the 36-row, two-column table is a long scroll of wrapped cells, and the category rows (`| **Discovery** | |`) add empty cells that look like rendering errors.

Recommendation: keep the What you can ask table as the user-facing entry point. Reduce The tools to a group summary with counts and 6 to 8 headline tools, plus a link to `docs/tools-reference.md`, or keep the full table inside one `<details>` block grouped by category. If the full list must stay visible for MCP directory reviewers, put it after Configuration and Troubleshooting, not before them.

### M5. "The 15 `get_*` domain tools" cannot be resolved by the reader

**Must-fix.** Overlaps with the accuracy lane.

Current text, line 185:

> The 15 `get_*` domain tools map one-to-one onto the API's 15 read domains: eight telemetry, seven charging.

Why it fails: the page above this sentence lists far more than fifteen names that start with `get_`, including `get_car_status`, `get_history` and the ten history tools, so the reader cannot tell which fifteen are meant. "Domain" is also never defined in the README.

Recommendation: name the groups instead of the prefix: "The 15 domain tools in the Telemetry and Charging groups above map one-to-one onto the API's 15 read domains". Define "Domain" at first use (see M9).

### M6. There is no Troubleshooting section

**Must-fix.** Overlaps with the operator lane.

Current text, line 319:

> `| [Getting started](docs/getting-started.md) | Credentials, every variable explained, first calls, troubleshooting |`

Why it fails: the failures a new reader is most likely to hit are a server that never appears in the client, a 401 from a bad secret, a 403 from swapping the two identifiers, a missing fixture, or an exhausted budget. None of those symptoms is described in the README; they sit behind a link in a reference table 200 lines below the quick start. Modern GitHub READMEs put a short troubleshooting block near the quick start, and the material already exists in `docs/getting-started.md` lines 159 to 177.

Recommendation: add a Troubleshooting section after Quick start with 6 to 10 rows copied or condensed from getting started, ordered by likelihood. Keep the full table in getting started as the reference.

### M7. There is no Contributing section

**Must-fix.**

Current text, line 304:

```text
Every check runs on each push and pull request. [CONTRIBUTING.md](CONTRIBUTING.md) carries the table with what each check proves, and describes how to add a domain or a tool.
```

Why it fails: the sentence points contributors at the right document, but it is buried in the last paragraph of Development and testing. A modern README has a visible Contributing section, and this project has unusually explicit contribution rules (no live captures, every claim needs a check, writing hygiene is enforced) that a newcomer should see before opening a PR.

Recommendation: add two to four lines near Development and testing: issues and PRs welcome, read `CONTRIBUTING.md`, run `npm test` and `node docs/check-docs.mjs hygiene`, never commit a live capture.

### M8. "Connect your car" does not say where the JSON goes or what success looks like

**Must-fix.** Overlaps with the operator lane.

Current text, lines 83 to 96:

> Point your MCP client at the built server:
>
> ```json
> {
>   "mcpServers": {
>     "polestar": {
>       "command": "node",
>       "args": ["/absolute/path/to/polestar-mcp/build/server.js"]
>     }
>   }
> }
> ```
>
> 4. Restart the client.

Why it fails: a first-time user cannot tell whether that JSON is a file to create, a field in a settings UI, or an environment variable. `docs/getting-started.md` line 58 answers it ("in Claude Desktop this is `claude_desktop_config.json`, in other clients look for MCP servers in their settings"); the README does not. The check step at line 104 says to ask for a status briefing but never shows an expected answer or the place to look when nothing happens. The README never says that diagnostics go to stderr and stdout carries the protocol, which is the one fact that explains a silent client.

Recommendation: name a concrete destination for at least the first client, or link to getting started step 3 for per-client instructions. Add one sentence: if the server does not appear, run `npm run build`, check the absolute path, and read the client's MCP log, because diagnostics go to stderr. Show a short expected `polestar_status` or `get_car_status` output.

### M9. Domain, SoC and M2M are used as if the reader knows them

**Must-fix** for Domain and SoC; M2M is cheap to fix in the same edit.

Current text, line 5:

> Read-only MCP server for the Polestar Data Portal M2M API.

Current text, line 123:

> Domain tools answer in short prose.

Current text, line 145:

> `| list_vehicle_domains | Which of the 15 domains this car reports, which are absent or refused, with data ages |`

Current text, line 167:

> `| get_charging_estimate | Energy and time to reach the target SoC, assumptions stated |`

Why it fails: `CONTRIBUTING.md` defines Domain as "One topic of vehicle data, `telemetry/battery`", but the README assumes the same meaning without stating it, and uses "domain" more than a dozen times. `SoC` is never expanded anywhere in the README. `M2M` is never expanded. A reader who is not an MCP or EV specialist has to infer three load-bearing terms from context.

Recommendation: expand machine-to-machine at line 5 or drop the acronym; define Domain at its first real use (line 123 or the group sentence at line 185) as "one topic of vehicle data, such as `telemetry/battery`"; write "target state of charge (SoC)" once at line 167 and use the acronym after that.

## Nice-to-have findings

### N1. The contents list is complete but does not help a first-time reader

Current text, lines 25 to 41: fifteen links, one per H2, before the reader reaches Requirements. The three subsections under Quick start (`Try it without a car`, `Connect your car`, `Check the connection`) are not listed, and those are the links a new reader wants.

Recommendation: either move Contents below Quick start, or add the three quick-start anchors and keep the list. Renaming any heading later means updating this list, because `node docs/check-docs.mjs links` validates every in-page anchor.

### N2. Protocol internals come before user-facing material

Current headings: `## Resources, prompts, and subscriptions` at line 187, `## Rate limits, caching, and tokens` at line 195, `## History and privacy` at line 218, `## HTTP mode` at line 232.

Recommendation: follow the outline above. History and privacy is a user decision and belongs before Configuration; resources, prompts, subscriptions and HTTP mode are operator material and belong together after the user sections.

### N3. The rate limits section is dense prose that wants structure

Measurements: in this section line 197 has 24 words, line 210 has 71, line 214 has 78; line 220 in History and privacy has 90, and line 234 in HTTP mode has 78.

Current text, line 210:

> Each URL gets a TTL matched to how fast the value changes: 30 seconds for battery, location, and exterior; 60 seconds for availability, odometer, and parking climatization; 5 minutes for charging settings; 10 minutes for health; 30 minutes for pre-cleaning; 1 hour for the vehicle list.

Recommendation: keep the budget paragraph and the fail-closed paragraph, convert the TTL schedule to a small two-column table (value class, TTL), and put retry rules in three bullets (which status codes, how many attempts, backoff cap). That removes one of the longest sentences in the README and makes the numbers scannable.

### N4. The Mermaid diagram is the only explanation of the request path and does not render everywhere

Current text, lines 199 to 208: a seven-node flowchart with `<br/>` labels, including `26 or 36 read tools` and `Budget meter 10,000 per day fails closed`.

Why it matters: `package.json` ships the README to npm, and package pages and several other renderers do not render Mermaid, so the packaged README shows a code block. On a narrow phone the diagram shrinks below readable size.

Recommendation: keep the diagram only if GitHub is the only target, and add a one-sentence ordered summary of the path (client, tool, client, cache, retry, budget, API) so the diagram is never the only source. Consider replacing it with five ordered list items.

### N5. Three-column tables will not be comfortable on narrow screens

Measurements: What you can ask has 12 data rows and cells up to 17 words; Configuration has 29 rows and cells up to 22 words; Documentation has 11 rows and cells up to 20 words. Example, line 260:

> `| POLESTAR_BUDGET_PER_MINUTE | 100 | Rolling per-minute ceiling the API also publishes; waited out rather than failed, when the wait fits the deadline |`

Recommendation: shorten the prose cells to about 8 words where the detail is already in `docs/getting-started.md`, keep the 29-variable table in its existing `<details>` block, and prefer two-column tables for anything a phone user must read. The 36-tool table is covered by M4.

### N6. Several claims are stated three to five times

- Read-only rationale: line 21, "The API is read-only, and so is this server."; line 333, "The documented v1 API is read-only and this server is read-only with it."
- Credential location: line 47, line 72 step 2, line 308, "Credentials live outside the repository, at `~/.config/polestar-mcp/.env.secrets`".
- Client list: line 7 and line 46.
- Tool count 26 or 36: line 11, line 23, line 201 in the diagram, line 238, line 320 in the Documentation table.

Recommendation: state read-only once in the intro, put the credential path in Quick start only and let Security link to it, and keep the tool count in two places at most (the badge and The tools intro).

### N7. Project status and Documentation mix three audiences

Current text, line 335:

```text
Directory reviewers should start with [docs/reviewer-pack.md](docs/reviewer-pack.md); data handling is described in [docs/privacy.md](docs/privacy.md).
```

Current text, line 335 (same paragraph) also carries npm and `.mcpb` release blockers. The Documentation table at lines 317 to 329 mixes user guides, architecture notes, live contract findings, write endpoints, the reviewer pack and the bundle checklist.

Recommendation: split Documentation into "For users" and "For developers and reviewers" tables, and move the reviewer pointer into that second table or a short "For reviewers" line. Keep the required links to `docs/privacy.md`, `docs/reviewer-pack.md` and `docs/bundle.md`; the docs gate checks that all three appear in the README.

### N8. "Check the connection" has no expected result and is not a numbered step

Current text, line 104:

> Ask the client for a status briefing. `get_car_status` is a good end-to-end check because it reads several domains and reports their ages. If something looks wrong, `polestar_status` shows the daily budget, cache state, and token expiry.

Recommendation: make it step 5 and show three or four lines of expected output (the fixtures already contain a `polestar_status` response). Say what a failure looks like (no tool listed, `AuthError`, 403 mismatch) and link to Troubleshooting.

### N9. The mechanics paragraph interrupts the user-facing example

Current text, line 123:

> Domain tools answer in short prose. The header names the vehicle and domain and says how old the data is. Passing `raw: true` appends the untouched API payload. A successful result carries that text plus structured data where the tool has one; failures, not successes, use `structuredContent.message`.

Recommendation: move this below the example output block at lines 125 to 130, or into a `<details>` block titled "How answers are shaped". The example is the point of the section; the plumbing is not.

### N10. Three headings are vague or jargon-first

Current headings: `## The tools` at line 134, `## Resources, prompts, and subscriptions` at line 187, `## HTTP mode` at line 232.

Recommendation: `## The tools` becomes `## Tools at a glance` or `## The 36 tools`. `## Resources, prompts, and subscriptions` becomes `## Advanced MCP surface (resources, prompts, subscriptions)` or moves under one "Advanced" heading. `## HTTP mode` becomes `## Run it over HTTP`. Heading length is otherwise good; none is longer than four words.

### N11. Development and testing is a sixteen-command wall

Current text, lines 283 to 300: a single code block with sixteen commands, from `npm ci` and `typecheck` through `smoke`, `demo`, the `check-*` scripts and the four `check-docs` subcommands.

Recommendation: keep the five commands a contributor needs first (`npm ci`, `npm run build`, `npm run typecheck`, `npm test`, `npm run coverage`) plus `npm run demo`, and link to the check table in `CONTRIBUTING.md` lines 50 to 67 for the rest. Keep `npm run demo` in particular, because the pack-and-install CI job runs it from the published tarball.

### N12. The credentials recipe is POSIX shell only and no OS support is stated

Current text, lines 74 to 80:

> ```sh
> mkdir -p ~/.config/polestar-mcp
> cat > ~/.config/polestar-mcp/.env.secrets <<'EOF'
> POLESTAR_CLIENT_ID=paste-your-client-id-here
> ...
> EOF
> ```

Why it matters: the heredoc does not work in PowerShell or `cmd`, and the README never says which platforms are supported. `docs/bundle.md` line 19 lists macOS and Windows compatibility for the Claude Desktop bundle, so a Windows reader has reason to expect support and no recipe.

Recommendation: add one line stating the supported platforms, or show an editor-based alternative ("create the file with your editor") beside the shell recipe. Link `.env.example`, which already exists and is shipped in the package.

### N13. The privacy story is spread across three sections and never summarized

Current text, line 220: "The API reports current state only, so questions about the past need a local store." Current text, line 308: "Credentials live outside the repository". The detailed policy is in `docs/privacy.md`, and the README never tells a reader that the server sends data only to Polestar and has no telemetry.

Recommendation: add two sentences near the top or at the end of Quick start: credentials stay on the machine, requests go only to Polestar, the history store is opt-in, and `docs/privacy.md` has the full policy. This also makes the required `docs/privacy.md` link visible earlier.

### N14. The opening paragraph leads with bookkeeping

Current text, line 23:

> A default start registers 26 tools. Enable the optional local history store and it registers 36.

Why it is an issue: "registers" and "local history store" are undefined at this point, and the paragraph is about counts rather than the reader's problem. The second and third sentences of that paragraph are good; the first two are bookkeeping that belongs in The tools or Requirements.

Recommendation: cut the count from the opening paragraph and let The tools introduce it, or say "exposes 26 tools to your MCP client by default, and 36 once you turn on the optional local history". The badge fix in M3 gives the count a home.

## Undefined jargon

Terms in order of first use. "Defined" means the README expands or explains it where it appears.

| Term | First use | Status | Suggested treatment |
| --- | --- | --- | --- |
| MCP | line 7 | Defined with link | Keep |
| M2M | line 5 | Undefined | Expand once or drop from the subtitle |
| stdio | line 46 | Undefined | Parenthetical: "stdio, the local process transport" |
| VIN | line 136 (as `vin`), line 143 (term) | Undefined | Expand once: vehicle identification number |
| Domain | line 104 (lowercase), line 123 (capitalized) | Undefined, used 25 times | Define once; it is a deliberate repo word, so keep the word and gloss it |
| SoC | line 167 | Undefined | "state of charge (SoC)" once |
| raw: true | line 123 | Explained | Keep |
| structuredContent.message | line 123 | Undefined | Move to advanced material or drop |
| MCP elicitation | line 136 | Undefined | "asks the client to choose" in plain language first |
| JSONL | line 220 | Undefined | "one JSON object per line" |
| metaEventId | line 191 | Undefined | "the cloud's change ID" as getting started does |
| Streamable HTTP | line 234 | Undefined | Link or one-clause gloss |
| TTL | line 210 | Undefined | "cache lifetime" instead |
| humanized | line 189 | Undefined | "plain-language answer" |
| single-flight | line 210 | Context explains it | Keep, or "one shared refresh" |

## Section-by-section assessment

Current H2 order. Action is what the rewrite should do, with finding references.

| Section (lines) | Verdict | Action |
| --- | --- | --- |
| Title and badges (1 to 15) | Keep with fixes | Badge count, scope line (M3, N14) |
| What it does (17 to 23) | Keep | Tighten, defer counts and history to later sections (M9, N14) |
| Contents (25 to 41) | Keep or move | Add quick-start anchors or move below Quick start (N1) |
| Requirements (43 to 47) | Keep with fixes | Add git, npm, clone, OS note, `.env.example` link (M2, N12) |
| Quick start (49 to 104) | Restructure | Add clone, fixture client, config locations, expected output (M1, M2, M8, N8) |
| What you can ask (106 to 132) | Keep with fixes | Trim cells, move mechanics paragraph (N5, N9) |
| The tools (134 to 185) | Collapse | Full table into `details` or docs; fix the 15 `get_*` sentence; define Domain (M4, M5, M9) |
| Resources, prompts, subscriptions (187 to 193) | Move | Merge with HTTP under advanced, rename (N2, N10) |
| Rate limits, caching, tokens (195 to 216) | Rewrite | Prose to table and bullets, keep one diagram sentence (N3, N4) |
| History and privacy (218 to 230) | Keep, move earlier | Before Configuration, gloss JSONL and `metaEventId` (N2, N13) |
| HTTP mode (232 to 238) | Move | With advanced surface, rename (N2, N10) |
| Configuration (240 to 279) | Keep | Lead with common variables, keep the 29-row `details` table (N5, gate constraint) |
| Development and testing (281 to 304) | Trim | Five commands plus `CONTRIBUTING.md` link (N11) |
| Security (306 to 313) | Keep with dedupe | Drop repeated credential path and read-only rationale (N6) |
| Documentation (315 to 329) | Split | User and developer/reviewer tables (N7) |
| Project status (331 to 337) | Keep with move | Scope moves to top, detail stays (M3, N7) |
| License (339 to 341) | Keep | None |

## Dimension scorecard

| Dimension | Verdict | Where addressed |
| --- | --- | --- |
| What it does in 20 seconds | Pass | line 5 and line 19 |
| Whether it fits my setup | Fail | M3 |
| What I need | Partial | M2, N12 |
| Try without a credential | Partial | M1 |
| Connect a real client | Partial | M8 |
| Check it works | Partial | M8, N8 |
| Where to go next | Partial | N7, outline section 14 |
| Ordering and hierarchy | Mixed | M3, N2, outline |
| Contents list | Complete but low value | N1 |
| Heading names and length | Good length, two jargon-first names | N10 |
| Opening paragraphs | Strong hook, early bookkeeping | N14, M3 |
| Quick start flow | Right order, broken first step | M1, M2, M8 |
| Table scannability | Poor for the 36-tool table | M4, N5 |
| Repetition | Noticeable | N6 |
| Missing sections | Installation step, Troubleshooting, Contributing | M2, M6, M7 |
| Undefined jargon | Domain, SoC and M2M are load-bearing | M9, jargon table |
| Prose versus list balance | Prose-heavy in the middle | N3, N9 |
| Narrow-screen rendering | Tools table, 3-column tables, Mermaid | M4, N4, N5 |

## Constraints the rewrite must keep

These are enforced, so the outline must not cut them while reorganizing.

- `scripts/check-version.mjs` line 46 parses a version badge of the form `badge/version-X.Y.Z` from the README. Keep that badge exactly. The tools badge is free text.
- `node docs/check-docs.mjs envvars` requires every `POLESTAR_*` variable read in `src/` to appear in `README.md`, `docs/getting-started.md` and `.env.example`. Do not delete the 29-variable table; move or collapse it.
- `test/docs-gates.test.ts` lines 238 to 250 requires the README to mention `docs/privacy.md`, `docs/reviewer-pack.md` and `docs/bundle.md`.
- `docs/reviewer-pack.md` line 70 expects the README status section to state that this is a personal project, not affiliated with or endorsed by Polestar. Keep the claim, move it if desired.
- The pack-and-install CI job runs `npm run demo`, `--version` and `--help` from the installed tarball, so those README commands must stay true.
- `node docs/check-docs.mjs links` validates every relative link and every in-page anchor in the README. If headings are renamed, update the Contents list in the same edit.
- `node docs/check-docs.mjs hygiene` scans the whole tree, including this analysis directory: no em dash, no spaced en dash, no banned marketing words, no spaced hyphen used as dash punctuation.

## Checks run

- `node docs/check-docs.mjs links` -> `DOCS_LINKS_OK`
- `node docs/check-docs.mjs tools` -> `DOCS_TOOLS_OK tools=36 domains=15`
- `node docs/check-docs.mjs envvars` -> `DOCS_ENVVARS_OK variables=29 docs=3`
- `node docs/check-docs.mjs hygiene` -> `HYGIENE_NO_EM_DASH`, `HYGIENE_BUZZWORDS_CLEAN`, `HYGIENE_NO_BANNERS`, `HYGIENE_NO_DASH_CONNECTORS`, `HYGIENE_CLEAN`

All four gates were run after this file was written and passed. No tracked file was modified; this report and its directory are new and untracked.

Measurements quoted above were taken with a local script over `README.md`: table row counts and word counts per cell, paragraph word counts, and lines over 220 characters. The longest source lines are line 335 (628 characters) and line 220 (594 characters); the longest paragraphs are line 335 (94 words) and line 220 (90 words).
