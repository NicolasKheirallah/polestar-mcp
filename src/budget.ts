import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

/** Version of the ledger file format. An unknown version is refused, not guessed at. */
const LEDGER_VERSION = 1;

/** Raised when the persistent budget ledger cannot be read or written. */
export class BudgetLedgerError extends Error {
  constructor(
    readonly path: string,
    problem: string,
    guidance: string,
  ) {
    super(`Budget ledger ${path} ${problem} ${guidance}`);
    this.name = 'BudgetLedgerError';
  }
}

/** Where the shared daily count lives, and which credential identity it belongs to. */
export interface BudgetLedgerOptions {
  /** Absolute path of the JSON file; the config loader validates it before startup. */
  path: string;
  /**
   * Credential identity. Only a SHA-256 of clientId and accountId is written, so
   * the ledger reveals call counts but never the credential identifiers.
   */
  clientId: string;
  accountId: string;
}

export interface BudgetMeterOptions {
  /** Injectable clock for tests. */
  now?: () => number;
  /**
   * Persist the count so a restart or a second process continues from the same
   * allowance. Omit it (or pass undefined) for the in-memory meter every test
   * and fixture run uses.
   */
  ledger?: BudgetLedgerOptions | undefined;
}

/** One identity's persisted count, with the window start parsed to epoch millis. */
interface LedgerState {
  windowStart: number;
  used: number;
}

interface LedgerFileEntry {
  windowStartUtc: string;
  used: number;
}

interface LedgerFile {
  version: number;
  identities: Record<string, LedgerFileEntry>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The on-disk half of the daily budget: one small JSON file shared by every
 * process that runs with the same credential. The file holds a SHA-256 per
 * identity and the UTC day it counts, so it can be read by an operator without
 * exposing the client ID or Account ID.
 *
 * The failure policy is fail closed on purpose. A ledger that cannot be read is
 * a count nobody knows, and starting at zero would let a restart or a second
 * process spend a fresh 10,000 calls against the same Polestar allowance. A
 * corrupt or unreadable file therefore refuses the call (and refuses startup
 * when it is found there) with a message naming the file and the fix. A missing
 * file is the first run, not corruption: the first write creates it.
 *
 * Writes go to a temp file in the same directory and are renamed into place, so
 * a reader never sees a half-written document, and the file is created 0600.
 * There is no cross-process lock: two processes that read and write inside the
 * same instant can lose one increment because the last writer wins. The atomic
 * rename keeps the file valid; this ledger is a safety net for the documented
 * daily ceiling, not an audit log.
 */
class BudgetLedger {
  private readonly identity: string;
  private tempWrites = 0;

  constructor(private readonly opts: BudgetLedgerOptions) {
    this.identity = createHash('sha256').update(opts.clientId).update('\u0000').update(opts.accountId).digest('hex');
  }

  get path(): string {
    return this.opts.path;
  }

  /** This identity's count, or undefined when the ledger has no entry for it yet. */
  read(): LedgerState | undefined {
    const file = this.readFile();
    const entry = file?.identities[this.identity];
    if (entry === undefined) return undefined;
    return { windowStart: parseWindowStart(entry.windowStartUtc, this.opts.path), used: entry.used };
  }

  /** Merge this identity's count into the file and replace the file atomically. */
  write(windowStart: number, used: number): void {
    const file = this.readFile();
    const identities: Record<string, LedgerFileEntry> = { ...(file?.identities ?? {}) };
    const existing = identities[this.identity];
    let nextUsed = used;
    if (existing !== undefined) {
      const existingStart = parseWindowStart(existing.windowStartUtc, this.opts.path);
      if (existingStart > windowStart) {
        throw new BudgetLedgerError(
          this.opts.path,
          `records the window ${new Date(existingStart).toISOString()}, later than ${new Date(windowStart).toISOString()}.`,
          'Refusing to overwrite a newer count with an older day; fix the system clock or delete the ledger file.',
        );
      }
      // Another process may have written the same day between our read and this
      // write. Keep the larger count rather than losing its increment.
      if (existingStart === windowStart) nextUsed = Math.max(used, existing.used);
    }
    identities[this.identity] = { windowStartUtc: new Date(windowStart).toISOString(), used: nextUsed };
    const next: LedgerFile = { version: LEDGER_VERSION, identities };

    const directory = path.dirname(this.opts.path);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new BudgetLedgerError(
        this.opts.path,
        `cannot create its directory ${directory} (${reason(err)}).`,
        'Refusing to spend quota against a count it cannot persist; create the directory, or unset POLESTAR_BUDGET_LEDGER.',
      );
    }

    this.tempWrites += 1;
    const temp = path.join(directory, `.${path.basename(this.opts.path)}.${process.pid}.${this.tempWrites}.tmp`);
    try {
      // mode 0600 is applied at creation and survives the rename; the umask can
      // only remove permissions from it, so the file is never group/world readable.
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.opts.path);
    } catch (err) {
      try {
        unlinkSync(temp);
      } catch {
        // The write may have failed before the temp file existed; nothing to clean.
      }
      throw new BudgetLedgerError(
        this.opts.path,
        `cannot be written (${reason(err)}).`,
        'Refusing to spend quota against a count it cannot persist; make the file writable, or unset POLESTAR_BUDGET_LEDGER.',
      );
    }
  }

  private readFile(): LedgerFile | undefined {
    let text: string;
    try {
      text = readFileSync(this.opts.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new BudgetLedgerError(
        this.opts.path,
        `cannot be read (${reason(err)}).`,
        'Refusing to run with an unknown daily count; fix its permissions or path, or unset POLESTAR_BUDGET_LEDGER to keep the count in memory.',
      );
    }
    return parseLedger(text, this.opts.path);
  }
}

/** A corrupt file is refused with the path and both recovery actions. */
function corrupt(file: string, problem: string): BudgetLedgerError {
  return new BudgetLedgerError(
    file,
    problem,
    'Refusing to run with a daily count it cannot read; restore the file or delete it to begin a fresh day, or unset POLESTAR_BUDGET_LEDGER.',
  );
}

function parseWindowStart(raw: unknown, file: string): number {
  if (typeof raw !== 'string') throw corrupt(file, 'has a non-string windowStartUtc.');
  const parsed = Date.parse(raw);
  if (!Number.isSafeInteger(parsed) || parsed % DAY_MS !== 0) {
    throw corrupt(file, `has a windowStartUtc ${JSON.stringify(raw)} that is not a UTC day start.`);
  }
  return parsed;
}

function parseLedger(text: string, file: string): LedgerFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw corrupt(file, `is not valid JSON (${reason(err)}).`);
  }
  if (!isPlainObject(parsed)) throw corrupt(file, 'does not hold a JSON object.');
  if (parsed.version !== LEDGER_VERSION) {
    throw corrupt(file, `has ledger version ${String(parsed.version)}, but this server writes version ${LEDGER_VERSION}.`);
  }
  const rawIdentities = parsed.identities;
  if (!isPlainObject(rawIdentities)) throw corrupt(file, 'has no identities object.');
  const identities: Record<string, LedgerFileEntry> = {};
  for (const [identity, value] of Object.entries(rawIdentities)) {
    if (!isPlainObject(value)) throw corrupt(file, `has a malformed entry for identity ${identity}.`);
    const windowStart = parseWindowStart(value.windowStartUtc, file);
    const used = value.used;
    if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) {
      throw corrupt(file, `has an invalid used count for identity ${identity}.`);
    }
    identities[identity] = { windowStartUtc: new Date(windowStart).toISOString(), used };
  }
  return { version: LEDGER_VERSION, identities };
}

/**
 * Tracks actual (live) API calls against the documented 10,000-per-client-per-day
 * limit and fails closed once exhausted. The window is a rolling UTC day; cache
 * hits, fixture reads, and stale re-serves never consume budget.
 *
 * With a ledger configured the count is shared rather than per process: every
 * consume re-reads the file before incrementing and rewrites it after, so a
 * restart, a second MCP client, or a second `npx` invocation continues from the
 * same allowance. The old two-argument form, `new BudgetMeter(limit, clock)`, is
 * still the in-memory meter.
 */
export class BudgetMeter {
  private used = 0;
  private windowStart: number;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly ledger: BudgetLedger | undefined;

  constructor(limit: number, optionsOrClock: BudgetMeterOptions | (() => number) = {}) {
    const options: BudgetMeterOptions = typeof optionsOrClock === 'function' ? { now: optionsOrClock } : optionsOrClock;
    if (!Number.isFinite(limit) || limit <= 0) throw new Error(`Budget limit must be positive, got ${limit}`);
    this.limit = limit;
    this.now = options.now ?? Date.now;
    this.windowStart = this.dayStart(this.now());
    this.ledger = options.ledger === undefined ? undefined : new BudgetLedger(options.ledger);
    const persisted = this.ledger?.read();
    if (persisted !== undefined) this.adopt(persisted);
  }

  consume(): void {
    this.rollWindowIfNeeded();
    this.syncFromLedger();
    if (this.used >= this.limit) {
      throw new BudgetExceededError(this.used, this.limit, this.resetsAtUtc());
    }
    const previous = this.used;
    this.used += 1;
    if (this.ledger !== undefined) {
      try {
        this.ledger.write(this.windowStart, this.used);
      } catch (err) {
        // The attempt was refused before it went out, so it must not be counted.
        this.used = previous;
        throw err;
      }
    }
  }

  snapshot(): BudgetSnapshot {
    this.rollWindowIfNeeded();
    this.syncFromLedger();
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

  /** Take up a persisted count, or the newer UTC day it declares. */
  private adopt(persisted: LedgerState): void {
    if (this.ledger === undefined) return;
    const dayStart = this.dayStart(this.now());
    if (persisted.windowStart > dayStart) {
      throw new BudgetLedgerError(
        this.ledger.path,
        `records the window ${new Date(persisted.windowStart).toISOString()}, later than the current UTC day.`,
        'Refusing to run with a count that cannot be trusted; fix the system clock or delete the ledger file.',
      );
    }
    // A stale entry from a previous day says nothing about the current one; the
    // rollover reset already happened locally and the next write replaces it.
    if (persisted.windowStart < this.windowStart) return;
    this.used = persisted.windowStart === this.windowStart ? Math.max(this.used, persisted.used) : persisted.used;
    this.windowStart = persisted.windowStart;
  }

  /** Pick up writes another process made since this meter last looked. */
  private syncFromLedger(): void {
    const persisted = this.ledger?.read();
    if (persisted !== undefined) this.adopt(persisted);
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
