# README prose audit

| Field | Value |
| --- | --- |
| File under review | `README.md` |
| Commit | `13e878e` ("Rewrite the README for clarity and completeness") |
| Size | 341 lines, 3,733 words |
| Reviewer | readme-prose |
| Date | 2026-11-09 |
| Method | `avoid-ai-writing` skill, detect mode, `docs` context profile |
| Writes | This report only. `README.md` was not edited. No live API calls. |

## Verdict

The vocabulary and the punctuation are clean. The tells that remain are structural: one
uniformly parallel list, one six-item clause pasted verbatim into three places, and five
table rows that restate rows from another table.

- P0: 0
- P1: 3 clear problems
- P2: 11 (5 clear, 6 judgment calls)
- Proposed rewrites: 8, in section 9

The voice is neutral documentation prose and the sentence-length variation is good. A
rewrite should fix the three P1 items and stop. The rest of this report exists so the Lead
can see what was checked and left alone, not so everything gets rewritten.

## 1. Method

I ran the `avoid-ai-writing` skill in detect mode with the `docs` context profile (README
structure triggers that profile automatically). The profile relaxes several rules for
documentation: em dashes, bold density, hedging, copula avoidance, subjectless fragments.
I applied the user's full checklist anyway and report where the profile would have relaxed
a finding. Two rules are stricter than either the skill or the profile, because this
repository enforces them tree-wide: zero em dashes and a banned-word list in
`docs/check-docs.mjs`.

Mechanical scans, all read-only:

- dash characters (U+2014, spaced U+2013, spaced hyphen), curly quotes
- Tier 1A, Tier 1B, Tier 2 and Tier 3 vocabulary, case-insensitive with inflections
- bold runs, heading case, emoji in headings, inline-header lists, list-label periods
- sentence and paragraph length distribution over prose only (tables, fences and HTML
  stripped)
- repeated 5-grams across the whole document, to find claims stated twice
- counts of comma triads, colon glosses and semicolon joins
- passive predicates and short paragraph-opening sentences, then a manual read of each
- type-token ratio over the prose

## 2. Gate evidence

Run from the repository root at `13e878e`:

| Command | Result |
| --- | --- |
| `node docs/check-docs.mjs hygiene` | `HYGIENE_NO_EM_DASH`, `HYGIENE_BUZZWORDS_CLEAN`, `HYGIENE_NO_BANNERS`, `HYGIENE_NO_DASH_CONNECTORS`, `HYGIENE_CLEAN` |
| `node docs/check-docs.mjs links` | `DOCS_LINKS_OK` |
| `npm run check-secrets` | `SECRETS_CLEAN` |

What these prove: no em dash or spaced en dash anywhere in the tree, none of the banned
words, no decorative banner comments, no hyphen used as an aside, every local markdown
link and anchor resolves, and no credential, VIN, email, phone number or coordinate in
any scanned file. Each negative check carries a positive control, so a green run means the
detector fired rather than that it was blind.

What they do not prove: anything about rhythm, repetition, sentence construction or voice.
A document can pass all three gates and still read as assembled. That gap is what the rest
of this report covers.

## 3. P0, credibility killers

None found.

Checked for and not present: cutoff disclaimers, chatbot artifacts, sycophantic openers,
"let's" transitions, vague attributions ("experts believe"), significance inflation,
generic future-narrative closers, hashtag blocks, AI-referrer URL parameters, citation
markup leaks, unfilled placeholders, and unearned emotional claims.

## 4. P1, clear problems

### P1-1. The 53-word test list is five identical "A and B" pairs (line 302)

Quote:

> The suite covers the cases that are easy to get wrong in this server: token single-flight
> and expiry skew, envelope unwrapping and identity checks, VIN resolution and delegation,
> cache TTLs and stale-while-revalidate, retry and budget metering, the charge-window
> planner including windows that wrap midnight, history dedup and session reconstruction,
> and the configuration registry.

Problem: five consecutive items share the exact shape "noun phrase and noun phrase". The
sixth breaks shape, then the seventh returns to a pair. This is the clearest passage where
the structure, not the wording, gives it away. It is also the longest sentence in the file
at 53 words, which makes the pattern the reader's main impression of the paragraph.

Why P1: uniform sentence construction is the strongest detection signal in the skill's
catalog, and this is the clearest instance in the README. The content is good; only the
shape is wrong.

Fix: rewrite R1.

### P1-2. The briefing field list appears verbatim three times (lines 19, 110, 164)

Quotes:

> line 19: one short briefing: charge, range, locks, availability, odometer, service
> countdown, and the age of each value.

> line 110: One briefing: charge, range, locks, availability, odometer, service countdown,
> data ages

> line 164: One-call briefing: charge, range, locks, availability, odometer, service, ages

Problem: the same six fields, in the same order, with the same "briefing:" preface, appear
three times in 145 lines. The 5-gram scan flags the whole run
`charge, range, locks, availability, odometer, service` at all three lines. Each occurrence
is individually fine; together they read as a paragraph reused rather than written.

Why P1: it is visible on a first read, it makes the document feel assembled from parts, and
the fix is cheap.

Fix: keep the full list once, in the prose at line 19 where a reader meets it first. Leave
line 110 as the table's terse version. Rewrite line 164 so it describes the call instead of
repeating the fields. See rewrite R2.

### P1-3. Five rows of "The tools" restate rows of "What you can ask" (lines 110-117 and 164-168)

Pairs, with the duplicated span:

| Ask table | Tools table | Duplicated words |
| --- | --- | --- |
| 110 `get_car_status` | 164 `get_car_status` | "charge, range, locks, availability, odometer, service" |
| 111 `is_car_secure` | 165 `is_car_secure` | "verdict that names anything open" |
| 112 `get_needs_attention` | 166 `get_needs_attention` | "warnings only, plus the service countdown" |
| 113 `get_charging_estimate` | 167 `get_charging_estimate` | "energy and time to" |
| 117 `get_charging_setup` | 168 `get_charging_setup` | "the seven charging settings in one" |

Problem: the two tables have different jobs. The ask table answers "what do I get for this
question". The tools table is the inventory. Five of the twelve ask rows describe the same
result in almost the same words as the reference row, so the reference section opens with
material the reader has already read.

Why P1: the 5-gram evidence is unambiguous, and duplication of this density is the main
reason the README reads longer than its content. It also makes the document harder to
maintain: a change to one description leaves the other stale.

Fix: shorten the five cells in the tools table so they name the call, not the answer. Row
165 is the one that cannot be honestly differentiated without a fact the README does not
state, so keep its wording or merge it into the ask table. See rewrite R3.

## 5. P2, clear problems

### P2-1. The description and the client list are each stated twice before the body (lines 5, 7, 19, 46)

Quotes:

> line 5: Read-only MCP server for the Polestar Data Portal M2M API.

> line 7: A [Model Context Protocol](https://modelcontextprotocol.io) server for the
> [Polestar Data Portal M2M API](https://data-portal.polestar.com), built for any MCP
> client: Claude Desktop, ZCode, Cursor, or your own tooling.

> line 46: An MCP client that can launch a stdio server, such as Claude Desktop, ZCode,
> Cursor, or your own.

Problem: lines 5, 7 and 19 each state the same relationship at slightly different length.
The client list at line 7 returns word for word at line 46. Tagline-then-description is a
normal README convention, so the first repeat is defensible. The second is not: the
requirements bullet does not need the names again.

Fix: drop the examples from line 46. See rewrite R7.

### P2-2. An agentless passive hides how recording actually starts (line 220)

Quote:

> Set `POLESTAR_HISTORY_DIR` and each live domain answer is appended to a JSONL file,
> deduplicated by `metaEventId`; an unchanged snapshot costs one line.

Problem: the sentence never says who appends, and the thing the reader needs to know is
that the server writes on every live call, without any extra step. The passive turns a
causal fact into a state. The semicolon join also packs a second fact into a sentence that
already has one.

Fix: name the actor and split the join. See rewrite R4.

### P2-3. "how it is named" has no clear referent (line 222)

Quote:

> These variables control what leaves the car and how it is named:

Problem: "it" can attach to "what leaves the car" or to "the car". The table below is about
vehicle labels and VIN redaction, so the intended meaning is how the data is labelled in
answers. As written, a reader can briefly think the sentence promises to rename the vehicle.

Fix: rewrite R5.

### P2-4. Two paragraphs in the resources and prompts section open with passives (lines 189, 193)

Quotes:

> line 189: Resources are exposed at `polestar://vehicle/{vin}/{telemetry|charging}/{domain}`.

> line 193: Two prompts are registered on a default start, `car-status` and `charge-plan`.

Problem: both sentences hide the server as the actor, and "on a default start" is an
unusual way to say "by default". The phrase also appears at line 23. In a section that is
otherwise direct about what works and what does not, these two openers are the vaguest
sentences in it.

Fix: rewrite R6. The docs profile would tolerate these passives; they are reported as
clarity, not as authorship evidence.

### P2-5. Double conjunction in the result-shape paragraph (line 123)

Quote:

> The header names the vehicle and domain and says how old the data is.

Problem: two "and"s in a ten-word sentence, with the second joining a clause to a pair.
A comma and a stronger verb fix it.

Fix: rewrite R8.

## 6. P2, judgment calls

These are flagged so the Lead can see them, not because they all need changing. Four of the
six should be left alone.

### J1. Colon glosses and semicolon joins are the dominant sentence join (15 and 13 of 113 sentences)

A colon carries the second half of the sentence 15 times, for example lines 67, 98, 185, 230,
236 and 333. Semicolons join independent clauses in 13, for example lines 98, 123, 136, 214,
234 and 335. Seven more sentences use a comma-"which" relative clause (lines 23, 67, 138,
145, 191, 227 and 333).

Assessment: this is a house style, not a defect. The repository bans em dashes, and the
colon gloss is a legitimate replacement. But it is the dominant repeated syntactic move in a
document whose sentence lengths otherwise vary well, so the prose stays slightly predictable
at paragraph level even when the sentence count changes. The rewrites below split two of
these joins (R1, R4). Do not chase the rest.

### J2. Roughly ten comma triads, most of them genuine enumerations

Examples: "budget, cache, and token state" (line 214), "tools, resources, and prompts"
(line 234), "cache, budget, and history" (line 234), "checks, packs, and publishes"
(line 335). The rest enumerate three real things (three Node versions, three config
behaviours) and are not padding.

Assessment: mostly leave. The two triads in one paragraph at line 234 are the pair worth
varying, because they sit four sentences apart and have the same shape. Replacing one with
two items or four is enough.

### J3. Eight paragraphs open with a short declarative (lines 138, 189, 191, 210, 214, 216, 236, 242)

Examples: "Argument names are strict." (4 words), "The budget fails closed." (4), "Tokens
are cached." (3), "All configuration is environment-only." (4). Five of the eight are
passive or copula.

Assessment: leave. This is the writer's signature, and it works: the short opener states
the topic and the paragraph explains it. The skill warns that maximum strictness produces
the uniformity it is meant to remove. Flattening these into longer sentences would make the
document worse, not more human.

### J4. "One detail trips people up:" is a mild setup-and-reveal hook (line 98)

Quote: "One detail trips people up: the portal gives you two identifiers."

Assessment: borderline. It pre-announces a gotcha, which is the shape of the "The catch?"
family, but the paragraph then delivers a real gotcha with a real error code
(`403 AUTHZ_CLIENT_ID_MISMATCH`). If the Lead wants it gone: "The portal gives you two
identifiers, and mixing them up fails every request." Otherwise leave it.

### J5. Compressed participial tails (lines 53, 175, 210)

Examples: "token flow included" (line 53), "with a 95% interval once the span allows it"
(line 175), "marked stale" (line 210).

Assessment: leave. Terse compression is the correct register for a README, and each of
these carries information rather than decorating a sentence. This is the docs carve-out,
not the tailing-negation tell.

### J6. One section is under-written and the tool surface is over-covered

"Check the connection" (lines 102 to 104) names two tools and gives no success signal. The
offline path (lines 51 to 67) is documented far more carefully: it prints `DUMP_OK`, it
documents the auth failure, and it explains `NOT_FOUND`. A first live run deserves the same
precision. The facts already exist in the document (line 132 says a live answer carries your
own labels and numbers, and lines 126 to 130 show the briefing shape), so this is a
one-sentence addition, not new research.

The over-coverage is the structural cause of P1-2 and P1-3: the tool surface is described
three times, at lines 19, 108 to 121 and 140 to 183. Fixing the duplicates is enough. Do not
add a fourth description.

## 7. Checked and clean

Counts, so the Lead can see the audit ran rather than skipped these.

| Rule | Result |
| --- | --- |
| Em dashes and spaced en dashes | 0. The hyphens in `---` table separators and in `--version` / `--help` are not prose dashes |
| Bold in body prose | 0. Six bold runs, all category labels in the tools table (lines 142, 146, 155, 163, 171, 173), which is correct for a reference table |
| Emoji in headings | 0. The five shields.io images at the top are badges, not prose |
| Curly quotes and apostrophes | 0. All straight |
| Title-case headings | 0 of 19. Every heading is sentence case |
| Inline-header lists | 0 |
| List-label periods | 0 |
| Chatbot artifacts, sycophancy, "let's" openers | 0 |
| Significance inflation | 0 |
| Transition phrases (Moreover, Furthermore, Additionally, In conclusion) | 0 |
| Generic conclusions | 0 |
| Vague attributions | 0 |
| Tier 1A vocabulary | 0 |
| Tier 1B clarity words (utilize, in order to, serves as, features) | 0 |
| Tier 2 vocabulary | 0 clusters. One single hit ("quietly", line 138), literal, explained below |
| "Real/actual" adjective inflation | 0. The one candidate (line 100) names its contrast, so the carve-out applies |
| Tier 3 density | 0 |
| "Not X but Y" reveal constructions | 0. See below |
| Subjectless fragments in flowing prose | 0. The imperatives in the quick start are the correct register |
| Hashtags, AI-referrer URL parameters, citation markup | 0 |

Two word-list hits that are not tells:

- line 138, "instead of quietly reading the default car". The Tier 2 entry for "quietly" is
  the significance collocation ("quietly ambitious"). Here it is literal: the error is
  silent. Keep.
- line 100, "Real environment variables always win". The "real/actual" inflation rule has a
  carve-out when the contrast is named. The same sentence names it ("instead of the secrets
  file"). Keep.

Eight "rather than" and "instead of" constructions (lines 67, 100, 138, 191, 214, 236, 256,
260) are all honest contrasts, not the reveal pattern. The one negative appositive, line 123
"failures, not successes, use `structuredContent.message`", is precise and should stay.

## 8. Voice assessment

**Is this neutral docs voice?** Yes, consistently. No first person, no "we", no marketing
adjectives, no exclamation, no rhetorical questions. Second person appears only where the
reader acts, and imperatives appear only in instructions. The document takes positions
("The API is read-only, and so is this server") and backs them with a mechanism, which is
docs voice doing its job rather than the flat neutrality the skill flags.

**Does rhythm vary?** In length, yes. Over 113 prose sentences: mean 15.0 words, standard
deviation 9.3, range 3 to 53. The spread is real, not cosmetic: 28 sentences run 8 words or
fewer, 42 run 9 to 14, 21 run 21 to 28, and 3 run 41 or more. Paragraphs run 2 to 94 words
with a mean of 41.9. This is the opposite of the metronomic profile the skill warns about.

The variation is in sentence length, not in sentence joinery. The colon gloss, the semicolon
join and the comma-"which" clause are the three ways the long sentences are built, and one
of the three appears in 30 of the 113 prose sentences. That is why the prose can have a
healthy length spread and still feel slightly predictable at paragraph level.

**Does any passage read as generated?** Three do, and all three are assembly artifacts
rather than vocabulary artifacts: the test list at line 302, the duplicated table rows at
lines 164 to 168, and the field list at lines 110 and 164. The rest reads like a person who
knows the system, because it carries specifics a model would have to be handed: the
`403 AUTHZ_CLIENT_ID_MISMATCH` failure, the 10,000-call budget, the 90 and 80 percent
poller thresholds, the five-minute token skew, the `0600` and `0700` modes, and the
protocol behaviours that differ between stdio and HTTP.

**Do any claims repeat?** Six groups, found by 5-gram scan:

- the briefing field list, three times (lines 19, 110, 164)
- five tools-table rows (see P1-3)
- the client list, twice (lines 7, 46)
- "masks VINs in rendered output", twice (lines 227, 268), once in each config table
- "blocked on the CLI and a desktop host", twice (lines 329, 335)
- the 26 and 36 tool counts, five times (lines 11, 23, 201, 238, 320)

The count repetition is all doing work: a badge, an opening summary, a diagram label, the
statement at line 238 that both protocol eras expose the same surface, and a reference
table. The VIN-mask and bundle-blocked repeats are each a table row plus prose, which is
conventional. I would leave every one of these.

Type-token ratio over the prose is 0.406 on 1,592 tokens. That is just above the skill's
0.40 threshold, and the cause is topic compression rather than a vocabulary loop: "server"
appears 16 times, "every" 13, and "request", "budget" and "domain" 9 each. The skill's own
guidance is not to thesaurus this. The repetition of technical nouns is correct here.

**Subjectless fragments and agentless passives.** No subjectless fragments in flowing
prose. There are 24 passive predicates in the prose. Most are idiomatic documentation, where
the actor is the server and is obvious from context ("requests are refused", "the store is
owner-only"). One hides a fact the reader needs (line 220). Two more are worth changing
because they pair with a vague phrase (lines 189, 193). The docs profile would skip this
category entirely; the three reported findings are clarity, not evidence about authorship.

**Over-polished or under-written?** Nothing is purple, and no section is overwritten in the
inflationary sense. The over-coverage is structural: the tool surface gets three passes,
which is where the duplication comes from. Under-written: "Check the connection" (see J6).

**The risk in rewriting this.** The short declarative openers and plain verbs are the
document's voice. The skill's own warning applies with force here: applying every rule at
maximum strictness produces the uniformity the audit is trying to remove. Fix the three P1
items, take the two passive fixes, and stop.

## 9. The eight rewrites

Only the passages that need changing. Every rewrite keeps the facts of the original and adds
none.

### R1. Line 302, the test list

Before:

> The suite runs on Node 20.11, 22, and 24 in CI. The suite covers the cases that are easy
> to get wrong in this server: token single-flight and expiry skew, envelope unwrapping and
> identity checks, VIN resolution and delegation, cache TTLs and stale-while-revalidate,
> retry and budget metering, the charge-window planner including windows that wrap midnight,
> history dedup and session reconstruction, and the configuration registry.

After:

> The suite runs on Node 20.11, 22, and 24 in CI. It covers the cases that are easy to get
> wrong in this server. Token single-flight, cache TTLs, envelope unwrapping, VIN
> resolution, retry and budget metering, and the configuration registry each have direct
> tests. So do the harder edges: expiry skew, identity checks, delegation,
> stale-while-revalidate, the charge-window planner including windows that wrap midnight,
> and history dedup with session reconstruction.

Why: one 53-word sentence becomes three with different shapes. Every item survives. The pair
rhythm is gone because the items are regrouped by what kind of test they are, a distinction
the original already implies.

### R2. Line 164, the duplicated briefing row

Before:

```text
| `get_car_status` | One-call briefing: charge, range, locks, availability, odometer, service, ages |
```

After:

```text
| `get_car_status` | The briefing in one call: several domains at once, each value aged |
```

Why: the full field list now lives only at line 19. This cell says what makes the call
different, which is that it collapses several domain reads into one round trip. That fact is
already in the document at line 104 ("it reads several domains and reports their ages").

### R3. Lines 165 to 168, the other four duplicated rows

Before:

```text
| `is_car_secure` | Yes/no security verdict that names anything open |
| `get_needs_attention` | Active health warnings only, plus the service countdown |
| `get_charging_estimate` | Energy and time to reach the target SoC, assumptions stated |
| `get_charging_setup` | The seven charging settings in one call, each with its data age |
```

After:

```text
| `is_car_secure` | Yes/no security verdict that names anything open |
| `get_needs_attention` | Active warnings only |
| `get_charging_estimate` | Energy and time to target, assumptions shown |
| `get_charging_setup` | All seven settings at once, each aged |
```

Why: the ask table keeps the fuller sentence, the reference table keeps a label. Row 165 is
left alone because the README gives no second fact about the tool, so any rewording would be
cosmetic. Do not invent a detail to make it different.

### R4. Line 220, the hidden actor

Before:

> Set `POLESTAR_HISTORY_DIR` and each live domain answer is appended to a JSONL file,
> deduplicated by `metaEventId`; an unchanged snapshot costs one line.

After:

> Set `POLESTAR_HISTORY_DIR` and the server appends each live domain answer to a JSONL
> file, deduplicated by `metaEventId`. An unchanged snapshot costs one line.

Why: the reader learns that recording needs no extra step, which is the point of the
paragraph. The semicolon join becomes a full stop.

### R5. Line 222, the ambiguous referent

Before:

> These variables control what leaves the car and how it is named:

After:

> These variables control what leaves the car and how the answers label it:

Why: "the answers label it" resolves the referent to the data, which is what the table
actually configures.

### R6. Lines 189 and 193, the passive openers

Before:

> Resources are exposed at `polestar://vehicle/{vin}/{telemetry|charging}/{domain}`.

After:

> The server exposes resources at `polestar://vehicle/{vin}/{telemetry|charging}/{domain}`.

Before:

> Two prompts are registered on a default start, `car-status` and `charge-plan`.

After:

> The server ships two prompts, `car-status` and `charge-plan`.

Why: both sentences gain an actor, and the second loses the odd "on a default start". The
paragraph now opens with an active verb, like the rest of the section.

### R7. Line 46, the repeated client list

Before:

> An MCP client that can launch a stdio server, such as Claude Desktop, ZCode, Cursor, or
> your own.

After:

> An MCP client that can launch a stdio server.

Why: the names appear at line 7, where they belong. The requirements bullet only needs the
capability.

### R8. Line 123, the double conjunction

Before:

> The header names the vehicle and domain and says how old the data is.

After:

> The header names the vehicle and domain, and states the age of the data.

Why: the comma groups the pair, and "states the age" is one verb instead of "says how old".

## 10. Limits

- This audit covers prose. It does not check whether the claims are true; that belongs to
  the accuracy reviewer. Where I used a document fact in a rewrite (R2, R3), I cited the
  line it comes from.
- Severity is assigned against the skill's tiers, adjusted for a README. The `docs` profile
  is more permissive than the user's checklist, so I report both the profile's view and the
  applied finding.
- Stylometric signals are weak evidence and the skill says so. Nothing here should be read
  as a claim about who or what wrote the file. The 5-gram and length data are reproducible;
  the judgment calls are judgment.
- The shared `analysis/` tree is untracked, so the hygiene and links gates scan this report
  as well as the tracked files. That is why the report itself contains no em dash and no
  relative markdown links.
