#!/usr/bin/env node
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { TokenProvider } from './auth.js';
import { BudgetMeter, MinuteWindowMeter } from './budget.js';
import { CachingTransport } from './caching-transport.js';
import { PolestarClient } from './client.js';
import { collectScopes, DOMAINS } from './domains.js';
import { createSubscriptionPoller, type SubscriptionDeps, type SubscriptionPoller } from './subscriptions.js';
import { decideBind, unauthenticatedBody } from './bind.js';
import { domainToolSpecs } from './domain-tools.js';
import { aggregateToolSpecs } from './aggregate-tools.js';
import { advisorToolSpecs } from './advisor-tools.js';
import { historyToolSpecs } from './history-tools.js';
import { systemToolSpecs } from './system-tools.js';
import { registerTools, toolNames, type ToolSpec } from './tools.js';
import { accountIdLooksLikeClientId, loadConfig, loadEnvFileInto, unknownEnvFatal, unknownEnvVariables, type Config } from './config.js';
import { HistorySampler, SAMPLED_DOMAINS } from './sampler.js';
import { HistoryStore } from './history.js';
import { readDomain } from './vehicle-read.js';
import { z } from 'zod';
import { FixtureTransport, HttpTransport, type Transport } from './transport.js';
import { RetryingTransport } from './retrying-transport.js';
import { resultText, type ToolDeps } from './tool-output.js';

const require = createRequire(import.meta.url);
const PKG_VERSION: string = require('../package.json').version;

/**
 * Candidate secrets files, in order. The project tree is deliberately absent:
 * a file holding a live token belongs outside a directory that gets zipped,
 * shared or committed. Set POLESTAR_ENV_FILE to point somewhere else.
 */
function secretsFileCandidates(env: NodeJS.ProcessEnv): string[] {
  const override = env.POLESTAR_ENV_FILE?.trim();
  if (override) return [resolve(override)];
  return [resolve(homedir(), '.config', 'polestar-mcp', '.env.secrets')];
}

export interface Engine {
  config: Config;
  budget: BudgetMeter;
  minute: MinuteWindowMeter;
  cacheStats: CachingTransport['stats'];
  client: PolestarClient;
  tokenProvider: TokenProvider;
  store?: HistoryStore | undefined;
  sampler?: HistorySampler | undefined;
  log: (message: string) => void;
}

/** Compose the runtime. Exported so the chain itself can be assembled in a test. */
export function buildEngine(env: NodeJS.ProcessEnv): Engine {
  const config = loadConfig(env);
  const log = (message: string): void => {
    // Protocol owns stdout; everything diagnosable goes to stderr.
    console.error(`[polestar-mcp] ${message}`);
  };
  const budget = new BudgetMeter(config.budgetLimit);
  const minute = new MinuteWindowMeter(config.budgetPerMinute);
  const store = config.historyDir ? new HistoryStore(config.historyDir) : undefined;

  let transport: Transport;
  const base: Transport = config.fixturesDir
    ? new FixtureTransport(config.fixturesDir)
    : new HttpTransport(config.timeoutMs);
  // Retry + budget metering are live-API concerns; fixture reads are free.
  // The cache is in the chain whenever live reads are worth not repeating. It no
  // longer plays any part in history recording: the recorder watches the client's
  // unwrapped result instead of the raw body passing through here.
  const inner: Transport =
    config.fixturesDir || config.cacheDisabled ? base : new RetryingTransport(base, { budget, minute });
  const cache = new CachingTransport(inner, {
    onRefreshError: ({ url, message }) => {
      // A stale entry that cannot be refreshed is worth a line on stderr even
      // without debug on: the caller was served an answer it cannot tell is old.
      log(`background refresh failed for ${new URL(url).pathname}: ${message}`);
    },
    disabled: config.cacheDisabled || (config.fixturesDir !== undefined && store === undefined),
  });
  const cacheStats = cache.stats;
  transport = cache;

  const tokenProvider = new TokenProvider(transport, {
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: config.scopes ?? collectScopes(),
  });
  const client = new PolestarClient(tokenProvider, transport, {
    baseUrl: config.baseUrl,
    accountId: config.accountId,
    allowLocation: config.allowLocation,
    ...(config.delegatedAccountId ? { delegatedAccountId: config.delegatedAccountId } : {}),
    ...(store === undefined
      ? {}
      : {
          // The cloud re-serves an unchanged metaEventId until the car reports
          // anew, so the store dedupes on it and files only grow when something
          // actually changed. Watching the client rather than the bytes means the
          // recorder sees the payload already unwrapped, with the change id read
          // out of the same Envelope the client just opened.
          onDomainRead: ({ vin, kind, name, data, metaEventId }) => {
            store.append(vin, kind, name, { observedAt: Date.now(), metaEventId, data });
          },
        }),
  });

  let sampler: HistorySampler | undefined;
  if (store) {
    sampler = new HistorySampler(
      client,
      budget,
      async (vin) => {
        for (const domain of SAMPLED_DOMAINS) {
          if (domain.name === 'location' && !config.allowLocation) continue;
          await client.domain(vin, domain.kind, domain.name).catch(() => undefined);
        }
      },
      { intervalSeconds: config.historySampleSeconds, log },
    );
  }

  return { config, budget, minute, cacheStats, client, tokenProvider, store, sampler, log };
}

/**
 * One MCP surface and everything it started.
 *
 * Pollers used to live in a module-level array every surface pushed into, which
 * made a surface's lifetime unownable. HTTP mode builds one surface per request
 * and its teardown closed the transport and the server but never the poller it
 * had just created, so a stateless deployment kept one per request until a signal
 * arrived, while the comment beside that teardown and the docs both said
 * subscriptions were a stdio feature. A surface now closes what it opened, so
 * nothing about a resource outlives the thing that created it.
 */
export interface McpSurface {
  server: McpServer;
  /** Every tool this surface registered, which is the list the instructions name. */
  toolNames: readonly string[];
  /** How many resource subscriptions this surface is polling for. */
  readonly subscriptions: number;
  /** Subscribe to a resource URI and start polling. The protocol handler calls this. */
  subscribe(uri: string): Promise<void>;
  unsubscribe(uri: string): void;
  /** Stop every poller this surface started, then close the session. Idempotent. */
  close(): Promise<void>;
}

/** The poller's clock, so a test need not wait a minute. Same hooks subscriptions.ts takes. */
export interface McpSurfaceOptions {
  pollerClock?: Pick<SubscriptionDeps, 'intervalMs' | 'setTimer' | 'clearTimer'>;
  /**
   * Whether this surface can keep a subscription alive. False for the stateless
   * HTTP mode, where the surface is closed as the response ends: a poller whose
   * first tick is a minute away can never fire, so accepting a subscribe request
   * and dropping it silently is worse than not advertising the capability. Stdio
   * defaults to true.
   */
  subscriptions?: boolean;
}

/**
 * The MCP surface: 15 humanized domain tools + aggregates + charging
 * advisor + system status (+ history tools when enabled), resources with VIN
 * completions and metaEventId-driven subscriptions, and starter prompts.
 * Every read tool carries readOnlyHint so clients can auto-approve.
 */
export function createMcpServer(engine: Engine, options: McpSurfaceOptions = {}): McpSurface {
  const subscriptionsAllowed = options.subscriptions !== false;
  const deps: ToolDeps = { client: engine.client, redactVin: engine.config.redactVin, vehicleLabels: engine.config.vehicleLabels, delegatedAccounts: engine.config.delegatedAccounts, units: engine.config.units };

  // The registry is built before the server that advertises it. The instructions
  // used to be a hand-written copy of these names and limits, and had drifted:
  // they sent every agent to a `get_security_status` that was never registered.
  // Built once: the instructions below name the aggregates, and rebuilding the
  // registry inside that string meant one surface carried two copies of it.
  const aggregates = aggregateToolSpecs(deps);
  const store = engine.store;
  const specs: ToolSpec[] = [
    ...domainToolSpecs(deps),
    ...aggregates,
    ...advisorToolSpecs(deps),
    ...systemToolSpecs({
      ...deps,
      budget: engine.budget,
      minute: engine.minute,
      cacheStats: engine.cacheStats,
      tokenExpiresAt: () => engine.tokenProvider.expiresAt(),
      fixtureMode: engine.config.fixturesDir !== undefined,
      ...(engine.sampler === undefined ? {} : { sampler: engine.sampler }),
    }),
    ...(store === undefined ? [] : historyToolSpecs({ ...deps, store })),
  ];

  const server = new McpServer(
    { name: 'polestar-mcp', version: PKG_VERSION },
    {
      instructions: [
        'Polestar Data Portal (M2M) is READ-ONLY: every tool is a GET, no command is sent to the car.',
        'Start with list_vehicles. On a credential that sees exactly one vehicle the vin argument may be omitted.',
        'Domain data is reported by the car, not by the API: fields are absent when unreported, and a whole domain can answer DATA_NOT_AVAILABLE. That is normal, not an error.',
        `Prefer ${aggregates.map((s) => s.name).join(' or ')} over the ${DOMAINS.length} individual domain reads; every live call spends a shared allowance of ${engine.config.budgetLimit.toLocaleString('en-US')} calls/day and ${engine.minute.snapshot().limit}/minute, and polestar_status reports what is left.`,
        'Every payload carries an age: charging configuration can be days old while telemetry is minutes old, so read the age before treating a value as current.',
        'Errors come back as structured JSON with a code, httpStatus and requestId. Quote the requestId when reporting a problem.',
      ].join(' '),
      capabilities: { resources: { subscribe: subscriptionsAllowed, listChanged: true }, logging: {} },
    },
  );

  registerTools(server, specs);
  if (engine.config.enableWrites) {
    // No v1 write endpoints exist yet; the flag is
    // the deliberate opt-in they will slot behind when Polestar ships them.
    engine.log('POLESTAR_ENABLE_WRITES is set, but the documented v1 API has no write endpoints, nothing registered.');
  }

  // Subscriptions: the SDK declares the protocol but not the bookkeeping. The
  // poller lives in subscriptions.ts, where the clock and the budget are
  // parameters instead of a closure. It is created here, by the same object that
  // closes it, rather than inside the resource registration: the thing that
  // starts a timer owns stopping it.
  const subscriptions = createSubscriptionPoller({
    read: (vin, kind, name) => engine.client.domain(vin, kind, name),
    budget: engine.budget,
    notify: (uri) => server.server.sendResourceUpdated({ uri }),
    log: engine.log,
    ...(options.pollerClock ?? {}),
  });

  registerResources(server, engine, deps, subscriptions, subscriptionsAllowed);
  registerPrompts(server);

  return {
    server,
    toolNames: toolNames(specs),
    get subscriptions() {
      return subscriptions.size;
    },
    async subscribe(uri: string) {
      await subscriptions.subscribe(uri);
    },
    unsubscribe(uri: string) {
      subscriptions.unsubscribe(uri);
    },
    async close() {
      // The poller stops before the session: a timer that outlives the server it
      // notifies would try to send on a closed transport.
      subscriptions.stop();
      await server.close();
    },
  };
}

const RESOURCE_KINDS = ['telemetry', 'charging'] as const;

function registerResources(
  server: McpServer,
  engine: Engine,
  deps: ToolDeps,
  subscriptions: SubscriptionPoller,
  subscriptionsAllowed: boolean,
): void {
  const domainsOf = (kind: (typeof RESOURCE_KINDS)[number]): string[] =>
    DOMAINS.filter((d) => d.kind === kind).map((d) => d.name);

  for (const kind of RESOURCE_KINDS) {
    server.registerResource(
      `Vehicle ${kind} domains`,
      new ResourceTemplate(`polestar://vehicle/{vin}/${kind}/{domain}`, {
        list: async () => {
          try {
            const vins = await engine.client.vehicles();
            return {
              resources: vins.slice(0, 10).flatMap((vin) =>
                domainsOf(kind).map((domain) => ({
                  uri: `polestar://vehicle/${vin}/${kind}/${domain}`,
                  name: `${domain} (…${vin.slice(-4)})`,
                  description: `${kind}/${domain} for vehicle …${vin.slice(-4)}`,
                  mimeType: 'text/plain',
                })),
              ),
            };
          } catch {
            return { resources: [] };
          }
        },
        complete: {
          vin: async (value: string) => {
            const vins = await engine.client.vehicles().catch(() => []);
            return vins.filter((v) => v.toLowerCase().includes(value.toLowerCase())).slice(0, 20);
          },
          domain: async (value: string) =>
            domainsOf(kind).filter((d) => d.includes(value.toLowerCase())).slice(0, 20),
        },
      }),
      { description: `Live ${kind} for one vehicle and domain, humanized.`, mimeType: 'text/plain' },
      async (uri, variables) => {
        const vin = decodeURIComponent(String(variables.vin ?? ''));
        const domain = String(variables.domain ?? '');
        const spec = DOMAINS.find((d) => d.kind === kind && d.name === domain);
        if (!spec) {
          return { contents: [{ uri: uri.href, text: `Unknown ${kind} domain "${domain}".`, mimeType: 'text/plain' }] };
        }
        // The very read get_${spec.name.replace(/-/g, '_')} performs, so a resource
        // gains the age header, the owner label, the redaction and the delegation
        // check instead of a second, smaller implementation of the same read. A
        // resource cannot answer isError, so a failure arrives as text.
        const outcome = await readDomain(deps, spec, vin === '' ? {} : { vin }, undefined);
        const body = outcome.ok ? outcome.reading.text : resultText(outcome.result);
        return { contents: [{ uri: uri.href, text: body, mimeType: 'text/plain' }] };
      },
    );
  }

  // Registered only where a subscription can actually outlive the request. The
  // capability above is the other half of the same answer, so a client learns
  // this from the handshake rather than from a subscription that never fires.
  if (!subscriptionsAllowed) return;
  server.server.setRequestHandler('resources/subscribe', async (request: { params: { uri: string } }) => {
    await subscriptions.subscribe(request.params.uri);
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', async (request: { params: { uri: string } }) => {
    subscriptions.unsubscribe(request.params.uri);
    return {};
  });
}

function registerPrompts(server: McpServer): void {
  const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

  server.registerPrompt(
    'car-status',
    {
      title: 'Car status briefing',
      description: 'A one-glance briefing: charge, range, security, and anything needing attention.',
      argsSchema: z.object({ vin: z.string().optional() }),
    },
    (args) => {
      const vin = args?.vin;
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text',
              text: `Give me a status briefing for my Polestar${first(vin) ? ` (VIN ${first(vin)})` : ''}. Use get_car_status, then is_car_secure, then get_needs_attention, and finish with a two-line summary plus anything that needs action.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'charge-plan',
    {
      title: 'Cheapest charge plan',
      description: 'Plan the cheapest charging hours for tonight given spot prices.',
      argsSchema: z.object({ vin: z.string().optional(), prices: z.string().optional() }),
    },
    (args) => {
      const vin = args?.vin;
      const prices = args?.prices;
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text',
              text: `I want to charge my Polestar as cheaply as possible tonight${first(vin) ? ` (VIN ${first(vin)})` : ''}. Spot prices from my tariff provider: ${first(prices) ?? 'ask me for hourly prices as {"startsAt": ISO, "price": number} pairs before planning'}. Call plan_cheapest_charge with these prices and present the result as a simple schedule with estimated cost.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'battery-health-report',
    {
      title: 'Battery health report',
      description: 'Degradation and charging-session report from recorded history.',
      argsSchema: z.object({ vin: z.string().optional() }),
    },
    (args) => {
      const vin = args?.vin;
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text',
              text: `Report on my Polestar's battery health${first(vin) ? ` (VIN ${first(vin)})` : ''}: call get_degradation_report and get_charging_sessions, summarize the implied capacity trend, and say clearly whether there is enough history to conclude anything.`,
            },
          },
        ],
      };
    },
  );
}

/** Serve the same MCP surface over Streamable HTTP (stateless mode). */
async function serveHttp(engine: Engine, port: number): Promise<void> {
  // The rule lives in bind.ts as a function so it can be tested without opening
  // a socket: binding a location-reading server to a routable address with no
  // token must be refused before anything listens.
  const bind = decideBind({ host: engine.config.httpHost, token: engine.config.httpToken });
  if (!bind.ok) throw new Error(bind.reason);
  const { host } = bind;
  const token = bind.token ?? '';
  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (token !== '' && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end(unauthenticatedBody());
      return;
    }
    // Stateless mode: each request is an independent JSON-RPC exchange over one
    // shared engine (cache, budget, history). Tools, resources and prompts are
    // served; subscriptions are not, and the surface below says so in its
    // capabilities, because the surface that would poll is closed with this
    // response and its notification channel goes with it.
    void (async () => {
      const transport = new NodeStreamableHTTPServerTransport({ enableJsonResponse: true });
      const surface = createMcpServer(engine, { subscriptions: false });
      res.on('close', () => {
        void transport.close();
        void surface.close();
      });
      await surface.server.connect(transport as unknown as Parameters<typeof surface.server.connect>[0]);
      await transport.handleRequest(req, res);
    })().catch((err: unknown) => {
      engine.log(`HTTP request failed: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const guarded = httpServer;
  if (token !== '') engine.log('HTTP mode: Authorization: Bearer <POLESTAR_HTTP_TOKEN> required');
  await new Promise<void>((resolveListen) => guarded.listen(port, host, resolveListen));
  startSampler(engine);
  installShutdown(async () => { engine.sampler?.stop(); guarded.close(); }, engine.log);
  engine.log(`HTTP mode: http://${host}:${port} (stateless; tools, resources and prompts; no subscriptions)`);
}

/**
 * Stop cleanly on a supervisor signal: the sampler stops taking quota calls,
 * the MCP session closes so clients see a real end-of-session instead of a
 * dead pipe, and the exit code says "stopped" rather than "crashed".
 */
function installShutdown(shutdown: () => Promise<void>, log: (message: string) => void): void {
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      log(`${signal} received, shutting down`);
      const timer = setTimeout(() => process.exit(1), 5_000);
      timer.unref();
      void shutdown().then(() => process.exit(0), () => process.exit(1));
    });
  }
}

/**
 * Background sampling is opt-in (`POLESTAR_SAMPLE`): a sampler that runs
 * unattended spends a shared 10,000-call/day quota on nobody's behalf, so it
 * never starts itself. History still accrues from ordinary tool calls.
 */
function startSampler(engine: Engine): void {
  if (engine.sampler === undefined) return;
  if (!engine.config.sample) {
    engine.log('history store enabled, background sampling off, set POLESTAR_SAMPLE=on to sample within the daily budget');
    return;
  }
  void engine.sampler
    .start()
    .then((count) => engine.log(`background sampling on: ${count} vehicle(s) every ${engine.config.historySampleSeconds}s, budget-guarded`))
    .catch((err: unknown) => engine.log(`background sampling did not start: ${err instanceof Error ? err.message : err}`));
}

/** `--help` / `--version` on stderr and stdout respectively; stdout is protocol-only in server mode. */
function handleCliArgs(): boolean {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    console.log(PKG_VERSION);
    return true;
  }
  if (args.includes('--help') || args.includes('-h')) {
    // stdout is reserved for the protocol while serving, but these answers exit
    // before any transport is connected, so they belong on stdout like --version.
    // Writing help to stderr made `polestar-mcp --help > file` produce an empty file.
    console.log(
      [
        `polestar-mcp ${PKG_VERSION}, read-only Polestar Data Portal MCP server over stdio (or Streamable HTTP).`,
        '',
        'There are no positional arguments; configuration is environment-only.',
        '  POLESTAR_CLIENT_ID / POLESTAR_CLIENT_SECRET / POLESTAR_ACCOUNT_ID   required for live mode',
        '  POLESTAR_FIXTURES_DIR=<dir>                        offline mode, no credentials needed',
        '  POLESTAR_HTTP_PORT=<port>                          serve Streamable HTTP instead of stdio',
        '  POLESTAR_ALLOW_LOCATION=false                      never request or return vehicle position',
        '',
        'Put the three values in ~/.config/polestar-mcp/.env.secrets (see .env.example); real',
        'environment variables always win. Every variable the server reads is listed there, an',
        'unrecognized POLESTAR_* name is reported at startup, because a typo is otherwise invisible.',
        'Docs: docs/getting-started.md, docs/tools-reference.md, docs/upstream-api.md.',
      ].join('\n'),
    );
    return true;
  }
  return false;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Real env vars always win; the file only fills blanks. Skipped entirely in
  // fixture mode, which must not touch a live credential file to run offline.
  if (!env.POLESTAR_FIXTURES_DIR?.trim()) {
    for (const candidate of secretsFileCandidates(env)) {
      if (loadEnvFileInto(candidate, env)) {
        console.error(`[polestar-mcp] loaded local environment from ${candidate}`);
        // The file holds a live client secret. On a shared machine mode 0644
        // means anyone who can read the home directory can mint tokens; the
        // server cannot fix the filesystem quietly, so it says so.
        try {
          const mode = statSync(candidate).mode & 0o777;
          if (mode & 0o077) {
            console.error(`[polestar-mcp] WARNING: ${candidate} is readable/writable by group or others (mode ${mode.toString(8)}). Run: chmod 600 "${candidate}"`);
          }
        } catch {
          /* unreadable stat is not worth failing startup over */
        }
        break;
      }
    }
  }

  const unknown = unknownEnvVariables(env);
  if (unknown.length > 0) {
    const detail = unknown.map((u) => (u.suggests ? `${u.name} (did you mean ${u.suggests}?)` : u.name)).join(', ');
    console.error(`[polestar-mcp] unrecognized variable${unknown.length > 1 ? 's' : ''}: ${detail}, the server does not read them, so whatever you wanted configured is not configured.`);
    if (unknownEnvFatal(env)) {
      // The same truthy decision config.ts already makes; spelling it out again
      // here meant one list living in two files.
      process.exit(1);
    }
  }

  const engine = buildEngine(env);
  if (accountIdLooksLikeClientId(engine.config)) {
    console.error('[polestar-mcp] POLESTAR_ACCOUNT_ID equals POLESTAR_CLIENT_ID. The gateway answers 403 AUTHZ_CLIENT_ID_MISMATCH when x-client-id is the OAuth client id; set POLESTAR_ACCOUNT_ID to the Account ID shown next to the Base URL in the Data Portal.');
  }
  engine.log(
    `${engine.config.fixturesDir ? 'fixture mode' : 'live'} · v${PKG_VERSION} · budget ${engine.config.budgetLimit}/day · cache ${engine.config.cacheDisabled ? 'off' : 'on'} · history ${engine.config.historyDir ? 'on' : 'off'}`,
  );
  if (engine.config.debug) {
    // Credentials are named by variable, never by value.
    engine.log(
      `debug: baseUrl=${engine.config.baseUrl} accountId=${engine.config.accountId === '' ? '(unset)' : 'set'} scopes=${engine.config.scopes?.length ?? 'derived'} timeoutMs=${engine.config.timeoutMs} minuteLimit=${engine.minute.snapshot().limit} units=${engine.config.units} redactVin=${engine.config.redactVin} allowLocation=${engine.config.allowLocation}`,
    );
  }

  if (engine.config.httpPort > 0) {
    await serveHttp(engine, engine.config.httpPort);
    return;
  }

  const surface = createMcpServer(engine);
  await surface.server.connect(new StdioServerTransport());
  startSampler(engine);
  installShutdown(async () => { engine.sampler?.stop(); await surface.close(); }, engine.log);
  // Both numbers come from the surface and the config that the lines above
  // actually used: this line used to restate "10,000 calls/day" and a hand-copied
  // tool list naming status twice, so it was wrong under POLESTAR_BUDGET.
  engine.log(
    `ready: ${surface.toolNames.length} tools over ${DOMAINS.length} domains · rate limit ${engine.config.budgetLimit.toLocaleString('en-US')} calls/day`,
  );
}

// Compare realpaths: a global install or `npx` launches this file through its bin
// symlink, so argv[1] is the link while import.meta.url is the resolved file. The
// old direct comparison silently failed there, and the documented `npx polestar-mcp`
// path started a process that ran nothing at all.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

const isDirect = invokedDirectly();
if (isDirect) {
  if (handleCliArgs()) process.exit(0);
  // stdout carries the JSON-RPC protocol, so nothing may be written there and
  // the process must not die on a rejection the transport cannot report.
  process.on('unhandledRejection', (reason) => {
    console.error('[polestar-mcp] unhandled rejection:', reason instanceof Error ? reason.message : reason);
  });
  main().catch((err: unknown) => {
    console.error('[polestar-mcp] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
