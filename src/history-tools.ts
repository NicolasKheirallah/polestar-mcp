import { z } from 'zod';
import {
  degradationSeries,
  extractChargingSessions,
  HistoryStore,
  linearTrend,
  odometerRate,
  recordTimeMs,
  type HistoryRecord,
} from './history.js';
import { buildCostLedger, type PriceSlot } from './cost-ledger.js';
import { PolestarApiError } from './client.js';
import { DOMAINS, findDomain } from './domains.js';
import { ampLimitA, healthView, numberField, pendingAmpLimitA, targetSoc } from './domain-data.js';
import { activeWarnings } from './format.js';
import { delegatedAccountArg, errorResult, text, vinArg, type ToolDeps, type VinArgs } from './tool-output.js';
import { vehicleFor } from './vehicle-read.js';
import type { ToolSpec } from './tools.js';

/** get_history names the Domain to read, as `kind/name`. */
type HistoryArgs = VinArgs & { domain?: string; hours?: number; limit?: number; offset?: number; before?: string };
/** The trend tools take a look-back instead. */
type SinceArgs = VinArgs & { days?: number };
/** The cost tool adds caller prices and the capacity and efficiency they rest on. */
type CostArgs = SinceArgs & { prices?: PriceSlot[]; capacityKwh?: number; efficiency?: number };

export interface HistoryDeps extends ToolDeps {
  store: HistoryStore;
}

/** The default page size, unchanged from before paging existed. */
const DEFAULT_HISTORY_LIMIT = 200;

/** A degradation trend needs this much history before its slope means anything. */
const MIN_TREND_SPAN_DAYS = 7;

/** A slope with a 95 percent interval needs this much history, not just this many points. */
const MIN_INTERVAL_TREND_DAYS = 90;

/** The confounders a range or capacity trend cannot correct for with this API. */
const TREND_CONFOUNDERS =
  'Confounders: range depends on temperature, speed and wheel choice, none of which the API reports; an over-the-air range-model change is a step rather than degradation; and a single outlier moves a short series. The API reports no nominal capacity, so this is not a state-of-health percentage.';

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

const costArgs = {
  ...sinceArgs,
  prices: z
    .array(z.object({ startsAt: z.string(), price: z.number() }))
    .optional()
    .describe('Hourly prices: [{startsAt: "2026-09-19T22:00:00+02:00", price: 0.42}, ...]. Without them energy is reported and no cost is claimed.'),
  capacityKwh: z.number().positive().optional().describe('Usable pack capacity; derived from the recorded battery fields when the car reported enough to imply one.'),
  efficiency: z.number().gt(0).lte(1).optional().describe('Wall-to-battery AC efficiency as a fraction, default 0.9.'),
};

/** The history health and odometer tools need a look-back only. */
const serviceArgs = {
  ...vinArg,
  ...delegatedAccountArg,
  days: z.number().positive().optional().describe('Look-back for the odometer rate, default 90 days.'),
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

const oneDecimal = (value: number): string => (Math.round(value * 10) / 10).toFixed(1);

/**
 * One slope line with its 95 percent interval. The caller passes x in days, so
 * the monthly figure is the fitted daily slope times 30.44. The interval is the
 * honest part: when it contains zero the data does not establish a trend.
 */
function slopeLine(label: string, points: readonly { x: number; y: number }[], spanDays: number, unit: string): string[] | undefined {
  const trend = linearTrend(points);
  if (trend === undefined) return undefined;
  return [
    `${label}: ${oneDecimal(trend.slopePerMonth)} ${unit}/month (95% interval ${oneDecimal(trend.monthlyLow)} to ${oneDecimal(trend.monthlyHigh)}), ${trend.n} points over ${Math.round(spanDays)} days`,
    trend.excludesZero
      ? `The ${label.toLowerCase()} interval excludes zero, so the change is established within this data.`
      : `The ${label.toLowerCase()} interval includes zero, so this data does not establish a change.`,
  ];
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
        const seriesSpanDays = (lastPoint.observedAt - firstPoint.observedAt) / 86_400_000;
        const distinctSocs = new Set(points.map((point) => point.socPct)).size;
        const trendLines: string[] = [];
        if (seriesSpanDays < MIN_INTERVAL_TREND_DAYS) {
          trendLines.push(
            `A trend with an interval needs at least ${MIN_INTERVAL_TREND_DAYS} days of history; this series spans ${Math.round(seriesSpanDays)} days, so the first-to-last lines above are a series, not an estimate.`,
          );
        } else if (distinctSocs < 3) {
          trendLines.push(
            `A trend with an interval needs readings at 3 or more distinct charge levels; this series has ${distinctSocs}, so a slope would mostly restate the range estimate at one charge level.`,
          );
        } else {
          const rangePoints = withRange.map((point) => ({ x: (point.observedAt - firstPoint.observedAt) / 86_400_000, y: point.impliedFullRangeKm! }));
          if (rangePoints.length >= 8) {
            const rangeTrend = slopeLine('Implied full-charge range trend', rangePoints, seriesSpanDays, 'km');
            if (rangeTrend !== undefined) trendLines.push(...rangeTrend);
          } else {
            trendLines.push(`A range trend with an interval needs at least 8 usable range points; this series has ${rangePoints.length}.`);
          }
          const capacityPoints = withCapacity.map((point) => ({ x: (point.observedAt - firstPoint.observedAt) / 86_400_000, y: point.impliedCapacityKwh! }));
          if (capacityPoints.length >= 8) {
            const capacityTrend = slopeLine('Implied pack capacity trend', capacityPoints, seriesSpanDays, 'kWh');
            if (capacityTrend !== undefined) trendLines.push(...capacityTrend);
          }
        }
        if (trendLines.length > 0) {
          lines.push(...trendLines);
          lines.push(TREND_CONFOUNDERS);
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

  {
    name: 'get_charging_cost',
    title: 'Charging energy and cost from history',
    description:
        'Energy and cost of each recorded charging session, from the session SoC delta or reported power, a pack capacity the car or caller can name, and hourly prices the caller supplies. States the capacity source, the AC efficiency and every missing price; never reports zero cost for energy no price covers.',
    args: costArgs,
    annotations: { readOnlyHint: true },
    run: async (args: CostArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-cost');
        if (!found.ok) return found.result;
        const vin = found.vehicle.vin;
        const sinceMs = args?.days !== undefined ? (deps.nowMs?.() ?? Date.now()) - args.days * 86_400_000 : undefined;
        const samples = deps.store.batteryChronological(vin, sinceMs);
        if (samples.length === 0) {
          return text('No battery history recorded yet, so there is no charging session to cost. History accrues while the server runs with history enabled.');
        }
        const ledger = buildCostLedger({
          samples,
          prices: args?.prices ?? [],
          ...(args?.capacityKwh !== undefined ? { capacityKwh: args.capacityKwh } : {}),
          ...(args?.efficiency !== undefined ? { efficiency: args.efficiency } : {}),
        });
        if (ledger.sessions.length === 0) {
          return text(`No charging session in the ${samples.length} recorded battery sample(s). A session is a run of samples that report a charging status or non-zero charging power, with gaps under 30 minutes.`);
        }
        const lines: string[] = [`Charging cost from ${ledger.sessions.length} recorded session(s):`];
        for (const session of ledger.sessions) {
          const when = `${new Date(session.startedAt).toISOString()} to ${new Date(session.lastSeenAt).toISOString()}`;
          const span = `span ${Math.round(session.spanSeconds / 60)} min over ${session.sampleCount} sample(s)`;
          const soc = session.startSocPct !== undefined && session.endSocPct !== undefined ? ` · SoC ${session.startSocPct}% to ${session.endSocPct}%` : '';
          const energy = session.batteryEnergyKwh !== undefined
            ? ` · ${oneDecimal(session.batteryEnergyKwh)} kWh at the battery, ${oneDecimal(session.gridEnergyKwh!)} kWh from the grid (${session.energySource})`
            : ' · energy unknown (no charge-level delta or reported power)';
          const cost = session.cost !== undefined
            ? ` · cost ${session.cost.toFixed(3)} for ${oneDecimal(session.pricedEnergyKwh)} kWh`
            : session.unpricedEnergyKwh > 0
              ? ' · cost unknown: no supplied price covers this session'
              : '';
          lines.push(`• ${when} · ${span}${soc}${energy}${cost}`);
        }
        if (ledger.totalBatteryEnergyKwh !== undefined) {
          lines.push(`Total: ${oneDecimal(ledger.totalBatteryEnergyKwh)} kWh at the battery, ${oneDecimal(ledger.totalGridEnergyKwh!)} kWh from the grid.`);
        }
        if (ledger.totalCost !== undefined) {
          lines.push(
            ledger.unpricedEnergyKwh > 0
              ? `Cost ${ledger.totalCost.toFixed(3)} covers ${oneDecimal(ledger.pricedEnergyKwh)} kWh; ${oneDecimal(ledger.unpricedEnergyKwh)} kWh has no price and no cost is claimed for it.`
              : `Estimated cost: ${ledger.totalCost.toFixed(3)}.`,
          );
        } else if (ledger.sessionsWithoutPrice === ledger.sessions.length) {
          lines.push('No cost is claimed: no supplied price covers any session.');
        } else if (ledger.pricedEnergyKwh === 0) {
          lines.push('No cost is claimed because no session has a price covering its energy.');
        }
        if (ledger.sessionsWithoutEnergy > 0) {
          lines.push(`${ledger.sessionsWithoutEnergy} session(s) have no energy estimate and are counted in no total.`);
        }
        if (ledger.problems.length > 0) lines.push(`Problems: ${ledger.problems.join('; ')}.`);
        if (ledger.missing.length > 0) lines.push(`Missing: ${ledger.missing.join('; ')}.`);
        lines.push('', `Assumptions: ${ledger.assumptions.join('; ')}.`);
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_warning_changes',
    title: 'Warning changes from health history',
    description:
        'Warnings that appeared or cleared between recorded health samples. States that the periods between samples are unobserved, so a quiet answer means no change was seen, not that no warning occurred. Health is not sampled by default, so this needs health reads or POLESTAR_SAMPLE with a sampler that includes health.',
    args: sinceArgs,
    annotations: { readOnlyHint: true },
    run: async (args: SinceArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-warnings');
        if (!found.ok) return found.result;
        const vin = found.vehicle.vin;
        const sinceMs = args?.days !== undefined ? (deps.nowMs?.() ?? Date.now()) - args.days * 86_400_000 : undefined;
        const samples = deps.store.query(vin, 'telemetry', 'health', { ...(sinceMs !== undefined ? { sinceMs } : {}), newestFirst: false });
        const caveat = 'Warnings that appear and clear between two observations leave no record, so a quiet answer means not observed, not absent. Health is not one of the domains the background sampler reads by default; it is recorded when a health tool is called.';
        if (samples.length === 0) {
          return text(`No health history recorded, so warning changes cannot be reconstructed. ${caveat}`);
        }
        if (samples.length === 1) {
          return text(`Only one health sample is recorded, and a change needs two. ${caveat}`);
        }
        const lines: string[] = [`Warning changes across ${samples.length} health observations:`];
        let changes = 0;
        let previous = activeWarnings(recordOf(samples[0]!.data) ?? {});
        for (let i = 1; i < samples.length; i++) {
          const current = activeWarnings(recordOf(samples[i]!.data) ?? {});
          const appeared = current.filter((warning) => !previous.includes(warning));
          const cleared = previous.filter((warning) => !current.includes(warning));
          const when = new Date(recordTimeMs(samples[i]!)).toISOString();
          for (const warning of appeared) {
            lines.push(`• ${when} appeared: ${warning}`);
            changes += 1;
          }
          for (const warning of cleared) {
            lines.push(`• ${when} cleared: ${warning}`);
            changes += 1;
          }
          previous = current;
        }
        const firstAt = new Date(recordTimeMs(samples[0]!)).toISOString();
        const lastAt = new Date(recordTimeMs(samples[samples.length - 1]!)).toISOString();
        const summary = changes === 0
          ? `No warning appeared or cleared between ${samples.length} observations from ${firstAt} to ${lastAt}.`
          : `${changes} warning change(s) in ${samples.length} observations from ${firstAt} to ${lastAt}.`;
        lines.splice(1, 0, summary);
        lines.push('', caveat);
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_service_forecast',
    title: 'Service forecast from history',
    description:
        "When the next service falls due: the car's own days and distance countdown, plus an odometer rate from recorded history to say which limit arrives first. Names the limits of the forecast, including that the distance side assumes mileage-based intervals.",
    args: serviceArgs,
    annotations: { readOnlyHint: true },
    run: async (args: SinceArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-service');
        if (!found.ok) return found.result;
        const vin = found.vehicle.vin;
        const healthRecords = deps.store.query(vin, 'telemetry', 'health', { newestFirst: false });
        const latest = healthRecords[healthRecords.length - 1];
        if (latest === undefined) {
          return text('No health history recorded, so there is no service countdown to forecast from. Call get_health once with history enabled and the next forecast can use it.');
        }
        const seen = healthView(recordOf(latest.data) ?? {});
        const engineHours = numberField(recordOf(latest.data) ?? {}, 'engineHoursToService');
        const lines = [
          `Service countdown as recorded ${new Date(recordTimeMs(latest)).toISOString()}: ${seen.daysToService ?? 'n/a'} days or ${seen.distanceToServiceKm ?? 'n/a'} km` +
            `${engineHours !== undefined ? ` (engine hours: ${engineHours})` : ''}.`,
        ];
        const lookbackDays = args?.days ?? 90;
        const sinceMs = (deps.nowMs?.() ?? Date.now()) - lookbackDays * 86_400_000;
        const odometerRecords = deps.store.query(vin, 'telemetry', 'odometer', { sinceMs, newestFirst: false });
        const rate = odometerRate(odometerRecords);
        if (rate.kmPerDay !== undefined && rate.kmPerDay > 0 && seen.distanceToServiceKm !== undefined) {
          const distanceDays = seen.distanceToServiceKm / rate.kmPerDay;
          const daysUntil = seen.daysToService;
          lines.push(
            `Odometer rate: ${oneDecimal(rate.kmPerDay)} km/day from ${rate.samples} reading(s) over ${Math.round(rate.spanDays ?? 0)} day(s)` +
              `${rate.resets > 0 ? `, with ${rate.resets} backward step(s) treated as resets and discarded` : ''}.`,
          );
          lines.push(
            `At that rate ${seen.distanceToServiceKm} km lasts about ${Math.round(distanceDays)} days (${Math.round(distanceDays / 7)} weeks).`,
          );
          if (daysUntil !== undefined) {
            const earlier = distanceDays <= daysUntil ? 'distance' : 'days';
            lines.push(`The days countdown says ${daysUntil} days (${Math.round(daysUntil / 7)} weeks); the ${earlier} limit arrives first.`);
          }
        } else {
          lines.push(
            `Odometer history is too thin for a rate: ${rate.samples} reading(s)` +
              `${rate.spanDays !== undefined ? ` over ${Math.round(rate.spanDays)} day(s)` : ''}. The countdown above is the car's own estimate, not a forecast from this data.`,
          );
        }
        lines.push(
          'Limits: the countdown is maintained by the car and may be calendar-based or mileage-based, which the payload does not say; engineHoursToService is reported on a battery-electric car and its meaning is unverified; the rate is a recent average and a long trip distorts it.',
        );
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_settings_history',
    title: 'Charging settings history',
    description:
        'Recorded changes to the charging settings (amp limit, target state of charge, charge window, climate timers) dated by the value clock the payload reports, with pending changes that the car has not confirmed. Read-only: nothing here writes to the car.',
    args: sinceArgs,
    annotations: { readOnlyHint: true },
    run: async (args: SinceArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-settings');
        if (!found.ok) return found.result;
        const vin = found.vehicle.vin;
        const sinceMs = args?.days !== undefined ? (deps.nowMs?.() ?? Date.now()) - args.days * 86_400_000 : undefined;
        const domains = [
          ['amp-limit', 'amp limit'],
          ['target-soc', 'target charge level'],
          ['global-charge-timer', 'charge window'],
          ['parking-climate-timer', 'parking climate timers'],
        ] as const;
        const lines: string[] = ['Recorded charging settings changes:'];
        let any = false;
        let readClockDated = 0;
        for (const [name, label] of domains) {
          const records = deps.store.query(vin, 'charging', name, { ...(sinceMs !== undefined ? { sinceMs } : {}), newestFirst: false });
          if (records.length === 0) {
            lines.push(`• ${label}: no records.`);
            continue;
          }
          any = true;
          lines.push(`• ${label}: ${records.length} record(s)`);
          let previousJson: string | undefined;
          for (const record of records) {
            const data = recordOf(record.data) ?? {};
            const rendered = renderHistorySample('charging', name, data);
            const json = JSON.stringify(rendered);
            const when = new Date(recordTimeMs(record)).toISOString();
            if (previousJson === undefined) {
              lines.push(`  ${when} first recorded state: ${json}`);
            } else if (json !== previousJson) {
              lines.push(`  ${when} changed to: ${json}`);
            }
            if (record.valueObservedAt === undefined) readClockDated += 1;
            if (name === 'amp-limit') {
              const applied = ampLimitA(data);
              const pending = pendingAmpLimitA(data);
              if (pending !== undefined && pending !== applied) {
                lines.push(`  ${when} pending: change to ${pending} A is recorded but the car has not confirmed it (the car reports ${applied ?? 'no'} A)`);
              }
            }
            if (name === 'global-charge-timer') {
              const pendingBlock = recordOf(data.pendingGlobalChargeTimer);
              const pendingKeys = pendingBlock === undefined ? [] : Object.keys(pendingBlock).filter((key) => key !== 'metadata');
              if (pendingKeys.length > 0) {
                lines.push(`  ${when} pending: a charge-window edit is recorded (${pendingKeys.join(', ')}) but not confirmed; an empty pending block means nothing is queued`);
              }
            }
            previousJson = json;
          }
        }
        if (!any) {
          lines.push('No charging settings have been recorded yet. A settings change is recorded when a settings tool or the sampler reads one.');
        }
        if (readClockDated > 0) {
          lines.push('', `${readClockDated} record(s) predate the vehicle clock and are dated by the server read clock, not the car.`);
        }
        lines.push(
          '',
          'The M2M API can serve a setting weeks after it changed, so a record time is when the value was observed, not necessarily when the owner changed it; use the pending lines for a change the car has not confirmed. Between records a setting may have changed and changed back unseen.',
        );
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },
  ];
}

export const historyToolNames = [
  'get_history',
  'get_degradation_report',
  'get_charging_sessions',
  'get_charging_cost',
  'get_warning_changes',
  'get_service_forecast',
  'get_settings_history',
];
