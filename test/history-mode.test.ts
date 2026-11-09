import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HistoryStore } from '../src/history.js';

const VIN = 'YSMTEST22PL000001';
const mode = (file: string): string => (statSync(file).mode & 0o777).toString(8);

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'polestar-history-mode-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('history files are 0600 and per-vehicle directories 0700 on creation', () => {
  withDir((dir) => {
    const store = new HistoryStore(dir);
    store.append(VIN, 'telemetry', 'battery', { observedAt: Date.now(), data: { batteryChargeLevelPercentage: 50 } });
    assert.equal(mode(path.join(dir, VIN, 'telemetry-battery.jsonl')), '600');
    assert.equal(mode(path.join(dir, VIN)), '700');
  });
});

test('an existing loose file is tightened on the next append', () => {
  withDir((dir) => {
    const store = new HistoryStore(dir);
    const file = path.join(dir, VIN, 'telemetry-battery.jsonl');
    store.append(VIN, 'telemetry', 'battery', { observedAt: Date.now(), data: { batteryChargeLevelPercentage: 50 } });
    chmodSync(file, 0o644);
    assert.equal(mode(file), '644');
    store.append(VIN, 'telemetry', 'battery', {
      observedAt: Date.now(),
      metaEventId: 'second',
      data: { batteryChargeLevelPercentage: 51 },
    });
    assert.equal(mode(file), '600');
  });
});

test('the retention rewrite keeps the file at 0600', () => {
  withDir((dir) => {
    const store = new HistoryStore(dir, 400);
    const file = path.join(dir, VIN, 'telemetry-battery.jsonl');
    for (let i = 0; i < 20; i += 1) {
      store.append(VIN, 'telemetry', 'battery', {
        observedAt: Date.now() + i,
        metaEventId: `event-${i}`,
        data: { batteryChargeLevelPercentage: 40 + i, padding: 'x'.repeat(120) },
      });
      assert.equal(mode(file), '600', `append ${i} kept the file owner-only`);
    }
  });
});
