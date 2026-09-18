export class BudgetExceededError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
    readonly resetsAt: string,
  ) {
    super(
      `Daily API budget exhausted: ${used}/${limit} calls used (limit from the Polestar Data Portal: 10,000 calls/client/day). ` +
        `Budget resets at ${resetsAt}. Reduce polling, raise POLESTAR_BUDGET if you know better, or wait for the reset.`,
    );
    this.name = 'BudgetExceededError';
  }
}

export interface BudgetSnapshot {
  used: number;
  limit: number;
  remaining: number;
  /** Fraction of the budget consumed, 0..1. `consume()` throws before it can exceed 1. */
  fractionUsed: number;
  resetsAtUtc: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tracks actual (live) API calls against the documented 10,000-per-client-per-day
 * limit and fails closed once exhausted. The window is a rolling UTC day;
 * cache hits, fixture reads, and stale re-serves never consume budget.
 */
export class BudgetMeter {
  private used = 0;
  private windowStart: number;

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error(`Budget limit must be positive, got ${limit}`);
    this.windowStart = this.dayStart(now());
  }

  consume(): void {
    this.rollWindowIfNeeded();
    if (this.used >= this.limit) {
      throw new BudgetExceededError(this.used, this.limit, this.resetsAtUtc());
    }
    this.used += 1;
  }

  snapshot(): BudgetSnapshot {
    this.rollWindowIfNeeded();
    return {
      used: this.used,
      limit: this.limit,
      remaining: Math.max(0, this.limit - this.used),
      fractionUsed: this.limit === 0 ? 1 : this.used / this.limit,
      resetsAtUtc: this.resetsAtUtc(),
    };
  }

  /** True when at least this fraction of the daily budget has been spent. */
  isLow(thresholdFraction: number): boolean {
    return this.snapshot().fractionUsed >= thresholdFraction;
  }

  private rollWindowIfNeeded(): void {
    const dayStart = this.dayStart(this.now());
    if (dayStart > this.windowStart) {
      this.windowStart = dayStart;
      this.used = 0;
    }
  }

  private dayStart(t: number): number {
    return Math.floor(t / DAY_MS) * DAY_MS;
  }

  private resetsAtUtc(): string {
    return new Date(this.windowStart + DAY_MS).toISOString();
  }
}

const MINUTE_MS = 60_000;

/** Raised when the per-minute ceiling is hit; carries how long to wait. */
export class RateLimitMinuteError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
    readonly retryInMs: number,
  ) {
    super(
      `Per-minute API ceiling reached: ${used}/${limit} requests in the current minute ` +
        `(the Data Portal allows 100 requests/minute as well as 10,000/day). Try again in ${Math.ceil(retryInMs / 1000)}s.`,
    );
    this.name = 'RateLimitMinuteError';
  }
}

/**
 * Rolling one-minute ceiling, separate from the daily budget because the API
 * publishes both (100/minute, 10,000/day) and only the day was modelled: a
 * status fan-out, an eager agent, or the sampler can exhaust a minute long
 * before the day is meaningfully spent. Fixed windows per started minute, so
 * the count is cheap and the reset moment is exact rather than estimated.
 */
export class MinuteWindowMeter {
  private used = 0;
  private windowStart: number;

  constructor(
    private readonly limit: number = 100,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error(`Per-minute limit must be positive, got ${limit}`);
    this.windowStart = Math.floor(this.now() / MINUTE_MS) * MINUTE_MS;
  }

  /** Register one outbound request, or throw with the remaining wait. */
  consume(): void {
    const t = this.now();
    if (t >= this.windowStart + MINUTE_MS) {
      this.windowStart = Math.floor(t / MINUTE_MS) * MINUTE_MS;
      this.used = 0;
    }
    if (this.used >= this.limit) {
      throw new RateLimitMinuteError(this.used, this.limit, this.windowStart + MINUTE_MS - t);
    }
    this.used += 1;
  }

  snapshot(): { used: number; limit: number; resetsInMs: number } {
    const t = this.now();
    if (t >= this.windowStart + MINUTE_MS) return { used: 0, limit: this.limit, resetsInMs: MINUTE_MS };
    return { used: this.used, limit: this.limit, resetsInMs: this.windowStart + MINUTE_MS - t };
  }
}
