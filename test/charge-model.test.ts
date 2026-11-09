import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSUMED_LINE_VOLTS, CAPACITY_MAX_KWH, DEFAULT_AC_EFFICIENCY, chargeModel } from '../src/charge-model.js';
import { ampLimitA, chargeLevelPct, chargeWindow, energyAvailableKwh, targetSoc } from '../src/domain-data.js';
import { aggregateToolSpecs } from '../src/aggregate-tools.js';
import { advisorToolSpecs } from '../src/advisor-tools.js';
import { toolSpec } from '../src/tools.js';
import type { PolestarClient } from '../src/client.js';
import type { ToolDeps } from '../src/tool-output.js';

/**
 * A car that reports its charging voltage. The estimator used to honour it and
 * the planner used to assume 230 V, so the same question got two answers, and
 * the reported 400 V was multiplied by the phase count as if it were a
 * per-phase voltage.
 */
const PAYLOADS: Record<string, Record<string, unknown> | null> = {
  'telemetry/battery': {
    batteryChargeLevelPercentage: 40,
    estimatedDistanceToEmptyKm: 150,
    chargingVoltageVolts: 400,
    dischargeInfo: { energyAvailable: 31.2 },
    metaReceivedAt: '2026-01-01T00:00:00.000Z',
  },
  'charging/target-soc': { targetSoc: { batteryChargeTargetLevel: 80, chargeTargetLevelSettingType: 'CUSTOM' } },
  'charging/amp-limit': { ampLimit: { ampLimit: 16 } },
  'charging/global-charge-timer': {
    globalChargeTimer: { activated: true, start: { hour: 22, timeZone: { offsetMinutes: 60 } }, stop: { hour: 28 } },
  },
};

function fakeClient(): PolestarClient {
  return {
    async resolveVin(vin?: string) { return vin ?? 'YSMTEST22PL000001'; },
    async vehicles() { return ['YSMTEST22PL000001']; },
    async domain(_vin: string, kind: string, name: string) {
      return PAYLOADS[`${kind}/${name}`] ?? null;
    },
    forDelegation() { return this; },
  } as unknown as PolestarClient;
}

function deps(): ToolDeps {
  return {
    client: fakeClient(),
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
    nowMs: () => Date.parse('2026-01-01T02:00:00Z'),
  };
}

const kw = (text: string): string | undefined => /([0-9]+(?:\.[0-9]+)?) kW(?!h)/.exec(text)?.[1];

test('three-phase power treats a reported voltage as line-to-line: 16 A at 400 V is 11.1 kW', () => {
  const reported = chargeModel({ socPct: 40, targetPct: 80, ampLimitA: 16, reportedVolts: 400, phases: 3 });
  assert.ok(reported.powerKw !== undefined);
  assert.ok(Math.abs(reported.powerKw - 11.085) < 0.01, `expected 11.1 kW, got ${reported.powerKw}`);
  assert.match(String(reported.assumptions[0]), /line-to-line/);

  const assumed = chargeModel({ socPct: 40, targetPct: 80, ampLimitA: 16, phases: 3 });
  assert.equal(assumed.powerKw, (16 * ASSUMED_LINE_VOLTS * 3) / 1000, 'the 230 V fallback is a per-phase voltage');
  assert.match(String(assumed.assumptions[0]), /230 V assumed per phase/);

  const live = chargeModel({ socPct: 40, targetPct: 80, ampLimitA: 16, reportedVolts: 400, livePowerW: 11_000, phases: 3 });
  assert.equal(live.powerKw, 11);
  assert.match(String(live.assumptions[0]), /live charging power/);
});

test('capacity falls back from reported energy to range and consumption, then caller capacity', () => {
  const fromEnergy = chargeModel({ socPct: 40, targetPct: 80, energyAvailableKwh: 31.2, phases: 3 });
  assert.equal(fromEnergy.capacityKwh, 78);
  assert.equal(fromEnergy.capacitySource, 'dischargeInfo.energyAvailable');

  const fromRange = chargeModel({ socPct: 52, targetPct: 80, distanceToEmptyKm: 170, consumptionKwhPer100Km: 20.1, phases: 3 });
  assert.ok(fromRange.capacityKwh !== undefined && Math.abs(fromRange.capacityKwh - 65.7115) < 0.001, `range-derived capacity ${fromRange.capacityKwh}`);
  assert.equal(fromRange.capacitySource, 'estimatedDistanceToEmptyKm and averageEnergyConsumptionKwhPer100Km');

  const supplied = chargeModel({ socPct: 52, targetPct: 80, suppliedCapacityKwh: 78, phases: 3 });
  assert.equal(supplied.capacityKwh, 78);
  assert.equal(supplied.capacitySource, 'caller-supplied capacity');

  // The car's own report wins over the caller's number: the chain has an order.
  const both = chargeModel({ socPct: 40, targetPct: 80, energyAvailableKwh: 31.2, suppliedCapacityKwh: 60, phases: 3 });
  assert.equal(both.capacityKwh, 78);
  assert.equal(both.capacitySource, 'dischargeInfo.energyAvailable');

  const none = chargeModel({ socPct: 52, targetPct: 80, phases: 3 });
  assert.equal(none.capacityKwh, undefined);
  assert.ok(none.missing.some((entry) => entry.includes('usable pack capacity')));
});

test('grid energy is battery energy divided by the stated AC efficiency', () => {
  const model = chargeModel({ socPct: 52, targetPct: 80, distanceToEmptyKm: 170, consumptionKwhPer100Km: 20.1, phases: 3 });
  assert.ok(model.energyNeededKwh !== undefined);
  assert.ok(model.gridEnergyKwh !== undefined);
  assert.ok(Math.abs(model.energyNeededKwh - 18.399) < 0.001, `battery energy ${model.energyNeededKwh}`);
  assert.ok(Math.abs(model.gridEnergyKwh - model.energyNeededKwh / DEFAULT_AC_EFFICIENCY) < 0.001, `grid energy ${model.gridEnergyKwh}`);
  assert.ok(model.assumptions.some((line) => line.includes('90% AC efficiency')));

  const custom = chargeModel({
    socPct: 52,
    targetPct: 80,
    distanceToEmptyKm: 170,
    consumptionKwhPer100Km: 20.1,
    phases: 3,
    efficiency: 0.8,
  });
  assert.equal(custom.efficiency, 0.8);
  assert.ok(
    custom.energyNeededKwh !== undefined
    && custom.gridEnergyKwh !== undefined
    && Math.abs(custom.gridEnergyKwh - custom.energyNeededKwh / 0.8) < 0.001,
  );
});

test('nonsense inputs are named as problems and no number is presented from them', () => {
  const problems = (input: Parameters<typeof chargeModel>[0]): string[] => chargeModel(input).problems;

  assert.ok(problems({ socPct: 120, phases: 3 }).some((entry) => /state of charge/.test(entry)));
  assert.ok(problems({ targetPct: 110, phases: 3 }).some((entry) => /target charge level/.test(entry)));
  assert.ok(problems({ socPct: 50, targetPct: 80, ampLimitA: 0, phases: 3 }).some((entry) => /amp limit/.test(entry)));
  assert.ok(problems({ socPct: 50, targetPct: 80, phases: 0 }).some((entry) => /phase count/.test(entry)));
  assert.ok(problems({ socPct: 50, targetPct: 80, phases: 3, efficiency: 1.2 }).some((entry) => /AC efficiency/.test(entry)));

  const implausible = chargeModel({ socPct: 6, targetPct: 80, energyAvailableKwh: 200, phases: 3 });
  assert.equal(implausible.capacityKwh, undefined, 'a 3333 kWh implied pack is refused, not returned');
  assert.ok(implausible.problems.some((entry) => /plausibility range/.test(entry)));

  const oversized = chargeModel({ socPct: 50, targetPct: 80, suppliedCapacityKwh: CAPACITY_MAX_KWH + 1, phases: 3 });
  assert.equal(oversized.capacityKwh, undefined);
  assert.ok(oversized.problems.some((entry) => /plausibility range/.test(entry)));

  const belowTarget = chargeModel({ socPct: 80, targetPct: 50, suppliedCapacityKwh: 78, phases: 3 });
  assert.equal(belowTarget.energyNeededKwh, 0);
  assert.equal(belowTarget.problems.length, 0, 'a target below the current SoC is not an invalid input');
});

test('the estimator and the planner agree on the power figure for one car', async () => {
  const d = deps();
  const prices = Array.from({ length: 10 }, (_, index) => ({
    startsAt: new Date(Date.parse('2026-01-01T21:00:00Z') + index * 3_600_000).toISOString(),
    price: 0.3,
  }));
  const estimate = await toolSpec(aggregateToolSpecs(d), 'get_charging_estimate').run({}, {});
  const plan = await toolSpec(advisorToolSpecs(d), 'plan_cheapest_charge').run({ prices }, {});

  const estimateText = JSON.stringify(estimate.content);
  const planText = JSON.stringify(plan.content);
  const fromEstimate = kw(estimateText);
  const fromPlan = kw(planText);

  assert.ok(fromEstimate !== undefined, `no kW figure in the estimate: ${estimateText}`);
  assert.ok(fromPlan !== undefined, `no kW figure in the plan: ${planText}`);
  assert.equal(fromPlan, fromEstimate, 'two tools answered the same car with different power');
  assert.equal(fromEstimate, '11.1', '16 A at 400 V line-to-line on 3 phases is 11.1 kW, not 19.2');
});

test('projections answer undefined for what a car does not report, never zero', () => {
  assert.equal(chargeLevelPct({}), undefined);
  assert.equal(energyAvailableKwh({ dischargeInfo: {} }), undefined);
  assert.equal(ampLimitA({}), undefined);
  assert.deepEqual(targetSoc({ targetSoc: {} }), {});
  const window = chargeWindow({
    globalChargeTimer: { activated: false, start: { hour: 22, timeZone: { offsetMinutes: 60 } }, stop: { hour: 28 } },
  });
  assert.deepEqual(window, { activated: false, startHour: 22, stopHour: 28, offsetMinutes: 60 });
  assert.equal(chargeWindow({}), undefined);
});
