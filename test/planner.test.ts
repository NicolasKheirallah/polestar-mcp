import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batteryView, exteriorView, isChargingStatus } from '../src/domain-data.js';
import { humanizeEnum, summarizeDomain, formatAge } from '../src/format.js';
import { planCheapestCharge } from '../src/planner.js';

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

const hourly = (startIso: string, prices: number[]) => {
  const start = Date.parse(startIso);
  return prices.map((price, index) => ({ startsAt: new Date(start + index * 3_600_000).toISOString(), price }));
};

const localHours = (plan: { steps: { startsAt: string }[] }): number[] =>
  plan.steps.map((step) => new Date(step.startsAt).getUTCHours());

test('planner picks the cheapest adjacent hours and the schedule delivers the energy needed', () => {
  const plan = planCheapestCharge({
    prices: hourly('2026-09-20T00:00:00Z', [0.1, 0.5, 0.4, 0.3, 0.2, 0.6, 0.7]),
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
  assert.equal(plan.steps.length, 4);
  assert.equal(plan.steps[0]!.startsAt, '2026-09-20T00:00:00.000Z');
  assert.equal(plan.steps.reduce((total, step) => total + step.energyKwh, 0), 32, 'the steps must deliver the energy needed');
  plan.steps.forEach((step, index) => {
    const start = new Date(step.startsAt);
    assert.equal(start.getUTCMinutes(), 0);
    assert.equal(start.getUTCSeconds(), 0);
    assert.equal(start.getUTCMilliseconds(), 0);
    if (index > 0) assert.equal(Date.parse(step.startsAt), Date.parse(plan.steps[index - 1]!.endsAt), 'steps are adjacent in time');
  });
  assert.equal(plan.totalCost, 11.778);
  assert.equal(plan.totalCost, Math.round(plan.steps.reduce((total, step) => total + step.cost, 0) * 1000) / 1000);
  assert.equal(plan.totalGridEnergyKwh, 35.555);
  assert.ok(plan.assumptions.some((line) => line.includes('90% AC efficiency')));
  assert.ok(plan.assumptions.some((line) => line.includes("caller's currency per kWh")));
});

test('planner handles wrap-around windows and normalizes hours above 23', () => {
  const wrap = planCheapestCharge({
    prices: hourly('2026-09-19T22:00:00Z', [0.3, 0.2, 0.1, 0.4, 0.5, 0.6, 0.7, 0.8]),
    socPct: 40,
    targetPct: 60,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 23,
    windowEndHour: 6,
    nowMs: Date.parse('2026-09-19T12:00:00Z'),
  });
  assert.equal(wrap.feasible, true);
  assert.deepEqual(localHours(wrap), [23, 0], 'a 23 to 6 window wraps midnight and stays adjacent');
  assert.equal(wrap.steps[0]!.startsAt, '2026-09-19T23:00:00.000Z');

  const lateStop = planCheapestCharge({
    prices: hourly('2026-01-01T00:00:00Z', Array.from({ length: 72 }, () => 0.2)),
    socPct: 50,
    targetPct: 80,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 22,
    windowEndHour: 28,
    nowMs: Date.parse('2026-01-01T12:00:00Z'),
  });
  assert.equal(lateStop.feasible, true);
  assert.deepEqual(localHours(lateStop).slice(0, 3), [22, 23, 0], 'a stop hour of 28 is 04:00, not a truncated window');
});

test('planner starts its first slot on a whole hour, never on the call second', () => {
  const plan = planCheapestCharge({
    prices: hourly('2026-01-01T00:00:00Z', Array.from({ length: 48 }, () => 0.2)),
    socPct: 50,
    targetPct: 60,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 0,
    windowEndHour: 24,
    nowMs: Date.parse('2026-01-01T12:00:55.678Z'),
  });
  assert.equal(plan.feasible, true);
  assert.ok(plan.steps.length > 0);
  for (const step of plan.steps) {
    const start = new Date(step.startsAt);
    assert.equal(start.getUTCMinutes(), 0);
    assert.equal(start.getUTCSeconds(), 0);
    assert.equal(start.getUTCMilliseconds(), 0);
  }
  assert.ok(Date.parse(plan.steps[0]!.startsAt) >= Date.parse('2026-01-01T13:00:00Z'), 'the partial hour is not scheduled as if it were whole');
});

test('planner reports a shortfall instead of a feasible plan that cannot deliver', () => {
  const plan = planCheapestCharge({
    prices: hourly('2026-01-01T00:00:00Z', Array.from({ length: 48 }, () => 0.2)),
    socPct: 30,
    targetPct: 100,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 0,
    windowEndHour: 1,
    nowMs: Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(plan.feasible, false, 'a plan that cannot reach the target is not feasible');
  assert.match(String(plan.reason), /Shortfall 36 kWh/);
  assert.match(String(plan.reason), /delivering at most 20 kWh/);
  assert.equal(plan.steps.length, 0);
});

test('planner labels a cross-night fallback non-contiguous instead of calling the run contiguous', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const prices = Array.from({ length: 96 }, (_, index) => ({
    startsAt: new Date(start + index * 3_600_000).toISOString(),
    price: 0.3,
  }));
  const patch = (dayIso: string, hour: number, price: number): void => {
    const at = Date.parse(dayIso) + hour * 3_600_000;
    const entry = prices.find((slot) => Date.parse(slot.startsAt) === at);
    if (entry !== undefined) entry.price = price;
  };
  for (const hour of [22, 23]) patch('2026-01-01T00:00:00Z', hour, 0.05);
  for (const hour of [0, 1]) patch('2026-01-02T00:00:00Z', hour, 0.05);
  for (const hour of [22, 23]) patch('2026-01-02T00:00:00Z', hour, 0.1);

  const plan = planCheapestCharge({
    prices,
    socPct: 0,
    targetPct: 75,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 22,
    windowEndHour: 2,
    nowMs: start,
  });
  assert.equal(plan.feasible, true);
  assert.match(String(plan.reason), /not contiguous/);
  assert.ok(plan.assumptions.some((line) => line.includes('not contiguous')));
  const gaps = plan.steps.slice(1).map((step, index) => Date.parse(step.startsAt) - Date.parse(plan.steps[index]!.endsAt));
  assert.ok(Math.max(...gaps) > 3_600_000, `expected a real time gap inside the plan, got ${gaps.join(', ')}`);
  assert.equal(Math.min(...plan.steps.map((step) => step.price)), 0.05);
});

test('planner refuses a plan whose scheduled hours have no supplied price', () => {
  // 24 prices, none of them inside either charge window in the next 48h.
  const prices = [
    ...hourly('2026-01-01T08:00:00Z', Array.from({ length: 12 }, () => 0.2)),
    ...hourly('2026-01-02T08:00:00Z', Array.from({ length: 12 }, () => 0.2)),
  ];
  const plan = planCheapestCharge({
    prices,
    socPct: 50,
    targetPct: 60,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 0,
    windowEndHour: 6,
    nowMs: Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(plan.feasible, false, '24 out-of-window prices must not produce a priced-looking plan');
  assert.match(String(plan.reason), /Price data does not cover the scheduled hours/);
  assert.equal(plan.steps.length, 0);

  const empty = planCheapestCharge({
    prices: [],
    socPct: 50,
    targetPct: 60,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 0,
    windowEndHour: 6,
    nowMs: Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(empty.feasible, false);
  assert.equal(empty.steps.length, 0);
});

test('planner keeps negative and zero totals and prices only the scheduled steps', () => {
  const negative = planCheapestCharge({
    prices: hourly('2026-01-01T00:00:00Z', [-0.1, -0.1, -0.1, -0.1, -0.1, -0.1]),
    socPct: 50,
    targetPct: 80,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 0,
    windowEndHour: 6,
    nowMs: Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(negative.feasible, true);
  assert.ok(negative.totalCost !== undefined && negative.totalCost < 0, `negative prices must keep a negative cost, got ${negative.totalCost}`);
  assert.equal(negative.totalCost, Math.round(negative.steps.reduce((total, step) => total + step.cost, 0) * 1000) / 1000);

  const zero = planCheapestCharge({
    prices: hourly('2026-01-01T00:00:00Z', [0, 0, 0, 0, 0, 0]),
    socPct: 50,
    targetPct: 80,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 0,
    windowEndHour: 6,
    nowMs: Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(zero.feasible, true);
  assert.equal(zero.totalCost, 0, 'a zero price is a real cost, not a missing one');
});

test('planner splits the last hour at the schedule instead of spreading energy evenly', () => {
  const plan = planCheapestCharge({
    prices: hourly('2026-01-01T00:00:00Z', [0.2, 0.1, 0.3, 0.4, 0.5, 0.6]),
    socPct: 0,
    targetPct: 20.7,
    capacityKwh: 100,
    powerKw: 13.8,
    windowStartHour: 0,
    windowEndHour: 6,
    nowMs: Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(plan.feasible, true);
  assert.deepEqual(plan.steps.map((step) => step.energyKwh), [13.8, 6.9], 'a full hour then the remaining half hour');
  assert.equal(plan.totalCost, 3.834);
  assert.equal(plan.totalCost, Math.round(plan.steps.reduce((total, step) => total + step.cost, 0) * 1000) / 1000);
});

test('planner returns an empty feasible plan when the target is already reached', () => {
  const plan = planCheapestCharge({
    prices: hourly('2026-01-01T00:00:00Z', [0.2]),
    socPct: 80,
    targetPct: 80,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 0,
    windowEndHour: 6,
    nowMs: Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal(plan.feasible, true);
  assert.equal(plan.steps.length, 0);
  assert.match(String(plan.reason), /already reached/);
});

test('planner refuses inputs it cannot trust', () => {
  const base = {
    prices: hourly('2026-01-01T00:00:00Z', [0.2]),
    socPct: 50,
    targetPct: 80,
    capacityKwh: 80,
    powerKw: 10,
    windowStartHour: 0,
    windowEndHour: 6,
    nowMs: Date.parse('2026-01-01T00:00:00Z'),
  };
  assert.match(String(planCheapestCharge({ ...base, capacityKwh: 0 }).reason), /Pack capacity/);
  assert.match(String(planCheapestCharge({ ...base, powerKw: 0 }).reason), /Charging power/);
  assert.match(String(planCheapestCharge({ ...base, socPct: 120 }).reason), /outside 0 to 100/);
  assert.match(String(planCheapestCharge({ ...base, targetPct: -1 }).reason), /outside 0 to 100/);
  assert.match(String(planCheapestCharge({ ...base, efficiency: 1.5 }).reason), /efficiency/);
});

test('a charging status is only active when it ends in _CHARGING', () => {
  // The enum namespace contains the word, so a substring test would call every
  // parked car charging. extractChargingSessions reads this rule through the
  // payload reader now rather than re-deriving it in its own loop.
  assert.equal(isChargingStatus('CHARGING_STATUS_V2_CHARGING'), true);
  assert.equal(isChargingStatus('CHARGING_STATUS_CHARGING'), true);
  assert.equal(isChargingStatus('CHARGING_STATUS_V2_IDLE'), false);
  assert.equal(isChargingStatus(undefined), false);
});

test('the exterior questions are stated once, and a charge flap is not a lock failure', () => {
  // The openness rule used to be written three times: a named list in the
  // humanizer, a bare count in get_car_status, and a count carrying a silent
  // `key !== 'tankLid'` exclusion in is_car_secure. The two tools ask genuinely
  // different questions, so both answers are fields of one view instead of two
  // filters written independently.
  const flapOpen = {
    centralLock: 'LOCK_STATUS_LOCKED',
    tailgateLock: 'LOCK_STATUS_LOCKED',
    tankLid: 'OPEN_STATUS_OPEN',
    frontLeftDoor: 'OPEN_STATUS_CLOSED',
    alarm: 'ALARM_STATUS_OK',
  };
  const seen = exteriorView(flapOpen);
  assert.deepEqual(seen.open, ['tank lid'], 'the charge flap is an open item, named the way a summary prints it');
  assert.deepEqual(seen.openSecurityRelevant, [], 'it is not a lock failure');
  assert.equal(seen.locked, true);

  const doorOpen = { ...flapOpen, frontLeftDoor: 'OPEN_STATUS_OPEN' };
  assert.deepEqual(exteriorView(doorOpen).open, ['tank lid', 'front left door']);
  assert.deepEqual(exteriorView(doorOpen).openSecurityRelevant, ['front left door'], 'a door is both');

  assert.equal(
    exteriorView({ ...flapOpen, tailgateLock: 'LOCK_STATUS_UNLOCKED' }).locked,
    false,
    'both locks have to be engaged for the car to count as locked',
  );
});

test('the battery view reads a field the single-field readers do not cover', () => {
  // The view exists so a consumer stops indexing the payload. It has to keep
  // answering for a payload that reports nothing, which is the common case for
  // the optional fields.
  const empty = batteryView(null);
  assert.equal(empty.chargeLevelPct, undefined);
  assert.equal(empty.powerWatts, undefined, 'unreported is undefined, never zero');

  const seen = batteryView({
    batteryChargeLevelPercentage: 61,
    chargingStatus: 'CHARGING_STATUS_IDLE',
    chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING',
    chargingCurrentAmps: 16,
    chargingVoltageVolts: 232,
    averageEnergyConsumptionKwhPer100Km: 17.4,
  });
  assert.equal(seen.chargeLevelPct, 61);
  assert.equal(seen.status, 'CHARGING_STATUS_V2_CHARGING', 'V2 supersedes V1 when a car reports both');
  assert.equal(seen.amps, 16);
  assert.equal(seen.volts, 232);
  assert.equal(seen.consumptionKwhPer100Km, 17.4);
  assert.equal(seen.distanceToEmptyKm, undefined);
});
