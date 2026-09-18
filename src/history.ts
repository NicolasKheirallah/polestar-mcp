import { mkdirSync, appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_HISTORY_FILE_BYTES = 64 * 1024 * 1024;

const statSyncSize = (file: string): number | undefined => {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
};

export interface HistoryRecord {
  /** Epoch ms when the server observed the value. */
  observedAt: number;
  /** Cloud-assigned change ID. Consecutive repeats of the last stored ID for a file are
   * dropped from an in-memory map, so the guard holds within a process run, not across
   * restarts and not for an ID that reappears after a different one. */
  metaEventId?: string | undefined;
  /** The unwrapped domain payload as the car reported it. */
  data: unknown;
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
 */
export class HistoryStore {
  constructor(readonly rootDir: string) {}

  append(vin: string, kind: string, name: string, record: HistoryRecord): void {
    const file = this.fileFor(vin, kind, name);
    mkdirSync(path.dirname(file), { recursive: true });
    const lastId = this.lastEventId.get(file) ?? this.tailEventId(file);
    if (record.metaEventId !== undefined && record.metaEventId === lastId) return;
    if (record.metaEventId !== undefined) this.lastEventId.set(file, record.metaEventId);
    appendFileSync(file, JSON.stringify(record) + '\n');
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
  peakPowerWatts: number;
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
    power: number;
    charging: boolean;
    level: number | undefined;
  }
  const parsed: Sample[] = [];
  for (const record of samples) {
    const d = record.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object') continue;
    const power = typeof d.chargingPowerWatts === 'number' ? d.chargingPowerWatts : 0;
    const status = typeof d.chargingStatusV2 === 'string' ? d.chargingStatusV2 : '';
    // endsWith, not includes: 'CHARGING_STATUS_V2_IDLE' contains "CHARGING"
    // as a substring of the enum namespace.
    const charging = power > 0 || status.endsWith('_CHARGING');
    const level = typeof d.batteryChargeLevelPercentage === 'number' ? d.batteryChargeLevelPercentage : undefined;
    parsed.push({ at: record.observedAt, power, charging, level });
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
    sessions.push({
      startedAt: s[0]!.at,
      lastSeenAt: s[s.length - 1]!.at,
      activeSeconds: Math.round((s[s.length - 1]!.at - s[0]!.at) / 1000),
      peakPowerWatts: Math.max(...s.map((x) => x.power)),
      ...(levels.length > 0 ? { maxChargeLevelPct: Math.max(...levels) } : {}),
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
 */
export function degradationSeries(samples: HistoryRecord[]): DegradationPoint[] {
  const points: DegradationPoint[] = [];
  for (const record of samples) {
    const d = record.data as Record<string, unknown> | null;
    if (!d) continue;
    const soc = d.batteryChargeLevelPercentage;
    if (typeof soc !== 'number' || soc <= 5) continue; // low-SoC range estimates are noisy
    const range = typeof d.estimatedDistanceToEmptyKm === 'number' ? d.estimatedDistanceToEmptyKm : undefined;
    const energyAvailable = (d.dischargeInfo as { energyAvailable?: unknown } | undefined)?.energyAvailable;
    points.push({
      observedAt: record.observedAt,
      socPct: soc,
      ...(range !== undefined
        ? {
            estimatedRangeKm: range,
            impliedFullRangeKm: Math.round((range / soc) * 100),
          }
        : {}),
      ...(typeof energyAvailable === 'number' && energyAvailable > 0
        ? { impliedCapacityKwh: Math.round((energyAvailable / soc) * 100 * 10) / 10 }
        : {}),
    });
  }
  return points;
}

