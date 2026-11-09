import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BudgetExceededError, BudgetLedgerError, BudgetMeter, type BudgetLedgerOptions } from '../src/budget.js';
import { InvalidConfigError, KNOWN_ENV_VARIABLES, loadConfig, unknownEnvVariables } from '../src/config.js';

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0); // fixed clock: 2026-11-09T12:00:00Z
const DAY1_START = Date.UTC(2026, 10, 9);
const DAY2_START = Date.UTC(2026, 10, 10);

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'polestar-ledger-'));
}

function ledgerIn(dir: string, identity: { clientId: string; accountId: string } = { clientId: 'client-1', accountId: 'account-1' }): BudgetLedgerOptions {
  return { path: path.join(dir, 'budget.json'), ...identity };
}

function identityHash(clientId: string, accountId: string): string {
  return createHash('sha256').update(clientId).update('\u0000').update(accountId).digest('hex');
}

function expectLedgerError(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (err: unknown) => {
    assert.ok(err instanceof BudgetLedgerError, `expected BudgetLedgerError, got ${String(err)}`);
    assert.match(err.message, /Budget ledger/);
    assert.match(err.message, pattern);
    return true;
  });
}

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('POLESTAR_BUDGET_LEDGER is a known variable and loads as an absolute file path', () => {
  const dir = scratch();
  try {
    assert.ok(KNOWN_ENV_VARIABLES.includes('POLESTAR_BUDGET_LEDGER'), 'the status and strict-env paths read the registry');
    assert.deepEqual(unknownEnvVariables({ POLESTAR_BUDGET_LEDGER: path.join(dir, 'budget.json') }), [], 'a known name is not a typo');
    const ledger = path.join(dir, 'budget.json');

    const config = loadConfig({ POLESTAR_FIXTURES_DIR: dir, POLESTAR_BUDGET_LEDGER: ledger });
    assert.equal(config.budgetLedgerPath, ledger);
    assert.equal(loadConfig({ POLESTAR_FIXTURES_DIR: dir }).budgetLedgerPath, undefined, 'unset means the in-memory meter');
    assert.equal(loadConfig({ POLESTAR_FIXTURES_DIR: dir, POLESTAR_BUDGET_LEDGER: '   ' }).budgetLedgerPath, undefined, 'blank means unset');

    // A file that already exists is fine, and its path is normalized.
    writeFileSync(ledger, '{}\n');
    const existing = loadConfig({ POLESTAR_FIXTURES_DIR: dir, POLESTAR_BUDGET_LEDGER: `${dir}//./budget.json` });
    assert.equal(existing.budgetLedgerPath, ledger);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger path is rejected when it cannot name one shared file', () => {
  const dir = scratch();
  try {
    const env = { POLESTAR_FIXTURES_DIR: dir };
    const rejects = (value: string, pattern: RegExp): void => {
      assert.throws(
        () => loadConfig({ ...env, POLESTAR_BUDGET_LEDGER: value }),
        (err: unknown) => {
          assert.ok(err instanceof InvalidConfigError);
          assert.match(err.message, /POLESTAR_BUDGET_LEDGER/);
          assert.match(err.message, pattern);
          return true;
        },
      );
    };

    rejects('budget.json', /absolute path/);
    rejects('~/budget.json', /not expand|tilde/i);
    rejects(path.join(dir, 'missing', 'budget.json'), /does not exist/);
    rejects('\u0000bad', /NUL|invalid/i);
    mkdirSync(path.join(dir, 'is-a-directory'));
    rejects(path.join(dir, 'is-a-directory'), /directory/);
    writeFileSync(path.join(dir, 'plain'), 'x');
    rejects(path.join(dir, 'plain', 'budget.json'), /not a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing ledger starts at zero and the first consume creates it', () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    const meter = new BudgetMeter(10, { now: () => T0, ledger });
    assert.equal(meter.snapshot().used, 0);
    assert.equal(readdirSync(dir).includes('budget.json'), false, 'constructing does not write');
    meter.consume();
    assert.deepEqual(readdirSync(dir), ['budget.json']);
    const parsed = JSON.parse(readFileSync(ledger.path, 'utf8')) as {
      version: number;
      identities: Record<string, { windowStartUtc: string; used: number }>;
    };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.identities[identityHash('client-1', 'account-1')]?.used, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two meters, as after a restart, share one daily count and one refusal', () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    const now = T0;
    const first = new BudgetMeter(10, { now: () => now, ledger });
    for (let i = 0; i < 6; i += 1) first.consume();

    const second = new BudgetMeter(10, { now: () => now, ledger });
    assert.equal(second.snapshot().used, 6, 'a new meter loads the persisted count instead of starting at zero');

    for (let i = 0; i < 4; i += 1) second.consume();
    assert.deepEqual(
      { used: second.snapshot().used, remaining: second.snapshot().remaining },
      { used: 10, remaining: 0 },
      'the shared count reaches the limit after ten calls in total',
    );

    assert.throws(() => second.consume(), (err: unknown) => err instanceof BudgetExceededError);
    assert.throws(() => first.consume(), BudgetExceededError, 'the meter that made ten calls is refused too');
    assert.equal(first.snapshot().used, 10, 'and it sees the other meter calls, not only its own six');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger stores a hash of the identity, never the identifiers', () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir, { clientId: 'private-client-id', accountId: 'private-account-id' });
    new BudgetMeter(10, { now: () => T0, ledger }).consume();
    const text = readFileSync(ledger.path, 'utf8');
    const hash = identityHash('private-client-id', 'private-account-id');
    const parsed = JSON.parse(text) as { identities: Record<string, { windowStartUtc: string; used: number }> };
    assert.deepEqual(Object.keys(parsed.identities), [hash], 'keyed by SHA-256 only');
    assert.equal(parsed.identities[hash]?.windowStartUtc, new Date(DAY1_START).toISOString(), 'the window is the UTC day start');
    assert.equal(parsed.identities[hash]?.used, 1);
    assert.equal(text.includes('private-client-id'), false, 'the ledger must not hold a credential identifier');
    assert.equal(text.includes('private-account-id'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two identities in one ledger keep separate counts', () => {
  const dir = scratch();
  try {
    const sharedPath = path.join(dir, 'budget.json');
    const a = new BudgetMeter(5, { now: () => T0, ledger: { path: sharedPath, clientId: 'client-a', accountId: 'account' } });
    const b = new BudgetMeter(5, { now: () => T0, ledger: { path: sharedPath, clientId: 'client-b', accountId: 'account' } });
    a.consume();
    a.consume();
    b.consume();
    assert.equal(a.snapshot().used, 2);
    assert.equal(b.snapshot().used, 1);
    const parsed = JSON.parse(readFileSync(sharedPath, 'utf8')) as { identities: Record<string, { used: number }> };
    assert.equal(Object.keys(parsed.identities).length, 2, 'one file, one entry per identity hash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a UTC day rollover resets the persisted count instead of carrying it over', () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    let now = Date.UTC(2026, 10, 9, 23, 30);
    const before = new BudgetMeter(10, { now: () => now, ledger });
    before.consume();
    before.consume();
    before.consume();
    assert.equal(before.snapshot().used, 3);

    now = Date.UTC(2026, 10, 10, 0, 5); // new UTC day
    assert.equal(before.snapshot().used, 0, 'the running meter resets at the boundary');

    const after = new BudgetMeter(10, { now: () => now, ledger });
    assert.equal(after.snapshot().used, 0, 'a meter started after the boundary resets too');
    assert.equal(after.snapshot().resetsAtUtc, new Date(Date.UTC(2026, 10, 11)).toISOString());

    after.consume();
    const parsed = JSON.parse(readFileSync(ledger.path, 'utf8')) as {
      identities: Record<string, { windowStartUtc: string; used: number }>;
    };
    const entry = parsed.identities[identityHash('client-1', 'account-1')];
    assert.equal(entry?.used, 1, 'the new day is written over the old window');
    assert.equal(entry?.windowStartUtc, new Date(DAY2_START).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger file is written mode 0600 and leaves no temp file behind', { skip: process.platform === 'win32' }, () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    // A pre-existing world-readable file is replaced, not updated in place, so its
    // permissions must tighten too; rename replaces the inode.
    writeFileSync(ledger.path, JSON.stringify({ version: 1, identities: {} }));
    chmodSync(ledger.path, 0o644);
    const meter = new BudgetMeter(10, { now: () => T0, ledger });
    meter.consume();
    meter.consume();
    assert.equal(statSync(ledger.path).mode & 0o777, 0o600, 'only the owner may read the counts');
    assert.deepEqual(readdirSync(dir), ['budget.json'], 'the rename landed and the temp file is gone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty identities ledger is a valid first run, not corruption', () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    writeFileSync(ledger.path, JSON.stringify({ version: 1, identities: {} }));
    const meter = new BudgetMeter(10, { now: () => T0, ledger });
    assert.equal(meter.snapshot().used, 0);
    meter.consume();
    assert.equal(meter.snapshot().used, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable or corrupt ledger fails closed instead of starting at zero', () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    const hash = identityHash('client-1', 'account-1');
    const corruptions: Array<[string, string]> = [
      ['not JSON', '{'],
      ['wrong version', JSON.stringify({ version: 2, identities: {} })],
      ['identities missing', JSON.stringify({ version: 1 })],
      ['window not a UTC day start', JSON.stringify({ version: 1, identities: { [hash]: { windowStartUtc: '2026-11-09T12:00:00.000Z', used: 1 } } })],
      ['window not a date', JSON.stringify({ version: 1, identities: { [hash]: { windowStartUtc: 'yesterday', used: 1 } } })],
      ['negative used', JSON.stringify({ version: 1, identities: { [hash]: { windowStartUtc: new Date(DAY1_START).toISOString(), used: -1 } } })],
      ['fractional used', JSON.stringify({ version: 1, identities: { [hash]: { windowStartUtc: new Date(DAY1_START).toISOString(), used: 1.5 } } })],
      ['used not a number', JSON.stringify({ version: 1, identities: { [hash]: { windowStartUtc: new Date(DAY1_START).toISOString(), used: '3' } } })],
    ];
    for (const [label, body] of corruptions) {
      writeFileSync(ledger.path, body);
      expectLedgerError(() => new BudgetMeter(10, { now: () => T0, ledger }), /Refusing to run/);
      assert.equal(readFileSync(ledger.path, 'utf8'), body, `${label}: the bad file is left for the operator to inspect`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable ledger fails closed at startup', { skip: process.platform === 'win32' || asRoot }, () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    writeFileSync(ledger.path, JSON.stringify({ version: 1, identities: {} }));
    chmodSync(ledger.path, 0o000);
    try {
      expectLedgerError(() => new BudgetMeter(10, { now: () => T0, ledger }), /Refusing to run/);
    } finally {
      chmodSync(ledger.path, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ledger that becomes corrupt mid-run refuses the call', () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    const meter = new BudgetMeter(10, { now: () => T0, ledger });
    meter.consume();
    writeFileSync(ledger.path, 'not json');
    expectLedgerError(() => meter.consume(), /Refusing to run/);
    expectLedgerError(() => meter.snapshot(), /Refusing to run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ledger entry from a later UTC day fails closed rather than trusting a backwards clock', () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    const hash = identityHash('client-1', 'account-1');
    writeFileSync(
      ledger.path,
      JSON.stringify({ version: 1, identities: { [hash]: { windowStartUtc: new Date(DAY2_START).toISOString(), used: 4 } } }),
    );
    expectLedgerError(() => new BudgetMeter(10, { now: () => T0, ledger }), /later than the current UTC day/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a write failure refuses the call instead of spending quota it cannot count', { skip: process.platform === 'win32' || asRoot }, () => {
  const dir = scratch();
  try {
    const ledger = ledgerIn(dir);
    const meter = new BudgetMeter(10, { now: () => T0, ledger });
    chmodSync(dir, 0o500); // readable, not writable: the temp file cannot be created
    try {
      expectLedgerError(() => meter.consume(), /Refusing to spend/);
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal(meter.snapshot().used, 0, 'the refused call did not count');
    meter.consume();
    assert.equal(meter.snapshot().used, 1, 'a later call works once the file is writable again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory named as the ledger fails closed', () => {
  const dir = scratch();
  try {
    const target = path.join(dir, 'budget.json');
    mkdirSync(target);
    expectLedgerError(() => new BudgetMeter(10, { now: () => T0, ledger: { ...ledgerIn(dir), path: target } }), /cannot be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain clock argument still builds an in-memory meter with no file', () => {
  // Every existing call site passes the clock as the second argument; the ledger
  // is opt-in and must not appear as a side effect of that shape.
  const dir = scratch();
  try {
    const meter = new BudgetMeter(3, () => T0);
    meter.consume();
    meter.consume();
    meter.consume();
    assert.throws(() => meter.consume(), BudgetExceededError);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
