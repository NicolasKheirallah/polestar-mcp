# Feature discovery brief: polestar-mcp

Working document for a five-agent deep dive and a three-seat council review. Every claim in
the area reports and the reviews has to be traceable to a file, a line, a command or a
measured number. Proposals that cannot be falsified are not proposals.

## The question

This repository is a read-only MCP server for the Polestar Data Portal M2M API. Version 0.3.0
ships 23 tools on every start, 26 with history enabled, 15 read Domains, 4 aggregate tools, one
charging advisor, one status tool, three history tools, resources with subscriptions, and three
prompts. The owner wants to know what to build next.

The answer must be a small set of features worth building, in order, each tied to a user
question and to something that can fail when the feature is wrong.

## What is known about the repo at the start of this exercise

- Node 22.23.2, npm 10.9.8. `npm test` passes 111 tests. The tree is clean except for the
  untracked `analysis/` directory.
- The upstream API is read only. It publishes no write endpoint for target state of charge,
  charge timers or climate. `POLESTAR_ENABLE_WRITES` registers nothing, and
  `test/posture.test.ts` protects that.
- The API returns latest known values only. Any longitudinal feature needs the local history
  store, which is opt-in behind `POLESTAR_HISTORY_DIR`.
- Rate limits are 10,000 calls per client per day and 100 per minute. The budget meter fails
  closed at the daily limit, the sampler stands down at 80 percent, subscriptions pause at 90
  percent.
- Credentials are one Polestar Account ID plus an OAuth client. A third-party credential may
  read a delegated account only if the operator allowlisted it.
- Fixture mode replays `test/fixtures/dump/` with no credential. The demo dump, the smoke
  scripts and every test run offline.
- `analysis/surface/capture.ts` is prior work: it spawns the real server over stdio in fixture
  mode and measures protocol bytes, tool description sizes, and result duplication. It writes
  only under `analysis/surface/evidence/`.

## House rules that constrain the proposals

- Every claim about behaviour needs something that can fail: a test, a probe or a CI check. A
  comment that describes protection nothing applies is a defect.
- Read-only by construction. A feature that needs a write endpoint waits for Polestar to
  publish one; see `docs/write-endpoints.md` for the safety design it would slot behind.
- The Domain registry in `src/domains.ts` is the one list of what exists. A new Domain is one
  row plus a fixture plus the doc count checks.
- Writing hygiene is enforced tree-wide by `node docs/check-docs.mjs hygiene`: no em dash or
  spaced en dash, no banned marketing words, no decorative comment banners, and no spaced
  hyphen used as dash punctuation in markdown prose. Untracked files count, so these analysis
  documents are scanned. Run the check before you finish.
- Do not modify `src/`, `test/`, `scripts/` or the docs tree. The only writes are the files
  named in your task's write scope.

## Deliverable format for every area report

1. `## What exists` with the measured or read facts, each with `file:line`, a command, or a
   number.
2. `## What is missing`, ordered by how much a user would notice.
3. `## Candidates`, one row per feature in a table with columns: id, name, the user question it
   answers, data it reads, effort (S/M/L), risk, and the falsifiable check it would need.
4. `## Rejected ideas`, with the reason, so the council does not resurrect them.
5. For anything you ran: the exact command and the observed output line.

## Council rubric

Each seat reads all five area reports plus this brief, and may verify claims against the code.
Score every candidate on user value (1 to 5), differentiation (1 to 5), evidence quality (1 to
5), and feasibility (1 to 5). Verdict is keep, merge, kill or needs-evidence. The council does
not average: it argues. Where seats disagree, the disagreement is recorded, not smoothed.

The three seats are product value, engineering feasibility, and security with privacy and
compliance. The lead synthesizes the final proposal and keeps the dissent.
