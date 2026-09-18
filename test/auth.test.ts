import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthError, TokenProvider } from '../src/auth.js';
import type { Transport, TransportResponse } from '../src/transport.js';
import { ok, ScriptedTransport, tokenBody } from './helpers.js';

test('collapses concurrent token() callers into a single token request', async () => {
  let resolveFirst: (r: TransportResponse) => void = () => {};
  const slow: Transport = {
    fetch: (url, request) =>
      new Promise((resolve) => {
        resolveFirst = resolve;
        void url;
        void request;
      }),
  };
  const tp = new TokenProvider(slow, { tokenUrl: 'https://x/token', clientId: 'id', clientSecret: 'secret' });

  const pending = [tp.token(), tp.token(), tp.token()];
  await new Promise((resolve) => setImmediate(resolve)); // let the fetch start
  resolveFirst(tokenBody('token-1'));
  const [t1, t2, t3] = await Promise.all(pending);

  assert.equal(t1, 'token-1');
  assert.equal(t2, 'token-1');
  assert.equal(t3, 'token-1');
});

test('caches a valid token: repeated token() does not refetch', async () => {
  const transport = new ScriptedTransport([tokenBody('token-1')]);
  const tp = new TokenProvider(transport, { tokenUrl: 'https://x/token', clientId: 'id', clientSecret: 'secret' });
  const first = await tp.token();
  const second = await tp.token();
  assert.equal(first, 'token-1');
  assert.equal(second, 'token-1');
  assert.equal(transport.calls.length, 1);
});

test('refetches only after expiry minus skew, and sends the credentials + scope', async () => {
  let now = 1_000_000;
  const transport = new ScriptedTransport([
    tokenBody('token-1'), // first fetch → token-1
    ok({ accessToken: 'token-2', expiresIn: 3600, tokenType: 'Bearer' }), // refresh after expiry
  ]);
  const tp = new TokenProvider(transport, {
    tokenUrl: 'https://x/token',
    clientId: 'id',
    clientSecret: 'secret',
    scopes: ['pdp-telemetry/battery', 'pdp-charging/targetSoc'],
    now: () => now,
  });

  await tp.token();
  now += 3_200_000; // inside the 5-minute skew window → still cached
  await tp.token();
  now += 300_000; // past expiry − skew → refetch
  const refreshed = await tp.token();

  assert.equal(refreshed, 'token-2');
  assert.equal(transport.calls.length, 2); // 1 token request + 1 refresh
  const req = transport.calls[0]!.request;
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(req.body ?? '{}'), {
    clientId: 'id',
    clientSecret: 'secret',
    scope: 'pdp-telemetry/battery pdp-charging/targetSoc',
  });
});

test('surfaces token-endpoint failures as AuthError with OAuth error, requestId and timestamp', async () => {
  const transport = new ScriptedTransport([
    {
      status: 401,
      body: JSON.stringify({
        error: 'invalid_client',
        error_description: 'Bad credentials',
        requestId: 'auth-req-7',
        timestamp: '2026-01-01T00:00:00Z',
      }),
    },
  ]);
  const tp = new TokenProvider(transport, { tokenUrl: 'https://x/token', clientId: 'id', clientSecret: 'wrong' });
  await assert.rejects(tp.token(), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.status, 401);
    assert.match(err.message, /invalid_client/);
    assert.match(err.message, /Bad credentials/);
    assert.equal(err.requestId, 'auth-req-7');
    assert.equal(err.timestamp, '2026-01-01T00:00:00Z');
    return true;
  });
});
