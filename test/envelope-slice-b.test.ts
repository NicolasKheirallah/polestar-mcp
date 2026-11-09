import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolestarApiError } from '../src/client.js';
import type { PolestarClient } from '../src/client.js';
import { domainToolSpecs } from '../src/domain-tools.js';
import { describeError, errorResult, type ToolDeps } from '../src/tool-output.js';
import { toolSpec } from '../src/tools.js';
import { systemToolSpecs, type SystemDeps } from '../src/system-tools.js';

/**
 * The envelope slice of the surface backlog: the status clock, the failure
 * wording, and the VIN list. Each test names the behaviour a maintainer relied
 * on before the fix, so a regression fails here rather than in a transcript.
 */

const NOW_MS = Date.parse('2026-01-01T12:00:00Z');
const VIN = 'YSMTEST22PL000001';

function statusDeps(over: Partial<SystemDeps> = {}): SystemDeps {
  return {
    client: {} as unknown as PolestarClient,
    redactVin: false,
    vehicleLabels: {},
    delegatedAccounts: [],
    units: 'km',
    budget: { snapshot: () => ({ used: 2_500, limit: 10_000, remaining: 7_500, fractionUsed: 0.25, resetsAtUtc: '2026-01-02T00:00:00Z' }) },
    minute: { snapshot: () => ({ used: 12, limit: 100 }) },
    cacheStats: { enabled: false, hits: 0, staleServed: 0, misses: 0, refreshes: 0, entries: 0 },
    tokenExpiresAt: () => NOW_MS + 12 * 60_000,
    fixtureMode: false,
    nowMs: () => NOW_MS,
    ...over,
  } as unknown as SystemDeps;
}

async function statusText(deps: SystemDeps): Promise<string> {
  const out = await toolSpec(systemToolSpecs(deps), 'polestar_status').run({}, {});
  return out.content[0]!.text;
}

test('polestar_status names POLESTAR_CACHE, the switch the server actually reads', async () => {
  const text = await statusText(statusDeps());
  assert.match(text, /Cache: off \(POLESTAR_CACHE=off, or fixture mode without a history store\)/);
  assert.doesNotMatch(text, /POLESTAR_CACHE_DISABLED/, 'that variable does not exist in config.ts');
});

test('polestar_status reports token life minus the five minute skew the provider enforces', async () => {
  // auth.ts stops trusting a token 300000 ms before its advertised expiry, so a
  // 12 minute token has 7 trusted minutes left. Reporting 12 overstated it.
  const text = await statusText(statusDeps());
  assert.match(text, /Token: trusted ~7 more min/);
  assert.doesNotMatch(text, /trusted ~12 more min/);

  // A token inside the skew window is already expired as far as the provider is
  // concerned, so the tool must not report negative time.
  const insideSkew = await statusText(statusDeps({ tokenExpiresAt: () => NOW_MS + 60_000 }));
  assert.match(insideSkew, /Token: trusted ~0 more min/);

  const none = await statusText(statusDeps({ tokenExpiresAt: () => undefined }));
  assert.match(none, /Token: not yet issued/);
});

test('polestar_status keeps the cache arithmetic it already reported', async () => {
  const text = await statusText(
    statusDeps({ cacheStats: { enabled: true, hits: 6, staleServed: 2, misses: 2, refreshes: 1, entries: 4 } }),
  );
  assert.match(text, /Cache: 6 hits \+ 2 stale-served of 10 reads \(80%\), 2 live misses, 1 refreshes, 4 entries/);
});

test('a minted refusal is presented as the server refusing it, not as a Polestar API error', () => {
  const minted = describeError(new PolestarApiError('INVALID_VIN', '"NOTAVIN" is not a plausible VIN.', 400));
  assert.match(minted, /^Server refused INVALID_VIN: /);
  assert.doesNotMatch(minted, /Polestar API error/);
  assert.doesNotMatch(minted, /HTTP/, 'a minted failure never carries an observed HTTP status');
});

test('an upstream failure keeps the Polestar API label and its observed status', () => {
  const upstream = describeError(
    new PolestarApiError('AUTHZ_VIN_UNAUTHORIZED', 'The credential cannot see that VIN.', 403, 'req-403'),
  );
  assert.match(upstream, /^Polestar API error AUTHZ_VIN_UNAUTHORIZED \(HTTP 403\): /);
  assert.match(upstream, /requestId: req-403/);
  assert.doesNotMatch(upstream, /Server refused/);
});

test('requestId appears only when the failure carries one', () => {
  const mintedWithout = describeError(new PolestarApiError('DELEGATION_NOT_ALLOWED', 'not allowlisted', 403));
  assert.doesNotMatch(mintedWithout, /requestId/, 'minted failures do not have a requestId to report');

  const mintedWith = describeError(new PolestarApiError('VIN_MISMATCH', 'wrong car', 200, 'req-minted'));
  assert.match(mintedWith, /requestId: req-minted/);

  const upstreamWithout = describeError(new PolestarApiError('UNAUTHORIZED', 'rejected', 401));
  assert.doesNotMatch(upstreamWithout, /requestId/);
});

test('the error result carries the server-refusal wording in its text and code', async () => {
  const out = errorResult(new PolestarApiError('INVALID_VIN', '"NOTAVIN" is not a plausible VIN.', 400));
  assert.equal(out.isError, true);
  assert.equal(out.structuredContent?.code, 'INVALID_VIN');
  assert.match(out.content[0]!.text, /Server refused INVALID_VIN/);
  assert.doesNotMatch(out.content[0]!.text, /Polestar API error/);
});

function fakeClient(vehiclesByAccount: Record<string, string[]>, calls: string[]): PolestarClient {
  const make = (account: string | undefined): PolestarClient =>
    ({
      vehicles: async () => {
        calls.push(account ?? 'owner');
        return vehiclesByAccount[account ?? 'owner'] ?? [];
      },
      resolveVin: async (vin?: string) => vin ?? VIN,
      domain: async () => null,
      forDelegation: (id: string) => {
        calls.push(`forDelegation:${id}`);
        return make(id);
      },
    }) as unknown as PolestarClient;
  return make(undefined);
}

function domainDeps(client: PolestarClient, over: Partial<ToolDeps> = {}): ToolDeps {
  return { client, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km', ...over };
}

test('list_vehicles declares the delegated account argument the other car tools take', () => {
  const deps = domainDeps(fakeClient({ owner: [VIN] }, []));
  const spec = toolSpec(domainToolSpecs(deps), 'list_vehicles');
  assert.ok(spec.args?.delegated_account_id !== undefined, 'a delegated credential must be able to name the account');
});

test('a delegated list_vehicles reads through forDelegation and returns that account history', async () => {
  const partnerVin = 'YSMTEST22PL000009';
  const calls: string[] = [];
  const deps = domainDeps(fakeClient({ owner: [VIN], 'partner-a': [partnerVin] }, calls), {
    delegatedAccounts: ['partner-a'],
  });
  const spec = toolSpec(domainToolSpecs(deps), 'list_vehicles');
  const out = await spec.run({ delegated_account_id: 'partner-a' }, {});
  assert.equal(out.isError, undefined);
  assert.deepEqual(calls, ['forDelegation:partner-a', 'partner-a']);
  const data = out.structuredContent?.data as { count?: number; vehicles?: Array<{ vin?: string }> } | undefined;
  assert.equal(data?.count, 1);
  assert.deepEqual(data?.vehicles, [{ vin: partnerVin }]);
  assert.match(out.content[0]!.text, new RegExp(partnerVin));
});

test('a delegation outside the allowlist is refused by name, not sent', async () => {
  const calls: string[] = [];
  const deps = domainDeps(fakeClient({ owner: [VIN] }, calls), { delegatedAccounts: ['partner-a'] });
  const spec = toolSpec(domainToolSpecs(deps), 'list_vehicles');
  const out = await spec.run({ delegated_account_id: 'intruder' }, {});
  assert.equal(out.isError, true);
  assert.equal(out.structuredContent?.code, 'DELEGATION_NOT_ALLOWED');
  assert.match(out.content[0]!.text, /Server refused DELEGATION_NOT_ALLOWED/);
  assert.deepEqual(calls, [], 'a refused delegation must not reach the transport');
});

test('an empty credential returns a structured empty list, not text only', async () => {
  const deps = domainDeps(fakeClient({ owner: [] }, []));
  const spec = toolSpec(domainToolSpecs(deps), 'list_vehicles');
  const out = await spec.run({}, {});
  assert.equal(out.isError, undefined);
  assert.equal(out.content[0]!.text, 'This credential is not authorized for any vehicle.');
  const data = out.structuredContent?.data as { count?: number; vehicles?: unknown[] } | undefined;
  assert.equal(data?.count, 0);
  assert.deepEqual(data?.vehicles, []);
});

test('a normal credential still returns count and vehicles, and the no-vin path is unchanged', async () => {
  const deps = domainDeps(fakeClient({ owner: [VIN] }, []), { vehicleLabels: { [VIN]: 'The Polestar' } });
  const spec = toolSpec(domainToolSpecs(deps), 'list_vehicles');
  const out = await spec.run({}, {});
  assert.equal(out.isError, undefined);
  assert.match(out.content[0]!.text, /Authorized vehicles \(1\):/);
  assert.match(out.content[0]!.text, /The Polestar \(YSMTEST22PL000001\)/);
  const data = out.structuredContent?.data as { count?: number; vehicles?: unknown[] } | undefined;
  assert.equal(data?.count, 1);
  assert.equal(data?.vehicles?.length, 1);
});
