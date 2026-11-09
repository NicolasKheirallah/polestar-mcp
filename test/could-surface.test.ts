import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TokenProvider } from '../src/auth.js';
import { PolestarApiError, PolestarClient, type DomainKind } from '../src/client.js';
import { domainToolSpecs, LIST_VEHICLE_DOMAINS } from '../src/domain-tools.js';
import { domainView } from '../src/domain-view.js';
import { DOMAINS, toolName } from '../src/domains.js';
import { FixtureTransport, type Transport, type TransportRequest, type TransportResponse } from '../src/transport.js';
import { toolSpec } from '../src/tools.js';
import type { ToolDeps } from '../src/tool-output.js';
import { systemToolSpecs, type SystemDeps } from '../src/system-tools.js';

/**
 * The Could wave: the vehicle support matrix and the typed data field.
 *
 * The matrix answers "which of these questions can my car answer before I spend
 * calls" and the views make a Domain answer machine-readable without changing
 * its prose. Both are asserted from the shipped fixtures, so the tests fail if a
 * Domain row, a status classification or a view field drifts.
 */

const VIN = 'YSMTEST22PL000001';
const NOW_MS = Date.parse('2026-11-09T12:00:00Z');
const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/dump', import.meta.url));

function fixtureData(kind: DomainKind, name: string): Record<string, unknown> | null {
  const body = JSON.parse(
    readFileSync(new URL(`./fixtures/dump/dataportal/${kind}/${name}.json`, import.meta.url), 'utf8'),
  ) as { data?: Record<string, unknown> };
  return body.data ?? null;
}

/** A client that answers from the shipped fixtures, so a view is tested on real shapes. */
function fixtureClient(calls: string[] = []): PolestarClient {
  const make = (account: string | undefined): PolestarClient =>
    ({
      vehicles: async () => [VIN],
      resolveVin: async (vin?: string) => vin ?? VIN,
      domain: async (_vin: string, kind: DomainKind, name: string) => {
        calls.push(`${account ?? 'owner'}:${kind}/${name}`);
        return fixtureData(kind, name);
      },
      forDelegation: (id: string) => make(id),
    }) as unknown as PolestarClient;
  return make(undefined);
}

function depsWith(client: PolestarClient, over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    client,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
    nowMs: () => NOW_MS,
    ...over,
  };
}

class CountingTransport implements Transport {
  readonly urls: string[] = [];
  constructor(private readonly inner: Transport) {}
  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    this.urls.push(url);
    return this.inner.fetch(url, request);
  }
}

/** A real client over the shipped fixture dump; no credential, no network. */
function fixtureBackedClient(allowLocation: boolean): { client: PolestarClient; transport: CountingTransport } {
  const transport = new CountingTransport(new FixtureTransport(FIXTURE_ROOT));
  const tokenProvider = {
    token: async () => 'fixture-test-token',
    invalidate: () => undefined,
  } as unknown as TokenProvider;
  return {
    client: new PolestarClient(tokenProvider, transport, {
      baseUrl: 'https://api.test/m2m',
      accountId: 'fixture-account',
      allowLocation,
    }),
    transport,
  };
}

test('list_vehicle_domains classifies all 15 domains from the shipped fixtures', async () => {
  const { client } = fixtureBackedClient(true);
  const spec = toolSpec(domainToolSpecs(depsWith(client)), LIST_VEHICLE_DOMAINS.name);
  const out = await spec.run({}, {});
  assert.equal(out.isError, undefined);
  const data = out.structuredContent?.data as {
    vin?: string;
    counts?: Record<string, number>;
    domains?: Array<{ kind: string; name: string; tool: string; status: string; code?: string; ageSeconds?: number; observedAt?: string }>;
  };
  assert.equal(data.vin, VIN);
  assert.deepEqual(data.counts, { total: 15, reported: 14, absent: 1, failed: 0, disallowed: 0 });
  assert.equal(data.domains?.length, 15);
  assert.deepEqual(
    data.domains?.map((entry) => entry.name),
    DOMAINS.map((domain) => domain.name),
    'the matrix follows the registry order',
  );
  for (const entry of data.domains ?? []) {
    assert.ok(entry.status === 'reported' || entry.status === 'absent', `${entry.name}: unexpected status ${entry.status}`);
    assert.equal(entry.tool, `get_${entry.name.replace(/-/g, '_')}`);
    if (entry.status === 'reported') {
      assert.equal(typeof entry.ageSeconds, 'number', `${entry.name}: a reported domain carries an age`);
      assert.ok((entry.ageSeconds ?? -1) >= 0);
      assert.match(String(entry.observedAt), /^\d{4}-\d{2}-\d{2}T/);
    }
  }
  const absent = data.domains?.find((entry) => entry.name === 'is-at-charge-location');
  assert.equal(absent?.status, 'absent');
  assert.equal(absent?.code, 'DATA_NOT_AVAILABLE');

  const text = out.content[0]!.text;
  assert.match(text, /^Vehicle YSMTEST22PL000001: 14 of 15 domains reported\./);
  assert.match(text, /telemetry\/battery: reported \(/);
  assert.match(text, /charging\/is-at-charge-location: absent \(DATA_NOT_AVAILABLE, which is not an error\)/);
  assert.match(text, /one cached read per domain on a cold cache/);
});

test('POLESTAR_ALLOW_LOCATION=false marks location disallowed and never requests it', async () => {
  const { client, transport } = fixtureBackedClient(false);
  const spec = toolSpec(domainToolSpecs(depsWith(client)), LIST_VEHICLE_DOMAINS.name);
  const out = await spec.run({}, {});
  assert.equal(out.isError, undefined);
  const data = out.structuredContent?.data as {
    counts?: Record<string, number>;
    domains?: Array<{ name: string; status: string; code?: string }>;
  };
  assert.deepEqual(data.counts, { total: 15, reported: 13, absent: 1, failed: 0, disallowed: 1 });
  const location = data.domains?.find((entry) => entry.name === 'location');
  assert.equal(location?.status, 'disallowed');
  assert.equal(location?.code, 'LOCATION_DISALLOWED');
  assert.equal(
    transport.urls.some((url) => url.endsWith('/telemetry/location')),
    false,
    'the disabled Domain is refused inside PolestarClient before any transport call',
  );
  const text = out.content[0]!.text;
  assert.match(text, /telemetry\/location: disallowed \(POLESTAR_ALLOW_LOCATION=false, so no position request was sent\)/);
  assert.equal(/latitude|longitude|coordinate/.test(JSON.stringify(out.structuredContent)), false, 'no position value is exposed');
});

test('a failed domain is reported as failed with its code, and the matrix still answers', async () => {
  const calls: string[] = [];
  const client = {
    vehicles: async () => [VIN],
    resolveVin: async (vin?: string) => vin ?? VIN,
    domain: async (_vin: string, kind: DomainKind, name: string) => {
      calls.push(`${kind}/${name}`);
      if (name === 'health') throw new PolestarApiError('AUTHZ_VIN_UNAUTHORIZED', 'no access to that VIN', 403, 'req-403');
      return fixtureData(kind, name);
    },
    forDelegation() { return this; },
  } as unknown as PolestarClient;
  const spec = toolSpec(domainToolSpecs(depsWith(client)), LIST_VEHICLE_DOMAINS.name);
  const out = await spec.run({}, {});
  assert.equal(out.isError, undefined, 'one failed Domain does not fail the matrix');
  const data = out.structuredContent?.data as {
    counts?: Record<string, number>;
    domains?: Array<{ name: string; status: string; code?: string; httpStatus?: number }>;
  };
  assert.equal(data.counts?.failed, 1);
  assert.equal(data.counts?.reported, 13);
  const health = data.domains?.find((entry) => entry.name === 'health');
  assert.equal(health?.status, 'failed');
  assert.equal(health?.code, 'AUTHZ_VIN_UNAUTHORIZED');
  assert.equal(health?.httpStatus, 403);
  assert.match(out.content[0]!.text, /telemetry\/health: failed \(AUTHZ_VIN_UNAUTHORIZED, HTTP 403\)/);
  assert.equal(new Set(calls).size, 15, 'every Domain is attempted exactly once');
});

test('every Domain tool carries its typed view in structuredContent.data', async () => {
  const specs = domainToolSpecs(depsWith(fixtureClient()));
  const expected: Record<string, Record<string, unknown>> = {
    availability: { availabilityStatus: 'AVAILABILITY_STATUS_AVAILABLE', usageMode: 'USAGE_MODE_ABANDONED' },
    battery: {
      chargeLevelPct: 52,
      distanceToEmptyKm: 170,
      chargingStatus: 'CHARGING_STATUS_V2_IDLE',
      chargerConnectionStatus: 'CHARGER_CONNECTION_STATUS_DISCONNECTED',
      isCharging: false,
      consumptionKwhPer100Km: 20.1,
    },
    exterior: { lockState: 'locked', alarmState: 'ok', open: [], openSecurityRelevant: [] },
    health: { daysToService: 313, distanceToServiceKm: 4150, engineHoursToService: 773 },
    location: { latitude: 47.6062, longitude: -122.3321, altitude: 0, heading: 121, speedKmh: 0 },
    odometer: { odometerMeters: 122952704, odometerKm: 122952.704 },
    'parking-climatization': { runningStatus: 'RUNNING_STATUS_OFF', runtimeLeftMinutes: 0 },
    'pre-cleaning': { pm25: 0, airQualityIndex: 0, lastCycleValid: true },
    'amp-limit': { ampLimitA: 20, pendingAmpLimitA: 20, source: 'RCS' },
    'charge-locations': { savedChargeLocations: 0, utc0: true },
    'charge-now': { overrideSynced: true },
    'global-charge-timer': { activated: false, startHour: 23, stopHour: 6, offsetMinutes: 120, pendingChanges: false },
    'parking-climate-timer': { timers: [{ index: 0, activated: false, repeat: false, readyAtHour: 14, offsetMinutes: 120, weekdays: ['SUNDAY'] }] },
    'target-soc': { targetPct: 80, settingType: 'CUSTOM' },
  };

  for (const domain of DOMAINS) {
    const spec = toolSpec(specs, toolName(domain));
    const out = await spec.run({}, {});
    assert.equal(out.isError, undefined, `${domain.name}: the fixture read succeeds`);
    const data = out.structuredContent?.data as Record<string, unknown> | undefined;
    if (domain.name === 'is-at-charge-location') {
      assert.deepEqual(data, { reported: false }, 'an absent Domain carries the absence signal');
      continue;
    }
    assert.ok(data !== undefined, `${domain.name}: a default read carries data`);
    for (const [key, value] of Object.entries(expected[domain.name] ?? {})) {
      assert.deepEqual(data?.[key], value, `${domain.name}.${key}`);
    }
    assert.ok(
      Buffer.byteLength(JSON.stringify(data)) < 600,
      `${domain.name}: the view stays compact (${Buffer.byteLength(JSON.stringify(data))} bytes)`,
    );
    assert.equal(typeof out.structuredContent?.ageSeconds, 'number', `${domain.name}: the envelope keeps the age`);
  }
});

test('raw:true keeps the raw payload in data instead of the compact view', async () => {
  const specs = domainToolSpecs(depsWith(fixtureClient()));
  const out = await toolSpec(specs, 'get_battery').run({ raw: true }, {});
  assert.equal(out.isError, undefined);
  const data = out.structuredContent?.data as Record<string, unknown> | undefined;
  assert.equal(data?.batteryChargeLevelPercentage, 52, 'the raw payload is the one the API sent');
  assert.equal(data?.chargeLevelPct, undefined, 'the compact view does not overwrite the documented raw payload');
  assert.match(out.content[0]!.text, /Raw payload:/);
});

test('polestar_status carries the budget, cache and token facts as data', async () => {
  const deps = {
    client: {} as unknown as PolestarClient,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
    budget: {
      snapshot: () => ({ used: 2_500, limit: 10_000, remaining: 7_500, fractionUsed: 0.25, resetsAtUtc: '2026-01-02T00:00:00Z' }),
    },
    minute: { snapshot: () => ({ used: 12, limit: 100 }) },
    cacheStats: { enabled: true, hits: 6, staleServed: 2, misses: 2, refreshes: 1, entries: 4 },
    tokenExpiresAt: () => NOW_MS + 12 * 60_000,
    fixtureMode: false,
    nowMs: () => NOW_MS,
  } as unknown as SystemDeps;
  const out = await toolSpec(systemToolSpecs(deps), 'polestar_status').run({}, {});
  const data = out.structuredContent?.data as {
    mode?: string;
    budget?: Record<string, number | string>;
    minute?: Record<string, number>;
    cache?: Record<string, number | boolean>;
    token?: Record<string, number | boolean>;
  };
  assert.equal(data.mode, 'live');
  assert.deepEqual(data.budget, { used: 2_500, limit: 10_000, remaining: 7_500, resetsAtUtc: '2026-01-02T00:00:00Z' });
  assert.deepEqual(data.minute, { used: 12, limit: 100 });
  assert.equal(data.cache?.enabled, true);
  assert.equal(data.cache?.hits, 6);
  assert.equal(data.cache?.hitRatePct, 80);
  assert.equal(data.token?.trustedMinutes, 7, 'the skew-adjusted life is the machine-readable one too');
  assert.equal(data.token?.expiresAt, NOW_MS + 12 * 60_000);
  assert.match(out.content[0]!.text, /Token: trusted ~7 more min/);

  const withSampler = await toolSpec(
    systemToolSpecs({ ...deps, sampler: { describe: () => 'on, every 600s, budget-guarded' } } as SystemDeps),
    'polestar_status',
  ).run({}, {});
  assert.equal((withSampler.structuredContent?.data as { sampling?: string }).sampling, 'on, every 600s, budget-guarded');
});

test('the new tool is registered once with the documented release name and description', () => {
  const specs = domainToolSpecs(depsWith(fixtureClient()));
  assert.equal(specs.filter((spec) => spec.name === LIST_VEHICLE_DOMAINS.name).length, 1);
  const spec = toolSpec(specs, LIST_VEHICLE_DOMAINS.name);
  assert.equal(spec.name, 'list_vehicle_domains');
  assert.equal(spec.title, 'List what the car reports');
  assert.equal(spec.description, LIST_VEHICLE_DOMAINS.description);
  assert.ok(spec.args?.vin !== undefined, 'the matrix takes the optional Vehicle argument');
  assert.ok(spec.args?.delegated_account_id !== undefined, 'the matrix takes the delegation argument');
  assert.equal(spec.annotations.readOnlyHint, true);
  assert.equal(spec.annotations.openWorldHint, true);
});

test('the view module keeps enum values machine-readable rather than prose', () => {
  const battery = domainView('battery', fixtureData('telemetry', 'battery') ?? {});
  assert.equal(battery.chargingStatus, 'CHARGING_STATUS_V2_IDLE', 'the API enum is preserved for a client to map');
  const exterior = domainView('exterior', fixtureData('telemetry', 'exterior') ?? {});
  assert.equal(exterior.alarmState, 'ok');
  assert.equal(exterior.lockState, 'locked');
});
