import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOMAINS, domainPath, parseDomainPath, parseResourceUri, toolName } from '../src/domains.js';
import { SAMPLED_DOMAINS } from '../src/sampler.js';
import { activeWarnings, observedAtMs, summarizeDomain } from '../src/format.js';


test('every captured domain matches its pinned key set', () => {
  for (const domain of DOMAINS) {
    if (domain.pinnedKeys.length === 0) continue;
    const kind = domain.kind;
    const name = domain.name;
    const expected = domain.pinnedKeys;
    const file = fileURLToPath(new URL(`./fixtures/dump/dataportal/${kind}/${name}.json`, import.meta.url));
    const body = JSON.parse(readFileSync(file, 'utf8')) as { data?: Record<string, unknown> };
    assert.ok(body.data !== undefined, `${name}: fixture has no data envelope`);
    assert.deepEqual(Object.keys(body.data).sort(), [...expected].sort(), `${name}: contract drifted`);
  }
});

test('the two metadata-only domains carry no payload a tool could summarise as data', () => {
  // Recorded so a future "it works, my car showed locations" cannot silently
  // contradict the shape these tools are described by.
  for (const name of ['charge-locations', 'charge-now']) {
    const file = fileURLToPath(new URL(`./fixtures/dump/dataportal/charging/${name}.json`, import.meta.url));
    const data = JSON.parse(readFileSync(file, 'utf8')).data as Record<string, unknown>;
    const interesting = Object.keys(data).filter((k) => !['id', 'vin', 'metaEventId', 'metaReceivedAt', 'utc0'].includes(k));
    assert.ok(interesting.length <= 1, `${name} unexpectedly grew real content: ${interesting.join(', ')}`);
  }
});

test('every domain renders a summary, an observation time, or an explicit none', () => {
  for (const domain of DOMAINS) {
    const file = fileURLToPath(new URL(`./fixtures/dump/dataportal/${domain.kind}/${domain.name}.json`, import.meta.url));
    const body = JSON.parse(readFileSync(file, 'utf8')) as { data?: Record<string, unknown>; error?: { code?: string } };
    if (body.error?.code === 'DATA_NOT_AVAILABLE') continue; // is-at-charge-location: the graceful null path
    const data = body.data as Record<string, unknown>;
    assert.ok(observedAtMs(data) !== undefined, `${domain.name}: no observation time recoverable`);
    const summary = summarizeDomain(domain.name, data, 'km');
    // A missing summarizer used to be legal here, and its consequence is not a failed
    // test but a raw payload dumped into the model's context on a live call.
    assert.ok(summary !== null && summary.length > 0, `${domain.name}: no summarizer, so the tool falls back to printing the whole payload`);
    assert.equal(Array.isArray(activeWarnings(data)), true, `${domain.name}: activeWarnings must always answer`);
    assert.ok(toolName(domain).startsWith('get_'));
  }
});

test('descriptions never promise a field the pinned contract does not return', () => {
  // Fields the OpenAPI contract defines but a given car may not report: a
  // description naming one must say that absence means unreported.
  const promised = /volts|current and voltage|since-charge|automatic-trip|consumption breakdown|pending changes/i;
  for (const domain of DOMAINS) {
    const file = fileURLToPath(new URL(`./fixtures/dump/dataportal/${domain.kind}/${domain.name}.json`, import.meta.url));
    const body = JSON.parse(readFileSync(file, 'utf8')) as { data?: Record<string, unknown> };
    const keys = Object.keys(body.data ?? {}).join(' ');
    if (!promised.test(domain.description)) continue;
    assert.ok(/only when the car reports|not an active\/inactive|only when an edit has not yet|typically carries only|typically answers as|not a list of addresses/i.test(domain.description),
      `${domain.name}: description advertises fields (${domain.description.slice(0, 60)}…) that the payload (${keys}) does not carry, without saying so`);
  }
});

test('fields the portal documents but this vehicle never reports are tolerated', () => {
  // The "API Documentation" page lists charging current/voltage, tyre pressure
  // warnings, cabin temperature, a sunroof and an unavailability reason. None
  // appear in the reference payloads. The humanizer is key-driven, so an
  // arriving field must extend the output rather than break it, and a real
  // warning among them must reach get_needs_attention.
  const unseen = {
    vin: 'YSMTEST22PL000001',
    metaReceivedAt: '2026-01-01T00:00:00.000Z',
    chargingCurrentAmps: 32,
    chargingVoltageVolts: 400,
    sunroof: 'OPEN_STATUS_OPEN',
    cabinTemperatureCurrent: 19.5,
    tyrePressureFrontLeftWarning: 'TYRE_PRESSURE_WARNING_LOW',
    lightWarnings: { brakeLightLeft: 'EXTERIOR_LIGHT_WARNING_BULB_FAILURE', highBeamLeft: 'EXTERIOR_LIGHT_WARNING_NO_WARNING' },
    unavailabilityReason: 'REASON_DEEP_SLEEP',
  };
  const summary = summarizeDomain('health', unseen, 'km');
  assert.ok(summary === null || summary.length > 0, 'unknown field set must not produce an empty summary');
  const warnings = activeWarnings(unseen);
  assert.ok(warnings.some((w) => w.includes('tyre pressure front left')), `flat warning surfaced: ${warnings.join(', ')}`);

  // The nested case that motivated this: nineteen light positions under one key.
  assert.ok(warnings.some((w) => w.includes('brake light left')), `nested warning surfaced: ${warnings.join(', ')}`);
  assert.equal(warnings.some((w) => w.includes('high beam')), false, 'a NO_WARNING value stays silent wherever it is nested');

  // A payload consisting only of unseen optional fields must still be readable.
  const optionalOnly = {
    ...unseen,
    tyrePressureFrontLeftWarning: 'TYRE_PRESSURE_WARNING_NO_WARNING',
    lightWarnings: { brakeLightLeft: 'EXTERIOR_LIGHT_WARNING_NO_WARNING', highBeamLeft: 'EXTERIOR_LIGHT_WARNING_NO_WARNING' },
  };
  assert.deepEqual(activeWarnings(optionalOnly), []);
  assert.notEqual(observedAtMs(optionalOnly), undefined);
});

test('every distance a summary renders honours the operator unit preference', () => {
  // POLESTAR_UNITS used to be a process global that some rendering paths read and
  // others ignored, so `mi` converted the battery line and left the odometer in
  // kilometres. Comparing whole summaries would let one converted line mask an
  // unconverted neighbour, so each rendered line is compared with the line the
  // other unit produced at the same position.
  const DISTANCE = /[\d][\d,.]* km(?!\/)/;
  const distanceBearing = ['battery', 'odometer', 'health'];
  const converted: string[] = [];

  for (const domain of DOMAINS) {
    const file = fileURLToPath(new URL(`./fixtures/dump/dataportal/${domain.kind}/${domain.name}.json`, import.meta.url));
    const body = JSON.parse(readFileSync(file, 'utf8')) as { data?: Record<string, unknown> };
    if (body.data === undefined) continue;
    const kmView = summarizeDomain(domain.name, body.data, 'km');
    const miView = summarizeDomain(domain.name, body.data, 'mi');
    assert.deepEqual(miView === null, kmView === null, `${domain.name}: units must not change whether a summary exists`);
    if (kmView === null || miView === null) continue;
    assert.equal(miView.length, kmView.length, `${domain.name}: the two units must render the same number of lines`);
    kmView.forEach((line, i) => {
      if (!DISTANCE.test(line)) return;
      if (line !== miView[i]) converted.push(domain.name);
      else if (distanceBearing.includes(domain.name)) {
        throw new Error(`${domain.name}: line ${i} renders a distance identically in km and mi, so a rendering site is ignoring the units argument: ${line}`);
      }
    });
  }

  assert.deepEqual([...new Set(converted)].sort(), distanceBearing.slice().sort());
});

test('every Domain carries the facts the runtime derives from it', () => {
  // These used to live in satellite lists: a regex table in the cache, a
  // four-entry list in the sampler, two hand-copied lists in the gates. A
  // forgotten entry cost a wrong TTL on live quota, or went unsampled, with
  // nothing failing. The row is now the only place to say it.
  for (const d of DOMAINS) {
    assert.ok(Number.isInteger(d.ttlMs) && d.ttlMs >= 30_000 && d.ttlMs <= 60 * 60_000, `${d.name}: implausible ttl ${d.ttlMs}`);
    assert.equal(typeof d.sampled, 'boolean', `${d.name}: sampled must be stated, not defaulted`);
    assert.match(d.scope, /^pdp-(telemetry|charging)\//, `${d.name}: scope does not match its kind`);
    assert.equal(domainPath(d.kind, d.name), `/v1/vehicles/{vin}/${d.kind}/${d.name}`);
    assert.ok(toolName(d).startsWith('get_'), `${d.name}: tool name is not derived from the row`);
  }
  assert.deepEqual(
    SAMPLED_DOMAINS.map((d) => d.name).sort(),
    DOMAINS.filter((d) => d.sampled).map((d) => d.name).sort(),
    'the sampler must read the registry, not a list beside it',
  );
  assert.ok(SAMPLED_DOMAINS.length > 0, 'nothing is sampled');
});

test('the route grammar accepts real paths and refuses invented Domains', () => {
  assert.deepEqual(
    parseDomainPath('/eu-north-1/data-portal/m2m/v1/vehicles/YSMTEST22PL000001/telemetry/battery'),
    { vin: 'YSMTEST22PL000001', kind: 'telemetry', name: 'battery' },
  );
  // A subscription URI is the same Domain route, but `vehicle` is the host there,
  // not a path segment. That distinction is what made subscriptions inert.
  assert.deepEqual(parseResourceUri('polestar://vehicle/YSMTEST22PL000001/charging/target-soc'), {
    vin: 'YSMTEST22PL000001',
    kind: 'charging',
    name: 'target-soc',
  });
  assert.equal(parseResourceUri('polestar://vehicle/YSMTEST22PL000001/telemetry/nope'), undefined);
  assert.equal(parseResourceUri('not a uri'), undefined);
  assert.equal(parseDomainPath('/v1/vehicles/YSMTEST22PL000001/telemetry/no-such-domain'), undefined);
  assert.equal(parseDomainPath('/v1/vehicles'), undefined);
});
