import { z } from 'zod';
import { odometerMeters } from './domain-data.js';
import { recordTimeMs, type HistoryRecord } from './history.js';
import type { HistoryDeps } from './history-tools.js';
import { delegatedAccountArg, errorResult, vinArg, withData, type VinArgs } from './tool-output.js';
import { vehicleFor } from './vehicle-read.js';
import type { ToolSpec } from './tools.js';
import { renderTrips, reconstructTrips } from './trips.js';
import {
  buildTimeline,
  renderTimeline,
  TIMELINE_LOCATION_LABEL,
  TIMELINE_SOURCES,
  type TimelineSourceRecords,
} from './timeline.js';
import { DIGEST_WINDOW_DAYS, weeklyDigest, type BackgroundSampling } from './digest.js';

/**
 * The wave 2 history tools: trips, timeline and weekly digest.
 *
 * They are a separate module from `history-tools.ts` because they are a
 * different kind of answer: those three read one Domain's series, these compose
 * several into a derived view. Every one reads only the local store; the client
 * is used for the same VIN resolution every other car tool uses, and no Domain
 * is fetched here.
 *
 * Registered by spreading this array beside `historyToolSpecs()` when a history
 * store exists. Keeping them out of that module means the Lead wiring them in
 * needs no edit inside another owner's file.
 */
export interface ExtraHistoryDeps extends HistoryDeps {
  /** Required: the operator's position opt-out must arrive explicitly. */
  allowLocation: boolean;
  /** What this process knows about background sampling; 'unknown' keeps the wording conservative. */
  backgroundSampling?: BackgroundSampling | undefined;
}

type TripArgs = VinArgs & { days?: number };
type TimelineArgs = VinArgs & { hours?: number; limit?: number };
type DigestArgs = VinArgs;

const tripArgs = {
  ...vinArg,
  ...delegatedAccountArg,
  days: z.number().positive().optional().describe('Look-back window in days (default 7).'),
};

const timelineArgs = {
  ...vinArg,
  ...delegatedAccountArg,
  hours: z.number().positive().optional().describe('Look-back window in hours (default 24).'),
  limit: z.number().int().positive().optional().describe('Max events to return, newest first (default 200).'),
};

const digestArgs = {
  ...vinArg,
  ...delegatedAccountArg,
};

const nowMs = (deps: ExtraHistoryDeps): number => deps.nowMs?.() ?? Date.now();

/**
 * Read every timeline source in the window. Location is not read at all when the
 * operator opted out, rather than read and hidden: the opt-out is a promise about
 * what leaves the request layer, not about what the answer prints.
 */
function readTimelineSources(
  deps: ExtraHistoryDeps,
  vin: string,
  sinceMs: number,
  untilMs: number,
): TimelineSourceRecords[] {
  const out: TimelineSourceRecords[] = [];
  for (const source of TIMELINE_SOURCES) {
    if (!deps.allowLocation && source.label === TIMELINE_LOCATION_LABEL) continue;
    const records = deps.store.query(vin, source.kind, source.name, { sinceMs, untilMs, newestFirst: false });
    const anyRecords =
      records.length > 0 ? true : deps.store.query(vin, source.kind, source.name, { limit: 1 }).length > 0;
    out.push({ source, records, anyRecords });
  }
  return out;
}

/** A recorded payload as a record; the store's data is unknown by type. */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The read guard's error is a refusal, not a crash: every tool body catches. */
function odometerSamples(records: readonly HistoryRecord[]): { atMs: number; odometerMeters: number }[] {
  const samples: { atMs: number; odometerMeters: number }[] = [];
  for (const record of records) {
    const meters = odometerMeters(asRecord(record.data));
    if (meters === undefined) continue;
    samples.push({ atMs: recordTimeMs(record), odometerMeters: meters });
  }
  return samples;
}

const emptyHistorySentence =
  'History records only what a tool read while the server was running with POLESTAR_HISTORY_DIR set; background sampling is off unless POLESTAR_SAMPLE=on.';

/**
 * The names in registration order. Exported beside the specs so the smoke
 * expectation and the docs gate can name the same list the registry uses
 * instead of a hand-written copy that drifts.
 */
export const extraHistoryToolNames = ['get_trips', 'get_timeline', 'get_weekly_digest'];

/**
 * The extra history tools, as values. `extraHistoryToolSpecs({ ...deps, store, allowLocation })`
 * is the one call the server needs beside `historyToolSpecs()`.
 */
export function extraHistoryToolSpecs(deps: ExtraHistoryDeps): ToolSpec[] {
  return [
    {
      name: 'get_trips',
      title: 'Trips from odometer history',
      description:
        'Distance and movement spans reconstructed from recorded odometer readings (requires history with odometer sampling). A span is inferred between consecutive recordings, not a trip computer: a gap longer than 24 h is named instead of interpolated, an odometer reset contributes no distance, and fewer than 3 readings says so instead of reporting 0 km. Structured data: distanceMeters, trips, gaps, resets.',
      args: tripArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (args: TripArgs, ctx) => {
        try {
          const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-trips');
          if (!found.ok) return found.result;
          const now = nowMs(deps);
          const days = args?.days ?? 7;
          const sinceMs = now - days * 86_400_000;
          const records = deps.store.query(found.vehicle.vin, 'telemetry', 'odometer', { sinceMs, newestFirst: false });
          const trips = reconstructTrips(odometerSamples(records));
          const lines = renderTrips(trips, deps.units);
          if (!trips.sufficient) lines.push(emptyHistorySentence);
          return withData(lines.join('\n'), {
            windowDays: days,
            sampleCount: trips.sampleCount,
            distanceMeters: trips.distanceMeters,
            ...(trips.firstAt !== undefined ? { firstAtMs: trips.firstAt } : {}),
            ...(trips.lastAt !== undefined ? { lastAtMs: trips.lastAt } : {}),
            trips: trips.trips,
            gaps: trips.gaps,
            resets: trips.resets,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    },

    {
      name: 'get_timeline',
      title: 'Cross-domain timeline',
      description:
        'Recorded changes across battery, odometer, location, health and the charging settings, in a look-back window (requires history). One row per changed value, newest first, each with a relative age; identical repeated snapshots are not listed, so every row is a change and not a reading. Location is excluded when POLESTAR_ALLOW_LOCATION=false. Empty history says nothing was observed rather than that nothing happened. Structured data: events, absent, excluded, readClockRecords.',
      args: timelineArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (args: TimelineArgs, ctx) => {
        try {
          const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-timeline');
          if (!found.ok) return found.result;
          const now = nowMs(deps);
          const hours = args?.hours ?? 24;
          const limit = args?.limit ?? 200;
          const sinceMs = now - hours * 3_600_000;
          const sources = readTimelineSources(deps, found.vehicle.vin, sinceMs, now);
          const timeline = buildTimeline(sources, {
            sinceMs,
            untilMs: now,
            nowMs: now,
            units: deps.units,
            allowLocation: deps.allowLocation,
          });
          const totalEvents = timeline.events.length;
          const shown = timeline.events.slice(0, limit);
          const truncated = totalEvents > shown.length;
          const lines = renderTimeline({ ...timeline, events: shown });
          if (truncated) {
            lines.push(
              `Showing the newest ${shown.length} of ${totalEvents} event(s); narrow the window with hours= or pass a larger limit=.`,
            );
          }
          return withData(lines.join('\n'), {
            windowHours: hours,
            events: shown,
            eventCount: totalEvents,
            truncated,
            recordCount: timeline.recordCount,
            readClockRecords: timeline.readClockRecords,
            absent: timeline.absent,
            excluded: timeline.excluded,
            notes: timeline.notes,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    },

    {
      name: 'get_weekly_digest',
      title: 'Weekly history digest',
      description:
        'What changed in the last 7 days from recorded history: distance from odometer spans, the battery series endpoints, charging sessions (no cost claim, prices are not stored), warnings observed in health samples, and charging-settings changes. Every item states its window and sample count. An empty store answers that nothing was observed rather than that nothing changed; a sparse store is named sparse. Structured data: window, distanceMeters, trips, battery, charging, warnings, settings, empty, sparse.',
      args: digestArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (args: DigestArgs, ctx) => {
        try {
          const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-digest');
          if (!found.ok) return found.result;
          const now = nowMs(deps);
          const sinceMs = now - DIGEST_WINDOW_DAYS * 86_400_000;
          const sources = readTimelineSources(deps, found.vehicle.vin, sinceMs, now);
          const digest = weeklyDigest({
            nowMs: now,
            units: deps.units,
            allowLocation: deps.allowLocation,
            sources,
            ...(deps.backgroundSampling !== undefined ? { backgroundSampling: deps.backgroundSampling } : {}),
          });
          return withData(digest.lines.join('\n'), { ...digest.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    },
  ];
}
