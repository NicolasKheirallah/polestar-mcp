import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolestarApiError, PolestarClient, type DomainObservation } from '../src/client.js';
import { TokenProvider } from '../src/auth.js';
import { FixtureTransport, HttpTransport } from '../src/transport.js';
import { domainPath, domainRequestPath } from '../src/domains.js';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ScriptedTransport, tokenBody } from './helpers.js';

const BASE = 'https://api.test/m2m';
const VIN = 'YSMTEST22PL000001';

interface StubResponse {
  status: number;
  body: string;
}

function makeClient(responses: StubResponse[], opts: { delegatedAccountId?: string; onDomainRead?: (o: DomainObservation) => void } = {}) {
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
    ...(opts.onDomainRead ? { onDomainRead: opts.onDomainRead } : {}),
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

test('the path a tool advertises is the path the client requests', async () => {
  // These were two assertions with nothing tying them together: one test checked
  // the template the tool descriptions print, another checked the URL that goes
  // out. A route change would have moved them apart in silence. The request now
  // comes from the registry's own grammar, so this asserts the link itself.
  const { client, transport } = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: { vin: VIN } }) },
  ]);
  await client.domain(VIN, 'charging', 'target-soc');

  const advertised = domainPath('charging', 'target-soc');
  assert.equal(advertised, '/v1/vehicles/{vin}/charging/target-soc', 'the template a tool description prints');
  assert.equal(
    transport.calls[1]!.url,
    `${BASE}${advertised.replace('{vin}', VIN)}`,
    'the requested path is that same template with the VIN filled in',
  );
});

test('a VIN that needs escaping is escaped, so it cannot add a path segment', async () => {
  // The payload carries no vin of its own, so the identity check has nothing to
  // compare: this test is about the path, not about that rule.
  const { client, transport } = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: { batteryChargeLevelPercentage: 52 } }) },
  ]);
  await client.domain('a/b', 'telemetry', 'battery');
  assert.equal(transport.calls[1]!.url, `${BASE}${domainRequestPath('a/b', 'telemetry', 'battery')}`);
  assert.ok(transport.calls[1]!.url.includes('a%2Fb'), 'the VIN is percent-encoded');
});

test('a successful read hands the recorder the unwrapped payload and its change id', async () => {
  // The history recorder was handed the raw body by the cache and reached into
  // `body.data.metaEventId` itself, so an Envelope concept lived inside the
  // Transport that merely carried it. The client opens the Envelope, so the client
  // reports what it found.
  const seen: DomainObservation[] = [];
  const { client } = makeClient(
    [
      tokenBody('t'),
      {
        status: 200,
        body: JSON.stringify({
          data: { vin: VIN, metaEventId: 'e7', batteryChargeLevelPercentage: 52 },
          meta: { domain: 'battery', vin: VIN },
        }),
      },
    ],
    { onDomainRead: (o) => seen.push(o) },
  );
  const data = await client.domain(VIN, 'telemetry', 'battery');

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    vin: VIN,
    kind: 'telemetry',
    name: 'battery',
    data: { vin: VIN, metaEventId: 'e7', batteryChargeLevelPercentage: 52 },
    metaEventId: 'e7',
  });
  assert.equal(seen[0]!.data, data, 'and it is the very object the caller was handed, not a copy');
});

test('a payload with no change id, and a Domain that has no data, are recorded apart', async () => {
  const seen: DomainObservation[] = [];
  const { client } = makeClient(
    [
      tokenBody('t'),
      { status: 200, body: JSON.stringify({ data: { vin: VIN } }) },
      { status: 404, body: JSON.stringify({ error: { code: 'DATA_NOT_AVAILABLE', message: 'no data' } }) },
      { status: 200, body: JSON.stringify({ meta: { domain: 'odometer', vin: VIN } }) },
    ],
    { onDomainRead: (o) => seen.push(o) },
  );
  await client.domain(VIN, 'telemetry', 'battery');
  assert.equal(seen[0]!.metaEventId, undefined, 'a payload without a change id reports none');

  const missing = await client.domain(VIN, 'telemetry', 'health');
  assert.equal(missing, null);
  assert.equal(seen.length, 1, 'an absent Domain is not an observation');

  // An Envelope that carries no `data` at all is not one either. It is a read that
  // produced nothing to record, and a recorder that ran on it would be reading
  // metaEventId off undefined.
  const empty = await client.domain(VIN, 'telemetry', 'odometer');
  assert.equal(empty, null);
  assert.equal(seen.length, 1, 'a payload-less Envelope is not an observation either');
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

test('a response labelled for another vehicle or another domain is refused, not shown', async () => {
  // assertIdentity is the guard docs/architecture.md calls the one error this
  // server must never make, and until now no test named either code, so the claim
  // rested on reading the function. Presenting one car's telemetry as another's is
  // the failure that cannot be walked back once it reaches a person.
  const other = 'YSMTEST22PL000099';

  const wrongCar = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: { vin: VIN, batteryChargeLevelPercentage: 52 }, meta: { domain: 'battery', vin: other } }) },
  ]);
  await assert.rejects(
    () => wrongCar.client.domain(VIN, 'telemetry', 'battery'),
    (err: PolestarApiError) => err.code === 'VIN_MISMATCH' && /labelled YSMTEST22PL000099/.test(err.message),
  );

  // The payload repeats the VIN, and it is checked too: an Envelope can be right
  // while the data inside it belongs to the car parked next to it.
  const wrongPayload = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: { vin: other, batteryChargeLevelPercentage: 52 }, meta: { domain: 'battery' } }) },
  ]);
  await assert.rejects(
    () => wrongPayload.client.domain(VIN, 'telemetry', 'battery'),
    (err: PolestarApiError) => err.code === 'VIN_MISMATCH' && /Response data is for/.test(err.message),
  );

  const wrongDomain = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: { vin: VIN, odometerMeters: 1 }, meta: { domain: 'odometer', vin: VIN } }) },
  ]);
  await assert.rejects(
    () => wrongDomain.client.domain(VIN, 'telemetry', 'battery'),
    (err: PolestarApiError) => err.code === 'DOMAIN_MISMATCH' && /labelled telemetry\/odometer/.test(err.message),
  );

  // The case-insensitivity is deliberate: the API answers in whatever case the
  // caller sent, and a mismatch that is only case would refuse a valid read.
  const shouted = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: { vin: VIN.toLowerCase(), batteryChargeLevelPercentage: 52 }, meta: { domain: 'BATTERY', vin: VIN.toLowerCase() } }) },
  ]);
  assert.equal((await shouted.client.domain(VIN, 'telemetry', 'battery'))?.batteryChargeLevelPercentage, 52);
});

test('a 404 that is not DATA_NOT_AVAILABLE stays an error', async () => {
  // live-contract-findings.md records that a mistyped Domain answers
  // VALIDATION_RESOURCE_NOT_FOUND while an unreported one answers
  // DATA_NOT_AVAILABLE, and says treating the two alike would hide a bug in our own
  // routing. Only the second half was tested.
  const typo = makeClient([
    tokenBody('t'),
    { status: 404, body: JSON.stringify({ error: { code: 'VALIDATION_RESOURCE_NOT_FOUND', message: 'Unsupported telematics domain: batteri', httpStatus: 404 } }) },
  ]);
  await assert.rejects(
    () => typo.client.domain(VIN, 'telemetry', 'batteri'),
    (err: PolestarApiError) => err.code === 'VALIDATION_RESOURCE_NOT_FOUND' && err.httpStatus === 404,
    'a typo is a contract error, not a car that reports nothing',
  );

  const absent = makeClient([
    tokenBody('t'),
    { status: 404, body: JSON.stringify({ error: { code: 'DATA_NOT_AVAILABLE', message: 'no data for this domain', httpStatus: 404 } }) },
  ]);
  assert.equal(await absent.client.domain(VIN, 'telemetry', 'is-at-charge-location'), null, 'and an absence is not an error');
});

test('the requests that leave the process are reads and one token exchange', async () => {
  // The API is read-only, so this server is read-only: the first claim in
  // docs/write-endpoints.md. It is only true of the bytes that reach a socket, and a
  // scripted transport hides the method entirely, so this one listens on a real port
  // and records what arrives.
  const seen: { method: string; url: string }[] = [];
  const endpoint = createHttpServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      req.url === '/token'
        ? tokenBody('t').body
        : JSON.stringify({ data: { batteryChargeLevelPercentage: 52 }, meta: { domain: 'battery', vin: VIN } }),
    );
  });
  await new Promise<void>((ready) => endpoint.listen(0, '127.0.0.1', ready));
  const port = (endpoint.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const transport = new HttpTransport(5_000);
    const tp = new TokenProvider(transport, { tokenUrl: `${base}/token`, clientId: 'oauth-client', clientSecret: 'secret' });
    await new PolestarClient(tp, transport, { baseUrl: base, accountId: 'account-1' }).domain(VIN, 'telemetry', 'battery');
  } finally {
    endpoint.close();
  }

  assert.deepEqual(seen.map((c) => c.method), ['POST', 'GET'], 'the token exchange, then one read');
  assert.deepEqual(seen.filter((c) => c.method !== 'GET').map((c) => c.url), ['/token'], 'nothing but the token exchange is anything other than a GET');
  assert.equal(seen.length, 2, 'and nothing else is probed first');
});

test('switching to a delegated account costs no extra request', async () => {
  // The API answers 200 for an x-delegated-account-id that does not exist, so
  // delegation cannot be validated by probing: the server sends the header and reads.
  // A well-meaning "check the account first" call would double every delegated read
  // and teach the caller nothing.
  const { client, transport } = makeClient([
    tokenBody('t'),
    { status: 200, body: JSON.stringify({ data: { batteryChargeLevelPercentage: 52 }, meta: { domain: 'battery', vin: VIN } }) },
  ], { delegatedAccountId: 'partner-a' });
  await client.domain(VIN, 'telemetry', 'battery');

  const reads = transport.calls.filter((c) => !c.url.endsWith('/token'));
  assert.equal(reads.length, 1, 'the header and the read are one request');
  assert.equal(reads[0]!.request.headers?.['x-delegated-account-id'], 'partner-a', 'the header travels with the read, not before it');
});
