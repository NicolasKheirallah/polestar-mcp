/**
 * Probes for planCheapestCharge arithmetic:
 *  A) a window with fewer hourly slots than the energy needs: does the plan
 *     still claim feasible with a schedule that delivers *less* energy?
 *  B) negative prices: is totalCost reported?
 *  C) a stop hour expressed as >23 (the shape the repo's own
 *     test/charge-model.test.ts payload uses): which hours does the window cover?
 *  D) the "contiguous fallback" scenario of test/planner.test.ts: does it ever
 *     reach the fallback branch?
 */
import { planCheapestCharge } from '../../src/planner.js';

const pricesFor = (hours: number, price: number, startIso = '2026-01-01T00:00:00Z') => {
  const start = Date.parse(startIso);
  return Array.from({ length: hours }, (_, i) => ({
    startsAt: new Date(start + i * 3_600_000).toISOString(),
    price,
  }));
};

const out: Record<string, unknown> = {};

// A) 1-hour window (one slot per day, two in the next 48h), 64 kWh needed at 10 kW.
const scarce = planCheapestCharge({
  prices: pricesFor(48, 0.2),
  socPct: 10,
  targetPct: 90,
  capacityKwh: 80,
  powerKw: 10,
  windowStartHour: 0,
  windowEndHour: 1,
  nowMs: Date.parse('2026-01-01T00:00:00Z'),
});
out.A_scarce_window = {
  feasible: scarce.feasible,
  reason: scarce.reason,
  energyNeededKwh: scarce.energyNeededKwh,
  hoursNeeded: scarce.hoursNeeded,
  steps: scarce.steps.length,
  energyPlannedKwh: scarce.steps.reduce((a, s) => a + s.energyKwh, 0),
  shortfallKwh: Math.round((scarce.energyNeededKwh - scarce.steps.reduce((a, s) => a + s.energyKwh, 0)) * 100) / 100,
};

// B) negative spot prices (a paid-to-charge hour): totalCost should be negative.
const negative = planCheapestCharge({
  prices: pricesFor(12, -0.1),
  socPct: 50,
  targetPct: 80,
  capacityKwh: 80,
  powerKw: 10,
  windowStartHour: 0,
  windowEndHour: 6,
  nowMs: Date.parse('2026-01-01T00:00:00Z'),
});
out.B_negative_prices = {
  feasible: negative.feasible,
  steps: negative.steps.length,
  stepPrices: negative.steps.map((s) => s.price),
  totalCost: negative.totalCost,
  sumPriceXEnergy: Math.round(negative.steps.reduce((a, s) => a + (s.price ?? 0) * s.energyKwh, 0) * 1000) / 1000,
};

// C) stop hour 28 (04:00 next day as used by test/charge-model.test.ts): which hours are planned?
const lateStop = planCheapestCharge({
  prices: pricesFor(48, 0.2, '2026-01-01T00:00:00Z'),
  socPct: 50,
  targetPct: 80,
  capacityKwh: 80,
  powerKw: 10,
  windowStartHour: 22,
  windowEndHour: 28,
  nowMs: Date.parse('2026-01-01T12:00:00Z'),
});
out.C_stop_hour_28 = {
  plannedLocalHours: lateStop.steps.map((s) => new Date(s.startsAt).getUTCHours()),
  plannedUtcTimes: lateStop.steps.map((s) => s.startsAt),
  note: 'window 22:00-28:00 means 22:00-04:00; 00:00-03:00 never appears',
};

// D) the scenario test/planner.test.ts calls "falls back to cheapest individual hours".
const fallbackTestScenario = planCheapestCharge({
  prices: [
    { startsAt: '2026-09-20T00:00:00Z', price: 0.1 },
    { startsAt: '2026-09-20T01:00:00Z', price: 0.9 },
    { startsAt: '2026-09-20T02:00:00Z', price: 0.2 },
  ],
  socPct: 0,
  targetPct: 90,
  capacityKwh: 100,
  powerKw: 100,
  windowStartHour: 0,
  windowEndHour: 3,
  nowMs: Date.parse('2026-09-19T23:00:00Z'),
});
out.D_named_fallback_test = {
  feasible: fallbackTestScenario.feasible,
  reason: fallbackTestScenario.reason ?? null,
  steps: fallbackTestScenario.steps.length,
  hoursNeeded: fallbackTestScenario.hoursNeeded,
  // the assertion in that test is `reason !== undefined || steps.length > 0`
  testAssertionWouldPass: fallbackTestScenario.reason !== undefined || fallbackTestScenario.steps.length > 0,
  fellBackToIndividualHours: /fell back/i.test(fallbackTestScenario.reason ?? ''),
};

console.log(JSON.stringify(out, null, 2));
