import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildEngine } from '../src/server.js';
import { createHttpHandler } from '../src/server.js';
import { decideBind, type BindSuccess } from '../src/bind.js';

/**
 * Both protocol eras over one HTTP listener.
 *
 * The server serves 2025-era clients through the stateless legacy path and
 * 2026-07-28 clients through the modern per-request envelope, from the same
 * tool registry. These tests pin both, because a serving change that silently
 * drops the era a client asked for is invisible until that client fails.
 */

const DUMP = fileURLToPath(new URL('../test/fixtures/dump', import.meta.url));

interface Listening {
  base: string;
  close(): Promise<void>;
}

async function listen(): Promise<Listening> {
  const engine = buildEngine({ POLESTAR_FIXTURES_DIR: DUMP, POLESTAR_HISTORY_DIR: undefined });
  const bind = decideBind({ host: '127.0.0.1', token: 'modern-protocol-token' });
  assert.equal(bind.ok, true);
  const server = createServer(createHttpHandler(engine, bind as BindSuccess));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const MODERN_VERSION = '2026-07-28';
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

function modernHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer modern-protocol-token',
    'MCP-Protocol-Version': MODERN_VERSION,
  };
}

async function rpc(
  base: string,
  method: string,
  headers: Record<string, string>,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: ENVELOPE },
    }),
  });
  return { status: response.status, body: await response.text() };
}

test('the modern 2026-07-28 era is served over HTTP: discovery and tools/list', async () => {
  const listener = await listen();
  try {
    const discover = await rpc(listener.base, 'server/discover', { ...modernHeaders(), 'Mcp-Method': 'server/discover' });
    assert.equal(discover.status, 200, discover.body);
    const discovered = JSON.parse(discover.body) as {
      result?: { supportedVersions?: string[]; capabilities?: Record<string, unknown>; instructions?: string };
    };
    assert.deepEqual(discovered.result?.supportedVersions, [MODERN_VERSION], 'the handler serves exactly the modern revision it advertises');
    assert.match(discovered.result?.instructions ?? '', /READ-ONLY/, 'the generated instructions travel with discovery');

    const listed = await rpc(listener.base, 'tools/list', { ...modernHeaders(), 'Mcp-Method': 'tools/list' });
    assert.equal(listed.status, 200, listed.body);
    const tools = (JSON.parse(listed.body) as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    assert.equal(tools.length, 26, 'the default surface is served to a modern client');
    assert.ok(tools.some((tool) => tool.name === 'get_car_status'));
  } finally {
    await listener.close();
  }
});

test('a modern request without the per-request envelope is refused, not silently downgraded', async () => {
  const listener = await listen();
  try {
    const response = await fetch(listener.base, {
      method: 'POST',
      headers: { ...modernHeaders(), 'Mcp-Method': 'tools/list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.match(body, /per-request envelope|_meta/, 'the refusal names the missing envelope');
  } finally {
    await listener.close();
  }
});

test('a 2025-era initialize is still answered on the same listener', async () => {
  const listener = await listen();
  try {
    const response = await fetch(listener.base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer modern-protocol-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '0' } },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const frame = body.split('\n').find((line) => line.startsWith('data:'));
    const parsed = JSON.parse(frame === undefined ? body : frame.slice(5).trim()) as {
      result?: { protocolVersion?: string; capabilities?: { resources?: { subscribe?: boolean } } };
    };
    assert.equal(parsed.result?.protocolVersion, '2025-06-18', 'a legacy client keeps the revision it asked for');
    assert.equal(parsed.result?.capabilities?.resources?.subscribe, false, 'stateless serving advertises no subscriptions');
  } finally {
    await listener.close();
  }
});
