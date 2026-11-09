/**
 * Probe: polestar_status self-report accuracy.
 *  A) "Token: trusted ~N more min" uses expiresAt() without the 5-minute skew the
 *     provider itself applies, so it overstates how long the token will be used.
 *  B) "Cache: off (POLESTAR_CACHE_DISABLED, ...)" names a variable the loader
 *     never reads (POLESTAR_CACHE is the real one).
 */
import { TokenProvider } from '../../src/auth.js';
import { BudgetMeter, MinuteWindowMeter } from '../../src/budget.js';
import { systemToolSpecs } from '../../src/system-tools.js';
import { toolSpec } from '../../src/tools.js';
import { loadConfig, unknownEnvVariables } from '../../src/config.js';
import type { Transport, TransportResponse } from '../../src/transport.js';

const out: Record<string, unknown> = {};

// A: token clock
let now = 0;
let tokenRequests = 0;
const transport: Transport = {
  async fetch(): Promise<TransportResponse> {
    tokenRequests += 1;
    return { status: 200, body: JSON.stringify({ accessToken: `token-${tokenRequests}`, expiresIn: 3600, tokenType: 'Bearer' }) };
  },
};
const provider = new TokenProvider(transport, { tokenUrl: 'https://x/token', clientId: 'id', clientSecret: 's', now: () => now });
await provider.token(); // expiresAt = 3_600_000
now = 3_400_000; // 200s (3.3 min) before expiry, i.e. inside the 300s skew
const status = await toolSpec(
  systemToolSpecs({
    client: {} as never,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
    budget: new BudgetMeter(10_000, () => now),
    minute: new MinuteWindowMeter(100, () => now),
    cacheStats: { enabled: true, hits: 0, staleServed: 0, misses: 0, refreshes: 0, entries: 0 },
    tokenExpiresAt: () => provider.expiresAt(),
    fixtureMode: false,
    nowMs: () => now,
  }),
  'polestar_status',
).run({}, {});
const tokenLine = status.content[0]!.text.split('\n').find((l) => l.startsWith('Token:')) ?? '';
const requestsBefore = tokenRequests;
await provider.token(); // the provider's own answer at that moment: is the reported time really trusted?
out.A_token_clock = {
  statusLine: tokenLine,
  tokenRequestsBefore: requestsBefore,
  tokenRequestsAfterCallingToken: tokenRequests,
  note: 'status said "trusted", the provider refetched because the 300s skew had started',
};

// B: env variable name
const offStatus = await toolSpec(
  systemToolSpecs({
    client: {} as never,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
    budget: new BudgetMeter(10_000),
    minute: new MinuteWindowMeter(100),
    cacheStats: { enabled: false, hits: 0, staleServed: 0, misses: 0, refreshes: 0, entries: 0 },
    tokenExpiresAt: () => undefined,
    fixtureMode: false,
  }),
  'polestar_status',
).run({}, {});
out.B_cache_off_line = offStatus.content[0]!.text.split('\n').find((l) => l.startsWith('Cache:')) ?? '';
out.B_named_variable_is_recognized = !unknownEnvVariables({ POLESTAR_CACHE_DISABLED: '1' }).some((u) => u.name === 'POLESTAR_CACHE_DISABLED');
out.B_named_variable_unknown_report = unknownEnvVariables({ POLESTAR_CACHE_DISABLED: '1' });
out.B_real_switch = { POLESTAR_CACHE_off_disables_cache: loadConfig({ POLESTAR_CACHE: 'off', POLESTAR_CLIENT_ID: 'c', POLESTAR_CLIENT_SECRET: 's', POLESTAR_ACCOUNT_ID: 'a' }).cacheDisabled };

console.log(JSON.stringify(out, null, 2));
