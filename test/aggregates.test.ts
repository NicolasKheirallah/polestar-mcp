import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolestarApiError, type PolestarClient } from '../src/client.js';
import { formatAge, summarizeDomain, valueObservedAtMs } from '../src/format.js';
import { position } from '../src/domain-data.js';
import { aggregateToolSpecs } from '../src/aggregate-tools.js';
import { toolSpec } from '../src/tools.js';
import { readDomainFormatted, resolveVinOrAsk } from '../src/vehicle-read.js';
import type { ToolDeps, ToolResult } from '../src/tool-output.js';

const VIN = 'YSMTEST22PL000001';
const NOW = Date.parse('2026-09-18T12:00:00.000Z');

const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const BATTERY = {
  batteryChargeLevelPercentage: 52,
  estimatedDistanceToEmptyKm: 170,
  averageEnergyConsumptionKwhPer100Km: 20.1,
  chargingStatusV2: 'CHARGING_STATUS_V2_IDLE',
  chargerConnectionStatus: 'CHARGER_CONNECTION_STATUS_DISCONNECTED',
  estimatedChargingTimeToFullMinutes: 0,
  metaReceivedAt: minutesAgo(5),
};
const TARGET = { targetSoc: { batteryChargeTargetLevel: 80, chargeTargetLevelSettingType: 'CUSTOM' }, metaReceivedAt: minutesAgo(2) };
const AMP = { ampLimit: { ampLimit: 20 }, metaReceivedAt: minutesAgo(2) };
const EXTERIOR_SECURE = {
  centralLock: 'LOCK_STATUS_LOCKED',
  tailgateLock: 'LOCK_STATUS_LOCKED',
  frontLeftDoor: 'OPEN_STATUS_CLOSED',
  frontLeftWindow: 'OPEN_STATUS_CLOSED',
  rearLeftDoor: 'OPEN_STATUS_CLOSED',
  alarm: 'ALARM_STATUS_OK',
  metaReceivedAt: minutesAgo(1),
};
const HEALTH = {
  daysToService: 313,
  distanceToServiceKm: 4150,
  brakeFluidLevelWarning: 'BRAKE_FLUID_LEVEL_WARNING_NO_WARNING',
  metaReceivedAt: new Date(NOW - 30 * 86_400_000).toISOString(),
};
const AVAILABILITY = { availabilityStatus: 'AVAILABILITY_STATUS_AVAILABLE', usageMode: 'USAGE_MODE_ABANDONED', metaReceivedAt: minutesAgo(1) };
const ODOMETER = { odometerMeters: 122_963_000, metaReceivedAt: minutesAgo(1) };

const FULL_CAR: Record<string, Record<string, unknown> | null> = {
  'telemetry/battery': BATTERY,
  'telemetry/exterior': EXTERIOR_SECURE,
  'telemetry/availability': AVAILABILITY,
  'telemetry/odometer': ODOMETER,
  'telemetry/health': HEALTH,
  'charging/target-soc': TARGET,
  'charging/amp-limit': AMP,
};

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

function depsFor(payloads: Payloads, overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    client: fakeClient(payloads),
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
    nowMs: () => NOW,
    ...overrides,
  };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => part.text).join('\n');

async function aggregateText(payloads: Payloads, name: string, args: Record<string, unknown> = {}, overrides: Partial<ToolDeps> = {}): Promise<string> {
  return textOf(await toolSpec(aggregateToolSpecs(depsFor(payloads, overrides)), name).run(args, {}));
}

test('an absent exterior answer starts from unknown, not from a verdict', async () => {
  const result = await toolSpec(aggregateToolSpecs(depsFor({})), 'is_car_secure').run({}, {});
  const body = textOf(result);
  assert.match(body, /^Unknown, not reported:/, 'absence must not read as Yes or No');
  assert.doesNotMatch(body, /^Yes/);
  assert.doesNotMatch(body, /^No/);
  assert.match(body, /\(the API returned DATA_NOT_AVAILABLE, this vehicle does not report this domain\)\./);
  assert.equal(result.structuredContent?.code, 'DATA_NOT_AVAILABLE', 'the envelope carries the absence code');
  assert.deepEqual(result.structuredContent?.data, { reported: false });
});

test('an absent health answer is unknown, not "nothing needs attention"', async () => {
  const body = await aggregateText({}, 'get_needs_attention');
  assert.match(body, /^Unknown, not reported:/);
  assert.doesNotMatch(body, /Nothing needs attention/);
  assert.doesNotMatch(body, /^No/);
});

test('an all-absent status briefing names every constituent domain and starts from unknown', async () => {
  const body = await aggregateText({}, 'get_car_status');
  assert.match(body, /^Unknown, not reported:/);
  for (const name of ['battery', 'exterior', 'availability', 'odometer', 'health', 'target-soc']) {
    assert.ok(body.includes(name), `${name} must be named as unreported, got: ${body}`);
  }
  assert.match(body, /\(the API returned DATA_NOT_AVAILABLE, this vehicle does not report this domain\)\./);
});

test('a partial status names the unreported domain and prints every domain age with the oldest marked', async () => {
  const body = await aggregateText(
    { ...FULL_CAR, 'telemetry/exterior': null },
    'get_car_status',
  );
  assert.match(body, /Not reported: exterior \(the API returned DATA_NOT_AVAILABLE; absence is not a negative\)\./);
  assert.match(body, /Domain ages: battery 5 min ago; availability 1 min ago; odometer 1 min ago; health 30 d ago; target-soc 2 min ago\./);
  assert.match(body, /Oldest: health \(30 d ago\)\./, 'the oldest domain must be marked, not hidden behind the newest');
  assert.doesNotMatch(body, /newest domain/);
});

test('a triggered alarm can never produce "Yes, car is secure"', async () => {
  const payloads = { 'telemetry/exterior': { ...EXTERIOR_SECURE, alarm: 'ALARM_STATUS_TRIGGERED' } };
  const body = await aggregateText(payloads, 'is_car_secure');
  assert.match(body, /^No, car is not secure:/);
  assert.match(body, /alarm triggered/);
  assert.doesNotMatch(body, /Yes/);
});

test('an absent lock field is unknown, not unlocked', async () => {
  const body = await aggregateText({ 'telemetry/exterior': { ...EXTERIOR_SECURE, tailgateLock: undefined } }, 'is_car_secure');
  assert.match(body, /^Unknown, not reported:/);
  assert.match(body, /tailgate lock not reported/);
  assert.doesNotMatch(body, /not fully locked/);
  assert.doesNotMatch(body, /^No,/);
});

test('an explicitly unlocked lock is a No, not an unknown', async () => {
  const payloads = { 'telemetry/exterior': { ...EXTERIOR_SECURE, centralLock: 'LOCK_STATUS_UNLOCKED' } };
  const body = await aggregateText(payloads, 'is_car_secure');
  assert.match(body, /^No, car is not secure:/);
  assert.match(body, /not fully locked \(central lock\)/);
});

test('the status answer reports plugged state, target, car ETA and computed energy with their sources', async () => {
  const body = await aggregateText(FULL_CAR, 'get_car_status');
  assert.match(body, /• Charging state: Unplugged · Idle \(telemetry\/battery\)/);
  assert.match(body, /• Target charge level: 80% \(charging\/target-soc\)/);
  assert.match(body, /• Energy to target: 18\.4 kWh at the battery, 20\.4 kWh from the grid \(capacity 65\.7 kWh estimatedDistanceToEmptyKm and averageEnergyConsumptionKwhPer100Km; 90% AC efficiency\)/);
  assert.match(body, /• Car's own time to full: not reported by the car/);
});

test('the status answer shows the car own time to full when the car reports one', async () => {
  const body = await aggregateText({
    ...FULL_CAR,
    'telemetry/battery': {
      ...BATTERY,
      estimatedChargingTimeToFullMinutes: 45,
      chargerConnectionStatus: 'CHARGER_CONNECTION_STATUS_CONNECTED',
      chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING',
    },
  }, 'get_car_status');
  assert.match(body, /• Charging state: Plugged in · Charging \(telemetry\/battery\)/);
  assert.match(body, /• Car's own time to full: ~0h 45m/);
});

test('the status answer names a missing target instead of inventing one', async () => {
  const body = await aggregateText({ ...FULL_CAR, 'charging/target-soc': null }, 'get_car_status');
  assert.match(body, /• Target charge level: not reported by charging\/target-soc/);
  assert.match(body, /• Energy to target: cannot compute\. Missing: target charge level/);
});

test('the charging estimate states an assumed 80 percent target and always prints the figure it computed', async () => {
  const body = await aggregateText({ ...FULL_CAR, 'charging/target-soc': null }, 'get_charging_estimate');
  assert.match(body, /80 percent was assumed/);
  assert.match(body, /Energy to 80%: 18\.4 kWh at the battery, 20\.4 kWh from the grid at 90% AC efficiency/);
  assert.match(body, /Time at 13\.8 kW: ~1h 20m/);
  assert.equal(/([0-9]+(?:\.[0-9]+)?) kWh at the battery/.test(body), true, 'a figure follows the energy sentence');
  assert.doesNotMatch(body, /showing the car's own estimate instead/);
});

test('the car own estimate is labelled to full and never promised without a figure', async () => {
  const capacityless = {
    'telemetry/battery': {
      batteryChargeLevelPercentage: 52,
      estimatedChargingTimeToFullMinutes: 45,
      metaReceivedAt: minutesAgo(5),
    },
    'charging/target-soc': null,
    'charging/amp-limit': null,
  };
  const body = await aggregateText(capacityless, 'get_charging_estimate');
  assert.match(body, /Showing the car's own estimate to full instead: ~0h 45m/);
  assert.doesNotMatch(body, /to 100%/);

  const noEstimateAtAll = {
    ...capacityless,
    'telemetry/battery': { batteryChargeLevelPercentage: 52, estimatedChargingTimeToFullMinutes: 0, metaReceivedAt: minutesAgo(5) },
  };
  const second = await aggregateText(noEstimateAtAll, 'get_charging_estimate');
  assert.doesNotMatch(second, /showing the car's own estimate/);
  assert.match(second, /does not report its own time to full/);
});

test('location speed strings are read as numbers and altitude is rendered', () => {
  const data = {
    coordinate: { latitude: 47.6062, longitude: -122.3321 },
    heading: 121,
    speed: '45',
    altitude: '12',
    metaReceivedAt: minutesAgo(1),
  };
  assert.deepEqual(position(data), { latitude: 47.6062, longitude: -122.3321, altitude: 12, heading: 121, speedKmh: 45 });
  const summary = summarizeDomain('location', data, 'km');
  const joined = (summary ?? []).join('\n');
  assert.match(joined, /45 km\/h/);
  assert.match(joined, /altitude 12 m/);

  const noHeading = summarizeDomain('location', { coordinate: { latitude: 1, longitude: 2 }, speed: '45', metaReceivedAt: minutesAgo(1) }, 'km');
  assert.doesNotMatch((noHeading ?? []).join('\n'), /heading\s*°/);
});

test('the charge window summary renders normalized hours and the timer offset', () => {
  const active = summarizeDomain('global-charge-timer', {
    globalChargeTimer: { activated: true, start: { hour: 23, timeZone: { offsetMinutes: 120 } }, stop: { hour: 6 } },
  }, 'km');
  assert.deepEqual(active, ['Charge window: 23:00 → 06:00 (UTC+02:00) (active)']);

  const pastMidnight = summarizeDomain('global-charge-timer', {
    globalChargeTimer: { activated: false, start: { hour: 22, timeZone: { offsetMinutes: -300 } }, stop: { hour: 28 } },
  }, 'km');
  assert.deepEqual(pastMidnight, ['Charge window: 22:00 → 04:00 (UTC-05:00) (defined but inactive)']);
});

test('a settings payload is aged by its own updatedAtTimestamp, not the cloud receive clock', async () => {
  const timer = {
    globalChargeTimer: {
      activated: false,
      metadata: { updatedAtTimestamp: { seconds: '1786905554', nanos: 918000000 } },
      start: { hour: 23, timeZone: { offsetMinutes: 120 } },
      stop: { hour: 6 },
    },
    metaReceivedAt: '2026-09-10T10:16:55.687Z',
  };
  assert.equal(valueObservedAtMs(timer), 1_786_905_554_000);

  const nowMs = Date.parse('2026-09-10T10:16:55.687Z');
  const deps = depsFor({ 'charging/global-charge-timer': timer }, { nowMs: () => nowMs });
  const reading = await readDomainFormatted(
    deps,
    { kind: 'charging', name: 'global-charge-timer', scope: 'pdp-charging/globalChargeTimer' },
    {},
    {},
  );
  assert.equal(reading.isError, undefined);
  const expectedAge = formatAge(1_786_905_554_000, nowMs);
  assert.match(reading.content[0]!.text, new RegExp(`data observed ${expectedAge}`));
});

test('a redacted elicitation offers masked choices, and the answer maps back to the real VIN', async () => {
  const vins = ['YSMTEST22PL000001', 'YSMTEST22PL000002'];
  let asked: { message: string | undefined; choices: string[] } | undefined;
  const client = {
    async resolveVin(vin?: string) {
      if (vin !== undefined) return vin;
      throw new PolestarApiError('AMBIGUOUS_VIN', 'this credential sees two vehicles', 400);
    },
    async vehicles() {
      return vins;
    },
    async domain() {
      return null;
    },
  } as unknown as PolestarClient;
  const deps = { client, redactVin: true, vehicleLabels: {}, delegatedAccounts: [], units: 'km' } as ToolDeps;
  const ctx = {
    mcpReq: {
      elicitInput: async (params: { message?: string; requestedSchema?: { properties?: { vin?: { enum?: string[] } } } }) => {
        asked = { message: params.message, choices: params.requestedSchema?.properties?.vin?.enum ?? [] };
        return { action: 'accept', content: { vin: params.requestedSchema?.properties?.vin?.enum?.[1] } };
      },
    },
  };

  const chosen = await resolveVinOrAsk(deps, ctx, undefined, 'pick-vehicle-battery');
  assert.equal(chosen.vin, vins[1], 'the masked choice is mapped back to the real VIN');
  assert.deepEqual(asked?.choices, ['YSM…001', 'YSM…002']);
  for (const raw of vins) {
    assert.equal(asked?.message?.includes(raw), false, 'no raw VIN in the elicitation message');
    assert.equal(asked?.choices?.includes(raw), false);
  }
});

test('a declined redacted elicitation reports masked identifiers only', async () => {
  const vins = ['YSMTEST22PL000001', 'YSMTEST22PL000002'];
  const client = {
    async resolveVin(vin?: string) {
      if (vin !== undefined) return vin;
      throw new PolestarApiError('AMBIGUOUS_VIN', 'this credential sees two vehicles', 400);
    },
    async vehicles() {
      return vins;
    },
    async domain() {
      return null;
    },
  } as unknown as PolestarClient;
  const deps = { client, redactVin: true, vehicleLabels: {}, delegatedAccounts: [], units: 'km' } as ToolDeps;
  const ctx = { mcpReq: { elicitInput: async () => ({ action: 'decline' }) } };

  await assert.rejects(
    () => resolveVinOrAsk(deps, ctx, undefined, 'pick-vehicle-battery'),
    (err: PolestarApiError) => {
      assert.equal(err.code, 'VIN_NOT_CHOSEN');
      assert.match(err.message, /YSM…001/);
      for (const raw of vins) assert.equal(err.message.includes(raw), false);
      return true;
    },
  );
});

test('an unaskable redacted client gets a masked ambiguity error', async () => {
  const vins = ['YSMTEST22PL000001', 'YSMTEST22PL000002'];
  const client = {
    async resolveVin(vin?: string) {
      if (vin !== undefined) return vin;
      throw new PolestarApiError('AMBIGUOUS_VIN', `Known VINs: ${vins.join(', ')}`, 400);
    },
    async vehicles() {
      return vins;
    },
    async domain() {
      return null;
    },
  } as unknown as PolestarClient;
  const deps = { client, redactVin: true, vehicleLabels: {}, delegatedAccounts: [], units: 'km' } as ToolDeps;

  await assert.rejects(
    () => resolveVinOrAsk(deps, undefined, undefined, 'pick-vehicle-battery'),
    (err: PolestarApiError) => {
      assert.equal(err.code, 'AMBIGUOUS_VIN');
      assert.match(err.message, /YSM…001/);
      for (const raw of vins) assert.equal(err.message.includes(raw), false);
      return true;
    },
  );
});

test('a 403 keeps its code-specific hint instead of claiming a missing scope', async () => {
  const domain = { kind: 'telemetry' as const, name: 'battery', scope: 'pdp-telemetry/battery' };
  const failing = (code: string): ToolDeps => ({
    ...depsFor({}),
    client: {
      async resolveVin(vin?: string) {
        return vin ?? VIN;
      },
      async vehicles() {
        return [VIN];
      },
      async domain(): Promise<Record<string, unknown>> {
        throw new PolestarApiError(code, 'upstream refused the domain', 403);
      },
      forDelegation() {
        return this;
      },
    } as unknown as PolestarClient,
  });

  const vinUnauthorized = await readDomainFormatted(failing('AUTHZ_VIN_UNAUTHORIZED'), domain, {}, {});
  assert.equal(vinUnauthorized.isError, true);
  assert.match(String(vinUnauthorized.structuredContent?.hint), /list_vehicles/);
  assert.doesNotMatch(String(vinUnauthorized.structuredContent?.hint), /OAuth scope/);

  const clientMismatch = await readDomainFormatted(failing('AUTHZ_CLIENT_ID_MISMATCH'), domain, {}, {});
  assert.match(String(clientMismatch.structuredContent?.hint), /POLESTAR_ACCOUNT_ID/);
  assert.doesNotMatch(String(clientMismatch.structuredContent?.hint), /OAuth scope/);

  const scopeProblem = await readDomainFormatted(failing('AUTHZ_SCOPE_MISSING'), domain, {}, {});
  assert.match(String(scopeProblem.structuredContent?.hint), /OAuth scope `pdp-telemetry\/battery`/);
});
