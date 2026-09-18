import type { Transport, TransportRequest, TransportResponse } from './transport.js';
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

const RETRYABLE_STATUS = new Set([429, 502, 503]);

/**
 * Retries the retryable failures the API documents, 429 (honoring
 * Retry-After when present) and the 502/503 gateway errors, with
 * exponential backoff capped at maxBackoffMs. Every attempt is metered
 * against the daily budget before it goes out, so retries can never spend
 * more than the credential allows. Errors (network) are not retried here;
 * the caller sees them immediately.
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
    let last: TransportResponse | undefined;
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
      last = await this.inner.fetch(url, request);
      if (!RETRYABLE_STATUS.has(last.status) || attempt === this.maxAttempts) return last;

      // Our own backoff is capped; a server-supplied Retry-After is honoured as
      // given. Clamping it down would make us retry sooner than the API asked,
      // which is the one thing that header exists to prevent.
      const retryAfterMs = retryAfterHeaderMs(last);
      const wait = retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), this.maxBackoffMs);
      if (this.now() - startedAt + wait > this.totalDeadlineMs) {
        // Hand the 429/5xx back rather than parking an MCP tool call past the
        // deadline; the caller can decide whether to try again later.
        return last;
      }
      await this.sleep(wait);
    }
    return last!;
  }
}

function retryAfterHeaderMs(res: TransportResponse): number | undefined {
  const raw = res.headers?.['retry-after'];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
