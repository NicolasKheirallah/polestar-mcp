/**
 * Probe: what does POLESTAR_REDACT_VIN=1 actually mask on the wire?
 *
 * Spawns the published build in fixture mode with redaction on, then records
 * whether the full synthetic VIN appears in each response the client receives.
 * Fixture VIN is the declared synthetic marker, never a real identifier.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'dump');
const VIN = 'YSMTEST22PL000001';

const child = spawn(process.execPath, ['build/server.js'], {
  cwd: ROOT,
  env: { ...process.env, POLESTAR_FIXTURES_DIR: FIXTURES, POLESTAR_REDACT_VIN: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buffer += d.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      /* server stderr diagnostics are not protocol */
    }
  }
});
child.stderr.on('data', () => {});

let nextId = 1;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const report = (label, payload) => {
  const text = JSON.stringify(payload);
  console.log(`${text.includes(VIN) ? 'FULL-VIN-PRESENT' : 'masked          '}  ${label}`);
};

await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'redact-probe', version: '0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const battery = await request('tools/call', { name: 'get_battery', arguments: {} });
report('tools/call get_battery (no raw)', battery);

const raw = await request('tools/call', { name: 'get_battery', arguments: { raw: true } });
report('tools/call get_battery raw:true', raw);

const resources = await request('resources/list', {});
const list = resources.result?.resources ?? [];
report('resources/list entry uri  ', list[0]?.uri);
report('resources/list entry name ', list[0]?.name);

const read = await request('resources/read', { uri: `polestar://vehicle/${VIN}/telemetry/battery` });
const contents = read.result?.contents?.[0] ?? {};
report('resources/read content text', contents.text);
report('resources/read echoed uri ', contents.uri);

const vehicles = await request('tools/call', { name: 'list_vehicles', arguments: {} });
report('tools/call list_vehicles', vehicles);

child.kill('SIGKILL');
process.exit(0);
