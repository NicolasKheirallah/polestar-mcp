import { PassThrough } from 'node:stream';

/**
 * Line filter in front of the stdio transport.
 *
 * The SDK transport is right for well-formed MCP messages, but it is silent on
 * the two answers JSON-RPC requires: a malformed JSON line is dropped inside its
 * read buffer, and a JSON-RPC batch is rejected by message validation without a
 * reply. A client cannot tell either from a slow server, so this filter parses
 * each line first, answers `-32700` or `-32600` on the wire, and passes valid
 * messages to the transport unchanged.
 *
 * Batching is refused rather than reimplemented: MCP removed it in 2025-06-18,
 * and an answer the caller can act on (one error frame) is better than silence on
 * every revision.
 */
export interface StdioInputFilter {
  /** The stream to hand the MCP transport as its stdin. */
  readonly input: PassThrough;
  /** Detach from the source stream; safe to call more than once. */
  dispose(): void;
}

const PARSE_ERROR = {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32700, message: 'Parse error: invalid JSON received.' },
} as const;

const BATCH_ERROR = {
  jsonrpc: '2.0',
  id: null,
  error: {
    code: -32600,
    message: 'Invalid Request: JSON-RPC batching is not supported; send one message per line.',
  },
} as const;

const INVALID_REQUEST = {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32600, message: 'Invalid Request: not a JSON-RPC 2.0 message.' },
} as const;

/** Whether an already-parsed line has the minimal JSON-RPC 2.0 envelope. */
export function looksLikeJsonRpc(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') return false;
  const hasMethod = typeof message.method === 'string';
  const hasResult = 'result' in message;
  const hasError = message.error !== null && typeof message.error === 'object';
  const id = message.id;
  const idOk = id === undefined || id === null || typeof id === 'string' || typeof id === 'number';
  return idOk && (hasMethod || hasResult || hasError);
}

export function createStdioInputFilter(
  source: NodeJS.ReadableStream,
  sink: NodeJS.WritableStream,
): StdioInputFilter {
  const input = new PassThrough();
  let buffer = Buffer.alloc(0);
  let disposed = false;

  const writeFrame = (frame: unknown): void => {
    sink.write(`${JSON.stringify(frame)}\n`);
  };

  const handleLine = (raw: string): void => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      writeFrame(PARSE_ERROR);
      return;
    }
    if (Array.isArray(parsed)) {
      writeFrame(BATCH_ERROR);
      return;
    }
    if (!looksLikeJsonRpc(parsed)) {
      writeFrame(INVALID_REQUEST);
      return;
    }
    input.write(`${line}\n`);
  };

  const onData = (chunk: Buffer | string): void => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const index = buffer.indexOf(0x0a);
      if (index < 0) return;
      const line = buffer.toString('utf8', 0, index);
      buffer = buffer.subarray(index + 1);
      handleLine(line);
    }
  };

  const finish = (): void => {
    if (disposed) return;
    disposed = true;
    source.removeListener('data', onData);
    source.removeListener('end', onEnd);
    source.removeListener('close', onEnd);
    source.removeListener('error', onError);
    input.end();
  };

  const onEnd = (): void => finish();
  const onError = (error: Error): void => {
    // A read error is the transport's problem, not a line's: close the pipe so
    // the SDK transport sees end-of-input and shuts down the session.
    if (!input.destroyed) input.destroy(error);
    finish();
  };

  source.on('data', onData);
  source.on('end', onEnd);
  source.on('close', onEnd);
  source.on('error', onError);

  return {
    input,
    dispose: () => {
      finish();
      if (!input.destroyed) input.destroy();
    },
  };
}
