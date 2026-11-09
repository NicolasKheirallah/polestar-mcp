import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEngine } from '../src/server.js';
import { BudgetExceededError } from '../src/budget.js';

/**
 * The composition of the live transport chain, from the environment alone.
 *
 * RetryingTransport is the only caller of budget.consume() and minute.consume(),
 * and it used to be composed only when the cache was enabled: POLESTAR_CACHE=off
 * silently removed the daily guard, the per-minute guard and every retry while
 * the README, SECURITY.md and docs/architecture.md all said every live attempt is
 * metered. These tests stub global fetch, so what reaches the network is observed
 * rather than assumed.
 */

const VIN = 'YSMTEST22PL000001';
const DUMP = fileURLToPath(new URL('../test/fixtures/dump', import.meta.url));

/** Real-mode environment; base URL is https and never dialled, fetch is stubbed. */
const LIVE = {
  POLESTAR_CLIENT_ID: 'oauth-client',
  POLESTAR_CLIENT_SECRET: 'secret',
  POLESTAR_ACCOUNT_ID: 'account-1',
  POLESTAR_BASE_URL: 'https://api.test/m2m',
};

interface StubResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface Stub {
  calls: Array<{ url: string; method: string }>;
  restore(): void;
}

function stubFetch(handler: (url: string, init: RequestInit | undefined) => StubResponse): Stub {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? 'GET' });
    const response = handler(url, init);
    return new Response(response.body, {
      status: response.status,
      headers: response.headers ?? { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const tokenResponse = (): StubResponse => ({
  status: 200,
  body: JSON.stringify({ accessToken: 'live-token', expiresIn: 3600, tokenType: 'Bearer' }),
});
const vehiclesResponse = (): StubResponse => ({ status: 200, body: JSON.stringify({ data: [VIN] }) });
const rateLimited = (): StubResponse => ({
  status: 429,
  body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down', httpStatus: 429 } }),
  // A server-requested wait of zero keeps the test instant; the header still
  // proves the retry path is the production one.
  headers: { 'content-type': 'application/json', 'retry-after': '0' },
});

const isTokenCall = (url: string): boolean => url.endsWith('/token');
const vehicleReads = (calls: Array<{ url: string; method: string }>): number =>
  calls.filter((call) => call.method !== 'POST' && !isTokenCall(call.url)).length;

for (const cache of ['off', 'on'] as const) {
  test(`cache ${cache}: a 429 is retried and every live attempt is metered`, async () => {
    let attempts = 0;
    const stub = stubFetch((url) => {
      if (isTokenCall(url)) return tokenResponse();
      attempts += 1;
      return attempts === 1 ? rateLimited() : vehiclesResponse();
    });
    try {
      const engine = buildEngine({ ...LIVE, ...(cache === 'off' ? { POLESTAR_CACHE: 'off' } : {}) });
      assert.equal(engine.config.cacheDisabled, cache === 'off');
      assert.deepEqual(await engine.client.vehicles(), [VIN], 'the retried read answers normally');
      assert.equal(vehicleReads(stub.calls), 2, `a 429 must be retried with the cache ${cache}`);
      assert.equal(attempts, 2);

      // The token exchange, the 429 and the successful retry: three live attempts.
      assert.ok(engine.budget.snapshot().used > 0, `cache ${cache} must meter live attempts`);
      assert.equal(engine.budget.snapshot().used, 3, 'both retry attempts are charged, not one');
    } finally {
      stub.restore();
    }
  });
}

test('with POLESTAR_CACHE=off and POLESTAR_BUDGET=2 the third live attempt is refused', async () => {
  const stub = stubFetch((url) => (isTokenCall(url) ? tokenResponse() : rateLimited()));
  try {
    const engine = buildEngine({ ...LIVE, POLESTAR_CACHE: 'off', POLESTAR_BUDGET: '2' });
    await assert.rejects(
      () => engine.client.vehicles(),
      (err: unknown) => {
        assert.ok(err instanceof BudgetExceededError, `expected the budget guard, saw ${String(err)}`);
        return true;
      },
      'the retry layer must fail closed at the daily ceiling even with the cache off',
    );
    // Attempt one spent the second and last unit on the token plus one read;
    // the retry was refused before it reached the network.
    assert.equal(vehicleReads(stub.calls), 1);
    assert.equal(engine.budget.snapshot().used, 2);
  } finally {
    stub.restore();
  }
});

test('fixture reads stay unmetered, however the cache is configured', async () => {
  for (const env of [{}, { POLESTAR_CACHE: 'off' }, { POLESTAR_CACHE: 'on' }] as const) {
    const engine = buildEngine({ POLESTAR_FIXTURES_DIR: DUMP, ...env });
    assert.deepEqual(await engine.client.vehicles(), [VIN]);
    assert.equal(engine.budget.snapshot().used, 0, 'an offline read spends no quota');
    assert.equal(engine.minute.snapshot().used, 0);
    engine.sampler?.stop();
  }
});
