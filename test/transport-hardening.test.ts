import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenProvider } from '../src/auth.js';
import { CachingTransport } from '../src/caching-transport.js';
import { PolestarClient } from '../src/client.js';
import { domainRequestPath } from '../src/domains.js';
import { RetryingTransport } from '../src/retrying-transport.js';
import { BudgetMeter } from '../src/budget.js';
import { TransportError, type Transport, type TransportRequest, type TransportResponse } from '../src/transport.js';
import { ok, ScriptedTransport, tokenBody } from './helpers.js';

const BASE = 'https://api.test/m2m';
const VIN = 'YSMTEST22PL000001';
const OTHER_VIN = 'YSMTEST22PL000002';
const ABSENT_URL = `${BASE}${domainRequestPath(VIN, 'charging', 'is-at-charge-location')}`;

/** Runs one responder for every call, records each call, and counts data reads. */
class RecordingTransport implements Transport {
  readonly calls: Array<{ url: string; request: TransportRequest }> = [];

  constructor(private readonly respond: (call: { url: string; request: TransportRequest }) => TransportResponse) {}

  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    this.calls.push({ url, request });
    return this.respond({ url, request });
  }

  /** Only GETs, so a token POST cannot inflate an assertion about live reads. */
  get reads(): number {
    return this.calls.filter((call) => (call.request.method ?? 'GET') === 'GET').length;
  }
}

function dataNotAvailable(): TransportResponse {
  return {
    status: 404,
    body: JSON.stringify({
      error: { code: 'DATA_NOT_AVAILABLE', message: 'The vehicle does not report this domain.', httpStatus: 404 },
    }),
  };
}

test('the cache key carries the identity, so a delegated read is not served the owner entry', async () => {
  // Reproduced against the production chain before this: owner.vehicles() then
  // delegated.vehicles() answered with the owner's list from one HTTP call. The
  // delegated-account feature exists to read another account's shared vehicles,
  // so on a process that uses it, that was a cross-account disclosure.
  const transport = new RecordingTransport(({ request }) => {
    if ((request.method ?? 'GET') !== 'GET') return tokenBody('token-1');
    const delegated = request.headers?.['x-delegated-account-id'];
    return ok({ data: [delegated === undefined ? VIN : OTHER_VIN] });
  });
  const cache = new CachingTransport(transport);
  const tokens = new TokenProvider(cache, { tokenUrl: `${BASE}/token`, clientId: 'owner', clientSecret: 'secret' });
  const owner = new PolestarClient(tokens, cache, { baseUrl: BASE, accountId: 'owner' });
  const delegated = owner.forDelegation('partner-a@example.com');

  assert.deepEqual(await owner.vehicles(), [VIN]);
  assert.deepEqual(await delegated.vehicles(), [OTHER_VIN], 'the partner read is the partner list, not the owner cached one');
  assert.equal(transport.reads, 2, 'two identities cost two live reads');

  assert.deepEqual(await owner.vehicles(), [VIN]);
  assert.deepEqual(await delegated.vehicles(), [OTHER_VIN]);
  assert.equal(transport.reads, 2, 'the same identity still hits the cache');
});

test('an unreported Domain is cached briefly instead of spending a call per read', async () => {
  let now = 1_000_000;
  const transport = new RecordingTransport(() => dataNotAvailable());
  const cache = new CachingTransport(transport, { now: () => now });

  const first = await cache.fetch(ABSENT_URL);
  const second = await cache.fetch(ABSENT_URL);
  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(transport.calls.length, 1, 'the second read is the cached negative answer');
  assert.equal(second.body, first.body, 'the cached body replays exactly');
  assert.equal(cache.stats.hits, 1);

  now += 61_000;
  const third = await cache.fetch(ABSENT_URL);
  assert.equal(third.status, 404);
  assert.equal(transport.calls.length, 2, 'the negative entry expires and is refetched');
});

test('the real client reads a cached DATA_NOT_AVAILABLE as absence, not as a stale answer', async () => {
  const transport = new RecordingTransport(({ request }) =>
    (request.method ?? 'GET') === 'POST' ? tokenBody('token-1') : dataNotAvailable(),
  );
  const cache = new CachingTransport(transport);
  const tokens = new TokenProvider(cache, { tokenUrl: `${BASE}/token`, clientId: 'owner', clientSecret: 'secret' });
  const client = new PolestarClient(tokens, cache, { baseUrl: BASE, accountId: 'owner' });

  assert.equal(await client.domain(VIN, 'charging', 'is-at-charge-location'), null);
  assert.equal(await client.domain(VIN, 'charging', 'is-at-charge-location'), null);
  assert.equal(transport.reads, 1, 'the second read is served the cached 404 body');
});

test('403 and 429 are never cached', async () => {
  for (const status of [403, 429]) {
    const transport = new RecordingTransport(() => ({
      status,
      body: JSON.stringify({ error: { code: `HTTP_${status}`, message: 'refused' } }),
    }));
    const cache = new CachingTransport(transport);
    await cache.fetch(ABSENT_URL);
    await cache.fetch(ABSENT_URL);
    assert.equal(transport.calls.length, 2, `HTTP ${status} must reach the API again`);
  }
});

test('a 404 that is not DATA_NOT_AVAILABLE is not cached', async () => {
  // The fixture adapter answers NOT_FOUND for a route it has no file for, which is
  // a server or fixture defect, not a car that reports nothing. Hiding it behind a
  // negative entry would make a misconfiguration look like normal absence.
  const transport = new RecordingTransport(() => ({
    status: 404,
    body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such route' } }),
  }));
  const cache = new CachingTransport(transport);
  await cache.fetch(ABSENT_URL);
  await cache.fetch(ABSENT_URL);
  assert.equal(transport.calls.length, 2);
});

test('Retry-After as an HTTP date waits until that date', async () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const waits: number[] = [];
  let calls = 0;
  const inner: Transport = {
    async fetch() {
      calls += 1;
      return calls === 1
        ? { status: 429, body: '{}', headers: { 'retry-after': new Date(now + 30_000).toUTCString() } }
        : ok({ fine: true });
    },
  };
  const retrying = new RetryingTransport(inner, {
    maxAttempts: 3,
    totalDeadlineMs: 60_000,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const res = await retrying.fetch(`${BASE}/v1/vehicles`);
  assert.equal(res.status, 200);
  assert.deepEqual(waits, [30_000], 'the date form produces the wait the numeric form would');
});

test('500 and 504 are retried like the documented gateway failures', async () => {
  for (const status of [500, 504]) {
    const inner = new ScriptedTransport([{ status, body: 'transient' }, ok({ fine: true })]);
    const waits: number[] = [];
    const retrying = new RetryingTransport(inner, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const res = await retrying.fetch(`${BASE}/v1/vehicles`);
    assert.equal(res.status, 200, `HTTP ${status} is retried`);
    assert.equal(inner.calls.length, 2, `HTTP ${status} costs two attempts`);
    assert.deepEqual(waits, [500]);
  }
});

test('a GET is retried once after a transport-level network failure, and both attempts are metered', async () => {
  const failures = [new TransportError('connection reset', 'network')];
  const transport = new RecordingTransport(() => {
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
    return ok({ fine: true });
  });
  const waits: number[] = [];
  const budget = new BudgetMeter(10, () => 0);
  const retrying = new RetryingTransport(transport, {
    sleep: async (ms) => {
      waits.push(ms);
    },
    budget,
  });
  const res = await retrying.fetch(`${BASE}/v1/vehicles`);
  assert.equal(res.status, 200);
  assert.equal(transport.calls.length, 2, 'one retry, inside the same attempt budget');
  assert.deepEqual(waits, [500]);
  assert.equal(budget.snapshot().used, 2, 'the retried attempt spends quota like any other');
});

test('a second network failure surfaces instead of retrying again', async () => {
  const transport = new RecordingTransport(() => {
    throw new TransportError('still down', 'network');
  });
  const retrying = new RetryingTransport(transport, { sleep: async () => undefined });
  await assert.rejects(
    () => retrying.fetch(`${BASE}/v1/vehicles`),
    (err: unknown) => err instanceof TransportError && err.causeKind === 'network',
  );
  assert.equal(transport.calls.length, 2);
});

test('a token POST is not retried on a network failure', async () => {
  const transport = new RecordingTransport(() => {
    throw new TransportError('connection refused', 'network');
  });
  const retrying = new RetryingTransport(transport, {
    sleep: async () => {
      throw new Error('a POST must not back off');
    },
  });
  await assert.rejects(
    () => retrying.fetch(`${BASE}/token`, { method: 'POST', body: '{}' }),
    (err: unknown) => err instanceof TransportError,
  );
  assert.equal(transport.calls.length, 1);
});

test('a timeout is surfaced immediately: it already spent the request deadline', async () => {
  const transport = new RecordingTransport(() => {
    throw new TransportError('request timed out', 'timeout');
  });
  const retrying = new RetryingTransport(transport, {
    sleep: async () => {
      throw new Error('a timeout must not be retried');
    },
  });
  await assert.rejects(
    () => retrying.fetch(`${BASE}/v1/vehicles`),
    (err: unknown) => err instanceof TransportError && err.causeKind === 'timeout',
  );
  assert.equal(transport.calls.length, 1);
});
