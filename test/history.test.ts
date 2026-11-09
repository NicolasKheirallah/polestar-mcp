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

// M7 / S3 / S9 coverage. These were written before the implementation so the
// pre-fix failures are recorded in the task report.

import { readFileSync } from 'node:fs';
import { toolSpec } from '../src/tools.js';
import { historyToolSpecs, renderHistorySample } from '../src/history-tools.js';
import type { ToolDeps } from '../src/tool-output.js';

const VIN = 'VINX';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'polestar-history-'));
}

function historyDeps(store: HistoryStore, nowMs = Date.parse('2026-01-01T12:00:00Z')): Parameters<typeof historyToolSpecs>[0] {
  const client = {
    async resolveVin(v?: string) { return v ?? VIN; },
    async vehicles() { return [VIN]; },
    async domain() { return null; },
    forDelegation() { return this; },
  };
  const deps = { client, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km', nowMs: () => nowMs, store } as unknown as ToolDeps;
  return { ...deps, store };
}

async function callHistory(
  store: HistoryStore,
  name: 'get_history' | 'get_degradation_report' | 'get_charging_sessions',
  args: Record<string, unknown> = {},
  nowMs?: number,
) {
  const specs = historyToolSpecs(historyDeps(store, nowMs));
  return toolSpec(specs, name).run(args, {});
}

function textOf(result: { content: { text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

test('get_history renders each domain instead of an empty object', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    store.append(VIN, 'charging', 'amp-limit', {
      observedAt: 1_700_000_000_000,
      metaEventId: 'amp-1',
      data: { ampLimit: { ampLimit: 20, source: 'RCS' }, pendingAmpLimit: { ampLimit: 7 }, metaReceivedAt: '2026-01-01T00:00:00.000Z' },
    });
    const result = await callHistory(store, 'get_history', { domain: 'charging/amp-limit' });
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /"ampLimit":20/, 'an amp limit sample must render its value, not {}');
    assert.doesNotMatch(textOf(result), /\{\}/, 'the empty-object rendering is the defect M7 fixes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrendered domain falls back to every payload key', () => {
  const rendered = renderHistorySample('telemetry', 'no-such-domain', { alpha: 1, beta: 'two', gamma: { nested: true } });
  assert.deepEqual(rendered, { alpha: 1, beta: 'two', gamma: { nested: true } });
});

test('the degradation report answers instead of throwing when no sample is usable', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      store.append(VIN, 'telemetry', 'battery', {
        observedAt: t0 + i * 86_400_000,
        metaEventId: `low-${i}`,
        data: { batteryChargeLevelPercentage: 3, estimatedDistanceToEmptyKm: 10 },
      });
    }
    const result = await callHistory(store, 'get_degradation_report', {}, t0 + 10 * 86_400_000);
    assert.equal(result.isError, undefined, 'a low-SoC store must be a sentence, not INTERNAL_ERROR');
    assert.match(textOf(result), /no usable|not enough|no degradation signal|too low/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the degradation report refuses a span shorter than a week and explains why', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      store.append(VIN, 'telemetry', 'battery', {
        observedAt: t0 + i * 86_400_000,
        metaEventId: `short-${i}`,
        data: { batteryChargeLevelPercentage: 50, estimatedDistanceToEmptyKm: 170 - i },
      });
    }
    const result = await callHistory(store, 'get_degradation_report', {}, t0 + 10 * 86_400_000);
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /span/i);
    assert.match(textOf(result), /7 days/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the degradation report still reports a trend when the span is long enough', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 6; i++) {
      store.append(VIN, 'telemetry', 'battery', {
        observedAt: t0 + i * 8 * 86_400_000,
        metaEventId: `long-${i}`,
        data: { batteryChargeLevelPercentage: 50, estimatedDistanceToEmptyKm: 170 - i },
      });
    }
    const result = await callHistory(store, 'get_degradation_report', {}, t0 + 60 * 86_400_000);
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /Implied full-charge range/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session output calls the recorded interval a span, not a duration', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const min = 60_000;
    for (let i = 0; i < 2; i++) {
      store.append(VIN, 'telemetry', 'battery', {
        observedAt: 1_700_000_000_000 + i * 29 * min,
        metaEventId: `charge-${i}`,
        data: { chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING', chargingPowerWatts: 7000, batteryChargeLevelPercentage: 40 + i },
      });
    }
    const result = await callHistory(store, 'get_charging_sessions', {}, 1_700_000_000_000 + 3_600_000);
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /span/i, 'activeSeconds is a span including gaps and must be labelled as one');
    assert.doesNotMatch(textOf(result), / min · peak/, 'the old output called the span a bare duration');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session output does not invent peak power or a span for a single sample', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    store.append(VIN, 'telemetry', 'battery', {
      observedAt: 1_700_000_000_000,
      metaEventId: 'charge-one',
      data: { chargingStatusV2: 'CHARGING_STATUS_V2_CHARGING' },
    });
    const result = await callHistory(store, 'get_charging_sessions', {}, 1_700_000_000_000 + 3_600_000);
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /peak unknown/i);
    assert.match(textOf(result), /single sample|no span/i);
    assert.doesNotMatch(textOf(result), /peak 0\.0 kW/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_history dates a record by the value clock when the recorder stored one', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const readMs = Date.parse('2026-11-09T12:00:00Z');
    const valueMs = Date.parse('2026-09-18T11:00:00Z');
    store.append(VIN, 'telemetry', 'battery', {
      observedAt: readMs - 60_000,
      valueObservedAt: valueMs,
      metaEventId: 'clock-1',
      data: { batteryChargeLevelPercentage: 52, estimatedDistanceToEmptyKm: 170 },
    });
    const result = await callHistory(store, 'get_history', { domain: 'telemetry/battery' }, readMs);
    const line = textOf(result).split('\n')[0]!;
    assert.match(line, /^2026-09-18T11:00:00\.000Z /, 'the vehicle clock is what the sample is');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an old record without a value clock still renders by its read clock', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const readMs = Date.parse('2026-11-09T12:00:00Z');
    store.append(VIN, 'telemetry', 'battery', {
      observedAt: readMs - 60_000,
      metaEventId: 'old-1',
      data: { batteryChargeLevelPercentage: 52 },
    });
    const result = await callHistory(store, 'get_history', { domain: 'telemetry/battery' }, readMs);
    assert.match(textOf(result).split('\n')[0]!, /^2026-11-09T11:59:00\.000Z /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_history pages with limit, offset and before, and marks truncation', async () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) {
      store.append(VIN, 'telemetry', 'battery', {
        observedAt: t0 + i * 60_000,
        metaEventId: `page-${i}`,
        data: { batteryChargeLevelPercentage: 40 + i },
      });
    }
    const first = await callHistory(store, 'get_history', { domain: 'telemetry/battery', limit: 2 }, t0 + 3_600_000);
    const firstLines = textOf(first).trim().split('\n');
    assert.equal(firstLines.length, 3, 'two records plus a visible more-available marker');
    assert.match(textOf(first), /more records|offset=2|before=/i);

    const second = await callHistory(store, 'get_history', { domain: 'telemetry/battery', limit: 2, offset: 2 }, t0 + 3_600_000);
    assert.equal(second.content[0]!.text!.trim().split('\n').length, 1);
    assert.doesNotMatch(textOf(second), /more records/i);

    const before = await callHistory(store, 'get_history', { domain: 'telemetry/battery', before: new Date(t0 + 60_000).toISOString() }, t0 + 3_600_000);
    assert.equal(before.content[0]!.text!.trim().split('\n').length, 1, 'before is exclusive on the displayed clock');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store prunes the oldest records when a file exceeds its bound', () => {
  const dir = tempDir();
  try {
    const store = new HistoryStore(dir, 2000);
    for (let i = 0; i < 40; i++) {
      store.append(VIN, 'telemetry', 'battery', {
        observedAt: 1_700_000_000_000 + i * 60_000,
        metaEventId: `prune-${i}`,
        data: { batteryChargeLevelPercentage: i, filler: 'x'.repeat(40) },
      });
    }
    const file = path.join(dir, VIN, 'telemetry-battery.jsonl');
    const kept = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    assert.ok(kept.length < 40, `the file must have pruned, kept ${kept.length} of 40`);
    assert.ok(kept.length >= 8, `the newest half must survive, not a single line (kept ${kept.length})`);
    assert.ok(kept.length > 0, 'the newest records survive');
    const newest = JSON.parse(kept[kept.length - 1]!) as { data: { batteryChargeLevelPercentage: number } };
    assert.equal(newest.data.batteryChargeLevelPercentage, 39, 'pruning drops the oldest records, never the newest');
    const records = store.query(VIN, 'telemetry', 'battery');
    assert.equal(records[0]!.metaEventId, 'prune-39');
    store.append(VIN, 'telemetry', 'battery', {
      observedAt: 1_700_000_000_000 + 40 * 60_000,
      metaEventId: 'prune-39',
      data: { batteryChargeLevelPercentage: 39 },
    });
    assert.equal(store.query(VIN, 'telemetry', 'battery').filter((r) => r.metaEventId === 'prune-39').length, 1, 'dedupe still holds after pruning');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('linearTrend fits a slope with an interval and refuses a flat series as a trend', async () => {
  const { linearTrend } = await import('../src/history.js');
  const falling = Array.from({ length: 12 }, (_, i) => ({ x: i * 30, y: 340 - 2 * i * 30 }));
  const trend = linearTrend(falling)!;
  assert.ok(Math.abs(trend.slopePerMonth + 60.88) < 0.05, `monthly slope ${trend.slopePerMonth}`);
  assert.equal(trend.excludesZero, true);
  const flat = linearTrend(Array.from({ length: 12 }, (_, i) => ({ x: i * 30, y: 340 })))!;
  assert.equal(flat.slopePerMonth, 0);
  assert.equal(flat.excludesZero, false, 'a flat series must not be called a trend');
  assert.equal(linearTrend([{ x: 0, y: 1 }, { x: 1, y: 2 }]), undefined, 'two points have no residual degrees of freedom');
});

test('odometerRate treats a backward odometer as a reset and ignores zero elapsed time', async () => {
  const { odometerRate } = await import('../src/history.js');
  const rate = odometerRate([
    { observedAt: 0, metaEventId: undefined, data: { odometerMeters: 1_000_000 } },
    { observedAt: 7 * 86_400_000, metaEventId: undefined, data: { odometerMeters: 1_350_000 } },
    { observedAt: 14 * 86_400_000, metaEventId: undefined, data: { odometerMeters: 1_700_000 } },
    { observedAt: 15 * 86_400_000, metaEventId: undefined, data: { odometerMeters: 500 } },
    { observedAt: 15 * 86_400_000, metaEventId: undefined, data: { odometerMeters: 2_700_000 } },
  ]);
  assert.equal(rate.resets, 1);
  assert.equal(rate.samples, 5);
  assert.ok(rate.kmPerDay !== undefined && Math.abs(rate.kmPerDay - 50) < 0.01, `rate ${rate.kmPerDay}`);
});
