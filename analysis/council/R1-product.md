# R1. Product value and adoption

Council seat R1, task-6. This seat reads the five area reports, the lead defect audit and the
repository, and asks one question of every candidate: would a real Polestar owner or fleet
operator change what they do because of this answer, and is it different from what the Polestar
app already does? The app already shows charge, range, locks, location and the service countdown.
A candidate that only re-renders those in prose has no product value. The long-lived questions
(cost of charging, battery health, departure readiness, the monthly digest) are where the app is
weak, and this seat weights them accordingly.

Method: read `analysis/00-brief.md`, then A, B, C, D and E in order, then `analysis/lead-report.md`,
`analysis/arch/findings.md` (headings and F4, F8), `analysis/ops/findings.md` (gates), then
spot-checked `README.md`, `docs/tools-reference.md`, `docs/getting-started.md`,
`docs/architecture.md`, `package.json`, `server.json`, `SECURITY.md`, `src/aggregate-tools.ts`,
`src/advisor-tools.ts`, `src/planner.ts`, `src/charge-model.ts`, `src/format.ts`,
`src/domains.ts`, `src/server.ts`, `src/bind.ts`, `src/history-tools.ts` and
`scripts/demo-dump.ts`. No live API call was made. Citations of the form `A:337` mean
`analysis/A-surface.md` line 337; `lead:72` means `analysis/lead-report.md` line 72.

One sentence before the table: the repository already has a defensible shape and a real
differentiator (the official M2M contract plus a budget that fails closed), but its own product
line is currently one aggregate that cannot answer the charging question, a planner that can be
confidently wrong, and an analytics layer that most users cannot turn on. The candidates below are
scored on that basis: user value first, differentiation against the app and other MCP servers
second, evidence quality third.

## 1. Scored candidates

Scores are 1 to 5. Value is whether an owner or operator would act on the answer. Differentiation
is against the Polestar app and the comparable MCP servers D documents. Evidence is whether the
owning report reproduced the failure with a command or measured number. Verdict is keep, merge
(naming the ids it folds into), kill, or needs-evidence.

| id | candidate | value | diff | evid | verdict | reason |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Structured results and per-tool schemas | 2 | 2 | 5 | merge A1 | Client developers need it, owners do not: only 1 of 23 tools carries `data` by default (A:226-228); one envelope rewrite covers E1, E2, E3. |
| A2 | Summary and unit coverage against descriptions | 3 | 2 | 5 | keep | 11 of 15 descriptions promise fields the prose omits (A:337-342), and `docs/tools-reference.md:54-67` repeats the promise; scope it to fields a user acts on. |
| A3 | Per-domain freshness in aggregates and advisor | 4 | 3 | 5 | keep | `get_car_status` prints the newest age and hides a 400-day stale health domain (A:334); the planner uses a 56-day window with no age (A:335). |
| A4 | Prompt surface that matches the server | 3 | 1 | 5 | keep | `battery-health-report` names two tools unregistered on a default start (A:343-347); a user cannot debug that from outside. |
| A5 | Redaction-consistent resource identity | 3 | 1 | 5 | keep | With redaction on, resource URIs and completions still return the full VIN (A:348-355); the promise in `README.md:170` is broken. |
| A6 | Aggregate resource and honest listing | 2 | 1 | 5 | merge A5, D9 | No owner reads a briefing as a resource; the silent empty list (A:356-360) belongs to A5 and the 10-VIN cap (A:246-248) to D9. |
| A7 | Elicitation for planning inputs | 3 | 2 | 4 | merge B1 | The capacity question is better answered by a fallback chain (B:140); ask only when every source is empty. |
| A8 | Domain availability matrix | 3 | 3 | 4 | merge C3 | Answers "which domains can this car report" before 15 failed reads (A:361-365); negative caching makes the answer stop costing quota. |
| B1 | Capacity fallback chain for estimate and plan | 5 | 3 | 5 | keep | The headline question has no number on the reference car (B:41-42, B:62); the fixture arithmetic yields 65.7 kWh (B:35). |
| B2 | Charging energy and cost ledger | 5 | 5 | 3 | keep | Cost is exactly where the app is weak; sessions carry no energy and prices are never stored (B:63, B:107). |
| B3 | Departure readiness from the climate timer | 4 | 4 | 3 | keep | Joins two facts the server already reads but never combines (B:66); the app has timers, not a readiness check. |
| B4 | Battery health trend with confidence bounds | 4 | 5 | 3 | keep | The classic long-lived question; today's report is first-to-last with no interval, span gate or outlier rule (B:68, B:105). |
| B5 | Warning transition detector on health | 2 | 2 | 4 | kill | Marginal value over `get_needs_attention` is timing only (B:216), and it costs 144 calls a day (B:210); a 10-minute cadence misses the event. |
| B6 | Trip and odometer reconstruction | 3 | 2 | 4 | merge B8 | The car already reports trip meters (`src/format.ts:160-164`); a weekly distance is one digest line, not a tool. |
| B7 | Cross-domain timeline and typed history query | 3 | 2 | 3 | keep | The substrate for B2, B4 and B8 (B:186); "what happened yesterday" only exists with history and sampling on (B:64). |
| B8 | Weekly digest | 4 | 4 | 3 | keep | The recurring surface the app lacks, but it is a composition of B2, B4 and B10 (B:130, B:250), not a first build. |
| B9 | Service due forecast | 2 | 2 | 4 | merge B8 | The app already shows the service countdown (`docs/tools-reference.md:74`); extrapolation is one digest line. |
| B10 | Settings change and confirmation timeline | 3 | 3 | 4 | keep | Pending versus applied is already in the payload and diffed (`src/format.ts:210-217`); the confirmation history is new. |
| B11 | Geofence arrival and departure | 2 | 3 | 3 | kill | A request-driven server cannot tell anyone when (B:246), and location history is the most sensitive store it holds (B:264). |
| B12 | Multi-vehicle comparison | 2 | 2 | 2 | merge D9 | The owner has one car (B:276), a health comparison has no spec denominator (B:272), and the fixture cannot run it (B:274). |
| C1 | Decouple metering and retry from the cache toggle | 2 | 1 | 5 | keep | A performance flag removes the fail-closed budget (C:9-13, C:236-242); a defect, and a gate for trusting anything else. |
| C2 | Persistent credential-scoped budget ledger | 2 | 1 | 4 | kill | Main user is an operator in a multi-process deployment the product does not have; the lead already defers durable state (lead:185-187). |
| C3 | Negative caching for absent domains | 2 | 1 | 5 | merge A8 | An absent domain spends a live call every time (C:255-258); a short negative TTL is the mechanism A8 needs. |
| C4 | Operable packaging and publish gate | 2 | 1 | 4 | merge D1 | Only the version-consistency gate has a user; the health endpoint is for an image nothing builds (C:95-100). |
| C5 | Host and Origin guards for HTTP mode | 2 | 1 | 5 | keep | A loopback server answers an attacker Origin with the full tool list (C:250-254); it protects the owner's data. |
| C6 | Structured stderr log and debug level | 1 | 1 | 5 | kill | Main user is a developer debugging a laptop server (C:124-131); no user question, and the server is not hosted. |
| C7 | Cancellation-aware reads | 2 | 1 | 4 | kill | Saves quota when a chat request is cancelled; invisible to the user and not a reason to use the product. |
| C8 | Retry policy hardening | 2 | 1 | 5 | keep | A Wi-Fi blip fails a call, and an HTTP-date `Retry-After` retried 29.5 s early (C:173-175); cheap reliability. |
| C9 | Bound local store growth and staleness | 3 | 2 | 4 | merge A3, B7 | A stale cache served as current is a trust defect (A3's half); the 64 MiB read cliff is history foundation (B:89). |
| C10 | Subscription lifecycle hardening | 2 | 1 | 5 | keep | A typo'd URI polls every 60 s and a failed notify loses the change (C:259-261); subscriber-only, but cheap and real. |
| C11 | Serve the modern MCP revision | 1 | 1 | 4 | kill | Main user is a future client developer; current clients still work by backward compatibility (C:265-268). |
| C12 | Fleet mode with several credentials | 2 | 2 | 3 | kill | Multi-credential fleet is a different product, and no evidence of a fleet user exists (D:146-149). |
| D1 | Real publish path (npm, registry, release) | 4 | 1 | 5 | keep | The npm name returns 404 and the registry has no entry (D:85-86); without this nobody can install anything. |
| D2 | Claude Desktop `.mcpb` bundle | 3 | 2 | 4 | keep | Single-click install with sensitive `user_config` (D:210-214); valuable after D1, not before. |
| D3 | Demo mode inside the published package | 4 | 2 | 5 | keep | The tarball excludes the demo dump (`package.json:45-52`) and the README demo command fails (E:21, E:27-33); first-run experience. |
| D4 | Reviewer pack for directories | 2 | 1 | 4 | merge D1 | A directory artifact, not owner value; it belongs to the publish program (D:321-323). |
| D5 | Protocol conformance to 2026-07-28 | 1 | 1 | 4 | kill | Duplicate of C11; generic conformance work with the developer as its main user (D:304-309). |
| D6 | Metadata pass for tool search and review | 2 | 1 | 5 | merge E7 | Overlaps vocabulary and routing work; deterministic order and the 4,096-byte instruction check are hygiene (D:342). |
| D7 | Spot-price provider behind the planner | 3 | 2 | 3 | kill | The data is already covered by many price servers (D:135) and egress breaks the offline claim (`SECURITY.md:50`); the residue is E6. |
| D8 | One MCP Apps chart | 3 | 4 | 3 | needs-evidence | A chart is where comparable servers win (D:310-313), but it needs history on, client support and a probe before it is a promise. |
| D9 | Fleet story and multi-vehicle read | 3 | 2 | 4 | keep | Multi-car read plus the unverified portal pricing (D:179-195, D:390-392); the P0-1 cache identity defect must land first (lead:72). |
| D10 | Self-hosted remote connector with OAuth | 2 | 2 | 3 | kill | Reachability is not a user question, and it changes the trust boundary and the per-vehicle, per-scope cost model (D:179-188). |
| E1 | Share one output schema | 1 | 1 | 5 | merge A1 | 51.8% of `tools/list` is one schema repeated 26 times (E:51); a cost fix inside the A1 envelope rewrite. |
| E2 | Move endpoint and scope out of descriptions | 2 | 1 | 5 | merge A1 | 1,394 bytes of route and scope prose the model never calls (E:61); trim it with A1. |
| E3 | Send the result text once | 2 | 1 | 5 | merge A1 | 44.3% duplicated payload over 20 calls (E:95); one envelope rewrite covers A1 and E1. |
| E4 | Time-to-full and target SoC in `get_car_status` | 5 | 3 | 5 | merge B1 | The instructions rank `get_car_status` first (`src/server.ts:208-211`), and it omits time-to-full and target SoC (`src/aggregate-tools.ts:78-86`). |
| E5 | Stop promising an estimate that is not shown | 4 | 1 | 5 | merge B1, E4 | A 180-byte answer promises the car's estimate and prints nothing (E:152-162); same charging-answer fix as E4. |
| E6 | Reject or flag prices outside the window | 4 | 2 | 5 | keep | 24 valid prices outside the 48-hour window produce an `ok: true` feasible plan with `price unknown` (E:191-209). |
| E7 | Align surface vocabulary with user words | 3 | 1 | 5 | keep | The routing fixture fails q2, q3 and q4 (E:114-120); plugged, month, journey and tonight appear on zero tools (E:122-127). |
| E8 | Reject unknown arguments | 3 | 1 | 5 | keep | A misspelled `vin` is silently dropped and the default car is read (E:224); the wrong car's answer is worse than an error. |
| E9 | Name valid tools in an unknown-tool error | 2 | 1 | 5 | merge E8 | The unknown-tool error names no next step while in-band errors do (E:223); same input-error class as E8. |
| E10 | Make history cost visible and conditional | 3 | 1 | 5 | merge B4, A1 | History adds 5,877 bytes per session (E:80-82) and the refusal does not say how long accrual takes (E:263-264). |

Tally: 22 keep, 19 merge, 10 kill, 1 needs-evidence. Every one of the 52 candidates appears above
exactly once. The merges collapse to ten build items: the result envelope (A1, E1, E2, E3); the
charging answer (B1, E4, E5, A7); absence handling (A8, C3); history foundation (B7, C9's store
half); freshness (A3, C9's staleness half); the digest (B8, B6, B9, E10's message); the fleet read
(D9, B12); the resource surface fixes (A5, A6); routing and input errors (E7, D6, E8, E9); and the
publish program (D1, C4, D4).

## 2. Conflicts between reports and how this seat resolves them

1. **External price data.** D7 proposes a spot-price provider inside the planner, and calls it
   "the strongest product idea in the list" (D:352). B rejects any external tariff fetch
   (B:286), E rejects fetching prices inside `plan_cheapest_charge` (E:354-356), and A rejects
   embedding the lookup (A:517-519). Resolution: kill D7. The user problem is real, but the data
   is already served by many price servers (D:135), and the only third-party call this server
   makes is the token request (`SECURITY.md:50`). Keep the user problem and fix the failure that
   makes pasted prices unusable: E6, plus a description that names the accepted timestamp range
   (`src/advisor-tools.ts:12-14` currently describes a price shape and no window).

2. **More humanizer prose versus vocabulary work.** A2 says render what the description promises
   (A:417-426), while A's own counter-signal limits the work to the 30 data-bearing raw-only
   leaves because most are plumbing (A:419-426). E7 proposes description vocabulary work
   (E:322-324). Resolution: they are different layers and both land. Do not grow the humanized
   output to cover all 30 fields. Render the short list of fields a user would act on (time to full and
   target SoC in `get_car_status`, charge window offset, pending amp change, amp source and
   update age, service distance, speed as a number not `0`, price unit in the planner), and
   delete the other promises from `src/domains.ts` and `docs/tools-reference.md:54-67`. E7 is
   description text the model matches against, not output prose.

3. **Fleet and hosted modes.** C rejects hosted multi-tenant mode now (C:670-673) while C12
   proposes multi-credential fleet mode, D9 proposes a fleet story and D10 proposes a public
   OAuth endpoint. Resolution: kill D10 and C12 for this round; keep D9 only as the
   one-credential, multi-car read plus the fleet pricing documentation that is currently missing
   (D:317-320), with B12 merged into it and no health comparison. C's own rejection says hosted
   mode waits for C12 to exist (C:673), which makes an unapproved product a prerequisite for
   another unapproved product; this seat inverts that. The credible slice is a single owner with
   up to five cars on one credential, which the portal's free threshold already covers (D:183).

4. **Public OAuth endpoint versus the loopback posture.** D10 proposes a self-hosted public
   connector with OAuth 2.1 and RFC 9728 metadata. The repository's posture is loopback-first,
   with a non-loopback bind refused without a token (`README.md:175`, `SECURITY.md:68-72`), and
   C rejects OAuth protected-resource metadata as decoration until a hosted mode exists
   (C:651-654). Resolution: kill D10. A public endpoint that holds vehicle location and spends a
   per-vehicle, per-scope, per-month allowance (D:179-188) is a different product with a
   different trust boundary. D1 and D3 make the local product installable first.

5. **Small fixes versus the data foundation.** E1, E4 and E6 are small, and B says its
   analytics need a data foundation first; B7 is the substrate for B2, B4, B6, B8 and B10
   (B:186). Resolution: repair the question users ask today before extending the data. The
   charging-answer cluster (B1, E4, E5) and E6 come first; B3 comes next because it needs no
   history; B7 then lands as the substrate for B2, B4 and B8. B's own table contradicts its
   dependency claim: B2 is second (B:121-122) while its substrate B7 is fifth (B:125, B:186).
   This seat's order is B1, B3, B7, B2, B4, B8.

6. **Add typed data versus remove duplicate text.** A1 wants to add per-tool `data` and
   schemas (A:401-415); E3 wants to remove the duplicated `message` text (E:291-306); E2 wants
   to remove endpoint and scope prose (E:297-300). Resolution: one envelope rewrite does all
   three. Put a typed, populated `data` object on the default path; keep `message` only when it
   differs from the content text (`src/tool-output.ts:71-72` says `message` exists so content-only
   clients lose nothing); send the raw payload once; move endpoint and scope to `list_domains`.
   The measured envelope duplication is 44.3% over 20 calls and 59.1% for a raw call (E:95,
   E:103-106).

7. **The history clock.** B measures that every record's `observedAt` is the time the server read
   the value, 48 to 56 days after the payload's own `metaReceivedAt` (B:46), and cites
   `src/server.ts:110-111`. C's history section treats the store as sound apart from size and
   retention (C:195-207), and the lead report's reliability list does not include the clock. C
   and the lead are silent, not contradictory. Resolution: B is right; `store.append(...,
   { observedAt: Date.now() ... })` is the code (`src/server.ts:110-111`), and the value clock is
   a prerequisite for B2, B4, B7 and B8, whose own checks demand it (B:190, B:226, B:250).

8. **Persistent budget ledger.** C2 proposes a durable credential-scoped ledger; the lead
   report explicitly defers persisting the budget across restarts to a design note
   (lead:185-187). Resolution: kill C2 for this round. It is the first durable write path, its
   hard parts are lock recovery and fail-closed reads (C:341-348), and its main user is a
   multi-process operator the product does not have yet. A restart still resets the count, but
   the 429 is visible and honest, which is the current contract.

## 3. Gaps the 52 candidates miss, seen from the product lens

These are product questions, not new engineering projects.

1. **Who is the user and what do they actually ask?** No report measures a real owner's
   questions. E's five questions are constructed by the analysis (E:112-120), and the only demand
   signal in the tree is 2 stars (D:146-149). Before building the long-lived cluster, the owner
   should write down ten questions asked by an actual Polestar driver. The 52 answer the
   questions this council imagined, not the ones a driver typed.

2. **What does the owner do after the answer?** The server is read-only by design, so every
   charging recommendation ends with the owner acting in the Polestar app; B3 says so itself
   (B:168). No candidate asks whether the answer should hand the user the exact screen and value
   to change, or whether advice without a link or a checklist is enough. That is a product
   decision the candidates assume away.

3. **How does the owner supply the price curve?** B2 and `plan_cheapest_charge` depend on an
   hourly curve (`src/advisor-tools.ts:12-14`), and B already notes that a fixed-price contract
   makes "savings" meaningless (B:156). Once D7 is rejected, no candidate asks where the curve
   comes from or how many target users are on hourly prices. The cost story is the strongest
   differentiator and its input is unexamined.

4. **What is the recurring reason to come back?** Nothing in the server runs when nobody asks:
   the sampler is not a scheduler (B:246), and B8 is a prompt the client runs. No candidate asks
   whether the monthly digest should be read in chat, written to a file, or delivered by an
   external scheduler, and none measures whether a user would return for it. MCP has no push, so
   this is a channel question before it is a feature.

5. **What does the Data Portal credential cost the owner?** D found a published pricing route
   (per vehicle, per scope, per calendar month, free up to five vehicles) but could not verify
   that it applies to M2M credentials (D:179-195, D:390-392). No candidate documents the owner's
   cost, and D1's install story does not mention it. Adoption depends on the answer.

6. **Which locale and timezone does the user see?** The repository is English with km and mi
   (`README.md:202-210`), the portal is Swedish-localised (D:162-169), and the charge window is
   printed without its offset (A:135-138). No candidate asks whether times should be rendered in
   the user's local zone, which matters most for the two features that are about time (B1, B3).

## 4. Top five, ordered

The five are all kept candidates. Each names the user question, the first check that can fail,
and the defects that must be fixed first. Prerequisite zero is separate: D1 and D3 are not
features, but nothing below is reachable without them.

**1. B1, with E4, E5 and A7: one charging answer.** Pitch: "Ask when the car will be charged and
get an energy figure and a time, or a plain 'not charging', without knowing your battery size."
First falsifiable check: on the shipped fixture, `get_car_status` must answer the question in one
call (target SoC plus a completion time, or an explicit "not charging"), and
`get_charging_estimate` must state 18.4 kWh to 80 percent and 1.33 h at 13.8 kW (3 phase) or
4.00 h at 4.6 kW (1 phase), and 52 percent must imply 65.7 kWh plus or minus 1; the unplugged
fixture must say not charging and must never print "showing the car's own estimate instead"
without a following figure; a null target must state that 80 was assumed (B:121, B:142,
E:283-284). Fix first: the phase and voltage convention (lead:109; the model assumes 230 V per
phase, `src/charge-model.ts:11`, and 3 phases by default, `src/aggregate-tools.ts:166`), the
no-data sentence (lead:75), and the charge-window offset if the answer names the window
(A:135-138). Do not label the car's own estimate "to 100%"
(`src/aggregate-tools.ts:191`) while its relation to the configured target is unestablished
(B:95).

**2. B3: departure readiness.** Pitch: "Ask whether the car will be warm and charged by Sunday at
14:00 and get a yes or no with the deadline that makes it true." First falsifiable check: with an
injected clock at Tuesday 10:00, a Sunday 14:00 climate timer and a 23:00 to 06:00 charge window
must produce a Sunday 06:00 charge deadline; 18.4 kWh must fit the 7-hour window; either timer
inactive must produce the sentence that the car will not do this on its own; a one-shot timer
with no date must be refused rather than guessed (B:123, B:166). Fix first: B1's power and
capacity, the window offset (A:135-138), and the read-only caveat that this is advice (B:168).

**3. B2: charging cost ledger.** Pitch: "Ask what charging cost last month and whether the cheap
hours actually saved money, and get a figure with the assumptions behind it." First falsifiable
check: a 40 to 70 percent session on a 65.71 kWh pack must yield 19.7 kWh plus or minus 0.2; a
session crossing a price boundary must split at the hour; no prices must mean no cost claim rather
than zero cost; savings against the stated baseline must equal the arithmetic difference and be
zero at the baseline price (B:122, B:154). Fix first: B7's typed history and the value clock
(B:46, B:186), B1's capacity, history and sampling on (B:64), the retention bound (B:89), and the
two-energy-method comparison as the confidence signal (B:152).

**4. B4: battery health trend.** Pitch: "Ask whether the battery is losing range and by how much
per year, and get an interval, or a refusal when there is not enough data." First falsifiable
check: a synthetic 12-month series with a 2 km/month slope and 5 km noise must produce an interval
that contains 2 and excludes 0; a span under 90 days, 6 samples in one hour, or SoC under 20
percent must be refused or excluded with the reason (B:124, B:176, B:178). Fix first: the value
clock (B:46), 90 or more days of history with sampling on (B:64), and the seasonality and
temperature caveat named in the answer (B:180). Claim a capacity trend only when
`dischargeInfo.energyAvailable` is present.

**5. B8: weekly digest.** Pitch: "Ask what changed this week and get one short list: distance
driven, charging cost, any warning, any settings change." First falsifiable check: a synthetic
7-day store must name each changed item once; an empty store must say no history was recorded
rather than that nothing happened; a settings value last updated 88 days ago must not be reported
as a change in the window (B:130, B:250). Fix first: B2, B4, B7 and B10, plus the value clock and
the five-field filter (`src/history-tools.ts:80-81`); B6 and B9 arrive as one line each. Do not
ship the digest before the items it composes, because a prose digest hides how few samples it
had (B:252).

Prerequisite zero: **D1 and D3.** The npm name returns 404 and the registry has no entry (D:85-86),
and the published package excludes the demo dump while `README.md:56` promises a demo that fails
on a clean checkout (E:21, E:27-33). D2 can follow D1; it is not first. Two cross-cutting fixes
gate the five: **E6** before any planner answer is presented as trustworthy, and **A3** because
every long-lived answer above must say how old each value is.

## 5. Dissent

- **Against A's ordering.** A ranks structured machine-readable data as the first missing thing
  (A:321-326) and puts A1 first in its candidate table (A:390-415). I disagree on product value:
  A1's main user is a client developer, and the owner never notices it. A2 and A3 (truthful
  answers and freshness) matter more to a user, and A1 should be one envelope item merged with
  E1, E2 and E3, not the headline. A's rejected ideas (writes, consumer-app data, a second
  history path, renames) are sound.

- **Against B's ordering.** B's table order is B1, B2, B3, B4, B7 (B:119-132), and B says the
  order is also dependency order. It is not: B2 depends on B7, which B itself says should land
  before B2 (B:186), and B2 is second while B7 is fifth. My order is B1, B3, B7, B2, B4, B8,
  because B3 needs no history and is cheaper and more differentiated than the ledger. I agree
  with B's substance and with all of its rejected ideas.

- **Against C's headline.** C's dominant finding is C1, the cache toggle removing the budget
  meter (C:9-13). I agree it is a defect and a release gate, but it is not a product feature:
  C's candidate list contains no user question, so it cannot rank a build order for an owner.
  The product seat treats C1, C5, C8 and C10 as defects to fix alongside, not as reasons to use
  the product.

- **Against D's top three.** D ranks D1, D2, D3 by adoption leverage (D:348-356). D1 is a
  prerequisite rather than a feature, and within the three D3 should precede D2: D3 fixes a claim
  that is already false (E:21, E:27-33) at S effort, while D2 is M effort and only helps Claude
  Desktop users. I also dissent from D's claim that D7 is the strongest product idea (D:352):
  the price curve is a supply problem the assistant can already solve with another server, and
  E6 is the part that actually protects the user.

- **Against E's table order.** E lists E1, E2 and E3 first (E:278-290), but its own measured
  worst friction is the charging answer (E:481-484) and its "What is missing" ranks that question
  first (E:250-254). The token economy is a cost, not a user question. E4, E5, E6 and E7 should
  lead. I also disagree with E3 as written: removing `structuredContent.message` outright
  conflicts with the stated reason it exists (`src/tool-output.ts:71-72`); keep it only when it
  differs from the content text.

## 6. Hygiene

`node docs/check-docs.mjs hygiene` exits 1 in this working tree, and every failing path is outside
this task's write scope, under `analysis/correctness/`:

- `EMDASH_CHECK_FAILED`: `analysis/correctness/findings.md` lines 1, 43, 71, 87, 113, 126, 159,
  183, 191, 222, 235, 245, 268, 278, 308, 337, 339, 356, 364, 382, 390, 413, 430, 438, 456, 464,
  491, 513, 533, 561, 578, 588 to 599, 604, 612, 623 to 627, 629.
- `CONNECTOR_CHECK_FAILED`: `analysis/correctness/findings.md` lines 185, 216, 432, 466, 485.
- `BANNER_CHECK_FAILED`: `analysis/correctness/probe-budget-window.ts` lines 12, 26;
  `probe-cache-clean.ts` lines 17, 30, 48, 61; `probe-history.ts` lines 19, 49, 65;
  `probe-status.ts` lines 17, 55; `probe-subscriptions.ts` lines 13, 41.

The buzzword detector is clean tree-wide (`HYGIENE_BUZZWORDS_CLEAN`). This file was scanned with
the same four detectors and reports em dash 0, spaced en dash 0, buzzword 0, spaced-hyphen
connector 0, banner 0 (the banner rule applies only to `.ts`, `.js`, `.mjs`, `.cjs` and `.py`),
and it is pure ASCII. The tree-wide check cannot reach `HYGIENE_CLEAN` until the correctness lane
removes its dashes and comment banners.
