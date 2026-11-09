import { mkdirSync, appendFileSync, chmodSync, readFileSync, existsSync, statSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { batteryView, isChargingStatus } from './domain-data.js';

/** The read guard: a file larger than this is refused instead of loaded whole. */
export const MAX_HISTORY_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The default append bound. When a file would grow past it, the oldest half of
 * its lines is dropped before the new record is written, so the newest records
 * always survive and the read guard above is never the first thing a long-lived
 * install meets. A store built without this argument keeps the old behaviour of
 * an unbounded append.
 */
export const DEFAULT_MAX_HISTORY_FILE_BYTES = MAX_HISTORY_FILE_BYTES;

const statSyncSize = (file: string): number | undefined => {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
};

export interface HistoryRecord {
  /**
   * Epoch ms when the server read the value, the read clock. It is what the
   * store sorts and filters on, and for records written before the value clock
   * existed it is also the only timestamp available.
   */
  observedAt: number;
  /**
   * Epoch ms of the value's own clock: the payload `timestamp.seconds`, or
   * `metaReceivedAt` when the payload carries no sensor timestamp. Optional so
   * every file written before this field existed stays readable; when absent the
   * read clock above is rendered instead and the answer says so.
   */
  valueObservedAt?: number | undefined;
  /** Cloud-assigned change ID. Consecutive repeats of the last stored ID for a file are
   * dropped from an in-memory map, so the guard holds within a process run, not across
   * restarts and not for an ID that reappears after a different one. */
  metaEventId?: string | undefined;
  /** The unwrapped domain payload as the car reported it. */
  data: unknown;
}

/** When the sample itself happened: the value clock when recorded, else the read clock. */
export function recordTimeMs(record: HistoryRecord): number {
  return record.valueObservedAt ?? record.observedAt;
}

export interface HistoryQuery {
  /** Only records observed at or after this epoch ms. */
  sinceMs?: number | undefined;
  /** Only records observed at or before this epoch ms. */
  untilMs?: number | undefined;
  /** Newest-first when true (default). */
  newestFirst?: boolean | undefined;
  limit?: number | undefined;
}

/**
 * Append-only JSONL history, one file per vehicle+domain. The API is
 * stateless-present, it answers only "what is true right now", so any
 * longitudinal feature (degradation, charging sessions, air-quality trend)
 * depends on a local store like this one. Deduplication is by metaEventId:
 * the cloud re-serves the same ID until the car reports something new, so
 * unchanged snapshots cost a single line each and query files stay small.
 *
 * The append bound is a retention rule, not a hard cap: a file that would grow
 * past `maxFileBytes` is rewritten with its newest half before the new record
 * is added, so the store stays readable without an operator pruning by hand.
 * The constant read guard above still refuses a file that grew some other way.
 */
export class HistoryStore {
  /** The append bound in bytes, clamped to the read guard so a hand-set value cannot make reads impossible. */
  readonly maxFileBytes: number;

  constructor(readonly rootDir: string, maxFileBytes: number = DEFAULT_MAX_HISTORY_FILE_BYTES) {
    this.maxFileBytes = Math.min(Math.max(Math.trunc(maxFileBytes), 64), MAX_HISTORY_FILE_BYTES);
  }

  append(vin: string, kind: string, name: string, record: HistoryRecord): void {
    const file = this.fileFor(vin, kind, name);
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.tighten(dir, 0o700);
    const lastId = this.lastEventId.get(file) ?? this.tailEventId(file);
    if (record.metaEventId !== undefined && record.metaEventId === lastId) return;
    const line = JSON.stringify(record) + '\n';
    this.pruneIfNeeded(file, Buffer.byteLength(line));
    if (record.metaEventId !== undefined) this.lastEventId.set(file, record.metaEventId);
    appendFileSync(file, line, { mode: 0o600 });
    this.tighten(file, 0o600);
  }

  /**
   * The store can hold position history, so its files and per-vehicle
   * directories are owner-only. `mode` only applies when a path is created, so a
   * file left loose by an older release or a loose umask is tightened here, and a
   * retention rewrite below sets the same mode on the replacement.
   */
  private tighten(target: string, mode: number): void {
    try {
      if ((statSync(target).mode & 0o077) !== 0) chmodSync(target, mode);
    } catch {
      /* a path that vanished between creation and stat is not worth failing on */
    }
  }

  /**
   * Keep the newest half of a file that would exceed the append bound. The
   * rewrite goes through a sibling temporary file and a rename, so a crash
   * cannot leave a half-written history in place of the original. A single
   * record larger than the whole bound is still kept: losing the newest sample
   * is worse than exceeding the retention target once.
   */
  private pruneIfNeeded(file: string, incomingBytes: number): void {
    const size = statSyncSize(file);
    if (size === undefined || size + incomingBytes <= this.maxFileBytes) return;
    let lines: string[];
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    } catch {
      return;
    }
    if (lines.length === 0) return;
    const keep = Math.max(1, Math.ceil(lines.length / 2));
    const kept = lines.slice(lines.length - keep);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, kept.join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  }

  query(vin: string, kind: string, name: string, q: HistoryQuery = {}): HistoryRecord[] {
    const file = this.fileFor(vin, kind, name);
    if (!existsSync(file)) return [];
    // A whole file is read into memory, so refuse to do that to an unexpectedly
    // enormous one rather than stalling the tool call that asked.
    if ((statSyncSize(file) ?? 0) > MAX_HISTORY_FILE_BYTES) {
      throw new Error(`history file ${path.relative(this.rootDir, file)} is larger than ${MAX_HISTORY_FILE_BYTES} bytes; prune it before querying`);
    }
    const records: HistoryRecord[] = [];
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as HistoryRecord);
      } catch {
        // A torn last line (crash mid-append) is not fatal to reads.
      }
    }
    const filtered = records.filter(
      (r) => r.observedAt >= (q.sinceMs ?? -Infinity) && r.observedAt <= (q.untilMs ?? Infinity),
    );
    filtered.sort((a, b) => (q.newestFirst === false ? a.observedAt - b.observedAt : b.observedAt - a.observedAt));
    return q.limit !== undefined ? filtered.slice(0, q.limit) : filtered;
  }

  /** Oldest→newest battery records, for trend math. */
  batteryChronological(vin: string, sinceMs?: number): HistoryRecord[] {
    return this.query(vin, 'telemetry', 'battery', { sinceMs, newestFirst: false });
  }

  private fileFor(vin: string, kind: string, name: string): string {
    // VIN and domain names are constrained character sets; belt and braces.
    const safeVin = vin.replace(/[^A-Za-z0-9]/g, '');
    const safeDomain = `${kind}-${name}`.replace(/[^a-z0-9-]/gi, '');
    return path.resolve(this.rootDir, safeVin, `${safeDomain}.jsonl`);
  }

  /**
   * Last cloud change id per file. Held in memory for speed, but seeded from the
   * tail of the file on first write: measured against the live API, a restarted
   * server re-served the same metaEventId and appended it a second time, because
   * the map started empty while the file did not.
   */
  private readonly lastEventId = new Map<string, string>();

  private tailEventId(file: string): string | undefined {
    if (!existsSync(file)) return undefined;
    try {
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = JSON.parse(lines[i] ?? '{}') as { metaEventId?: unknown };
        if (typeof parsed.metaEventId === 'string') return parsed.metaEventId;
      }
    } catch {
      // A torn or unreadable tail means no known last id; appending once is the
      // safe reading of that, not a reason to lose the write.
    }
    return undefined;
  }
}

export interface ChargingSession {
  startedAt: number;
  lastSeenAt: number;
  /** Seconds between the first and last charging sample. Gaps are included, so this is
   * the span a session covers, not the time the charger was actually delivering power. */
  activeSeconds: number;
  /** Highest reported charging power. Absent when no sample in the session reported
   * power at all: an unreported value is not a measured zero. */
  peakPowerWatts?: number | undefined;
  /** Charge level at the first and last sample, for the energy a session added. */
  startChargeLevelPct?: number | undefined;
  endChargeLevelPct?: number | undefined;
  maxChargeLevelPct?: number | undefined;
  sampleCount: number;
}

export interface DegradationPoint {
  observedAt: number;
  socPct: number;
  estimatedRangeKm?: number;
  /** Full-charge range implied by range/SoC, the degradation signal. */
  impliedFullRangeKm?: number;
  /** Usable pack kWh implied by dischargeInfo.energyAvailable and SoC. */
  impliedCapacityKwh?: number;
}

/**
 * Session reconstruction from battery samples: a session is a maximal run of
 * samples where the car reported an active charging status or non-zero
 * charging power, allowing gaps up to gapMs (default 30min) before closing.
 */
export function extractChargingSessions(samples: HistoryRecord[], gapMs = 30 * 60 * 1000): ChargingSession[] {
  interface Sample {
    at: number;
    /** Undefined when the car reported no charging power, not zero. */
    power: number | undefined;
    charging: boolean;
    level: number | undefined;
  }
  const parsed: Sample[] = [];
  for (const record of samples) {
    const stored = record.data;
    if (stored === null || typeof stored !== 'object') continue;
    const view = batteryView(stored as Record<string, unknown>);
    const power = view.powerWatts;
    // The enum rule belongs to the payload reader, not to this loop: endsWith,
    // not includes, because 'CHARGING_STATUS_V2_IDLE' contains "CHARGING" as a
    // substring of the enum namespace.
    const charging = (power !== undefined && power > 0) || isChargingStatus(view.status);
    parsed.push({ at: recordTimeMs(record), power, charging, level: view.chargeLevelPct });
  }
  parsed.sort((a, b) => a.at - b.at);

  const sessions: ChargingSession[] = [];
  let current: { samples: Sample[] } | undefined;
  for (const sample of parsed) {
    if (sample.charging) {
      if (current && sample.at - current.samples[current.samples.length - 1]!.at > gapMs) {
        finalize();
      }
      (current ??= { samples: [] }).samples.push(sample);
    } else if (current) {
      finalize();
    }
  }
  finalize();
  return sessions;

  function finalize(): void {
    if (!current || current.samples.length === 0) {
      current = undefined;
      return;
    }
    const s = current.samples;
    const levels = s.map((x) => x.level).filter((l): l is number => l !== undefined);
    const powers = s.map((x) => x.power).filter((p): p is number => p !== undefined);
    const firstLevel = s.find((x) => x.level !== undefined)?.level;
    const lastLevel = [...s].reverse().find((x) => x.level !== undefined)?.level;
    sessions.push({
      startedAt: s[0]!.at,
      lastSeenAt: s[s.length - 1]!.at,
      activeSeconds: Math.round((s[s.length - 1]!.at - s[0]!.at) / 1000),
      ...(powers.length > 0 ? { peakPowerWatts: powers.reduce((max, p) => Math.max(max, p), 0) } : {}),
      ...(firstLevel !== undefined ? { startChargeLevelPct: firstLevel } : {}),
      ...(lastLevel !== undefined ? { endChargeLevelPct: lastLevel } : {}),
      ...(levels.length > 0 ? { maxChargeLevelPct: levels.reduce((max, l) => Math.max(max, l), 0) } : {}),
      sampleCount: s.length,
    });
    current = undefined;
  }
}

/**
 * Degradation signal from (SoC, range) pairs: full-charge range implied by
 * range/SoC, and pack capacity implied by dischargeInfo.energyAvailable when
 * the car reports it. Both are estimates, range is conditions-dependent 
 * so the report presents the series, not a single verdict.
 *
 * A record that reports neither a range nor usable energy contributes no
 * signal, so it is dropped here rather than counted as a sample the report
 * could use. Its time is the value clock when the recorder stored one.
 */
export function degradationSeries(samples: HistoryRecord[]): DegradationPoint[] {
  const points: DegradationPoint[] = [];
  for (const record of samples) {
    const stored = record.data;
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) continue;
    const view = batteryView(stored as Record<string, unknown>);
    const soc = view.chargeLevelPct;
    if (soc === undefined || soc <= 5) continue; // low-SoC range estimates are noisy
    const range = view.distanceToEmptyKm;
    const energyAvailable = view.energyAvailableKwh;
    const hasRange = range !== undefined;
    const hasCapacity = energyAvailable !== undefined && energyAvailable > 0;
    if (!hasRange && !hasCapacity) continue;
    points.push({
      observedAt: recordTimeMs(record),
      socPct: soc,
      ...(hasRange
        ? {
            estimatedRangeKm: range,
            impliedFullRangeKm: Math.round((range / soc) * 100),
          }
        : {}),
      ...(hasCapacity
        ? { impliedCapacityKwh: Math.round((energyAvailable / soc) * 100 * 10) / 10 }
        : {}),
    });
  }
  return points;
}


/** The percentile of a two-sided 95 percent Student t distribution, for small-sample intervals. */
export function tCritical95(df: number): number {
  if (!Number.isFinite(df) || df < 1) return 12.706;
  // A short table is honest about approximation; above 30 degrees of freedom the
  // normal value is close enough for a range trend read by a person.
  const table = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  const index = Math.min(Math.floor(df), table.length) - 1;
  return table[Math.max(0, index)]!;
}

export interface LinearTrend {
  /** Change of y per day of x. */
  slopePerDay: number;
  /** Change of y per 30.44-day month, the unit a person reads. */
  slopePerMonth: number;
  /** 95 percent confidence interval for the monthly slope. */
  monthlyLow: number;
  monthlyHigh: number;
  n: number;
  df: number;
  /** True when the interval excludes zero, the only case the caller may call a trend. */
  excludesZero: boolean;
}

/**
 * Ordinary least-squares slope with a 95 percent interval. `x` is days since the
 * first point and `y` is the value being trended. Fewer than three points has no
 * residual degrees of freedom, so it answers undefined instead of a slope.
 */
export function linearTrend(points: readonly { x: number; y: number }[]): LinearTrend | undefined {
  const n = points.length;
  if (n < 3) return undefined;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    sxx += (point.x - meanX) ** 2;
    sxy += (point.x - meanX) * (point.y - meanY);
  }
  if (sxx === 0) return undefined;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let residual = 0;
  for (const point of points) residual += (point.y - (intercept + slope * point.x)) ** 2;
  const df = n - 2;
  if (df < 1) return undefined;
  const standardError = Math.sqrt(residual / df / sxx);
  const margin = tCritical95(df) * standardError;
  const perMonth = 30.44;
  return {
    slopePerDay: slope,
    slopePerMonth: slope * perMonth,
    monthlyLow: (slope - margin) * perMonth,
    monthlyHigh: (slope + margin) * perMonth,
    n,
    df,
    excludesZero: slope - margin > 0 || slope + margin < 0,
  };
}

/** Median of the finite values, used to combine per-sample capacity estimates. */
export function median(values: readonly number[]): number | undefined {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return undefined;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 1 ? finite[middle] : (finite[middle - 1]! + finite[middle]!) / 2;
}

export interface OdometerRate {
  /** Kilometres per day from the usable steps, absent when there were none. */
  kmPerDay?: number | undefined;
  /** Days between the first and last usable sample, a span not an observing time. */
  spanDays?: number | undefined;
  /** Number of odometer samples that carried a reading. */
  samples: number;
  /** Steps discarded because the odometer went backwards, i.e. a reset or a replaced unit. */
  resets: number;
}

/**
 * Distance rate from odometer records. A decreasing odometer is a reset, not
 * negative distance, so backward steps are discarded and counted; forward steps
 * with no elapsed time are ignored too. The rate is distance-weighted, so a
 * long parked gap does not pretend the car drove during it.
 */
export function odometerRate(samples: HistoryRecord[]): OdometerRate {
  const readings: { at: number; meters: number }[] = [];
  for (const record of samples) {
    const stored = record.data;
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) continue;
    const meters = (stored as Record<string, unknown>).odometerMeters;
    if (typeof meters !== 'number' || !Number.isFinite(meters)) continue;
    readings.push({ at: recordTimeMs(record), meters });
  }
  readings.sort((a, b) => a.at - b.at);
  let metres = 0;
  let ms = 0;
  let resets = 0;
  for (let i = 1; i < readings.length; i++) {
    const previous = readings[i - 1]!;
    const current = readings[i]!;
    const deltaMeters = current.meters - previous.meters;
    const deltaMs = current.at - previous.at;
    if (deltaMeters < 0) {
      resets += 1;
      continue;
    }
    if (deltaMs <= 0) continue;
    metres += deltaMeters;
    ms += deltaMs;
  }
  const first = readings[0];
  const last = readings[readings.length - 1];
  return {
    ...(ms > 0 ? { kmPerDay: metres / 1000 / (ms / 86_400_000) } : {}),
    ...(first !== undefined && last !== undefined ? { spanDays: (last.at - first.at) / 86_400_000 } : {}),
    samples: readings.length,
    resets,
  };
}
