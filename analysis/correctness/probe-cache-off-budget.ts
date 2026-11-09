/**
 * Probe: does POLESTAR_CACHE=off (a cache-only setting) also remove the retry
 * wrapper that meters the daily budget and the per-minute ceiling?
 *
 * src/server.ts:78-79 picks the inner transport with
 *   config.fixturesDir || config.cacheDisabled ? base : new RetryingTransport(base, ...)
 * so cache-off selects the *unmetered* base transport. Everything below is
 * offline: globalThis.fetch is stubbed, no socket is opened.
 */
import { buildEngine } from '../../src/server.js';

const VIN = 'YSMTEST22PL000001';
let fetchCalls: string[] = [];

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let vehicleAttempts = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  fetchCalls.push(url);
  if (url.endsWith('/token')) return ok({ accessToken: 'token-1', expiresIn: 3600, tokenType: 'Bearer' });
  vehicleAttempts += 1;
  // The gateway's transient answer: 429 first, 200 on a retry.
  if (vehicleAttempts <= 2) return new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), { status: 429, headers: { 'retry-after': '0' } });
  return ok({ data: [VIN] });
}) as typeof fetch;

const liveEnv = {
  POLESTAR_CLIENT_ID: 'oauth-client',
  POLESTAR_CLIENT_SECRET: 'secret',
  POLESTAR_ACCOUNT_ID: 'account-1',
};

async function run(label: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  fetchCalls = [];
  vehicleAttempts = 0;
  const engine = buildEngine(env);
  let outcome: string;
  try {
    outcome = JSON.stringify(await engine.client.vehicles());
  } catch (err) {
    outcome = `${(err as { name?: string }).name}: ${(err as Error).message}`;
  }
  const result = {
    label,
    cacheEnabled: engine.cacheStats.enabled,
    budgetUsed: engine.budget.snapshot().used,
    minuteUsed: engine.minute.snapshot().used,
    httpRequests: fetchCalls.length,
    vehiclesOutcome: outcome,
  };
  engine.sampler?.stop();
  return result;
}

const off = await run('POLESTAR_CACHE=off', { ...liveEnv, POLESTAR_CACHE: 'off' });
const on = await run('cache default (on)', { ...liveEnv });
console.log(JSON.stringify({ off, on }, null, 2));
