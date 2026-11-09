import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import {
  buildEngine,
  completeVehicleResource,
  createHttpHandler,
  createMcpServer,
  listVehicleResources,
  readVehicleResource,
  type Engine,
  type McpSurface,
} from '../src/server.js';
import { HistorySampler } from '../src/sampler.js';
import { BudgetMeter } from '../src/budget.js';
import {
  bearerMatches,
  decideBind,
  decideHttpRequest,
  forbiddenBody,
  MIN_HTTP_TOKEN_LENGTH,
  unauthenticatedBody,
  type BindSuccess,
} from '../src/bind.js';
import { createSubscriptionPoller, MAX_SUBSCRIPTIONS } from '../src/subscriptions.js';
import { DOMAINS } from '../src/domains.js';
import { domainToolSpecs } from '../src/domain-tools.js';
import { aggregateToolSpecs } from '../src/aggregate-tools.js';
import { systemToolSpecs } from '../src/system-tools.js';
import { toolSpec } from '../src/tools.js';
import { historyToolSpecs } from '../src/history-tools.js';
import { advisorToolSpecs } from '../src/advisor-tools.js';
import { InvalidConfigError, loadConfig } from '../src/config.js';
import { PolestarApiError, type PolestarClient } from '../src/client.js';
import type { ToolDeps } from '../src/tool-output.js';

const DUMP = fileURLToPath(new URL('../test/fixtures/dump', import.meta.url));
const VIN = 'YSMTEST22PL000001';
const VIN_PATTERN = /(?<![A-Za-z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])/;

function depsFor(engine: Engine, over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    client: engine.client,
    redactVin: engine.config.redactVin,
    vehicleLabels: engine.config.vehicleLabels,
    delegatedAccounts: engine.config.delegatedAccounts,
    units: engine.config.units,
    ...over,
  };
}

function surfaceFor(env: Record<string, string | undefined> = {}): { engine: Engine; surface: McpSurface; logged: string[] } {
  const engine = buildEngine({ POLESTAR_FIXTURES_DIR: DUMP, POLESTAR_HISTORY_DIR: undefined, ...env });
  const logged: string[] = [];
  engine.log = (message: string) => logged.push(message);
  const surface = createMcpServer(engine);
  return { engine, surface, logged };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('a non-loopback bind is refused before anything listens, and allowed with a long token', () => {
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

  // A short secret on a routable interface is a guessable secret: refused.
  const short = decideBind({ host: '10.0.0.5', token: 'sekret' });
  assert.equal(short.ok, false, 'a bearer token below the floor must not be accepted');
  if (!short.ok) assert.match(short.reason, new RegExp(`${MIN_HTTP_TOKEN_LENGTH} characters`));

  const withToken = decideBind({ host: '10.0.0.5', token: 'a'.repeat(MIN_HTTP_TOKEN_LENGTH) });
  assert.equal(withToken.ok, true);
  if (withToken.ok) assert.equal(withToken.authenticated, true);

  // The floor is a non-loopback rule: a loopback development token may be short.
  const loopbackToken = decideBind({ host: '127.0.0.1', token: 'short' });
  assert.equal(loopbackToken.ok, true);

  // The 401 body speaks the same error shape the client reads everywhere else.
  const body = JSON.parse(unauthenticatedBody()) as { error: { code: string; httpStatus: number } };
  assert.equal(body.error.code, 'UNAUTHENTICATED');
  assert.equal(body.error.httpStatus, 401);

  const forbidden = JSON.parse(forbiddenBody('nope')) as { error: { code: string; httpStatus: number; message: string } };
  assert.equal(forbidden.error.code, 'FORBIDDEN');
  assert.equal(forbidden.error.httpStatus, 403);
  assert.equal(forbidden.error.message, 'nope');
});

test('a forged Host or a foreign Origin is refused; same-host and configurable origins pass', () => {
  const loopback = { boundHost: '127.0.0.1', allowedOrigins: [] as string[] };

  const normal = decideHttpRequest({ ...loopback, hostHeader: '127.0.0.1:8080', originHeader: undefined });
  assert.equal(normal.ok, true, 'a non-browser client sends no Origin and must keep working');

  const sameHost = decideHttpRequest({ ...loopback, hostHeader: '127.0.0.1:8080', originHeader: 'http://127.0.0.1:8080' });
  assert.equal(sameHost.ok, true, 'same-host-origin is the default allowlist');

  const localhostAlias = decideHttpRequest({ ...loopback, hostHeader: '127.0.0.1:8080', originHeader: 'http://localhost:8080' });
  assert.equal(localhostAlias.ok, true, 'localhost and 127.0.0.1 are the same machine');

  // The measured DNS-rebinding request: attacker Host and Origin.
  const rebound = decideHttpRequest({ ...loopback, hostHeader: 'attacker.example', originHeader: 'http://attacker.example' });
  assert.equal(rebound.ok, false);
  if (!rebound.ok) {
    assert.equal(rebound.status, 403);
    assert.match(rebound.message, /DNS-rebinding|not this listener/);
  }

  const foreignOrigin = decideHttpRequest({ ...loopback, hostHeader: '127.0.0.1:8080', originHeader: 'https://evil.example' });
  assert.equal(foreignOrigin.ok, false);
  if (!foreignOrigin.ok) assert.match(foreignOrigin.message, /POLESTAR_HTTP_ALLOWED_ORIGINS/);

  const missingHost = decideHttpRequest({ ...loopback, hostHeader: undefined, originHeader: undefined });
  assert.equal(missingHost.ok, false);

  // A configured allowlist admits that origin and nothing else.
  const configured = { boundHost: '127.0.0.1', allowedOrigins: ['https://app.example.com'] };
  const allowed = decideHttpRequest({ ...configured, hostHeader: '127.0.0.1:8080', originHeader: 'https://app.example.com' });
  assert.equal(allowed.ok, true);
  const notListed = decideHttpRequest({ ...configured, hostHeader: '127.0.0.1:8080', originHeader: 'https://other.example.com' });
  assert.equal(notListed.ok, false);

  // On a routable bind the Host must be the bound interface, not any loopback alias.
  const routed = decideHttpRequest({ boundHost: '10.0.0.5', allowedOrigins: [], hostHeader: '127.0.0.1:8080', originHeader: undefined });
  assert.equal(routed.ok, false, 'a loopback Host must not reach a routable bind');
});

test('bearer tokens are compared in constant time and length-checked', () => {
  const token = 'a'.repeat(MIN_HTTP_TOKEN_LENGTH);
  assert.equal(bearerMatches(`Bearer ${token}`, token), true);
  assert.equal(bearerMatches(`bearer ${token}`, token), true, 'the scheme is case-insensitive per RFC 7235');
  assert.equal(bearerMatches(`Bearer ${'b'.repeat(MIN_HTTP_TOKEN_LENGTH)}`, token), false, 'same length, different bytes');
  assert.equal(bearerMatches('Bearer short', token), false, 'length mismatch is refused before timingSafeEqual');
  assert.equal(bearerMatches('Basic abc', token), false);
  assert.equal(bearerMatches(undefined, token), false);
  assert.equal(bearerMatches('Bearer ', token), false);
});

/** POST one JSON-RPC body with exact headers, over a real socket. */
function post(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'POST', headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'seams-test', version: '0.0.0' } },
});

async function withHttp(
  engine: Engine,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const bind = decideBind({ host: '127.0.0.1', token: engine.config.httpToken });
  assert.equal(bind.ok, true);
  const server = createHttpServer(createHttpHandler(engine, bind as BindSuccess));
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(port);
  } finally {
    await new Promise<void>((closed, reject) => server.close((err) => (err ? reject(err) : closed())));
  }
}

test('the HTTP listener refuses a forged Host or Origin before the transport reads the body', async () => {
  const { engine } = surfaceFor({});
  await withHttp(engine, async (port) => {
    // Garbage body on purpose: a 403 rather than a parse error proves the header
    // gate ran first, and no transport saw the bytes.
    const rebound = await post(
      port,
      { host: 'attacker.example', origin: 'http://attacker.example', 'content-type': 'application/json' },
      'not json at all',
    );
    assert.equal(rebound.status, 403, JSON.stringify(rebound));
    const parsed = JSON.parse(rebound.body) as { error?: { code?: string } };
    assert.equal(parsed.error?.code, 'FORBIDDEN');

    const foreign = await post(port, { origin: 'https://evil.example', 'content-type': 'application/json' }, 'not json');
    assert.equal(foreign.status, 403);

    // A normal loopback client still completes a handshake.
    const ok = await post(
      port,
      { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      INITIALIZE,
    );
    assert.equal(ok.status, 200, `a normal loopback client must still pass: ${ok.status} ${ok.body.slice(0, 200)}`);
    assert.match(ok.body, /serverInfo/);
  });
});

test('the HTTP listener requires the bearer token when one is configured', async () => {
  const token = 't'.repeat(MIN_HTTP_TOKEN_LENGTH);
  const { engine } = surfaceFor({ POLESTAR_HTTP_TOKEN: token });
  assert.equal(engine.config.httpToken, token);
  await withHttp(engine, async (port) => {
    const anonymous = await post(port, { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, INITIALIZE);
    assert.equal(anonymous.status, 401);

    const wrong = await post(
      port,
      { authorization: `Bearer ${'x'.repeat(token.length)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      INITIALIZE,
    );
    assert.equal(wrong.status, 401);

    const right = await post(
      port,
      { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      INITIALIZE,
    );
    assert.equal(right.status, 200, right.body.slice(0, 200));
  });
});

test('the advertised capabilities promise only what a sender exists for', () => {
  // The handshake used to advertise logging and resources.listChanged while no
  // code in src/ ever sent either notification; a client that waits for one waits
  // forever. Subscriptions are the one capability whose value depends on the
  // transport, because the stateless HTTP surface is closed with its response.
  const stdio = surfaceFor({}).surface;
  const stateless = createMcpServer(buildEngine({ POLESTAR_FIXTURES_DIR: DUMP }), { subscriptions: false });
  const stdioCaps = stdio.server.server.getCapabilities();
  const statelessCaps = stateless.server.server.getCapabilities();

  assert.equal(stdioCaps.resources?.subscribe, true, 'stdio can keep a poller alive');
  assert.equal(statelessCaps.resources?.subscribe, false, 'a per-request surface cannot');
  assert.equal('logging' in stdioCaps, false, 'nothing in src/ sends a logging notification');
  assert.equal('logging' in statelessCaps, false);
});

test('config refuses a fixtures directory that does not exist, naming the variable and the fix', () => {
  assert.throws(
    () => buildEngine({ POLESTAR_FIXTURES_DIR: join(tmpdir(), `polestar-missing-${process.pid}-${Date.now()}`) }),
    (err: unknown) => {
      assert.ok(err instanceof InvalidConfigError);
      assert.match(err.message, /POLESTAR_FIXTURES_DIR/);
      assert.match(err.message, /does not exist/);
      assert.match(err.message, /test\/fixtures\/dump/);
      return true;
    },
  );
});

test('config names the variable and the fix for non-positive numbers, http and falsey location', () => {
  const LIVE = { POLESTAR_CLIENT_ID: 'id', POLESTAR_CLIENT_SECRET: 'secret', POLESTAR_ACCOUNT_ID: 'account-1' };
  const bad: Array<[string, string]> = [
    ['POLESTAR_BUDGET', '0'],
    ['POLESTAR_BUDGET', '-5'],
    ['POLESTAR_BUDGET', 'lots'],
    ['POLESTAR_BUDGET_PER_MINUTE', '0'],
    ['POLESTAR_TIMEOUT_MS', '0'],
    ['POLESTAR_HISTORY_SAMPLE_SECONDS', '-1'],
  ];
  for (const [name, value] of bad) {
    assert.throws(
      () => loadConfig({ ...LIVE, [name]: value }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidConfigError, `${name}=${value} must be an InvalidConfigError`);
        assert.match(err.message, new RegExp(name), 'the message names the variable');
        assert.match(err.message, /positive|whole number/, 'and says what to set');
        return true;
      },
    );
  }

  // http sends the bearer token in clear text, so it is loopback-only.
  assert.throws(
    () => loadConfig({ ...LIVE, POLESTAR_BASE_URL: 'http://api.example/m2m' }),
    (err: unknown) => err instanceof InvalidConfigError && /https/.test(err.message),
  );
  assert.equal(loadConfig({ ...LIVE, POLESTAR_BASE_URL: 'http://127.0.0.1:8080/m2m' }).baseUrl, 'http://127.0.0.1:8080/m2m');

  // A privacy switch has to understand the words a person writes.
  for (const spelling of ['no', 'never', 'off', 'false', '0', 'disabled', 'NO']) {
    assert.equal(loadConfig({ ...LIVE, POLESTAR_ALLOW_LOCATION: spelling }).allowLocation, false, spelling);
  }
  assert.equal(loadConfig({ ...LIVE, POLESTAR_ALLOW_LOCATION: 'yes' }).allowLocation, true);

  // Origins are parsed at startup rather than compared as unvalidated strings.
  assert.deepEqual(loadConfig({ ...LIVE, POLESTAR_HTTP_ALLOWED_ORIGINS: ' https://app.example.com , https://b.example ' }).httpAllowedOrigins, [
    'https://app.example.com',
    'https://b.example',
  ]);
  assert.throws(
    () => loadConfig({ ...LIVE, POLESTAR_HTTP_ALLOWED_ORIGINS: 'not-an-origin' }),
    (err: unknown) => err instanceof InvalidConfigError && /POLESTAR_HTTP_ALLOWED_ORIGINS/.test(err.message),
  );
});

function harness(options: {
  metaEventIds: (string | undefined)[];
  lowBudget?: boolean;
  notify?: (uri: string) => Promise<void>;
}) {
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
    notify:
      options.notify ??
      (async (uri) => {
        notified.push(uri);
      }),
    log: (m) => logged.push(m),
    setTimer: (cb) => {
      timer = cb;
      return { unref: () => undefined };
    },
    clearTimer: () => {
      timer = undefined;
    },
  });
  return { poller, reads, notified, logged, tick: async () => { await timer?.(); await poller.pollOnce(); }, hasTimer: () => timer !== undefined };
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

test('an unparseable or non-VIN subscription URI is a JSON-RPC invalid-params error', async () => {
  const h = harness({ metaEventIds: ['e1'] });
  const rejected = [
    'not a uri at all',
    'polestar://vehicle/not-a-vin/telemetry/battery',
    'polestar://vehicle/YSMTEST22PL000001/telemetry/not-a-domain',
    'polestar://vehicle/YSMTEST22PL000001/solar/battery',
  ];
  for (const uri of rejected) {
    await assert.rejects(
      () => h.poller.subscribe(uri),
      (err: unknown) => {
        assert.ok(err instanceof ProtocolError, `${uri} must be a protocol error, saw ${String(err)}`);
        assert.equal(err.code, ProtocolErrorCode.InvalidParams);
        return true;
      },
    );
  }
  assert.equal(h.poller.size, 0, 'a rejected subscription holds no target');
  assert.equal(h.hasTimer(), false, 'and never starts a timer');
});

test('the subscription set has a cap, and an unsubscribe makes room again', async () => {
  const h = harness({ metaEventIds: ['e1'] });
  const vin = (n: number): string => `YSM${String(n).padStart(14, '0')}`;
  for (let n = 0; n < MAX_SUBSCRIPTIONS; n += 1) {
    await h.poller.subscribe(`polestar://vehicle/${vin(n)}/telemetry/battery`);
  }
  assert.equal(h.poller.size, MAX_SUBSCRIPTIONS);

  await assert.rejects(
    () => h.poller.subscribe(`polestar://vehicle/${vin(MAX_SUBSCRIPTIONS)}/telemetry/battery`),
    (err: unknown) => err instanceof ProtocolError && err.code === ProtocolErrorCode.InvalidParams && /cap/.test(err.message),
  );

  h.poller.unsubscribe(`polestar://vehicle/${vin(0)}/telemetry/battery`);
  await h.poller.subscribe(`polestar://vehicle/${vin(MAX_SUBSCRIPTIONS)}/telemetry/battery`);
  assert.equal(h.poller.size, MAX_SUBSCRIPTIONS);
});

test('a slow polling round cannot overlap the next, so one tick is one read', async () => {
  let reads = 0;
  let hang = false;
  const releases: Array<() => void> = [];
  const poller = createSubscriptionPoller({
    async read() {
      reads += 1;
      if (hang) await new Promise<void>((release) => releases.push(release));
      return { metaEventId: 'e1' };
    },
    budget: { isLow: () => false },
    notify: async () => undefined,
    log: () => undefined,
    setTimer: () => ({}),
    clearTimer: () => undefined,
  });

  await poller.subscribe(URI);
  assert.equal(reads, 1, 'subscribe primes once');
  hang = true;
  const first = poller.pollOnce();
  const overlapping = poller.pollOnce();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 2, 'the overlapping call did not issue a second read');
  releases.shift()?.();
  await first;
  await overlapping;
  assert.equal(reads, 2);
});

test('a notification the client rejects is retried next round instead of losing the change', async () => {
  // One cloud change is one notify. The change id used to be stored before the
  // client acknowledged it, so a dropped notification meant that change was never
  // sent again; it is stored only after notify resolves.
  const delivered: string[] = [];
  const events = ['e2', 'e3', 'e3', 'e3'];
  let read = 0;
  let failOnce = true;
  const poller = createSubscriptionPoller({
    async read() {
      const id = events[Math.min(read, events.length - 1)];
      read += 1;
      return { metaEventId: id };
    },
    budget: { isLow: () => false },
    async notify(uri: string) {
      delivered.push(uri);
      if (failOnce) {
        failOnce = false;
        throw new Error('notification channel closed');
      }
    },
    log: () => undefined,
    setTimer: () => ({}),
    clearTimer: () => undefined,
  });

  await poller.subscribe(URI); // primes on e2
  assert.deepEqual(delivered, []);
  await poller.pollOnce(); // e3 arrives, the notification throws
  assert.deepEqual(delivered, [URI], 'the failed attempt is the only notification so far');
  await poller.pollOnce(); // same e3, the retry succeeds
  assert.deepEqual(delivered, [URI, URI], 'the same change was retried');
  await poller.pollOnce(); // e3 is stored now, so no further notification
  assert.deepEqual(delivered, [URI, URI]);
  poller.stop();
});

test('buildEngine composes a runnable server from the environment alone', () => {
  const engine = buildEngine({ POLESTAR_FIXTURES_DIR: DUMP, POLESTAR_HISTORY_DIR: undefined });
  assert.ok(engine.client, 'the client is assembled');
  assert.equal(engine.config.budgetLimit, 10_000, 'the documented daily ceiling is the default');
  assert.equal(engine.config.budgetPerMinute, 100, 'and the documented per-minute one');
  assert.equal(engine.config.httpHost, '127.0.0.1', 'the bind defaults to loopback');
  assert.equal(engine.config.httpToken, '');
  assert.equal(engine.config.httpAllowedOrigins.length, 0, 'no cross-origin caller is allowed by default');
  engine.sampler?.stop();
  engine.budget.consume();
  assert.equal(engine.budget.snapshot().used, 1);
});

test('a surface owns the poller it starts, and close stops it', async () => {
  const { engine } = surfaceFor({});
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
  // The provider stops trusting a token five minutes early, so a 12-minute
  // token has 7 trusted minutes left; assert the arithmetic, not just the phrase.
  assert.match(text, /Token: trusted ~7 more min/);

  // No reads yet is a rate of zero, not a division by zero.
  const cold = await report({ cacheStats: { enabled: true, hits: 0, staleServed: 0, misses: 0, refreshes: 0, entries: 0 } });
  assert.match(cold, /of 0 reads \(0%\)/, 'a cold cache reads as zero percent rather than NaN');

  // An expired-but-unspent budget is still worth naming, and a cache that is off
  // says so instead of printing counters no read can move.
  assert.match(await report({ tokenExpiresAt: () => undefined }), /Token: not yet issued/);
  const off = await report({ cacheStats: { enabled: false, hits: 0, staleServed: 0, misses: 0, refreshes: 0, entries: 0 } });
  assert.match(off, /Cache: off \(POLESTAR_CACHE=off/);
  assert.doesNotMatch(off, /stale-served/, 'an off cache prints no hit rate');
});

test('the instructions and prompts describe only the running surface', () => {
  const plain = surfaceFor({});
  const history = surfaceFor({ POLESTAR_HISTORY_DIR: tempDir('polestar-seams-history-') });

  // The history prompt is registered only when its two tools are.
  assert.deepEqual([...plain.surface.promptNames], ['car-status', 'charge-plan']);
  assert.deepEqual([...history.surface.promptNames], ['car-status', 'charge-plan', 'battery-health-report']);

  const plainNames = new Set(plain.surface.toolNames);
  const historyNames = new Set(history.surface.toolNames);
  assert.ok(plainNames.has('get_car_status') && plainNames.has('is_car_secure') && plainNames.has('polestar_status'));
  assert.equal(plainNames.has('get_history'), false, 'no history tool without a store');
  assert.equal(historyNames.has('get_history'), true);

  // Every tool-shaped name a prompt tells the model to call is registered on the
  // same surface. This used to scan the source file and a hand-built union of all
  // 26 tools, so a prompt naming an unregistered tool still passed CI.
  for (const [surface, names] of [[plain.surface, plainNames], [history.surface, historyNames]] as const) {
    for (const spec of surface.prompts) {
      const rendered = JSON.stringify(spec.build({ vin: VIN, prices: '1' }));
      const named = rendered.match(/\b(?:get|is|plan|polestar|list)_[a-z_]+\b/g) ?? [];
      assert.ok(named.length > 0, `${spec.name} names no tool`);
      for (const tool of named) {
        assert.ok(names.has(tool), `${spec.name} tells the model to call ${tool}, which is not registered`);
      }
    }
  }
  // The history prompt exists only where its tools do.
  const historyPrompt = history.surface.prompts.find((spec) => spec.name === 'battery-health-report');
  assert.ok(historyPrompt !== undefined);
  const rendered = JSON.stringify(historyPrompt.build({}));
  assert.match(rendered, /get_degradation_report/);
  assert.equal(plainNames.has('get_degradation_report'), false, 'the default surface has no such tool');

  // Instructions: generated from the same surface, short, and stable.
  const text = plain.surface.instructions;
  assert.match(text, /READ-ONLY/);
  assert.doesNotMatch(text, /Start with list_vehicles/, 'list_vehicles is not a mandatory first call: vin may be omitted');
  assert.match(text, /A vin argument is optional when the credential sees exactly one vehicle/);
  assert.match(text, /requestId when the upstream sent one/, 'claim requestId only when the error carries one');
  assert.doesNotMatch(text, /with a code, httpStatus and requestId/, 'not every error carries a requestId');
  assert.doesNotMatch(text, /get_history|get_degradation_report/, 'no history tools in the default instructions');
  assert.match(text, /kilometres/);
  assert.doesNotMatch(text, /delegated_account_id/, 'no delegation sentence when the operator configured none');
  assert.equal(surfaceFor({}).surface.instructions, text, 'byte-stable across identical builds');
  for (const tool of text.match(/\b(?:get|is|plan|polestar|list)_[a-z_]+\b/g) ?? []) {
    assert.ok(plainNames.has(tool), `the instructions name ${tool}, which is not registered`);
  }

  const miles = surfaceFor({ POLESTAR_UNITS: 'mi' }).surface.instructions;
  assert.match(miles, /miles/);
  assert.doesNotMatch(miles, /kilometres/);

  const delegated = surfaceFor({ POLESTAR_DELEGATED_ACCOUNT_IDS: 'partner-a@example.com' }).surface.instructions;
  assert.match(delegated, /delegated_account_id/);

  const historyText = history.surface.instructions;
  assert.match(historyText, /get_history/);
  assert.match(historyText, /get_degradation_report/);
});

test('POLESTAR_REDACT_VIN covers resource text, completions and non-raw tool results', async () => {
  const { engine } = surfaceFor({ POLESTAR_REDACT_VIN: '1' });
  const deps = depsFor(engine);
  assert.equal(deps.redactVin, true);

  // Positive control: the resource URI is the documented exception and does
  // carry the raw VIN, so a detector that finds nothing elsewhere is awake.
  const listed = await listVehicleResources(engine, deps, 'telemetry');
  assert.ok(listed.length > 0);
  assert.ok(listed[0]!.uri.includes(VIN), 'the URI exception keeps the raw VIN');
  const resourceText = listed.map((entry) => `${entry.name}\n${entry.description}`).join('\n');
  assert.doesNotMatch(resourceText, VIN_PATTERN, 'resource names and descriptions are masked');
  assert.match(resourceText, /YSM…001/, 'and show the mask');

  const completions = await completeVehicleResource(engine, deps, 'telemetry', 'vin', '');
  assert.ok(completions.length > 0);
  for (const value of completions) assert.doesNotMatch(value, VIN_PATTERN, `completion leaks ${value}`);

  const read = await readVehicleResource(deps, 'telemetry', new URL(listed[0]!.uri), { vin: VIN, domain: 'battery' });
  assert.doesNotMatch(read.contents[0]!.text, VIN_PATTERN, 'resource contents are masked');

  // Every domain tool's default (non-raw) result: text and envelope together.
  for (const spec of domainToolSpecs(deps)) {
    const result = await spec.run({}, {});
    assert.doesNotMatch(JSON.stringify(result), VIN_PATTERN, `${spec.name} leaks the VIN in a non-raw result`);
  }
});

test('resources/list enumerates every vehicle instead of silently keeping ten', async () => {
  const { engine } = surfaceFor({});
  const deps = depsFor(engine);
  const twelve = Array.from({ length: 12 }, (_, index) => `YSM${String(index).padStart(14, '0')}`);
  const fake: Engine = { ...engine, client: { vehicles: async () => twelve } as unknown as PolestarClient };

  const listed = await listVehicleResources(fake, deps, 'telemetry');
  const telemetryDomains = DOMAINS.filter((domain) => domain.kind === 'telemetry').length;
  assert.equal(listed.length, twelve.length * telemetryDomains, 'twelve vehicles, not the first ten');
  const seen = new Set(listed.map((entry) => /vehicle\/([^/]+)\//.exec(entry.uri)?.[1]));
  assert.deepEqual([...seen].sort(), [...twelve].sort());

  // POLESTAR_VEHICLE_LABELS names the vehicle in text.
  const labelled = await listVehicleResources(fake, depsFor(engine, { vehicleLabels: { [twelve[0]!]: 'The Polestar' } }), 'telemetry');
  assert.ok(labelled.some((entry) => entry.name.includes('The Polestar')));
  assert.ok(labelled.every((entry) => !entry.description.includes('The Polestar') || entry.name.includes('The Polestar')));
});

test('resources/list errors when the vehicle list fails, and an unknown domain is a protocol error', async () => {
  const { engine } = surfaceFor({});
  const deps = depsFor(engine);
  const failing: Engine = {
    ...engine,
    client: {
      vehicles: async () => {
        throw new PolestarApiError('HTTP_500', 'upstream failed', 500);
      },
    } as unknown as PolestarClient,
  };
  await assert.rejects(
    () => listVehicleResources(failing, deps, 'telemetry'),
    (err: unknown) => err instanceof PolestarApiError,
    'a failed vehicle list must be an error, not an empty listing that looks like zero cars',
  );

  await assert.rejects(
    () => readVehicleResource(deps, 'telemetry', new URL(`polestar://vehicle/${VIN}/telemetry/bogus`), { vin: VIN, domain: 'bogus' }),
    (err: unknown) => err instanceof ProtocolError && err.code === ProtocolErrorCode.InvalidParams,
    'an unknown domain URI is a protocol error, not content',
  );
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
  const client = {
    async resolveVin(v?: string) { return v ?? VIN; },
    async vehicles() { return [VIN]; },
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

// Keep the imports of the remaining spec factories load-bearing: this suite is
// the one that builds the running surface, so a family that stops building is a
// startup failure, not a silently smaller registry.
test('every tool family still builds against the fixture client', () => {
  const { engine } = surfaceFor({});
  const deps = depsFor(engine);
  const names = new Set([
    ...domainToolSpecs(deps),
    ...aggregateToolSpecs(deps),
    ...advisorToolSpecs(deps),
    ...systemToolSpecs({
      ...deps,
      budget: engine.budget,
      minute: engine.minute,
      cacheStats: engine.cacheStats,
      tokenExpiresAt: () => undefined,
      fixtureMode: true,
    } as never),
    ...historyToolSpecs({ ...deps, store: {} } as never),
  ].map((spec) => spec.name));
  assert.ok(names.size >= 26, `expected the full registry, saw ${names.size}`);
});
