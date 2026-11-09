import {
  activeWarnings,
  formatAge,
  formatUtcOffset,
  fromKm,
  humanizeEnum,
  km,
  normalizeHour,
  type Units,
} from './format.js';
import {
  ampLimitA,
  batteryView,
  chargeWindow,
  healthView,
  numberField,
  odometerMeters,
  pendingAmpLimitA,
  position,
  targetSoc,
} from './domain-data.js';
import { recordTimeMs, type HistoryRecord } from './history.js';

/**
 * The cross-domain timeline: one ordered list of what the car was recorded
 * doing, across the Domains that report change.
 *
 * `get_history` answers one Domain at a time, so a question like "what happened
 * yesterday" needed several calls and the caller had to merge them. This module
 * owns the merge and the per-Domain field map, and states the two things a
 * merged list can easily overclaim: a reading's time is the value's own clock
 * where the recorder stored one, and two events close in time are not proof that
 * one caused the other.
 *
 * Pure: records in, timeline out. The store read sits at the edge.
 */

/** A Domain the timeline reads, with the label the rendered line uses. */
export interface TimelineSource {
  kind: 'telemetry' | 'charging';
  name: string;
  label: string;
}

/**
 * The Domains a timeline merges. Battery, odometer, location and exterior are
 * the sampled set; health and the charging settings are recorded only when a
 * tool read them, which the absent/notes wording says rather than hides.
 */
export const TIMELINE_SOURCES: readonly TimelineSource[] = [
  { kind: 'telemetry', name: 'battery', label: 'battery' },
  { kind: 'telemetry', name: 'odometer', label: 'odometer' },
  { kind: 'telemetry', name: 'location', label: 'location' },
  { kind: 'telemetry', name: 'health', label: 'health' },
  { kind: 'charging', name: 'amp-limit', label: 'amp limit' },
  { kind: 'charging', name: 'target-soc', label: 'target charge level' },
  { kind: 'charging', name: 'global-charge-timer', label: 'charge window' },
  { kind: 'charging', name: 'parking-climate-timer', label: 'climate timers' },
];

/** The location Domain, the only one gated by POLESTAR_ALLOW_LOCATION. */
export const TIMELINE_LOCATION_LABEL = 'location';

/** Labels the digest treats as a settings change. */
export const TIMELINE_SETTINGS_LABELS: readonly string[] = [
  'amp limit',
  'target charge level',
  'charge window',
  'climate timers',
];

type Payload = Record<string, unknown>;

const asRecord = (value: unknown): Payload | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : undefined;

interface Summary {
  /** One line for the timeline row. */
  text: string;
  /** Changes to these mean the row is worth listing; an identical snapshot is not. */
  key: string;
  /** Health only: the warning labels this payload reports, for transition wording. */
  warnings?: string[];
}

const padHour = (hour: number | undefined): string =>
  hour === undefined ? 'n/a' : `${String(normalizeHour(hour)).padStart(2, '0')}:00`;

/**
 * One summarizer per Domain. A reader that returns `undefined` means this
 * server has no honest line for the payload, and the record is skipped rather
 * than rendered as a JSON blob; the field map is here so a renamed upstream
 * field has one place to change.
 */
function summarize(source: TimelineSource, data: Payload, units: Units): Summary | undefined {
  switch (`${source.kind}/${source.name}`) {
    case 'telemetry/battery': {
      const view = batteryView(data);
      const parts: string[] = [];
      if (view.chargeLevelPct !== undefined) parts.push(`charge ${view.chargeLevelPct}%`);
      if (view.distanceToEmptyKm !== undefined) parts.push(`range ${fromKm(view.distanceToEmptyKm, units)}`);
      parts.push(`charging ${humanizeEnum(view.status)} / ${humanizeEnum(view.connection)}`);
      if (view.powerWatts !== undefined && view.powerWatts > 0) {
        parts.push(`power ${(view.powerWatts / 1000).toFixed(1)} kW`);
      }
      return {
        text: parts.join(' · '),
        key: JSON.stringify([
          view.chargeLevelPct,
          view.distanceToEmptyKm,
          view.status,
          view.connection,
          view.powerWatts,
          view.timeToFullMinutes,
          view.consumptionKwhPer100Km,
        ]),
      };
    }
    case 'telemetry/odometer': {
      const meters = odometerMeters(data);
      const automatic = numberField(data, 'tripMeterAutomaticKm');
      const manual = numberField(data, 'tripMeterManualKm');
      const parts = [`odometer ${km(meters, units)}`];
      if (automatic !== undefined) parts.push(`trip ${fromKm(automatic, units)} automatic`);
      if (manual !== undefined) parts.push(`trip ${fromKm(manual, units)} manual`);
      return { text: parts.join(' · '), key: JSON.stringify([meters, automatic, manual]) };
    }
    case 'telemetry/location': {
      const where = position(data);
      if (where === undefined || where.latitude === undefined || where.longitude === undefined) {
        return { text: 'position not reported', key: 'unreported' };
      }
      const parts = [`position ${where.latitude.toFixed(5)}, ${where.longitude.toFixed(5)}`];
      if (where.heading !== undefined) parts.push(`heading ${where.heading}°`);
      if (where.speedKmh !== undefined) parts.push(`${where.speedKmh} km/h`);
      if (where.altitude !== undefined) parts.push(`altitude ${where.altitude} m`);
      return {
        text: parts.join(' · '),
        key: JSON.stringify([where.latitude, where.longitude, where.heading, where.speedKmh, where.altitude]),
      };
    }
    case 'telemetry/health': {
      const view = healthView(data);
      const warnings = activeWarnings(data).sort();
      const parts: string[] = [];
      if (view.daysToService !== undefined) parts.push(`service in ${view.daysToService} days`);
      if (view.distanceToServiceKm !== undefined) parts.push(`${fromKm(view.distanceToServiceKm, units)} to service`);
      parts.push(warnings.length === 0 ? 'no warnings reported' : `warnings: ${warnings.join(', ')}`);
      return {
        text: parts.join(' · '),
        key: JSON.stringify([view.daysToService, view.distanceToServiceKm, warnings]),
        warnings,
      };
    }
    case 'charging/amp-limit': {
      const applied = ampLimitA(data);
      const pending = pendingAmpLimitA(data);
      const parts = [`AC charge current limit ${applied ?? 'n/a'} A`];
      if (pending !== undefined && pending !== applied) parts.push(`recorded change to ${pending} A not yet confirmed`);
      return { text: parts.join(' · '), key: JSON.stringify([applied, pending]) };
    }
    case 'charging/target-soc': {
      const target = targetSoc(data);
      return {
        text: `target charge level ${target.levelPct ?? 'n/a'}% (${humanizeEnum(target.settingType)})`,
        key: JSON.stringify([target.levelPct, target.settingType]),
      };
    }
    case 'charging/global-charge-timer': {
      const timer = chargeWindow(data);
      if (timer === undefined) return { text: 'no global charge timer reported', key: 'none' };
      const offset = formatUtcOffset(timer.offsetMinutes);
      const state =
        timer.activated === true ? 'active' : timer.activated === false ? 'defined but inactive' : 'activation not reported';
      return {
        text: `charge window ${padHour(timer.startHour)} to ${padHour(timer.stopHour)}${offset === undefined ? '' : ` (${offset})`} (${state})`,
        key: JSON.stringify([timer.activated, timer.startHour, timer.stopHour, timer.offsetMinutes]),
      };
    }
    case 'charging/parking-climate-timer': {
      const raw = data.parkingClimateTimers;
      const timers = Array.isArray(raw) ? raw : [];
      if (timers.length === 0) return { text: 'no parking climate timers reported', key: 'none' };
      const active = timers.filter((timer) => asRecord(timer)?.activated === true).length;
      return {
        text: `${timers.length} climate timer(s), ${active} active`,
        key: JSON.stringify(raw),
      };
    }
    default:
      return undefined;
  }
}

/** One source's records, as the store returned them: the caller does the read. */
export interface TimelineSourceRecords {
  source: TimelineSource;
  /**
   * Records for this source. The builder keeps only those inside the window, so
   * the caller may pass the store's natural answer; passing a pre-filtered set is
   * also correct.
   */
  records: readonly HistoryRecord[];
  /**
   * Whether the store holds any record for this source at all, outside the
   * window too. The caller checks this (one extra read) so the timeline can say
   * "never recorded" instead of "no records in this window"; undefined when the
   * caller did not check.
   */
  anyRecords?: boolean | undefined;
}

export interface TimelineOptions {
  sinceMs: number;
  untilMs: number;
  /** Injected clock for the relative ages. */
  nowMs: number;
  units: Units;
  /** Required, not defaulted: the operator's opt-out must arrive explicitly. */
  allowLocation: boolean;
}

export interface TimelineEvent {
  atMs: number;
  /** ISO 8601, the value's own clock where the recorder stored one. */
  at: string;
  /** How long before the injected now: "5 min ago". */
  age: string;
  /** Domain label, e.g. "battery" or "charge window". */
  source: string;
  text: string;
}

export interface TimelineAbsent {
  source: string;
  reason: 'no-records-in-window' | 'never-recorded';
}

export interface TimelineResult {
  windowStartMs: number;
  windowEndMs: number;
  /** Newest first. */
  events: TimelineEvent[];
  /** Records inside the window across the included Domains. */
  recordCount: number;
  /** Records inside the window that have no value clock and are dated by the read clock. */
  readClockRecords: number;
  absent: TimelineAbsent[];
  /** Domains skipped because the operator asked for no position reads. */
  excluded: string[];
  notes: string[];
}

interface PendingEvent {
  atMs: number;
  seq: number;
  source: string;
  text: string;
}

/** The sources the timeline is allowed to read: location follows the operator's opt-out. */
export function timelineSources(allowLocation: boolean): readonly TimelineSource[] {
  return TIMELINE_SOURCES.filter((source) => allowLocation || source.label !== TIMELINE_LOCATION_LABEL);
}

/**
 * Merge the Domains into one ordered list of changes.
 *
 * A record becomes an event when its rendered values differ from the previous
 * record of the same Domain: a repeated identical snapshot is not news, and a
 * quiet timeline of unchanged values is not a quiet car. The first record of a
 * Domain in the window is always an event, because it is the first observation
 * the window has. Health rows carry warning transitions in their wording: a
 * warning that appears is named as new, one that disappears as cleared, and a
 * payload whose warning set never changed produces no warning claim.
 */
export function buildTimeline(
  sources: readonly TimelineSourceRecords[],
  options: TimelineOptions,
): TimelineResult {
  const { sinceMs, untilMs, nowMs, units, allowLocation } = options;
  const excluded = allowLocation ? [] : [TIMELINE_LOCATION_LABEL];
  const events: PendingEvent[] = [];
  const absent: TimelineAbsent[] = [];
  const notes: string[] = [];
  let recordCount = 0;
  let readClockRecords = 0;
  let includeUnsampledNote = false;
  let sequence = 0;

  for (const input of sources) {
    const source = input.source;
    if (!allowLocation && source.label === TIMELINE_LOCATION_LABEL) continue;
    const inWindow = input.records
      .map((record) => ({ record, atMs: recordTimeMs(record) }))
      .filter((item) => item.atMs >= sinceMs && item.atMs <= untilMs)
      .map((item, index) => ({ ...item, index }))
      .sort((a, b) => a.atMs - b.atMs || a.index - b.index);

    if (inWindow.length === 0) {
      absent.push({
        source: source.label,
        reason: input.anyRecords === false ? 'never-recorded' : 'no-records-in-window',
      });
      continue;
    }
    recordCount += inWindow.length;
    let previousKey: string | undefined;
    let previousWarnings: string[] | undefined;
    for (const item of inWindow) {
      if (item.record.valueObservedAt === undefined) readClockRecords += 1;
      const data = asRecord(item.record.data);
      if (data === undefined) continue;
      const summary = summarize(source, data, units);
      if (summary === undefined) continue;

      let text = summary.text;
      if (source.name === 'health') {
        const warnings = summary.warnings ?? [];
        if (previousWarnings !== undefined) {
          const added = warnings.filter((warning) => !previousWarnings!.includes(warning));
          const cleared = previousWarnings.filter((warning) => !warnings.includes(warning));
          if (added.length > 0) text += ` · new warning: ${added.join(', ')}`;
          if (cleared.length > 0) text += ` · warning cleared: ${cleared.join(', ')}`;
        } else if (warnings.length > 0) {
          text += ` · first recorded health sample reports: ${warnings.join(', ')}`;
        }
        previousWarnings = warnings;
      }

      const changed = previousKey === undefined || summary.key !== previousKey;
      previousKey = summary.key;
      if (!changed) continue;
      events.push({ atMs: item.atMs, seq: sequence, source: source.label, text });
      sequence += 1;
    }
    if (
      input.anyRecords === false &&
      (source.name === 'health' || TIMELINE_SETTINGS_LABELS.includes(source.label))
    ) {
      includeUnsampledNote = true;
    }
  }

  events.sort((a, b) => b.atMs - a.atMs || b.seq - a.seq);

  if (readClockRecords > 0) {
    notes.push(
      `${readClockRecords} record(s) are dated by the server read clock because they were stored before the value clock existed, so their time is when the server read them, not when the car changed.`,
    );
  }
  if (includeUnsampledNote) {
    notes.push(
      'Health and charging settings are recorded only when a tool reads them; background sampling covers battery, exterior, location and odometer.',
    );
  }
  const distinctSources = new Set(events.map((event) => event.source));
  if (distinctSources.size > 1) {
    notes.push('Readings are ordered in time, not by cause: two events close in time are not proof that one produced the other.');
  }

  return {
    windowStartMs: sinceMs,
    windowEndMs: untilMs,
    events: events.map((event) => ({
      atMs: event.atMs,
      at: new Date(event.atMs).toISOString(),
      age: formatAge(event.atMs, nowMs),
      source: event.source,
      text: event.text,
    })),
    recordCount,
    readClockRecords,
    absent,
    excluded,
    notes,
  };
}

/**
 * Render the timeline as lines, newest first. The empty-store sentence exists so
 * "no events" is read as "nothing was observed", which is a different claim from
 * "nothing happened".
 */
export function renderTimeline(result: TimelineResult): string[] {
  const windowHours = Math.round((result.windowEndMs - result.windowStartMs) / 3_600_000);
  const lines: string[] = [
    `Timeline: ${result.events.length} event(s) from ${result.recordCount} record(s), ` +
      `${new Date(result.windowStartMs).toISOString()} to ${new Date(result.windowEndMs).toISOString()} ` +
      `(${windowHours} h window), newest first.`,
  ];
  if (result.excluded.length > 0) {
    lines.push(`Excluded: ${result.excluded.join(', ')} (POLESTAR_ALLOW_LOCATION=false, so position was never read).`);
  }
  if (result.events.length === 0) {
    if (result.recordCount === 0) {
      lines.push(
        'No history records for these domains in this window. That means nothing was observed, not that nothing happened: ' +
          'history records only what a tool read, and background sampling is off unless POLESTAR_SAMPLE=on.',
      );
    } else {
      lines.push(`${result.recordCount} record(s) in the window produced no rendered event.`);
    }
  } else {
    for (const event of result.events) {
      lines.push(`  ${event.at} (${event.age}) ${event.source}: ${event.text}`);
    }
  }
  for (const entry of result.absent) {
    const why = entry.reason === 'never-recorded' ? 'never recorded for this vehicle' : 'no records in this window';
    lines.push(`No records: ${entry.source} (${why}).`);
  }
  for (const note of result.notes) lines.push(`Note: ${note}`);
  return lines;
}
