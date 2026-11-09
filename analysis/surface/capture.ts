/**
 * Audit capture: spawn the real server over stdio in fixture mode and dump the
 * actual protocol frames plus byte/token measurements. Read-only; writes only
 * under analysis/surface/evidence/.
 *
 *   node --import tsx analysis/surface/capture.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcpClient } from '../../scripts/stdio-client.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'analysis', 'surface', 'evidence');

const client = StdioMcpClient.spawn(['--import', 'tsx', 'src/server.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    POLESTAR_FIXTURES_DIR: path.join(ROOT, 'test', 'fixtures', 'dump'),
    POLESTAR_HISTORY_DIR: mkdtempSync(path.join(tmpdir(), 'polestar-audit-history-')),
  },
});

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
// Token estimate used throughout: ~4 UTF-8 bytes/token for English JSON.
const tok = (v: unknown): number => Math.round(bytes(v) / 4);

const report: Record<string, unknown> = {};

try {
  const initMsg = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'audit', version: '0.0.0' },
  });
  client.notifyInitialized();

  // --- initialize result: instructions are paid once per session, not per turn,
  // but they are still part of the surface. Measure them.
  const initResult = initMsg.result as Record<string, unknown>;
  report.initialize = {
    resultBytes: bytes(initResult),
    instructionsBytes: Buffer.byteLength(String(initResult?.instructions ?? ''), 'utf8'),
    capabilities: initResult?.capabilities,
    serverInfo: initResult?.serverInfo,
    protocolVersion: initResult?.protocolVersion,
  };
  writeFileSync(path.join(OUT, 'initialize.json'), JSON.stringify(initMsg, null, 2) + '\n');

  // --- tools/list: the recurring tax.
  const toolsMsg = await client.request('tools/list', {});
  const tools = (toolsMsg.result?.tools ?? []) as Record<string, unknown>[];
  writeFileSync(path.join(OUT, 'tools-list.json'), JSON.stringify(toolsMsg, null, 2) + '\n');
  const descs = tools.map((t) => ({
    name: String(t.name),
    title: String(t.title ?? ''),
    descriptionLength: String(t.description ?? '').length,
    descriptionBytes: Buffer.byteLength(String(t.description ?? ''), 'utf8'),
    toolBytes: bytes(t),
    inputSchemaBytes: bytes(t.inputSchema),
    outputSchemaBytes: bytes(t.outputSchema),
    annotations: t.annotations,
    required: (t.inputSchema as { required?: string[] } | undefined)?.required ?? [],
  }));
  report.toolsList = {
    toolCount: tools.length,
    fullResultBytes: bytes(toolsMsg.result),
    fullResultTokensEst: tok(toolsMsg.result),
    totalDescriptionBytes: descs.reduce((a, d) => a + d.descriptionBytes, 0),
    totalOutputSchemaBytes: descs.reduce((a, d) => a + d.outputSchemaBytes, 0),
    totalInputSchemaBytes: descs.reduce((a, d) => a + d.inputSchemaBytes, 0),
    perTool: descs.sort((a, b) => b.toolBytes - a.toolBytes),
  };

  // --- tools/call measurements.
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const msg = await client.callTool(name, args);
    const textBytes = Buffer.byteLength(msg.text, 'utf8');
    const structBytes = bytes(msg.structuredContent);
    // Duplicate payload: the structured `message` is the text block again.
    const messageValue = msg.structuredContent?.message;
    const duplicatedBytes =
      typeof messageValue === 'string' ? Buffer.byteLength(messageValue, 'utf8') : 0;
    return {
      name,
      args,
      isError: msg.isError,
      textForReading: msg.text,
      structuredKeys: Object.keys(msg.structuredContent ?? {}),
      textBytes,
      structBytes,
      duplicatedBytes,
      totalJSONBytes: bytes({ content: [{ type: 'text', text: msg.text }], structuredContent: msg.structuredContent, isError: msg.isError }),
    };
  };
  const calls = [
    await call('get_car_status'),
    await call('get_battery'),
    await call('get_availability'),
    await call('get_pre_cleaning'),
    await call('polestar_status'),
    await call('get_history', { domain: 'telemetry/battery' }),
    await call('list_vehicles'),
    await call('list_domains'),
    await call('get_battery', { vin: 'NOTAVIN' }),
    await call('get_history', { domain: 'telemetry/nope' }),
    await call('plan_cheapest_charge', {
      prices: Array.from({ length: 24 }, (_, i) => ({
        startsAt: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
        price: 0.5 + (i % 6) * 0.1,
      })),
    }),
  ];
  report.calls = calls;
  writeFileSync(path.join(OUT, 'calls.json'), JSON.stringify(calls, null, 2) + '\n');

  // --- resources + prompts listings.
  const resMsg = await client.request('resources/list', {});
  const tplMsg = await client.request('resources/templates/list', {});
  const promptsMsg = await client.request('prompts/list', {});
  writeFileSync(path.join(OUT, 'resources-list.json'), JSON.stringify(resMsg, null, 2) + '\n');
  writeFileSync(path.join(OUT, 'resource-templates.json'), JSON.stringify(tplMsg, null, 2) + '\n');
  writeFileSync(path.join(OUT, 'prompts-list.json'), JSON.stringify(promptsMsg, null, 2) + '\n');
  report.listing = {
    resourcesListBytes: bytes(resMsg.result),
    resourcesListCount: ((resMsg.result?.resources ?? []) as unknown[]).length,
    resourceTemplatesBytes: bytes(tplMsg.result),
    resourceTemplateCount: ((tplMsg.result?.resourceTemplates ?? []) as unknown[]).length,
    promptsBytes: bytes(promptsMsg.result),
    promptCount: ((promptsMsg.result?.prompts ?? []) as unknown[]).length,
  };

  // --- completions: does the server answer them?
  const completionMsg = await client.request('completion/complete', {
    ref: { type: 'ref/resource', uri: 'polestar://vehicle/{vin}/telemetry/{domain}' },
    argument: { name: 'vin', value: 'YSM' },
  });
  report.completion = { result: completionMsg.result, error: completionMsg.error };

  // --- resources/read: text/plain body, same bytes as the tool text.
  const readMsg = await client.request('resources/read', {
    uri: 'polestar://vehicle/YSMTEST22PL000001/telemetry/battery',
  });
  writeFileSync(path.join(OUT, 'resource-read.json'), JSON.stringify(readMsg, null, 2) + '\n');
  report.resourceRead = { bytes: bytes(readMsg.result), result: readMsg.result };

  // --- cancellation: send a request then a cancelled notification; server must survive.
  const cancelProbe = await client.request('tools/list', {});
  report.afterProbes = { toolsStillListed: ((cancelProbe.result?.tools ?? []) as unknown[]).length };

  writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  client.stop();
}
