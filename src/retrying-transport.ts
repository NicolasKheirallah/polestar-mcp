import { TransportError, type Transport, type TransportRequest, type TransportResponse } from './transport.js';
import { RateLimitMinuteError, type BudgetMeter, type MinuteWindowMeter } from './budget.js';

export interface RetryingTransportOptions {
  /** Max attempts per logical request (including the first). */
  maxAttempts?: number;
  /** Upper bound for computed backoff when no Retry-After header is present. */
  maxBackoffMs?: number;
  /** Stop retrying once this much wall-clock has passed for one logical request. */
  totalDeadlineMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Budget meter: every actual HTTP attempt is one unit of the daily budget. */
  budget?: BudgetMeter;
  /** Rolling 100/minute ceiling; waits out the window instead of failing the caller. */
  minute?: MinuteWindowMeter;
}

/**
 * 500 and 504 join the documented gateway failures: the API can answer either
 * from a transient backend problem, and the caller should not have to tell that
 * apart from a 502.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** A GET is safe to repeat after a transport failure; one retry is worth the quota. */
const NETWORK_RETRIES_PER_REQUEST = 1;

const BASE_BACKOFF_MS = 500;

/**
 * Retries the transient failures the API documents, 429 (honoring Retry-After in
 * either RFC 9110 form) and 5xx gateway errors, with exponential backoff capped
 * at maxBackoffMs. A GET that fails at the transport layer (connection reset,
 * DNS blip) is retried once, because repeating a read costs one metered attempt
 * and the alternative is failing a question a moment later would have answered.
 * A transient status is retried for any method: the API answered, and it told
 * us the failure was temporary. A POST is not replayed after a transport
 * failure because the request may already have been received.
 *
 * Every attempt is metered against the daily budget before it goes out, so
 * retries can never spend more than the credential allows, and the total
 * deadline stops a retry loop from parking an MCP call.
 */
export class RetryingTransport implements Transport {
  private readonly maxAttempts: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly totalDeadlineMs: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: Transport,
    private readonly opts: RetryingTransportOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.totalDeadlineMs = opts.totalDeadlineMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  async fetch(url: string, request: TransportRequest = {}): Promise<TransportResponse> {
    const startedAt = this.now();
    const isGet = (request.method ?? 'GET').toUpperCase() === 'GET';
    let last: TransportResponse | undefined;
    let networkRetries = 0;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // The minute ceiling is transient by construction, so ride it out while
      // the wait still fits the request deadline; a wait longer than the caller
      // is willing to block on is reported instead of hidden.
      if (this.opts.minute !== undefined) {
        for (;;) {
          try {
            this.opts.minute.consume();
            break;
          } catch (err) {
            const remaining = this.totalDeadlineMs - (this.now() - startedAt);
            if (!(err instanceof RateLimitMinuteError) || err.retryInMs > remaining || attempt === this.maxAttempts) throw err;
            await this.sleep(err.retryInMs);
          }
        }
      }
      this.opts.budget?.consume();

      try {
        last = await this.inner.fetch(url, request);
      } catch (err) {
        const retryable =
          err instanceof TransportError &&
          err.causeKind === 'network' &&
          isGet &&
          networkRetries < NETWORK_RETRIES_PER_REQUEST &&
          attempt < this.maxAttempts;
        if (!retryable) throw err;
        networkRetries += 1;
        const wait = this.backoffMsFor(attempt);
        if (this.now() - startedAt + wait > this.totalDeadlineMs) {
          throw err;
        }
        await this.sleep(wait);
        continue;
      }

      if (!RETRYABLE_STATUS.has(last.status) || attempt === this.maxAttempts) return last;

      // Our own backoff is capped; a server-supplied Retry-After is honoured as
      // given. Clamping it down would make us retry sooner than the API asked,
      // which is the one thing that header exists to prevent.
      const retryAfterMs = retryAfterHeaderMs(last, this.now());
      const wait = retryAfterMs ?? this.backoffMsFor(attempt);
      if (this.now() - startedAt + wait > this.totalDeadlineMs) {
        // Hand the 429/5xx back rather than parking an MCP tool call past the
        // deadline; the caller can decide whether to try again later.
        return last;
      }
      await this.sleep(wait);
    }
    return last!;
  }

  private backoffMsFor(attempt: number): number {
    return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), this.maxBackoffMs);
  }
}

/**
 * Retry-After in either RFC 9110 form: delta-seconds, or an HTTP-date meaning
 * "do not retry before this instant". The date form was read with Number(),
 * which is NaN, so a date 30 seconds out produced the 500 ms default and the
 * server retried 29.5 seconds before it was asked to.
 */
function retryAfterHeaderMs(res: TransportResponse, now: number): number | undefined {
  const raw = headerValue(res, 'retry-after')?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function headerValue(res: TransportResponse, name: string): string | undefined {
  const headers = res.headers;
  if (headers === undefined) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}
