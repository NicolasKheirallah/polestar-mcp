import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createStdioInputFilter, looksLikeJsonRpc } from '../src/stdio-filter.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  const source = new PassThrough();
  const sink = new PassThrough();
  const filter = createStdioInputFilter(source, sink);
  let emitted = '';
  let forwarded = '';
  sink.on('data', (chunk: Buffer) => {
    emitted += chunk.toString('utf8');
  });
  filter.input.on('data', (chunk: Buffer) => {
    forwarded += chunk.toString('utf8');
  });
  return {
    source,
    filter,
    emitted: () => emitted,
    forwarded: () => forwarded,
    dispose: () => {
      filter.dispose();
      source.destroy();
      sink.destroy();
    },
  };
}

function frames(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

test('a malformed JSON line gets -32700 and is not forwarded', async () => {
  const h = harness();
  try {
    h.source.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"\n');
    await tick();
    assert.deepEqual(frames(h.emitted()).map((f) => (f as { error?: { code?: number } }).error?.code), [-32700]);
    assert.equal(h.forwarded(), '');
  } finally {
    h.dispose();
  }
});

test('a JSON-RPC batch gets -32600 and is not forwarded', async () => {
  const h = harness();
  try {
    h.source.write('[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]\n');
    await tick();
    const out = frames(h.emitted()) as Array<{ error?: { code?: number; message?: string } }>;
    assert.equal(out.length, 1);
    assert.equal(out[0]?.error?.code, -32600);
    assert.match(out[0]?.error?.message ?? '', /batch/i);
    assert.equal(h.forwarded(), '');
  } finally {
    h.dispose();
  }
});

test('an object that is not JSON-RPC gets -32600', async () => {
  const h = harness();
  try {
    h.source.write('{"hello":"world"}\n');
    await tick();
    assert.equal((frames(h.emitted())[0] as { error?: { code?: number } }).error?.code, -32600);
    assert.equal(h.forwarded(), '');
  } finally {
    h.dispose();
  }
});

test('valid messages are forwarded unchanged, split across chunks', async () => {
  const h = harness();
  try {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    h.source.write(line.slice(0, 18));
    await tick();
    assert.equal(h.forwarded(), '');
    h.source.write(`${line.slice(18)}\n`);
    await tick();
    assert.equal(h.forwarded(), `${line}\n`);
    assert.equal(frames(h.emitted()).length, 0);
  } finally {
    h.dispose();
  }
});

test('looksLikeJsonRpc accepts requests, notifications and responses', () => {
  assert.equal(looksLikeJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), true);
  assert.equal(looksLikeJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), true);
  assert.equal(looksLikeJsonRpc({ jsonrpc: '2.0', id: 2, result: {} }), true);
  assert.equal(looksLikeJsonRpc({ jsonrpc: '2.0', id: 3, error: { code: -1, message: 'x' } }), true);
  assert.equal(looksLikeJsonRpc({ jsonrpc: '1.0', id: 1, method: 'x' }), false);
  assert.equal(looksLikeJsonRpc({ jsonrpc: '2.0', id: true, method: 'x' }), false);
  assert.equal(looksLikeJsonRpc(null), false);
  assert.equal(looksLikeJsonRpc([]), false);
  assert.equal(looksLikeJsonRpc('text'), false);
});
