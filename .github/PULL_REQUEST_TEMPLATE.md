<!--
What a reviewer needs to judge this without running your head through it.
-->

## What changes, in behaviour

One or two sentences on what a caller sees differently. Delete this line and the comment
before submitting.

## Why

The reason, not the diff. If it fixes a bug, name the check that failed before and passes now.

## How it was verified

- [ ] `npm run typecheck` and `npm run build`
- [ ] `npm test`
- [ ] `npm run smoke` and `npm run smoke-http`
- [ ] `npm run verify-fixtures` and `npm run check-secrets`
- [ ] `npm run check-tool-refs`
- [ ] `node docs/check-docs.mjs tools`, `envvars`, `links`, `hygiene`
- [ ] I added or updated something that can fail on this change, and where a check only
      matters because it can reject something, I ran its positive control

## Claims about the upstream API

If this changes what the server believes about the Data Portal, say how that was measured:
a live call, a captured fixture, or documentation. An assumption written as a fact is the
one thing a reviewer cannot check.

## Notes for the reviewer

Anything surprising in the diff, and anything deliberately not done.
