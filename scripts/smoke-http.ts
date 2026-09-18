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

const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', '--http'], {
  cwd: PROJECT_ROOT,
  env: {
    ...process.env,
    POLESTAR_HTTP_PORT: String(PORT),
    POLESTAR_FIXTURES_DIR: path.join(PROJECT_ROOT, 'test', 'fixtures', 'dump'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));

async function post(body: unknown): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string }; id?: number }> {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
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
