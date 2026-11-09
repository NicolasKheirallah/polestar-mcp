/**
 * Audit capture 2: raw payload duplication, absence behaviour, failure modes,
 * and a fixture copy with whole domains deleted so absence is observable.
 *
 *   node --import tsx analysis/surface/capture2.ts
 */
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcpClient } from '../../scripts/stdio-client.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'analysis', 'surface', 'evidence');
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');

// A fixture copy where health and exterior are never reported, so aggregates
// meet DATA_NOT_AVAILABLE and we can see what the agent is told.
const partial = mkdtempSync(path.join(tmpdir(), 'polestar-partial-'));
cpSync(path.join(ROOT, 'test', 'fixtures', 'dump'), partial, { recursive: true });
for (const gone of ['telemetry/health.json', 'telemetry/exterior.json', 'charging/is-at-charge-location.json']) {
  rmSync(path.join(partial, 'dataportal', gone));
}

const run = async (fixturesDir: string, label: string) => {
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
      capabilities: { elicitation: {} },
      clientInfo: { name: 'audit2', version: '0' },
    });
    client.notifyInitialized();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const m = await client.callTool(name, args);
      return {
        name,
        args,
        isError: m.isError,
        text: m.text,
        textBytes: Buffer.byteLength(m.text, 'utf8'),
        structBytes: bytes(m.structuredContent),
        structKeys: Object.keys(m.structuredContent ?? {}),
        dataBytes: bytes(m.structuredContent?.data),
        rawPayloadInText: m.text.includes('"metaEventId"'),
        totalBytes: bytes({
          content: [{ type: 'text', text: m.text }],
          structuredContent: m.structuredContent,
        }),
      };
    };
    const calls = [
      await call('get_battery', { raw: true }),
      await call('get_battery'),
      await call('get_charging_estimate'),
      await call('is_car_secure'),
      await call('get_needs_attention'),
      await call('get_car_status'),
      await call('get_is_at_charge_location'),
      await call('get_location'),
      // Error-path: delegation refusal, and a location refusal is config-only.
      await call('get_battery', { delegated_account_id: 'nope' }),
      // Elicitation path cannot be triggered on a one-vehicle fixture; measured
      // by the unit tests only.
    ];
    const toolsMsg = await client.request('tools/list', {});
    return { label, fixture: fixturesDir, calls, toolCount: ((toolsMsg.result?.tools ?? []) as unknown[]).length };
  } finally {
    client.stop();
  }
};

const full = await run(path.join(ROOT, 'test', 'fixtures', 'dump'), 'full');
const missing = await run(partial, 'health+exterior+is-at-charge-location deleted');

writeFileSync(
  path.join(OUT, 'capture2.json'),
  JSON.stringify({ full, missing }, null, 2) + '\n',
);
for (const r of [full, missing]) {
  console.log(`\n===== ${r.label} (${r.toolCount} tools) =====`);
  for (const c of r.calls) {
    console.log(
      `\n--- ${c.name} ${JSON.stringify(c.args)} isError=${c.isError} text=${c.textBytes}B struct=${c.structBytes}B data=${c.dataBytes}B total=${c.totalBytes}B keys=${c.structKeys.join(',')} rawInText=${c.rawPayloadInText}`,
    );
    console.log(c.text.slice(0, 900));
  }
}
rmSync(partial, { recursive: true, force: true });
