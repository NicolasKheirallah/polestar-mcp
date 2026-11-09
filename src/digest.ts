import { activeWarnings, formatAge, fromKm, type Units } from './format.js';
import { batteryView, odometerMeters } from './domain-data.js';
import { extractChargingSessions, recordTimeMs, type HistoryRecord } from './history.js';
import { renderTrips, reconstructTrips } from './trips.js';
import {
  buildTimeline,
  TIMELINE_LOCATION_LABEL,
  TIMELINE_SETTINGS_LABELS,
  TIMELINE_SOURCES,
  type TimelineResult,
  type TimelineSourceRecords,
} from './timeline.js';

/**
 * The weekly digest: what changed in the recorded window, one item per question,
 * each item carrying its own window and sample count.
 *
 * It composes the trip reconstruction, the cross-domain timeline, the charging
 * sessions and the battery series, and it says out loud how little it may be
 * standing on. An empty store is reported as "nothing was observed", not as a
 * quiet week; a sparse store is named sparse; a domain that was never read says
 * so instead of implying no change. That wording is the whole point of the
 * item: a prose digest hides sample sparsity more easily than any other surface.
 *
 * Pure: records in, text and data out. The store read sits at the edge.
 */

export const DIGEST_WINDOW_DAYS = 7;
const DIGEST_WINDOW_MS = DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Fewer in-window records than this is called sparse rather than summarised as quiet. */
export const SPARSE_SAMPLE_THRESHOLD = 6;

/** What the process knows about background sampling, when it knows anything. */
export type BackgroundSampling = 'on' | 'off' | 'unknown';

export interface DigestInputs {
  nowMs: number;
  units: Units;
  /** Required, not defaulted: the operator's opt-out must arrive explicitly. */
  allowLocation: boolean;
  /** Records per Domain, as the store returned them; the digest applies its own window. */
  sources: readonly TimelineSourceRecords[];
  backgroundSampling?: BackgroundSampling | undefined;
}

export interface DigestWindow {
  startMs: number;
  endMs: number;
  days: number;
}

export interface DigestBattery {
  samples: number;
  firstSocPct: number;
  lastSocPct: number;
  firstRangeKm?: number;
  lastRangeKm?: number;
  newestAtMs: number;
}

export interface DigestCharging {
  sessions: number;
  peakPowerWatts?: number;
  /** This server stores no prices, so it makes no cost claim. */
  cost: 'not-recorded';
}

export interface DigestWarnings {
  healthSamples: number;
  /** False means no health sample was recorded, not that no warning exists. */
  observed: boolean;
  current: string[];
  added: string[];
  cleared: string[];
}

export interface DigestSettingsChange {
  source: string;
  atMs: number;
  text: string;
}

export interface DigestSettings {
  samples: number;
  changes: DigestSettingsChange[];
}

export interface DigestData {
  window: DigestWindow;
  empty: boolean;
  sparse: boolean;
  totalRecords: number;
  distanceMeters: number;
  trips: { sufficient: boolean; sampleCount: number; count: number; gaps: number; resets: number };
  battery?: DigestBattery;
  charging: DigestCharging;
  warnings: DigestWarnings;
  settings: DigestSettings;
  timelineEvents: number;
}

export interface DigestResult {
  lines: string[];
  data: DigestData;
}

type Payload = Record<string, unknown>;

const asRecord = (value: unknown): Payload | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : undefined;

const sourceKey = (input: TimelineSourceRecords): string => `${input.source.kind}/${input.source.name}`;

/**
 * Build the weekly digest.
 *
 * The window is fixed at seven days ending at the injected now, so the answer
 * does not silently mean a different span from one call to the next.
 */
export function weeklyDigest(input: DigestInputs): DigestResult {
  const { nowMs, units } = input;
  const startMs = nowMs - DIGEST_WINDOW_MS;
  const endMs = nowMs;
  const sampling = input.backgroundSampling ?? 'unknown';
  const sources = input.sources.filter(
    (source) => input.allowLocation || source.source.label !== TIMELINE_LOCATION_LABEL,
  );

  const inWindow = new Map<string, HistoryRecord[]>();
  for (const source of sources) {
    const records = source.records
      .map((record) => ({ record, atMs: recordTimeMs(record) }))
      .filter((item) => item.atMs >= startMs && item.atMs <= endMs)
      .sort((a, b) => a.atMs - b.atMs)
      .map((item) => item.record);
    inWindow.set(sourceKey(source), records);
  }
  const recordsOf = (kind: string, name: string): HistoryRecord[] => inWindow.get(`${kind}/${name}`) ?? [];
  const totalRecords = [...inWindow.values()].reduce((sum, records) => sum + records.length, 0);

  const window: DigestWindow = { startMs, endMs, days: DIGEST_WINDOW_DAYS };
  const header =
    `Weekly digest: last ${DIGEST_WINDOW_DAYS} days, ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}.`;

  if (totalRecords === 0) {
    const lines = [
      header,
      'No history was recorded in this window, so the week was not observed rather than quiet.',
      samplingSentence(sampling),
    ];
    return {
      lines,
      data: {
        window,
        empty: true,
        sparse: false,
        totalRecords: 0,
        distanceMeters: 0,
        trips: { sufficient: false, sampleCount: 0, count: 0, gaps: 0, resets: 0 },
        charging: { sessions: 0, cost: 'not-recorded' },
        warnings: { healthSamples: 0, observed: false, current: [], added: [], cleared: [] },
        settings: { samples: 0, changes: [] },
        timelineEvents: 0,
      },
    };
  }

  const timeline: TimelineResult = buildTimeline(sources, {
    sinceMs: startMs,
    untilMs: endMs,
    nowMs,
    units,
    allowLocation: input.allowLocation,
  });

  const tag = (samples: number, newestAtMs?: number): string => {
    const newest = newestAtMs === undefined ? '' : `, newest ${formatAge(newestAtMs, nowMs)}`;
    return `(last ${DIGEST_WINDOW_DAYS} days, ${samples} ${samples === 1 ? 'sample' : 'samples'}${newest})`;
  };
  const lines: string[] = [header];

  // Distance, from the odometer series through the same reconstruction get_trips uses.
  const odometerRecords = recordsOf('telemetry', 'odometer');
  const odometerSamples = odometerRecords
    .map((record) => ({ atMs: recordTimeMs(record), odometerMeters: odometerMeters(asRecord(record.data)) }))
    .filter((sample): sample is { atMs: number; odometerMeters: number } => sample.odometerMeters !== undefined);
  const trips = reconstructTrips(odometerSamples);
  const newestOdometerAt = odometerSamples.length > 0 ? odometerSamples[odometerSamples.length - 1]!.atMs : undefined;
  if (odometerSamples.length === 0) {
    lines.push(`Distance: not observed (no odometer samples in this window) ${tag(0)}.`);
  } else if (!trips.sufficient) {
    lines.push(`Distance: not reconstructed, ${trips.reason ?? 'not enough odometer history'} ${tag(trips.sampleCount, newestOdometerAt)}.`);
  } else {
    const gapText = trips.gaps.length > 0 ? `; ${trips.gaps.length} unobserved gap(s) over 24 h` : '';
    lines.push(
      `Distance: ${fromKm(trips.distanceMeters / 1000, units)} across ${trips.trips.length} movement span(s)${gapText} ` +
        `${tag(trips.sampleCount, newestOdometerAt)}.`,
    );
  }

  // Battery: the endpoints of the recorded series, never a current-state claim.
  const batteryRecords = recordsOf('telemetry', 'battery');
  const batteryPoints = batteryRecords
    .map((record) => ({ atMs: recordTimeMs(record), view: batteryView(asRecord(record.data)) }))
    .filter((point) => point.view.chargeLevelPct !== undefined);
  const firstBattery = batteryPoints[0];
  const lastBattery = batteryPoints[batteryPoints.length - 1];
  const battery: DigestBattery | undefined =
    firstBattery !== undefined && lastBattery !== undefined
      ? {
          samples: batteryPoints.length,
          firstSocPct: firstBattery.view.chargeLevelPct!,
          lastSocPct: lastBattery.view.chargeLevelPct!,
          ...(firstBattery.view.distanceToEmptyKm !== undefined ? { firstRangeKm: firstBattery.view.distanceToEmptyKm } : {}),
          ...(lastBattery.view.distanceToEmptyKm !== undefined ? { lastRangeKm: lastBattery.view.distanceToEmptyKm } : {}),
          newestAtMs: lastBattery.atMs,
        }
      : undefined;
  if (battery === undefined) {
    lines.push('Battery: not observed (no battery samples with a charge level in this window).');
  } else {
    const rangeText =
      battery.firstRangeKm !== undefined && battery.lastRangeKm !== undefined
        ? `, range ${fromKm(battery.firstRangeKm, units)} to ${fromKm(battery.lastRangeKm, units)}`
        : '';
    lines.push(
      `Battery: charge ${battery.firstSocPct}% to ${battery.lastSocPct}%${rangeText} ${tag(battery.samples, battery.newestAtMs)}.`,
    );
  }

  // Charging sessions, and no cost claim: prices are a planner argument, not stored history.
  const sessions = extractChargingSessions(batteryRecords);
  const peaks = sessions.map((session) => session.peakPowerWatts).filter((watts): watts is number => watts !== undefined);
  const peakPowerWatts = peaks.length > 0 ? Math.max(...peaks) : undefined;
  const charging: DigestCharging = {
    sessions: sessions.length,
    ...(peakPowerWatts !== undefined ? { peakPowerWatts } : {}),
    cost: 'not-recorded',
  };
  const newestBatteryAt = batteryRecords.length > 0 ? recordTimeMs(batteryRecords[batteryRecords.length - 1]!) : undefined;
  if (batteryRecords.length === 0) {
    lines.push('Charging: not observed (no battery samples in this window).');
  } else {
    const peakText = peakPowerWatts !== undefined ? `, peak ${(peakPowerWatts / 1000).toFixed(1)} kW` : '';
    lines.push(
      `Charging: ${sessions.length} session(s)${peakText}; no cost recorded because prices are not stored ` +
        `${tag(batteryRecords.length, newestBatteryAt)}.`,
    );
  }

  // Warnings: unobserved is not "none", and a warning that came and went between
  // samples cannot be claimed either way.
  const healthRecords = recordsOf('telemetry', 'health');
  let currentWarnings: string[] = [];
  const addedWarnings: string[] = [];
  const clearedWarnings: string[] = [];
  let previousWarnings: string[] | undefined;
  for (const record of healthRecords) {
    const data = asRecord(record.data);
    if (data === undefined) continue;
    const warnings = activeWarnings(data);
    if (previousWarnings !== undefined) {
      for (const warning of warnings) {
        if (!previousWarnings.includes(warning) && !addedWarnings.includes(warning)) addedWarnings.push(warning);
      }
      for (const warning of previousWarnings) {
        if (!warnings.includes(warning) && !clearedWarnings.includes(warning)) clearedWarnings.push(warning);
      }
    }
    previousWarnings = warnings;
    currentWarnings = warnings;
  }
  const warnings: DigestWarnings = {
    healthSamples: healthRecords.length,
    observed: healthRecords.length > 0,
    current: currentWarnings,
    added: addedWarnings,
    cleared: clearedWarnings,
  };
  if (healthRecords.length === 0) {
    lines.push(
      'Warnings: not observed (no health samples in this window; health is recorded only when a tool reads it, not by background sampling).',
    );
  } else {
    const newestHealthAt = recordTimeMs(healthRecords[healthRecords.length - 1]!);
    const currentText =
      currentWarnings.length === 0 ? 'none in any recorded health sample' : currentWarnings.join(', ');
    const addedText = addedWarnings.length > 0 ? `; appeared: ${addedWarnings.join(', ')}` : '';
    const clearedText = clearedWarnings.length > 0 ? `; cleared: ${clearedWarnings.join(', ')}` : '';
    const blindSpot =
      currentWarnings.length === 0 ? '; a warning that came and went between samples would not be seen' : '';
    lines.push(`Warnings: ${currentText}${addedText}${clearedText}${blindSpot} ${tag(healthRecords.length, newestHealthAt)}.`);
  }

  // Settings changes come from the timeline, so presence of a pending value is
  // not mistaken for a change: only a different rendered value is an event.
  const settingsSamples = sources
    .filter((source) => TIMELINE_SETTINGS_LABELS.includes(source.source.label))
    .reduce((sum, source) => sum + (inWindow.get(sourceKey(source))?.length ?? 0), 0);
  // The first recorded value of a settings Domain inside the window is that
  // Domain's starting value, not a change; only later different values are
  // changes. Pending values that never differ from the applied one are already
  // not events, so presence alone is never reported as a change.
  const baselineSeen = new Set<string>();
  const changes: DigestSettingsChange[] = [];
  for (const event of [...timeline.events].sort((a, b) => a.atMs - b.atMs)) {
    if (!TIMELINE_SETTINGS_LABELS.includes(event.source)) continue;
    if (!baselineSeen.has(event.source)) {
      baselineSeen.add(event.source);
      continue;
    }
    changes.push({ source: event.source, atMs: event.atMs, text: event.text });
  }
  const settings: DigestSettings = { samples: settingsSamples, changes };
  if (settingsSamples === 0) {
    lines.push(
      'Settings: not observed (no charging-settings samples in this window; those domains are recorded only when a tool reads them).',
    );
  } else if (changes.length === 0) {
    const newestSettingsAt = newestSettingsRecordAt(sources, inWindow);
    lines.push(`Settings: no changes in ${settingsSamples} recorded sample(s) ${tag(settingsSamples, newestSettingsAt)}.`);
  } else {
    const newestSettingsAt = newestSettingsRecordAt(sources, inWindow);
    lines.push(`Settings: ${changes.length} change(s) ${tag(settingsSamples, newestSettingsAt)}:`);
    for (const change of changes) {
      lines.push(`  ${new Date(change.atMs).toISOString()} ${change.source}: ${change.text}`);
    }
  }

  lines.push(
    `Timeline: ${timeline.events.length} change event(s) across ${new Set(timeline.events.map((event) => event.source)).size} ` +
      `domain(s); get_timeline lists them in order.`,
  );
  if (!input.allowLocation) {
    lines.push(`Location: excluded (POLESTAR_ALLOW_LOCATION=false, so position was never read) ${tag(0)}.`);
  }

  const sparse = totalRecords < SPARSE_SAMPLE_THRESHOLD;
  if (sparse) {
    lines.push(
      `Sparse record: only ${totalRecords} sample(s) in the window, so items marked not observed above are unobserved, not unchanged. ` +
        samplingSentence(sampling),
    );
  }

  // The trip renderer is reused by get_trips; the digest states the same facts in
  // one line above, so only the reset/gap wording that is easy to misread is
  // appended when a discontinuity exists.
  if (trips.sufficient && trips.resets.length > 0) {
    lines.push(`Odometer reset(s) in the window: ${trips.resets.length}; the interval contributes no distance.`);
  }
  if (trips.sufficient && trips.gaps.length > 0) {
    lines.push(
      `Unobserved odometer gap(s): ${trips.gaps.length}; distance across them is included but not placed in time.`,
    );
  }
  void renderTrips;

  const data: DigestData = {
    window,
    empty: false,
    sparse,
    totalRecords,
    distanceMeters: trips.distanceMeters,
    trips: {
      sufficient: trips.sufficient,
      sampleCount: trips.sampleCount,
      count: trips.trips.length,
      gaps: trips.gaps.length,
      resets: trips.resets.length,
    },
    ...(battery !== undefined ? { battery } : {}),
    charging,
    warnings,
    settings,
    timelineEvents: timeline.events.length,
  };
  return { lines, data };
}

/** Newest in-window record among the settings Domains, for the age tag. */
function newestSettingsRecordAt(
  sources: readonly TimelineSourceRecords[],
  inWindow: ReadonlyMap<string, HistoryRecord[]>,
): number | undefined {
  let newest: number | undefined;
  for (const source of sources) {
    if (!TIMELINE_SETTINGS_LABELS.includes(source.source.label)) continue;
    const records = inWindow.get(sourceKey(source)) ?? [];
    for (const record of records) {
      const at = recordTimeMs(record);
      if (newest === undefined || at > newest) newest = at;
    }
  }
  return newest;
}

function samplingSentence(sampling: BackgroundSampling): string {
  switch (sampling) {
    case 'on':
      return 'Background sampling is on, so a sparse week means the server was not running for most of it.';
    case 'off':
      return 'Background sampling is off (POLESTAR_SAMPLE is unset), so history holds only what tool calls read.';
    case 'unknown':
      return 'Background sampling is off unless POLESTAR_SAMPLE=on; otherwise history holds only what tool calls read.';
  }
}

/** The Domains the digest reads; exported so the tool and a test name the same set. */
export const DIGEST_SOURCES = TIMELINE_SOURCES.filter((source) =>
  ['battery', 'odometer', 'health', 'amp limit', 'target charge level', 'charge window', 'climate timers'].includes(source.label),
);
