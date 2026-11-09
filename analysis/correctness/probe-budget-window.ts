/**
 * Probe: is the daily budget window "rolling" as src/budget.ts:28 and
 * docs/architecture.md:119 say, or does it reset at UTC midnight?
 *
 * Also: what happens to `used` when the wall clock steps backwards (NTP / a
 * container clock correction) after a day has rolled?
 */
import { BudgetMeter } from '../../src/budget.js';

const out: Record<string, unknown> = {};

// boundary
let now = Date.UTC(2026, 0, 1, 23, 59, 59);
const meter = new BudgetMeter(10, () => now);
meter.consume();
meter.consume();
const before = meter.snapshot();
now = Date.UTC(2026, 0, 2, 0, 0, 0);
const after = meter.snapshot();
out.boundary = {
  at_23_59_59: { used: before.used, resetsAtUtc: before.resetsAtUtc },
  at_00_00_00: { used: after.used, resetsAtUtc: after.resetsAtUtc },
  note: 'the whole budget resets at the UTC midnight instant; a rolling 24h window would not',
};

// clock steps backwards after a roll
let t = Date.UTC(2026, 0, 1, 23, 0, 0);
const stepped = new BudgetMeter(10, () => t);
for (let i = 0; i < 5; i += 1) stepped.consume();
t = Date.UTC(2026, 0, 2, 0, 30, 0);
const rolled = stepped.snapshot();
// the clock is corrected back to before midnight (same UTC day the window started in)
t = Date.UTC(2026, 0, 1, 23, 59, 0);
stepped.consume();
const steppedBack = stepped.snapshot();
out.backward_clock = {
  used_after_roll: rolled.used,
  used_after_backward_step: steppedBack.used,
  note: 'dayStart < windowStart so no re-roll: the post-midnight call is metered against the previous day window',
};

console.log(JSON.stringify(out, null, 2));
