import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractChargingSessions, degradationSeries, HistoryStore } from '../src/history.js';

function withTempStore(run: (store: HistoryStore) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'polestar-history-'));
  try {
    run(new HistoryStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('history store dedupes by metaEventId and queries by time', () => {
  withTempStore((store) => {
    const t0 = 1_700_000_000_000;
    store.append('VINX', 'telemetry', 'battery', { observedAt: t0, metaEventId: 'a', data: { batteryChargeLevelPercentage: 50 } });
    store.append('VINX', 'telemetry', 'battery', { observedAt: t0 + 1, metaEventId: 'a', data: { batteryChargeLevelPercentage: 50 } }); // dupe
    store.append('VINX', 'telemetry', 'battery', { observedAt: t0 + 2, metaEventId: 'b', data: { batteryChargeLevelPercentage: 51 } });
    const all = store.query('VINX', 'telemetry', 'battery');
    assert.equal(all.length, 2);
    assert.equal(all[0]!.metaEventId, 'b'); // newest first
    const since = store.query('VINX', 'telemetry', 'battery', { sinceMs: t0 + 2 });
    assert.equal(since.length, 1);
  });
});

test('charging session extraction segments on charging status with gap tolerance', () => {
  const min = 60_000;
  const samples: { observedAt: number; data: Record<string, unknown> }[] = [
    { observedAt: 0, data: { chargingStatusV2: 'CHARGING_STATUS_V2_IDLE', chargingPowerWatts: 0 } },
    { observedAt: min, data: { chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING', chargingPowerWatts: 7000, batteryChargeLevelPercentage: 40 } },
    { observedAt: 5 * min, data: { chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING', chargingPowerWatts: 11000, batteryChargeLevelPercentage: 45 } },
    { observedAt: 6 * min, data: { chargingStatusV2: 'CHARGING_STATUS_V2_IDLE', chargingPowerWatts: 0, batteryChargeLevelPercentage: 46 } },
  ].map(({ observedAt, data }) => ({ observedAt, data }));
  const sessions = extractChargingSessions(samples.map((s) => ({ observedAt: s.observedAt, metaEventId: undefined, data: s.data })));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.peakPowerWatts, 11000);
  assert.equal(sessions[0]!.maxChargeLevelPct, 45);
  assert.equal(sessions[0]!.sampleCount, 2);
});

test('degradation series derives implied full range and capacity', () => {
  const points = degradationSeries([
    { observedAt: 1, metaEventId: undefined, data: { batteryChargeLevelPercentage: 50, estimatedDistanceToEmptyKm: 170, dischargeInfo: { energyAvailable: 34 } } },
    { observedAt: 2, metaEventId: undefined, data: { batteryChargeLevelPercentage: 3, estimatedDistanceToEmptyKm: 10 } }, // filtered: SoC <= 5
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.impliedFullRangeKm, 340);
  assert.equal(points[0]!.impliedCapacityKwh, 68);
});
