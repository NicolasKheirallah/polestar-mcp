/**
 * Agent-facing surface probe. Boots the real server over stdio in fixture mode
 * and measures what a model pays for and what it sees: tool list cost in both
 * configurations, realistic question routing, error actionability, resources,
 * prompts and completions.
 *
 *   node --import tsx analysis/surface/probe-agent.ts
 *
 * Writes only under analysis/surface/evidence/. All non-ASCII is escaped in the
 * output so the tree-wide hygiene check stays green.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcpClient } from '../../scripts/stdio-client.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'analysis', 'surface', 'evidence');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'dump');

const bytes = (v: unknown): number => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v) ?? '', 'utf8');
const tokens = (b: number): number => Math.round(b / 4);

/** JSON with every non-ASCII code point escaped, so hygiene can read the file. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (ch) => {
    const hex = (ch.codePointAt(0) ?? 0).toString(16).padStart(4, '0');
    return `\\u${hex}`;
  });
}

interface BootOptions {
  history?: boolean;
  fixturesDir?: string;
  env?: Record<string, string>;
  capabilities?: Record<string, unknown>;
}

async function boot(opts: BootOptions = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POLESTAR_FIXTURES_DIR: opts.fixturesDir ?? FIXTURES,
    POLESTAR_HISTORY_DIR:
      opts.history === false ? '' : mkdtempSync(path.join(tmpdir(), 'polestar-probe-history-')),
    ...opts.env,
  };
  const client = StdioMcpClient.spawn(['--import', 'tsx', 'src/server.ts'], { cwd: ROOT, env });
  const initMsg = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: opts.capabilities ?? {},
    clientInfo: { name: 'agent-surface-probe', version: '0.0.0' },
  });
  client.notifyInitialized();
  if (initMsg.error) throw new Error(`initialize failed: ${JSON.stringify(initMsg.error)}`);
  const init = initMsg.result as Record<string, unknown>;
  const toolsMsg = await client.request('tools/list', {});
  if (toolsMsg.error) throw new Error(`tools/list failed: ${JSON.stringify(toolsMsg.error)}`);
  const tools = ((toolsMsg.result?.tools ?? []) as Record<string, unknown>[]);
  return { client, init, tools, toolsResult: toolsMsg.result };
}

type Client = Awaited<ReturnType<typeof boot>>['client'];

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.request('tools/call', { name, arguments: args });
  const result = res.result as Record<string, unknown> | undefined;
  const content = (result?.content ?? []) as { type: string; text?: string }[];
  const text = content.map((c) => c.text ?? '').join('\n');
  const structured = result?.structuredContent as Record<string, unknown> | undefined;
  const message = typeof structured?.message === 'string' ? structured.message : '';
  const textBytes = bytes(text);
  const structBytes = bytes(structured);
  const duplicatedBytes = bytes(message);
  const totalBytes = bytes({ content: [{ type: 'text', text }], structuredContent: structured });
  return {
    tool: name,
    args,
    isError: result?.isError === true,
    protocolError: res.error ?? null,
    text,
    textBytes,
    structuredKeys: Object.keys(structured ?? {}),
    structBytes,
    dataBytes: bytes(structured?.data),
    duplicatedBytes,
    duplicateIsExact: message === text,
    duplicateSharePct: totalBytes === 0 ? 0 : Math.round((duplicatedBytes / totalBytes) * 1000) / 10,
    totalJSONBytes: totalBytes,
    wastedTokensEst: tokens(duplicatedBytes),
  };
}

/**
 * A deterministic lexical stand-in for an LLM reading tools/list. It counts
 * whole-token overlap between the question and each tool's name, title and
 * description. It is deliberately dumb: it measures whether the written surface
 * names the words a user uses, not whether a model can infer a synonym.
 */
const STOP = new Set(
  'a an the and or of for to in on at is it my me i do does what when will should before than last lower how why about with into from long'.split(
    ' ',
  ),
);
/** True when two surface words are the same word or an inflection of it. */
function same(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.startsWith(a)) return true;
  if (b.length >= 4 && a.startsWith(b)) return true;
  return false;
}
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}
function scoreTool(questionTokens: string[], tool: Record<string, unknown>) {
  const name = new Set(words(String(tool.name ?? '')));
  const title = new Set(words(String(tool.title ?? '')));
  const desc = new Set(words(String(tool.description ?? '')));
  let score = 0;
  const hits: string[] = [];
  for (const t of questionTokens) {
    if ([...name].some((n) => same(t, n))) { score += 3; hits.push(`${t}:name`); }
    else if ([...title].some((n) => same(t, n))) { score += 2; hits.push(`${t}:title`); }
    else if ([...desc].some((n) => same(t, n))) { score += 1; hits.push(`${t}:desc`); }
  }
  return { score, hits };
}
function rank(question: string, tools: Record<string, unknown>[]) {
  const qTokens = [...new Set(words(question))].filter((w) => !STOP.has(w));
  return tools
    .map((t) => ({ name: String(t.name), ...scoreTool(qTokens, t) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((r) => ({ name: r.name, score: r.score, hits: r.hits }));
}

const report: Record<string, unknown> = {};

// Surface size: what a model pays for once per session.
{
  const defaultRun = await boot({ history: false });
  const historyRun = await boot({ history: true });
  const summarizeTools = (tools: Record<string, unknown>[]) => {
    const per = tools
      .map((t) => {
        const description = String(t.description ?? '');
        const inputSchema = t.inputSchema;
        const outputSchema = t.outputSchema;
        return {
          name: String(t.name),
          title: String(t.title ?? ''),
          descriptionBytes: bytes(description),
          inputSchemaBytes: bytes(inputSchema),
          outputSchemaBytes: bytes(outputSchema),
          annotations: t.annotations,
          required: (inputSchema as { required?: string[] } | undefined)?.required ?? [],
          wholeToolBytes: bytes(t),
        };
      })
      .sort((a, b) => b.wholeToolBytes - a.wholeToolBytes);
    const sum = (pick: (p: typeof per[number]) => number) => per.reduce((a, p) => a + pick(p), 0);
    const resultBytes = bytes(tools.map((t) => t));
    return {
      toolCount: tools.length,
      fullResultBytes: resultBytes,
      fullResultTokensEst: tokens(resultBytes),
      leanBytes: sum((p) => p.descriptionBytes + p.inputSchemaBytes + bytes(p.name)),
      leanTokensEst: tokens(sum((p) => p.descriptionBytes + p.inputSchemaBytes + bytes(p.name))),
      descriptionBytes: sum((p) => p.descriptionBytes),
      inputSchemaBytes: sum((p) => p.inputSchemaBytes),
      outputSchemaBytes: sum((p) => p.outputSchemaBytes),
      descriptionSharePct: Math.round((sum((p) => p.descriptionBytes) / resultBytes) * 1000) / 10,
      outputSchemaSharePct: Math.round((sum((p) => p.outputSchemaBytes) / resultBytes) * 1000) / 10,
      perTool: per,
    };
  };

  const instructions = String(defaultRun.init.instructions ?? '');
  report.initialize = {
    instructionBytes: bytes(instructions),
    instructionTokensEst: tokens(bytes(instructions)),
    instructionWords: instructions.split(/\s+/).filter(Boolean).length,
    resultBytes: bytes(defaultRun.init),
    capabilities: defaultRun.init.capabilities,
    protocolVersion: defaultRun.init.protocolVersion,
  };
  writeFileSync(path.join(OUT, 'tools-list-default.json'), asciiJson(defaultRun.toolsResult) + '\n');
  writeFileSync(path.join(OUT, 'tools-list-history.json'), asciiJson(historyRun.toolsResult) + '\n');
  report.toolsDefault = summarizeTools(defaultRun.tools);
  report.toolsHistory = summarizeTools(historyRun.tools);
  report.toolsAddedByHistory = historyRun.tools
    .filter((t) => !defaultRun.tools.some((d) => d.name === t.name))
    .map((t) => ({
      name: String(t.name),
      wholeToolBytes: bytes(t),
      descriptionBytes: bytes(String(t.description ?? '')),
    }));

  // prompts
  const promptList = await historyRun.client.request('prompts/list', {});
  const prompts = ((promptList.result?.prompts ?? []) as Record<string, unknown>[]);
  const promptDetails = [];
  for (const p of prompts) {
    const got = await historyRun.client.request('prompts/get', { name: p.name, arguments: {} });
    const messages = ((got.result?.messages ?? []) as { content?: { text?: string } }[]);
    const text = messages.map((m) => m.content?.text ?? '').join('\n');
    promptDetails.push({
      name: String(p.name),
      title: String(p.title ?? ''),
      descriptionBytes: bytes(String(p.description ?? '')),
      argumentCount: ((p.arguments ?? []) as unknown[]).length,
      messageBytes: bytes(text),
      messageTokensEst: tokens(bytes(text)),
      messageText: text,
    });
  }
  report.prompts = {
    count: prompts.length,
    listResultBytes: bytes(promptList.result),
    perPrompt: promptDetails,
  };

  // resources
  const resList = await historyRun.client.request('resources/list', {});
  const resources = ((resList.result?.resources ?? []) as Record<string, unknown>[]);
  const tplList = await historyRun.client.request('resources/templates/list', {});
  const readMsg = await historyRun.client.request('resources/read', {
    uri: 'polestar://vehicle/YSMTEST22PL000001/telemetry/battery',
  });
  const readText = ((readMsg.result?.contents ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('');
  const toolBattery = await call(historyRun.client, 'get_battery');
  report.resources = {
    count: resources.length,
    listResultBytes: bytes(resList.result),
    templates: tplList.result?.resourceTemplates,
    readResultBytes: bytes(readMsg.result),
    readTextBytes: bytes(readText),
    readMatchesToolText: readText === toolBattery.text,
    readMimeType: ((readMsg.result?.contents ?? []) as { mimeType?: string }[])[0]?.mimeType,
    sampleResource: resources[0],
  };

  // completions
  const completions = [];
  for (const probe of [
    { ref: { type: 'ref/resource', uri: 'polestar://vehicle/{vin}/telemetry/{domain}' }, argument: { name: 'vin', value: 'YSM' } },
    { ref: { type: 'ref/resource', uri: 'polestar://vehicle/{vin}/telemetry/{domain}' }, argument: { name: 'domain', value: 'bat' } },
    { ref: { type: 'ref/resource', uri: 'polestar://vehicle/{vin}/charging/{domain}' }, argument: { name: 'domain', value: 'char' } },
    { ref: { type: 'ref/resource', uri: 'polestar://vehicle/{vin}/telemetry/{domain}' }, argument: { name: 'domain', value: 'zzz' } },
    { ref: { type: 'ref/prompt', name: 'car-status' }, argument: { name: 'vin', value: 'YSM' } },
  ]) {
    const got = await historyRun.client.request('completion/complete', probe);
    completions.push({
      probe: probe.argument,
      error: got.error ?? null,
      values: (got.result as { completion?: { values?: unknown[]; total?: number } } | undefined)?.completion?.values ?? null,
    });
  }
  report.completions = completions;

  report.sessionCost = {
    initializeResultBytes: bytes(historyRun.init),
    toolsListResultBytes: bytes(historyRun.toolsResult),
    promptsListResultBytes: bytes(promptList.result),
    resourcesListResultBytes: bytes(resList.result),
    resourceTemplatesResultBytes: bytes(tplList.result),
    totalBytes:
      bytes(historyRun.init) +
      bytes(historyRun.toolsResult) +
      bytes(promptList.result) +
      bytes(resList.result) +
      bytes(tplList.result),
  };

  // realistic questions, ranked from the tool list a model actually receives
  const questions = [
    { id: 'q1', question: 'how is my car doing', expect: ['get_car_status'] },
    { id: 'q2', question: 'is it plugged in and when will it be full', expect: ['get_battery', 'get_charging_estimate'] },
    { id: 'q3', question: 'what should I check before a long trip', expect: ['get_needs_attention', 'get_car_status'] },
    { id: 'q4', question: 'why is my range lower than last month', expect: ['get_degradation_report'] },
    { id: 'q5', question: 'plan cheap charging for tonight', expect: ['plan_cheapest_charge'] },
  ];
  const routed = questions.map((q) => {
    const defaultRank = rank(q.question, defaultRun.tools);
    const historyRank = rank(q.question, historyRun.tools);
    const bestDefault = defaultRank[0]?.name;
    const bestHistory = historyRank[0]?.name;
    return {
      ...q,
      defaultToolsRanked: defaultRank,
      historyToolsRanked: historyRank,
      expectedPresentInDefault: q.expect.some((e) => defaultRun.tools.some((t) => t.name === e)),
      expectedPresentInHistory: q.expect.some((e) => historyRun.tools.some((t) => t.name === e)),
      defaultTopPick: bestDefault,
      historyTopPick: bestHistory,
      defaultHit: bestDefault !== undefined && q.expect.includes(bestDefault),
      historyHit: bestHistory !== undefined && q.expect.includes(bestHistory),
    };
  });
  report.questionRouting = routed;

  // Vocabulary coverage: which user words exist anywhere on the surface.
  const vocabulary = [
    'plugged', 'charger', 'connection', 'time to full', 'target',
    'month', 'history', 'trend', 'degradation', 'since',
    'trip', 'journey', 'drive', 'attention', 'warning', 'health', 'secure',
    'cheapest', 'price', 'schedule', 'tonight', 'cost',
    'range', 'range km', 'consumption', 'weather', 'traffic',
  ];
  const coverage = vocabulary.map((term) => {
    const matches = historyRun.tools
      .filter((t) => `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase().includes(term))
      .map((t) => String(t.name));
    return {
      term,
      toolCount: matches.length,
      tools: matches,
      presentInDefault: matches.some((m) => defaultRun.tools.some((t) => t.name === m)),
    };
  });
  report.vocabulary = coverage;

  // the calls those questions lead to, and what the agent gets back
  const flows: Record<string, unknown> = {};
  flows.q1 = [await call(historyRun.client, 'get_car_status')];
  flows.q2 = [await call(historyRun.client, 'get_battery'), await call(historyRun.client, 'get_charging_estimate')];
  flows.q3 = [await call(historyRun.client, 'get_needs_attention')];
  flows.q4_historyEnabled = [await call(historyRun.client, 'get_degradation_report')];
  flows.q4_defaultConfig = [await call(defaultRun.client, 'get_battery')];
  const hourlyPrices = Array.from({ length: 24 }, (_, i) => ({
    startsAt: new Date(Date.UTC(2026, 1, 1, i)).toISOString(),
    price: i >= 22 || i <= 5 ? 0.12 : 0.31,
  }));
  flows.q5 = [
    await call(historyRun.client, 'plan_cheapest_charge', { prices: hourlyPrices }),
  ];
  flows.q5RetryWithCapacity = [
    await call(historyRun.client, 'plan_cheapest_charge', { prices: hourlyPrices, capacityKwh: 78 }),
  ];
  // Prices anchored to the next 12 hours, the only shape the planner can match.
  const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const relativePrices = Array.from({ length: 24 }, (_, i) => ({
    startsAt: new Date(nextHour + i * 3_600_000).toISOString(),
    price: i >= 22 || i <= 5 ? 0.12 : 0.31,
  }));
  flows.q5RelativePrices = [
    await call(historyRun.client, 'plan_cheapest_charge', { prices: relativePrices, capacityKwh: 78 }),
  ];
  report.flowCalls = flows;
  report.flowCallList = (Object.values(flows).flat() as Awaited<ReturnType<typeof call>>[]).map((c) => ({
    tool: c.tool,
    isError: c.isError,
    textBytes: c.textBytes,
    structBytes: c.structBytes,
    duplicatedBytes: c.duplicatedBytes,
    duplicateIsExact: c.duplicateIsExact,
    duplicateSharePct: c.duplicateSharePct,
    wastedTokensEst: c.wastedTokensEst,
  }));

  // Error surface: what the agent is told when a call cannot succeed.
  const errors: Record<string, unknown> = {};
  errors.badVin = await call(historyRun.client, 'get_battery', { vin: 'NOTAVIN' });
  errors.unknownDomain = await call(historyRun.client, 'get_history', { domain: 'telemetry/nope' });
  errors.unknownTool = await call(historyRun.client, 'get_tyre_pressure');
  errors.unknownArgument = await call(historyRun.client, 'get_battery', { tyre: 1 });
  errors.rawDuplication = await call(historyRun.client, 'get_battery', { raw: true });
  report.errors = errors;

  defaultRun.client.stop();
  historyRun.client.stop();
}

// Multi-vehicle fixture: does the server ask, and what does the agent see?
{
  const multi = mkdtempSync(path.join(tmpdir(), 'polestar-multi-'));
  cpSync(FIXTURES, multi, { recursive: true });
  writeFileSync(
    path.join(multi, 'dataportal', 'vehicles.json'),
    JSON.stringify({ data: ['YSMTEST22PL000001', 'YSMTEST22PL000002'], meta: { count: 2 } }),
  );

  const withElicit = await boot({ history: false, fixturesDir: multi, capabilities: { elicitation: {} } });
  withElicit.client.answerElicitation({ vin: 'YSMTEST22PL000001' });
  const asked = await call(withElicit.client, 'get_battery', {});
  withElicit.client.stop();

  const declined = await boot({ history: false, fixturesDir: multi, capabilities: { elicitation: {} } });
  declined.client.answerElicitation({ action: 'decline' });
  const refused = await call(declined.client, 'get_battery', {});
  declined.client.stop();

  const noCapability = await boot({ history: false, fixturesDir: multi, capabilities: {} });
  const ambiguous = await call(noCapability.client, 'get_battery', {});
  noCapability.client.stop();

  report.multiVehicle = {
    elicitationWire: await captureElicitation(multi),
    vehicleCount: 2,
    elicitationAccepted: asked,
    elicitationDeclined: refused,
    noElicitationCapability: ambiguous,
  };
  rmSync(multi, { recursive: true, force: true });
}

// Budget exhaustion: reachable offline through a local HTTP stub of the upstream API.
{
  const battery = JSON.parse(
    await (await import('node:fs/promises')).readFile(path.join(FIXTURES, 'dataportal', 'telemetry', 'battery.json'), 'utf8'),
  ) as unknown;
  const fake = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && req.url === '/token') {
      send(200, { accessToken: 'offline-probe-token', expiresIn: 3600, tokenType: 'Bearer' });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/vehicles') {
      send(200, { data: ['YSMTEST22PL000001'], meta: { count: 1 } });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/vehicles/YSMTEST22PL000001/telemetry/battery') {
      send(200, battery);
      return;
    }
    send(404, { error: { code: 'NOT_FOUND', message: 'probe route not handled' } });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const address = fake.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const live = await boot({
    history: false,
    fixturesDir: '',
    env: {
      POLESTAR_FIXTURES_DIR: '',
      POLESTAR_BASE_URL: base,
      POLESTAR_M2M_TOKEN_ENDPOINT: `${base}/token`,
      POLESTAR_CLIENT_ID: 'offline-probe-client',
      POLESTAR_CLIENT_SECRET: 'offline-probe-secret',
      POLESTAR_ACCOUNT_ID: 'offline-probe-account',
      POLESTAR_BUDGET: '1',
    },
  });
  const first = await call(live.client, 'list_vehicles');
  const second = await call(live.client, 'get_battery');
  const third = await call(live.client, 'get_battery');
  const status = await call(live.client, 'polestar_status');
  live.client.stop();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  report.budgetExhaustion = {
    configuredLimit: 1,
    firstCall: { tool: first.tool, isError: first.isError, text: first.text },
    secondCall: { tool: second.tool, isError: second.isError, text: second.text, structuredKeys: second.structuredKeys },
    thirdCall: { tool: third.tool, isError: third.isError, text: third.text },
    statusAfter: { isError: status.isError, text: status.text },
  };
}

// Duplicate measurement across every tool result measured above.
{
  const calls = [
    ...(Object.values(report.flowCalls as Record<string, { tool: string; textBytes: number; structBytes: number; duplicatedBytes: number; duplicateSharePct: number; wastedTokensEst: number }[]>).flat()),
  ];
  const totalBytes = calls.reduce((a, c) => a + c.textBytes + c.structBytes, 0);
  const duplicated = calls.reduce((a, c) => a + c.duplicatedBytes, 0);
  report.duplication = {
    measuredCalls: calls.length,
    sumTextBytes: calls.reduce((a, c) => a + c.textBytes, 0),
    sumStructBytes: calls.reduce((a, c) => a + c.structBytes, 0),
    sumDuplicatedBytes: duplicated,
    duplicatedShareOfPayloadPct: totalBytes === 0 ? 0 : Math.round((duplicated / totalBytes) * 1000) / 10,
    wastedTokensEst: tokens(duplicated),
    perCall: calls.map((c) => ({
      tool: c.tool,
      textBytes: c.textBytes,
      structBytes: c.structBytes,
      duplicatedBytes: c.duplicatedBytes,
      duplicateSharePct: c.duplicateSharePct,
      wastedTokensEst: c.wastedTokensEst,
    })),
  };
}

/**
 * A raw stdio exchange, used only to record the exact server-initiated
 * elicitation request: what the agent is asked when a credential sees more
 * than one vehicle.
 */
async function captureElicitation(fixturesDir: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, POLESTAR_FIXTURES_DIR: fixturesDir, POLESTAR_HISTORY_DIR: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const serverRequests: unknown[] = [];
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      serverRequests.push({ method: msg.method, params: msg.params });
      child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content: { vin: 'YSMTEST22PL000001' } } }) + '\n',
      );
      return;
    }
    if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
  });
  let nextId = 1;
  const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { elicitation: {} },
    clientInfo: { name: 'raw-elicitation-probe', version: '0' },
  });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const callResult = await request('tools/call', { name: 'get_battery', arguments: {} });
  child.kill('SIGTERM');
  const result = callResult.result as Record<string, unknown> | undefined;
  return {
    serverRequests,
    callResult: {
      isError: result?.isError === true,
      text: ((result?.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('\n'),
    },
  };
}

writeFileSync(path.join(OUT, 'runtime-probe.json'), asciiJson(report) + '\n');

const show = {
  initialize: report.initialize,
  toolsDefault: {
    toolCount: (report.toolsDefault as Record<string, unknown>).toolCount,
    fullResultBytes: (report.toolsDefault as Record<string, unknown>).fullResultBytes,
    fullResultTokensEst: (report.toolsDefault as Record<string, unknown>).fullResultTokensEst,
    descriptionBytes: (report.toolsDefault as Record<string, unknown>).descriptionBytes,
    outputSchemaBytes: (report.toolsDefault as Record<string, unknown>).outputSchemaBytes,
    leanTokensEst: (report.toolsDefault as Record<string, unknown>).leanTokensEst,
  },
  toolsHistory: {
    toolCount: (report.toolsHistory as Record<string, unknown>).toolCount,
    fullResultBytes: (report.toolsHistory as Record<string, unknown>).fullResultBytes,
    fullResultTokensEst: (report.toolsHistory as Record<string, unknown>).fullResultTokensEst,
  },
  questionRouting: (report.questionRouting as { id: string; question: string; defaultTopPick: string; historyTopPick: string; defaultHit: boolean; historyHit: boolean; expectedPresentInDefault: boolean }[]).map(
    (q) => ({ id: q.id, question: q.question, defaultTopPick: q.defaultTopPick, historyTopPick: q.historyTopPick, defaultHit: q.defaultHit, historyHit: q.historyHit, expectedPresentInDefault: q.expectedPresentInDefault }),
  ),
  vocabularyGaps: (report.vocabulary as { term: string; toolCount: number; tools: string[] }[]).filter(
    (v) => v.toolCount === 0 || v.term === 'plugged' || v.term === 'month' || v.term === 'trip',
  ),
  q5Retry: (report.flowCalls as Record<string, { text: string; textBytes: number; isError: boolean }[]>).q5RetryWithCapacity,
  q5RelativePrices: (report.flowCalls as Record<string, { text: string; textBytes: number; isError: boolean }[]>).q5RelativePrices,
  duplication: report.duplication,
  multiVehicle: {
    elicitationWire: (report.multiVehicle as Record<string, unknown>).elicitationWire,
    accepted: (report.multiVehicle as Record<string, { text: string; isError: boolean }>).elicitationAccepted,
    declined: (report.multiVehicle as Record<string, { text: string; isError: boolean }>).elicitationDeclined,
    noCapability: (report.multiVehicle as Record<string, { text: string; isError: boolean }>).noElicitationCapability,
  },
  budgetExhaustion: report.budgetExhaustion,
  errors: Object.fromEntries(
    Object.entries(report.errors as Record<string, { tool: string; isError: boolean; text: string }>).map(([k, v]) => [k, { tool: v.tool, isError: v.isError, text: v.text }]),
  ),
};
console.log(JSON.stringify(show, null, 2));
const dup = report.duplication as { duplicatedShareOfPayloadPct: number; wastedTokensEst: number };
console.log(
  `PROBE_OK tools=${(report.toolsDefault as Record<string, number>).toolCount}/${(report.toolsHistory as Record<string, number>).toolCount} toolsListBytes=${(report.toolsHistory as Record<string, number>).fullResultBytes + 10} duplicateSharePct=${dup.duplicatedShareOfPayloadPct} wastedTokensEst=${dup.wastedTokensEst}`,
);
