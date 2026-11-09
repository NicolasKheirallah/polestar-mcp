import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { StdioMcpClient } from '../scripts/stdio-client.js';
import { promptSpecs, refreshFailureLine } from '../src/server.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const FIX = path.join(ROOT, 'test/fixtures/dump');
const VIN = (JSON.parse(readFileSync(path.join(FIX, 'dataportal/vehicles.json'), 'utf8')) as { data: string[] }).data[0]!;
const MASKED = `${VIN.slice(0, 3)}…${VIN.slice(-3)}`;

function spawn(env: NodeJS.ProcessEnv = {}): StdioMcpClient {
  return StdioMcpClient.spawn(['--import', 'tsx', 'src/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, POLESTAR_FIXTURES_DIR: FIX, ...env },
  });
}

async function withClient(env: NodeJS.ProcessEnv, run: (client: StdioMcpClient) => Promise<void>): Promise<void> {
  const client = spawn(env);
  try {
    await client.initialize('polestar-mcp');
    await run(client);
  } finally {
    client.stop();
  }
}

test('POLESTAR_ALLOW_LOCATION=0 refuses recorded position history', async () => {
  const history = mkdtempSync(path.join(tmpdir(), 'polestar-history-location-'));
  try {
    mkdirSync(path.join(history, VIN), { recursive: true });
    writeFileSync(
      path.join(history, VIN, 'telemetry-location.jsonl'),
      `${JSON.stringify({ observedAt: Date.now(), data: { coordinate: { latitude: 1.5, longitude: 2.5 } } })}\n`,
    );
    await withClient(
      { POLESTAR_HISTORY_DIR: history, POLESTAR_ALLOW_LOCATION: '0', POLESTAR_REDACT_VIN: '1' },
      async (client) => {
        const denied = await client.callTool('get_history', { domain: 'telemetry/location' });
        assert.equal(denied.isError, true);
        assert.equal(denied.structuredContent?.code, 'LOCATION_DISALLOWED');
        assert.doesNotMatch(denied.text, /latitude|longitude/);
      },
    );
    // Positive control: with the switch on, the recorded sample is the answer.
    await withClient({ POLESTAR_HISTORY_DIR: history }, async (client) => {
      const allowed = await client.callTool('get_history', { domain: 'telemetry/location' });
      assert.equal(allowed.isError, false);
      assert.match(allowed.text, /latitude/);
    });
  } finally {
    rmSync(history, { recursive: true, force: true });
  }
});

test('redaction masks a VIN echoed in an upstream error message', async () => {
  const dump = mkdtempSync(path.join(tmpdir(), 'polestar-error-redaction-'));
  try {
    cpSync(FIX, dump, { recursive: true });
    writeFileSync(
      path.join(dump, 'dataportal/telemetry/battery.json'),
      JSON.stringify({
        error: { code: 'VALIDATION_INVALID_PARAMETER', message: `vehicle ${VIN} rejected`, httpStatus: 400 },
      }),
    );
    await withClient({ POLESTAR_FIXTURES_DIR: dump, POLESTAR_REDACT_VIN: '1' }, async (client) => {
      const masked = await client.callTool('get_battery');
      assert.equal(masked.isError, true);
      assert.doesNotMatch(masked.text, new RegExp(VIN));
      assert.doesNotMatch(String(masked.structuredContent?.message ?? ''), new RegExp(VIN));
      assert.match(masked.text, new RegExp(MASKED));
    });
    // Positive control: without redaction the upstream message is untouched.
    await withClient({ POLESTAR_FIXTURES_DIR: dump }, async (client) => {
      const raw = await client.callTool('get_battery');
      assert.match(raw.text, new RegExp(VIN));
    });
  } finally {
    rmSync(dump, { recursive: true, force: true });
  }
});

test('redaction masks a caller-supplied VIN in prompt text', async () => {
  await withClient({ POLESTAR_REDACT_VIN: '1' }, async (client) => {
    const got = await client.request('prompts/get', { name: 'car-status', arguments: { vin: VIN } });
    const text = JSON.stringify(got.result ?? {});
    assert.doesNotMatch(text, new RegExp(VIN));
    assert.match(text, new RegExp(MASKED));
  });
  // Positive control: the no-redaction prompt still carries what the caller named.
  await withClient({}, async (client) => {
    const got = await client.request('prompts/get', { name: 'car-status', arguments: { vin: VIN } });
    assert.match(JSON.stringify(got.result ?? {}), new RegExp(VIN));
  });
});

test('redaction masks the caller identifier echoed by INVALID_VIN', async () => {
  const typo = `${VIN.slice(0, 16)}O`;
  await withClient({ POLESTAR_REDACT_VIN: '1' }, async (client) => {
    const denied = await client.callTool('get_battery', { vin: typo });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent?.code, 'INVALID_VIN');
    assert.equal(denied.text.includes(typo), false);
    assert.match(denied.text, /YSM…00O/);
  });
  // Positive control: without redaction the refusal names the argument it rejected.
  await withClient({}, async (client) => {
    const denied = await client.callTool('get_battery', { vin: typo });
    assert.match(denied.text, new RegExp(typo));
  });
});

test('a failed background refresh line masks the VIN in the path and message', () => {
  const url = `https://api.example.test/v1/vehicles/${VIN}/telemetry/battery`;
  const masked = refreshFailureLine(url, `${VIN} failed`, true);
  assert.doesNotMatch(masked, new RegExp(VIN));
  assert.match(masked, /YSM…001/);
  // Positive control: without redaction the diagnostic keeps the path as it was.
  assert.match(refreshFailureLine(url, 'boom', false), new RegExp(VIN));
});

test('promptSpecs masks a supplied VIN only when redaction is on', () => {
  const [status] = promptSpecs({ history: true, redactVin: true });
  const masked = JSON.stringify(status!.build({ vin: VIN })).match(/"text":"(.*)"/s)?.[1] ?? '';
  assert.doesNotMatch(masked, new RegExp(VIN));
  const [raw] = promptSpecs({ history: true, redactVin: false });
  const unmasked = JSON.stringify(raw!.build({ vin: VIN }));
  assert.match(unmasked, new RegExp(VIN));
});
