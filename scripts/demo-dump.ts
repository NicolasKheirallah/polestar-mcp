/**
 * Proves the server reproduces real values from the captured endpoint dump
 * (POLESTAR_FIXTURES_DIR pointed at the sibling api_endpoints dump), now
 * including the true 404 branch, since the fixture adapter replays captured
 * error statuses. Prints DUMP_OK only after every assertion passes and never
 * prints VINs or values beyond existence checks.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StdioMcpClient } from './stdio-client.js';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DUMP_DIR = path.resolve(PROJECT_ROOT, '..');

if (!existsSync(path.join(DUMP_DIR, 'dataportal', 'vehicles.json'))) {
  console.error(`DUMP_FAILED: expected captured dump at ${DUMP_DIR} (dataportal/vehicles.json not found)`);
  process.exit(1);
}

const client = StdioMcpClient.spawn(['--import', 'tsx', 'src/server.ts'], {
  cwd: PROJECT_ROOT,
  env: { ...process.env, POLESTAR_FIXTURES_DIR: DUMP_DIR },
});

try {
  await client.initialize('polestar-mcp');

  // Outputs are humanized now; the VIN arrives in the summary line and the
  // raw payload rides along when raw=true.
  const vehicles = await client.callTool('list_vehicles');
  const vinMatch = /([A-HJ-NPR-Z0-9]{17})/.exec(vehicles.text);
  if (vinMatch === null) throw new Error('dump did not yield a plausible VIN list');
  const vin = vinMatch[1]!;

  const battery = await client.callTool('get_battery', { vin, raw: true });
  if (!battery.text.includes('Charge:') || !/\d+/.test(battery.text)) {
    throw new Error('dump battery response did not humanize');
  }
  const rawJson = battery.text.slice(battery.text.indexOf('{'));
  const batteryData = JSON.parse(rawJson) as { batteryChargeLevelPercentage?: unknown };
  if (typeof batteryData.batteryChargeLevelPercentage !== 'number') {
    throw new Error('dump battery raw payload did not include batteryChargeLevelPercentage');
  }

  const unavailable = await client.callTool('get_is_at_charge_location', { vin });
  if (unavailable.isError || unavailable.protocolError || !unavailable.text.includes('DATA_NOT_AVAILABLE')) {
    throw new Error(`dump is-at-charge-location was not surfaced as DATA_NOT_AVAILABLE: ${unavailable.text}`);
  }

  client.stop();
  console.log('DUMP_OK');
  process.exit(0);
} catch (err) {
  client.kill();
  console.error('DUMP_FAILED:', err instanceof Error ? err.message : err);
  console.error('--- server stderr ---');
  console.error(client.stderr());
  process.exit(1);
}
