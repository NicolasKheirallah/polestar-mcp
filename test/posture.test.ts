import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEngine, createMcpServer } from '../src/server.js';

/**
 * What this server refuses to do, checked rather than asserted in prose.
 *
 * Both claims here are load-bearing and both are stated in documents a reader acts
 * on (AGENTS.md, docs/write-endpoints.md, docs/consumer-adapter-note.md). Documents
 * cannot fail, so each one gets a check that can.
 */

const DUMP = fileURLToPath(new URL('../test/fixtures/dump', import.meta.url));

function surfaceFor(env: Record<string, string | undefined>): { names: string[]; logged: string[] } {
  const engine = buildEngine({ POLESTAR_FIXTURES_DIR: DUMP, POLESTAR_HISTORY_DIR: undefined, ...env });
  const logged: string[] = [];
  engine.log = (message: string) => logged.push(message);
  const surface = createMcpServer(engine);
  return { names: [...surface.toolNames], logged };
}

test('POLESTAR_ENABLE_WRITES registers nothing, so read-only is a property of the registry', () => {
  // The flag exists so the day Polestar documents writes, the tools land behind an
  // opt-in that is already wired. Until then it must add nothing: a tool appearing
  // while the opt-in is on, or a write slipping in without it, both move this list.
  const off = surfaceFor({});
  const on = surfaceFor({ POLESTAR_ENABLE_WRITES: '1' });

  assert.deepEqual(on.names, off.names, 'the opt-in changes no tool');
  assert.ok(off.names.length >= 22, `the registry is the full one, saw ${off.names.length}`);

  // And it says so out loud, because a flag that silently does nothing is
  // indistinguishable from a flag that is misspelled.
  assert.match(on.logged.join('\n'), /POLESTAR_ENABLE_WRITES is set, but the documented v1 API has no write endpoints, nothing registered\./);
  assert.doesNotMatch(off.logged.join('\n'), /POLESTAR_ENABLE_WRITES/, 'and stays quiet when unset');
});

test('the consumer app API is still a design note, not a code path', () => {
  // docs/consumer-adapter-note.md opens by saying the server ignores the consumer app
  // API: that API is undocumented and its refresh token rotates on every refresh, so a
  // half-wired adapter would lock a car out rather than fail loudly. The note names
  // three hosts and three GraphQL documents; none of them may reach src/ or scripts/.
  const markers: Record<string, RegExp> = {
    'the Polestar ID token endpoint': /polestarid\.eu\.polestar\.com/,
    'the render CDN': /car-images\.polestar\.com/,
    'GetConsumerCarsV2': /GetConsumerCarsV2/,
    'GetCarImages': /GetCarImages/,
    'CarTelematicsV2': /CarTelematicsV2/,
    'a GraphQL request': /graphql/i,
  };

  const sources: string[] = [];
  for (const dir of ['src', 'scripts']) {
    for (const entry of readdirSync(fileURLToPath(new URL(`../${dir}`, import.meta.url)))) {
      if (/\.(?:ts|mjs)$/.test(entry)) sources.push(`${dir}/${entry}`);
    }
  }
  assert.ok(sources.length > 20, `expected to be scanning the tree, saw ${sources.length} files`);

  const found: string[] = [];
  for (const rel of sources) {
    const body = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
    for (const [what, pattern] of Object.entries(markers)) {
      if (pattern.test(body)) found.push(`${what} in ${rel}`);
    }
  }
  assert.deepEqual(found, [], `the consumer adapter is documented as not implemented:\n${found.join('\n')}`);

  // Positive control: the same patterns do find the document that names them, so an
  // empty result above means the tree is clean rather than the detector being asleep.
  const note = readFileSync(new URL('../docs/consumer-adapter-note.md', import.meta.url), 'utf8');
  for (const [what, pattern] of Object.entries(markers)) {
    assert.match(note, pattern, `the detector no longer matches ${what}`);
  }

  // The other half of "not implemented": the gate the note promises does not exist yet,
  // so adding it to the registry without the adapter is caught here.
  const config = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /POLESTAR_CONSUMER_REFRESH_TOKEN/, 'the note gate is not wired, so it is not config');
  assert.match(config, /POLESTAR_HISTORY_DIR/, 'the control: real gates are in this file');
});
