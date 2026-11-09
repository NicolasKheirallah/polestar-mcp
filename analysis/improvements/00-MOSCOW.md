# polestar-mcp: MoSCoW improvement backlog

Scope: the whole repository at commit `dc50017` (v0.3.0), read in code and exercised offline.
This is the synthesis of four deep-dive lanes: surface and protocol, domain data and analytics,
platform and security, ecosystem and release. Each lane produced an evidence file under
`analysis/improvements/`. Every row below carries the identifier from the source lane so a claim
can be traced to its file, its line and the command that observed it.

Nothing in `src/`, `test/`, `scripts/` or `docs/` was modified. The only new files are the
analysis notes under `analysis/`.

## Delivery status

Implementation status is recorded in [05-IMPLEMENTATION-STATUS.md](05-IMPLEMENTATION-STATUS.md):
10 of 10 Must items done (one external publish half blocked on credentials), 15 of 16 Should
items done with one partial, and 13 of 16 Could items done with one partial and two blocked on
SDK or desktop-host support. The code lives on the `moscow-backlog` branch in the worktree
`.agents/worktrees/moscow-backlog`; the main checkout was restored to `dc50017` and never holds
the implementation.

## Baseline measured before and after the audit

| Check | Command | Result |
| --- | --- | --- |
| Unit suite | `npm test` | 111 pass, 0 fail |
| Types | `npm run typecheck` | exit 0 |
| Docs and writing gates | `node docs/check-docs.mjs tools, envvars, links, hygiene` | all pass |
| Registry, fixtures, secrets, bin, HTTP | `npm run check-tool-refs`, `verify-fixtures`, `check-secrets`, `smoke-bin`, `smoke-http` | all pass |
| Coverage | `npm run coverage` | 95.54 line, 86.50 branch, no threshold |
| Offline demo | `npm run demo-dump` | exit 1, `DUMP_FAILED` |
| npm name | `npm view polestar-mcp version` | `E404` |
| Packed package | `npm pack --dry-run` | 85 files, no fixtures, no scripts |

The backlog is deliberately ordered by what blocks trust, not by what is fun to build. Must
items are release blockers: each one is a documented promise or a safety property that is false
today. Should items are high-value repairs to the same product. Could items are real features
that should wait until the substrate is trustworthy. Won't items are decisions, recorded so they
are not re-litigated by accident.

Counts: 10 Must groups, 16 Should, 16 Could, 12 Won't. Items that the source lanes graded
differently are called out in the row so the disagreement stays visible.

---

## MUST (release blockers: a published claim or safety property is false today)

### M1. Scope the cache by identity, because a delegated read can be served from the owner's entry

Evidence: `src/caching-transport.ts:83` keys entries on the URL alone, while the identity travels
in `x-client-id` and `x-delegated-account-id` headers (`src/client.ts:193-200`), and
`forDelegation` shares the same transport and cache (`src/client.ts:85-88`). Reproduced with a
stub: `owner.vehicles()` returned `['owner-vehicle']`, then `delegated.vehicles()` returned
`['owner-vehicle']` with exactly one HTTP call, so the partner read was the owner's cached list.
The delegated-account feature exists to read another account's shared vehicles, so on a process
that uses it this is a cross-account disclosure. This is the security council's P0-1 and it gates
A6, C3, C9, C12, D9 and B12.

Fix: include the credential identity and the delegated account in the cache key (or namespace
the cache per client), and keep the token POST out of it. Add a regression test that builds the
production chain through `buildEngine`, calls as the owner, then as a delegated client, and
asserts a second transport request.

Cost: S. Risk: a wider key changes cache hit rates and entry counts, so the status arithmetic
and existing cache tests move with it.

Falsifiable check: with two identities on one engine, the second identity must miss the cache;
the test fails against today's `const key = url`.

### M2. Keep budget metering and retry in the live chain when `POLESTAR_CACHE=off`

Evidence: `src/server.ts:78-79` composes `RetryingTransport` only when the cache is enabled and
not in fixture mode. `RetryingTransport` is the only caller of `budget.consume()` and
`minute.consume()` (`src/retrying-transport.ts:56-68`), so `POLESTAR_CACHE=off` silently removes
the daily guard, the per-minute guard and all retries. The probe recorded
`CACHE_OFF budgetUsed=0 minuteUsed=0` after live requests and a surfaced 429, against
`CACHE_ON budgetUsed=4`. Three published statements are therefore false under a supported flag:
`README.md:157` ("every attempt, retries included, is metered"),
`SECURITY.md:59-60` ("the server meters every live attempt and fails closed"), and
`docs/architecture.md:7` ("every live attempt is metered before it goes out").

Fix: make metering and retry unconditional in live mode; let the cache wrap the retry layer.
Add a composition test for both cache settings, including `POLESTAR_BUDGET=2` refusing the third
attempt with the cache off.

Cost: S. Risk: one extra wrapper order to get right; fixture mode must stay unmetered.

Falsifiable check: `buildEngine({POLESTAR_CACHE:'off', ...})` with a 429 then 200 stub must make
two attempts and report `used > 0`.

### M3. Make `POLESTAR_REDACT_VIN` true on every surface, or narrow the claim in `SECURITY.md`

Evidence: redaction is applied in the tool text and envelope (`src/vehicle-read.ts:275-283`) and
nowhere else. `resources/list` builds URIs from the raw VIN (`src/server.ts:285-287`),
completion returns raw VINs (`src/server.ts:297-302`), `AMBIGUOUS_VIN` and `VIN_MISMATCH` print
the raw identifiers (`src/client.ts:124-125`, `:227`, `:246`), the elicitation enum and
`VIN_NOT_CHOSEN` do the same (`src/vehicle-read.ts:94`, `:109`), and the store names directories
with the VIN (`src/history.ts:86-90`). `SECURITY.md:26-27` claims the mask covers resource
listings. Prior probes observed full VINs in `resources/list`, `resources/read` echo,
`completion/complete`, `VIN_MISMATCH` and the ambiguity error.

Fix: mask names, descriptions, completions, elicitation values and error text. Decide the
resource URI explicitly: truncation breaks reads because the URI VIN is fed back through
`resolveVin` (`src/server.ts:306-317`, `src/client.ts:107-116`), so either introduce an opaque
stable vehicle handle or document the URI as an exception. Document `raw: true` and the history
directory path as the remaining exceptions, and add a scan that no non-raw JSON-RPC result
contains a 17-character VIN pattern.

Cost: M (the opaque handle is the expensive half; masking the other five paths is S). Risk: a
masked URI makes every listed resource unreadable and unsubscribable, which is why the narrow
claim is a valid interim.

Falsifiable check: with `POLESTAR_REDACT_VIN=1`, every non-raw result passes
`!/[A-HJ-NPR-Z0-9]{17}/`, except the documented URI and `raw` exceptions.

### M4. Stop letting absence answer yes/no, and stop hiding unreported or stale domains in aggregates

Evidence: `src/vehicle-read.ts:155-158` returns the absence sentence as `ok: true`, so
`is_car_secure` and `get_needs_attention` answer from nothing. With exterior and health set to
`DATA_NOT_AVAILABLE`, `is_car_secure` returned only `No exterior data is available...` with
`isError false`, and `get_car_status` printed a partial briefing with no mention that two
domains were absent. `get_car_status` prints one newest age (`src/aggregate-tools.ts:86`) while
its description promises "data age for each" (`:38`), so a two-year-old service countdown and a
one-minute-old battery look equally current. The same aggregate omits missing constituents
silently (`:55-76`), and `is_car_secure`'s verdict ignores the alarm state its description
promises (`:98` against `:110-114`). A triggered alarm can print
`Yes, car is secure ... Alarm: triggered.`

Fix: absence becomes unknown, not negative; carry `code: DATA_NOT_AVAILABLE` and
`data.reported: false`; aggregates name each unreported domain and print per-domain ages plus an
oldest marker; the security verdict includes alarm and treats absent lock fields as unknown, not
unlocked.

Cost: M. Risk: text changes that models route on; update the contract tests in the same change.

Falsifiable check: an all-absent surface must never start its answer with "Yes", "No" or
"Nothing"; fresh battery plus stale health must name the stale domain and its age.

### M5. Make the charging and planning answers say only what they computed

Evidence, four separate defects in one answer path:

- `get_charging_estimate` prints "Usable-energy data not reported; showing the car's own estimate
  instead." and then no figure when `estimatedChargingTimeToFullMinutes` is 0 or absent
  (`src/aggregate-tools.ts:186-191`). It also defaults a missing target to 80 percent without
  saying so (`:170`, `:178`), and labels the car's own estimate "to 100%" although its relation to
  the configured target is unverified.
- The planner reports `feasible: true` while delivering less energy than needed when the 48-hour
  window has fewer slots than the required hours: probe A needed 56 kWh, produced 2 steps totalling
  18.67 kWh, and still said feasible (`src/planner.ts:59-63`, `:114-138`).
- "Contiguous" means adjacent in the filtered slot list, not adjacent in time: a probe showed a
  20-hour gap inside a block reported as contiguous (`src/planner.ts:118-125`). A stop hour above
  23 silently truncates the window to one hour per night (`:70-73`), and steps can start at
  `:00:45.678` because the first slot is not floored (`:77`).
- Prices outside the 48-hour match window still produce `ok: true` steps labelled "price unknown"
  with no cost; the cost has no unit, negative prices lose the cost line, and energy is spread
  evenly over rounded-up hours rather than derived from the chosen schedule
  (`src/planner.ts:86-92`, `:132-147`; `src/advisor-tools.ts:79-81`, `:125`).

Fix: refuse or explicitly flag a shortfall; require time adjacency or label the plan
non-contiguous; normalize window hours (including values above 23) and floor slot starts; validate
that prices cover the scheduled hours and return an error or a dominant warning when they do not;
name the currency unit, keep negative and zero costs, and compute cost from the chosen steps;
state the assumed target when `target-soc` is absent, and remove "to 100%" unless the live
contract proves it.

Cost: M. Risk: the planner's tests currently pin some of this behavior, so they change with it.

Falsifiable check: delivered energy must be greater than or equal to the needed energy or the
plan is not feasible; every step start ends in `:00`; a 22 to 28 window schedules 00:00 to 03:00;
24 out-of-window prices produce an error code, not a priced-looking plan.

### M6. Make the registered surface match what prompts and schemas say

Evidence: `battery-health-report` is registered on every start
(`src/server.ts:240`, `:388-409`) and names `get_degradation_report` and
`get_charging_sessions`, which exist only when a history store is configured
(`src/server.ts:201`). The check that appears to cover this builds the 26-tool union instead of
the running surface (`test/server-seams.test.ts:263-284`), so CI is green while a default user is
told to call two tools that do not exist. Separately, the SDK parses tool arguments with Zod and
strips unknown keys (`src/tools.ts:48`), so `get_battery {"vinn": ...}` answers normally about
the default car. `polestar_status` tells the operator to set `POLESTAR_CACHE_DISABLED`
(`src/system-tools.ts:54`), a variable the server never reads, and reports the token as trusted
past its five-minute skew (`:56-64` against `src/auth.ts:13`).

Fix: build prompts from the running surface, or gate the history prompt on the store; make tool
schemas strict so an unknown key is refused by name (state the compatibility break in the release
notes); fix the status string and the skew-adjusted token life.

Cost: S to M. Risk: strict schemas can reject client-added keys; that is the intended trade for a
misspelled VIN.

Falsifiable check: spawn without a history directory and assert every tool-shaped name in a prompt
is in `tools/list`; `get_battery {"vinn": ...}` is an error naming `vinn`.

### M7. Make the advertised history answers correct

Evidence: `get_history` keeps five hardcoded battery field names
(`src/history-tools.ts:79-83`), so 11 of 15 domains render as `{}`, including amp limit, target
SOC, charge window and climate timers. A store of five battery samples at 3 percent SOC crashes
the degradation report with `INTERNAL_ERROR` because the sample gate counts raw records while the
series drops them (`src/history-tools.ts:104-111`, `src/history.ts:211`). Session output prints
`activeSeconds` as a duration even though the store documents it as a span including gaps
(`src/history-tools.ts:155`, `src/history.ts:118-122`). Every record timestamp is the read clock
(`src/server.ts:110-112`, `Date.now()`), while history tools present it as the sample time
(`src/history.ts:216`), which is how a fixture observed 2026-09-18 appeared as a 2026-11-09 sample.

Fix: render each domain's payload (per-domain allowlist, or all keys when none match), guard zero
usable points with a sentence, label the session span honestly, record and display the value's own
timestamp, and add a pagination marker so a truncated answer cannot look complete.

Cost: M. Risk: the store format changes, so old files need a labelled read-clock field rather
than silent reinterpretation.

Falsifiable check: one recorded `charging/amp-limit` sample renders `ampLimit`, not `{}`; a
five-sample low-SOC store returns a sentence, not `isError`.

### M8. Make the offline demo and the install path true, or stop promising them

Evidence: `npm run demo-dump` exits 1 on a clean checkout with
`DUMP_FAILED: expected captured dump at .../GitHub (dataportal/vehicles.json not found)`, because
`scripts/demo-dump.ts:14-19` resolves the parent of the repository and refuses before reading
`POLESTAR_FIXTURES_DIR`. `README.md:51-57` and `:222` say the same command prints `DUMP_OK`.
`package.json:45-53` excludes `test/` and `scripts/`, so the packed tarball (85 files) contains
neither the synthetic dump nor the demo script while the packed README still advertises both.
`docs/releases/v0.3.0.md:11` tells a new user to run `npm install -g polestar-mcp`, but
`npm view polestar-mcp version` returns `E404`; `server.json:2` points at a schema URL that
returns 404, uses `name` where the current schema requires `packages[].identifier`, and
`package.json` has no `mcpName`; CI has no publish or pack-and-install job.

Fix: make the demo run against the shipped `test/fixtures/dump` (and add a `--demo` mode that
zeroes network access) or remove the promise; either publish for real (reserve the npm name,
current registry schema, `mcpName`, tag-driven release with provenance) or replace every install
claim with the repository build path. Add a CI job that packs, installs the tarball in a temp
directory and runs the handshake.

Cost: S to M. Risk: publishing needs owner credentials and an unavailable name, so the honest
interim is to remove the claims.

Falsifiable check: clean checkout `npm run demo-dump` prints `DUMP_OK`; a pack-and-install job
runs `--version`, `--help` and an MCP handshake from the tarball.

### M9. Reject cross-origin and forged-Host requests in HTTP mode

Evidence: `src/server.ts:421-425` checks only the bearer token. Binding loopback with no token is
the documented default (`src/bind.ts:19-26`). A prior probe sent `Host: attacker.example` and
`Origin: http://attacker.example` to the loopback listener and received 200 with the full
`tools/list`; a request with no Origin also passed. That is the DNS-rebinding and browser-origin
path to vehicle location and status, and the MCP specification calls for Origin validation.

Fix: compose the SDK Host and Origin guards, or implement an explicit allowlist, and reject
before the body is read. Add a token length floor and a constant-time comparison while there.

Cost: S. Risk: a legitimate proxied deployment needs a configured allowlist, so document the
variable.

Falsifiable check: an `initialize` POST with an attacker Host and Origin must be 401 or 403; a
normal stdio-side client and the loopback smoke client must still pass.

### M10. Repair the gates that pass while these defects are live, and give coverage a floor

Evidence: the prompt test builds the 26-tool union (`test/server-seams.test.ts:263-284`); the
description test only checks for a hedge phrase, never that a promised value is rendered
(`test/contract.test.ts:50-62`); the planner "fallback" test takes the contiguous path and accepts
any plan (`test/planner.test.ts:125-146`); the HTTP smoke sends no Origin or Host
(`scripts/smoke-http.ts`); the redaction test covers the domain envelope only
(`test/runtime.test.ts:345-365`); `package.json:25` runs `--experimental-test-coverage` with no
threshold and CI runs that script, so the gate cannot fail. The ecosystem lane also measured
`scripts/smoke-bin.ts:39-42` hardcoding exit 0 and leaving stdin open, which makes the bin smoke
cost about 20 seconds and masks the executable-bit claim.

Fix: derive the prompt test from `createMcpServer(env)`; add a promise-to-render map; assert
delivered energy in the planner test; add an identity-scoped cache regression test, a redaction
scan over every non-raw result, and an Origin/Host test; set coverage floors (for example lines
90, branches 80, functions 85) with documented exceptions and a real exit code; make smoke-bin
observe the child exit and close stdin.

Cost: M. Risk: some new tests will fail immediately, which is the point; land them with the fixes
they describe.

Falsifiable check: each new check fails against the current code and passes after its fix; the
coverage command exits nonzero below the floor.

---

## SHOULD (high-value repairs for the same product, next cycle)

| ID | Improvement | Evidence | Cost | Why now | Falsifiable check |
| --- | --- | --- | --- | --- | --- |
| S1 | One charging answer in `get_car_status`: target SOC, plugged state, car's own time to full, energy to target when available (E4, B1) | `src/aggregate-tools.ts:45-52` reads five telemetry domains and no charging setting | S | "Is it plugged in and when will it be full" is the second-most-asked question and currently costs two tools plus a confusing sentence | Unplugged fixture answers "not charging" in one call; target and ETA appear when the car reports them |
| S2 | One charge model: capacity fallback chain, AC efficiency, phase and voltage convention, input bounds (B-01, B-02, B-06, B-07, B-16) | `src/charge-model.ts:50-70` multiplies amps by volts by phases, which is 1.73x high if the reported volts are line-to-line, and derives capacity only from `dischargeInfo.energyAvailable`; 16 A at 400 V three-phase becomes 19.2 kW instead of 11.1 kW | M | Both the estimate and the plan rest on this one model, so an error here is an error in every charging answer | 16 A, 400 V, 3 phases yields 11.1 kW plus or minus 0.1; a fixture without `dischargeInfo` still yields the range-times-consumption capacity with the source named |
| S3 | Rate freshness by the value's own clock, not the receive or read clock (A-03, B-08, V21) | `src/domain-data.ts:120-132` reads top-level `timestamp.seconds` then `metaReceivedAt` and never nested `updatedAtTimestamp`; the fixture charge timer is 24.65 days older than its receive time, the climate timer 88.44 days | M | The advice "read the age before trusting a value" is false for charging settings today, and history records the read clock | A settings payload with an old `updatedAtTimestamp` prints that age; recorded `observedAt` equals the payload value time or a separate read time is labelled |
| S4 | Negative caching for `DATA_NOT_AVAILABLE` (C3, V18) | `src/caching-transport.ts:113-115` stores only statuses below 400, and `src/client.ts:150-152` turns the 404 into null, so every question about an unreported domain spends a live call | S | `get_is_at_charge_location` is unsupported on the reference car and costs quota on every ask | Two reads of an absent domain make one transport call; a 403 or 429 is never cached |
| S5 | Retry hardening: both RFC 9110 `Retry-After` forms, 5xx policy, jitter, token `expiresIn` validation (C8, V19, B-17-adjacent) | `src/retrying-transport.ts:21` retries only 429/502/503; `:88-93` parses only numeric seconds, so an HTTP-date header is ignored; `src/auth.ts:138` accepts NaN/negative `expiresIn` | S | One Wi-Fi blip or a date-form header changes whether a call succeeds and how much quota it spends | An HTTP-date `Retry-After` produces the same wait as the numeric form; a non-finite `expiresIn` is an `AuthError` |
| S6 | Subscription hardening: validate URI and VIN, cap the set, guard overlapping rounds, advance the change id only after `notify` resolves (C10, A-19, V20) | `src/subscriptions.ts:39` has no cap, `:44-47` lets a round overlap the next, `:105-108` stores the new id before awaiting notify, and any non-slash VIN segment parses (`src/domains.ts:390`) | S | A typo costs a 60-second poll, one failed notify loses a change forever, and 150 subscriptions can spend about 9,000 reads a day | A garbage URI is a JSON-RPC error; one cloud change produces exactly one notification; a rejected notify is retried next round |
| S7 | Tool-list economy: one compact output schema, move endpoint and scope prose to `list_domains`, decide the duplicated `message`, remove the tripled hint (E1, E2, E3, A-12, D-13, D-14) | `tools/list` is 50,718 bytes at 26 tools, 26,234 of it the same 1,009-byte output schema 26 times; `structuredContent.message` repeats the text; measured 44,841 bytes at 23 tools | M | Every session pays about 12,000 tokens before the first question; the schema duplication is over half of it | `tools/list` under 32,000 bytes with the routing questions still answered; no `message` equals the content text; a raw result carries its payload once |
| S8 | Machine-readable `data` on the default path, with documented per-tool shapes (A-11, A1) | `src/tool-output.ts:70-92` declares `data` as `z.unknown()`; only `list_vehicles` populates it; a client that wants the charge percent or planner steps must parse prose | M | Structured clients are the main integration path, and the envelope already claims a shape that does not exist | Every tool result carries a schema-valid `data` object; a client test reads charge percent and budget remaining without regex |
| S9 | Bound and prune the history store, and page history reads (C9, A-13, B-08) | `src/history.ts:5` caps a read at 64 MB while `append` has no bound; `src/history-tools.ts:28,37-40,77` has no offset, cursor or truncation marker | M | The 64 MB refusal is an internal error after months of legitimate append, and a 200-record answer looks complete | Appends respect a configured size or retention bound with a documented prune; `limit: 2` of three records says more are available and returns a next pointer |
| S10 | Configuration and connection hardening: reject non-positive budgets and timeouts, honour a falsey vocabulary for `POLESTAR_ALLOW_LOCATION`, require https outside loopback, check the fixtures directory, add a token floor (lead probes, C5) | `POLESTAR_ALLOW_LOCATION=no` leaves location enabled, `POLESTAR_BUDGET=-5` and `0` load and only fail later in `BudgetMeter` with a generic error, `http://` base URLs are accepted, a missing fixtures directory starts and fails per call | S | These are privacy and setup controls whose wrong value looks like a working configuration | `POLESTAR_ALLOW_LOCATION=no` disables location; `POLESTAR_BUDGET=abc` and `0` fail with the variable and the fix; a missing fixtures directory fails at startup |
| S11 | Failure presentation: distinguish local refusal from upstream error, correct the 403 hint, mention `requestId` only when present, stop tripling the hint (A-17) | `src/failure.ts:113-117` prefixes every failure with "Polestar API error"; `src/vehicle-read.ts:226-231` rewrites every 403 as a missing scope; `src/tool-output.ts:121-123,167-178` asks for a requestId that minted failures do not carry and repeats the hint three times | S | The model currently blames Polestar for local validation failures and cannot quote a handle that exists | `INVALID_VIN` text says the server refused it and makes no HTTP claim; a 403 keeps the code-specific hint; the hint appears once in text and once in the field |
| S12 | Location and summary data correctness: parse string-encoded numbers, render altitude, print the charge-window offset (B-05, A-21) | `src/domain-data.ts:142-156` reads speed with `asNumber`, but the live contract records speed as a string, and `src/format.ts:169` falls back to `0`, so a moving car can print `0 km/h`; `altitude` has no reader; the window offset is parsed but never rendered | S | A false speed and a hidden altitude undermine the one tool whose job is position truth | A payload with `speed: "45"` renders 45 km/h; altitude appears when reported; the charge window prints its offset |
| S13 | Resource and listing honesty: page more than 10 VINs, error instead of an empty list when the vehicle call fails, use configured labels, reject an unknown domain URI as a protocol error, add delegation and structured data to `list_vehicles` (A-22, A-20) | `src/server.ts:283` slices to 10 with no cursor; `:292-294` swallows a failure as `resources: []`; `:309-312` returns unknown-domain text as content; `src/domain-tools.ts:19-46` has no delegation argument | M | Fleet credentials cannot discover their vehicles, a failed list looks like zero cars, and a delegated `list_vehicles` cannot name the account it is reading | 12 VINs page or report truncation, a throwing vehicle list returns an error, a delegated list routes through `forDelegation` |
| S14 | Packaging and operations: `.dockerignore`, non-root user, healthcheck or `/healthz`, pinned base image, pack-and-install CI, Node floor and matrix (C4, D-05, D-07, D-08) | `Dockerfile` has no `USER`, `HEALTHCHECK`, `EXPOSE` or `.dockerignore`; `ci.yml` builds no image and publishes nothing; `engines` says 20.6 while scripts use `import.meta.dirname` (20.11) and CI tests only Node 22 | M | The container story is unvalidated and the stated Node floor is narrower than the helper scripts require | `docker build` runs non-root and answers a health probe; CI packs, installs the tarball and runs the handshake; a Node floor test runs at the stated minimum |
| S15 | Release and documentation gates: single version source, docs gates over CONTRIBUTING, SECURITY, CHANGELOG, releases and README, envvar regex and scope, shipped help coverage, changelog claims (D-09, D-10, D-11, D-18, D-19) | Version appears in six places while `docs/development.md:126` claims one; the docs gates resolve only `docs/*.md` plus README, so broken links in CONTRIBUTING, SECURITY, CHANGELOG and the release note pass; the envvar regex stops at digits and reads two source files; the `--help` text points at `.env.example` as the full list, but five variables the server reads are missing there; the changelog claims a logging notification that no code sends | S | The repository's own rules depend on these checks, and today they can pass while a document is wrong | A broken link in CONTRIBUTING fails a gate; a version mismatch fails a gate; every `POLESTAR_*` name in `KNOWN_ENV_VARIABLES` appears in both docs and help |
| S16 | Honest instructions, capabilities and annotations, plus prompt arguments and completions (A-09, A-24, A-25) | `src/server.ts:207-214` is a fixed string that never changes with history or units and claims every error has a requestId; `:215` advertises `logging` and `listChanged` while no notification sender exists in `src/`; `polestar_status` and history tools inherit the open-world default; prompts declare bare argument names | S | Clients auto-approve weaker hints and wait for notifications that never arrive; models route from text that does not describe this process | Instructions differ when history is enabled; advertised capabilities correspond to a sender; every tool states `openWorldHint` and `idempotentHint`; prompt arguments carry descriptions and VIN completion |

---

## COULD (worthwhile, after the substrate is trustworthy)

| ID | Improvement | Evidence | Cost | Note |
| --- | --- | --- | --- | --- |
| C1 | Charging setup aggregate: one call over the seven charging settings, each with its age (A-27) | `src/aggregate-tools.ts:45-52` covers telemetry only | M | The instructions tell models to prefer aggregates, and the second-most-asked setup question has none |
| C2 | Domain availability matrix: report each of the 15 domains as reported, absent or failed (A-28) | `list_domains` is the server registry, not the car's support | M | Today onboarding costs up to 15 failed reads |
| C3 | Departure readiness from the climate and charge timers (B3) | `src/advisor-tools.ts` reads the charge window but not the climate timer | M | Answers "warm and charged by Sunday 14:00" without needing history |
| C4 | Charging energy and cost ledger (B2) | History has sessions without energy (`src/history.ts:117-126`) | L | Gated on a written retention and disclosure rule; it is a second personal-data store |
| C5 | Battery health trend with an interval, minimum span and named confounders (B4) | `src/history-tools.ts:104-111` accepts five samples from any span | M | The current report can claim a trend from an hour of noise |
| C6 | Warning transition detector: did a new warning appear (B5) | `sampled: false` for health in `src/domains.ts:129-130` | S | Needs the sampler set widened and the empty state worded as unobserved, not clear |
| C7 | Trip and odometer reconstruction over history (B6) | Odometer is sampled; no derived trip tool exists | M | Compute on read, do not persist derived trips |
| C8 | Cross-domain timeline and typed history query (B7) | `get_history` is one domain at a time | L | The substrate for C4, C5 and C9; honour the location opt-out per domain |
| C9 | Weekly digest composing the answers above (B8) | None today | M | Ship only after C4, C5 and C8, because a prose digest hides sample sparsity |
| C10 | Service forecast and settings confirmation timeline (B9, B10) | `health` has days and distance; `pendingAmpLimit` and pending timer blocks exist | S | Two lines each once the value clock (S3) lands |
| C11 | Claude Desktop `.mcpb` bundle with sensitive `user_config` fields (D2) | None today | M | After publishing exists |
| C12 | Reviewer pack: sample data statement, three example prompts, privacy policy link (D4) | None today | S | Required by directories for review |
| C13 | One MCP Apps view for charging sessions or degradation, with a text fallback (D8) | Text only today | L | New executable content in the trust path; no external fetch, no location unless allowed |
| C14 | Protocol era upgrade to the 2026-07-28 revision once the SDK supports it (C11, D5) | Installed SDK negotiates 2025-11-25; `server/discover` returns method not found | L | Needs evidence before work; the compatibility rules cover legacy servers meanwhile |
| C15 | Persistent budget ledger keyed by identity hash (C2) | `src/budget.ts` is memory only, so two clients each get a full day | M | Fail closed on an unreadable ledger; mode 0600 |
| C16 | Small correctness and surface cleanups: `formatAge` rounding at 90 minutes and 47.5 hours, malformed percent-encoding in `parseResourceUri`, HTTP body and response size caps, per-request surface rebuild (B-17, B-19, lead) | `src/format.ts:99-107`, `src/domains.ts:422`, `src/server.ts:433` | S | None change an answer materially; batch them with the next surface change |

---

## WON'T (decisions, with the reason recorded)

| ID | Not doing | Reason |
| --- | --- | --- |
| W1 | Vehicle commands or any write endpoint | The documented v1 API publishes none; `POLESTAR_ENABLE_WRITES` stays inert until Polestar ships one, and `test/posture.test.ts` protects that |
| W2 | An adapter over the consumer app API | Undocumented, and its refresh token rotates on every refresh; a half-wired adapter would lock a car out rather than fail loudly |
| W3 | A hosted multi-tenant OAuth connector (D10) | A public endpoint holding location needs per-user credentials, an authorization server, TLS and audit that do not exist; it is a different product |
| W4 | Multi-credential fleet mode in one process (C12) | Cross-credential cache, history and budget bleed; it also needs the M1 isolation first |
| W5 | Geofence arrival and departure (B11) | Location history plus a home point is a presence oracle; it needs its own opt-in, storage rule and privacy review |
| W6 | Comparison across delegated accounts (B12) | The account may belong to another owner; M1 does not make that disclosure acceptable, it only stops the cache leak |
| W7 | A spot-price provider inside the server (D7) | It breaks the stated no-third-party-egress promise and a wrong price becomes a confidently wrong plan; improve pasted-price validation instead |
| W8 | Masking resource URIs by truncation | `resolveVin` rejects a masked VIN, so every listed resource would become unreadable and unsubscribable; use an opaque handle (part of M3) if that path is chosen |
| W9 | Full 2026-07-28 conformance before the SDK supports it | The installed SDK negotiates 2025-11-25; doing it now means hand-rolling protocol plumbing for no client |
| W10 | Patching or wrapping the SDK to add an unknown-tool hint | The error is thrown inside the SDK with no public hook; this is an upstream request, not a server feature |
| W11 | Renaming existing tools | Breaking change for every saved prompt and client; fix titles and descriptions instead (S16) |
| W12 | A full mutation-testing gate now | Run a pilot on the planner, cache and budget modules first; a tree-wide Stryker gate is a project of its own |

---

## Sequencing

**Milestone 1, about one day: stop the false answers and the two safety holes.** M2 (metering and
retry), M1 (cache identity), M6 (prompt surface, strict arguments, status string), M10's first
five tests, and the text halves of M4 and M5. These are small edits in `src/server.ts`,
`src/aggregate-tools.ts`, `src/caching-transport.ts`, `src/tool-output.ts` and the tests that
currently pin the defects. Nothing else on the list is visible this cheaply.

**Milestone 2, about one week: trusted answers.** M3 (redaction, with the URI decision made
first), M7 (history), M8 (distribution truth), M9 (HTTP guards), then S1 to S6. The charging
cluster (S1, S2) and the value clock (S3) are the prerequisites for every longitudinal Could.
S4 and S6 are independent and cheap.

**Milestone 3, about two weeks: foundation and release.** S7 to S16, then the Could analytics in
dependency order: C4 waits for C8 and a retention rule; C5 waits for S3 and a minimum span; C9
waits for C4, C5 and C8. Distribution (C11, C12) follows a real publish path.

**Do not start** the Could features before M1 to M5 and S3 land, because every one of them either
reads the cache, reads the history clock, or repeats the charging model.

## Verification appendix

Commands run by the lanes or the lead, with observed results. The full per-lane logs are in
`analysis/improvements/01-surface.md`, `02-core.md` and `04-ecosystem.md`; the platform rows here
were re-read in code by the lead and cross-checked against
`analysis/council/R2-engineering.md` (V1 to V38) and `analysis/council/R3-security.md` (red team).

| Command | Observed |
| --- | --- |
| `npm test` | 111 pass, 0 fail |
| `npm run typecheck` | exit 0 |
| `node docs/check-docs.mjs hygiene` | `HYGIENE_CLEAN` |
| `npm run demo-dump` | exit 1, `DUMP_FAILED: expected captured dump at .../GitHub` |
| `npm pack --dry-run --json` | 85 files, `build/` 78, no `test/` or `scripts/` |
| `npm view polestar-mcp version` | `E404` |
| Stub cache and delegation probe | `owner ['owner-vehicle']`, `delegated ['owner-vehicle']`, 1 HTTP call |
| Planner shortfall probe | `feasible true`, needed 56 kWh, steps delivered 18.67 kWh |
| `POLESTAR_CACHE=off` probe | `budgetUsed 0`, `minuteUsed 0`; cache on: `budgetUsed 4` |
| Config probe | `ALLOW_LOCATION=no` leaves location on; `BUDGET=-5` and `0` load; `http://` accepted |
| `grep -rn "sendLoggingMessage|sendToolListChanged" src/` | no matches |
| `grep -rn "mcpReq.signal" src/` | no matches; only the transport's own timeout signal |
