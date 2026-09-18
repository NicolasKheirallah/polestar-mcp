import { readFileSync } from 'node:fs';

export const DEFAULT_BASE_URL = 'https://pc-api.polestar.com/eu-north-1/data-portal/m2m';

export interface Config {
  clientId: string;
  clientSecret: string;
  /** Sent verbatim as `x-client-id`. The gateway rejects a token's own clientId here. */
  accountId: string;
  /** Sent as `x-delegated-account-id` when running third-party credentials on shared VINs. */
  delegatedAccountId?: string;
  /** Accounts a caller may name per tool call with `delegated_account_id`; empty means never. */
  delegatedAccounts: string[];
  baseUrl: string;
  tokenUrl: string;
  /** When set, all reads are served from captured JSON responses in this directory (offline fixture mode). No real credential is needed; the dump supplies a token response. */
  fixturesDir?: string;
  /** Hard deadline per HTTP request, ms. */
  timeoutMs: number;
  /** Disable the response cache. */
  cacheDisabled: boolean;
  /** Daily live-call ceiling; the server fails closed at the limit. */
  budgetLimit: number;
  /** Per-minute ceiling the API also publishes (100 req/min). */
  budgetPerMinute: number;
  /** Explicit scope list override; defaults to the union of all domains. */
  scopes?: string[];
  /** Enable the local history store + background sampler in this directory. */
  historyDir?: string;
  /** Actually run the background sampler. Off by default: polling spends the shared quota. */
  sample: boolean;
  /** Seconds between sampler rounds (clamped 60..3600). */
  historySampleSeconds: number;
  /** Owner-facing labels for VINs: "VIN=My Car;OTHER=Spouse's". Identity the API never returns. */
  vehicleLabels: Record<string, string>;
  /**
   * Mask VINs in rendered output and in the structured envelope. `raw: true` is the
   * deliberate exception: that payload is handed back exactly as the API sent it,
   * identifier included, because its purpose is upstream fidelity.
   */
  redactVin: boolean;
  /** Omit position entirely: `get_location` refuses and coordinates are stripped from aggregates. */
  allowLocation: boolean;
  /** POLESTAR_LOG=debug: extra stderr diagnostics. Nothing else reads the flag. */
  debug: boolean;
  /** Preferred distance unit for humanized output. */
  units: 'km' | 'mi';
  /** Scaffold for future write endpoints; registers nothing today. */
  enableWrites: boolean;
  /** Serve Streamable HTTP on this port instead of stdio (0 = stdio). */
  httpPort: number;
  /** Interface to bind in HTTP mode. Defaults to loopback. */
  httpHost: string;
  /** Bearer token required in HTTP mode; required before a non-loopback bind. */
  httpToken: string;
  /** Make an unrecognized POLESTAR_* variable fatal instead of a warning. */
  strictEnv: boolean;
}

export class MissingConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Missing environment variables: ${missing.join(', ')}. ` +
        `POLESTAR_CLIENT_ID and POLESTAR_CLIENT_SECRET come from the Polestar Data Portal ` +
        `(data-portal.polestar.com → Data Portal API tab → credentials), and POLESTAR_ACCOUNT_ID is the ` +
        `Account ID shown on that same page: it is a separate identifier, sent as the x-client-id header. ` +
        `You can put all three in ~/.config/polestar-mcp/.env.secrets (read at startup; override the path ` +
        `with POLESTAR_ENV_FILE). Alternatively set POLESTAR_FIXTURES_DIR to run offline against captured responses.`,
    );
    this.name = 'MissingConfigError';
  }
}

/** A configuration value was present but unusable, reported before any request is made. */
export class InvalidConfigError extends Error {
  constructor(variable: string, problem: string, guidance: string) {
    super(`Invalid ${variable}: ${problem} ${guidance}`);
    this.name = 'InvalidConfigError';
  }
}

/** Every variable the server reads, so an unrecognized one can be flagged instead of ignored. */
export const KNOWN_ENV_VARIABLES: readonly string[] = [
  'POLESTAR_CLIENT_ID', 'POLESTAR_CLIENT_SECRET', 'POLESTAR_ACCOUNT_ID', 'POLESTAR_DELEGATED_ACCOUNT_ID', 'POLESTAR_DELEGATED_ACCOUNT_IDS',
  'POLESTAR_BASE_URL', 'POLESTAR_M2M_TOKEN_ENDPOINT', 'POLESTAR_FIXTURES_DIR', 'POLESTAR_ENV_FILE',
  'POLESTAR_TIMEOUT_MS', 'POLESTAR_BUDGET', 'POLESTAR_BUDGET_PER_MINUTE', 'POLESTAR_CACHE', 'POLESTAR_SCOPES', 'POLESTAR_HISTORY_DIR',
  'POLESTAR_HISTORY_SAMPLE_SECONDS', 'POLESTAR_SAMPLE', 'POLESTAR_VEHICLE_LABELS', 'POLESTAR_REDACT_VIN', 'POLESTAR_ALLOW_LOCATION', 'POLESTAR_UNITS',
  'POLESTAR_LOG', 'POLESTAR_ENABLE_WRITES', 'POLESTAR_HTTP_PORT', 'POLESTAR_HTTP_HOST', 'POLESTAR_HTTP_TOKEN', 'POLESTAR_STRICT_ENV',
];

/**
 * Unrecognized `POLESTAR_*` names, each paired with the closest real one. A typo
 * in a variable the server never reads is otherwise invisible: the value is
 * simply absent and the behaviour silently stays at its default.
 */
export function unknownEnvVariables(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; suggests?: string }> {
  const known = new Set(KNOWN_ENV_VARIABLES);
  const found: Array<{ name: string; suggests?: string }> = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith('POLESTAR_') || known.has(name) || env[name]?.trim() === '') continue;
    const suggests = closest(name, KNOWN_ENV_VARIABLES);
    found.push(suggests ? { name, suggests } : { name });
  }
  return found;
}

function closest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const c of candidates) {
    const score = commonPrefixLength(name, c) + commonPrefixLength(reverse(name), reverse(c));
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 10 ? best : undefined;
}

const reverse = (s: string): string => [...s].reverse().join('');
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * Loader for the local secrets file. Real environment variables always win; the
 * file only fills blanks.
 *
 * Handles the dotenv idioms a hand-rolled parser gets wrong: a leading
 * `export `, values quoted with either kind of quote, and trailing `#`
 * comments. A quoted value keeps its `#`, inside quotes it is data.
 */
export function loadEnvFileInto(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const declaration = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = declaration.indexOf('=');
    if (eq <= 0) continue;
    const key = declaration.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    // Parse the value quote-first, then handle comments. The previous order let a
    // trailing comment defeat quote detection (`K="a#b" # note` failed endsWith and
    // fell through to the comment branch, which only matched `#!`), so a real `#`
    // inside a quoted value was unreachable and the comment leaked into the value.
    const raw = declaration.slice(eq + 1).trim();
    let value: string;
    const quote = raw[0];
    if (quote === '"' || quote === "'") {
      const end = raw.indexOf(quote, 1);
      // Quoted: everything between the quotes is data, anything after is noise.
      // An unterminated quote keeps the remainder rather than dropping it silently.
      value = end > 0 ? raw.slice(1, end) : raw.slice(1).trim();
    } else {
      // Unquoted: whitespace before `#` starts a comment, so `pass#word` survives.
      const comment = /\s+#/.exec(raw);
      value = comment?.index !== undefined ? raw.slice(0, comment.index).trim() : raw;
    }

    const existing = env[key];
    if (existing === undefined || existing === '') env[key] = value;
  }
  return true;
}

/** Trim trailing slashes and prove the value is usable as a URL base. */
export function normalizeBaseUrl(raw: string, variable = 'POLESTAR_BASE_URL'): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidConfigError(
      variable,
      `${JSON.stringify(raw)} is not a valid absolute URL.`,
      'Expected for example https://pc-api.polestar.com/eu-north-1/data-portal/m2m',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InvalidConfigError(variable, `has scheme ${url.protocol}, expected https://.`, 'Check for a copied quote or a missing scheme.');
  }
  return trimmed;
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new InvalidConfigError(name, `${JSON.stringify(raw)} is not a number.`, `Remove it or set a number (default ${fallback}).`);
  }
  return parsed;
}

/** Port must be a real TCP port; a typo here otherwise starts a server on a nonsense socket. */
function httpPortOrThrow(env: NodeJS.ProcessEnv): number {
  const raw = env.POLESTAR_HTTP_PORT?.trim();
  if (raw === undefined || raw === '') return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidConfigError('POLESTAR_HTTP_PORT', `${JSON.stringify(raw)} is not a valid port.`, 'Use 0 for stdio or 1-65535 for HTTP.');
  }
  return port;
}

/**
 * `VIN=Label;VIN2=Label2`. The M2M contract returns bare VINs and nothing else,
 * so an owner's question ("is my car locked?") has no bridge to an identifier
 * unless somebody states it; this is that statement, kept in the env file.
 */
export function parseVehicleLabels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(';').map((p) => p.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const vin = pair.slice(0, i).trim().toUpperCase();
    const label = pair.slice(i + 1).trim();
    if (/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) && label !== '') out[vin] = label;
  }
  return out;
}

/** One truthy spelling list, shared by every flag and by the startup checks. */
export const TRUTHY_ENV = ['1', 'true', 'on'];

function flagEnv(raw: string | undefined, truthy: string[]): boolean {
  return truthy.includes((raw?.trim().toLowerCase() ?? ''));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fixturesDir = env.POLESTAR_FIXTURES_DIR?.trim() || undefined;
  const baseUrl = normalizeBaseUrl(env.POLESTAR_BASE_URL?.trim() || DEFAULT_BASE_URL);
  const clientId = env.POLESTAR_CLIENT_ID?.trim() || '';
  const clientSecret = env.POLESTAR_CLIENT_SECRET?.trim() || '';
  const accountId = env.POLESTAR_ACCOUNT_ID?.trim() || '';
  const delegatedAccountId = env.POLESTAR_DELEGATED_ACCOUNT_ID?.trim() || undefined;

  if (env.POLESTAR_UNITS !== undefined && !['km', 'mi', 'miles', ''].includes(env.POLESTAR_UNITS.trim().toLowerCase())) {
    throw new InvalidConfigError('POLESTAR_UNITS', `${JSON.stringify(env.POLESTAR_UNITS)} is not a supported unit.`, 'Use km or mi.');
  }

  if (!fixturesDir) {
    // x-client-id must carry the Data Portal Account ID. Falling back to the
    // OAuth clientId, as this loader once did, is answered live by the
    // gateway with 403 AUTHZ_CLIENT_ID_MISMATCH, so every call fails while the
    // configuration looks complete. Ask instead of guessing.
    const missing: string[] = [];
    if (!clientId) missing.push('POLESTAR_CLIENT_ID');
    if (!clientSecret) missing.push('POLESTAR_CLIENT_SECRET');
    if (!accountId) missing.push('POLESTAR_ACCOUNT_ID');
    if (missing.length > 0) throw new MissingConfigError(missing);
  }

  const resolvedAccountId = accountId || clientId || 'fixture-account';
  const unitsRaw = env.POLESTAR_UNITS?.trim().toLowerCase() ?? '';
  const allowLocation = !flagEnv(env.POLESTAR_ALLOW_LOCATION, ['0', 'false', 'off', 'disabled']);

  return {
    clientId,
    clientSecret,
    accountId: resolvedAccountId,
    baseUrl,
    tokenUrl: env.POLESTAR_M2M_TOKEN_ENDPOINT?.trim()
      ? normalizeBaseUrl(env.POLESTAR_M2M_TOKEN_ENDPOINT.trim(), 'POLESTAR_M2M_TOKEN_ENDPOINT')
      : `${baseUrl}/token`,
    timeoutMs: numberEnv(env, 'POLESTAR_TIMEOUT_MS', 15_000),
    budgetLimit: numberEnv(env, 'POLESTAR_BUDGET', 10_000),
    budgetPerMinute: numberEnv(env, 'POLESTAR_BUDGET_PER_MINUTE', 100),
    historySampleSeconds: numberEnv(env, 'POLESTAR_HISTORY_SAMPLE_SECONDS', 600),
    sample: flagEnv(env.POLESTAR_SAMPLE, TRUTHY_ENV),
    httpPort: httpPortOrThrow(env),
    httpHost: (env.POLESTAR_HTTP_HOST ?? '').trim() || '127.0.0.1',
    httpToken: (env.POLESTAR_HTTP_TOKEN ?? '').trim(),
    cacheDisabled: flagEnv(env.POLESTAR_CACHE, ['off', 'disabled', '0', 'false']),
    redactVin: flagEnv(env.POLESTAR_REDACT_VIN, ['1', 'true', 'on']),
    vehicleLabels: parseVehicleLabels(env.POLESTAR_VEHICLE_LABELS),
    allowLocation,
    units: unitsRaw === 'mi' || unitsRaw === 'miles' ? 'mi' : 'km',
    debug: (env.POLESTAR_LOG?.trim().toLowerCase() ?? '') === 'debug',
    enableWrites: flagEnv(env.POLESTAR_ENABLE_WRITES, TRUTHY_ENV),
    strictEnv: flagEnv(env.POLESTAR_STRICT_ENV, TRUTHY_ENV),
    delegatedAccounts: (env.POLESTAR_DELEGATED_ACCOUNT_IDS ?? '').split(/[;,\s]+/).map((v) => v.trim()).filter((v) => v.length > 0),
    ...(delegatedAccountId ? { delegatedAccountId } : {}),
    ...(env.POLESTAR_SCOPES?.trim()
      ? { scopes: env.POLESTAR_SCOPES.trim().split(/[\s,]+/).filter((s) => s.length > 0) }
      : {}),
    ...(env.POLESTAR_HISTORY_DIR?.trim() ? { historyDir: env.POLESTAR_HISTORY_DIR.trim() } : {}),
    ...(fixturesDir ? { fixturesDir } : {}),
  };
}

/**
 * Whether the resolved configuration can only be wrong: the gateway matches
 * `x-client-id` against the identity behind the token, so copying the OAuth
 * client ID into the Account ID is a guaranteed 403 on every vehicle route.
 */
export function accountIdLooksLikeClientId(config: Config): boolean {
  return config.fixturesDir === undefined && config.accountId !== '' && config.accountId === config.clientId;
}

/**
 * Whether an unrecognized variable should stop startup dead. `POLESTAR_STRICT_ENV`
 * is answered here because `loadConfig` has not run yet when the server reports
 * unknown names, this is the one decision the entry point makes without a
 * Config object, so it lives beside the flag that defines it.
 */
export function unknownEnvFatal(env: NodeJS.ProcessEnv): boolean {
  return flagEnv(env.POLESTAR_STRICT_ENV, TRUTHY_ENV);
}
