/**
 * Probe: Retry-After parsing. src/retrying-transport.ts:88-93 does Number(raw)*1000,
 * so the HTTP-date form is NaN -> treated as absent, and a negative value becomes a
 * negative sleep (retry immediately). The comment claims a server-supplied
 * Retry-After is "honoured as given".
 */
import { RetryingTransport } from '../../src/retrying-transport.js';
import type { Transport, TransportResponse } from '../../src/transport.js';

const now = Date.parse('2026-01-01T00:00:00Z');
const ok = (): TransportResponse => ({ status: 200, body: '{}' });
const throttled = (retryAfter: string): TransportResponse => ({ status: 429, body: '{}', headers: { 'retry-after': retryAfter } });

async function run(label: string, header: string): Promise<Record<string, unknown>> {
  const waits: number[] = [];
  let calls = 0;
  const inner: Transport = {
    async fetch() {
      calls += 1;
      return calls === 1 ? throttled(header) : ok();
    },
  };
  const tp = new RetryingTransport(inner, {
    maxAttempts: 3,
    maxBackoffMs: 5_000,
    totalDeadlineMs: 10 * 60_000,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const res = await tp.fetch('https://api.test/x');
  return { label, header, waits, calls, finalStatus: res.status };
}

const results = [
  // 2030 date, i.e. 4 years away: the server asked us to wait, the code waits 500ms.
  await run('HTTP-date in the future', 'Tue, 01 Jan 2030 00:00:00 GMT'),
  // A negative value: the server asked us to back off, the code sleeps -5000ms.
  await run('negative integer', '-5'),
  // Sanity: the integer form does work.
  await run('integer seconds', '30'),
  // A garbage value: NaN -> treated as absent.
  await run('non-numeric', 'soon'),
];
console.log(JSON.stringify(results, null, 2));
