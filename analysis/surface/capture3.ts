/**
 * Audit capture 3: what aggregates say when a domain is DATA_NOT_AVAILABLE,
 * and what resources/list does with more vehicles than it will list.
 *
 *   node --import tsx analysis/surface/capture3.ts
 */
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcpClient } from '../../scripts/stdio-client.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'analysis', 'surface', 'evidence');
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');

const DATA_NOT_AVAILABLE = (domain: string): string =>
  JSON.stringify(
    {
      error: {
        code: 'DATA_NOT_AVAILABLE',
        details: { requested_vin: 'YSMTEST22PL000001' },
        httpStatus: 404,
        message: `No ${domain} data is available for this vehicle.`,
        requestId: '191ec653-2e3d-4eae-93d1-47b8109b5361',
        timestamp: '2026-09-18T13:39:03.772Z',
      },
    },
    null,
    2,
  );

const run = async (fixturesDir: string, label: string, calls: Array<[string, Record<string, unknown>]>) => {
  const client = StdioMcpClient.spawn(['--import', 'tsx', 'src/server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      POLESTAR_FIXTURES_DIR: fixturesDir,
      POLESTAR_HISTORY_DIR: mkdtempSync(path.join(tmpdir(), 'polestar-audit-history-')),
    },
  });
  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'audit3', version: '0' },
    });
    client.notifyInitialized();
    const out = [];
    for (const [name, args] of calls) {
      const m = await client.callTool(name, args);
      out.push({
        name,
        args,
        isError: m.isError,
        text: m.text,
        textBytes: Buffer.byteLength(m.text, 'utf8'),
        structKeys: Object.keys(m.structuredContent ?? {}),
        structBytes: bytes(m.structuredContent),
      });
    }
    return { label, calls: out };
  } finally {
    client.stop();
  }
};

// A: health and exterior are DATA_NOT_AVAILABLE (the normal live state for a car
// that does not report them), so aggregates meet the absence path.
const absent = mkdtempSync(path.join(tmpdir(), 'polestar-absent-'));
cpSync(path.join(ROOT, 'test', 'fixtures', 'dump'), absent, { recursive: true });
writeFileSync(path.join(absent, 'dataportal', 'telemetry', 'health.json'), DATA_NOT_AVAILABLE('health'));
writeFileSync(path.join(absent, 'dataportal', 'telemetry', 'exterior.json'), DATA_NOT_AVAILABLE('exterior'));

// B: 12 vehicles, so resources/list is forced past its slice(0, 10) cap.
const fleet = mkdtempSync(path.join(tmpdir(), 'polestar-fleet-'));
cpSync(path.join(ROOT, 'test', 'fixtures', 'dump'), fleet, { recursive: true });
const vins = Array.from({ length: 12 }, (_, i) => `YSMTEST22PL0000${String(i).padStart(2, '0')}`);
writeFileSync(
  path.join(fleet, 'dataportal', 'vehicles.json'),
  JSON.stringify({ data: vins, meta: { count: vins.length } }, null, 2),
);

const a = await run(absent, 'health+exterior DATA_NOT_AVAILABLE', [
  ['get_car_status', {}],
  ['is_car_secure', {}],
  ['get_needs_attention', {}],
  ['get_charging_estimate', {}],
]);

const client = StdioMcpClient.spawn(['--import', 'tsx', 'src/server.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    POLESTAR_FIXTURES_DIR: fleet,
    POLESTAR_HISTORY_DIR: mkdtempSync(path.join(tmpdir(), 'polestar-audit-history-')),
  },
});
let b: Record<string, unknown> = {};
try {
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'audit3', version: '0' },
  });
  client.notifyInitialized();
  const res = await client.request('resources/list', {});
  const list = (res.result?.resources ?? []) as unknown[];
  const v = await client.callTool('list_vehicles');
  b = {
    vehicleCountInFixture: vins.length,
    resourcesListBytes: bytes(res.result),
    resourcesListCount: list.length,
    hasNextCursor: 'nextCursor' in (res.result ?? {}),
    distinctVinsListed: new Set(list.map((r) => String((r as { uri: string }).uri).split('/')[3])).size,
    listVehiclesText: v.text,
  };
} finally {
  client.stop();
}

writeFileSync(path.join(OUT, 'capture3.json'), JSON.stringify({ absenceAggregates: a, fleetResources: b }, null, 2) + '\n');
console.log(`\n===== ${a.label} =====`);
for (const c of a.calls) {
  console.log(`\n--- ${c.name} isError=${c.isError} text=${c.textBytes}B struct=${c.structBytes}B keys=${c.structKeys.join(',')}`);
  console.log(c.text);
}
console.log('\n===== fleet resources =====');
console.log(JSON.stringify(b, null, 2));
rmSync(absent, { recursive: true, force: true });
rmSync(fleet, { recursive: true, force: true });
