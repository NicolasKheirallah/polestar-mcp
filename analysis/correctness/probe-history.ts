/**
 * Probes for HistoryStore (src/history.ts):
 *  A) append() records the metaEventId in memory *before* appendFileSync; when the
 *     write throws, the same event is silently swallowed on the retry.
 *  B) extractChargingSessions uses Math.max(...array): how many samples can a
 *     legitimate history file hold before that throws a RangeError?
 *  C) torn last line tolerance + restart dedupe (expected clean, documented).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractChargingSessions, HistoryStore } from '../../src/history.js';

const dir = mkdtempSync(path.join(tmpdir(), 'polestar-probe-history-'));
const VIN = 'YSMTEST22PL000001';
const out: Record<string, unknown> = {};

try {
  // A: a failed append poisons the dedupe map
  const store = new HistoryStore(dir);
  // Make the target path un-writable by creating it as a directory: appendFileSync
  // then fails with EISDIR, which is the same class of failure as ENOSPC/EACCES.
  mkdirSync(path.join(dir, VIN, 'telemetry-battery.jsonl'), { recursive: true });
  let firstError = 'no error (unexpected)';
  try {
    store.append(VIN, 'telemetry', 'battery', { observedAt: 1, metaEventId: 'event-a', data: { soc: 50 } });
  } catch (err) {
    firstError = `${(err as NodeJS.ErrnoException).code}: ${(err as Error).message}`;
  }
  // Repair the filesystem as an operator would, then let the caller retry the same event.
  rmSync(path.join(dir, VIN, 'telemetry-battery.jsonl'), { recursive: true });
  let retryResult = 'threw (unexpected)';
  try {
    store.append(VIN, 'telemetry', 'battery', { observedAt: 1, metaEventId: 'event-a', data: { soc: 50 } });
    retryResult = 'silently skipped';
  } catch (err) {
    retryResult = `threw: ${(err as Error).message}`;
  }
  out.A_append_failure = {
    firstError,
    retryOfSameEvent: retryResult,
    recordsAfterRetry: store.query(VIN, 'telemetry', 'battery').length,
    note: 'the failed write is not recorded, and the retry never reaches the file because lastEventId was set first',
  };
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// B: Math.max(...samples) in extractChargingSessions
function sessionsAt(n: number): Record<string, unknown> {
  const samples = Array.from({ length: n }, (_, i) => ({
    observedAt: i * 60_000,
    metaEventId: `e${i}`,
    data: { chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING', chargingPowerWatts: 7_000, batteryChargeLevelPercentage: 50 },
  }));
  try {
    const sessions = extractChargingSessions(samples);
    return { samples: n, ok: true, sessions: sessions.length };
  } catch (err) {
    return { samples: n, ok: false, error: `${(err as Error).name}: ${(err as Error).message}` };
  }
}
out.B_spread_limit = [50_000, 130_000, 200_000, 300_000].map(sessionsAt);

// C: torn last line and restart dedupe
const dirC = mkdtempSync(path.join(tmpdir(), 'polestar-probe-torn-'));
try {
  const store = new HistoryStore(dirC);
  store.append(VIN, 'telemetry', 'battery', { observedAt: 1, metaEventId: 'e1', data: { soc: 50 } });
  store.append(VIN, 'telemetry', 'battery', { observedAt: 2, metaEventId: 'e2', data: { soc: 51 } });
  const file = path.join(dirC, VIN, 'telemetry-battery.jsonl');
  writeFileSync(file, '{"observedAt":3,"metaEventId":"e3","data":{"soc":52}}\n{"observedAt":4,"metaEve', { flag: 'a' });
  const reopened = new HistoryStore(dirC);
  out.C_torn = {
    readableRecords: reopened.query(VIN, 'telemetry', 'battery').length,
    note: "the torn line is skipped on read",
  };
} finally {
  rmSync(dirC, { recursive: true, force: true });
}

console.log(JSON.stringify(out, null, 2));
