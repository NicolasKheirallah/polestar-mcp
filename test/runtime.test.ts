import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { PolestarApiError } from '../src/client.js';
import { clientFor, describeError, errorResult, readDomainFormatted } from '../src/tool-output.js';
import { HttpTransport } from '../src/transport.js';
import { DOMAINS } from '../src/domains.js';
import { domainToolSpecs } from '../src/domain-tools.js';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../src/history.js';
import { BudgetExceededError, BudgetMeter, MinuteWindowMeter, RateLimitMinuteError } from '../src/budget.js';
import { CachingTransport } from '../src/caching-transport.js';
import { RetryingTransport } from '../src/retrying-transport.js';
import { HistorySampler } from '../src/sampler.js';
import type { PolestarClient } from '../src/client.js';
import type { Transport, TransportRequest, TransportResponse } from '../src/transport.js';
import type { ToolDeps } from '../src/tool-output.js';

/** Driven sleep: a test decides exactly when an interval elapses, so nothing waits in real time. */
class FakeSleep {
  private queued: Array<() => void> = [];
  sleep = (): Promise<void> => new Promise<void>((resolve) => { this.queued.push(resolve); });
  async runNext(): Promise<void> {
    const release = this.queued.shift();
    if (release === undefined) return;
    release();
    await new Promise((r) => setImmediate(r));
  }
}

const BATTERY = { kind: 'telemetry', name: 'battery', scope: 'pdp-telemetry/battery' } as const;

function ok(body: unknown, headers?: Record<string, string>): TransportResponse {
  // Conditional spread, not `headers`: TransportResponse declares `headers?`, and
  // under exactOptionalPropertyTypes an explicitly-present undefined does not
  // satisfy an optional property whose type excludes it.
  return { status: 200, body: JSON.stringify(body), ...(headers === undefined ? {} : { headers }) };
}

class ScriptedTransport implements Transport {
  attempts = 0;
  constructor(private readonly responses: TransportResponse[]) {}
  async fetch(_url: string, _request: TransportRequest = {}): Promise<TransportResponse> {
    this.attempts += 1;
    const next = this.responses.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    return next;
  }
}

test('budget meter counts attempts and resets on UTC day rollover', () => {
  let now = Date.UTC(2026, 8, 18, 10, 0, 0);
  const meter = new BudgetMeter(3, () => now);
  meter.consume();
  meter.consume();
  assert.equal(meter.snapshot().used, 2);
  now += 24 * 60 * 60 * 1000; // next UTC day
  assert.equal(meter.snapshot().used, 0);
  assert.equal(meter.snapshot().remaining, 3);
});

test('budget meter fails closed at the limit with a clear error', () => {
  const meter = new BudgetMeter(1, () => Date.UTC(2026, 8, 18, 10, 0, 0));
  meter.consume();
  assert.throws(() => meter.consume(), (err: unknown) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.match(err.message, /budget exhausted/i);
    return true;
  });
});

test('budget meter isLow reports fraction used', () => {
  const meter = new BudgetMeter(10, () => Date.UTC(2026, 8, 18, 10, 0, 0));
  for (let i = 0; i < 9; i++) meter.consume();
  assert.equal(meter.isLow(0.8), true);
  assert.equal(meter.isLow(0.95), false);
});

test('retries 502 with backoff and succeeds, consuming budget per attempt', async () => {
  const sleeps: number[] = [];
  const inner = new ScriptedTransport([
    { status: 502, body: 'bad gateway' },
    ok({ fine: true }),
  ]);
  const meter = new BudgetMeter(10, () => Date.UTC(2026, 8, 18));
  const retrying = new RetryingTransport(inner, {
    budget: meter,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const res = await retrying.fetch('https://api.test/m2m/v1/vehicles');
  assert.equal(res.status, 200);
  assert.equal(inner.attempts, 2);
  assert.equal(meter.snapshot().used, 2);
  assert.deepEqual(sleeps, [500]);
});

test('honors Retry-After on 429 and gives up after maxAttempts', async () => {
  const sleeps: number[] = [];
  const inner = new ScriptedTransport([
    { status: 429, body: 'slow down', headers: { 'retry-after': '2' } },
    { status: 429, body: 'slow down', headers: { 'retry-after': '2' } },
    { status: 429, body: 'slow down', headers: { 'retry-after': '2' } },
  ]);
  const retrying = new RetryingTransport(inner, {
    maxAttempts: 3,
    maxBackoffMs: 5_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const res = await retrying.fetch('https://api.test/m2m/v1/vehicles');
  assert.equal(res.status, 429);
  assert.equal(inner.attempts, 3);
  assert.deepEqual(sleeps, [2000, 2000]); // header honored over exponential
});

test('does not retry non-retryable statuses', async () => {
  const inner = new ScriptedTransport([{ status: 404, body: 'nope' }]);
  const retrying = new RetryingTransport(inner, { sleep: async () => undefined });
  const res = await retrying.fetch('https://api.test/m2m/v1/vehicles');
  assert.equal(res.status, 404);
  assert.equal(inner.attempts, 1);
});

const DOMAIN_URL = 'https://api.test/m2m/v1/vehicles/VIN1234567890123/telemetry/battery';

test('cache serves repeated reads within the domain TTL from one live call', async () => {
  let now = 1_000_000;
  const inner = new ScriptedTransport([ok({ data: { metaEventId: 'e1' } })]);
  const cache = new CachingTransport(inner, { now: () => now });
  const first = await cache.fetch(DOMAIN_URL);
  const second = await cache.fetch(DOMAIN_URL);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(inner.attempts, 1);
  assert.equal(cache.stats.hits, 1);
});

test('cache serves stale while refreshing, then converges on fresh data', async () => {
  let now = 1_000_000;
  let resolveRefresh: ((r: TransportResponse) => void) | undefined;
  // A closure counter rather than `attempts` on the literal: Transport declares
  // no such member, so an object literal typed as Transport cannot carry it, and
  // nothing in this test reads the count back out.
  let attempts = 0;
  const inner: Transport = {
    async fetch() {
      attempts += 1;
      if (attempts === 1) return ok({ data: { metaEventId: 'old' } });
      await new Promise<void>((resolve) => {
        // Adapt to the declared resolveRefresh signature; the payload argument is
        // not needed to settle the promise.
        resolveRefresh = () => resolve();
      });
      return ok({ data: { metaEventId: 'new' } });
    },
  };
  const cache = new CachingTransport(inner, { now: () => now });

  await cache.fetch(DOMAIN_URL); // prime (battery TTL = 30s)
  now += 31_000; // expire
  const stale = await cache.fetch(DOMAIN_URL); // should serve old immediately
  assert.equal(JSON.parse(stale.body).data.metaEventId, 'old');
  assert.equal(cache.stats.staleServed, 1);

  const refresh = cache.fetch(DOMAIN_URL); // joins the in-flight revalidation
  resolveRefresh!(ok({ data: { metaEventId: 'new' } }));
  await refresh;
  await new Promise((r) => setImmediate(r)); // let the revalidation land in the entries
  const fresh = await cache.fetch(DOMAIN_URL); // now within the new entry's TTL
  assert.equal(JSON.parse(fresh.body).data.metaEventId, 'new');
  assert.equal(cache.stats.refreshes, 2); // prime + the single shared revalidation
  assert.ok(resolveRefresh !== undefined);
});

test('POST requests (token) and cache-disabled mode bypass the cache', async () => {
  const inner = new ScriptedTransport([ok({ accessToken: 't' }), ok({ accessToken: 't2' })]);
  const cache = new CachingTransport(inner, {});
  await cache.fetch('https://api.test/m2m/token', { method: 'POST', body: '{}' });
  await cache.fetch('https://api.test/m2m/token', { method: 'POST', body: '{}' });
  assert.equal(inner.attempts, 2);
  assert.equal(cache.stats.hits, 0);

  const disabledInner = new ScriptedTransport([ok({}), ok({})]);
  const disabled = new CachingTransport(disabledInner, { disabled: true });
  await disabled.fetch(DOMAIN_URL);
  await disabled.fetch(DOMAIN_URL);
  assert.equal(disabledInner.attempts, 2); // every read hits the inner transport
  assert.equal(disabled.stats.misses, 0); // and none of it is bookkept as cache traffic
});

test('error responses are not cached', async () => {
  let now = 1_000_000;
  const inner = new ScriptedTransport([
    { status: 500, body: 'boom' },
    ok({ data: {} }),
  ]);
  const cache = new CachingTransport(inner, { now: () => now });
  const bad = await cache.fetch(DOMAIN_URL);
  assert.equal(bad.status, 500);
  const good = await cache.fetch(DOMAIN_URL);
  assert.equal(good.status, 200);
  assert.equal(inner.attempts, 2);
});

test('background sampling is opt-in and budget-guarded, never self-starting', async () => {
  const vin = 'YSMTEST22PL000001';
  const client = { vehicles: async () => [vin] } as unknown as PolestarClient;
  const budget = new BudgetMeter(10_000);
  let rounds = 0;
  const sleeper = new FakeSleep();
  const sampler = new HistorySampler(client, budget, async () => { rounds += 1; }, {
    intervalSeconds: 60, sleep: sleeper.sleep,
  });
  // Constructing it must not schedule anything.
  assert.equal(rounds, 0);
  assert.equal(await sampler.start(), 1, 'resolves the VIN list from the credential');
  await sleeper.runNext();
  assert.ok(rounds >= 1, 'a round runs once the interval elapses');
  sampler.stop();
  const before = rounds;
  await sleeper.runNext();
  assert.equal(rounds, before, 'stop() really stops: no quota spent afterwards');
});

test('Retry-After is honoured as given instead of clamped to the backoff cap', async () => {
  const waits: number[] = [];
  let calls = 0;
  const inner = {
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? { status: 429, body: '{}', headers: { 'retry-after': '30' } }
        : { status: 200, body: '{}' };
    },
  } as unknown as Transport;
  const tp = new RetryingTransport(inner, {
    maxAttempts: 3, maxBackoffMs: 5_000, totalDeadlineMs: 60_000,
    now: () => 0, sleep: async (ms) => { waits.push(ms); },
  });
  const res = await tp.fetch('https://x/y');
  assert.equal(res.status, 200);
  assert.deepEqual(waits, [30_000], 'the server asked for 30s, so we wait 30s, not the 5s cap');
});

test('a wait that would overrun the total deadline returns the 429 instead of parking the call', async () => {
  let calls = 0;
  const inner = { fetch: async () => { calls += 1; return { status: 429, body: '{}', headers: { 'retry-after': '600' } }; } } as unknown as Transport;
  const tp = new RetryingTransport(inner, {
    maxAttempts: 3, totalDeadlineMs: 10_000, now: () => 0, sleep: async () => { throw new Error('must not sleep past the deadline'); },
  });
  const res = await tp.fetch('https://x/y');
  assert.equal(res.status, 429);
  assert.equal(calls, 1, 'gives up after the first attempt rather than waiting ten minutes');
});

test('the bearer token never reaches tool output, errors, or transport diagnostics', () => {
  // A token printed anywhere the model can see is a credential leak with a
  // 1-hour shelf life, so this is asserted, not assumed.
  const secret = 'super-secret-token-value';
  const sources = ['transport.ts', 'client.ts', 'auth.ts', 'tool-output.ts', 'caching-transport.ts', 'retrying-transport.ts']
    .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
    .join('\n');
  // Building `Authorization: Bearer ${token}` is the whole point; mentioning a
  // token or header inside a *diagnostic* is the leak. Check log lines only.
  const logLines = sources
    .split('\n')
    .filter((line) => /console\.[a-z]+\(|\blog\??\(/.test(line))
    .filter((line) => /token|authorization|bearer/i.test(line));
  assert.deepEqual(logLines, [], 'credential material must never appear in a log statement');
  const described = describeError(new PolestarApiError('UNAUTHORIZED', 'Bad credentials', 401, 'req-1'));
  assert.ok(described.includes('req-1'), 'the requestId does survive into the message');
  assert.equal(described.includes(secret), false);
  const leaked = errorResult(new PolestarApiError('UNAUTHORIZED', `token ${secret} rejected`, 401));
  assert.equal(JSON.stringify(leaked).includes(secret), true, 'if the API itself echoes a secret in a message we surface it, so never forward raw bodies');
});

test('HttpTransport maps a deadline or a dead socket to a TransportError, never a hang', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); }) as typeof fetch;
    await assert.rejects(() => new HttpTransport(50).fetch('https://example.invalid/x'), (err: unknown) => {
      assert.equal((err as { name: string }).name, 'TransportError');
      assert.equal((err as { causeKind: string }).causeKind, 'timeout');
      return true;
    });
    globalThis.fetch = (async () => { throw Object.assign(new Error('nope'), { name: 'TypeError' }); }) as typeof fetch;
    await assert.rejects(() => new HttpTransport(50).fetch('https://example.invalid/x'), (err: unknown) =>
      (err as { causeKind: string }).causeKind === 'network');
    globalThis.fetch = (async () => new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const res = await new HttpTransport(5_000).fetch('https://example.invalid/ok');
    assert.equal(res.status, 201);
    assert.equal(res.body, '{"ok":true}');
    assert.equal(res.headers?.['content-type'], 'application/json', 'response headers are surfaced for Retry-After and friends');
  } finally {
    globalThis.fetch = original;
  }
});

// The registry is a value now, so this asserts names *and* reaches a handler 
// the thing the handler-discarding fake could never do.
test('POLESTAR_REDACT_VIN covers the structured envelope, not only the text', async () => {
  // Found by running the server against the live API: the prose was masked while
  // structuredContent.vin still carried the identifier, and clients forward the
  // structured half to the model as well.
  const vin = 'YSMTEST22PL000001';
  const client = {
    async resolveVin(v?: string) { return v ?? vin; },
    async vehicles() { return [vin]; },
    async domain() { return { batteryChargeLevelPercentage: 61, vin, metaReceivedAt: '2026-01-01T00:00:00.000Z' }; },
  } as unknown as PolestarClient;
  const base = { client, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km' } as ToolDeps;
  const battery = DOMAINS.find((d) => d.name === 'battery');
  assert.ok(battery !== undefined);

  const shown = await readDomainFormatted(base, battery, {}, {});
  assert.equal(shown.structuredContent?.vin, vin, 'without redaction the identifier is the VIN');

  const hidden = await readDomainFormatted({ ...base, redactVin: true }, battery, {}, {});
  assert.equal(hidden.structuredContent?.vin, 'YSM…001');
  assert.equal(JSON.stringify(hidden).includes(vin), false, 'the whole result must be free of the full VIN');
});

test('the domain registry is a value, and its handlers answer', async () => {
  const vin = 'YSMTEST22PL000001';
  const client = {
    async resolveVin(v?: string) { return v ?? vin; },
    async vehicles() { return [vin]; },
    async domain() { return { batteryChargeLevelPercentage: 77, metaReceivedAt: '2026-01-01T00:00:00.000Z' }; },
  } as unknown as PolestarClient;
  const deps: ToolDeps = { client, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km', nowMs: () => Date.parse('2026-01-01T02:00:00Z') };
  const specs = domainToolSpecs(deps);

  assert.equal(specs.filter((s) => s.name.startsWith('get_')).length, DOMAINS.length, 'one tool per Domain');
  assert.ok(specs.some((s) => s.name === 'list_domains'), 'the self-describing tool exists');
  assert.ok(specs.every((s) => s.annotations.readOnlyHint === true), 'every read tool says so');

  const battery = specs.find((s) => s.name === 'get_battery');
  assert.ok(battery !== undefined, 'get_battery is reachable by name');
  const out = await battery.run({}, {});
  assert.equal(out.structuredContent?.ok, true);
  assert.match(JSON.stringify(out.content), /77%/);
  assert.equal(out.structuredContent?.vin, vin, 'the answer names the Vehicle it read');

  // POLESTAR_REDACT_VIN reaches output through maskVin, shared by list_vehicles and the
  // resource listing. A recursion in that helper was caught only by the spawned smoke
  // run, so the masked path is asserted through the registry now.
  const redactedDeps: ToolDeps = { ...deps, redactVin: true };
  const list = domainToolSpecs(redactedDeps).find((s) => s.name === 'list_vehicles');
  assert.ok(list !== undefined);
  const masked = await list.run({}, {});
  const maskedText = JSON.stringify(masked);
  assert.ok(maskedText.includes('YSM…001'), `unexpected masking: ${maskedText}`);
  assert.equal(maskedText.includes(vin), false, 'the full VIN must not appear anywhere in a redacted result');

  const domains = specs.find((s) => s.name === 'list_domains');
  assert.ok(domains !== undefined);
  const listed = await domains.run({}, {});
  assert.ok(JSON.stringify(listed.content).includes('pdp-telemetry/battery'), 'list_domains enumerates the scopes');
});

test('an ambiguous VIN asks the client to pick, and uses the answer it gets', async () => {
  const [firstVin, secondVin] = ['YSMTEST22PL000001', 'YSMTEST22PL000002'] as const;
  const asked: string[] = [];
  const client = {
    resolveVin: async (v?: string) => {
      if (v !== undefined && v !== '') return v.toUpperCase();
      // A real PolestarApiError, not an object wearing its name: presentation now
      // identifies failures by type, so a forged `name` field would be a lie the
      // compiler would happily accept.
      throw new PolestarApiError('AMBIGUOUS_VIN', 'This credential has 2 vehicles; pass an explicit vin.', 400);
    },
    vehicles: async () => [firstVin, secondVin],
    domain: async () => ({ batteryChargeLevelPercentage: 52, metaReceivedAt: '2026-01-01T00:00:00.000Z' }),
  } as unknown as PolestarClient;
  const deps: ToolDeps = { client, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km', nowMs: () => Date.parse('2026-01-01T02:00:00Z') };

  // A client that answers: the tool continues with the chosen vehicle.
  const answering = { mcpReq: { elicitInput: async (params: { requestedSchema?: { properties?: { vin?: { enum?: string[] } } } }) => {
    asked.push(JSON.stringify(params.requestedSchema?.properties?.vin?.enum ?? []));
    return { action: 'accept', content: { vin: secondVin } };
  } } };
  const got = await readDomainFormatted(deps, BATTERY, {}, answering);
  assert.equal(got.structuredContent?.ok, true, 'the call completed instead of failing');
  assert.equal(got.structuredContent?.vin, secondVin);
  assert.ok(asked[0]?.includes(secondVin), 'the choices offered were the authorized VINs');

  // A client that declines: an explicit, actionable outcome, not a hang, not a stack trace.
  const declining = { mcpReq: { elicitInput: async () => ({ action: 'decline' }) } };
  const decl = await readDomainFormatted(deps, BATTERY, {}, declining);
  assert.equal(decl.isError, true);
  assert.equal(decl.structuredContent?.code, 'VIN_NOT_CHOSEN');

  // A client that cannot be asked at all: the original AMBIGUOUS_VIN error survives.
  const silent = { mcpReq: { elicitInput: async () => { throw new Error('client did not declare the capability'); } } };
  const fell = await readDomainFormatted(deps, BATTERY, {}, silent);
  assert.equal(fell.structuredContent?.code, 'AMBIGUOUS_VIN', 'falls back rather than leaking a protocol refusal');
});

test('a delegated account is applied only when the operator allowlisted it', () => {
  const seen: Array<string | undefined> = [];
  const base = {
    forDelegation(id: string | undefined) {
      seen.push(id);
      return this;
    },
  } as unknown as PolestarClient;
  const deps: ToolDeps = { client: base, redactVin: false, vehicleLabels: {}, delegatedAccounts: ['partner-a@example.com'], units: 'km' };
  assert.equal(clientFor(deps, undefined), base, 'no argument, no header');
  assert.equal(clientFor(deps, 'partner-a@example.com'), base, 'allowlisted account is applied');
  assert.throws(() => clientFor(deps, 'intruder@example.com'), (err: unknown) => (err as { code: string }).code === 'DELEGATION_NOT_ALLOWED');
  assert.equal(seen.includes('intruder@example.com'), false, 'a rejected account must never reach the request layer');
});

test('the per-minute ceiling counts requests and rolls its window', () => {
  let now = Date.UTC(2026, 8, 18, 10, 0, 5);
  const minute = new MinuteWindowMeter(3, () => now);
  minute.consume(); minute.consume(); minute.consume();
  assert.deepEqual(minute.snapshot(), { used: 3, limit: 3, resetsInMs: 55_000 });
  assert.throws(() => minute.consume(), (err: unknown) => {
    assert.ok(err instanceof RateLimitMinuteError);
    assert.equal(err.retryInMs, 55_000, 'tells the caller exactly when the window frees');
    return true;
  });
  now += 60_000;                                  // next minute starts
  minute.consume();
  assert.equal(minute.snapshot().used, 1, 'window rolled rather than accumulating');
});

test('a burst above the minute ceiling is waited out, not surfaced as an error', async () => {
  let now = 0;
  const waits: number[] = [];
  const minute = new MinuteWindowMeter(1, () => now);
  let calls = 0;
  const inner = { fetch: async () => { calls += 1; return { status: 200, body: '{}' }; } } as unknown as Transport;
  const tp = new RetryingTransport(inner, {
    minute, budget: new BudgetMeter(100), totalDeadlineMs: 120_000,
    now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; },
  });
  await tp.fetch('https://x/a');
  now = 1_000;
  const second = await tp.fetch('https://x/b');   // ceiling reached -> must wait, then send
  assert.equal(second.status, 200);
  assert.equal(calls, 2, 'the request still went out');
  assert.deepEqual(waits, [59_000], 'slept precisely the remaining window');
});

test('a wait longer than the request deadline is reported instead of hidden', async () => {
  const minute = new MinuteWindowMeter(1, () => 0);
  minute.consume();
  const inner = { fetch: async () => ({ status: 200, body: '{}' }) } as unknown as Transport;
  const tp = new RetryingTransport(inner, {
    minute, totalDeadlineMs: 1_000, now: () => 0, sleep: async () => { throw new Error('must not outlast the deadline'); },
  });
  await assert.rejects(() => tp.fetch('https://x/a'), (err: unknown) => {
    assert.ok(err instanceof RateLimitMinuteError);
    assert.equal((err as Error).name, 'RateLimitMinuteError', 'surfaces as the typed ceiling error for the tool layer');
    return true;
  });
});

test('the minute ceiling maps to RATE_LIMIT_MINUTE with a hint', () => {
  const r = errorResult(new RateLimitMinuteError(100, 100, 12_000));
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent?.code, 'RATE_LIMIT_MINUTE');
  assert.match(String(r.structuredContent?.hint), /100 requests\/minute/);
});

test('an allowlisted delegated account serves the read, not just the VIN lookup', async () => {
  // The bug this pins: the delegated client was built, used to resolve the VIN,
  // and then the domain read went out on the base client, so the request
  // carried no x-delegated-account-id and answered for the wrong account.
  const calls: string[] = [];
  const make = (who: string) => ({
    async resolveVin(vin?: string) { calls.push(`resolveVin:${who}`); return vin ?? 'YSMTEST22PL000001'; },
    async vehicles() { calls.push(`vehicles:${who}`); return ['YSMTEST22PL000001']; },
    async domain() { calls.push(`domain:${who}`); return { batteryChargeLevelPercentage: 61, metaReceivedAt: '2026-01-01T00:00:00.000Z' }; },
    forDelegation(id: string) { calls.push(`forDelegation:${id}`); return make(`delegated:${id}`) as never; },
  });
  const deps: ToolDeps = {
    client: make('base') as never,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: ['partner-a'],
    units: 'km',
    nowMs: () => Date.parse('2026-01-01T02:00:00Z'),
  };

  const result = await readDomainFormatted(deps, BATTERY, { delegated_account_id: 'partner-a' }, {});

  assert.equal(result.structuredContent?.ok, true, 'the call should have produced data');
  assert.ok(calls.includes('forDelegation:partner-a'), 'the delegation was requested');
  assert.deepEqual(
    calls.filter((c) => c.startsWith('domain:')),
    ['domain:delegated:partner-a'],
    'the data read must be served by the delegated client, not the base one',
  );
});

test('history deduplication survives a restart', () => {
  // Measured against the live API: a restarted server re-served the same
  // metaEventId and appended it again, because the change-id memory began empty
  // while the file did not.
  const dir = mkdtempSync(path.join(tmpdir(), 'polestar-history-restart-'));
  const vin = 'YSMTEST22PL000001';
  const first = new HistoryStore(dir);
  first.append(vin, 'telemetry', 'battery', { observedAt: 1, metaEventId: 'event-a', data: { soc: 50 } });
  first.append(vin, 'telemetry', 'battery', { observedAt: 2, metaEventId: 'event-a', data: { soc: 50 } });
  assert.equal(first.query(vin, 'telemetry', 'battery').length, 1, 'in-process dedupe');

  const reopened = new HistoryStore(dir);
  reopened.append(vin, 'telemetry', 'battery', { observedAt: 3, metaEventId: 'event-a', data: { soc: 50 } });
  assert.equal(reopened.query(vin, 'telemetry', 'battery').length, 1, 'the same cloud event replayed after a restart must not add a line');

  reopened.append(vin, 'telemetry', 'battery', { observedAt: 4, metaEventId: 'event-b', data: { soc: 51 } });
  assert.equal(reopened.query(vin, 'telemetry', 'battery').length, 2, 'a genuinely new event must still be recorded');
});

test('a failed background refresh is reported instead of vanishing', async () => {
  // Stale-while-revalidate serves the old entry immediately; until now a refresh
  // that rejected was a dropped promise, so the cache could serve an answer that
  // grew silently staler by the minute with no signal anywhere.
  const DOMAIN_URL = 'https://api.test/m2m/v1/vehicles/VIN1234567890123/telemetry/battery';
  let now = 1_000_000;
  let calls = 0;
  const reported: string[] = [];
  const inner: Transport = {
    async fetch() {
      calls += 1;
      if (calls === 1) return { status: 200, body: '{"data":{"metaEventId":"old"}}' };
      throw new Error('budget exhausted');
    },
  };
  const cache = new CachingTransport(inner, {
    now: () => now,
    onRefreshError: ({ url, message }) => reported.push(`${new URL(url).pathname}: ${message}`),
  });

  await cache.fetch(DOMAIN_URL); // prime
  now += 31_000; // expire the battery TTL
  const served = await cache.fetch(DOMAIN_URL); // stale answer, refresh in flight
  assert.equal(JSON.parse(served.body).data.metaEventId, 'old');
  await new Promise((r) => setImmediate(r));
  assert.equal(reported.length, 1, `the failed refresh must surface exactly once, saw ${reported.length}`);
  assert.match(reported[0] ?? '', /telemetry\/battery: budget exhausted/);
});
