import { z } from 'zod';
import {
  degradationSeries,
  extractChargingSessions,
  HistoryStore,
  type HistoryRecord,
} from './history.js';
import { errorResult, text, vinArg, type ToolDeps, type VinArgs } from './tool-output.js';
import type { ToolSpec } from './tools.js';

/** get_history names the Domain to read, as `kind/name`. */
type HistoryArgs = VinArgs & { domain?: string; hours?: number; limit?: number };
/** The trend tools take a look-back instead. */
type SinceArgs = VinArgs & { days?: number };

export interface HistoryDeps extends ToolDeps {
  store: HistoryStore;
}

const historyArgs = {
  ...vinArg,
  domain: z.string().describe('Domain as kind/name, e.g. "telemetry/battery".'),
  hours: z.number().positive().optional().describe('Only records newer than this many hours.'),
  limit: z.number().int().positive().optional().describe('Max records to return (default 200).'),
};

const sinceArgs = {
  ...vinArg,
  days: z.number().positive().optional().describe('Only consider the last N days.'),
};

function recordsToText(records: HistoryRecord[], summarize: (data: Record<string, unknown>) => string): string {
  if (records.length === 0) return 'No history records matched.';
  return records.map((r) => `${new Date(r.observedAt).toISOString()} ${summarize((r.data ?? {}) as Record<string, unknown>)}`).join('\n');
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
        'Raw recorded samples for one domain from the local history store (requires history to be enabled on the server). Returns one line per change, newest first.',
    args: historyArgs,
    annotations: { readOnlyHint: true },
    run: async (args: HistoryArgs) => {
      try {
        const vin = await deps.client.resolveVin(args?.vin);
        const parsed = /(\w+)\/([\w-]+)/.exec(args?.domain ?? '');
        const kind = (parsed?.[1] ?? 'telemetry') as 'telemetry' | 'charging';
        const name = parsed?.[2] ?? args?.domain;
        if (!name) return text('Pass a domain like "telemetry/battery".');
        const sinceMs = args?.hours !== undefined ? Date.now() - args.hours * 3_600_000 : undefined;
        const records = deps.store.query(vin, kind, name, { ...(sinceMs !== undefined ? { sinceMs } : {}), limit: args?.limit ?? 200 });
        return text(
          recordsToText(records, (data) => {
            const interesting = ['batteryChargeLevelPercentage', 'estimatedDistanceToEmptyKm', 'odometerMeters', 'chargingPowerWatts', 'measuredParticulateMatter25'];
            return JSON.stringify(Object.fromEntries(Object.entries(data).filter(([k]) => interesting.includes(k))));
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_degradation_report',
    title: 'Battery degradation estimate',
    description:
        'Trend of the battery\'s implied full-charge range and implied pack capacity over recorded history (range/SoC and dischargeInfo.energyAvailable/SoC). Estimates, not verdicts, range depends on conditions. Requires history.',
    args: sinceArgs,
    annotations: { readOnlyHint: true },
    run: async (args: SinceArgs) => {
      try {
        const vin = await deps.client.resolveVin(args?.vin);
        const sinceMs = args?.days !== undefined ? Date.now() - args.days * 86_400_000 : undefined;
        const samples = deps.store.batteryChronological(vin, sinceMs);
        if (samples.length < 5) {
          return text(`Only ${samples.length} battery sample(s) recorded, need at least 5. History accrues while the server runs with history enabled.`);
        }
        const points = degradationSeries(samples);
        const withRange = points.filter((p) => p.impliedFullRangeKm !== undefined);
        const first = withRange[0];
        const last = withRange[withRange.length - 1];
        const lines = [`${points.length} usable samples from ${new Date(points[0]!.observedAt).toISOString()} to ${new Date(points[points.length - 1]!.observedAt).toISOString()}`];
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
        'Reconstructed AC/DC charging sessions from recorded battery samples: start, duration, peak power, max SoC reached. Requires history with battery sampling.',
    args: sinceArgs,
    annotations: { readOnlyHint: true },
    run: async (args: SinceArgs) => {
      try {
        const vin = await deps.client.resolveVin(args?.vin);
        const sinceMs = args?.days !== undefined ? Date.now() - args.days * 86_400_000 : undefined;
        const samples = deps.store.batteryChronological(vin, sinceMs);
        const sessions = extractChargingSessions(samples);
        if (sessions.length === 0) return text('No charging sessions in the recorded history.');
        const lines = [`${sessions.length} session(s):`];
        for (const s of sessions) {
          lines.push(
            `• ${new Date(s.startedAt).toISOString()}, ${new Date(s.lastSeenAt).toISOString()} · ${Math.round(s.activeSeconds / 60)} min · peak ${(s.peakPowerWatts / 1000).toFixed(1)} kW${s.maxChargeLevelPct !== undefined ? ` · up to ${s.maxChargeLevelPct}%` : ''} (${s.sampleCount} samples)`,
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
