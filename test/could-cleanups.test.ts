import assert from 'node:assert/strict';
import { test } from 'node:test';
import { domainPath, parseDomainPath, parseResourceUri } from '../src/domains.js';
import { DEFAULT_MAX_RESPONSE_BYTES, HttpTransport, TransportError } from '../src/transport.js';
import { helpText, MAX_HTTP_REQUEST_BYTES } from '../src/server.js';
import { KNOWN_ENV_VARIABLES } from '../src/config.js';

/**
 * C16: the small correctness and surface cleanups.
 *
 * Three of these are boundary failures that only appear with hostile or odd
 * input (a malformed percent escape, an oversized request, an oversized
 * response), which is exactly the class of bug a happy-path suite misses. The
 * fourth is a claim in `--help` that can drift without any test noticing unless
 * the text is generated from the registry it describes.
 */

const VIN = 'YSMTEST22PL000001';

test('a malformed percent-encoded VIN parses to undefined instead of throwing', () => {
  // `%E0%A4%A` is an incomplete UTF-8 escape: decodeURIComponent throws URIError
  // on it. That used to escape the protocol handler and answer INTERNAL_ERROR;
  // the subscription path now gets undefined and answers -32602.
  assert.equal(parseResourceUri('polestar://vehicle/%E0%A4%A/telemetry/battery'), undefined);
  assert.equal(parseDomainPath(`/v1/vehicles/%E0%A4%A/telemetry/battery`), undefined);
  assert.equal(parseResourceUri('polestar://vehicle/%/telemetry/battery'), undefined, 'a lone percent is not an escape');
  assert.equal(parseDomainPath('/v1/vehicles/%ZZ/telemetry/battery'), undefined);

  // Positive controls: a valid URI and a valid percent-encoded VIN still parse,
  // so the guard rejects escapes rather than rejecting the route.
  assert.deepEqual(parseResourceUri(`polestar://vehicle/${VIN}/telemetry/battery`), {
    vin: VIN,
    kind: 'telemetry',
    name: 'battery',
  });
  const encoded = parseResourceUri(`polestar://vehicle/${encodeURIComponent(VIN)}/telemetry/battery`);
  assert.equal(encoded?.vin, VIN);
  assert.equal(parseDomainPath(domainPath('telemetry', 'battery').replace('{vin}', VIN))?.vin, VIN);
});

/** The parts of a Response the transport actually reads; a real Response is not needed. */
function responseWith(init: { status?: number; headers?: Record<string, string>; body: ReadableStream<Uint8Array> | null }): Response {
  return {
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    body: init.body,
  } as unknown as Response;
}

interface StreamState {
  pulls: number;
  cancelled: boolean;
}

/** A stream that hands out the given chunks and records how often it is read or cancelled. */
function countingStream(chunks: readonly Uint8Array[], state: StreamState, failWith?: Error): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      if (failWith !== undefined) {
        controller.error(failWith);
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

async function withStubbedFetch(
  response: Response,
  run: (transport: HttpTransport) => Promise<void>,
  transport: HttpTransport = new HttpTransport(5_000, 1_024),
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    await run(transport);
  } finally {
    globalThis.fetch = original;
  }
}

test('a response body over the cap is a typed failure, not an unbounded read', async () => {
  assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 4 * 1024 * 1024, 'the production cap is the documented 4 MiB');

  // Declared size over the cap: refused from the header, stream never pulled.
  const declaredState: StreamState = { pulls: 0, cancelled: false };
  const declaredBody = countingStream([new TextEncoder().encode('{}')], declaredState);
  await withStubbedFetch(responseWith({ headers: { 'content-length': '2048' }, body: declaredBody }), async (transport) => {
    await assert.rejects(
      () => transport.fetch('https://api.test/m2m/v1/vehicles'),
      (err: unknown) => {
        assert.ok(err instanceof TransportError, `expected a typed transport failure, saw ${String(err)}`);
        assert.equal(err.causeKind, 'network');
        assert.match(err.message, /1024 byte cap/);
        assert.match(err.message, /2048 bytes declared/);
        return true;
      },
    );
  });
  // A ReadableStream may prefetch one chunk on construction; the transport reads
  // none of them and cancels, so the declared-oversize path buffers no body.
  assert.ok(declaredState.pulls <= 1, `declared oversize must not be read; saw ${declaredState.pulls} pulls`);
  assert.equal(declaredState.cancelled, true, 'and the stream is released');

  // No declared length: the read stops as soon as the running total crosses the
  // cap. Ten chunks are offered, so pulling far fewer than ten is the observable
  // proof that the body was not drained.
  const streamedState: StreamState = { pulls: 0, cancelled: false };
  const streamedBody = countingStream(
    Array.from({ length: 10 }, () => new Uint8Array(600)),
    streamedState,
  );
  await withStubbedFetch(responseWith({ body: streamedBody }), async (transport) => {
    await assert.rejects(
      () => transport.fetch('https://api.test/m2m/v1/vehicles'),
      (err: unknown) => err instanceof TransportError && /1024 byte cap/.test(err.message) && /bytes received/.test(err.message),
    );
  });
  assert.equal(streamedState.cancelled, true, 'the stream is cancelled once the limit is crossed');
  // The queue may prefetch a chunk or two, but the cap is crossed after the
  // second chunk and the remaining eight are never requested.
  assert.ok(streamedState.pulls <= 4, `stopped pulling near the cap, saw ${streamedState.pulls} of 10 pulls`);
});

test('a response under the cap still decodes, including a multi-byte character split across chunks', async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode('{"value":"å"}');
  // Split inside the two-byte 'å' sequence, so a decoder used per chunk instead
  // of a streaming decoder would corrupt the text.
  const cut = bytes.indexOf(0xc3) + 1;
  const state: StreamState = { pulls: 0, cancelled: false };
  const body = countingStream([bytes.slice(0, cut), bytes.slice(cut)], state);
  await withStubbedFetch(responseWith({ headers: { 'content-type': 'application/json' }, body }), async (transport) => {
    const res = await transport.fetch('https://api.test/m2m/v1/vehicles');
    assert.equal(res.status, 200);
    assert.equal(res.headers?.['content-type'], 'application/json');
    assert.equal(res.body, '{"value":"å"}');
  });
});

test('a failure while reading the body becomes a transport error, not a raw stream error', async () => {
  const state: StreamState = { pulls: 0, cancelled: false };
  const body = countingStream([], state, new Error('socket reset mid-body'));
  await withStubbedFetch(responseWith({ body }), async (transport) => {
    await assert.rejects(
      () => transport.fetch('https://api.test/m2m/v1/vehicles'),
      (err: unknown) => {
        assert.ok(err instanceof TransportError);
        assert.equal(err.causeKind, 'network');
        assert.match(err.message, /reading the response body/);
        return true;
      },
    );
  });
});

test('--help lists every configuration variable and makes no unverified completeness claim', () => {
  const help = helpText();
  assert.ok(KNOWN_ENV_VARIABLES.length >= 27, `expected the real registry, saw ${KNOWN_ENV_VARIABLES.length}`);
  const missing = KNOWN_ENV_VARIABLES.filter((name) => !help.includes(name));
  assert.deepEqual(missing, [], `--help must name every variable the server reads; missing ${missing.join(', ')}`);
  assert.match(help, new RegExp(`Every variable the server reads \\(${KNOWN_ENV_VARIABLES.length} names\\)`));

  // The old text said `.env.example` listed every variable while the file was
  // short by five names. The help may point at the template but must not assert
  // a completeness the server cannot verify; the release gate owns that file.
  assert.doesNotMatch(help, /Every variable the server reads is listed there/);
  assert.doesNotMatch(help, /lists every variable/i);

  // The request-body cap is documented where an operator will look for it.
  assert.match(help, new RegExp(`request body at ${MAX_HTTP_REQUEST_BYTES / (1024 * 1024)} MiB`));
  assert.match(help, /413 JSON error/);

  // Compact: no line is a wall of text trying to hold all 28 names at once.
  for (const line of help.split('\n')) assert.ok(line.length <= 120, `help line too long: ${line}`);
});
