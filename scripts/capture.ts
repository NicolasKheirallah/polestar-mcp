/**
 * Refresh the endpoint capture and regenerate sanitized fixtures from it.
 *
 *   npm run capture                    # live: writes ../capture-<utc>/ and test/fixtures/dump/
 *   npm run capture -- --from <dir>    # re-sanitize an existing capture, no network
 *
 * The raw capture holds a live token and real position history, so it is written
 * outside the project tree and the tree only ever receives the sanitized copy:
 * synthetic VIN, zeroed ids, a fixed non-geographic position, and a timestamp
 * pinned to a constant so fixture assertions stay deterministic.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { TokenProvider } from '../src/auth.js';
import { PolestarClient } from '../src/client.js';
import { HttpTransport } from '../src/transport.js';
import { DOMAINS } from '../src/domains.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const fromArg = process.argv.indexOf('--from');
const STAGED = fromArg > -1 ? path.resolve(process.argv[fromArg + 1] ?? '') : undefined;

const SYNTHETIC_VIN = 'YSMTEST22PL000001';
const PINNED_EPOCH_S = 1_767_225_600; // 2026-01-01T00:00:00Z, so ages in tests are deterministic
const SYNTHETIC_EVENT = 'shardId-000000000000:00000000000000000000000000000000000000000000000000000000';

/** Replace anything identifying with a fixed synthetic equivalent. */
function sanitize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, key));
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(value)) return SYNTHETIC_VIN;
    if (/^(latitude|longitude)$/i.test(key)) return Number(key.toLowerCase() === 'latitude' ? '47.6062' : '-122.3321');
    if (/^(metaEventId)$/i.test(key)) return SYNTHETIC_EVENT;
    if (/^id$/i.test(key) && typeof value === 'string' && value.length > 8) return '00000000-0000-4000-8000-000000000000';
    if (/^(timestamp|updatedAt|startedAt|measurementDate|lastCycleCompleted)$/i.test(key) && typeof value === 'string' && /^\d{10,13}$/.test(value)) {
      return String(PINNED_EPOCH_S * (value.length > 10 ? 1000 : 1));
    }
    if (typeof value === 'string' && /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(value)) return 'owner@example.com';
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitize(v, k);
  return out;
}

const outDir = STAGED ?? path.resolve(ROOT, '..', `capture-${new Date().toISOString().replace(/[:.]/g, '-')}`);
if (!STAGED) mkdirSync(outDir, { recursive: true });

let responses: Record<string, unknown> = {};
if (STAGED) {
  for (const kind of ['telemetry', 'charging']) {
    for (const domain of DOMAINS.filter((d) => d.kind === kind)) {
      const file = path.join(STAGED, 'dataportal', kind, `${domain.name}.json`);
      if (existsSync(file)) responses[`${kind}/${domain.name}`] = JSON.parse(readFileSync(file, 'utf8'));
    }
  }
  const v = path.join(STAGED, 'dataportal', 'vehicles.json');
  if (existsSync(v)) responses['vehicles'] = JSON.parse(readFileSync(v, 'utf8'));
  console.log(`re-sanitizing ${Object.keys(responses).length} captured responses from ${STAGED} (no network)`);
} else {
  const env = { ...process.env };
  const secretsFile = path.join(process.env.HOME ?? '', '.config', 'polestar-mcp', '.env.secrets');
  if (existsSync(secretsFile)) {
    for (const line of readFileSync(secretsFile, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trim().startsWith('#')) {
        const k = line.slice(0, i).replace(/^export\s+/, '').trim();
        if (env[k] === undefined || env[k] === '') env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  const config = loadConfig(env);
  const transport = new HttpTransport(config.timeoutMs);
  const tokens = new TokenProvider(transport, { tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret: config.clientSecret, ...(config.scopes !== undefined ? { scopes: config.scopes } : {}) });
  const client = new PolestarClient(tokens, transport, { baseUrl: config.baseUrl, accountId: config.accountId });
  mkdirSync(path.join(outDir, 'dataportal', 'telemetry'), { recursive: true });
  mkdirSync(path.join(outDir, 'dataportal', 'charging'), { recursive: true });
  const vehicles = await client.vehicles();
  writeFileSync(path.join(outDir, 'dataportal', 'vehicles.json'), JSON.stringify({ data: vehicles, meta: { count: vehicles.length } }, null, 2));
  responses['vehicles'] = { data: vehicles, meta: { count: vehicles.length } };
  const vin = vehicles[0];
  if (vin === undefined) throw new Error('credential sees no vehicles; nothing to capture');
  for (const domain of DOMAINS) {
    try {
      const data = await client.domain(vin, domain.kind, domain.name);
      const body = data === null ? { error: { code: 'DATA_NOT_AVAILABLE', httpStatus: 404 } } : { data, meta: { domain: domain.name, vin } };
      writeFileSync(path.join(outDir, 'dataportal', domain.kind, `${domain.name}.json`), JSON.stringify(body, null, 2));
      responses[`${domain.kind}/${domain.name}`] = body;
      console.log(`  captured ${domain.kind}/${domain.name}`);
    } catch (err) {
      console.error(`  FAILED ${domain.kind}/${domain.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    dump_created_at: new Date().toISOString(), target_vin: vin,
    endpoints: Object.entries(responses).map(([k]) => ({ file: `dataportal/${k}.json`, endpoint: `/v1/vehicles/${vin}/${k}`, status: 200 })),
  }, null, 2));
  console.log(`raw capture (contains a real VIN): ${outDir}, keep it outside the project tree`);
}

// Write the sanitized fixtures the tests and offline demos actually use.
let written = 0;
for (const [key, body] of Object.entries(responses)) {
  const clean = sanitize(body);
  const target = key === 'vehicles'
    ? path.join(ROOT, 'test', 'fixtures', 'dump', 'dataportal', 'vehicles.json')
    : path.join(ROOT, 'test', 'fixtures', 'dump', 'dataportal', key + '.json');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(clean, null, 2) + '\n');
  written += 1;
}
const tokenFile = path.join(ROOT, 'test', 'fixtures', 'dump', 'token.json');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, JSON.stringify({ accessToken: 'test-token', expiresIn: 3600, tokenType: 'Bearer' }, null, 2) + '\n');
console.log(`CAPTURE_OK: ${written} sanitized responses written to test/fixtures/dump/`);
