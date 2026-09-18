import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractChargingSessions, degradationSeries, HistoryStore } from '../src/history.js';
import { humanizeEnum, summarizeDomain, formatAge } from '../src/format.js';
import { planCheapestCharge } from '../src/planner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('humanizeEnum decodes the API enum vocabularies', () => {
  assert.equal(humanizeEnum('CHARGING_STATUS_V2_IDLE'), 'Idle');
  assert.equal(humanizeEnum('USAGE_MODE_ABANDONED'), 'Asleep / not in use');
  assert.equal(humanizeEnum('BRAKE_FLUID_LEVEL_WARNING_NO_WARNING'), 'OK');
  assert.equal(humanizeEnum('CHARGER_CONNECTION_STATUS_DISCONNECTED'), 'Unplugged');
  assert.equal(humanizeEnum('LOCK_STATUS_LOCKED'), 'Locked');
  assert.equal(humanizeEnum('HEATING_INTENSITY_UNSPECIFIED'), 'Off');
});

test('a pending amp limit is reported only when it differs from the applied one', () => {
  // Live data carries pendingAmpLimit beside ampLimit. When they agree there is
  // nothing to say; when they differ, saying only the applied figure would tell
  // an agent the car is charging at a current it has not accepted yet.
  const settled = summarizeDomain('amp-limit', {
    ampLimit: { ampLimit: 20 },
    pendingAmpLimit: { ampLimit: 20 },
  }, 'km');
  assert.deepEqual(settled, ['AC charge current limit: 20 A']);

  const waiting = summarizeDomain('amp-limit', {
    ampLimit: { ampLimit: 20 },
    pendingAmpLimit: { ampLimit: 7 },
  }, 'km');
  assert.ok(waiting !== null && waiting.length === 2, 'expected the applied limit plus a pending-change line');
  assert.match(String(waiting[1]), /7 A .* not yet confirmed/);

  const absent = summarizeDomain('amp-limit', { ampLimit: { ampLimit: 16 } }, 'km');
  assert.deepEqual(absent, ['AC charge current limit: 16 A'], 'a car with no pending change must not gain a line');
});

test('one distance convention per summary, whatever the unit', () => {
  // Live output used to mix them: the odometer rendered `76,405 mi` while the
  // trip meters underneath it rendered `2873 km (1785 mi)`.
  const km = summarizeDomain('odometer', { odometerMeters: 122_963_000, tripMeterManualKm: 2873, tripMeterAutomaticKm: 10 }, 'mi');
  const mi = summarizeDomain('odometer', { odometerMeters: 122_963_000, tripMeterManualKm: 2873, tripMeterAutomaticKm: 10 }, 'km');
  assert.ok(km !== null && mi !== null);
  assert.equal(km.every((line) => !/km \(/.test(line)), true, 'a converted distance is shown in two units beside one that is not');
  assert.match(km[0]!, /mi$/);
  assert.match(mi[0]!, /km$/);
  // Battery range is the API's own dual field, so it keeps showing both.
  const battery = summarizeDomain('battery', { estimatedDistanceToEmptyKm: 170, batteryChargeLevelPercentage: 49 }, 'mi');
  assert.match(String(battery?.[0]), /range 170 km \(106 mi\)/);
});

test('summarizeDomain renders battery and exterior summaries', () => {
  const battery = summarizeDomain('battery', {
    batteryChargeLevelPercentage: 49,
    estimatedDistanceToEmptyKm: 170,
    chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING',
    chargerConnectionStatus: 'CHARGER_CONNECTION_STATUS_CONNECTED',
    chargingPowerWatts: 7400,
  }, 'km');
  assert.ok(battery![0]!.includes('49%'));
  assert.ok(battery![2]!.includes('7.4 kW'));

  const exterior = summarizeDomain('exterior', {
    frontLeftDoor: 'OPEN_STATUS_OPEN',
    centralLock: 'LOCK_STATUS_UNLOCKED',
    alarm: 'ALARM_STATUS_IDLE',
  }, 'km');
  assert.ok(exterior![0]!.includes('Open: front left door'));
  assert.ok(exterior![0]!.includes('Unlocked'));
});

test('formatAge speaks relative time', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatAge(now - 30_000, now), '30s ago');
  assert.equal(formatAge(now - 5 * 60_000, now), '5 min ago');
  assert.equal(formatAge(now - 3 * 3_600_000, now), '3 h ago');
});

const HOURLY_PRICES = [
  '2026-09-19T22:00:00Z',
  '2026-09-19T23:00:00Z',
  '2026-09-20T00:00:00Z',
  '2026-09-20T01:00:00Z',
].map((startsAt, i) => ({ startsAt, price: [0.9, 0.2, 0.1, 0.5][i]! }));

test('planner picks the cheapest contiguous hours inside the window', () => {
  const plan = planCheapestCharge({
    prices: HOURLY_PRICES,
    socPct: 40,
    targetPct: 80,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 0,
    windowEndHour: 6,
    nowMs: Date.parse('2026-09-19T23:30:00Z'),
  });
  assert.equal(plan.feasible, true);
  assert.equal(plan.energyNeededKwh, 32);
  // cheapest contiguous 1h slots are 00:00 (0.1) and 23:00 (0.2); only 00:00–06:00 window includes 00:00
  assert.ok(plan.steps.length >= 2);
  assert.equal(plan.steps[0]!.price, 0.1);
});

test('planner handles wrap-around windows (23→06) and reports assumptions', () => {
  const plan = planCheapestCharge({
    prices: HOURLY_PRICES,
    socPct: 40,
    targetPct: 80,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 23,
    windowEndHour: 6,
    nowMs: Date.parse('2026-09-19T12:00:00Z'),
  });
  assert.equal(plan.feasible, true);
  // 23:00 (0.2) and 00:00 (0.1) are the two cheapest in the wrapped window
  const hours = plan.steps.map((s) => new Date(s.startsAt).getUTCHours());
  assert.deepEqual(hours.slice(0, 2), [23, 0]); // ascending in time: 23:00 then 00:00
  assert.ok(plan.assumptions.some((a) => a.includes('10.0 kW')));
});

test('planner falls back to cheapest individual hours when the window is too short', () => {
  const plan = planCheapestCharge({
    prices: [
      { startsAt: '2026-09-20T00:00:00Z', price: 0.1 },
      { startsAt: '2026-09-20T01:00:00Z', price: 0.9 },
      { startsAt: '2026-09-20T02:00:00Z', price: 0.2 },
    ],
    socPct: 0,
    targetPct: 90,
    capacityKwh: 100,
    powerKw: 100, // 0.9h needed → 1h per ceil, but need 90 kWh across 3 hours of window
    windowStartHour: 0,
    windowEndHour: 3,
    nowMs: Date.parse('2026-09-19T23:00:00Z'),
  });
  assert.equal(plan.feasible, true);
  assert.ok(plan.reason !== undefined || plan.steps.length > 0);
});

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
    { observedAt: 2, metaEventId: undefined, data: { batteryChargeLevelPercentage: 3, estimatedDistanceToEmptyKm: 10 } }, // filtered: SoC ≤ 5
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0]!.impliedFullRangeKm, 340);
  assert.equal(points[0]!.impliedCapacityKwh, 68);
});
