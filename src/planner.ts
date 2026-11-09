import { DEFAULT_AC_EFFICIENCY } from './charge-model.js';

export interface PriceSlot {
  /** ISO 8601 start of a (typically hourly) price period. */
  startsAt: string;
  /** Currency per kWh, units pass through untouched. */
  price: number;
}

export interface ChargePlanInput {
  prices: PriceSlot[];
  /** Current state of charge, percent. */
  socPct: number;
  /** Target state of charge, percent. */
  targetPct: number;
  /** Usable pack capacity kWh, from the charge model's capacity chain. */
  capacityKwh: number;
  /** Charging power in kW at the configured amp limit. */
  powerKw: number;
  /** Charge window start hour, from the global charge timer. Values above 23 wrap. */
  windowStartHour: number;
  /** Charge window end hour; may be smaller than start (wraps midnight) or above 23. */
  windowEndHour: number;
  /** Fixed UTC offset of the window in minutes (from the timer's timeZone). */
  windowOffsetMinutes?: number;
  /** The caller's name for the price unit, carried into the answer. */
  priceUnit?: string;
  /** Wall-to-battery efficiency, a fraction above 0 and at most 1. Defaults to 0.9. */
  efficiency?: number;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export interface ChargePlanStep {
  startsAt: string;
  endsAt: string;
  /** The hourly price that applies to this step, in the caller's unit. */
  price: number;
  /** Battery-side energy delivered in this hour. */
  energyKwh: number;
  /** Grid-side energy for that battery energy, at the stated efficiency. */
  gridEnergyKwh: number;
  /** price × gridEnergyKwh, in the caller's price unit. */
  cost: number;
}

export interface ChargePlan {
  feasible: boolean;
  reason?: string;
  energyNeededKwh: number;
  /** Grid-side energy needed, when capacity makes it computable. */
  gridEnergyNeededKwh?: number;
  hoursNeeded: number;
  /** Ordered plan, priced in full; empty when not feasible. */
  steps: ChargePlanStep[];
  /** Sum of the step costs. Zero and negative totals are real answers, so they are kept. */
  totalCost?: number;
  totalGridEnergyKwh?: number;
  /** The unit the caller supplied prices in, named back to them. */
  priceUnit: string;
  assumptions: string[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DEFAULT_PRICE_UNIT = "the caller's currency per kWh";

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** A timer hour as a clock hour: 28 is 04:00, and a negative hour wraps too. */
const normalizeHour = (hour: number): number => ((Math.floor(hour) % 24) + 24) % 24;

const localHourOf = (utcMs: number, offsetMs: number): number =>
  Math.floor((((utcMs + offsetMs) % DAY_MS) + DAY_MS) % DAY_MS / HOUR_MS) % 24;

/**
 * Picks the cheapest hours inside the car's charge window that still deliver
 * the energy needed to reach the target SoC. Pure arithmetic over data the
 * server already serves (target-soc, amp-limit, battery, global-charge-timer)
 * plus a price curve the caller supplies, no writes, no external calls.
 *
 * The plan is feasible only when it can deliver the whole energy need. The old
 * version kept `feasible: true` while scheduling a fraction of it, because it
 * divided the need by the hours wanted and never recomputed anything when the
 * window was too short for them.
 *
 * "Contiguous" means adjacent on the clock, not adjacent in the filtered slot
 * list: four hours a night, listed as eight consecutive slots, are not one
 * block. When no adjacent block fits, the cheapest individual hours are chosen
 * and the plan says they are not contiguous.
 */
export function planCheapestCharge(input: ChargePlanInput): ChargePlan {
  const priceUnit = input.priceUnit ?? DEFAULT_PRICE_UNIT;
  const efficiency = input.efficiency ?? DEFAULT_AC_EFFICIENCY;
  const assumptions: string[] = [];

  const invalid = (reason: string, energyNeededKwh = 0): ChargePlan => ({
    feasible: false,
    reason,
    energyNeededKwh: round(energyNeededKwh, 3),
    hoursNeeded: 0,
    steps: [],
    priceUnit,
    assumptions,
  });

  if (!Number.isFinite(input.socPct) || input.socPct < 0 || input.socPct > 100) {
    return invalid(`Current state of charge ${input.socPct}% is outside 0 to 100, so no plan can be trusted.`);
  }
  if (!Number.isFinite(input.targetPct) || input.targetPct < 0 || input.targetPct > 100) {
    return invalid(`Target charge level ${input.targetPct}% is outside 0 to 100, so no plan can be trusted.`);
  }
  if (!Number.isFinite(input.capacityKwh) || input.capacityKwh <= 0) {
    return invalid(`Pack capacity must be a positive number of kWh, got ${input.capacityKwh}; pass capacityKwh when the car does not report a usable capacity.`);
  }
  if (!Number.isFinite(input.powerKw) || input.powerKw <= 0) {
    return invalid(`Charging power must be a positive number of kW, got ${input.powerKw}; the car reports no usable live power or amp limit.`);
  }
  if (!(Number.isFinite(efficiency) && efficiency > 0 && efficiency <= 1)) {
    return invalid(`AC efficiency must be a fraction above 0 and at most 1, got ${efficiency}.`);
  }

  const energyNeededKwh = (input.capacityKwh * Math.max(0, input.targetPct - input.socPct)) / 100;
  const hoursNeeded = energyNeededKwh / input.powerKw;
  assumptions.push(
    `Charging at a constant ${input.powerKw.toFixed(1)} kW`,
    `Pack capacity ${input.capacityKwh.toFixed(1)} kWh`,
    `From ${input.socPct}% to ${input.targetPct}%`,
    `Grid energy and cost assume ${(efficiency * 100).toFixed(0)}% AC efficiency (battery energy / efficiency)`,
    `Prices are ${priceUnit} of grid energy; cost figures use that same unit`,
  );

  if (energyNeededKwh === 0) {
    return {
      feasible: true,
      ...(input.targetPct < input.socPct ? { reason: `Target ${input.targetPct}% is below the current ${input.socPct}%, so nothing needs charging.` } : { reason: 'Target already reached, nothing needs charging.' }),
      energyNeededKwh: 0,
      hoursNeeded: 0,
      steps: [],
      priceUnit,
      assumptions,
    };
  }

  const startHour = normalizeHour(input.windowStartHour);
  const endHour = normalizeHour(input.windowEndHour);
  const windowHours = ((Math.ceil(input.windowEndHour) - Math.ceil(input.windowStartHour)) % 24 + 24) % 24;
  // A window whose stated length is a multiple of 24, or whose normalized
  // start equals its normalized end (0 to 24), is a full-day window rather
  // than an empty one.
  const fullDay = windowHours === 0;
  if (startHour !== input.windowStartHour || endHour !== input.windowEndHour) {
    assumptions.push(
      `Window hours ${input.windowStartHour} to ${input.windowEndHour} are read as ${startHour}:00 to ${endHour}:00`,
    );
  }
  const inWindow = (localHour: number): boolean =>
    fullDay
      ? true
      : startHour < endHour
        ? localHour >= startHour && localHour < endHour
        : localHour >= startHour || localHour < endHour;

  const offsetMs = (input.windowOffsetMinutes ?? 0) * 60_000;
  const now = input.nowMs ?? Date.now();
  // First slot: the next whole local hour. The old code added whole minutes to
  // the call time, so a plan at 12:00:55 started at 12:00:55 and straddled two
  // price hours.
  const firstSlotStartUtc = Math.ceil((now + offsetMs) / HOUR_MS) * HOUR_MS - offsetMs;

  const slots: { startUtcMs: number; localHour: number; price?: number | undefined }[] = [];
  const parsedPrices = input.prices
    .map((slot) => ({ startsAtMs: Date.parse(slot.startsAt), price: slot.price }))
    .filter((slot) => Number.isFinite(slot.startsAtMs) && Number.isFinite(slot.price));
  const unparseablePrices = input.prices.length - parsedPrices.length;
  if (unparseablePrices > 0) {
    assumptions.push(`${unparseablePrices} supplied price slot(s) had an unparseable startsAt or a non-finite price and were ignored`);
  }
  const priceFor = (startUtcMs: number): number | undefined => {
    const match = parsedPrices.find((p) => p.startsAtMs <= startUtcMs && startUtcMs < p.startsAtMs + HOUR_MS);
    return match?.price;
  };

  for (let index = 0; index < 48; index += 1) {
    const startUtcMs = firstSlotStartUtc + index * HOUR_MS;
    const localHour = localHourOf(startUtcMs, offsetMs);
    if (!inWindow(localHour)) continue;
    slots.push({ startUtcMs, localHour, price: priceFor(startUtcMs) });
  }

  if (slots.length === 0) {
    return {
      feasible: false,
      reason: `No charge window slots found in the next 48h for window ${startHour}:00 to ${endHour}:00.`,
      energyNeededKwh: round(energyNeededKwh, 3),
      gridEnergyNeededKwh: round(energyNeededKwh / efficiency, 3),
      hoursNeeded: round(hoursNeeded, 2),
      steps: [],
      priceUnit,
      assumptions,
    };
  }

  const hoursInt = Math.ceil(hoursNeeded);
  if (hoursInt > slots.length) {
    const maxDeliverableKwh = slots.length * input.powerKw;
    const shortfallKwh = energyNeededKwh - maxDeliverableKwh;
    return {
      feasible: false,
      reason: `The charge window gives ${slots.length} hourly slot(s) in the next 48h at ${input.powerKw.toFixed(1)} kW, delivering at most ${round(maxDeliverableKwh, 2)} kWh of the ${round(energyNeededKwh, 2)} kWh needed. Shortfall ${round(shortfallKwh, 2)} kWh, so the target cannot be reached inside this window.`,
      energyNeededKwh: round(energyNeededKwh, 2),
      gridEnergyNeededKwh: round(energyNeededKwh / efficiency, 2),
      hoursNeeded: round(hoursNeeded, 2),
      steps: [],
      priceUnit,
      assumptions,
    };
  }

  // Cheapest block of adjacent hourly slots. A block is adjacent only when every
  // step starts exactly one hour after the previous one, so a filtered-slot-run
  // across two nights is not mistaken for one charge.
  let chosen: typeof slots = [];
  let bestIndex = -1;
  let bestSum = Number.POSITIVE_INFINITY;
  for (let index = 0; index + hoursInt <= slots.length; index += 1) {
    const block = slots.slice(index, index + hoursInt);
    const adjacent = block.every(
      (slot, position) => position === 0 || slot.startUtcMs - block[position - 1]!.startUtcMs === HOUR_MS,
    );
    if (!adjacent) continue;
    const sum = block.reduce((total, slot) => total + (slot.price ?? Number.POSITIVE_INFINITY), 0);
    if (sum < bestSum) {
      bestSum = sum;
      bestIndex = index;
    }
  }

  let contiguous = bestIndex >= 0;
  if (bestIndex >= 0) {
    chosen = slots.slice(bestIndex, bestIndex + hoursInt);
  } else {
    chosen = [...slots]
      .sort((a, b) => (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY) || a.startUtcMs - b.startUtcMs)
      .slice(0, hoursInt);
    chosen.sort((a, b) => a.startUtcMs - b.startUtcMs);
    assumptions.push('The chosen hours are not contiguous, so charging may be interrupted between them');
  }

  const unpriced = chosen.filter((slot) => slot.price === undefined);
  if (unpriced.length > 0) {
    const first = unpriced[0]!;
    return {
      feasible: false,
      reason: `Price data does not cover the scheduled hours: ${unpriced.length} of ${chosen.length} planned hour(s) have no hourly price (first missing ${new Date(first.startUtcMs).toISOString()}). Supply hourly prices covering the whole charge window; a plan is not presented with unpriced hours.`,
      energyNeededKwh: round(energyNeededKwh, 3),
      gridEnergyNeededKwh: round(energyNeededKwh / efficiency, 3),
      hoursNeeded: round(hoursNeeded, 2),
      steps: [],
      priceUnit,
      assumptions,
    };
  }

  // Allocate energy from the chosen schedule: a full hour is one hour at the
  // modelled power, the last hour takes only what is still missing. Spreading
  // the need evenly over rounded-up hours billed boundary energy at the wrong
  // price and overstated the cost of a partially used hour.
  let remainingKwh = energyNeededKwh;
  const steps: ChargePlanStep[] = chosen.map((slot) => {
    const batteryEnergyKwh = Math.min(input.powerKw, Math.max(0, remainingKwh));
    remainingKwh -= batteryEnergyKwh;
    const gridEnergyKwh = batteryEnergyKwh / efficiency;
    const price = slot.price!;
    return {
      startsAt: new Date(slot.startUtcMs).toISOString(),
      endsAt: new Date(slot.startUtcMs + HOUR_MS).toISOString(),
      price,
      energyKwh: round(batteryEnergyKwh, 3),
      gridEnergyKwh: round(gridEnergyKwh, 3),
      cost: round(price * gridEnergyKwh, 3),
    };
  });

  // Cost comes from the steps that are scheduled, including a zero or negative
  // total: a negative spot price is a real answer, and dropping the field made
  // the cheapest plan look like the one with no price at all.
  const totalCost = round(steps.reduce((total, step) => total + step.cost, 0), 3);
  const totalGridEnergyKwh = round(steps.reduce((total, step) => total + step.gridEnergyKwh, 0), 3);

  return {
    feasible: true,
    ...(contiguous
      ? {}
      : { reason: `No block of ${hoursInt} adjacent hours fits the charge window in the next 48h, so the cheapest individual hours are scheduled instead; they are not contiguous.` }),
    energyNeededKwh: round(energyNeededKwh, 3),
    gridEnergyNeededKwh: round(energyNeededKwh / efficiency, 3),
    hoursNeeded: round(hoursNeeded, 2),
    steps,
    totalCost,
    totalGridEnergyKwh,
    priceUnit,
    assumptions,
  };
}
