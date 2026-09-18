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
  /** Usable pack capacity kWh (from dischargeInfo.energyAvailable or a spec value). */
  capacityKwh: number;
  /** Charging power in kW at the configured amp limit. */
  powerKw: number;
  /** Charge window start hour (0-23), from the global charge timer. */
  windowStartHour: number;
  /** Charge window end hour (0-23); may be smaller than start (wraps midnight). */
  windowEndHour: number;
  /** Fixed UTC offset of the window in minutes (from the timer's timeZone). */
  windowOffsetMinutes?: number;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export interface ChargePlanStep {
  startsAt: string;
  endsAt: string;
  price?: number;
  energyKwh: number;
}

export interface ChargePlan {
  feasible: boolean;
  reason?: string;
  energyNeededKwh: number;
  hoursNeeded: number;
  /** Ordered plan; empty when not feasible. */
  steps: ChargePlanStep[];
  totalCost?: number;
  assumptions: string[];
}

/**
 * Picks the cheapest hours inside the car's charge window that still deliver
 * the energy needed to reach the target SoC. Pure arithmetic over data the
 * server already serves (target-soc, amp-limit, battery, global-charge-timer)
 * plus a price curve the caller supplies, no writes, no external calls.
 */
export function planCheapestCharge(input: ChargePlanInput): ChargePlan {
  const assumptions: string[] = [
    `Charging at a constant ${input.powerKw.toFixed(1)} kW`,
    `Pack capacity ${input.capacityKwh.toFixed(1)} kWh`,
    `From ${input.socPct}% to ${input.targetPct}%`,
  ];

  const energyNeededKwh = input.capacityKwh * Math.max(0, input.targetPct - input.socPct) / 100;
  if (energyNeededKwh === 0) {
    return { feasible: true, energyNeededKwh: 0, hoursNeeded: 0, steps: [], assumptions: [...assumptions, 'Target already reached'] };
  }
  const hoursNeeded = Math.ceil((energyNeededKwh / input.powerKw) * 100) / 100;

  // Expand the window into concrete hourly slots over the next 48h in the
  // window's fixed-offset timezone (timers report a single offsetMinutes).
  const offsetMin = input.windowOffsetMinutes ?? 0;
  const now = input.nowMs ?? Date.now();
  const slots: { startUtcMs: number; price?: number; localHour: number }[] = [];
  const inWindow = (localHour: number): boolean =>
    input.windowStartHour <= input.windowEndHour
      ? localHour >= input.windowStartHour && localHour < input.windowEndHour
      : localHour >= input.windowStartHour || localHour < input.windowEndHour;

  const hourMs = 3_600_000;
  // First slot: the next whole local hour.
  const firstSlotStartUtc = now + ((60 - Math.floor(((now + offsetMin * 60_000) % hourMs) / 60_000)) % 60) * 60_000;

  for (let i = 0; i < 48; i++) {
    const startUtcMs = firstSlotStartUtc + i * hourMs;
    const localHour = Math.floor((((startUtcMs + offsetMin * 60_000) % 86_400_000) + 86_400_000) / hourMs) % 24;
    if (!inWindow(localHour)) continue;
    slots.push({ startUtcMs, localHour });
  }

  const priceFor = (startUtcMs: number): number | undefined => {
    const match = input.prices.find((p) => {
      const t = Date.parse(p.startsAt);
      return Number.isFinite(t) && t <= startUtcMs && startUtcMs < t + hourMs;
    });
    return match?.price;
  };

  const priced = slots.map((slot) => ({ ...slot, price: priceFor(slot.startUtcMs) }));
  if (priced.length === 0) {
    return {
      feasible: false,
      reason: `No charge window slots found in the next 48h for window ${input.windowStartHour}:00–${input.windowEndHour}:00.`,
      energyNeededKwh,
      hoursNeeded,
      steps: [],
      assumptions,
    };
  }

  const rated = priced.map((slot) => ({ ...slot, effectivePrice: slot.price ?? Number.POSITIVE_INFINITY }));
  const unpriced = rated.filter((slot) => slot.price === undefined).length;
  if (unpriced > 0) {
    assumptions.push(`${unpriced} window slot(s) had no price and are treated as last resorts`);
  }

  // Cheapest contiguous block that fits hoursNeeded; fall back to greedy
  // cheapest-first individual hours when no contiguous block is large enough.
  const hoursInt = Math.ceil(hoursNeeded);
  let chosen: typeof rated = [];
  let contiguous = true;
  let bestSum = Number.POSITIVE_INFINITY;
  for (let i = 0; i + hoursInt <= rated.length; i++) {
    const block = rated.slice(i, i + hoursInt);
    const sum = block.reduce((acc, s) => acc + s.effectivePrice, 0);
    if (sum < bestSum) {
      bestSum = sum;
      chosen = block;
    }
  }
  if (chosen.length === 0 || hoursInt > rated.length) {
    contiguous = false;
    chosen = [...rated].sort((a, b) => a.effectivePrice - b.effectivePrice).slice(0, Math.min(hoursInt, rated.length));
    chosen.sort((a, b) => a.startUtcMs - b.startUtcMs);
  }

  const perStepKwh = energyNeededKwh / hoursInt;
  const steps: ChargePlanStep[] = chosen.map((slot) => ({
    startsAt: new Date(slot.startUtcMs).toISOString(),
    endsAt: new Date(slot.startUtcMs + hourMs).toISOString(),
    ...(slot.price !== undefined ? { price: slot.price } : {}),
    energyKwh: Math.min(perStepKwh, energyNeededKwh),
  }));

  const totalCost = steps.reduce((acc, s) => acc + (s.price ?? 0) * s.energyKwh, 0);
  return {
    feasible: true,
    ...(contiguous ? {} : { reason: 'Window too short for one contiguous block, fell back to cheapest individual hours.' }),
    energyNeededKwh: Math.round(energyNeededKwh * 100) / 100,
    hoursNeeded,
    steps,
    ...(totalCost > 0 ? { totalCost: Math.round(totalCost * 1000) / 1000 } : {}),
    assumptions: [...assumptions, ...(contiguous ? [] : ['Hours are not contiguous, real charging may be interrupted'])],
  };
}
