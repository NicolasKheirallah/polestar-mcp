#!/usr/bin/env node
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMcpHandler, McpServer, ProtocolError, ProtocolErrorCode, ResourceTemplate } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createStdioInputFilter } from './stdio-filter.js';
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { TokenProvider } from './auth.js';
import { BudgetMeter, MinuteWindowMeter } from './budget.js';
import { CachingTransport } from './caching-transport.js';
import { PolestarClient } from './client.js';
import { collectScopes, DOMAINS } from './domains.js';
import { createSubscriptionPoller, type SubscriptionDeps, type SubscriptionPoller } from './subscriptions.js';
import { bearerMatches, decideBind, decideHttpRequest, forbiddenBody, unauthenticatedBody, type BindSuccess } from './bind.js';
import { domainToolSpecs } from './domain-tools.js';
import { aggregateToolSpecs } from './aggregate-tools.js';
import { advisorToolSpecs } from './advisor-tools.js';
import { historyToolNames, historyToolSpecs } from './history-tools.js';
import { extraHistoryToolNames, extraHistoryToolSpecs } from './extra-history-tools.js';
import { systemToolSpecs } from './system-tools.js';
import { registerTools, toolNames, type ToolSpec } from './tools.js';
import { accountIdLooksLikeClientId, InvalidConfigError, KNOWN_ENV_VARIABLES, loadConfig, loadEnvFileInto, unknownEnvFatal, unknownEnvVariables, type Config } from './config.js';
import { HistorySampler, SAMPLED_DOMAINS } from './sampler.js';
import { HistoryStore } from './history.js';
import { readDomain } from './vehicle-read.js';
import { valueObservedAtMs } from './domain-data.js';
import { z } from 'zod';
import { FixtureTransport, HttpTransport, type Transport } from './transport.js';
import { RetryingTransport } from './retrying-transport.js';
import { maskFailureResult, resultText, type ToolDeps } from './tool-output.js';
import { maskVin, maskVinsInText, type Units } from './format.js';

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

/**
 * The stderr line for a failed background refresh.
 *
 * The request path carries the VIN, so a diagnostic about a cache refresh used
 * to write the identifier to stderr with POLESTAR_REDACT_VIN on. Masking the
 * path here keeps the diagnostic useful without widening the redaction promise.
 */
export function refreshFailureLine(url: string, message: string, redact: boolean): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* keep the raw value when it is not a URL */
  }
  return `background refresh failed for ${maskVinsInText(pathname, redact)}: ${maskVinsInText(message, redact)}`;
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
  // A fixtures path that does not exist used to start and fail one call at a
  // time with a filesystem error, which reads like a data problem instead of a
  // configuration one. Fail before anything is served. (A dump missing only its
  // token response still fails later, as the fixture adapter documents.)
  if (config.fixturesDir !== undefined) {
    let isDirectory = false;
    try {
      isDirectory = statSync(config.fixturesDir).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new InvalidConfigError(
        'POLESTAR_FIXTURES_DIR',
        `${JSON.stringify(config.fixturesDir)} does not exist or is not a directory.`,
        'Point it at a captured dump directory (for example test/fixtures/dump for the shipped synthetic one), or unset it for live mode.',
      );
    }
  }
  // The optional ledger makes the daily count survive a restart and be shared
  // by two processes holding the same credential; without it the meter is the
  // in-memory count it always was. Identity is hashed by the ledger itself.
  const budget = new BudgetMeter(config.budgetLimit, {
    ledger:
      config.budgetLedgerPath === undefined
        ? undefined
        : { path: config.budgetLedgerPath, clientId: config.clientId, accountId: config.accountId },
  });
  const minute = new MinuteWindowMeter(config.budgetPerMinute);
  const store = config.historyDir ? new HistoryStore(config.historyDir) : undefined;

  let transport: Transport;
  const base: Transport = config.fixturesDir
    ? new FixtureTransport(config.fixturesDir)
    : new HttpTransport(config.timeoutMs);
  // Retry and metering belong to every live attempt, not to the cache flag:
  // metering used to live inside a wrapper composed only when the cache was on,
  // so POLESTAR_CACHE=off silently removed the daily guard, the per-minute guard
  // and every retry. The cache now wraps the retry layer instead of owning it.
  // Fixture reads stay unmetered and retry-free: they spend no quota.
  const inner: Transport = config.fixturesDir ? base : new RetryingTransport(base, { budget, minute });
  const cache = new CachingTransport(inner, {
    onRefreshError: ({ url, message }) => {
      // A stale entry that cannot be refreshed is worth a line on stderr even
      // without debug on: the caller was served an answer it cannot tell is old.
      log(refreshFailureLine(url, message, config.redactVin));
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
    // The client raises VIN_MISMATCH and AMBIGUOUS_VIN; a mask that stopped at
    // the tool text would leave the identifier in the failure path.
    redactVin: config.redactVin,
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
            // observedAt is when this process made the read; valueObservedAt is
            // the car's own clock from the payload, so a fixture captured months
            // ago is not presented as a sample taken today. Optional: a payload
            // without a timestamp records only the read clock.
            store.append(vin, kind, name, { observedAt: Date.now(), valueObservedAt: valueObservedAtMs(data), metaEventId, data });
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
  /** Every prompt this surface registered; the history prompt exists only with a store. */
  prompts: readonly PromptSpec[];
  /** Prompt names, for a caller that only needs to know what answers prompts/list. */
  promptNames: readonly string[];
  /** The text the handshake returns. Built from the surface above, never hand-copied. */
  instructions: string;
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
  const deps: ToolDeps = {
    client: engine.client,
    redactVin: engine.config.redactVin,
    vehicleLabels: engine.config.vehicleLabels,
    delegatedAccounts: engine.config.delegatedAccounts,
    units: engine.config.units,
    allowLocation: engine.config.allowLocation,
  };

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
    // Three derived history tools read only the local store: trips, a
    // cross-domain timeline and the weekly digest. They need the same store
    // and the location switch the aggregate reads honour.
    ...(store === undefined
      ? []
      : [
          ...historyToolSpecs({ ...deps, store }),
          ...extraHistoryToolSpecs({
            ...deps,
            store,
            allowLocation: engine.config.allowLocation,
            backgroundSampling: engine.config.sample ? 'on' : 'off',
          }),
        ]),
  ];

  // The instructions are generated from the surface the process actually
  // registered: a hand-written copy had drifted and sent agents to a tool that
  // was never registered, and it promised a requestId on errors that do not
  // carry one. Built from the same values the registration used.
  const instructions = buildInstructions({
    aggregates: aggregates.map((spec) => spec.name),
    domainCount: DOMAINS.length,
    budgetLimit: engine.config.budgetLimit,
    minuteLimit: engine.minute.snapshot().limit,
    history: store !== undefined,
    units: engine.config.units,
    delegated: engine.config.delegatedAccounts.length > 0,
  });
  const prompts = promptSpecs({ history: store !== undefined, redactVin: engine.config.redactVin });

  const server = new McpServer(
    { name: 'polestar-mcp', version: PKG_VERSION },
    {
      instructions,
      // Advertise only what a sender exists for: nothing in this process sends
      // logging or list-changed notifications, and a client that waits for either
      // waits forever.
      capabilities: { resources: { subscribe: subscriptionsAllowed } },
    },
  );

  registerTools(
    server,
    engine.config.redactVin
      ? specs.map((spec) => ({
          ...spec,
          run: async (args: Record<string, unknown>, ctx) =>
            maskFailureResult(await spec.run(args, ctx), true),
        }))
      : specs,
  );
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
  registerPrompts(server, prompts);

  return {
    server,
    toolNames: toolNames(specs),
    prompts,
    promptNames: prompts.map((spec) => spec.name),
    instructions,
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
type ResourceKind = (typeof RESOURCE_KINDS)[number];

function domainsOf(kind: ResourceKind): string[] {
  return DOMAINS.filter((d) => d.kind === kind).map((d) => d.name);
}

/**
 * A vehicle's display label in resource text: the configured owner label when
 * one exists, otherwise the VIN itself, masked when POLESTAR_REDACT_VIN is on.
 *
 * The resource URI keeps the raw VIN and is the documented exception. It is not
 * cosmetic: `resolveVin` feeds the URI's VIN segment back through the client, so
 * masking the URI would make every listed resource unreadable and unsubscribable,
 * which is worse than a narrow, stated exception.
 */
function resourceLabel(vin: string, deps: ToolDeps): string {
  const label = deps.vehicleLabels[vin.toUpperCase()];
  return label !== undefined ? label : maskVin(vin, deps.redactVin);
}

export interface VehicleResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

type ResourceVariables = Record<string, string | string[] | undefined>;

/**
 * Every Domain of a kind for every vehicle the credential can reach.
 *
 * This used to slice to the first ten VINs with no cursor and no marker, so a
 * fleet credential silently saw 10 of its 12 cars and the listing looked complete.
 * There is no cursor in the SDK's resource listing callback, so the honest answer
 * is all of them; a failure to list vehicles is an error, not an empty array that
 * looks like "you own no cars".
 */
export async function listVehicleResources(engine: Engine, deps: ToolDeps, kind: ResourceKind): Promise<VehicleResource[]> {
  const vins = await engine.client.vehicles();
  return vins.flatMap((vin) => {
    const label = resourceLabel(vin, deps);
    return domainsOf(kind).map((domain) => ({
      uri: `polestar://vehicle/${vin}/${kind}/${domain}`,
      name: `${domain} (${label})`,
      description: `${kind}/${domain} for vehicle ${label}`,
      mimeType: 'text/plain',
    }));
  });
}

/** Completion values for a resource template variable; VINs obey POLESTAR_REDACT_VIN. */
export async function completeVehicleResource(
  engine: Engine,
  deps: ToolDeps,
  kind: ResourceKind,
  variable: 'vin' | 'domain',
  value: string,
): Promise<string[]> {
  if (variable === 'domain') {
    return domainsOf(kind).filter((d) => d.includes(value.toLowerCase())).slice(0, 20);
  }
  let vins: string[];
  try {
    vins = await engine.client.vehicles();
  } catch {
    return [];
  }
  return vins
    .map((vin) => maskVin(vin, deps.redactVin))
    .filter((vin) => vin.toLowerCase().includes(value.toLowerCase()))
    .slice(0, 20);
}

/**
 * One resource read: the same read the matching get_* tool performs, so a
 * resource gains the age header, the owner label, the redaction and the
 * delegation check instead of a second, smaller implementation.
 *
 * An unknown Domain is a protocol error rather than content: answering with a
 * text block made a typo look like a successful read whose text happened to say
 * "Unknown domain", which no client can branch on.
 */
export async function readVehicleResource(
  deps: ToolDeps,
  kind: ResourceKind,
  uri: URL,
  variables: ResourceVariables,
): Promise<{ contents: Array<{ uri: string; text: string; mimeType: string }> }> {
  const rawVin = variables.vin;
  let vin: string;
  try {
    vin = decodeURIComponent(String(Array.isArray(rawVin) ? rawVin[0] ?? '' : rawVin ?? ''));
  } catch {
    // A malformed percent escape is the caller's invalid argument, not an
    // internal failure: the subscription path already answers -32602 for the
    // same input, and the read path must not turn it into -32603.
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'The VIN segment of the resource URI has invalid percent-encoding.',
    );
  }
  const domain = String(Array.isArray(variables.domain) ? variables.domain[0] ?? '' : variables.domain ?? '');
  const spec = DOMAINS.find((d) => d.kind === kind && d.name === domain);
  if (!spec) {
    const exception =
      deps.redactVin
        ? ' Resource names, descriptions and completions are masked because POLESTAR_REDACT_VIN is on; the resource URI keeps the raw VIN as the documented exception.'
        : '';
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Unknown ${kind} domain ${JSON.stringify(domain)}. Use one of the resource domains listed in resources/list.${exception}`,
    );
  }
  const outcome = await readDomain(deps, spec, vin === '' ? {} : { vin }, undefined);
  const body = outcome.ok ? outcome.reading.text : resultText(outcome.result);
  // A failed resource read renders the same failure text a tool would, so it
  // gets the same redaction: an upstream message or a caller-supplied VIN can
  // reach this surface too.
  return {
    contents: [{ uri: uri.href, text: outcome.ok ? body : maskVinsInText(body, deps.redactVin), mimeType: 'text/plain' }],
  };
}

function registerResources(
  server: McpServer,
  engine: Engine,
  deps: ToolDeps,
  subscriptions: SubscriptionPoller,
  subscriptionsAllowed: boolean,
): void {
  for (const kind of RESOURCE_KINDS) {
    server.registerResource(
      `Vehicle ${kind} domains`,
      new ResourceTemplate(`polestar://vehicle/{vin}/${kind}/{domain}`, {
        list: async () => ({ resources: await listVehicleResources(engine, deps, kind) }),
        complete: {
          vin: (value: string) => completeVehicleResource(engine, deps, kind, 'vin', value),
          domain: (value: string) => completeVehicleResource(engine, deps, kind, 'domain', value),
        },
      }),
      { description: `Live ${kind} for one vehicle and domain, humanized. The URI keeps the raw VIN.`, mimeType: 'text/plain' },
      (uri, variables) => readVehicleResource(deps, kind, uri, variables as ResourceVariables),
    );
  }

  // Registered only where a subscription can actually outlive the request. The
  // capability above is the other half of the same answer, so a client learns
  // this from the handshake rather than from a subscription that never fires.
  if (!subscriptionsAllowed) return;
  server.server.setRequestHandler('resources/subscribe', async (request: { params: { uri: string } }) => {
    // A bad URI or a full subscription set throws a JSON-RPC invalid-params
    // error; it used to start a timer that polled nothing forever.
    await subscriptions.subscribe(request.params.uri);
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', async (request: { params: { uri: string } }) => {
    subscriptions.unsubscribe(request.params.uri);
    return {};
  });
}

/**
 * What the initialize result tells the model about this process.
 *
 * Every sentence has to be true of the surface that registered it: the history
 * sentence appears only with a history store, units follow POLESTAR_UNITS, the
 * delegation sentence appears only when the operator configured accounts, and the
 * requestId promise is conditional because a locally minted failure carries none.
 * `vin` is described as optional rather than telling every caller to start with
 * list_vehicles, which forced a live call on a single-car credential.
 */
export interface InstructionsInput {
  aggregates: readonly string[];
  domainCount: number;
  budgetLimit: number;
  minuteLimit: number;
  history: boolean;
  units: Units;
  delegated: boolean;
}

export function buildInstructions(input: InstructionsInput): string {
  return [
    'Polestar Data Portal (M2M) is READ-ONLY: every tool is a GET, no command is sent to the car.',
    'A vin argument is optional when the credential sees exactly one vehicle; list_vehicles names the vehicles this credential can reach.',
    'Domain data is reported by the car, not by the API: fields are absent when unreported, and a whole domain can answer DATA_NOT_AVAILABLE. That is normal, not an error.',
    `Prefer ${input.aggregates.join(' or ')} over the ${input.domainCount} individual domain reads; every live call spends a shared allowance of ${input.budgetLimit.toLocaleString('en-US')} calls/day and ${input.minuteLimit}/minute, and polestar_status reports what is left.`,
    'Every payload carries an age: charging configuration can be days old while telemetry is minutes old, so read the age before treating a value as current.',
    ...(input.history
      ? [`History tools (${[...historyToolNames, ...extraHistoryToolNames].join(', ')}) answer from the local history store and are empty until a read has been recorded.`]
      : []),
    `Distances are rendered in ${input.units === 'mi' ? 'miles' : 'kilometres'}.`,
    ...(input.delegated
      ? ["A delegated_account_id from POLESTAR_DELEGATED_ACCOUNT_IDS reads that account's shared vehicles for one call."]
      : []),
    'Failures return structured JSON with a code and httpStatus, plus requestId when the upstream sent one; quote it only then.',
  ].join(' ');
}

/** One prompt as a value: the same array is what the server registers and what a test renders. */
export interface PromptSpec {
  name: string;
  title: string;
  description: string;
  argsSchema: z.ZodRawShape;
  build(args: Record<string, unknown> | undefined): {
    messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
  };
}

/**
 * The prompt surface for one running configuration.
 *
 * `battery-health-report` is built only when the history tools are, because a
 * default start used to register a prompt telling the model to call two tools
 * that were never registered.
 */
export function promptSpecs(options: { history: boolean; redactVin?: boolean }): PromptSpec[] {
  const first = (value: unknown): string | undefined => (Array.isArray(value) ? (value[0] as string | undefined) : typeof value === 'string' ? value : undefined);
  const message = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });
  // A caller-supplied VIN lands in the transcript through the prompt message, so
  // it follows the same redaction rule as tool results instead of echoing it.
  const shownVin = (value: unknown): string | undefined => {
    const vin = first(value);
    return vin === undefined ? undefined : maskVinsInText(vin, options.redactVin === true);
  };

  const specs: PromptSpec[] = [
    {
      name: 'car-status',
      title: 'Car status briefing',
      description: 'A one-glance briefing: charge, range, security, and anything needing attention.',
      argsSchema: { vin: z.string().optional() },
      build(args) {
        const vin = shownVin(args?.vin);
        return message(
          `Give me a status briefing for my Polestar${vin ? ` (VIN ${vin})` : ''}. Use get_car_status, then is_car_secure, then get_needs_attention, and finish with a two-line summary plus anything that needs action.`,
        );
      },
    },
    {
      name: 'charge-plan',
      title: 'Cheapest charge plan',
      description: 'Plan the cheapest charging hours for tonight given spot prices.',
      argsSchema: { vin: z.string().optional(), prices: z.string().optional() },
      build(args) {
        const vin = shownVin(args?.vin);
        const prices = first(args?.prices);
        return message(
          `I want to charge my Polestar as cheaply as possible tonight${vin ? ` (VIN ${vin})` : ''}. Spot prices from my tariff provider: ${prices ?? 'ask me for hourly prices as {"startsAt": ISO, "price": number} pairs before planning'}. Call plan_cheapest_charge with these prices and present the result as a simple schedule with estimated cost.`,
        );
      },
    },
  ];

  if (options.history) {
    specs.push({
      name: 'battery-health-report',
      title: 'Battery health report',
      description: 'Degradation and charging-session report from recorded history.',
      argsSchema: { vin: z.string().optional() },
      build(args) {
        const vin = shownVin(args?.vin);
        return message(
          `Report on my Polestar's battery health${vin ? ` (VIN ${vin})` : ''}: call get_degradation_report and get_charging_sessions, summarize the implied capacity trend, and say clearly whether there is enough history to conclude anything.`,
        );
      },
    });
  }
  return specs;
}

function registerPrompts(server: McpServer, specs: readonly PromptSpec[]): void {
  for (const spec of specs) {
    server.registerPrompt(
      spec.name,
      { title: spec.title, description: spec.description, argsSchema: z.object(spec.argsSchema) },
      (args) => spec.build(args as Record<string, unknown> | undefined),
    );
  }
}

/**
 * Upper bound on one JSON-RPC request body in HTTP mode, 4 MiB.
 *
 * A JSON-RPC tool call is a VIN, a domain name and sometimes an hourly price
 * array; 4 MiB is far above the largest legitimate call and matches the SDK
 * transport's own default. The limit is pinned here so it is an explicit,
 * documented number rather than an inherited one, and so an oversized body is a
 * clear JSON error instead of a slow buffer.
 */
export const MAX_HTTP_REQUEST_BYTES = 4 * 1024 * 1024;

/** The 413 body an oversized request gets: the same JSON-RPC error shape a client parses elsewhere. */
export function payloadTooLargeBody(limitBytes: number = MAX_HTTP_REQUEST_BYTES): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32000,
      message: `Payload Too Large: one request body must not exceed ${limitBytes} bytes.`,
    },
  });
}

/**
 * The HTTP request gate for one bound listener: Host, Origin and bearer token,
 * all decided from headers before the transport reads a byte of the body.
 *
 * Exported because the guards have to be exercised over a real socket in a way
 * `decideHttpRequest` alone cannot prove: this is the function the listener
 * actually installs first.
 */
/** Optional per-listener limits; production uses the constants, a test may lower them. */
export interface HttpHandlerOptions {
  maxRequestBytes?: number;
}

export function createHttpHandler(engine: Engine, bind: BindSuccess, options: HttpHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const token = bind.token;
  const maxRequestBytes = options.maxRequestBytes ?? MAX_HTTP_REQUEST_BYTES;
  const handler = createMcpHandler(
    () => createMcpServer(engine, { subscriptions: false }).server,
    { legacy: 'stateless', maxRequestBodySize: maxRequestBytes },
  );
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: maxRequestBytes,
    onerror: (err) => engine.log(`HTTP adapter failure: ${err.message}`),
  });
  return (req: IncomingMessage, res: ServerResponse) => {
    const guard = decideHttpRequest({
      boundHost: bind.host,
      allowedOrigins: engine.config.httpAllowedOrigins,
      hostHeader: req.headers.host,
      originHeader: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    });
    if (!guard.ok) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(forbiddenBody(guard.message));
      return;
    }
    if (token !== undefined && !bearerMatches(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined, token)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end(unauthenticatedBody());
      return;
    }
    // An oversized body is refused from its declared length alone, so a 5 MB
    // call costs one header parse instead of a buffer. A chunked body declares
    // no length; the transport's own cap below stops that read at the same
    // bound. Both answers are 413 with a JSON-RPC error body.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxRequestBytes) {
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end(payloadTooLargeBody(maxRequestBytes));
      return;
    }
    // Serving goes through the SDK's handler entry, which owns both eras: a
    // legacy 2025 request is answered per request by a fresh surface (the
    // stateless idiom this mode has always used), and a modern 2026-07-28
    // request is served with its per-request envelope. One surface per request
    // is deliberate and measured: createMcpServer costs median 0.19 ms / p95
    // 1.10 ms, and a whole initialize POST median 0.48 ms / p95 1.74 ms, so the
    // fresh instance is cheap next to the protocol exchange. The handler itself
    // is created once per server, because it owns the modern stream router.
    // The adapter's Node types require a defined method; Node always sets one
    // for a request it hands to a listener, and the adapter only needs the
    // shape it reads.
    void nodeHandler(
      req as unknown as Parameters<typeof nodeHandler>[0],
      res as unknown as Parameters<typeof nodeHandler>[1],
    ).catch((err: unknown) => {
      engine.log(`HTTP request failed: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  };
}

/** Serve the same MCP surface over Streamable HTTP (stateless mode). */
async function serveHttp(engine: Engine, port: number): Promise<void> {
  // The rule lives in bind.ts as a function so it can be tested without opening
  // a socket: binding a location-reading server to a routable address with no
  // token must be refused before anything listens.
  const bind = decideBind({ host: engine.config.httpHost, token: engine.config.httpToken });
  if (!bind.ok) throw new Error(bind.reason);
  const { host } = bind;
  const guarded = createHttpServer(createHttpHandler(engine, bind));
  if (bind.token !== undefined) engine.log('HTTP mode: Authorization: Bearer <POLESTAR_HTTP_TOKEN> required');
  const origins = engine.config.httpAllowedOrigins;
  engine.log(
    origins.length === 0
      ? 'HTTP mode: Origin must match the request host; set POLESTAR_HTTP_ALLOWED_ORIGINS to admit a browser client'
      : `HTTP mode: allowed origins ${origins.join(', ')}`,
  );
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
    console.log(helpText());
    return true;
  }
  return false;
}

/**
 * The `--help` text, generated from the configuration registry rather than
 * restated by hand.
 *
 * It used to show four hand-picked settings and claim every variable was listed
 * in `.env.example` while that file was short by five names. The complete list
 * now comes from KNOWN_ENV_VARIABLES, and the `.env.example` sentence no longer
 * asserts completeness, because the file is owned by the release lane and a
 * claim about it can go stale without this file changing.
 */
export function helpText(): string {
  return [
    `polestar-mcp ${PKG_VERSION}, read-only Polestar Data Portal MCP server over stdio (or Streamable HTTP).`,
    '',
    'There are no positional arguments; configuration is environment-only.',
    '  POLESTAR_CLIENT_ID / POLESTAR_CLIENT_SECRET / POLESTAR_ACCOUNT_ID   required for live mode',
    '  POLESTAR_FIXTURES_DIR=<dir>                        offline mode, no credentials needed',
    '  POLESTAR_HTTP_PORT=<port>                          serve Streamable HTTP instead of stdio',
    '  POLESTAR_ALLOW_LOCATION=false                      never request or return vehicle position',
    '',
    `Every variable the server reads (${KNOWN_ENV_VARIABLES.length} names):`,
    ...wrapNames(KNOWN_ENV_VARIABLES),
    '',
    'The same names are documented in .env.example and docs/getting-started.md, as a template to',
    'copy; real environment variables always win, and an unrecognized POLESTAR_* name is reported',
    'at startup because a typo is otherwise invisible.',
    `HTTP mode caps one request body at ${MAX_HTTP_REQUEST_BYTES / (1024 * 1024)} MiB; a larger body gets a 413 JSON error.`,
    'Docs: docs/getting-started.md, docs/tools-reference.md, docs/upstream-api.md.',
  ].join('\n');
}

/** Wrap the complete variable list over indented lines, so it stays readable and copyable. */
function wrapNames(names: readonly string[], width = 92): string[] {
  const lines: string[] = [];
  let current = '';
  for (const name of names) {
    if (current !== '' && current.length + 1 + name.length > width) {
      lines.push(current);
      current = name;
      continue;
    }
    current = current === '' ? name : `${current} ${name}`;
  }
  if (current !== '') lines.push(current);
  return lines.map((line) => `  ${line}`);
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
  // Answer malformed lines and batches on the wire before the SDK transport sees
  // them: its read buffer drops invalid JSON silently and its message validator
  // rejects arrays without a reply.
  const filtered = createStdioInputFilter(process.stdin, process.stdout);
  const transport = new StdioServerTransport(filtered.input, process.stdout);
  transport.onerror = (error: Error) => engine.log(`stdio transport error: ${error.message}`);
  await surface.server.connect(transport);
  startSampler(engine);
  installShutdown(async () => {
    engine.sampler?.stop();
    filtered.dispose();
    await surface.close();
  }, engine.log);
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
