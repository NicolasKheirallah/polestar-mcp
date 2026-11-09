import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDomainPath, VEHICLES_PATH } from './domains.js';

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

/**
 * Upper bound on one upstream response body, 4 MiB. A Domain payload is a few
 * kilobytes and the vehicle list is smaller, so this only fires on a misrouted
 * request, a proxy error page with an enormous body, or a hostile endpoint.
 * `fetch().text()` would buffer whatever arrives; the cap makes the failure
 * bounded and typed instead of a memory spike.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Real HTTP adapter: global fetch with a hard deadline on every request. */
export class HttpTransport implements Transport {
  constructor(
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly maxResponseBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
  ) {}

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
    return { status: res.status, body: await this.readBody(url, res), headers };
  }

  /**
   * Read the body up to the cap rather than calling `res.text()`.
   *
   * A declared Content-Length over the cap is refused without touching the
   * stream; otherwise the read stops as soon as the limit is crossed and the
   * stream is cancelled so the socket is released. The thrown value is a
   * TransportError, the typed transport failure the rest of the code already
   * renders; causeKind stays 'network' because the retry policy and the failure
   * mapping live in other modules and a new kind would be a cross-owner change.
   * The practical cost is one bounded retry on a GET before the failure surfaces.
   */
  private async readBody(url: string, res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw this.tooLarge(url, `${declared} bytes declared`);
    }
    if (res.body === null) return '';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > this.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw this.tooLarge(url, `${received} bytes received`);
        }
        text += decoder.decode(value, { stream: true });
      }
    } catch (err) {
      if (err instanceof TransportError) throw err;
      const name = err instanceof Error ? err.name : '';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new TransportError(
        timedOut
          ? `Request to ${url} did not complete within ${this.timeoutMs}ms.`
          : `Network request to ${url} failed while reading the response body.`,
        timedOut ? 'timeout' : 'network',
      );
    } finally {
      reader.releaseLock();
    }
    return text + decoder.decode();
  }

  private tooLarge(url: string, detail: string): TransportError {
    return new TransportError(
      `Response from ${url} exceeded the ${this.maxResponseBytes} byte cap (${detail}); refusing to buffer it.`,
      'network',
    );
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
    if (pathname.endsWith(VEHICLES_PATH) && method === 'GET') {
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

  /**
   * The fixtures dir is operator config, so a lookup is still resolved against it
   * rather than trusted. No route reaches this refusal today: every segment is
   * either a literal or a registry name, and the fixture layout has no VIN
   * directory. It is kept because that is a property of the routes, not of this
   * function, and `isInside` below is what makes it testable rather than
   * decorative.
   */
  private containedPath(parts: string[]): string {
    const target = path.resolve(this.rootDir, ...parts);
    if (!isInside(this.rootDir, target)) {
      throw new TransportError('Fixture lookup escaped the fixtures directory.', 'network');
    }
    return target;
  }
}

/** Whether `target` is `root` itself or sits inside it. */
export function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  return target === resolvedRoot || target.startsWith(resolvedRoot + path.sep);
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
