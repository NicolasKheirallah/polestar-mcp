import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildEngine, createMcpServer, type Engine } from '../src/server.js';
import { PolestarApiError } from '../src/client.js';
import { errorResult, resultSchema, text, withData } from '../src/tool-output.js';

/**
 * The envelope contract a client sees on the wire, asserted through the real
 * McpServer: argument validation, the shared output schema and its byte budget,
 * the text-once rule, and the annotations that decide auto-approval.
 *
 * The transports are the SDK's linked in-memory pair, so every request goes
 * through the same registration and validation path stdio uses without paying
 * for a child process per case.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DUMP = path.join(ROOT, 'test', 'fixtures', 'dump');

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolListing {
  name: string;
  description?: string;
  inputSchema?: { required?: string[]; additionalProperties?: boolean; properties?: Record<string, unknown> };
  outputSchema?: { required?: string[]; properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean; idempotentHint?: boolean };
}

interface CallOutcome {
  text: string;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
  protocolError?: { code: number; message: string };
}

class LoopbackClient {
  private readonly pending = new Map<number, (message: RpcMessage) => void>();
  private nextId = 1;

  constructor(private readonly transport: InMemoryTransport) {
    transport.onmessage = (message) => {
      const id = (message as RpcMessage).id;
      if (typeof id !== 'number') return;
      const resolve = this.pending.get(id);
      if (resolve === undefined) return;
      this.pending.delete(id);
      resolve(message as RpcMessage);
    };
  }

  async initialize(): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'envelope-test', version: '0.0.0' },
    });
    if (init.error !== undefined) throw new Error(`initialize failed: ${init.error.message}`);
    await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  request(method: string, params?: Record<string, unknown>): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      void this.transport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  async listTools(): Promise<{ tools: ToolListing[]; bytes: number }> {
    const res = await this.request('tools/list', {});
    if (res.error !== undefined) throw new Error(`tools/list failed: ${res.error.message}`);
    const tools = (res.result?.tools ?? []) as ToolListing[];
    // The measured unit is the JSON-RPC result a client receives and pays for.
    return { tools, bytes: JSON.stringify(res.result ?? {}).length };
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error !== undefined) return { text: '', isError: true, protocolError: res.error };
    const content = (res.result?.content ?? []) as { type: string; text?: string }[];
    return {
      text: content.map((c) => c.text ?? '').join('\n'),
      isError: res.result?.isError === true,
      ...(res.result?.structuredContent === undefined
        ? {}
        : { structuredContent: res.result.structuredContent as Record<string, unknown> }),
    };
  }
}

interface Surface {
  engine: Engine;
  client: LoopbackClient;
  close(): Promise<void>;
}

async function startSurface(options: { history?: boolean } = {}): Promise<Surface> {
  const engine = buildEngine({
    POLESTAR_FIXTURES_DIR: DUMP,
    ...(options.history === true
      ? { POLESTAR_HISTORY_DIR: mkdtempSync(path.join(tmpdir(), 'polestar-envelope-')) }
      : { POLESTAR_HISTORY_DIR: undefined }),
  });
  const surface = createMcpServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await surface.server.connect(serverTransport);
  await clientTransport.start();
  const client = new LoopbackClient(clientTransport);
  await client.initialize();
  return {
    engine,
    client,
    async close() {
      await clientTransport.close();
      await surface.close();
    },
  };
}

test('an unknown argument key is refused by name through the real server', async () => {
  const surface = await startSurface();
  try {
    const refused = await surface.client.callTool('get_battery', { vinn: 'YSMTEST22PL000001' });
    assert.equal(refused.isError, true, 'the call must fail rather than strip vinn and answer about the default car');
    const detail = refused.protocolError?.message ?? refused.text;
    assert.match(detail, /vinn/, 'the refusal names the misspelled key');
    assert.match(detail, /unrecognized key/i);

    const valid = await surface.client.callTool('get_battery', { vin: 'YSMTEST22PL000001' });
    assert.notEqual(valid.isError, true, 'a valid call still works');
    assert.match(valid.text, /Charge: 52%/);
  } finally {
    await surface.close();
  }
});

test('tools/list fits its budget and keeps one compact output schema on every tool', async () => {
  const standard = await startSurface();
  const withHistory = await startSurface({ history: true });
  try {
    const listed = await standard.client.listTools();
    const extended = await withHistory.client.listTools();

    // Wave 2 grew the default surface from 23 to 26 tools (list_vehicle_domains,
    // get_charging_setup, get_departure_readiness) and the history surface from
    // 26 to 36 (seven settings and analytics tools plus the trip, timeline and
    // digest tools). The ceilings were re-measured rather than carried over:
    // 34,723 bytes default and 50,420 with history. The default keeps 36,000 so
    // a small description change does not trip the gate, and history keeps
    // 55,000 for the same reason now that its ten tools are all present.
    assert.equal(listed.tools.length, 26, 'the default surface is 26 tools after the wave 2 additions');
    assert.ok(
      extended.tools.length >= 36,
      `history adds tools on top of the default surface, saw ${extended.tools.length}`,
    );

    assert.ok(
      listed.bytes < 36_000,
      `default tools/list result is ${listed.tools.length} tools at ${listed.bytes} bytes, budget is 36,000`,
    );
    assert.ok(
      extended.bytes < 55_000,
      `history tools/list result is ${extended.tools.length} tools at ${extended.bytes} bytes, budget is 55,000`,
    );

    for (const tool of [...listed.tools, ...extended.tools]) {
      assert.ok(tool.outputSchema !== undefined, `${tool.name} declares an output schema`);
    }
    // Per-tool description economy: the routing text for one tool should not cost
    // a session more than the largest tool does today (get_battery, 532 bytes).
    // A tool that grows past this is a decision, not a refactor.
    for (const tool of listed.tools) {
      const length = tool.description?.length ?? 0;
      assert.ok(length < 700, `${tool.name} description is ${length} bytes, per-tool ceiling is 700`);
    }
    const descriptionBytes = listed.tools.reduce((sum, tool) => sum + (tool.description?.length ?? 0), 0);
    assert.ok(
      descriptionBytes < 6_500,
      `default tool descriptions total ${descriptionBytes} bytes, ceiling is 6,500 (5,752 at 26 tools)`,
    );

    // One shared schema, converted once per tool by the SDK. The point is that it
    // is the same small shape: 401 bytes with the field descriptions dropped,
    // against 1,009 when every field carried one.
    const serialised = new Set([...listed.tools, ...extended.tools].map((tool) => JSON.stringify(tool.outputSchema)));
    assert.equal(serialised.size, 1, 'every tool advertises the same shared envelope');
    const schema = [...serialised][0] as string;
    assert.ok(schema.length < 500, `the shared output schema is ${schema.length} bytes`);

    const parsed = JSON.parse(schema) as { required?: string[]; properties?: Record<string, unknown> };
    assert.deepEqual(parsed.required, ['ok'], 'only ok is mandatory; message is sent only when it differs');
    for (const field of ['ok', 'message', 'tool', 'vin', 'data', 'ageSeconds', 'code', 'httpStatus', 'requestId', 'hint']) {
      assert.ok(parsed.properties !== undefined && field in parsed.properties, `the envelope documents ${field}`);
    }
  } finally {
    await standard.close();
    await withHistory.close();
  }
});

test('a successful result sends its text once, and a failure adds its hint once', async () => {
  const surface = await startSurface();
  try {
    for (const name of ['get_battery', 'list_domains', 'list_vehicles', 'polestar_status']) {
      const out = await surface.client.callTool(name);
      assert.notEqual(out.isError, true, `${name} answered`);
      assert.equal(out.structuredContent?.ok, true);
      assert.equal(
        out.structuredContent?.message,
        undefined,
        `${name} must not repeat the content text in structuredContent.message`,
      );
    }

    const failure = await surface.client.callTool('get_battery', { vin: 'NOTAVIN' });
    assert.equal(failure.isError, true, 'a malformed VIN is refused');
    const message = failure.structuredContent?.message;
    const hint = failure.structuredContent?.hint;
    assert.equal(typeof message, 'string', 'a failure names the refusal in message');
    assert.equal(typeof hint, 'string', 'the advice is a field a client can branch on');
    assert.equal(failure.text, `${String(message)}\nHint: ${String(hint)}`, 'text is the refusal plus one hint');
    assert.equal(failure.text.split(String(hint)).length - 1, 1, 'the hint appears once in the text');
    assert.doesNotMatch(String(message), /Hint:/, 'the hint is not also inside message');
  } finally {
    await surface.close();
  }
});

test('every tool states openWorldHint and idempotentHint, and local tools stay closed-world', async () => {
  const surface = await startSurface({ history: true });
  try {
    const { tools } = await surface.client.listTools();
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is a read`);
      assert.equal(typeof tool.annotations?.openWorldHint, 'boolean', `${tool.name} states openWorldHint explicitly`);
      assert.equal(tool.annotations?.idempotentHint, true, `${tool.name} is idempotent because it only reads`);
    }

    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations ?? {}]));
    for (const name of ['get_battery', 'get_car_status', 'list_vehicles']) {
      assert.equal(byName.get(name)?.openWorldHint, true, `${name} reaches the Polestar API`);
    }
    for (const name of ['polestar_status', 'get_history']) {
      assert.equal(byName.get(name)?.openWorldHint, false, `${name} reads local state only`);
    }
  } finally {
    await surface.close();
  }
});

test('a success carries no message field, and withData attaches the documented payload', () => {
  const plain = text('just the text');
  assert.deepEqual(plain.structuredContent, { ok: true }, 'no payload, no repeated text');
  assert.equal('message' in (plain.structuredContent ?? {}), false);

  const withPayload = withData('two vehicles', { count: 2, vehicles: [] }, { tool: 'list_vehicles' });
  assert.deepEqual(withPayload.structuredContent, {
    ok: true,
    data: { count: 2, vehicles: [] },
    tool: 'list_vehicles',
  });
  assert.equal(withPayload.content[0]!.text, 'two vehicles');
});

test('the shared output schema requires only ok and leaves data optional', () => {
  const json = resultSchema['~standard'].jsonSchema.output({ target: 'draft-2020-12' }) as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(json.required, ['ok'], 'message and data are omitted when absent, not required empty');
  assert.ok(json.properties !== undefined);
  for (const field of ['message', 'tool', 'vin', 'data', 'ageSeconds', 'code', 'httpStatus', 'requestId', 'hint']) {
    assert.ok(field in json.properties, `the contract field ${field} is declared`);
  }

  assert.equal(resultSchema.safeParse({ ok: true }).success, true, 'a bare success validates');
  assert.equal(resultSchema.safeParse({ ok: true, data: { count: 0 } }).success, true, 'an empty payload still validates');
  assert.equal(
    resultSchema.safeParse({ ok: false, message: 'Server refused X: no', code: 'X', hint: 'advice' }).success,
    true,
    'a failure validates',
  );
  assert.equal(resultSchema.safeParse({ message: 'missing ok' }).success, false, 'ok is the one mandatory field');
});

test('a failure states its hint once, and mentions a requestId only when it has one', () => {
  const failure = errorResult(new PolestarApiError('INVALID_VIN', 'not a VIN', 400));
  assert.equal(failure.isError, true);
  const sc = failure.structuredContent ?? {};
  const message = String(sc.message);
  const hint = String(sc.hint);
  assert.equal(failure.content[0]!.text, `${message}\nHint: ${hint}`, 'the text is the refusal plus the hint');
  assert.equal(failure.content[0]!.text.split(hint).length - 1, 1, 'the hint appears once in the text');
  assert.doesNotMatch(message, /Hint:/, 'message is the refusal alone');
  assert.equal(sc.requestId, undefined, 'a local refusal has no upstream handle to report');
  assert.doesNotMatch(hint, /requestId/);

  const anonymous = errorResult(new PolestarApiError('UNMAPPED_CODE', 'anonymous', 500));
  assert.doesNotMatch(String(anonymous.structuredContent?.hint), /requestId/, 'no invented handle in the fallback');

  const handled = errorResult(new PolestarApiError('UNMAPPED_CODE', 'anonymous', 500, 'req-42'));
  assert.match(String(handled.structuredContent?.hint), /requestId/, 'a real handle is worth asking for');
  assert.equal(handled.structuredContent?.requestId, 'req-42');

  const internal = errorResult(new Error('boom'));
  assert.equal(internal.structuredContent?.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(String(internal.structuredContent?.hint), /requestId/, 'a local internal error has none either');
});
