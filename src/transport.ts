import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDomainPath } from './domains.js';

export interface TransportRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TransportResponse {
  status: number;
  body: string;
  /** Selected response headers (e.g. retry-after) when the adapter can see them. */
  headers?: Record<string, string>;
}

export interface Transport {
  fetch(url: string, request?: TransportRequest): Promise<TransportResponse>;
}

/** Raised when a request cannot be completed at all: deadline hit, or no route. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly causeKind: 'timeout' | 'network',
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Real HTTP adapter: global fetch with a hard deadline on every request. */
export class HttpTransport implements Transport {
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    // Without a deadline one hung Polestar connection blocks forever, and since
    // token requests are single-flight it would wedge every caller queued behind
    // it too. AbortSignal.timeout needs no manual cleanup.
    const init: RequestInit = {
      method: request.method ?? 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (request.headers !== undefined) init.headers = request.headers;
    if (request.body !== undefined) init.body = request.body;

    let res: Response;
    try {
      res = await globalThis.fetch(url, init);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new TransportError(
        timedOut
          ? `Request to ${url} did not complete within ${this.timeoutMs}ms.`
          : `Network request to ${url} failed.`,
        timedOut ? 'timeout' : 'network',
      );
    }
    const headers: Record<string, string> = {};
    for (const name of ['retry-after', 'content-type']) {
      const value = res.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: res.status, body: await res.text(), headers };
  }
}

/**
 * Offline adapter serving captured responses from a directory laid out like the
 * endpoint dump: `<root>/token.json`, `<root>/dataportal/vehicles.json`, and
 * `<root>/dataportal/{telemetry|charging}/<name>.json`.
 *
 * A fixture whose captured body is itself an error envelope replays with the
 * status the API really returned, so callers exercise the same branch as live
 * traffic. A route with no fixture at all answers 404 NOT_FOUND, deliberately
 * distinct from DATA_NOT_AVAILABLE: conflating them lets a missing or typo'd
 * fixture read as "this vehicle reports nothing", which makes the null rule
 * impossible to test honestly.
 */
export class FixtureTransport implements Transport {
  constructor(private readonly rootDir: string) {}

  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    const pathname = new URL(url).pathname;
    const method = request.method ?? 'GET';

    if (pathname.endsWith('/token') && method === 'POST') {
      const rootToken = await this.tryFile(['token.json']);
      if (rootToken !== null) return rootToken;
      // Captured dumps store the token response under dataportal/.
      return this.readFile(['dataportal', 'token.json'], 'token');
    }
    if (pathname.endsWith('/v1/vehicles') && method === 'GET') {
      return this.readFile(['dataportal', 'vehicles.json'], 'vehicles');
    }
    const ref = parseDomainPath(pathname);
    if (ref !== undefined && method === 'GET') {
      return this.readFile(['dataportal', ref.kind, `${ref.name}.json`], `${ref.kind}/${ref.name}`);
    }

    return notFound(`unhandled route ${method} ${pathname}`);
  }

  private async readFile(parts: string[], what: string): Promise<TransportResponse> {
    const found = await this.tryFile(parts);
    if (found !== null) return found;
    return notFound(`missing ${what} fixture`);
  }

  private async tryFile(parts: string[]): Promise<TransportResponse | null> {
    const target = this.containedPath(parts);
    let body: string;
    try {
      body = await readFile(target, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return { status: capturedErrorStatus(body) ?? 200, body };
  }

  /** The fixtures dir is operator config; still refuse to read outside it. */
  private containedPath(parts: string[]): string {
    const root = path.resolve(this.rootDir);
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new TransportError('Fixture lookup escaped the fixtures directory.', 'network');
    }
    return target;
  }
}

function notFound(what: string): TransportResponse {
  return {
    status: 404,
    body: JSON.stringify({
      error: {
        code: 'NOT_FOUND',
        message: `No fixture response: ${what}.`,
        httpStatus: 404,
      },
    }),
  };
}

function capturedErrorStatus(body: string): number | null {
  try {
    const status = (JSON.parse(body) as { error?: { httpStatus?: unknown } }).error?.httpStatus;
    return typeof status === 'number' ? status : null;
  } catch {
    return null;
  }
}
