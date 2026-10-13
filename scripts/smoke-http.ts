/**
 * Streamable-HTTP mode smoke test: starts the server with --http, then speaks
 * plain JSON-RPC over HTTP POSTs (stateless mode, each request independent).
 * Prints HTTP_SMOKE_OK only after every assertion passes.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 18493;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = 'smoke-http-token';

const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', '--http'], {
  cwd: PROJECT_ROOT,
  env: {
    ...process.env,
    POLESTAR_HTTP_PORT: String(PORT),
    // A token is required so the bearer check itself is exercised: it was reachable
    // only by spawning a process, and nothing spawned one with a token at all.
    POLESTAR_HTTP_TOKEN: TOKEN,
    POLESTAR_FIXTURES_DIR: path.join(PROJECT_ROOT, 'test', 'fixtures', 'dump'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

async function post(
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string }; id?: number }> {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Statelessness: accept plain JSON or an SSE frame carrying the result.
  const jsonLine = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(jsonLine !== undefined ? jsonLine.slice(5).trim() : text) as never;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250);
    up = await fetch(BASE_URL, { method: 'POST', body: 'not-json' })
      .then((r) => r.status >= 400)
      .catch(() => false);
  }
  if (!up) throw new Error('server never came up on ' + BASE_URL);

  const init = await post({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-http', version: '0' } },
  });
  if ((init.result?.serverInfo as { name?: string } | undefined)?.name !== 'polestar-mcp') {
    throw new Error(`handshake failed: ${JSON.stringify(init).slice(0, 200)}`);
  }
  // Stateless: the surface that would poll is closed with this response, so the
  // capability says no rather than accepting a subscription that can never fire.
  if ((init.result?.capabilities as { resources?: { subscribe?: boolean } } | undefined)?.resources?.subscribe !== false) {
    throw new Error(`stateless HTTP must not advertise subscriptions: ${JSON.stringify(init.result?.capabilities)}`);
  }
  const subscribe = await post({ jsonrpc: '2.0', id: 9, method: 'resources/subscribe', params: { uri: 'polestar://vehicle/X/telemetry/battery' } });
  if (subscribe.error === undefined) {
    throw new Error('resources/subscribe was accepted over stateless HTTP, where it can never be delivered');
  }

  const tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolCount = ((tools.result?.tools as unknown[] | undefined) ?? []).length;
  if (toolCount < 22) throw new Error(`expected the full tool registry over HTTP, got ${toolCount}`);

  const call = await post({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'get_battery', arguments: { vin: 'YSMTEST22PL000001' } },
  });
  if (!JSON.stringify(call.result).includes('Charge: 52%')) throw new Error(`get_battery over HTTP failed: ${JSON.stringify(call.result).slice(0, 200)}`);

  const resources = await post({ jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} });
  if (!Array.isArray(resources.result?.resources) || (resources.result!.resources as unknown[]).length === 0) {
    throw new Error('resources/list over HTTP returned nothing');
  }

  // The bearer check and its body, which nothing exercised before: a caller that
  // forgets the header has to be told what to send, not answered as an anonymous read.
  for (const [label, headers] of [
    ['no Authorization header', {}],
    ['the wrong token', { authorization: 'Bearer not-the-token' }],
  ] as const) {
    const denied = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
    });
    if (denied.status !== 401) throw new Error(`${label} answered ${denied.status}, not 401`);
    if (denied.headers.get('www-authenticate') !== 'Bearer') {
      throw new Error(`${label} did not challenge with www-authenticate: Bearer`);
    }
    const body = await denied.text();
    if (!body.includes('UNAUTHENTICATED') || !body.includes('POLESTAR_HTTP_TOKEN')) {
      throw new Error(`${label} got an unhelpful 401 body: ${body.slice(0, 200)}`);
    }
  }
  // And the token we do have still works, so the check is not simply refusing everything.
  if ((await post({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} })).result === undefined) {
    throw new Error('a valid bearer token was refused');
  }

  child.kill('SIGTERM');
  console.log('HTTP_SMOKE_OK');
  process.exit(0);
} catch (err) {
  child.kill('SIGKILL');
  console.error('HTTP_SMOKE_FAILED:', err instanceof Error ? err.message : err);
  console.error('--- server stderr ---');
  console.error(stderr);
  process.exit(1);
}
