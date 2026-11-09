/**
 * Probe: does a cache hit cross a delegated-account identity boundary?
 *
 * Chain mirrors src/server.ts: cache -> retrying -> base; one CachingTransport
 * shared by the owner client and every client built by forDelegation().
 */
import { CachingTransport } from '../../src/caching-transport.js';
import { TokenProvider } from '../../src/auth.js';
import { PolestarClient } from '../../src/client.js';
import type { Transport, TransportRequest, TransportResponse } from '../../src/transport.js';

const BASE = 'https://api.test/m2m';
const OWNER_VIN = 'YSMTEST22PL000001';
const PARTNER_VIN = 'YSM-PARTNER-VIN-01';

const calls: { url: string; delegated: string | undefined }[] = [];

const base: Transport = {
  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    const delegated = request.headers?.['x-delegated-account-id'];
    calls.push({ url, delegated });
    if (url.endsWith('/token')) {
      return { status: 200, body: JSON.stringify({ accessToken: 'token-1', expiresIn: 3600, tokenType: 'Bearer' }) };
    }
    if (url.endsWith('/v1/vehicles')) {
      // Upstream answers per identity: the owner sees its VIN, the partner sees the shared VIN.
      return {
        status: 200,
        body: JSON.stringify({ data: delegated === 'partner-a' ? [PARTNER_VIN] : [OWNER_VIN] }),
      };
    }
    // Per-identity battery payload, distinguishable by the charge level.
    const soc = delegated === 'partner-a' ? 42 : 77;
    return {
      status: 200,
      body: JSON.stringify({ data: { vin: url.split('/')[6], batteryChargeLevelPercentage: soc } }),
    };
  },
};

const cache = new CachingTransport(base);
const tokens = new TokenProvider(cache, { tokenUrl: `${BASE}/token`, clientId: 'id', clientSecret: 'secret' });
const owner = new PolestarClient(tokens, cache, { baseUrl: BASE, accountId: 'owner-account' });
const partner = owner.forDelegation('partner-a');

const out: Record<string, unknown> = {};
out.ownerVehicles = await owner.vehicles();
out.callsAfterOwnerVehicles = calls.length;
out.partnerVehicles = await partner.vehicles();
out.callsAfterPartnerVehicles = calls.length;
out.vehicleCalls = calls.filter((c) => c.url.endsWith('/v1/vehicles'));

// Partner reads its shared VIN first (cache miss -> header travels).
// What a delegated tool call with an omitted VIN resolves to.
out.partnerResolvedVin = await partner.resolveVin(undefined);
out.ownerResolvedVin = await owner.resolveVin(undefined);

out.partnerBattery = await partner.domain(PARTNER_VIN, 'telemetry', 'battery');
out.callsAfterPartnerBattery = calls.length;
// Owner then reads the same VIN: cache hit, no header, partner's bytes.
out.ownerBatteryAfterPartner = await owner.domain(PARTNER_VIN, 'telemetry', 'battery');
out.callsAfterOwnerBattery = calls.length;

console.log(JSON.stringify(out, null, 2));
