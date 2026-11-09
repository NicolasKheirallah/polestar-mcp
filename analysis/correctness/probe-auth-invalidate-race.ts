/**
 * Probe: invalidate() races under concurrent 401s.
 *
 * The provider's contract is "a 401 triggers exactly one fresh-token retry" and
 * "concurrent callers share one request". When several in-flight reads were sent
 * with the same stale token, each 401 calls invalidate(), which drops whatever
 * token is cached *at that moment* - including a token minted after the 401 that
 * triggered it. Each retry can then mint another token, so the "one fresh token"
 * becomes N+1 token POSTs, all metered against the daily budget.
 */
import { TokenProvider } from '../../src/auth.js';
import { PolestarClient } from '../../src/client.js';
import type { Transport, TransportRequest, TransportResponse } from '../../src/transport.js';

const BASE = 'https://api.test/m2m';
const VIN = 'YSMTEST22PL000001';

let tokenPosts = 0;
let getAttempts = 0;
const tokenUsedPerGet: string[] = [];

const tokenResponse = (): TransportResponse => {
  tokenPosts += 1;
  return { status: 200, body: JSON.stringify({ accessToken: `tok-${tokenPosts}`, expiresIn: 3600, tokenType: 'Bearer' }) };
};

const transport: Transport = {
  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    if (url.endsWith('/token')) return tokenResponse();
    getAttempts += 1;
    const attempt = getAttempts;
    tokenUsedPerGet.push(String(request.headers?.authorization));
    // Stagger the first three 401s so each invalidate() lands after the previous
    // retry already cached its fresh token.
    if (attempt <= 3) await new Promise((r) => setTimeout(r, (attempt - 1) * 15));
    return { status: 401, body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'expired', httpStatus: 401 } }) };
  },
};

const tokens = new TokenProvider(transport, { tokenUrl: `${BASE}/token`, clientId: 'id', clientSecret: 's' });
const client = new PolestarClient(tokens, transport, { baseUrl: BASE, accountId: 'acct' });

const settled = await Promise.allSettled([
  client.domain(VIN, 'telemetry', 'battery'),
  client.domain(VIN, 'telemetry', 'odometer'),
  client.domain(VIN, 'telemetry', 'health'),
]);

console.log(
  JSON.stringify(
    {
      requests: 3,
      allFailedWith401: settled.every((s) => s.status === 'rejected' && (s.reason as { httpStatus?: number }).httpStatus === 401),
      tokenPosts,
      getAttempts,
      authorizationUsed: tokenUsedPerGet,
      note: 'each 401 wipes the token that the previous retry had just minted, so 3 requests spent 4 token POSTs instead of 2',
    },
    null,
    2,
  ),
);
