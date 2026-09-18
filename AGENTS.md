# AGENTS.md

Working notes for agents and contributors working in this repository.

## Read first

- [CONTRIBUTING.md](CONTRIBUTING.md): how to run it, what CI checks, how to add a Domain or a tool.
- [SECURITY.md](SECURITY.md): what the server can and cannot do, where credentials live, what leaves the machine.
- [docs/architecture.md](docs/architecture.md): the module boundaries and why they are drawn there.

## Words this codebase uses deliberately

Domain: **Vehicle**, **VIN**, **Domain**, **Envelope**, **Availability**, **Token Provider**,
**Transport**, **PolestarClient**, **Fixture mode**.

Design: **module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**,
and the **deletion test**. Do not substitute "component", "service", "API" or "boundary" when one
of these is what is meant.

## House rules

- Every claim about behaviour needs something that can fail: a test, a probe, or a CI check. A
  comment that describes protection nothing applies is a defect.
- Do not claim a check passed without running it, and do not add a check whose failure cannot be
  observed. Detectors carry positive controls.
- Fixture mode is the default test path: `test/fixtures/dump/` is synthetic and needs no
  credential. Live capture goes through `npm run capture`, which writes the raw dump outside this
  tree on purpose; a raw capture holds a real VIN, a real token and real position history.
- The API is read-only, so this server is read-only. `POLESTAR_ENABLE_WRITES` registers nothing.
- Writing hygiene is enforced by `node docs/check-docs.mjs hygiene` across the whole tree. Run it
  before pushing.
