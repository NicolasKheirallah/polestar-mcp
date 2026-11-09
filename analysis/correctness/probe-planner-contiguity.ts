/**
 * Probe: planner "contiguous block" is contiguous in the *filtered slot array*,
 * not in time. A window of 4 hours/day (22:00-02:00) with 5 hours of energy needed
 * chooses a 5-slot block that straddles a 22-hour gap and reports it as contiguous
 * (no `reason`, no "hours are not contiguous" assumption).
 */
import { planCheapestCharge } from '../../src/planner.js';

const start = Date.parse('2026-01-01T00:00:00Z');
const prices = Array.from({ length: 96 }, (_, i) => ({ startsAt: new Date(start + i * 3_600_000).toISOString(), price: 0.2 }));

const plan = planCheapestCharge({
  prices,
  socPct: 0,
  targetPct: 60, // 48 kWh at 10 kW = 4.8h -> hoursInt 5 > 4 slots/day
  capacityKwh: 80,
  powerKw: 10,
  windowStartHour: 22,
  windowEndHour: 2,
  nowMs: Date.parse('2026-01-01T12:00:00Z'),
});

const gapsHours = plan.steps.slice(1).map((s, i) => (Date.parse(s.startsAt) - Date.parse(plan.steps[i]!.endsAt)) / 3_600_000);

console.log(
  JSON.stringify(
    {
      feasible: plan.feasible,
      hoursNeeded: plan.hoursNeeded,
      steps: plan.steps.map((s) => s.startsAt),
      gapHoursBetweenSteps: gapsHours,
      reason: plan.reason ?? null,
      saysNonContiguous: plan.assumptions.some((a) => /not contiguous/i.test(a)),
      note: 'the 5th slot is 22 hours after the 4th, but the plan calls the block contiguous',
    },
    null,
    2,
  ),
);
