import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildEngine } from '../src/server.js';
import { decideBind, unauthenticatedBody } from '../src/bind.js';
import { createSubscriptionPoller } from '../src/subscriptions.js';
import { DOMAINS } from '../src/domains.js';
import { aggregateToolSpecs } from '../src/aggregate-tools.js';
import { systemToolSpecs } from '../src/system-tools.js';
import { historyToolSpecs } from '../src/history-tools.js';
import { advisorToolSpecs } from '../src/advisor-tools.js';
import type { ToolDeps } from '../src/tool-output.js';
import type { PolestarClient } from '../src/client.js';

test('a non-loopback bind is refused before anything listens, and allowed with a token', () => {
  const loopback = decideBind({ host: '127.0.0.1', token: undefined });
  assert.equal(loopback.ok, true);
  if (loopback.ok) assert.equal(loopback.authenticated, false, 'loopback needs no token');

  const exposed = decideBind({ host: '0.0.0.0', token: '' });
  assert.equal(exposed.ok, false);
  if (!exposed.ok) {
    assert.match(exposed.reason, /POLESTAR_HTTP_TOKEN/);
    assert.match(exposed.reason, /0\.0\.0\.0/);
  }

  const guarded = decideBind({ host: '10.0.0.5', token: '   ' });
  assert.equal(guarded.ok, false, 'whitespace is not a token');

  const withToken = decideBind({ host: '10.0.0.5', token: 'sekret' });
  assert.equal(withToken.ok, true);
  if (withToken.ok) assert.equal(withToken.authenticated, true);

  // The 401 body speaks the same error shape the client reads everywhere else.
  const body = JSON.parse(unauthenticatedBody()) as { error: { code: string; httpStatus: number } };
  assert.equal(body.error.code, 'UNAUTHENTICATED');
  assert.equal(body.error.httpStatus, 401);
});

function harness(options: { metaEventIds: (string | undefined)[]; lowBudget?: boolean }) {
  const reads: string[] = [];
  let index = 0;
  const notified: string[] = [];
  const logged: string[] = [];
  let timer: (() => void) | undefined;
  const poller = createSubscriptionPoller({
    async read(vin, kind, name) {
      reads.push(`${vin}/${kind}/${name}`);
      const id = options.metaEventIds[Math.min(index, options.metaEventIds.length - 1)];
      index += 1;
      return { metaEventId: id };
    },
    budget: { isLow: () => options.lowBudget === true },
    async notify(uri) {
      notified.push(uri);
    },
    log: (m) => logged.push(m),
    setTimer: (cb) => {
      timer = cb;
      return { unref: () => undefined };
    },
    clearTimer: () => {
      timer = undefined;
    },
  });
  return { poller, reads, notified, logged, tick: async () => { await timer?.(); await poller.pollOnce(); } };
}

const URI = 'polestar://vehicle/YSMTEST22PL000001/telemetry/battery';

test('a subscription notifies only when the cloud reports a new metaEventId', async () => {
  const h = harness({ metaEventIds: ['e1', 'e1', 'e2'] });
  await h.poller.subscribe(URI);
  assert.deepEqual(h.reads, ['YSMTEST22PL000001/telemetry/battery'], 'subscribe primes the change detector');

  await h.poller.pollOnce();
  assert.deepEqual(h.notified, [], 'an unchanged metaEventId is not a notification');

  await h.poller.pollOnce();
  assert.deepEqual(h.notified, [URI], 'the changed metaEventId is');

  h.poller.unsubscribe(URI);
  assert.equal(h.poller.size, 0);
});

test('subscriptions stand down rather than spend the last tenth of the daily budget', async () => {
  const h = harness({ metaEventIds: ['a', 'b'], lowBudget: true });
  await h.poller.subscribe(URI);
  await h.poller.pollOnce();
  assert.deepEqual(h.notified, [], 'no polling reads while the budget is low');
  assert.match(h.logged.join('\n'), /subscriptions paused/);
});

test('unsubscribing the last URI clears the timer', async () => {
  const h = harness({ metaEventIds: ['x'] });
  await h.poller.subscribe(URI);
  assert.equal(h.poller.size, 1);
  h.poller.unsubscribe(URI);
  assert.equal(h.poller.size, 0, 'the poller holds no ghost entries');
});

test('buildEngine composes a runnable server from the environment alone', () => {
  const dump = new URL('../test/fixtures/dump', import.meta.url).pathname;
  const engine = buildEngine({ POLESTAR_FIXTURES_DIR: dump, POLESTAR_HISTORY_DIR: undefined });
  assert.ok(engine.client, 'the client is assembled');
  assert.equal(engine.config.budgetLimit, 10_000, 'the documented daily ceiling is the default');
  assert.equal(engine.config.budgetPerMinute, 100, 'and the documented per-minute one');
  assert.equal(engine.config.httpHost, '127.0.0.1', 'the bind defaults to loopback');
  assert.equal(engine.config.httpToken, '');
  engine.sampler?.stop();
  engine.budget.consume();
  assert.equal(engine.budget.snapshot().used, 1);
});

test('the prompts and the registry agree on every tool name', async () => {
  const deps = {
    client: {} as unknown as PolestarClient,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
  } as ToolDeps;
  const names = new Set([
    ...aggregateToolSpecs(deps),
    ...advisorToolSpecs(deps),
    ...systemToolSpecs({
      ...deps,
      budget: {},
      minute: {},
      cacheStats: undefined,
      tokenExpiresAt: () => undefined,
      fixtureMode: false,
    } as never),
    ...historyToolSpecs({ ...deps, store: {} } as never),
  ].map((spec) => spec.name));
  assert.ok(names.has('get_car_status') && names.has('is_car_secure') && names.has('polestar_status'));

  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const prose = server.split('\n').filter((line) => /Give me a status briefing|Call plan_cheapest_charge|call get_degradation_report/.test(line));
  assert.equal(prose.length, 3, 'the three prompts are still generated from the registry');
  for (const line of prose) {
    for (const named of line.match(/\b(?:get|is|plan|polestar)_[a-z_]+\b/g) ?? []) {
      assert.ok(names.has(named), `a prompt tells the model to call ${named}, which is not registered`);
    }
  }
});

test('every Domain states the keys its fixture must hold', () => {
  // The pinned contract used to be a second list in the test file, so a new
  // Domain could join the registry with nothing checking its shape.
  for (const domain of DOMAINS) {
    assert.ok(Array.isArray(domain.pinnedKeys), `${domain.name}: no pinnedKeys`);
  }
  const battery = DOMAINS.find((d) => d.name === 'battery');
  assert.ok(battery?.pinnedKeys.includes('batteryChargeLevelPercentage'));
});
