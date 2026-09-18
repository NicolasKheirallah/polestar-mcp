/**
 * End-to-end MCP stdio smoke test over the full surface: handshake, the
 * complete tool registry (domains + aggregates + advisor + system + history),
 * tool annotations, humanized output with optional-vin resolution, resources
 * with templates, prompts, graceful DATA_NOT_AVAILABLE, and unknown-tool
 * rejection. Runs in fixture mode with history enabled. Prints SMOKE_OK only
 * after every assertion passes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DOMAINS, toolName } from '../src/domains.js';
import { historyToolNames } from '../src/history-tools.js';
import { StdioMcpClient } from './stdio-client.js';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const VIN = 'YSMTEST22PL000001';

const aggregateTools = [
  'list_vehicles',
  'list_domains',
  'get_car_status',
  'is_car_secure',
  'get_needs_attention',
  'get_charging_estimate',
  'plan_cheapest_charge',
  'polestar_status',
];

const client = StdioMcpClient.spawn(['--import', 'tsx', 'src/server.ts'], {
  cwd: PROJECT_ROOT,
  env: {
    ...process.env,
    POLESTAR_FIXTURES_DIR: path.join(PROJECT_ROOT, 'test', 'fixtures', 'dump'),
    POLESTAR_HISTORY_DIR: mkdtempSync(path.join(tmpdir(), 'polestar-smoke-history-')),
  },
});

try {
  await client.initialize('polestar-mcp');

  // Tool registry: every domain tool + aggregates + history tools.
  const tools0 = await client.request('tools/list', {});
  const toolNames = ((tools0.result?.tools as { name: string }[] | undefined) ?? []).map((t) => t.name);
  const expected = new Set<string>([...aggregateTools, ...DOMAINS.map(toolName), ...historyToolNames]);
  const actual = new Set<string>(toolNames);
  if (actual.size !== expected.size || ![...expected].every((n) => actual.has(n))) {
    throw new Error(
      `tool mismatch:\nexpected: ${[...expected].sort().join(', ')}\nactual:   ${[...actual].sort().join(', ')}`,
    );
  }

  // Contract: every tool declares its output shape and read-only nature,
  // and every callable-with-no-arguments tool actually returns matching
  // structured content. Text is for the model; structure is for the client.
  const listed = ((tools0.result?.tools ?? []) as { name: string; inputSchema?: { required?: string[] }; outputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }[]);
  const missingSchema = listed.filter((t) => t.outputSchema === undefined).map((t) => t.name);
  if (missingSchema.length > 0) throw new Error(`tools without outputSchema: ${missingSchema.join(', ')}`);
  const missingShape = listed
    .filter((t) => { const o = t.outputSchema as { properties?: Record<string, unknown> } | undefined; return o?.properties?.ok === undefined || o.properties.message === undefined; })
    .map((t) => t.name);
  if (missingShape.length > 0) throw new Error(`outputSchema missing ok/message: ${missingShape.join(', ')}`);
  const noAnnotations = listed.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
  if (noAnnotations.length > 0) throw new Error(`tools without readOnlyHint: ${noAnnotations.join(', ')}`);
  const callable = listed.filter((t) => (t.inputSchema?.required ?? []).length === 0).map((t) => t.name);
  for (const name of callable) {
    const r = await client.callTool(name);
    const sc = r.structuredContent;
    if (r.isError) throw new Error(`${name} failed on a no-argument call: ${r.text}`);
    if (sc?.ok !== true || typeof sc.message !== 'string' || sc.message.length === 0) {
      throw new Error(`${name} returned no structured ok/message envelope: ${JSON.stringify(r.structuredContent)}`);
    }
    if (r.structuredContent?.message !== r.text) throw new Error(`${name}: structuredContent.message diverged from content text`);
  }
  process.stderr.write(`registry: ${listed.length} tools, ${callable.length} callable with no args\n`);

  // Annotations: reads declare themselves side-effect-free.
  const toolsRaw = tools0;
  if (!JSON.stringify(toolsRaw.result).includes('"readOnlyHint":true')) {
    throw new Error('tools/list does not carry readOnlyHint annotations');
  }

  // Optional VIN: resolveVin defaults to the single fixture vehicle.
  const battery = await client.callTool('get_battery', {});
  if (!battery.text.includes('Charge: 52%') || !battery.text.includes('range 170 km') || !battery.text.includes('data observed')) {
    throw new Error(`get_battery (no vin) did not humanize the fixture state: ${battery.text}`);
  }

  // Humanized aggregate over cached domain reads.
  const status = await client.callTool('get_car_status', {});
  if (!status.text.includes('Car status') || !status.text.includes('52%')) {
    throw new Error(`get_car_status did not humanize: ${status.text}`);
  }

  // Resources: templates listed, and a read resolves humanized text.
  const resources = await client.request('resources/list', {});
  const resourceList = resources.result?.resources as { uri: string }[] | undefined;
  const uris = new Set((resourceList ?? []).map((r) => r.uri));
  if (!uris.has(`polestar://vehicle/${VIN}/telemetry/battery`)) {
    throw new Error(`resources/list missing battery URI (got ${uris.size} entries)`);
  }
  const read = await client.request('resources/read', { uri: `polestar://vehicle/${VIN}/telemetry/battery` });
  const readText = JSON.stringify(read.result);
  if (!readText.includes('Charge:')) throw new Error(`resources/read did not humanize battery: ${readText.slice(0, 200)}`);

  // A failed resource read renders like a failed tool call: the shared text carries
  // the code and, when upstream gave one, the requestId.
  const badRead = await client.request('resources/read', { uri: 'polestar://vehicle/NOTAVALIDVIN1234567/telemetry/battery' });
  const badText = JSON.stringify(badRead.result ?? badRead.error ?? {});
  if (!badText.includes('Polestar API error') || !/INVALID_VIN|VIN_NOT_FOUND|DATA_NOT_AVAILABLE|NOT_FOUND/.test(badText)) {
    throw new Error(`resources/read error did not render through the shared failure text: ${badText.slice(0, 240)}`);
  }

  // Prompts: three starters registered and retrievable.
  const prompts = await client.request('prompts/list', {});
  const promptNames = ((prompts.result?.prompts as { name: string }[] | undefined) ?? []).map((p) => p.name).sort();
  if (JSON.stringify(promptNames) !== JSON.stringify(['battery-health-report', 'car-status', 'charge-plan'])) {
    throw new Error(`prompt mismatch: ${promptNames.join(', ')}`);
  }

  // History: fixture reads flowed into the store (recorder hook).
  const history = await client.callTool('get_history', { domain: 'telemetry/battery' });
  if (history.isError || !history.text.includes('"batteryChargeLevelPercentage":52')) {
    throw new Error(`get_history returned nothing from the recorder: ${history.text}`);
  }

  // Graceful degradation + unknown tool rejection. MCP reports tool
  // failures either as a JSON-RPC error or as an in-band isError result.
  const unavailable = await client.callTool('get_is_at_charge_location', { vin: VIN });
  if (unavailable.isError || unavailable.protocolError || !unavailable.text.includes('DATA_NOT_AVAILABLE')) {
    throw new Error(`DATA_NOT_AVAILABLE was not surfaced gracefully: ${unavailable.text}`);
  }
  const unknown = await client.callTool('no_such_tool');
  if (!unknown.isError && !unknown.protocolError) {
    throw new Error(`unknown tool call was not rejected cleanly: ${unknown.text}`);
  }

  // System status: budget + cache visible to the agent.
  const sys = await client.callTool('polestar_status', {});
  if (!sys.text.includes('API budget:') || !sys.text.includes('fixture')) {
    throw new Error(`polestar_status did not self-report: ${sys.text}`);
  }

  client.stop();
  console.log('SMOKE_OK');
  process.exit(0);
} catch (err) {
  client.kill();
  console.error('SMOKE_FAILED:', err instanceof Error ? err.message : err);
  console.error('--- server stderr ---');
  console.error(client.stderr());
  process.exit(1);
}
