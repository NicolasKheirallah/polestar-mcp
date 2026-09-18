import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountIdLooksLikeClientId,
  InvalidConfigError,
  loadConfig,
  loadEnvFileInto,
  MissingConfigError,
  normalizeBaseUrl,
  unknownEnvVariables,
} from '../src/config.js';
import { collectScopes, DOMAINS, domainToolNames, toolName } from '../src/domains.js';

/** The three variables live mode needs; the Account ID is not the OAuth client ID. */
const LIVE = { POLESTAR_CLIENT_ID: 'id', POLESTAR_CLIENT_SECRET: 'secret', POLESTAR_ACCOUNT_ID: '0a7f-0000-uuid' };

test('config defaults: budget 10000, cache on, timeout 15s, stdio mode', () => {
  const config = loadConfig({ ...LIVE });
  assert.equal(config.budgetLimit, 10_000);
  assert.equal(config.cacheDisabled, false);
  assert.equal(config.timeoutMs, 15_000);
  assert.equal(config.httpPort, 0);
  assert.equal(config.redactVin, false);
  assert.equal(config.allowLocation, true);
  assert.equal(config.units, 'km');
  assert.equal(config.historySampleSeconds, 600);
  assert.equal(config.scopes, undefined);
  assert.equal(config.tokenUrl, `${config.baseUrl}/token`);
});

test('config parses flags: cache off, redact, writes, scopes narrowing, custom budget', () => {
  const config = loadConfig({
    ...LIVE,
    POLESTAR_CACHE: 'off',
    POLESTAR_REDACT_VIN: 'true',
    POLESTAR_ENABLE_WRITES: '1',
    POLESTAR_BUDGET: '500',
    POLESTAR_SCOPES: 'pdp-telemetry/battery pdp-charging/targetSoc',
    POLESTAR_HISTORY_SAMPLE_SECONDS: '120',
    POLESTAR_HTTP_PORT: '8420',
    POLESTAR_ALLOW_LOCATION: 'false',
    POLESTAR_UNITS: 'mi',
  });
  assert.equal(config.cacheDisabled, true);
  assert.equal(config.redactVin, true);
  assert.equal(config.enableWrites, true);
  assert.equal(config.budgetLimit, 500);
  assert.deepEqual(config.scopes, ['pdp-telemetry/battery', 'pdp-charging/targetSoc']);
  assert.equal(config.historySampleSeconds, 120);
  assert.equal(config.httpPort, 8420);
  assert.equal(config.allowLocation, false);
  assert.equal(config.units, 'mi');
});

test('live mode requires the Account ID: it is not the OAuth client ID', () => {
  // The gateway answers 403 AUTHZ_CLIENT_ID_MISMATCH when x-client-id carries
  // the token's own client id, so a config that silently falls back to it looks
  // correct and fails every call. Requiring it turns that into a startup error.
  assert.throws(
    () => loadConfig({ POLESTAR_CLIENT_ID: 'id', POLESTAR_CLIENT_SECRET: 'secret' }),
    (err: unknown) => err instanceof MissingConfigError && /POLESTAR_ACCOUNT_ID/.test(err.message),
  );
  const noAccount = loadConfig({ POLESTAR_FIXTURES_DIR: '/tmp/whatever' });
  assert.equal(noAccount.accountId, 'fixture-account'); // offline mode needs no identity
  assert.equal(accountIdLooksLikeClientId(loadConfig({ ...LIVE })), false);
  assert.equal(accountIdLooksLikeClientId(loadConfig({ POLESTAR_CLIENT_ID: 'same', POLESTAR_CLIENT_SECRET: 's', POLESTAR_ACCOUNT_ID: 'same' })), true);
});

test('base URL is normalized and validated instead of being concatenated blindly', () => {
  const config = loadConfig({ ...LIVE, POLESTAR_BASE_URL: 'https://api.example/m2m///' });
  assert.equal(config.baseUrl, 'https://api.example/m2m');
  assert.equal(config.tokenUrl, 'https://api.example/m2m/token');
  assert.throws(() => normalizeBaseUrl('not-a-url'), InvalidConfigError);
  assert.throws(() => normalizeBaseUrl('ftp://api.example/m2m'), InvalidConfigError);
  const override = loadConfig({ ...LIVE, POLESTAR_M2M_TOKEN_ENDPOINT: 'https://auth.example/token' });
  assert.equal(override.tokenUrl, 'https://auth.example/token'); // the endpoint is configurable, and actually read
});

test('secrets file: export prefix, quotes and inline comments do not corrupt values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polestar-env-'));
  const file = join(dir, '.env.secrets');
  writeFileSync(
    file,
    [
      '# a comment',
      'export POLESTAR_CLIENT_ID=cid',
      'POLESTAR_CLIENT_SECRET="quoted secret"',
      "POLESTAR_ACCOUNT_ID=0a7f-uuid  # the Account ID, not the client id",
      'POLESTAR_HISTORY_DIR=/tmp/data # stripped: unquoted hash starts a comment',
      'POLESTAR_SCOPES="pdp-telemetry/battery#keep-me" # stripped',
      'MALFORMED LINE WITHOUT EQUALS',
    ].join('\n'),
    'utf8',
  );
  const env: Record<string, string> = { POLESTAR_CLIENT_SECRET: 'from-real-env' };
  assert.equal(loadEnvFileInto(file, env), true);
  assert.equal(env.POLESTAR_CLIENT_ID, 'cid');
  assert.equal(env.POLESTAR_CLIENT_SECRET, 'from-real-env'); // real environment always wins
  assert.equal(env.POLESTAR_ACCOUNT_ID, '0a7f-uuid');
  assert.equal(env.POLESTAR_HISTORY_DIR, '/tmp/data');
  assert.equal(env.POLESTAR_SCOPES, 'pdp-telemetry/battery#keep-me'); // quoted values keep their '#'
  assert.equal(Object.keys(env).some((k) => k.includes('MALFORMED')), false, 'a line without = is ignored, not loaded as a key');
  assert.equal(loadEnvFileInto(join(dir, 'does-not-exist'), {}), false);
});

test('unrecognized POLESTAR_* variables are reported, with the closest real name', () => {
  const unknown = unknownEnvVariables({ ...LIVE, POLESTAR_TIMOUT_MS: '1', POLESTAR_M2M_TOKEN_ENDPOINT: 'https://x/token' });
  const names = unknown.map((u) => u.name);
  assert.ok(names.includes('POLESTAR_TIMOUT_MS'), 'typo surfaces');
  assert.equal(unknown.find((u) => u.name === 'POLESTAR_TIMOUT_MS')?.suggests, 'POLESTAR_TIMEOUT_MS');
  assert.equal(names.includes('POLESTAR_M2M_TOKEN_ENDPOINT'), false, 'known variables are not flagged');
  assert.deepEqual(unknownEnvVariables({ ...LIVE }), []);
});

test('numeric and port variables fail loudly instead of silently defaulting', () => {
  assert.throws(() => loadConfig({ ...LIVE, POLESTAR_TIMEOUT_MS: 'fast' }), InvalidConfigError);
  assert.throws(() => loadConfig({ ...LIVE, POLESTAR_HTTP_PORT: '999999' }), InvalidConfigError);
  assert.throws(() => loadConfig({ ...LIVE, POLESTAR_UNITS: 'furlongs' }), InvalidConfigError);
});

test('registry: 15 domains, deduped scopes, derived tool names', () => {
  assert.equal(DOMAINS.length, 15);
  assert.equal(collectScopes().length, 15);
  assert.equal(new Set(collectScopes()).size, 15);
  const names = domainToolNames();
  assert.equal(names.length, 15);
  assert.ok(names.includes('get_battery'));
  assert.ok(names.includes('get_target_soc'));
  assert.ok(names.includes('get_is_at_charge_location'));
  assert.equal(toolName(DOMAINS.find((d) => d.name === 'target-soc')!), 'get_target_soc');
});
