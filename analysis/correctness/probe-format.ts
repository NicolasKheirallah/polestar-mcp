/**
 * Probe: formatting edges the brief names (NaN, Infinity, unit conversion) and
 * two reachable corrupt-timestamp paths.
 *
 * The domain readers filter to finite numbers, so NaN reaches format.ts only from
 * a computed value or a hand-built payload; the timestamp paths below are
 * reachable from an upstream payload.
 */
import { formatAge, distance, fromKm, km, pct, summarizeDomain } from '../../src/format.js';
import { observedAtMs, epochSecondsMs } from '../../src/domain-data.js';

const now = Date.parse('2026-01-01T00:00:00Z');
const out: Record<string, unknown> = {};

out.latent_nan_and_infinity = {
  pct_NaN: pct(Number.NaN),
  pct_Infinity: pct(Number.POSITIVE_INFINITY),
  distance_NaN_km: distance(Number.NaN, 'km'),
  distance_Infinity_mi: distance(Number.POSITIVE_INFINITY, 'mi'),
  fromKm_NaN_mi: fromKm(Number.NaN, 'mi'),
  km_Infinity_mi: km(Number.POSITIVE_INFINITY, 'mi'),
  formatAge_NaN: formatAge(Number.NaN, now),
};

// A corrupt/far-future timestamp: a 21-digit seconds string (1e20 s).
const corruptTimestamp = { seconds: '1' + '0'.repeat(20) };
out.corrupt_timestamp = {
  epochSecondsMs: epochSecondsMs(corruptTimestamp),
  observedAtMs: observedAtMs({ timestamp: corruptTimestamp }),
  formatAgeOfIt: formatAge(observedAtMs({ timestamp: corruptTimestamp })!, now),
  note: 'a timestamp 3e12 years in the future reports as fresh ("0s ago") instead of unknown',
};

let summarizeError = 'no error';
try {
  summarizeDomain('pre-cleaning', { lastCycleCompleted: corruptTimestamp }, 'km');
} catch (err) {
  summarizeError = `${(err as Error).name}: ${(err as Error).message}`;
}
out.corrupt_timestamp_summarizer = {
  summarizeError,
  note: 'summarizeDomain throws instead of saying the timestamp is unusable; a domain tool turns this into INTERNAL_ERROR',
};

console.log(JSON.stringify(out, null, 2));
