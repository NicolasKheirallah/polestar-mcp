import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PolestarClient } from '../src/client.js';
import { formatAge, observedAtMs } from '../src/format.js';
import { aggregateToolSpecs } from '../src/aggregate-tools.js';
import { advisorToolSpecs } from '../src/advisor-tools.js';
import { toolSpec } from '../src/tools.js';
import type { ToolDeps } from '../src/tool-output.js';

const VIN = 'YSMTEST22PL000001';
// Tuesday 15 September 2026, 10:00 in UTC+02:00.
const NOW = Date.parse('2026-09-15T08:00:00Z');

const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const BATTERY = {
  batteryChargeLevelPercentage: 52,
  estimatedDistanceToEmptyKm: 170,
  averageEnergyConsumptionKwhPer100Km: 20.1,
  metaReceivedAt: minutesAgo(5),
};
const TARGET = { targetSoc: { batteryChargeTargetLevel: 80, chargeTargetLevelSettingType: 'CUSTOM' }, metaReceivedAt: minutesAgo(2) };
const AMP = { ampLimit: { ampLimit: 20 }, metaReceivedAt: minutesAgo(2) };

const TIMER = {
  globalChargeTimer: {
    activated: true,
    start: { hour: 23, timeZone: { offsetMinutes: 120 } },
    stop: { hour: 6 },
  },
  metaReceivedAt: minutesAgo(60),
};

function climateTimer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parkingClimateTimers: [
      {
        activated: true,
        readyAt: { hour: 14, timeZone: { offsetMinutes: 120 } },
        repeat: true,
        weekdays: ['SUNDAY'],
        ...overrides,
      },
    ],
    metaReceivedAt: minutesAgo(90),
  };
}

const DEPARTURE = '2026-09-20T14:00:00+02:00';

type Payloads = Record<string, Record<string, unknown> | null>;

function fakeClient(payloads: Payloads): PolestarClient {
  return {
    async resolveVin(vin?: string) {
      return vin ?? VIN;
    },
    async vehicles() {
      return [VIN];
    },
    async domain(_vin: string, kind: string, name: string) {
      return payloads[`${kind}/${name}`] ?? null;
    },
    forDelegation() {
      return this;
    },
  } as unknown as PolestarClient;
}

function depsFor(payloads: Payloads, nowMs = NOW): ToolDeps {
  return {
    client: fakeClient(payloads),
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
    nowMs: () => nowMs,
  };
}

/** A captured domain payload from the shipped synthetic dump. */
function fixture(kind: 'telemetry' | 'charging', name: string): Record<string, unknown> {
  const file = fileURLToPath(new URL(`./fixtures/dump/dataportal/${kind}/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')).data as Record<string, unknown>;
}

const CHARGING_FIXTURES: Payloads = {
  'charging/amp-limit': fixture('charging', 'amp-limit'),
  'charging/target-soc': fixture('charging', 'target-soc'),
  'charging/global-charge-timer': fixture('charging', 'global-charge-timer'),
  'charging/parking-climate-timer': fixture('charging', 'parking-climate-timer'),
  'charging/charge-locations': fixture('charging', 'charge-locations'),
  'charging/charge-now': fixture('charging', 'charge-now'),
  'charging/is-at-charge-location': null,
};

async function run(specs: ReturnType<typeof aggregateToolSpecs>, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: Record<string, unknown> }> {
  const result = await toolSpec(specs, name).run(args, {});
  return {
    text: result.content.map((part) => part.text).join('\n'),
    data: (result.structuredContent?.data ?? {}) as Record<string, unknown>,
  };
}

const SETTINGS: Payloads = {
  'charging/amp-limit': {
    ampLimit: { ampLimit: 20 },
    pendingAmpLimit: { ampLimit: 16 },
    metaReceivedAt: minutesAgo(3),
  },
  'charging/target-soc': TARGET,
  'charging/global-charge-timer': TIMER,
  'charging/parking-climate-timer': climateTimer(),
  'charging/charge-locations': { id: 'loc', utc0: true, metaReceivedAt: minutesAgo(1) },
  'charging/charge-now': { syncedOverrideChargeTimer: { updatedAt: '2026-09-15T07:00:00Z' }, metaReceivedAt: minutesAgo(4) },
  'charging/is-at-charge-location': null,
};

test('charging setup covers the seven settings, prints each age, and marks at-charge-location unsupported', async () => {
  const { text, data } = await run(aggregateToolSpecs(depsFor(SETTINGS)), 'get_charging_setup');
  for (const name of ['amp-limit', 'target-soc', 'global-charge-timer', 'parking-climate-timer', 'charge-locations', 'charge-now', 'is-at-charge-location']) {
    assert.ok(text.includes(name), `${name} must be named: ${text}`);
  }
  assert.match(text, /amp-limit \(3 min ago\): AC charge current limit: 20 A/);
  assert.match(text, /parking-climate-timer \(2 h ago\):/);
  assert.match(text, /is-at-charge-location: unsupported on this vehicle/);
  assert.match(text, /this is not a failure/);
  assert.match(text, /Oldest setting: parking-climate-timer \(2 h ago\)/);

  const settings = data.settings as Record<string, Record<string, unknown>>;
  assert.equal(settings['amp-limit']?.ampLimitA, 20);
  assert.equal(settings['amp-limit']?.pendingAmpLimitA, 16);
  assert.equal(settings['amp-limit']?.ageSeconds, 180);
  assert.equal(settings['target-soc']?.targetPct, 80);
  assert.deepEqual(settings['global-charge-timer']?.window, { activated: true, startHour: 23, stopHour: 6, offsetMinutes: 120 });
  assert.equal((settings['parking-climate-timer']?.timers as unknown[]).length, 1);
  assert.deepEqual(data.unsupported, ['is-at-charge-location']);
  assert.deepEqual(data.unreported, []);
});

test('charging setup names an unreported setting instead of omitting it', async () => {
  const { text, data } = await run(
    aggregateToolSpecs(depsFor({ ...SETTINGS, 'charging/target-soc': null })),
    'get_charging_setup',
  );
  assert.match(text, /target-soc: not reported \(the API returned DATA_NOT_AVAILABLE\)/);
  assert.match(text, /Not reported: target-soc/);
  assert.deepEqual(data.unreported, ['target-soc']);
  assert.deepEqual((data.settings as Record<string, Record<string, unknown>>)['target-soc'], { reported: false });
});

test('the parking climate timer reader tolerates the non-array shape that once threw', async () => {
  const { climateTimerEntries } = await import('../src/aggregate-tools.js');
  assert.deepEqual(climateTimerEntries({ parkingClimateTimers: {} }), []);
  assert.deepEqual(climateTimerEntries(null), []);
  const parsed = climateTimerEntries(climateTimer());
  assert.deepEqual(parsed[0], { hour: 14, offsetMinutes: 120, activated: true, repeat: true, weekdays: ['SUNDAY'] });
});

test('departure readiness answers yes with the charge deadline and preconditioning schedule', async () => {
  const payloads: Payloads = {
    'telemetry/battery': BATTERY,
    'charging/target-soc': TARGET,
    'charging/amp-limit': AMP,
    'charging/global-charge-timer': TIMER,
    'charging/parking-climate-timer': climateTimer(),
  };
  const { text, data } = await run(advisorToolSpecs(depsFor(payloads)), 'get_departure_readiness', { departureAt: DEPARTURE });
  assert.match(text, /• Departure: 2026-09-20T12:00:00\.000Z \(SUNDAY 14:00 UTC\+02:00\); source: the departureAt argument\./);
  assert.match(text, /• Latest charge deadline: SUNDAY 06:00 UTC\+02:00/);
  assert.match(text, /• Energy needed: 18\.4 kWh at the battery to reach 80% \(now 52%\)\./);
  assert.match(text, /• Charging time needed: 1h 20m at 13\.8 kW\./);
  assert.match(text, /• Verdict: Yes: the car can be charged to 80% by SUNDAY 14:00 UTC\+02:00 and is scheduled to precondition\./);
  assert.match(text, /Read-only advice: This server is read-only/);
  assert.equal(data.ready, true);
  assert.equal(data.verdict, 'yes');
  assert.equal(data.deadlineAt, '2026-09-20T04:00:00.000Z');
  assert.equal(data.chargeReadiness, 'yes');
  assert.equal((data.preconditioning as Record<string, unknown>).status, 'scheduled');
});

test('departure readiness derives the next departure from a repeating climate timer', async () => {
  const payloads: Payloads = {
    'telemetry/battery': BATTERY,
    'charging/target-soc': TARGET,
    'charging/amp-limit': AMP,
    'charging/global-charge-timer': TIMER,
    'charging/parking-climate-timer': climateTimer(),
  };
  const { text, data } = await run(advisorToolSpecs(depsFor(payloads)), 'get_departure_readiness');
  assert.match(text, /source: the next repeating parking climate timer/);
  assert.equal(data.departureAt, '2026-09-20T12:00:00.000Z');
  assert.equal(data.verdict, 'yes');
});

test('departure readiness refuses to guess a one-shot timer without a date', async () => {
  const payloads: Payloads = {
    'telemetry/battery': BATTERY,
    'charging/target-soc': TARGET,
    'charging/amp-limit': AMP,
    'charging/global-charge-timer': TIMER,
    'charging/parking-climate-timer': climateTimer({ repeat: false }),
  };
  const { text, data } = await run(advisorToolSpecs(depsFor(payloads)), 'get_departure_readiness');
  assert.match(text, /^Refused:/);
  assert.match(text, /one-shot timer with no date/);
  assert.equal(data.refused, true);
});

test('a one-shot timer cannot confirm preconditioning even when a departure is supplied', async () => {
  const payloads: Payloads = {
    'telemetry/battery': BATTERY,
    'charging/target-soc': TARGET,
    'charging/amp-limit': AMP,
    'charging/global-charge-timer': TIMER,
    'charging/parking-climate-timer': climateTimer({ repeat: false }),
  };
  const { text, data } = await run(advisorToolSpecs(depsFor(payloads)), 'get_departure_readiness', { departureAt: DEPARTURE });
  assert.match(text, /• Verdict: Unknown:/);
  assert.match(text, /one-shot parking climate timer .* carries no date/);
  assert.equal(data.ready, null);
  assert.equal((data.preconditioning as Record<string, unknown>).status, 'one-shot-unconfirmed');
});

test('inactive timers produce the explicit "will not ... on its own" answer', async () => {
  const payloads: Payloads = {
    'telemetry/battery': BATTERY,
    'charging/target-soc': TARGET,
    'charging/amp-limit': AMP,
    'charging/global-charge-timer': { ...TIMER, globalChargeTimer: { ...(TIMER.globalChargeTimer as object), activated: false } },
    'charging/parking-climate-timer': climateTimer({ activated: false }),
  };
  const { text, data } = await run(advisorToolSpecs(depsFor(payloads)), 'get_departure_readiness', { departureAt: DEPARTURE });
  assert.match(text, /• Verdict: No:/);
  assert.match(text, /charge window is defined but INACTIVE on the car, so the car will not charge on its own/);
  assert.match(text, /parking climate timer is defined but INACTIVE on the car, so the car will not precondition on its own/);
  assert.equal(data.ready, false);
});

test('departure readiness says No when the window cannot deliver the energy in time', async () => {
  const payloads: Payloads = {
    'telemetry/battery': { ...BATTERY, batteryChargeLevelPercentage: 0 },
    'charging/target-soc': { targetSoc: { batteryChargeTargetLevel: 100 } },
    'charging/amp-limit': { ampLimit: { ampLimit: 16 } },
    'charging/global-charge-timer': TIMER,
    'charging/parking-climate-timer': climateTimer(),
  };
  const { text, data } = await run(advisorToolSpecs(depsFor(payloads)), 'get_departure_readiness', {
    departureAt: '2026-09-17T14:00:00+02:00',
    capacityKwh: 300,
  });
  assert.match(text, /• Verdict: No:/);
  assert.match(text, /14 complete hour\(s\)/);
  assert.equal(data.chargeReadiness, 'short-window');
  assert.equal(data.ready, false);
});

test('an unreported parking climate timer makes the preconditioning half unknown, not a no', async () => {
  const payloads: Payloads = {
    'telemetry/battery': BATTERY,
    'charging/target-soc': TARGET,
    'charging/amp-limit': AMP,
    'charging/global-charge-timer': TIMER,
    'charging/parking-climate-timer': null,
  };
  const { text, data } = await run(advisorToolSpecs(depsFor(payloads)), 'get_departure_readiness', { departureAt: DEPARTURE });
  assert.match(text, /• Verdict: Unknown:/);
  assert.match(text, /parking climate timer is not reported, so preconditioning is unknown/);
  assert.equal(data.ready, null);
});

test('departure readiness refuses ambiguous or past timestamps and a missing target', async () => {
  const payloads: Payloads = {
    'telemetry/battery': BATTERY,
    'charging/target-soc': TARGET,
    'charging/amp-limit': AMP,
    'charging/global-charge-timer': TIMER,
    'charging/parking-climate-timer': climateTimer(),
  };
  const noZone = await run(advisorToolSpecs(depsFor(payloads)), 'get_departure_readiness', { departureAt: '2026-09-20T14:00:00' });
  assert.match(noZone.text, /^Refused: departureAt must be an ISO 8601 timestamp with a UTC offset or Z/);

  const past = await run(advisorToolSpecs(depsFor(payloads)), 'get_departure_readiness', { departureAt: '2026-09-14T14:00:00+02:00' });
  assert.match(past.text, /^Refused: the requested departure .* is not in the future/);

  const noTarget = await run(
    advisorToolSpecs(depsFor({ ...payloads, 'charging/target-soc': null })),
    'get_departure_readiness',
    { departureAt: DEPARTURE },
  );
  assert.match(noTarget.text, /^Refused: the car does not report a target charge level/);
});

test('the charge plan carries its steps and cost in structured data', async () => {
  const payloads: Payloads = {
    'telemetry/battery': BATTERY,
    'charging/target-soc': TARGET,
    'charging/amp-limit': AMP,
    'charging/global-charge-timer': TIMER,
  };
  const prices = Array.from({ length: 12 }, (_, index) => ({
    startsAt: new Date(Date.parse('2026-09-15T20:00:00Z') + index * 3_600_000).toISOString(),
    price: 0.3,
  }));
  const { data } = await run(advisorToolSpecs(depsFor(payloads)), 'plan_cheapest_charge', { prices });
  assert.equal(data.feasible, true);
  assert.ok(Array.isArray(data.steps) && data.steps.length > 0, 'steps are structured data, not only prose');
  assert.ok(typeof data.totalCost === 'number');
  assert.equal(typeof data.priceUnit, 'string');
  assert.equal(data.energyNeededKwh, 18.399);
});

test('charging setup answers from the shipped charging fixtures', async () => {
  const nowMs = Date.parse('2026-09-18T12:00:00Z');
  const { text, data } = await run(aggregateToolSpecs(depsFor(CHARGING_FIXTURES, nowMs)), 'get_charging_setup');

  for (const name of ['amp-limit', 'target-soc', 'global-charge-timer', 'parking-climate-timer', 'charge-locations', 'charge-now', 'is-at-charge-location']) {
    assert.ok(text.includes(name), `${name} must be named from the fixture payloads: ${text}`);
  }
  const ageOf = (kind: 'telemetry' | 'charging', name: string): string => {
    const payload = fixture(kind, name);
    return formatAge(observedAtMs(payload)!, nowMs);
  };
  assert.ok(text.includes(`amp-limit (${ageOf('charging', 'amp-limit')})`), 'settings carry their own value clocks');
  assert.ok(text.includes(`parking-climate-timer (${ageOf('charging', 'parking-climate-timer')})`));
  assert.match(text, /is-at-charge-location: unsupported on this vehicle/);

  const settings = data.settings as Record<string, Record<string, unknown>>;
  assert.equal(settings['amp-limit']?.ampLimitA, 20);
  assert.equal(settings['amp-limit']?.pendingAmpLimitA, 20);
  assert.equal(settings['target-soc']?.targetPct, 80);
  assert.deepEqual(settings['global-charge-timer']?.window, { activated: false, startHour: 23, stopHour: 6, offsetMinutes: 120 });
  assert.deepEqual(settings['parking-climate-timer']?.timers, [
    { hour: 14, offsetMinutes: 120, activated: false, repeat: false, weekdays: ['SUNDAY'] },
  ]);
  assert.deepEqual(data.unsupported, ['is-at-charge-location']);
});

test('departure readiness on the shipped fixtures reports the inactive timers and the deadline', async () => {
  const nowMs = Date.parse('2026-09-18T12:00:00Z');
  const payloads: Payloads = {
    'telemetry/battery': fixture('telemetry', 'battery'),
    'charging/target-soc': fixture('charging', 'target-soc'),
    'charging/amp-limit': fixture('charging', 'amp-limit'),
    'charging/global-charge-timer': fixture('charging', 'global-charge-timer'),
    'charging/parking-climate-timer': fixture('charging', 'parking-climate-timer'),
  };
  const { text, data } = await run(
    advisorToolSpecs(depsFor(payloads, nowMs)),
    'get_departure_readiness',
    { departureAt: '2026-09-20T14:00:00+02:00' },
  );
  assert.match(text, /• Verdict: No:/);
  assert.match(text, /charge window is defined but INACTIVE on the car, so the car will not charge on its own/);
  assert.match(text, /parking climate timer is defined but INACTIVE on the car, so the car will not precondition on its own/);
  assert.equal(data.deadlineAt, '2026-09-20T04:00:00.000Z');
  assert.equal(data.energyNeededKwh, 18.399);
  assert.equal(data.chargeReadiness, 'window-inactive');
  assert.equal(data.ready, false);
});
