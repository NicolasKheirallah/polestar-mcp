import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildEngine, createMcpServer } from '../src/server.js';
import { HistorySampler } from '../src/sampler.js';
import { BudgetMeter } from '../src/budget.js';
import { decideBind, unauthenticatedBody } from '../src/bind.js';
import { createSubscriptionPoller } from '../src/subscriptions.js';
import { DOMAINS } from '../src/domains.js';
import { aggregateToolSpecs } from '../src/aggregate-tools.js';
import { systemToolSpecs } from '../src/system-tools.js';
import { toolSpec } from '../src/tools.js';
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

test('a stopped poller stops the clock and forgets its target', async () => {
  // `stop()` used to clear the timer only, leaving the map behind. A surface that
  // had closed then still reported one subscription, which is how a finished HTTP
  // request could look like it was still polling.
  const h = harness({ metaEventIds: ['e1'] });
  await h.poller.subscribe(URI);
  assert.equal(h.poller.size, 1);

  h.poller.stop();
  assert.equal(h.poller.size, 0, 'nothing is left to poll');
  await h.tick();
  assert.deepEqual(h.notified, [], 'and the round never runs');

  h.poller.stop();
  assert.equal(h.poller.size, 0, 'stopping twice is not an error');
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

test('a surface owns the poller it starts, and close stops it', async () => {
  // The poller used to be created inside the resource registration and pushed
  // into a module-level array, so a surface could not say how much background
  // work it was responsible for, and the HTTP teardown closed the transport and
  // the server but never the poller it had just created: a stateless deployment
  // kept one per request until a signal arrived.
  const dump = new URL('../test/fixtures/dump', import.meta.url).pathname;
  const engine = buildEngine({ POLESTAR_FIXTURES_DIR: dump, POLESTAR_HISTORY_DIR: undefined });

  const timers: Array<() => void> = [];
  const surface = createMcpServer(engine, {
    pollerClock: {
      setTimer: (callback: () => void) => {
        timers.push(callback);
        return {};
      },
      clearTimer: () => {
        timers.length = 0;
      },
    },
  });

  assert.equal(surface.subscriptions, 0);
  assert.equal(timers.length, 0, 'a surface nobody subscribed to polls nothing');

  await surface.subscribe(URI);
  assert.equal(surface.subscriptions, 1);
  assert.equal(timers.length, 1, 'subscribing is what starts the clock');

  surface.unsubscribe(URI);
  assert.equal(surface.subscriptions, 0);
  assert.equal(timers.length, 0, 'the last unsubscribe stops it');

  await surface.subscribe(URI);
  assert.equal(timers.length, 1);
  await surface.close();
  assert.equal(surface.subscriptions, 0, 'a closed surface holds no subscriptions');
  assert.equal(timers.length, 0, 'and stopped the poller it had created');
  await surface.close();
  assert.equal(timers.length, 0, 'closing twice is not an error');
});

test('polestar_status prints what the sampler says, and nothing when there is no sampler', async () => {
  // The tool asks the sampler rather than being handed a sentence built from the
  // environment, so the line can only be as wrong as the sampler is. History off
  // means no sampler at all, and then the whole line has to disappear.
  const base = {
    client: {} as unknown as PolestarClient,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km' as const,
    budget: { snapshot: () => ({ used: 0, limit: 10_000, remaining: 10_000, fractionUsed: 0, resetsAtUtc: 'soon' }) },
    minute: { snapshot: () => ({ used: 0, limit: 100 }) },
    cacheStats: { enabled: true, hits: 0, staleServed: 0, misses: 0, refreshes: 0, entries: 0 },
    tokenExpiresAt: () => undefined,
    fixtureMode: true,
  };
  // A sleep that never resolves: the sampler is started but no round ever runs.
  const never = (): Promise<void> => new Promise<void>(() => undefined);
  const sampler = new HistorySampler(
    { vehicles: async () => [] } as unknown as PolestarClient,
    new BudgetMeter(10_000),
    async () => undefined,
    { intervalSeconds: 900, sleep: never },
  );

  const off = await toolSpec(systemToolSpecs({ ...base, sampler } as never), 'polestar_status').run({}, {});
  assert.match(off.content[0]!.text, /Background sampling: off, history records only/);

  await sampler.start();
  const on = await toolSpec(systemToolSpecs({ ...base, sampler } as never), 'polestar_status').run({}, {});
  assert.match(on.content[0]!.text, /Background sampling: on, but this credential reports no vehicle to sample/);

  const without = await toolSpec(systemToolSpecs(base as never), 'polestar_status').run({}, {});
  assert.doesNotMatch(without.content[0]!.text, /Background sampling/, 'no sampler, no line');
});

test('polestar_status reports the budget arithmetic, the hit rate and the token clock', async () => {
  // Four snapshots concatenated, and only the tool's name was ever asserted. The
  // hit rate is arithmetic on three counters, the reset time is the budget's, and
  // the expiry is a subtraction against a clock, so each of them can be wrong on
  // its own.
  const nowMs = Date.parse('2026-01-01T12:00:00Z');
  const deps = {
    client: {} as unknown as PolestarClient,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km' as const,
    budget: { snapshot: () => ({ used: 2_500, limit: 10_000, remaining: 7_500, fractionUsed: 0.25, resetsAtUtc: '2026-01-02T00:00:00Z' }) },
    minute: { snapshot: () => ({ used: 12, limit: 100 }) },
    cacheStats: { enabled: true, hits: 6, staleServed: 2, misses: 2, refreshes: 1, entries: 4 },
    tokenExpiresAt: () => nowMs + 12 * 60_000,
    fixtureMode: false,
    nowMs: () => nowMs,
  };
  const report = async (over: Record<string, unknown> = {}): Promise<string> =>
    (await toolSpec(systemToolSpecs({ ...deps, ...over } as never), 'polestar_status').run({}, {})).content[0]!.text;

  const text = await report();
  assert.match(text, /Mode: live/);
  assert.match(text, /API budget: 2500\/10000 used \(7500 left\), resets 2026-01-02T00:00:00Z/);
  assert.match(text, /Per-minute ceiling: 12\/100 used in this minute/);
  // 6 hits plus 2 stale-served out of 10 reads.
  assert.match(text, /Cache: 6 hits \+ 2 stale-served of 10 reads \(80%\), 2 live misses, 1 refreshes, 4 entries/);
  assert.match(text, /Token: trusted ~12 more min/);

  // No reads yet is a rate of zero, not a division by zero.
  const cold = await report({ cacheStats: { enabled: true, hits: 0, staleServed: 0, misses: 0, refreshes: 0, entries: 0 } });
  assert.match(cold, /of 0 reads \(0%\)/, 'a cold cache reads as zero percent rather than NaN');

  // An expired-but-unspent budget is still worth naming, and a cache that is off
  // says so instead of printing counters no read can move.
  assert.match(await report({ tokenExpiresAt: () => undefined }), /Token: not yet issued/);
  const off = await report({ cacheStats: { enabled: false, hits: 0, staleServed: 0, misses: 0, refreshes: 0, entries: 0 } });
  assert.match(off, /Cache: off \(POLESTAR_CACHE_DISABLED/);
  assert.doesNotMatch(off, /stale-served/, 'an off cache prints no hit rate');
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
      cacheStats: { enabled: true, hits: 0, staleServed: 0, misses: 0, refreshes: 0, entries: 0 },
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

test('the security verdict and the status count answer from one exterior rule', async () => {
  // get_car_status asks "is anything open" and is_car_secure asks "is the car
  // shut and locked". Those are different questions, and before exteriorView
  // existed each derived its answer from its own filter, so the tank-lid
  // exclusion lived as one silent predicate inside one of them and the other
  // could not see it.
  const vin = 'YSMTEST22PL000001';
  const client = {
    async resolveVin(v?: string) { return v ?? vin; },
    async vehicles() { return [vin]; },
    async domain() {
      return {
        centralLock: 'LOCK_STATUS_LOCKED',
        tailgateLock: 'LOCK_STATUS_LOCKED',
        tankLid: 'OPEN_STATUS_OPEN',
        frontLeftDoor: 'OPEN_STATUS_CLOSED',
        alarm: 'ALARM_STATUS_OK',
      };
    },
  } as unknown as PolestarClient;
  const deps = { client, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km' } as ToolDeps;
  const specs = aggregateToolSpecs(deps);
  const textOf = (r: { content: ReadonlyArray<{ text: string }> }): string => r.content.map((c) => c.text).join('\n');

  const secure = await toolSpec(specs, 'is_car_secure').run({}, {});
  assert.match(textOf(secure), /Yes, car is secure/, 'an open charge flap is not a lock failure');

  const status = await toolSpec(specs, 'get_car_status').run({}, {});
  assert.match(textOf(status), /1 item\(s\) open/, 'the same flap is still a fact worth reporting');
});
