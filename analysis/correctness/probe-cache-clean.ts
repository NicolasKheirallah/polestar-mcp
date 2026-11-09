/**
 * Probes for cache behaviour that turned out clean (evidence for the
 * "probed and found clean" section):
 *  1) concurrent misses for one URL collapse into one live call;
 *  2) the TTL boundary is exclusive: at exactly fetchedAt+ttl the entry is stale;
 *  3) two different VINs (different URLs) never share an entry;
 *  4) a stale serve plus a concurrent joiner produce exactly one refresh.
 */
import { CachingTransport } from '../../src/caching-transport.js';
import type { Transport, TransportResponse } from '../../src/transport.js';

const ok = (id: string): TransportResponse => ({ status: 200, body: JSON.stringify({ data: { metaEventId: id } }) });
const VIN_A = 'https://api.test/m2m/v1/vehicles/YSMTEST22PL000001/telemetry/battery';
const VIN_B = 'https://api.test/m2m/v1/vehicles/YSMTEST22PL000002/telemetry/battery';
const out: Record<string, unknown> = {};

// 1: concurrent misses
let calls1 = 0;
const inner1: Transport = {
  async fetch() {
    calls1 += 1;
    await new Promise((r) => setTimeout(r, 10));
    return ok('e1');
  },
};
const cache1 = new CachingTransport(inner1);
await Promise.all([cache1.fetch(VIN_A), cache1.fetch(VIN_A), cache1.fetch(VIN_A)]);
out.concurrent_misses = { liveCalls: calls1, hits: cache1.stats.hits, misses: cache1.stats.misses, refreshes: cache1.stats.refreshes };

// 2: TTL boundary (battery TTL = 30_000ms)
let now = 1_000_000;
let calls2 = 0;
const inner2: Transport = {
  async fetch() {
    calls2 += 1;
    return ok(`e${calls2}`);
  },
};
const cache2 = new CachingTransport(inner2, { now: () => now });
await cache2.fetch(VIN_A);
now += 29_999;
await cache2.fetch(VIN_A); // fresh
const justInside = calls2;
now += 1; // exactly fetchedAt + ttl
await cache2.fetch(VIN_A); // stale, background refresh
out.ttl_boundary = { justInsideTtlLiveCalls: justInside, atExactBoundaryLiveCalls: calls2, staleServed: cache2.stats.staleServed };

// 3: different VINs do not share
let calls3 = 0;
const inner3: Transport = {
  async fetch() {
    calls3 += 1;
    return ok('e');
  },
};
const cache3 = new CachingTransport(inner3);
await cache3.fetch(VIN_A);
await cache3.fetch(VIN_B);
out.cross_vin = { liveCalls: calls3, note: 'different VIN -> different URL key -> no sharing' };

// 4: stale serve + joiner, one refresh
let now4 = 1_000_000;
let calls4 = 0;
let release: (() => void) | undefined;
const inner4: Transport = {
  async fetch() {
    calls4 += 1;
    if (calls4 === 1) return ok('old');
    await new Promise<void>((r) => {
      release = r;
    });
    return ok('new');
  },
};
const cache4 = new CachingTransport(inner4, { now: () => now4 });
await cache4.fetch(VIN_A); // prime
now4 += 31_000;
const stale = await cache4.fetch(VIN_A);
const joiner = cache4.fetch(VIN_A); // joins the in-flight revalidation
release!();
await joiner;
await new Promise((r) => setImmediate(r));
out.stale_single_flight = { staleBody: JSON.parse(stale.body).data.metaEventId, liveCalls: calls4, staleServed: cache4.stats.staleServed };

console.log(JSON.stringify(out, null, 2));
