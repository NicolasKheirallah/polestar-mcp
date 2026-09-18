import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSUMED_LINE_VOLTS, chargeModel } from '../src/charge-model.js';
import { ampLimitA, chargeLevelPct, chargeWindow, energyAvailableKwh, targetSoc } from '../src/domain-data.js';
import { aggregateToolSpecs } from '../src/aggregate-tools.js';
import { advisorToolSpecs } from '../src/advisor-tools.js';
import { toolSpec } from '../src/tools.js';
import type { PolestarClient } from '../src/client.js';
import type { ToolDeps } from '../src/tool-output.js';

/**
 * A car that reports its charging voltage. The estimator used to honour it and
 * the planner used to assume 230 V, so the same question got two answers.
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

test('the model prefers reported voltage, then live power, and states what it assumed', () => {
  const reported = chargeModel({ socPct: 40, targetPct: 80, ampLimitA: 16, reportedVolts: 400, phases: 3 });
  assert.equal(reported.powerKw, (16 * 400 * 3) / 1000);
  assert.match(String(reported.assumptions[0]), /400 V \(reported\)/);

  const assumed = chargeModel({ socPct: 40, targetPct: 80, ampLimitA: 16, phases: 3 });
  assert.equal(assumed.powerKw, (16 * ASSUMED_LINE_VOLTS * 3) / 1000);
  assert.match(String(assumed.assumptions[0]), /230 V assumed .* reports no charging voltage/);

  const live = chargeModel({ socPct: 40, targetPct: 80, ampLimitA: 16, reportedVolts: 400, livePowerW: 11_000, phases: 3 });
  assert.equal(live.powerKw, 11);
  assert.match(String(live.assumptions[0]), /live charging power/);
});

test('the estimator and the planner agree on the power figure for one car', async () => {
  const d = deps();
  const estimate = await toolSpec(aggregateToolSpecs(d), 'get_charging_estimate').run({}, {});
  const plan = await toolSpec(advisorToolSpecs(d), 'plan_cheapest_charge').run(
    { prices: [{ startsAt: '2026-01-01T22:00:00Z', price: 0.3 }] },
    {},
  );

  const estimateText = JSON.stringify(estimate.content);
  const planText = JSON.stringify(plan.content);
  const fromEstimate = kw(estimateText);
  const fromPlan = kw(planText);

  assert.ok(fromEstimate !== undefined, `no kW figure in the estimate: ${estimateText}`);
  assert.ok(fromPlan !== undefined, `no kW figure in the plan: ${planText}`);
  assert.equal(fromPlan, fromEstimate, 'two tools answered the same car with different power');
  assert.equal(fromEstimate, '19.2', '16 A × 400 V × 3 phases is 19.2 kW: the reported voltage must be used, not an assumed 230 V');
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
