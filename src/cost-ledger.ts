/**
 * Charging energy and cost from recorded sessions.
 *
 * The API answers only "what is true now", so a cost figure has to be built from
 * three things this server owns: reconstructed sessions (`extractChargingSessions`),
 * a pack capacity the car or the caller can name (`chargeModel`), and a price
 * curve the caller supplies. Every simplification is listed in `assumptions`,
 * every missing input in `missing`, and no session is reported at cost zero when
 * the prices do not cover it.
 *
 * Nothing here persists the prices or the derived cost: the answer is computed
 * on read from the history file the operator already has.
 */
import { CAPACITY_MAX_KWH, CAPACITY_MIN_KWH, DEFAULT_AC_EFFICIENCY, chargeModel } from './charge-model.js';
import { batteryView } from './domain-data.js';
import {
  extractChargingSessions,
  median,
  recordTimeMs,
  type ChargingSession,
  type HistoryRecord,
} from './history.js';

export interface PriceSlot {
  /** ISO 8601 start of the price period. */
  startsAt: string;
  /** Currency per kWh, units pass through untouched. */
  price: number;
}

export interface SessionLedgerEntry {
  startedAt: number;
  lastSeenAt: number;
  spanSeconds: number;
  sampleCount: number;
  startSocPct?: number | undefined;
  endSocPct?: number | undefined;
  /** Battery-side energy the session added, kWh. */
  batteryEnergyKwh?: number | undefined;
  /** Wall-side energy at the stated efficiency, kWh. */
  gridEnergyKwh?: number | undefined;
  /** The other estimate when the session also reported power, for cross-checking. */
  powerEnergyKwh?: number | undefined;
  energySource?: 'soc-delta' | 'power-integration' | undefined;
  pricedEnergyKwh: number;
  unpricedEnergyKwh: number;
  /** Absent when no hour of the session had a price, which is not a zero cost. */
  cost?: number | undefined;
}

export interface CostLedger {
  capacityKwh?: number | undefined;
  capacitySource?: string | undefined;
  efficiency: number;
  sessions: SessionLedgerEntry[];
  totalBatteryEnergyKwh?: number | undefined;
  totalGridEnergyKwh?: number | undefined;
  totalCost?: number | undefined;
  pricedEnergyKwh: number;
  unpricedEnergyKwh: number;
  sessionsWithoutEnergy: number;
  sessionsWithoutPrice: number;
  assumptions: string[];
  missing: string[];
  problems: string[];
}

export interface CostLedgerInput {
  /** Battery-domain records, oldest first. */
  samples: HistoryRecord[];
  /** Caller-supplied hourly prices; an empty list means "energy only, no cost". */
  prices: PriceSlot[];
  /** Caller-supplied usable capacity, used when the records cannot imply one. */
  capacityKwh?: number | undefined;
  /** Wall-to-battery efficiency as a fraction, default 0.9. */
  efficiency?: number | undefined;
  /** Sessions to price; extracted from the samples when omitted. */
  sessions?: ChargingSession[] | undefined;
}

const HOUR_MS = 3_600_000;

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The price whose hour contains the instant, when the curve has one. */
export function priceAt(prices: readonly PriceSlot[], epochMs: number): number | undefined {
  for (const slot of prices) {
    const start = Date.parse(slot.startsAt);
    if (Number.isFinite(start) && start <= epochMs && epochMs < start + HOUR_MS) return slot.price;
  }
  return undefined;
}

export interface CapacityEstimate {
  capacityKwh?: number | undefined;
  source?: string | undefined;
  /** How many records implied a capacity, and their median. */
  impliedFrom: number;
  assumptions: string[];
  missing: string[];
}

/**
 * A capacity for the pack, from the caller first, then from the records by the
 * same chain the live charge model uses. The median of the per-record estimates
 * keeps one noisy low-SoC sample from setting the whole ledger.
 */
export function estimateCapacity(samples: HistoryRecord[], supplied?: number): CapacityEstimate {
  const assumptions: string[] = [];
  const missing: string[] = [];
  if (supplied !== undefined) {
    if (Number.isFinite(supplied) && supplied >= CAPACITY_MIN_KWH && supplied <= CAPACITY_MAX_KWH) {
      assumptions.push(`capacity ${supplied} kWh supplied by the caller`);
      return { capacityKwh: supplied, source: 'caller-supplied capacity', impliedFrom: 0, assumptions, missing };
    }
    missing.push(
      `caller-supplied capacity ${supplied} kWh is outside the ${CAPACITY_MIN_KWH} to ${CAPACITY_MAX_KWH} kWh plausibility range`,
    );
  }
  const estimates: { value: number; source: string }[] = [];
  for (const record of samples) {
    const view = batteryView(recordOf(record.data) ?? {});
    const model = chargeModel({
      socPct: view.chargeLevelPct,
      energyAvailableKwh: view.energyAvailableKwh,
      distanceToEmptyKm: view.distanceToEmptyKm,
      consumptionKwhPer100Km: view.consumptionKwhPer100Km,
      phases: 1,
    });
    if (model.capacityKwh !== undefined && model.capacitySource !== undefined) {
      estimates.push({ value: model.capacityKwh, source: model.capacitySource });
    }
  }
  const value = median(estimates.map((estimate) => estimate.value));
  if (value === undefined) {
    missing.push(
      'pack capacity: the car reports neither dischargeInfo.energyAvailable nor a range beside the average consumption, and no capacityKwh was supplied',
    );
    return { impliedFrom: 0, assumptions, missing };
  }
  const source = estimates.find((estimate) => estimate.value === value)?.source;
  assumptions.push(
    `capacity ${value.toFixed(1)} kWh is the median of ${estimates.length} record(s) using ${source ?? 'the car-reported values'}`,
  );
  const suppliedDifference = supplied !== undefined && Number.isFinite(supplied) ? Math.abs(supplied - value) / value : undefined;
  if (suppliedDifference !== undefined && suppliedDifference > 0.2) {
    assumptions.push(
      `the history implies ${value.toFixed(1)} kWh and the caller said ${supplied} kWh; the caller figure is used, a difference this size is worth checking`,
    );
    return {
      capacityKwh: supplied,
      source: 'caller-supplied capacity',
      impliedFrom: estimates.length,
      assumptions,
      missing,
    };
  }
  return { capacityKwh: value, source, impliedFrom: estimates.length, assumptions, missing };
}

/** Battery energy a session added, from the charge-level delta when it is usable. */
function energyFromSocDelta(session: ChargingSession, capacityKwh: number | undefined): number | undefined {
  if (capacityKwh === undefined) return undefined;
  const start = session.startChargeLevelPct;
  const end = session.endChargeLevelPct;
  if (start === undefined || end === undefined) return undefined;
  if (!(end > start)) return undefined;
  return (capacityKwh * (end - start)) / 100;
}

/** Battery energy from the trapezoid of reported power over the session samples. */
function energyFromPower(samples: HistoryRecord[], startedAt: number, lastSeenAt: number): number | undefined {
  const points: { at: number; watts: number }[] = [];
  for (const record of samples) {
    const at = recordTimeMs(record);
    if (at < startedAt || at > lastSeenAt) continue;
    const watts = batteryView(recordOf(record.data) ?? {}).powerWatts;
    if (watts === undefined) continue;
    points.push({ at, watts });
  }
  if (points.length < 2) return undefined;
  points.sort((a, b) => a.at - b.at);
  let energyKwh = 0;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    const hours = (current.at - previous.at) / HOUR_MS;
    if (hours <= 0) continue;
    energyKwh += ((previous.watts + current.watts) / 2 / 1000) * hours;
  }
  return energyKwh > 0 ? energyKwh : undefined;
}

export interface SessionPrice {
  cost?: number | undefined;
  pricedEnergyKwh: number;
  unpricedEnergyKwh: number;
}

/**
 * Split a session's grid energy across the hours its span covers and price each
 * part. With no prices the whole energy is unpriced, so the caller cannot read a
 * missing tariff as a free charge. The common charger power that the split
 * assumes is stated by the caller as an assumption.
 */
export function splitSessionCost(
  startedAt: number,
  lastSeenAt: number,
  gridEnergyKwh: number | undefined,
  prices: readonly PriceSlot[],
): SessionPrice {
  if (gridEnergyKwh === undefined || gridEnergyKwh <= 0) return { pricedEnergyKwh: 0, unpricedEnergyKwh: 0 };
  const spanMs = lastSeenAt - startedAt;
  if (spanMs <= 0 || prices.length === 0) return { pricedEnergyKwh: 0, unpricedEnergyKwh: gridEnergyKwh };
  let cost = 0;
  let pricedEnergyKwh = 0;
  let unpricedEnergyKwh = 0;
  const firstHour = Math.floor(startedAt / HOUR_MS) * HOUR_MS;
  for (let hour = firstHour; hour < lastSeenAt; hour += HOUR_MS) {
    const overlapMs = Math.min(lastSeenAt, hour + HOUR_MS) - Math.max(startedAt, hour);
    if (overlapMs <= 0) continue;
    const fraction = overlapMs / spanMs;
    const energy = gridEnergyKwh * fraction;
    const price = priceAt(prices, hour);
    if (price === undefined) {
      unpricedEnergyKwh += energy;
    } else {
      pricedEnergyKwh += energy;
      cost += energy * price;
    }
  }
  return { ...(pricedEnergyKwh > 0 ? { cost } : {}), pricedEnergyKwh, unpricedEnergyKwh };
}

/** Build the whole ledger: capacity, per-session energy, per-session cost and totals. */
export function buildCostLedger(input: CostLedgerInput): CostLedger {
  const assumptions: string[] = [];
  const missing: string[] = [];
  const problems: string[] = [];
  let efficiency = input.efficiency ?? DEFAULT_AC_EFFICIENCY;
  if (!(Number.isFinite(efficiency) && efficiency > 0 && efficiency <= 1)) {
    problems.push(`AC efficiency ${efficiency} is not a fraction above 0 and at most 1, so ${DEFAULT_AC_EFFICIENCY} is used`);
    efficiency = DEFAULT_AC_EFFICIENCY;
  }
  const capacity = estimateCapacity(input.samples, input.capacityKwh);
  assumptions.push(...capacity.assumptions);
  missing.push(...capacity.missing);
  assumptions.push(`grid energy is battery energy divided by ${(efficiency * 100).toFixed(0)}% AC efficiency`);
  assumptions.push('charging energy is spread over the session span in proportion to time, so a taper or a fixed-power plateau is not modelled');

  const sessions = input.sessions ?? extractChargingSessions(input.samples);
  const entries: SessionLedgerEntry[] = [];
  let sessionsWithoutEnergy = 0;
  let sessionsWithoutPrice = 0;
  let totalBattery = 0;
  let anyBattery = false;
  let totalGrid = 0;
  let anyGrid = false;
  let totalCost = 0;
  let anyPriced = false;
  let pricedEnergy = 0;
  let unpricedEnergy = 0;

  for (const session of sessions) {
    const socEnergy = energyFromSocDelta(session, capacity.capacityKwh);
    const powerEnergy = energyFromPower(input.samples, session.startedAt, session.lastSeenAt);
    const batteryEnergy = socEnergy ?? powerEnergy;
    const energySource = socEnergy !== undefined ? 'soc-delta' : powerEnergy !== undefined ? 'power-integration' : undefined;
    if (socEnergy !== undefined && powerEnergy !== undefined) {
      const relative = Math.abs(socEnergy - powerEnergy) / Math.max(socEnergy, powerEnergy);
      if (relative > 0.25) {
        assumptions.push(
          `session at ${new Date(session.startedAt).toISOString()}: the charge-level delta gives ${socEnergy.toFixed(1)} kWh and the reported power gives ${powerEnergy.toFixed(1)} kWh, a ${(relative * 100).toFixed(0)}% disagreement`,
        );
      }
    }
    const gridEnergy = batteryEnergy !== undefined ? batteryEnergy / efficiency : undefined;
    const priced = splitSessionCost(session.startedAt, session.lastSeenAt, gridEnergy, input.prices);
    if (gridEnergy === undefined) sessionsWithoutEnergy += 1;
    if (gridEnergy !== undefined && priced.pricedEnergyKwh === 0) sessionsWithoutPrice += 1;
    if (batteryEnergy !== undefined) {
      totalBattery += batteryEnergy;
      anyBattery = true;
    }
    if (gridEnergy !== undefined) {
      totalGrid += gridEnergy;
      anyGrid = true;
    }
    pricedEnergy += priced.pricedEnergyKwh;
    unpricedEnergy += priced.unpricedEnergyKwh;
    if (priced.cost !== undefined) {
      totalCost += priced.cost;
      anyPriced = true;
    }
    entries.push({
      startedAt: session.startedAt,
      lastSeenAt: session.lastSeenAt,
      spanSeconds: session.activeSeconds,
      sampleCount: session.sampleCount,
      ...(session.startChargeLevelPct !== undefined ? { startSocPct: session.startChargeLevelPct } : {}),
      ...(session.endChargeLevelPct !== undefined ? { endSocPct: session.endChargeLevelPct } : {}),
      ...(batteryEnergy !== undefined ? { batteryEnergyKwh: batteryEnergy } : {}),
      ...(gridEnergy !== undefined ? { gridEnergyKwh: gridEnergy } : {}),
      ...(powerEnergy !== undefined ? { powerEnergyKwh: powerEnergy } : {}),
      ...(energySource !== undefined ? { energySource } : {}),
      pricedEnergyKwh: priced.pricedEnergyKwh,
      unpricedEnergyKwh: priced.unpricedEnergyKwh,
      ...(priced.cost !== undefined ? { cost: priced.cost } : {}),
    });
  }

  if (entries.length === 0) missing.push('charging sessions: the battery records contain no run of charging samples');
  if (entries.length > 0 && sessionsWithoutEnergy === entries.length) {
    missing.push(
      'session energy: no session has both a charge-level delta with a known capacity and at least two samples that report charging power',
    );
  }
  if (input.prices.length === 0) {
    assumptions.push('no prices were supplied, so energy is reported without a cost');
  }
  if (unpricedEnergy > 0) {
    missing.push(`${unpricedEnergy.toFixed(1)} kWh of grid energy falls outside the supplied price curve and has no cost`);
  }

  return {
    ...(capacity.capacityKwh !== undefined ? { capacityKwh: capacity.capacityKwh } : {}),
    ...(capacity.source !== undefined ? { capacitySource: capacity.source } : {}),
    efficiency,
    sessions: entries,
    ...(anyBattery ? { totalBatteryEnergyKwh: totalBattery } : {}),
    ...(anyGrid ? { totalGridEnergyKwh: totalGrid } : {}),
    ...(anyPriced ? { totalCost } : {}),
    pricedEnergyKwh: pricedEnergy,
    unpricedEnergyKwh: unpricedEnergy,
    sessionsWithoutEnergy,
    sessionsWithoutPrice,
    assumptions,
    missing,
    problems,
  };
}
