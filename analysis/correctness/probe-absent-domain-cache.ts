/**
 * Probe: is a semantic "the car does not report this domain" (404
 * DATA_NOT_AVAILABLE, which the client maps to null) cached?
 *
 * CachingTransport only stores status < 400, and the 404 sits below the client,
 * so every read of a permanently-absent Domain goes to the API. The live scan in
 * docs/live-contract-findings.md says is-at-charge-location answers that 404 on the
 * reference car.
 */
import { CachingTransport } from '../../src/caching-transport.js';
import { TokenProvider } from '../../src/auth.js';
import { PolestarClient } from '../../src/client.js';
import type { Transport, TransportRequest, TransportResponse } from '../../src/transport.js';

const BASE = 'https://api.test/m2m';
const VIN = 'YSMTEST22PL000001';
const URL = `${BASE}/v1/vehicles/${VIN}/charging/is-at-charge-location`;

const calls: string[] = [];
const inner: Transport = {
  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    calls.push(`${request.method ?? 'GET'} ${url}`);
    if (url.endsWith('/token')) return { status: 200, body: JSON.stringify({ accessToken: 't', expiresIn: 3600 }) };
    return { status: 404, body: JSON.stringify({ error: { code: 'DATA_NOT_AVAILABLE', message: 'no data', httpStatus: 404 } }) };
  },
};

const cache = new CachingTransport(inner);
const tokens = new TokenProvider(cache, { tokenUrl: `${BASE}/token`, clientId: 'id', clientSecret: 's' });
const client = new PolestarClient(tokens, cache, { baseUrl: BASE, accountId: 'acct' });

const first = await client.domain(VIN, 'charging', 'is-at-charge-location');
const second = await client.domain(VIN, 'charging', 'is-at-charge-location');
const third = await client.domain(VIN, 'charging', 'is-at-charge-location');

const domainCalls = calls.filter((c) => c.startsWith('GET'));
console.log(
  JSON.stringify(
    {
      results: [first, second, third],
      cacheStats: cache.stats,
      domainCalls: domainCalls.length,
      note: 'three reads of an absent domain -> three live calls; a 200 response would be served from cache after one',
    },
    null,
    2,
  ),
);
