import { z } from 'zod';
import {
  degradationSeries,
  extractChargingSessions,
  HistoryStore,
  recordTimeMs,
  type HistoryRecord,
} from './history.js';
import { PolestarApiError } from './client.js';
import { DOMAINS, findDomain } from './domains.js';
import { ampLimitA, pendingAmpLimitA, targetSoc } from './domain-data.js';
import { delegatedAccountArg, errorResult, text, vinArg, type ToolDeps, type VinArgs } from './tool-output.js';
import { vehicleFor } from './vehicle-read.js';
import type { ToolSpec } from './tools.js';

/** get_history names the Domain to read, as `kind/name`. */
type HistoryArgs = VinArgs & { domain?: string; hours?: number; limit?: number; offset?: number; before?: string };
/** The trend tools take a look-back instead. */
type SinceArgs = VinArgs & { days?: number };

export interface HistoryDeps extends ToolDeps {
  store: HistoryStore;
}

/** The default page size, unchanged from before paging existed. */
const DEFAULT_HISTORY_LIMIT = 200;

/** A degradation trend needs this much history before its slope means anything. */
const MIN_TREND_SPAN_DAYS = 7;

const historyArgs = {
  ...vinArg,
  ...delegatedAccountArg,
  domain: z.string().describe('Domain as kind/name, e.g. "telemetry/battery".'),
  hours: z.number().positive().optional().describe('Only records newer than this many hours.'),
  limit: z.number().int().positive().optional().describe(`Max records to return (default ${DEFAULT_HISTORY_LIMIT}).`),
  offset: z.number().int().min(0).optional().describe('Skip this many records after the time filter, for paging older records.'),
  before: z.string().optional().describe('Only records whose displayed time is before this ISO 8601 timestamp (exclusive), for paging.'),
};

const sinceArgs = {
  ...vinArg,
  ...delegatedAccountArg,
  days: z.number().positive().optional().describe('Only consider the last N days.'),
};

type Payload = Record<string, unknown>;

const recordOf = (value: unknown): Payload | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : undefined;

const pick = (data: Payload, keys: readonly string[]): Payload => {
  const out: Payload = {};
  for (const key of keys) if (data[key] !== undefined) out[key] = data[key];
  return out;
};

const keysEndingWith = (data: Payload, suffix: RegExp): Payload => {
  const out: Payload = {};
  for (const [key, value] of Object.entries(data)) if (suffix.test(key)) out[key] = value;
  return out;
};

/**
 * Per-Domain renderers for recorded payloads. Each one keeps the upstream field
 * names and the fields an agent reasons about, so a history answer states the
 * same values the live tool would. A Domain without a renderer falls back to
 * every key in the payload, which is honest rather than empty.
 */
const RENDERERS: Record<string, (data: Payload) => Payload> = {
  battery: (data) => ({
    ...pick(data, [
      'batteryChargeLevelPercentage',
      'estimatedDistanceToEmptyKm',
      'chargingStatusV2',
      'chargingStatus',
      'chargerConnectionStatus',
      'chargerPowerStatus',
      'chargingType',
      'chargingPowerWatts',
      'chargingVoltageVolts',
      'chargingCurrentAmps',
      'estimatedChargingTimeToFullMinutes',
      'averageEnergyConsumptionKwhPer100Km',
      'dischargeInfo',
    ]),
  }),
  odometer: (data) =>
    pick(data, ['odometerMeters', 'tripMeterManualKm', 'tripMeterAutomaticKm', 'averageSpeedKmPerHour', 'averageSpeedKmPerHourAutomatic']),
  location: (data) => ({
    ...pick(data, ['coordinate', 'heading', 'altitude', 'speed']),
  }),
  exterior: (data) => keysEndingWith(data, /^(OPEN_STATUS|LOCK_STATUS|ALARM_STATUS)_/),
  health: (data) => ({
    ...pick(data, ['daysToService', 'distanceToServiceKm', 'engineHoursToService']),
    ...keysEndingWith(data, /Warning$/),
  }),
  availability: (data) => pick(data, ['availabilityStatus', 'usageMode']),
  'parking-climatization': (data) => ({
    ...pick(data, [
      'runningStatus',
      'runtimeLeftMinutes',
      'ventilation',
      'requestedFrontLeftSeat',
      'requestedFrontRightSeat',
      'requestedRearLeftSeat',
      'requestedRearRightSeat',
      'requestedSteeringWheelHeating',
    ]),
  }),
  'pre-cleaning': (data) => ({
    ...pick(data, [
      'runningStatus',
      'runtimeLeftMinutes',
      'measuredParticulateMatter25',
      'measuredAirQualityIndex',
      'lastCycleValid',
      'lastCycleCompleted',
      'measurementDate',
    ]),
  }),
  'amp-limit': (data) => {
    const applied = ampLimitA(data);
    const pending = pendingAmpLimitA(data);
    const nested = recordOf(data.ampLimit);
    return {
      ...(applied !== undefined ? { ampLimit: applied } : { ampLimit: data.ampLimit }),
      ...(pending !== undefined ? { pendingAmpLimit: pending } : {}),
      ...(typeof nested?.source === 'string' ? { source: nested.source } : {}),
      ...(nested?.updatedAtTimestamp !== undefined ? { updatedAtTimestamp: nested.updatedAtTimestamp } : {}),
    };
  },
  'target-soc': (data) => {
    const target = targetSoc(data);
    return {
      ...(target.levelPct !== undefined ? { batteryChargeTargetLevel: target.levelPct } : {}),
      ...(target.settingType !== undefined ? { chargeTargetLevelSettingType: target.settingType } : {}),
    };
  },
  'global-charge-timer': (data) => pick(data, ['globalChargeTimer', 'pendingGlobalChargeTimer']),
  'parking-climate-timer': (data) => pick(data, ['parkingClimateTimers']),
  'charge-now': (data) => pick(data, ['syncedOverrideChargeTimer']),
  'charge-locations': (data) => pick(data, ['id', 'utc0', 'chargeLocations']),
};

/** Render one recorded payload for display, with an all-keys fallback for a new Domain. */
export function renderHistorySample(kind: string, name: string, data: Payload): Payload {
  const renderer = RENDERERS[`${kind}/${name}`] ?? RENDERERS[name];
  return renderer !== undefined ? renderer(data) : { ...data };
}

/**
 * One line per record: the value's own clock when the recorder stored one,
 * otherwise the read clock the store has always held. Records written before
 * the value clock existed stay readable; the tool description says which clock
 * an unlabelled date is.
 */
function recordsToText(records: HistoryRecord[], kind: string, name: string): string {
  if (records.length === 0) return 'No history records matched.';
  return records
    .map((record) => `${new Date(recordTimeMs(record)).toISOString()} ${JSON.stringify(renderHistorySample(kind, name, recordOf(record.data) ?? {}))}`)
    .join('\n');
}

/**
 * History tools over the opt-in local JSONL store. These answer the
 * longitudinal questions the stateless API cannot: how has the battery aged,
 * what did charging sessions look like, how has consumption moved. Only
 * registered when POLESTAR_HISTORY_DIR is set.
 */
export function historyToolSpecs(deps: HistoryDeps): ToolSpec[] {
  return [
  {
    name: 'get_history',
    title: 'Query recorded history',
    description:
        'Recorded samples for one domain from the local history store (requires history to be enabled on the server). Returns one line per change, newest first, with the domain\'s own fields. Each line is dated by the value\'s clock when the recorder stored one; records written before that clock existed are dated by the server read clock. Paging uses offset or before, and a truncated answer says more records are available.',
    args: historyArgs,
    annotations: { readOnlyHint: true },
    run: async (args: HistoryArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-history');
        if (!found.ok) return found.result;
        const vin = found.vehicle.vin;
        // The registry decides what a domain is, here as everywhere else. This
        // used to re-spell the route with its own regex and then hand whatever it
        // matched to the store, so a typo read as "no history records matched"
        // instead of as a name no Domain has.
        const asked = args?.domain ?? '';
        const slash = asked.indexOf('/');
        const spec = slash < 0 ? undefined : findDomain(asked.slice(0, slash), asked.slice(slash + 1));
        if (spec === undefined) {
          throw new PolestarApiError(
            'UNKNOWN_DOMAIN',
            `"${asked}" is not a registered domain. This server records ${DOMAINS.length} domains, listed by kind/name.`,
            400,
          );
        }
        const sinceMs = args?.hours !== undefined ? (deps.nowMs?.() ?? Date.now()) - args.hours * 3_600_000 : undefined;
        const all = deps.store.query(vin, spec.kind, spec.name, { ...(sinceMs !== undefined ? { sinceMs } : {}) });
        let filtered = all;
        if (args?.before !== undefined) {
          const cutoff = Date.parse(args.before);
          if (!Number.isFinite(cutoff)) {
            throw new PolestarApiError(
              'INVALID_BEFORE',
              `before must be an ISO 8601 timestamp, e.g. 2026-09-18T11:00:00.000Z; got ${JSON.stringify(args.before)}.`,
              400,
            );
          }
          filtered = filtered.filter((record) => recordTimeMs(record) < cutoff);
        }
        const offset = args?.offset ?? 0;
        const limit = args?.limit ?? DEFAULT_HISTORY_LIMIT;
        const page = filtered.slice(offset, offset + limit);
        const more = filtered.length > offset + page.length;
        const body = recordsToText(page, spec.kind, spec.name);
        if (!more) return text(body);
        const oldestShown = page.length > 0 ? new Date(recordTimeMs(page[page.length - 1]!)).toISOString() : undefined;
        const hint = oldestShown !== undefined
          ? `More records are available: pass offset=${offset + page.length} or before=${oldestShown} to page older records.`
          : 'More records are available: pass offset=0 to page older records.';
        return text(`${body}\n${hint}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_degradation_report',
    title: 'Battery degradation estimate',
    description:
        'Trend of the battery\'s implied full-charge range and implied pack capacity over recorded history (range/SoC and dischargeInfo.energyAvailable/SoC). Estimates, not verdicts, range depends on conditions. Requires history and at least a week of it.',
    args: sinceArgs,
    annotations: { readOnlyHint: true },
    run: async (args: SinceArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-degradation');
        if (!found.ok) return found.result;
        const vin = found.vehicle.vin;
        const sinceMs = args?.days !== undefined ? (deps.nowMs?.() ?? Date.now()) - args.days * 86_400_000 : undefined;
        const samples = deps.store.batteryChronological(vin, sinceMs);
        if (samples.length < 5) {
          return text(`Only ${samples.length} battery sample(s) recorded, need at least 5. History accrues while the server runs with history enabled.`);
        }
        const points = degradationSeries(samples);
        if (points.length === 0) {
          return text(
            `None of the ${samples.length} recorded battery sample(s) reports a charge level together with a range or a usable-energy value, so there is no degradation signal yet. ` +
            'A trend needs range or dischargeInfo.energyAvailable beside the charge level; history accrues while the server runs with history enabled.',
          );
        }
        const firstPoint = points[0]!;
        const lastPoint = points[points.length - 1]!;
        const spanDays = (lastPoint.observedAt - firstPoint.observedAt) / 86_400_000;
        // A window the caller asked for can be narrower than a week on purpose,
        // but no trend is reported over less history than that window allows.
        const requiredDays = args?.days !== undefined ? Math.min(MIN_TREND_SPAN_DAYS, args.days) : MIN_TREND_SPAN_DAYS;
        if (spanDays < requiredDays) {
          return text(
            `The ${points.length} usable sample(s) span ${spanDays < 1 ? 'under a day' : `${spanDays.toFixed(1)} days`}; ` +
            `a trend needs at least ${requiredDays} days of history, so this is a series, not an estimate yet. ` +
            'History accrues while the server runs with history enabled.',
          );
        }
        const withRange = points.filter((p) => p.impliedFullRangeKm !== undefined);
        const first = withRange[0];
        const last = withRange[withRange.length - 1];
        const lines = [`${points.length} usable samples from ${new Date(firstPoint.observedAt).toISOString()} to ${new Date(lastPoint.observedAt).toISOString()} (${spanDays.toFixed(1)} days)`];
        if (first && last && withRange.length > 1) {
          lines.push(
            `Implied full-charge range: ${first.impliedFullRangeKm} km → ${last.impliedFullRangeKm} km`,
          );
        }
        const withCapacity = points.filter((p) => p.impliedCapacityKwh !== undefined);
        if (withCapacity.length > 1) {
          lines.push(
            `Implied capacity: ${withCapacity[0]!.impliedCapacityKwh} kWh → ${withCapacity[withCapacity.length - 1]!.impliedCapacityKwh} kWh`,
          );
        }
        // A stride-thinned sample of the whole series (max 20 points), oldest points
        // included, so the agent can see the shape rather than only the tail.
        const stride = Math.max(1, Math.ceil(points.length / 20));
        for (const point of points.filter((_, i) => i % stride === 0)) {
          lines.push(`  ${new Date(point.observedAt).toISOString()} SoC ${point.socPct}% → implied ${point.impliedFullRangeKm ?? '?'} km / ${point.impliedCapacityKwh ?? '?'} kWh`);
        }
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_charging_sessions',
    title: 'Charging sessions from history',
    description:
        'Reconstructed AC/DC charging sessions from recorded battery samples: start, the span between the first and last charging sample (gaps included, so it is not a duration), peak power when the car reported it, and max SoC reached. Requires history with battery sampling.',
    args: sinceArgs,
    annotations: { readOnlyHint: true },
    run: async (args: SinceArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-sessions');
        if (!found.ok) return found.result;
        const vin = found.vehicle.vin;
        const sinceMs = args?.days !== undefined ? (deps.nowMs?.() ?? Date.now()) - args.days * 86_400_000 : undefined;
        const samples = deps.store.batteryChronological(vin, sinceMs);
        const sessions = extractChargingSessions(samples);
        if (sessions.length === 0) return text('No charging sessions in the recorded history.');
        const lines = [`${sessions.length} session(s):`];
        for (const s of sessions) {
          const coverage = s.sampleCount === 1
            ? 'single sample, no span observed'
            : `span ${Math.round(s.activeSeconds / 60)} min over ${s.sampleCount} samples (gaps included)`;
          const peak = s.peakPowerWatts !== undefined
            ? `peak ${(s.peakPowerWatts / 1000).toFixed(1)} kW`
            : 'peak unknown, the car reported no charging power';
          lines.push(
            `• ${new Date(s.startedAt).toISOString()} to ${new Date(s.lastSeenAt).toISOString()} · ${coverage} · ${peak}${s.maxChargeLevelPct !== undefined ? ` · up to ${s.maxChargeLevelPct}%` : ''}`,
          );
        }
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },
  ];
}

export const historyToolNames = ['get_history', 'get_degradation_report', 'get_charging_sessions'];
