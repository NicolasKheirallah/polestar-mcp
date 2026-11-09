import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const VIN = (JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/dump/dataportal/vehicles.json'), 'utf8')) as { data: string[] }).data[0]!;

interface Wire {
  child: ChildProcessWithoutNullStreams;
  frames: Array<Record<string, unknown>>;
  send(value: unknown): void;
  waitFor(predicate: (frame: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>>;
  stop(): void;
}

function start(): Wire {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, POLESTAR_FIXTURES_DIR: path.join(ROOT, 'test/fixtures/dump') },
  });
  const frames: Array<Record<string, unknown>> = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.trim() === '') return;
    frames.push(JSON.parse(line) as Record<string, unknown>);
  });
  child.stderr.resume();
  const wire: Wire = {
    child,
    frames,
    send: (value) => child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`),
    waitFor: async (predicate, label) => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = frames.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    stop: () => child.kill('SIGTERM'),
  };
  return wire;
}

async function initialized(wire: Wire): Promise<void> {
  wire.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wire-test', version: '0.0.0' } },
  });
  await wire.waitFor((frame) => frame.id === 1 && frame.result !== undefined, 'initialize response');
  wire.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

test('a malformed JSON line is answered with -32700 and the session survives', async () => {
  const wire = start();
  try {
    await initialized(wire);
    wire.send('{"jsonrpc":"2.0","id":9,"method":"tools/list"');
    const parseError = await wire.waitFor(
      (frame) => (frame.error as { code?: number } | undefined)?.code === -32700,
      'parse error frame',
    );
    assert.equal((parseError.error as { code: number }).code, -32700);
    // The session keeps answering after the bad line.
    wire.send({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} });
    const listed = await wire.waitFor((frame) => frame.id === 10, 'tools/list response');
    assert.ok(Array.isArray((listed.result as { tools?: unknown[] }).tools));
  } finally {
    wire.stop();
  }
});

test('a JSON-RPC batch is refused with -32600 instead of being dropped', async () => {
  const wire = start();
  try {
    await initialized(wire);
    wire.send([
      { jsonrpc: '2.0', id: 21, method: 'ping' },
      { jsonrpc: '2.0', id: 22, method: 'ping' },
    ]);
    const refused = await wire.waitFor(
      (frame) => (frame.error as { code?: number } | undefined)?.code === -32600,
      'batch refusal frame',
    );
    assert.match(String((refused.error as { message?: string }).message), /batch/i);
  } finally {
    wire.stop();
  }
});

test('malformed percent-encoding in a resource URI is -32602, not an internal error', async () => {
  const wire = start();
  try {
    await initialized(wire);
    wire.send({
      jsonrpc: '2.0',
      id: 31,
      method: 'resources/read',
      params: { uri: 'polestar://vehicle/%ZZ/telemetry/battery' },
    });
    const refused = await wire.waitFor((frame) => frame.id === 31, 'resources/read response');
    assert.equal((refused.error as { code?: number } | undefined)?.code, -32602);
    assert.match(String((refused.error as { message?: string }).message), /percent-encoding/i);
    // Positive control: the canonical URI for the same resource still reads.
    wire.send({ jsonrpc: '2.0', id: 32, method: 'resources/read', params: { uri: `polestar://vehicle/${VIN}/telemetry/battery` } });
    const read = await wire.waitFor((frame) => frame.id === 32, 'valid resources/read response');
    assert.ok(Array.isArray((read.result as { contents?: unknown[] }).contents));
  } finally {
    wire.stop();
  }
});
