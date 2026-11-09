import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HistoryStore, type HistoryRecord } from '../src/history.js';
import { reconstructTrips, renderTrips } from '../src/trips.js';
import {
  buildTimeline,
  renderTimeline,
  TIMELINE_SOURCES,
  type TimelineSource,
  type TimelineSourceRecords,
} from '../src/timeline.js';
import { weeklyDigest } from '../src/digest.js';
import { extraHistoryToolNames, extraHistoryToolSpecs, type ExtraHistoryDeps } from '../src/extra-history-tools.js';
import { toolSpec } from '../src/tools.js';
import type { PolestarClient } from '../src/client.js';

/**
 * The wave 2 could-analytics modules: trip reconstruction (C7), the cross-domain
 * timeline (C8) and the weekly digest (C9).
 *
 * Each module is tested pure first, with synthetic records, and then through the
 * tool spec it is wrapped in, with a real HistoryStore in a temporary directory.
 * The wording tests are deliberate: an empty or sparse store must never read as
 * "nothing changed".
 */

const VIN = 'YSMTEST22PL000001';
const NOW = Date.parse('2026-11-09T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

function record(
  observedAt: number,
  data: Record<string, unknown>,
  options: { valueAtMs?: number; metaEventId?: string } = {},
): HistoryRecord {
  return {
    observedAt,
    ...(options.valueAtMs !== undefined ? { valueObservedAt: options.valueAtMs } : {}),
    ...(options.metaEventId !== undefined ? { metaEventId: options.metaEventId } : {}),
    data,
  };
}

function source(label: string): TimelineSource {
  const found = TIMELINE_SOURCES.find((candidate) => candidate.label === label);
  assert.ok(found !== undefined, `timeline has a ${label} source`);
  return found;
}

function timelineInputs(records: Partial<Record<string, HistoryRecord[]>>): TimelineSourceRecords[] {
  return TIMELINE_SOURCES.map((candidate) => {
    const forSource = records[candidate.label] ?? [];
    return { source: candidate, records: forSource, anyRecords: forSource.length > 0 };
  });
}

function digestSources(records: Partial<Record<string, HistoryRecord[]>>): TimelineSourceRecords[] {
  return TIMELINE_SOURCES.map((candidate) => {
    const forSource = records[`${candidate.kind}/${candidate.name}`] ?? [];
    return { source: candidate, records: forSource, anyRecords: forSource.length > 0 };
  });
}

function tempStore(): HistoryStore {
  return new HistoryStore(mkdtempSync(path.join(tmpdir(), 'polestar-could-')));
}

function fakeDeps(overrides: Partial<ExtraHistoryDeps> = {}): ExtraHistoryDeps {
  const store = overrides.store ?? tempStore();
  const client = {
    async resolveVin(vin?: string) {
      return vin ?? VIN;
    },
    async vehicles() {
      return [VIN];
    },
    async domain() {
      return null;
    },
  } as unknown as PolestarClient;
  return {
    client,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
    store,
    allowLocation: true,
    nowMs: () => NOW,
    ...overrides,
  };
}

function append(store: HistoryStore, kind: string, name: string, records: readonly HistoryRecord[]): void {
  for (const entry of records) store.append(VIN, kind, name, entry);
}

const ODOMETER_SAMPLES = [
  { atMs: NOW - 2 * HOUR, odometerMeters: 122_952_704 },
  { atMs: NOW - HOUR, odometerMeters: 122_967_704 },
  { atMs: NOW - 30 * 60_000, odometerMeters: 122_987_704 },
];

test('odometer differences become a trip with a start and an end', () => {
  const result = reconstructTrips(ODOMETER_SAMPLES);
  assert.equal(result.sufficient, true);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.distanceMeters, 35_000, '122,952,704 to 122,987,704 m is 35.0 km');
  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0]!.startedAt, ODOMETER_SAMPLES[0]!.atMs);
  assert.equal(result.trips[0]!.endedAt, ODOMETER_SAMPLES[2]!.atMs);
  assert.equal(result.trips[0]!.distanceMeters, 35_000);
  assert.equal(result.trips[0]!.sampleCount, 3);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.resets.length, 0);
  assert.match(renderTrips(result, 'km').join('\n'), /Distance: 35 km over 3 odometer sample\(s\)/);
});

test('a decreasing odometer is a reset event, never negative distance', () => {
  const result = reconstructTrips([
    { atMs: NOW - 3 * HOUR, odometerMeters: 100_000 },
    { atMs: NOW - 2 * HOUR, odometerMeters: 120_000 },
    { atMs: NOW - HOUR, odometerMeters: 90_000 },
    { atMs: NOW - 30 * 60_000, odometerMeters: 92_000 },
  ]);
  assert.equal(result.distanceMeters, 22_000, 'the 20 km rise plus the 2 km after the reset');
  assert.ok(result.distanceMeters >= 0);
  assert.equal(result.resets.length, 1);
  assert.equal(result.resets[0]!.fromMeters, 120_000);
  assert.equal(result.resets[0]!.toMeters, 90_000);
  assert.ok(result.trips.every((trip) => trip.distanceMeters > 0));
  assert.match(renderTrips(result, 'km').join('\n'), /odometer reset\(s\)/i);
});

test('a gap longer than a day is named and not placed in time', () => {
  const gapStart = NOW - 36 * HOUR;
  const afterGap = NOW - 5 * HOUR;
  const result = reconstructTrips([
    { atMs: gapStart, odometerMeters: 100_000 },
    { atMs: afterGap, odometerMeters: 105_000 },
    { atMs: afterGap + 10 * 60_000, odometerMeters: 107_000 },
  ]);
  assert.equal(result.sufficient, true);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0]!.startedAt, gapStart);
  assert.equal(result.gaps[0]!.endedAt, afterGap);
  assert.equal(result.gaps[0]!.distanceMeters, 5_000);
  assert.equal(result.distanceMeters, 7_000, 'both the gap distance and the observed trip are counted once');
  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0]!.startedAt, afterGap, 'no trip spans the gap');
  assert.match(renderTrips(result, 'km').join('\n'), /unobserved gap\(s\)/i);
});

test('fewer than three readings is refused with the count, and no readings with its own sentence', () => {
  const two = reconstructTrips([
    { atMs: NOW - HOUR, odometerMeters: 100_000 },
    { atMs: NOW - 30 * 60_000, odometerMeters: 101_000 },
  ]);
  assert.equal(two.sufficient, false);
  assert.equal(two.distanceMeters, 0);
  assert.match(two.reason ?? '', /2 odometer samples/);
  assert.match(two.reason ?? '', /3 are needed/);

  const none = reconstructTrips([]);
  assert.equal(none.sufficient, false);
  assert.equal(none.sampleCount, 0);
  assert.match(none.reason ?? '', /no odometer samples/);
  assert.match(renderTrips(none, 'km').join('\n'), /^Trips: no odometer samples/);
});

test('the trips tool reads the store, reports 35 km, and says an empty store was not observed', async () => {
  const deps = fakeDeps();
  append(
    deps.store,
    'telemetry',
    'odometer',
    ODOMETER_SAMPLES.map((sample) => record(sample.atMs, { odometerMeters: sample.odometerMeters }, { valueAtMs: sample.atMs })),
  );
  const specs = extraHistoryToolSpecs(deps);
  const trips = await toolSpec(specs, 'get_trips').run({}, {});

  assert.notEqual(trips.isError, true);
  assert.match(trips.content[0]!.text, /Distance: 35 km over 3 odometer sample\(s\)/);
  const data = trips.structuredContent?.data as { distanceMeters?: number; trips?: unknown[]; sampleCount?: number };
  assert.equal(data.distanceMeters, 35_000);
  assert.equal(data.sampleCount, 3);
  assert.equal(data.trips?.length, 1);

  const empty = await toolSpec(extraHistoryToolSpecs(fakeDeps()), 'get_trips').run({}, {});
  assert.notEqual(empty.isError, true);
  assert.match(empty.content[0]!.text, /Trips: no odometer samples are recorded/);
  assert.match(empty.content[0]!.text, /POLESTAR_SAMPLE/);
  assert.equal((empty.structuredContent?.data as { sampleCount?: number }).sampleCount, 0);
});

test('the timeline orders two domains into one sequence with relative ages', () => {
  const batteryAt = NOW - 2 * HOUR;
  const odometerAt = batteryAt + 60_000;
  const result = buildTimeline(
    timelineInputs({
      battery: [record(batteryAt, { batteryChargeLevelPercentage: 40, chargingStatusV2: 'CHARGING_STATUS_V2_IDLE' })],
      odometer: [record(odometerAt, { odometerMeters: 122_952_704 })],
    }),
    { sinceMs: NOW - 3 * HOUR, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: true },
  );
  assert.deepEqual(result.events.map((event) => event.source), ['odometer', 'battery'], 'newest first');
  assert.equal(result.events[0]!.atMs, odometerAt);
  assert.match(result.events[0]!.age, /ago$/);
  assert.match(result.events[1]!.text, /charge 40%/);
  assert.match(renderTimeline(result)[0]!, /2 event\(s\) from 2 record\(s\)/);
});

test('only a changed value becomes an event; repeated snapshots are not news', () => {
  const snapshot = { batteryChargeLevelPercentage: 40, chargingStatusV2: 'CHARGING_STATUS_V2_IDLE' };
  const unchanged = buildTimeline(
    timelineInputs({
      battery: [
        record(NOW - 3 * HOUR, snapshot),
        record(NOW - 2 * HOUR, snapshot),
        record(NOW - HOUR, snapshot),
      ],
    }),
    { sinceMs: NOW - 4 * HOUR, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: true },
  );
  assert.equal(unchanged.events.length, 1, 'the first observation is listed, the two repeats are not');
  assert.equal(unchanged.recordCount, 3);

  const changed = buildTimeline(
    timelineInputs({
      battery: [
        record(NOW - 2 * HOUR, snapshot),
        record(NOW - HOUR, { ...snapshot, batteryChargeLevelPercentage: 41 }),
      ],
    }),
    { sinceMs: NOW - 3 * HOUR, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: true },
  );
  assert.equal(changed.events.length, 2);
  assert.match(changed.events[0]!.text, /charge 41%/);
});

test('a charge window renders its hours instead of an empty payload', () => {
  const result = buildTimeline(
    timelineInputs({
      'charge window': [
        record(NOW - HOUR, { globalChargeTimer: { activated: true, start: { hour: 23 }, stop: { hour: 6 } } }),
      ],
    }),
    { sinceMs: NOW - 2 * HOUR, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: true },
  );
  assert.equal(result.events.length, 1);
  assert.match(result.events[0]!.text, /23:00/);
  assert.match(result.events[0]!.text, /06:00/);
  assert.doesNotMatch(result.events[0]!.text, /\{\}/);
});

test('location is excluded before it is read when the operator opted out', () => {
  const inputs = timelineInputs({
    battery: [record(NOW - HOUR, { batteryChargeLevelPercentage: 40 })],
    location: [record(NOW - 2 * HOUR, { coordinate: { latitude: 47.6062, longitude: -122.3321 } })],
  });
  const allowed = buildTimeline(inputs, { sinceMs: NOW - 3 * HOUR, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: true });
  assert.ok(allowed.events.some((event) => event.source === 'location'));
  assert.deepEqual(allowed.excluded, []);

  const refused = buildTimeline(inputs, { sinceMs: NOW - 3 * HOUR, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: false });
  assert.deepEqual(refused.excluded, ['location']);
  assert.equal(refused.events.some((event) => event.source === 'location'), false);
  assert.match(renderTimeline(refused).join('\n'), /POLESTAR_ALLOW_LOCATION=false/);
});

test('a new warning is one transition, and an unchanged warning is not repeated', () => {
  const healthAt = NOW - 2 * DAY;
  const warningPayload = {
    lowVoltageBatteryWarning: 'LOW_VOLTAGE_BATTERY_WARNING_LOW',
    daysToService: 313,
    distanceToServiceKm: 4_150,
  };
  const result = buildTimeline(
    timelineInputs({
      health: [
        record(healthAt, { lowVoltageBatteryWarning: 'NO_WARNING', daysToService: 313, distanceToServiceKm: 4_150 }),
        record(healthAt + DAY, warningPayload),
        record(healthAt + DAY + HOUR, { ...warningPayload, daysToService: 312 }),
      ],
    }),
    { sinceMs: NOW - 3 * DAY, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: true },
  );
  const healthEvents = result.events.filter((event) => event.source === 'health');
  assert.equal(healthEvents.length, 3, 'the warning change and the countdown change are separate rows');
  const newWarningRows = healthEvents.filter((event) => event.text.includes('new warning'));
  assert.equal(newWarningRows.length, 1, 'exactly one row names the warning as new');
  assert.match(newWarningRows[0]!.text, /low voltage battery/);
  const repeats = healthEvents.filter((event) => event.text.includes('new warning:') && event.atMs > healthAt + DAY + 1);
  assert.equal(repeats.length, 0, 'an unchanged warning set is not announced again');
});

test('a record is dated by the value clock, and a read-clock record says so', () => {
  const valueAt = NOW - 48 * DAY;
  const clocked = buildTimeline(
    timelineInputs({ battery: [record(NOW, { batteryChargeLevelPercentage: 61 }, { valueAtMs: valueAt })] }),
    { sinceMs: NOW - 49 * DAY, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: true },
  );
  assert.equal(clocked.events[0]!.atMs, valueAt, 'dated 48 days earlier, by the value clock');
  assert.equal(clocked.readClockRecords, 0);

  const readClock = buildTimeline(
    timelineInputs({ battery: [record(NOW - HOUR, { batteryChargeLevelPercentage: 61 })] }),
    { sinceMs: NOW - 2 * HOUR, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: true },
  );
  assert.equal(readClock.readClockRecords, 1);
  assert.match(readClock.notes.join('\n'), /server read clock/);
});

test('an empty timeline says nothing was observed, and absent sources say which kind of absent', () => {
  const empty = buildTimeline(timelineInputs({}), {
    sinceMs: NOW - DAY,
    untilMs: NOW,
    nowMs: NOW,
    units: 'km',
    allowLocation: true,
  });
  assert.equal(empty.events.length, 0);
  assert.equal(empty.recordCount, 0);
  const rendered = renderTimeline(empty).join('\n');
  assert.match(rendered, /No history records for these domains/);
  assert.match(rendered, /nothing was observed/);
  assert.match(rendered, /POLESTAR_SAMPLE/);
  assert.doesNotMatch(rendered, /^Nothing (changed|happened)/im, 'the empty answer never claims a quiet week');

  const mixed = buildTimeline(
    [
      { source: source('battery'), records: [record(NOW - 48 * HOUR, { batteryChargeLevelPercentage: 61 })], anyRecords: true },
      { source: source('health'), records: [], anyRecords: false },
    ],
    { sinceMs: NOW - DAY, untilMs: NOW, nowMs: NOW, units: 'km', allowLocation: true },
  );
  assert.deepEqual(
    mixed.absent.sort((a, b) => a.source.localeCompare(b.source)),
    [
      { source: 'battery', reason: 'no-records-in-window' },
      { source: 'health', reason: 'never-recorded' },
    ],
  );
  assert.match(renderTimeline(mixed).join('\n'), /No records: health \(never recorded for this vehicle\)/);
});

test('the timeline tool reads the store and reports an empty store explicitly', async () => {
  const deps = fakeDeps();
  append(deps.store, 'telemetry', 'battery', [
    record(NOW - 2 * HOUR, { batteryChargeLevelPercentage: 40, chargingStatusV2: 'CHARGING_STATUS_V2_IDLE' }, { valueAtMs: NOW - 2 * HOUR }),
    record(NOW - HOUR, { batteryChargeLevelPercentage: 41, chargingStatusV2: 'CHARGING_STATUS_V2_IDLE' }, { valueAtMs: NOW - HOUR }),
  ]);
  append(deps.store, 'telemetry', 'odometer', [
    record(NOW - 90 * 60_000, { odometerMeters: 122_952_704 }, { valueAtMs: NOW - 90 * 60_000 }),
  ]);
  const specs = extraHistoryToolSpecs(deps);
  const timeline = await toolSpec(specs, 'get_timeline').run({ hours: 4 }, {});
  assert.notEqual(timeline.isError, true);
  assert.match(timeline.content[0]!.text, /battery:/);
  assert.match(timeline.content[0]!.text, /odometer:/);
  const data = timeline.structuredContent?.data as { windowHours?: number; eventCount?: number };
  assert.equal(data.windowHours, 4);
  assert.equal(data.eventCount, 3, 'every Domain first observation in the window is a row');

  const empty = await toolSpec(extraHistoryToolSpecs(fakeDeps()), 'get_timeline').run({}, {});
  assert.notEqual(empty.isError, true);
  assert.match(empty.content[0]!.text, /nothing was observed/);
  assert.match(empty.content[0]!.text, /POLESTAR_SAMPLE/);
});

test('the weekly digest names each changed item once, with its window and samples', () => {
  const sources = digestSources({
    'telemetry/battery': [
      record(NOW - 5 * DAY, { batteryChargeLevelPercentage: 40, chargingPowerWatts: 11_000, chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING' }),
      record(NOW - 5 * DAY + 10 * 60_000, { batteryChargeLevelPercentage: 50, chargingPowerWatts: 11_000, chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING' }),
      record(NOW - DAY, { batteryChargeLevelPercentage: 60, chargingStatusV2: 'CHARGING_STATUS_V2_IDLE' }),
    ],
    'telemetry/odometer': [
      record(NOW - 6 * DAY, { odometerMeters: 122_952_704 }),
      record(NOW - 5 * DAY, { odometerMeters: 122_967_704 }),
      record(NOW - 4 * DAY, { odometerMeters: 122_987_704 }),
    ],
    'telemetry/health': [
      record(NOW - 3 * DAY, { lowVoltageBatteryWarning: 'NO_WARNING', daysToService: 313, distanceToServiceKm: 4_150 }),
      record(NOW - DAY, { lowVoltageBatteryWarning: 'LOW_VOLTAGE_BATTERY_WARNING_LOW', daysToService: 313, distanceToServiceKm: 4_150 }),
    ],
    'charging/amp-limit': [
      record(NOW - 5 * DAY, { ampLimit: { ampLimit: 20 } }),
      record(NOW - 4 * DAY, { ampLimit: { ampLimit: 7 } }),
    ],
  });
  const digest = weeklyDigest({ nowMs: NOW, units: 'km', allowLocation: true, sources });
  const lines = digest.lines;
  for (const item of ['Distance:', 'Battery:', 'Charging:', 'Warnings:', 'Settings:']) {
    assert.equal(lines.filter((line) => line.startsWith(item)).length, 1, `${item} appears exactly once`);
  }
  const lineOf = (prefix: string): string => lines.find((line) => line.startsWith(prefix))!;
  assert.match(lineOf('Distance:'), /35 km/);
  assert.match(lineOf('Distance:'), /\(last 7 days, 3 samples/);
  assert.match(lineOf('Battery:'), /charge 40% to 60%/);
  assert.match(lineOf('Charging:'), /1 session\(s\), peak 11\.0 kW/);
  assert.match(lineOf('Charging:'), /no cost recorded/);
  assert.match(lineOf('Warnings:'), /appeared: low voltage battery/);
  assert.match(lineOf('Settings:'), /1 change\(s\)/, 'the first recorded value is a baseline, not a change');
  assert.match(lines.join('\n'), /AC charge current limit 7 A/, 'the change names the new value');

  assert.equal(digest.data.empty, false);
  assert.equal(digest.data.sparse, false);
  assert.equal(digest.data.distanceMeters, 35_000);
  assert.equal(digest.data.battery?.firstSocPct, 40);
  assert.equal(digest.data.battery?.lastSocPct, 60);
  assert.equal(digest.data.charging.sessions, 1);
  assert.equal(digest.data.charging.peakPowerWatts, 11_000);
  assert.deepEqual(digest.data.warnings.added, ['low voltage battery']);
  assert.equal(digest.data.settings.samples, 2);
  assert.equal(digest.data.settings.changes.length, 1);
});

test('an empty store answers that nothing was observed, not that nothing changed', () => {
  const digest = weeklyDigest({ nowMs: NOW, units: 'km', allowLocation: true, sources: digestSources({}) });
  assert.equal(digest.data.empty, true);
  assert.equal(digest.data.totalRecords, 0);
  const text = digest.lines.join('\n');
  assert.match(text, /No history was recorded in this window/);
  assert.match(text, /not observed rather than quiet/);
  assert.match(text, /POLESTAR_SAMPLE/);
  assert.doesNotMatch(text, /nothing changed/i);
  assert.equal(digest.data.sparse, false, 'an empty store is empty, not sparse');
});

test('a sparse store is named sparse and unobserved items are not called unchanged', () => {
  const digest = weeklyDigest({
    nowMs: NOW,
    units: 'km',
    allowLocation: true,
    sources: digestSources({
      'telemetry/battery': [record(NOW - DAY, { batteryChargeLevelPercentage: 40 })],
      'telemetry/odometer': [record(NOW - DAY, { odometerMeters: 122_952_704 })],
    }),
  });
  assert.equal(digest.data.empty, false);
  assert.equal(digest.data.sparse, true);
  const text = digest.lines.join('\n');
  assert.match(text, /Sparse record: only 2 sample\(s\)/);
  assert.match(text, /unobserved, not unchanged/);
  assert.match(text, /Battery: charge 40% to 40%/);
  assert.match(text, /Distance: not reconstructed, .*at least 3 are needed/);
});

test('the digest window is the last seven days, and an older record is outside it', () => {
  const outside = weeklyDigest({
    nowMs: NOW,
    units: 'km',
    allowLocation: true,
    sources: digestSources({
      'telemetry/battery': [record(NOW - 8 * DAY, { batteryChargeLevelPercentage: 40 })],
    }),
  });
  assert.equal(outside.data.empty, true);
  assert.equal(outside.data.totalRecords, 0);

  const inside = weeklyDigest({
    nowMs: NOW,
    units: 'km',
    allowLocation: true,
    sources: digestSources({
      'telemetry/battery': [record(NOW - 6 * DAY, { batteryChargeLevelPercentage: 40 })],
    }),
  });
  assert.equal(inside.data.empty, false);
  assert.equal(inside.data.totalRecords, 1);
  assert.equal(inside.data.window.days, 7);
  assert.equal(inside.data.window.startMs, NOW - 7 * DAY);
});

test('the extra history specs are three read-only store tools with the shared arguments', async () => {
  const deps = fakeDeps();
  const specs = extraHistoryToolSpecs(deps);
  assert.deepEqual(specs.map((spec) => spec.name), [...extraHistoryToolNames], 'the names export matches the registry');
  for (const spec of specs) {
    assert.equal(spec.annotations.readOnlyHint, true, `${spec.name} is a read`);
    assert.equal(spec.annotations.openWorldHint, false, `${spec.name} reads local history, not the API`);
    assert.ok(spec.args !== undefined && 'vin' in spec.args, `${spec.name} takes a vin`);
    assert.ok(spec.args !== undefined && 'delegated_account_id' in spec.args, `${spec.name} takes a delegation`);
    assert.ok((spec.description?.length ?? 0) < 700, `${spec.name} keeps its description short`);
  }

  append(deps.store, 'telemetry', 'odometer', [
    record(NOW - 2 * HOUR, { odometerMeters: 122_952_704 }),
    record(NOW - HOUR, { odometerMeters: 122_967_704 }),
    record(NOW - 30 * 60_000, { odometerMeters: 122_987_704 }),
  ]);
  append(deps.store, 'telemetry', 'battery', [
    record(NOW - HOUR, { batteryChargeLevelPercentage: 40 }, { valueAtMs: NOW - HOUR }),
  ]);
  append(deps.store, 'telemetry', 'health', [
    record(NOW - 2 * HOUR, { lowVoltageBatteryWarning: 'NO_WARNING' }, { valueAtMs: NOW - 2 * HOUR }),
  ]);

  const digest = await toolSpec(extraHistoryToolSpecs(deps), 'get_weekly_digest').run({}, {});
  assert.notEqual(digest.isError, true);
  assert.match(digest.content[0]!.text, /^Weekly digest: last 7 days/);
  const data = digest.structuredContent?.data as { empty?: boolean; sparse?: boolean; window?: { days?: number } };
  assert.equal(data.empty, false);
  assert.equal(data.window?.days, 7);

  const emptyDigest = await toolSpec(extraHistoryToolSpecs(fakeDeps()), 'get_weekly_digest').run({}, {});
  assert.notEqual(emptyDigest.isError, true);
  assert.match(emptyDigest.content[0]!.text, /No history was recorded in this window/);
  assert.equal((emptyDigest.structuredContent?.data as { empty?: boolean }).empty, true);
});
