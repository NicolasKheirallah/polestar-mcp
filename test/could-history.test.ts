import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../src/history.js';
import { historyToolSpecs } from '../src/history-tools.js';
import { buildCostLedger } from '../src/cost-ledger.js';
import { toolSpec } from '../src/tools.js';
import type { ToolDeps } from '../src/tool-output.js';

/**
 * Could-tier history coverage: the cost ledger, the interval trend, warning
 * transitions, the service forecast and the settings timeline. Each test builds
 * a synthetic store so the arithmetic, not the API, decides the answer.
 */

const VIN = 'VINX';
const DAY = 86_400_000;
const MIN = 60_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'polestar-could-history-'));
}

function deps(store: HistoryStore, nowMs = T0 + 365 * DAY): Parameters<typeof historyToolSpecs>[0] {
  const client = {
    async resolveVin(v?: string) { return v ?? VIN; },
    async vehicles() { return [VIN]; },
    async domain() { return null; },
    forDelegation() { return this; },
  };
  const base = { client, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km', nowMs: () => nowMs } as unknown as ToolDeps;
  return { ...base, store };
}

async function call(
  store: HistoryStore,
  name: 'get_charging_cost' | 'get_warning_changes' | 'get_service_forecast' | 'get_settings_history' | 'get_degradation_report',
  args: Record<string, unknown> = {},
  nowMs?: number,
) {
  return toolSpec(historyToolSpecs(deps(store, nowMs)), name).run(args, {});
}

function textOf(result: { content: { text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

/** A charging sample whose reported usable energy implies a 65.7 kWh pack. */
function chargingSample(at: number, socPct: number, watts: number, metaEventId: string) {
  return {
    observedAt: at,
    metaEventId,
    data: {
      batteryChargeLevelPercentage: socPct,
      chargingPowerWatts: watts,
      chargingStatusV2: watts > 0 ? 'CHARGING_STATUS_V2_CHARGING' : 'CHARGING_STATUS_V2_IDLE',
      dischargeInfo: { energyAvailable: (socPct / 100) * 65.71 },
    },
  };
}

test('the cost ledger derives session energy from the charge-level delta', () => {
  const samples = [
    chargingSample(T0, 40, 7000, 'a'),
    chargingSample(T0 + 30 * MIN, 55, 7000, 'b'),
    chargingSample(T0 + 60 * MIN, 70, 7000, 'c'),
    { observedAt: T0 + 65 * MIN, metaEventId: 'd', data: { batteryChargeLevelPercentage: 70, chargingStatusV2: 'CHARGING_STATUS_V2_IDLE', chargingPowerWatts: 0 } },
  ];
  const ledger = buildCostLedger({ samples, prices: [] });
  assert.ok(ledger.capacityKwh !== undefined && Math.abs(ledger.capacityKwh - 65.71) < 0.5, `capacity ${ledger.capacityKwh}`);
  assert.equal(ledger.sessions.length, 1);
  const session = ledger.sessions[0]!;
  assert.equal(session.startSocPct, 40);
  assert.equal(session.endSocPct, 70);
  assert.ok(session.batteryEnergyKwh !== undefined && Math.abs(session.batteryEnergyKwh - 19.713) < 0.2, `energy ${session.batteryEnergyKwh}`);
  assert.ok(session.gridEnergyKwh !== undefined && Math.abs(session.gridEnergyKwh - 19.713 / 0.9) < 0.2, `grid ${session.gridEnergyKwh}`);
  assert.equal(session.energySource, 'soc-delta');
  assert.equal(session.cost, undefined, 'no prices must mean no cost, not zero cost');
  assert.equal(ledger.totalCost, undefined);
  assert.ok(ledger.unpricedEnergyKwh > 0);
});

test('a session crossing a price hour splits its energy at the boundary', () => {
  const start = Date.parse('2026-01-01T23:00:00Z');
  const samples = [
    chargingSample(start, 40, 7000, 'p1'),
    chargingSample(start + 20 * MIN, 43, 7000, 'p2'),
    chargingSample(start + 40 * MIN, 46, 7000, 'p3'),
    chargingSample(start + 70 * MIN, 48, 7000, 'p4'),
    chargingSample(start + 90 * MIN, 50, 7000, 'p5'),
    { observedAt: start + 95 * MIN, metaEventId: 'p6', data: { batteryChargeLevelPercentage: 50, chargingStatusV2: 'CHARGING_STATUS_V2_IDLE', chargingPowerWatts: 0 } },
  ];
  const prices = [
    { startsAt: '2026-01-01T23:00:00Z', price: 0.2 },
    { startsAt: '2026-01-02T00:00:00Z', price: 0.4 },
  ];
  const ledger = buildCostLedger({ samples, prices });
  assert.equal(ledger.sessions.length, 1);
  const grid = ledger.sessions[0]!.gridEnergyKwh!;
  // The span is 90 minutes from 23:00: 60 minutes at 0.2, 30 minutes at 0.4.
  const expected = grid * (60 / 90) * 0.2 + grid * (30 / 90) * 0.4;
  assert.ok(ledger.sessions[0]!.cost !== undefined && Math.abs(ledger.sessions[0]!.cost - expected) < 1e-6, `cost ${ledger.sessions[0]!.cost} expected ${expected}`);
  assert.ok(ledger.totalCost !== undefined && Math.abs(ledger.totalCost - expected) < 1e-6);
  assert.equal(ledger.unpricedEnergyKwh, 0);
});

test('a partially priced ledger keeps the priced cost and reports the rest as unpriced', () => {
  const start = Date.parse('2026-01-01T23:00:00Z');
  const samples = [
    chargingSample(start, 40, 7000, 'q1'),
    chargingSample(start + 20 * MIN, 42, 7000, 'q2'),
    chargingSample(start + 40 * MIN, 44, 7000, 'q3'),
    chargingSample(start + 60 * MIN, 46, 7000, 'q4'),
    chargingSample(start + 80 * MIN, 48, 7000, 'q5'),
    chargingSample(start + 120 * MIN, 50, 7000, 'q6'),
    { observedAt: start + 125 * MIN, metaEventId: 'q7', data: { batteryChargeLevelPercentage: 50, chargingStatusV2: 'CHARGING_STATUS_V2_IDLE', chargingPowerWatts: 0 } },
  ];
  // Only the first hour has a price; the second hour is inside the span but absent.
  const ledger = buildCostLedger({ samples, prices: [{ startsAt: '2026-01-01T23:00:00Z', price: 0.3 }] });
  assert.ok(ledger.totalCost !== undefined && ledger.totalCost > 0);
  assert.ok(ledger.unpricedEnergyKwh > 0, 'the unpriced hour must not be counted as free');
  assert.ok(ledger.pricedEnergyKwh > 0);
});

test('the cost ledger refuses to invent energy when no capacity or power is recorded', () => {
  const samples = [
    { observedAt: T0, metaEventId: 'r1', data: { batteryChargeLevelPercentage: 40, chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING' } },
    { observedAt: T0 + 30 * MIN, metaEventId: 'r2', data: { batteryChargeLevelPercentage: 41, chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING' } },
  ];
  const ledger = buildCostLedger({ samples, prices: [{ startsAt: '2026-01-01T00:00:00Z', price: 0.3 }] });
  assert.equal(ledger.sessions.length, 1);
  assert.equal(ledger.sessions[0]!.batteryEnergyKwh, undefined);
  assert.equal(ledger.sessions[0]!.cost, undefined);
  assert.equal(ledger.totalCost, undefined);
  assert.ok(ledger.missing.some((line) => /capacity|session energy/.test(line)));
});

test('get_charging_cost states its assumptions and refuses a sparse store with a sentence', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    for (const sample of [
      chargingSample(T0, 40, 7000, 's1'),
      chargingSample(T0 + 20 * MIN, 50, 7000, 's2'),
    ]) store.append(VIN, 'telemetry', 'battery', sample);
    // A final idle sample closes the session.
    store.append(VIN, 'telemetry', 'battery', { observedAt: T0 + 25 * MIN, metaEventId: 's3', data: { batteryChargeLevelPercentage: 50, chargingStatusV2: 'CHARGING_STATUS_V2_IDLE', chargingPowerWatts: 0 } });
    const priced = await call(store, 'get_charging_cost', {
      prices: [{ startsAt: '2026-01-01T00:00:00Z', price: 0.25 }],
    });
    assert.equal(priced.isError, undefined);
    const text = textOf(priced);
    assert.match(text, /Assumptions:/);
    assert.match(text, /capacity/);
    assert.match(text, /kWh at the battery/);
    assert.match(text, /Estimated cost:/);

    const noPrices = await call(store, 'get_charging_cost', {});
    assert.doesNotMatch(textOf(noPrices), /Estimated cost:/);
    assert.match(textOf(noPrices), /no cost is claimed|no prices were supplied/i);

    const empty = new HistoryStore(mkdtempSync(path.join(tmpdir(), 'polestar-cost-empty-')));
    try {
      const refused = await call(empty, 'get_charging_cost', {});
      assert.equal(refused.isError, undefined, 'a sparse store is a sentence, not an error');
      assert.match(textOf(refused), /No battery history recorded/);
    } finally {
      // The temp directory is removed with the outer one below by the OS; this store wrote nothing.
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_warning_changes reports appearances and clearances with the unobserved caveat', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    store.append(VIN, 'telemetry', 'health', {
      observedAt: T0, metaEventId: 'w1', data: { brakeFluidLevelWarning: 'BRAKE_FLUID_LEVEL_WARNING_NO_WARNING' },
    });
    store.append(VIN, 'telemetry', 'health', {
      observedAt: T0 + 10 * MIN, metaEventId: 'w2', data: { brakeFluidLevelWarning: 'BRAKE_FLUID_LEVEL_WARNING_LOW' },
    });
    store.append(VIN, 'telemetry', 'health', {
      observedAt: T0 + 20 * MIN, metaEventId: 'w3', data: { brakeFluidLevelWarning: 'BRAKE_FLUID_LEVEL_WARNING_NO_WARNING' },
    });
    const result = await call(store, 'get_warning_changes', {});
    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.match(text, /appeared: brake fluid level/);
    assert.match(text, /cleared: brake fluid level/);
    assert.match(text, /between two observations/i);
    assert.match(text, /not observed, not absent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_warning_changes refuses zero or one health sample with the caveat', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const none = await call(store, 'get_warning_changes', {});
    assert.equal(none.isError, undefined);
    assert.match(textOf(none), /No health history/);
    assert.match(textOf(none), /not one of the domains/);
    store.append(VIN, 'telemetry', 'health', { observedAt: T0, metaEventId: 'one', data: { serviceWarning: 'SERVICE_WARNING_NO_WARNING' } });
    const one = await call(store, 'get_warning_changes', {});
    assert.match(textOf(one), /Only one health sample/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_service_forecast names the earlier limit from the odometer rate', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    store.append(VIN, 'telemetry', 'health', {
      observedAt: T0,
      metaEventId: 'h1',
      data: { daysToService: 313, distanceToServiceKm: 4150, engineHoursToService: 773 },
    });
    store.append(VIN, 'telemetry', 'odometer', { observedAt: T0, metaEventId: 'o1', data: { odometerMeters: 100_000_000 } });
    store.append(VIN, 'telemetry', 'odometer', { observedAt: T0 + 14 * DAY, metaEventId: 'o2', data: { odometerMeters: 100_700_000 } });
    const result = await call(store, 'get_service_forecast', {}, T0 + 15 * DAY);
    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.match(text, /50\.0 km\/day/);
    assert.match(text, /distance limit arrives first/);
    assert.match(text, /Limits:/);
    assert.match(text, /engine hours/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_service_forecast refuses a thin odometer history without inventing a rate', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    store.append(VIN, 'telemetry', 'health', { observedAt: T0, metaEventId: 'h1', data: { daysToService: 313, distanceToServiceKm: 4150 } });
    store.append(VIN, 'telemetry', 'odometer', { observedAt: T0, metaEventId: 'o1', data: { odometerMeters: 100_000_000 } });
    const result = await call(store, 'get_service_forecast', {}, T0 + DAY);
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /too thin for a rate/);
    assert.doesNotMatch(textOf(result), /km\/day/);
    const noHealth = new HistoryStore(mkdtempSync(path.join(tmpdir(), 'polestar-service-empty-')));
    const refused = await call(noHealth, 'get_service_forecast', {});
    assert.match(textOf(refused), /No health history recorded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_settings_history uses the value clock, names pending changes and ignores an empty pending block', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    store.append(VIN, 'charging', 'amp-limit', {
      observedAt: T0,
      valueObservedAt: T0 - 30 * DAY,
      metaEventId: 'amp-1',
      data: { ampLimit: { ampLimit: 20, source: 'RCS' }, pendingAmpLimit: { ampLimit: 7 } },
    });
    store.append(VIN, 'charging', 'target-soc', {
      observedAt: T0 + MIN,
      valueObservedAt: T0 + MIN,
      metaEventId: 'target-1',
      data: { targetSoc: { batteryChargeTargetLevel: 80, chargeTargetLevelSettingType: 'CUSTOM' } },
    });
    store.append(VIN, 'charging', 'target-soc', {
      observedAt: T0 + 2 * MIN,
      valueObservedAt: T0 + 2 * MIN,
      metaEventId: 'target-2',
      data: { targetSoc: { batteryChargeTargetLevel: 90, chargeTargetLevelSettingType: 'CUSTOM' } },
    });
    store.append(VIN, 'charging', 'global-charge-timer', {
      observedAt: T0,
      valueObservedAt: T0,
      metaEventId: 'timer-1',
      data: { globalChargeTimer: { activated: false, start: { hour: 22 }, stop: { hour: 6 } }, pendingGlobalChargeTimer: { metadata: {} } },
    });
    store.append(VIN, 'charging', 'parking-climate-timer', {
      observedAt: T0 - 5 * DAY,
      metaEventId: 'timer-old',
      data: { parkingClimateTimers: [{ activated: false, readyAt: { hour: 14 }, weekdays: ['SUNDAY'] }] },
    });
    const result = await call(store, 'get_settings_history', {});
    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.match(text, /pending: change to 7 A/);
    assert.match(text, /changed to: .*batteryChargeTargetLevel":90/);
    assert.match(text, /2025-12-02T00:00:00\.000Z/, 'the amp-limit record is dated by its value clock, 30 days before the read');
    assert.doesNotMatch(text, /charge-window edit is recorded/);
    assert.match(text, /1 record\(s\) predate the vehicle clock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_settings_history refuses an empty store with a sentence', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const result = await call(store, 'get_settings_history', {});
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /No charging settings have been recorded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A battery sample whose implied full-charge range is exactly `impliedKm`. */
function degradationSample(at: number, socPct: number, impliedKm: number, metaEventId: string, energyAtFullPack = 65.71) {
  return {
    observedAt: at,
    metaEventId,
    data: {
      batteryChargeLevelPercentage: socPct,
      estimatedDistanceToEmptyKm: (impliedKm * socPct) / 100,
      dischargeInfo: { energyAvailable: (energyAtFullPack * socPct) / 100 },
    },
  };
}

test('the degradation report adds a slope with an interval after 90 days', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const socs = [40, 50, 60];
    // A full-charge range falling by about 20 km per month over 180 days.
    for (let i = 0; i < 12; i++) {
      const implied = 340 - (20 / 30.44) * (i * 15);
      store.append(VIN, 'telemetry', 'battery', degradationSample(T0 + i * 16 * DAY, socs[i % 3]!, implied, `deg-${i}`));
    }
    const result = await call(store, 'get_degradation_report', {}, T0 + 200 * DAY);
    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.match(text, /trend/);
    assert.match(text, /95% interval/);
    assert.match(text, /Confounders:/);
    assert.match(text, /km\/month/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a flat degradation series says the interval includes zero instead of claiming a decline', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const socs = [40, 50, 60];
    for (let i = 0; i < 12; i++) {
      store.append(VIN, 'telemetry', 'battery', degradationSample(T0 + i * 16 * DAY, socs[i % 3]!, 340, `flat-${i}`));
    }
    const result = await call(store, 'get_degradation_report', {}, T0 + 200 * DAY);
    const text = textOf(result);
    assert.match(text, /interval includes zero/);
    assert.doesNotMatch(text, /interval excludes zero/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a 40-day series is refused a slope and told why', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const socs = [40, 50, 60];
    for (let i = 0; i < 10; i++) {
      store.append(VIN, 'telemetry', 'battery', degradationSample(T0 + i * 4 * DAY, socs[i % 3]!, 340 - i, `short-${i}`));
    }
    const result = await call(store, 'get_degradation_report', {}, T0 + 50 * DAY);
    const text = textOf(result);
    assert.match(text, /at least 90 days/);
    assert.doesNotMatch(text, /95% interval/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
