import { fromKm, km, type Units } from './format.js';

/**
 * Trip reconstruction from recorded odometer readings.
 *
 * The car reports the odometer on a sampling cadence, not per trip, so a trip
 * here is a stretch of movement inferred from consecutive readings: distance is
 * the difference between readings, not a measurement of a journey. Two facts
 * make that honest: a gap longer than a day has a known odometer difference but
 * no known place in time, and a lower reading is a reset (a module change or a
 * repaired cluster), never negative distance. Both are reported as their own
 * records rather than folded into a number that looks continuous.
 *
 * Pure: sample arrays in, reconstruction out. The store read and the text
 * rendering sit at the edges.
 */

/** One odometer reading: when it was taken and what the car said. */
export interface OdometerSample {
  atMs: number;
  odometerMeters: number;
}

/** A stretch of movement inferred from consecutive readings. */
export interface Trip {
  startedAt: number;
  endedAt: number;
  distanceMeters: number;
  startOdometerMeters: number;
  endOdometerMeters: number;
  /** Readings that carried this trip, including the one before its first interval. */
  sampleCount: number;
}

/** An interval longer than the gap bound: the distance is known, its time is not. */
export interface OdometerGap {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** Odometer difference across the gap, already included in the total. */
  distanceMeters: number;
}

/** A reading lower than the one before it: a reset, not negative distance. */
export interface OdometerReset {
  atMs: number;
  fromMeters: number;
  toMeters: number;
}

export interface TripReconstruction {
  /** False when fewer readings than the minimum exist; the fields below are empty then. */
  sufficient: boolean;
  /** Why reconstruction was refused, one sentence fragment without a full stop. */
  reason?: string;
  sampleCount: number;
  distanceMeters: number;
  firstAt?: number;
  lastAt?: number;
  trips: Trip[];
  gaps: OdometerGap[];
  resets: OdometerReset[];
}

/** Why three readings rather than two: two give a difference and no way to bound it. */
export const MIN_TRIP_SAMPLES = 3;

/**
 * An interval longer than this is a gap. A day is generous for a 10 minute
 * sampler: a longer interval means the server was not running or the car was
 * unreachable, so placing any movement inside it would be a guess.
 */
export const TRIP_GAP_MS = 24 * 60 * 60 * 1000;

/**
 * Reconstruct movement from readings.
 *
 * A trip is a maximal run of consecutive readings where the odometer rose and no
 * interval crossed the gap bound. An unchanged reading closes the trip: the car
 * was parked (or reported the same value), so the next movement starts a new
 * one. A decrease is a reset event: it closes the trip, contributes no distance,
 * and the new reading becomes the baseline. The total is the sum of every
 * positive difference, including distance across a gap, because the odometer
 * did move even though the moment it moved is unknown.
 */
export function reconstructTrips(
  samples: readonly OdometerSample[],
  options: { gapMs?: number } = {},
): TripReconstruction {
  const gapMs = options.gapMs ?? TRIP_GAP_MS;
  const usable = samples
    .filter((sample) => Number.isFinite(sample.atMs) && Number.isFinite(sample.odometerMeters))
    .slice()
    .sort((a, b) => a.atMs - b.atMs);

  const empty: TripReconstruction = {
    sufficient: false,
    sampleCount: usable.length,
    distanceMeters: 0,
    trips: [],
    gaps: [],
    resets: [],
  };

  if (usable.length === 0) {
    return { ...empty, reason: 'no odometer samples are recorded for this window' };
  }
  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  if (usable.length < MIN_TRIP_SAMPLES) {
    return {
      ...empty,
      reason:
        `${usable.length === 1 ? 'only 1 odometer sample is' : 'only 2 odometer samples are'} recorded and at least ` +
        `${MIN_TRIP_SAMPLES} are needed to tell a trip from an unobserved interval`,
      firstAt: first.atMs,
      lastAt: last.atMs,
    };
  }

  const trips: Trip[] = [];
  const gaps: OdometerGap[] = [];
  const resets: OdometerReset[] = [];
  let distanceMeters = 0;
  let current: Trip | undefined;

  const closeTrip = (): void => {
    if (current !== undefined) trips.push(current);
    current = undefined;
  };

  for (let index = 1; index < usable.length; index += 1) {
    const previous = usable[index - 1]!;
    const reading = usable[index]!;
    const elapsedMs = reading.atMs - previous.atMs;
    const differenceMeters = reading.odometerMeters - previous.odometerMeters;

    if (differenceMeters < 0) {
      closeTrip();
      resets.push({ atMs: reading.atMs, fromMeters: previous.odometerMeters, toMeters: reading.odometerMeters });
      continue;
    }
    if (elapsedMs > gapMs) {
      closeTrip();
      gaps.push({
        startedAt: previous.atMs,
        endedAt: reading.atMs,
        durationMs: elapsedMs,
        distanceMeters: differenceMeters,
      });
      distanceMeters += differenceMeters;
      continue;
    }
    if (differenceMeters === 0) {
      // The car did not move between these readings, so this interval is not
      // part of any trip and a later movement starts a new one.
      closeTrip();
      continue;
    }
    distanceMeters += differenceMeters;
    if (current === undefined) {
      current = {
        startedAt: previous.atMs,
        endedAt: reading.atMs,
        distanceMeters: differenceMeters,
        startOdometerMeters: previous.odometerMeters,
        endOdometerMeters: reading.odometerMeters,
        sampleCount: 2,
      };
    } else {
      current.endedAt = reading.atMs;
      current.distanceMeters += differenceMeters;
      current.endOdometerMeters = reading.odometerMeters;
      current.sampleCount += 1;
    }
  }
  closeTrip();

  return {
    sufficient: true,
    sampleCount: usable.length,
    distanceMeters,
    firstAt: first.atMs,
    lastAt: last.atMs,
    trips,
    gaps,
    resets,
  };
}

/**
 * Render a reconstruction for an agent, in the operator's unit. The words say
 * what the numbers are: distance is between readings, a gap is unobserved time,
 * a reset is a discontinuity rather than ignored data.
 */
export function renderTrips(result: TripReconstruction, units: Units): string[] {
  if (!result.sufficient) {
    return [`Trips: ${result.reason ?? 'not enough odometer history to reconstruct trips'}.`];
  }
  const lines: string[] = [];
  const first = result.firstAt !== undefined ? new Date(result.firstAt).toISOString() : 'unknown';
  const last = result.lastAt !== undefined ? new Date(result.lastAt).toISOString() : 'unknown';
  lines.push(
    `Distance: ${fromKm(result.distanceMeters / 1000, units)} over ${result.sampleCount} odometer sample(s) from ${first} to ${last}.`,
  );
  if (result.distanceMeters === 0) {
    lines.push('The odometer did not move in any recorded interval: the car was parked, or the readings repeated.');
  }
  if (result.trips.length > 0) {
    lines.push(`${result.trips.length} movement span(s) reconstructed from consecutive readings:`);
    for (const trip of result.trips) {
      lines.push(
        `  ${new Date(trip.startedAt).toISOString()} to ${new Date(trip.endedAt).toISOString()}: ` +
          `${fromKm(trip.distanceMeters / 1000, units)} (odometer ${km(trip.startOdometerMeters, units)} to ${km(trip.endOdometerMeters, units)}, ${trip.sampleCount} samples)`,
      );
    }
  }
  if (result.gaps.length > 0) {
    lines.push(`${result.gaps.length} unobserved gap(s) longer than ${Math.round(TRIP_GAP_MS / 3_600_000)} h:`);
    for (const gap of result.gaps) {
      lines.push(
        `  ${new Date(gap.startedAt).toISOString()} to ${new Date(gap.endedAt).toISOString()}: ` +
          `${fromKm(gap.distanceMeters / 1000, units)} included in the total but not placed in time.`,
      );
    }
  }
  if (result.resets.length > 0) {
    lines.push(`${result.resets.length} odometer reset(s); the interval contributes no distance:`);
    for (const reset of result.resets) {
      lines.push(
        `  ${new Date(reset.atMs).toISOString()}: ${reset.fromMeters} m to ${reset.toMeters} m (a repaired cluster or a module change, not negative distance).`,
      );
    }
  }
  return lines;
}
