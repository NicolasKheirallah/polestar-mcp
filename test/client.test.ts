import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolestarApiError, PolestarClient } from '../src/client.js';
import { TokenProvider } from '../src/auth.js';
import { FixtureTransport } from '../src/transport.js';
import { fileURLToPath } from 'node:url';
import { ScriptedTransport, tokenBody } from './helpers.js';

const BASE = 'https://api.test/m2m';
const VIN = 'YSMTEST22PL000001';

interface StubResponse {
  status: number;
  body: string;
}

function makeClient(responses: StubResponse[], opts: { delegatedAccountId?: string } = {}) {
  const transport = new ScriptedTransport(responses);
  const tp = new TokenProvider(transport, {
    tokenUrl: `${BASE}/token`,
    clientId: 'oauth-client',
    clientSecret: 'secret',
  });
  const client = new PolestarClient(tp, transport, {
    baseUrl: BASE,
    accountId: 'account-1',
    ...(opts.delegatedAccountId ? { delegatedAccountId: opts.delegatedAccountId } : {}),
  });
  return { client, transport };
}

test('unwraps the {data, meta} envelope and returns the domain payload', async () => {
  const payload = { vin: VIN, batteryChargeLevelPercentage: 52 };
  const { client } = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: payload, meta: { domain: 'battery', vin: VIN } }) },
  ]);
  const result = await client.domain(VIN, 'telemetry', 'battery');
  assert.deepEqual(result, payload);
});

test('sends bearer token, x-client-id and accept headers to the right URL', async () => {
  const { client, transport } = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: { vin: VIN } }) },
  ]);
  await client.domain(VIN, 'charging', 'target-soc');
  const dataCall = transport.calls[1]!;
  assert.equal(dataCall.url, `${BASE}/v1/vehicles/${VIN}/charging/target-soc`);
  assert.equal(dataCall.request.headers?.authorization, 'Bearer t');
  assert.equal(dataCall.request.headers?.['x-client-id'], 'account-1');
  assert.equal(dataCall.request.headers?.accept, 'application/json');
});

test('sends x-delegated-account-id when third-party delegation is configured', async () => {
  const { client, transport } = makeClient(
    [tokenBody('t'), { status: 200, body: JSON.stringify({ data: { vin: VIN } }) }],
    { delegatedAccountId: 'fleet-partner@example.com' },
  );
  await client.domain(VIN, 'telemetry', 'battery');
  assert.equal(transport.calls[1]!.request.headers?.['x-delegated-account-id'], 'fleet-partner@example.com');
});

test('normalizes API error envelopes into PolestarApiError with requestId and details', async () => {
  const { client } = makeClient([
    tokenBody('t'),
    {
      status: 400,
      body: JSON.stringify({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid VIN format.',
          httpStatus: 400,
          requestId: 'req-42',
          timestamp: '2026-01-01T00:00:00Z',
          details: { requested_vin: VIN },
        },
      }),
    },
  ]);
  await assert.rejects(client.domain(VIN, 'telemetry', 'battery'), (err: unknown) => {
    assert.ok(err instanceof PolestarApiError);
    assert.equal(err.code, 'INVALID_REQUEST');
    assert.equal(err.message, 'Invalid VIN format.');
    assert.equal(err.httpStatus, 400);
    assert.equal(err.requestId, 'req-42');
    assert.deepEqual(err.details, { requested_vin: VIN });
    return true;
  });
});

test('maps 404 DATA_NOT_AVAILABLE to null instead of an error', async () => {
  const { client } = makeClient([
    tokenBody('t'),
    {
      status: 404,
      body: JSON.stringify({
        error: { code: 'DATA_NOT_AVAILABLE', message: 'No data.', httpStatus: 404 },
      }),
    },
  ]);
  const result = await client.domain(VIN, 'charging', 'is-at-charge-location');
  assert.equal(result, null);
});

test('rejects a vehicles response whose data is not an array', async () => {
  const { client } = makeClient([tokenBody('t'), { status: 200, body: JSON.stringify({ data: null }) }]);
  await assert.rejects(client.vehicles(), (err: unknown) => {
    assert.ok(err instanceof PolestarApiError);
    assert.equal(err.code, 'BAD_RESPONSE');
    assert.match(err.message, /no data array/);
    return true;
  });
});

test('lists VINs from the vehicles response', async () => {
  const { client } = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: [VIN], meta: { count: 1 } }) },
  ]);
  assert.deepEqual(await client.vehicles(), [VIN]);
});

test('retries exactly once with a fresh token after a 401', async () => {
  const { client, transport } = makeClient([
    tokenBody('token-1'),
    { status: 401, body: 'expired' }, // data call fails with stale token
    tokenBody('token-2'), // provider refetches after invalidate()
    { status: 200, body: JSON.stringify({ data: { ok: true } }) },
  ]);
  const result = await client.domain(VIN, 'telemetry', 'battery');
  assert.deepEqual(result, { ok: true });
  assert.equal(transport.calls.length, 4);
  assert.equal(transport.calls[1]!.request.headers?.authorization, 'Bearer token-1');
  assert.equal(transport.calls[3]!.request.headers?.authorization, 'Bearer token-2');
});

test('propagates the error when the retry also gets a 401', async () => {
  const { client, transport } = makeClient([
    tokenBody('token-1'),
    { status: 401, body: 'expired' },
    tokenBody('token-2'),
    { status: 401, body: 'still expired' },
  ]);
  await assert.rejects(client.domain(VIN, 'telemetry', 'battery'), (err: unknown) => {
    assert.ok(err instanceof PolestarApiError);
    assert.equal(err.httpStatus, 401);
    return true;
  });
  assert.equal(transport.calls.length, 4);
});

test('FixtureTransport maps dump-layout paths and rejects unmapped routes', async () => {
  const root = fileURLToPath(new URL('./fixtures/dump', import.meta.url));
  const fx = new FixtureTransport(root);
  const tp = new TokenProvider(fx, { tokenUrl: `${BASE}/token`, clientId: 'c', clientSecret: 's' });
  const client = new PolestarClient(tp, fx, { baseUrl: BASE, accountId: 'a' });

  assert.deepEqual(await client.vehicles(), [VIN]);

  const battery = await client.domain(VIN, 'telemetry', 'battery');
  assert.equal((battery as { batteryChargeLevelPercentage?: number }).batteryChargeLevelPercentage, 52);

  // A route with no fixture is a harness gap, not "the vehicle reports nothing",
  // so it surfaces as an error rather than the null the DATA_NOT_AVAILABLE rule
  // produces. Keeping the two distinct is what makes that rule falsifiable.
  await assert.rejects(client.domain(VIN, 'charging', 'no-such-domain'), (err: unknown) => {
    assert.ok(err instanceof PolestarApiError);
    assert.equal(err.code, 'NOT_FOUND');
    return true;
  });

  const target = await client.domain(VIN, 'charging', 'target-soc');
  assert.equal((target as { targetSoc?: { batteryChargeTargetLevel?: number } }).targetSoc?.batteryChargeTargetLevel, 80);
});

test('FixtureTransport replays captured error envelopes with their original status', async () => {
  const root = fileURLToPath(new URL('./fixtures/dump', import.meta.url));
  const fx = new FixtureTransport(root);
  // The captured is-at-charge-location response is a 404 error envelope; the
  // adapter must replay the status so the client takes the documented 404
  // branch (not the envelope-fallback path).
  const res = await fx.fetch(`${BASE}/v1/vehicles/${VIN}/charging/is-at-charge-location`);
  assert.equal(res.status, 404);

  const tp = new TokenProvider(fx, { tokenUrl: `${BASE}/token`, clientId: 'c', clientSecret: 's' });
  const client = new PolestarClient(tp, fx, { baseUrl: BASE, accountId: 'a' });
  assert.equal(await client.domain(VIN, 'charging', 'is-at-charge-location'), null);
});

test('resolveVin defaults to the only vehicle and rejects malformed VINs', async () => {
  const { client } = makeClient([tokenBody('t'), { status: 200, body: JSON.stringify({ data: [VIN] }) }]);
  assert.equal(await client.resolveVin(undefined), VIN);
  await assert.rejects(client.resolveVin('NOT-A-VIN'), (err: unknown) => {
    assert.ok(err instanceof PolestarApiError);
    assert.equal(err.code, 'INVALID_VIN');
    return true;
  });
});

test('resolveVin refuses to guess among several vehicles', async () => {
  const vins = ['YSMTEST22PL000001', 'YSMTEST22PL000002'];
  const { client } = makeClient([tokenBody('t'), { status: 200, body: JSON.stringify({ data: vins }) }]);
  await assert.rejects(client.resolveVin(undefined), (err: unknown) => {
    assert.ok(err instanceof PolestarApiError);
    assert.equal(err.code, 'AMBIGUOUS_VIN');
    assert.match(err.message, /2 vehicles/);
    return true;
  });
  assert.equal(await client.resolveVin(vins[1]), vins[1]);
});
