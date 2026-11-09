import { z } from 'zod';
import { planCheapestCharge, type PriceSlot } from './planner.js';
import { ampLimitA, batteryView, chargeWindow, targetSoc, type ChargeWindow } from './domain-data.js';
import { chargeModel } from './charge-model.js';
import { climateTimerEntries } from './aggregate-tools.js';
import { formatUtcOffset, maskVin, normalizeHour } from './format.js';
import { delegatedAccountArg, errorResult, vinArg, withData, type ToolContext, type ToolDeps, type ToolResult } from './tool-output.js';
import { noData, readDomains, unknownData, vehicleFor } from './vehicle-read.js';
import type { ToolSpec } from './tools.js';

const planArgs = {
  ...vinArg,
  ...delegatedAccountArg,
  prices: z
    .array(z.object({ startsAt: z.string(), price: z.number() }))
    .describe('Hourly prices from your spot-price provider: [{startsAt: "2026-09-19T22:00:00+02:00", price: 0.42}, ...]. Prices are in your own currency per kWh; the answer names that unit back.'),
  phases: z.number().int().min(1).max(3).optional().describe('AC phases at your charger (default 3, Swedish 400V three-phase). A voltage the car reports is treated as line-to-line.'),
  capacityKwh: z
    .number()
    .positive()
    .optional()
    .describe('Usable pack capacity; used only when the car reports neither dischargeInfo.energyAvailable nor a range with average consumption.'),
};

type PlanArgs = {
  vin?: string;
  prices: PriceSlot[];
  phases?: number;
  capacityKwh?: number;
};

const departureArgs = {
  ...vinArg,
  ...delegatedAccountArg,
  departureAt: z
    .string()
    .optional()
    .describe('Requested departure as ISO 8601 with a UTC offset or Z, e.g. "2026-09-20T14:00:00+02:00". Omit it to use the next repeating parking climate timer; a one-shot timer with no date is refused rather than guessed.'),
  phases: z.number().int().min(1).max(3).optional().describe('AC phases at your charger (default 3). A voltage the car reports is treated as line-to-line.'),
  capacityKwh: z
    .number()
    .positive()
    .optional()
    .describe('Usable pack capacity; used only when the car reports neither dischargeInfo.energyAvailable nor a range with average consumption.'),
};

type DepartureArgs = {
  vin?: string;
  departureAt?: string;
  phases?: number;
  capacityKwh?: number;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEKDAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;

/** An ISO 8601 instant with an explicit zone: a local wall time alone is ambiguous. */
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** The fixed-offset local reading of an instant, in the window's own clock. */
function localReading(utcMs: number, offsetMinutes: number): { weekday: string; hour: number; time: string } {
  const local = new Date(utcMs + offsetMinutes * 60_000);
  const weekday = WEEKDAY_NAMES[local.getUTCDay()] ?? 'SUNDAY';
  const hour = local.getUTCHours();
  return {
    weekday,
    hour,
    time: `${weekday} ${String(hour).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`,
  };
}

/** The next occurrence of a weekday and clock hour strictly after `nowMs`. */
function nextWeekdayHourMs(weekday: string, hour: number, offsetMinutes: number, nowMs: number): number | undefined {
  const wanted = WEEKDAY_NAMES.indexOf(weekday.toUpperCase() as (typeof WEEKDAY_NAMES)[number]);
  if (wanted < 0 || hour < 0 || hour > 23) return undefined;
  const offsetMs = offsetMinutes * 60_000;
  const nowLocal = nowMs + offsetMs;
  const dayStart = Math.floor(nowLocal / DAY_MS) * DAY_MS;
  const todayWeekday = new Date(dayStart).getUTCDay();
  const deltaDays = ((wanted - todayWeekday) % 7 + 7) % 7;
  let candidate = dayStart + deltaDays * DAY_MS + hour * HOUR_MS;
  if (candidate <= nowLocal) candidate += 7 * DAY_MS;
  return candidate - offsetMs;
}

interface WindowShape {
  startHour: number;
  endHour: number;
  fullDay: boolean;
  offsetMinutes: number;
}

/** Window hours normalized the way the planner reads them: 28 is 04:00, 0 to 24 is a whole day. */
function windowShape(window: ChargeWindow): WindowShape | undefined {
  if (window.startHour === undefined || window.stopHour === undefined) return undefined;
  const startHour = normalizeHour(window.startHour)!;
  const endHour = normalizeHour(window.stopHour)!;
  const length = ((Math.ceil(window.stopHour) - Math.ceil(window.startHour)) % 24 + 24) % 24;
  return { startHour, endHour, fullDay: length === 0, offsetMinutes: window.offsetMinutes ?? 0 };
}

/** The latest moment the charge window closes at or before the departure. */
function latestWindowCloseMs(departureMs: number, shape: WindowShape): number {
  const offsetMs = shape.offsetMinutes * 60_000;
  const departureLocal = departureMs + offsetMs;
  let closeLocal = Math.floor(departureLocal / DAY_MS) * DAY_MS + shape.endHour * HOUR_MS;
  if (closeLocal > departureLocal) closeLocal -= DAY_MS;
  return closeLocal - offsetMs;
}

/** Whole hours of charge window left between now and the deadline. */
function completeWindowHours(nowMs: number, deadlineMs: number, shape: WindowShape): number {
  const offsetMs = shape.offsetMinutes * 60_000;
  const firstSlot = Math.ceil((nowMs + offsetMs) / HOUR_MS) * HOUR_MS - offsetMs;
  let hours = 0;
  for (let slot = firstSlot; slot + HOUR_MS <= deadlineMs; slot += HOUR_MS) {
    const localHour = Math.floor((((slot + offsetMs) % DAY_MS) + DAY_MS) % DAY_MS / HOUR_MS) % 24;
    const inWindow = shape.fullDay
      ? true
      : shape.startHour < shape.endHour
        ? localHour >= shape.startHour && localHour < shape.endHour
        : localHour >= shape.startHour || localHour < shape.endHour;
    if (inWindow) hours += 1;
  }
  return hours;
}

type PreconditioningStatus = 'scheduled' | 'inactive' | 'not-scheduled' | 'one-shot-unconfirmed' | 'none-configured' | 'unknown';

interface Preconditioning {
  status: PreconditioningStatus;
  detail: string;
}

/** Whether the car is set to precondition for the requested departure. */
function evaluatePreconditioning(climate: Record<string, unknown> | null, departureMs: number): Preconditioning {
  if (climate === null) {
    return { status: 'unknown', detail: 'the parking climate timer is not reported, so preconditioning is unknown' };
  }
  const timers = climateTimerEntries(climate);
  if (timers.length === 0) {
    return { status: 'none-configured', detail: 'no parking climate timer is configured, so the car will not precondition on its own' };
  }
  for (const timer of timers) {
    if (timer.hour === undefined) continue;
    const local = localReading(departureMs, timer.offsetMinutes ?? 0);
    const hourMatches = local.hour === normalizeHour(timer.hour);
    const dayMatches = timer.weekdays.some((day) => day.toUpperCase() === local.weekday);
    if (!hourMatches || !dayMatches) continue;
    if (timer.activated !== true) {
      return { status: 'inactive', detail: 'the parking climate timer is defined but INACTIVE on the car, so the car will not precondition on its own' };
    }
    if (timer.repeat !== true) {
      return { status: 'one-shot-unconfirmed', detail: 'a one-shot parking climate timer is set for that time but carries no date, so preconditioning for this departure cannot be confirmed' };
    }
    return { status: 'scheduled', detail: `scheduled for ${local.time} (active)` };
  }
  const configured = timers
    .filter((timer) => timer.hour !== undefined)
    .map((timer) => `${timer.weekdays.join('/') || 'no weekday'} ${String(normalizeHour(timer.hour!)).padStart(2, '0')}:00`)
    .join(', ');
  return {
    status: 'not-scheduled',
    detail: `no parking climate timer matches that departure${configured === '' ? '' : ` (configured: ${configured})`}`,
  };
}

/** Minutes rendered as `2h 5m`, used for window and charging durations. */
const durationText = (minutes: number): string => `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

/**
 * plan_cheapest_charge: the read-only smart-charging advisor. Combines four
 * data points the server already serves, current SoC, target SoC, amp limit,
 * and the (often inactive) charge window from the global charge timer, with
 * a price curve the caller supplies, and computes the cheapest adjacent hours
 * that reach the target. No writes, no external fetches: prices arrive as an
 * argument so the LLM can paste them from any tariff source.
 *
 * The answer is feasible only when the schedule can deliver the whole energy
 * need and every scheduled hour has a price. A shortfall, a gap in time, or a
 * price curve that misses the window is stated instead of being papered over.
 */
export function advisorToolSpecs(deps: ToolDeps): ToolSpec[] {
  return [
    {
      name: 'plan_cheapest_charge',
      title: 'Plan the cheapest charge',
      description:
        'Given hourly electricity prices, computes the cheapest hours inside the car\'s charge window (from global-charge-timer) that deliver enough energy to reach the target charge level. The plan is feasible only when the window can deliver the full energy need and the prices cover the scheduled hours; otherwise the shortfall, the non-contiguity, or the missing prices are stated. Cost is computed from the scheduled steps on grid energy at 90% AC efficiency.',
      args: planArgs,
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (args: PlanArgs, ctx: ToolContext): Promise<ToolResult> => {
        try {
          const found = await vehicleFor(deps, ctx, args, 'pick-vehicle-plan');
          if (!found.ok) return found.result;
          const { battery, target, amp, timer } = await readDomains(found.vehicle, {
            battery: { kind: 'telemetry', name: 'battery' },
            target: { kind: 'charging', name: 'target-soc' },
            amp: { kind: 'charging', name: 'amp-limit' },
            timer: { kind: 'charging', name: 'global-charge-timer' },
          });
          const phases = args.phases ?? 3;

          if (battery === null) {
            return noData(found.vehicle, { kind: 'telemetry', name: 'battery' }, 'Without the charge level there is nothing to plan from.');
          }

          const window = chargeWindow(timer);
          const targetSeen = targetSoc(target);
          const batterySeen = batteryView(battery);
          const model = chargeModel({
            socPct: batterySeen.chargeLevelPct,
            targetPct: targetSeen.levelPct,
            ampLimitA: ampLimitA(amp),
            reportedVolts: batterySeen.volts,
            livePowerW: batterySeen.powerWatts,
            energyAvailableKwh: batterySeen.energyAvailableKwh,
            distanceToEmptyKm: batterySeen.distanceToEmptyKm,
            consumptionKwhPer100Km: batterySeen.consumptionKwhPer100Km,
            suppliedCapacityKwh: args.capacityKwh,
            phases,
          });
          const soc = batterySeen.chargeLevelPct;
          const targetPct = targetSeen.levelPct;

          const planVin = maskVin(found.vehicle.vin, deps.redactVin);
          const refusedPlan = (message: string, reason: string): ToolResult =>
            withData(message, { feasible: false, reason }, { vin: planVin });
          if (model.problems.length > 0) {
            return refusedPlan(`Cannot plan: ${model.problems.join('; ')}.`, model.problems.join('; '));
          }
          if (typeof soc !== 'number' || typeof targetPct !== 'number') {
            return refusedPlan('Missing required data (battery SoC or target SoC), cannot plan.', 'missing battery SoC or target SoC');
          }
          if (window?.startHour === undefined || window.stopHour === undefined) {
            return refusedPlan(
              'No charge window is configured on the car (global-charge-timer is unset). Set one in the Polestar app first, or ask the user for a window.',
              'no charge window configured on the car',
            );
          }
          const powerKw = model.powerKw;
          if (powerKw === undefined) {
            return refusedPlan(`Cannot plan: ${model.missing.join('; ')}.`, model.missing.join('; '));
          }
          const capacityKwh = model.capacityKwh;
          if (capacityKwh === undefined) {
            return refusedPlan(
              'Pack capacity is unknown: the car reports neither dischargeInfo.energyAvailable nor estimatedDistanceToEmptyKm with averageEnergyConsumptionKwhPer100Km, and no capacityKwh argument was given. Pass capacityKwh explicitly, e.g. 78 for a long range dual motor.',
              'pack capacity unknown',
            );
          }

          // Power, capacity and efficiency come from the same model
          // get_charging_estimate uses, so the two tools cannot disagree about
          // one car or about the wall-to-battery loss.
          const plan = planCheapestCharge({
            prices: args.prices ?? [],
            socPct: soc,
            targetPct,
            capacityKwh,
            powerKw,
            windowStartHour: window.startHour,
            windowEndHour: window.stopHour,
            windowOffsetMinutes: window.offsetMinutes ?? 0,
            efficiency: model.efficiency,
            ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs() } : {}),
          });

          const windowState = window.activated === true
            ? 'car window active'
            : window.activated === false
              ? 'note: the car window is defined but INACTIVE on the car'
              : 'car window activation not reported';
          const lines = [
            `Charge plan (${windowState})`,
            `Need: ${plan.energyNeededKwh} kWh at the battery${plan.gridEnergyNeededKwh !== undefined ? ` (${plan.gridEnergyNeededKwh} kWh from the grid at ${(model.efficiency * 100).toFixed(0)}% AC efficiency)` : ''} to go ${soc}% → ${targetPct}% ≈ ${plan.hoursNeeded}h at ${powerKw.toFixed(1)} kW`,
            '',
          ];
          if (!plan.feasible) {
            lines.push(`Not feasible: ${plan.reason}`);
          } else if (plan.steps.length === 0) {
            lines.push('Nothing to do, target already reached.');
          } else {
            for (const step of plan.steps) {
              lines.push(
                `• ${step.startsAt} → ${step.endsAt} @ ${step.price}: ${step.energyKwh.toFixed(1)} kWh at the battery, ${step.gridEnergyKwh.toFixed(1)} kWh from the grid`,
              );
            }
            lines.push(`Estimated cost: ${plan.totalCost} (${plan.priceUnit})`);
            if (plan.reason) lines.push(`Note: ${plan.reason}`);
          }
          lines.push('', `Assumptions: ${plan.assumptions.join('; ')}.`);
          return withData(lines.join('\n'), {
            feasible: plan.feasible,
            ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
            energyNeededKwh: plan.energyNeededKwh,
            ...(plan.gridEnergyNeededKwh !== undefined ? { gridEnergyNeededKwh: plan.gridEnergyNeededKwh } : {}),
            hoursNeeded: plan.hoursNeeded,
            steps: plan.steps,
            ...(plan.totalCost !== undefined ? { totalCost: plan.totalCost } : {}),
            ...(plan.totalGridEnergyKwh !== undefined ? { totalGridEnergyKwh: plan.totalGridEnergyKwh } : {}),
            priceUnit: plan.priceUnit,
            assumptions: plan.assumptions,
          }, { vin: planVin });
        } catch (err) {
          return errorResult(err);
        }
      },
    },

    {
      name: 'get_departure_readiness',
      title: 'Get departure readiness',
      description:
        'Given a departure time (departureAt, ISO 8601 with a UTC offset), or the next repeating parking climate timer when departureAt is omitted, answers whether the car can be charged to its target and preconditioned by then. Names the latest charge deadline, the energy and window time needed, refuses to guess when only a one-shot timer without a date is configured, and ends with a read-only advice sentence: this server cannot start charging or climate.',
      args: departureArgs,
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (args: DepartureArgs, ctx: ToolContext): Promise<ToolResult> => {
        try {
          const found = await vehicleFor(deps, ctx, args, 'pick-vehicle-departure');
          if (!found.ok) return found.result;
          const { climate, timer, battery, target, amp } = await readDomains(found.vehicle, {
            climate: { kind: 'charging', name: 'parking-climate-timer' },
            timer: { kind: 'charging', name: 'global-charge-timer' },
            battery: { kind: 'telemetry', name: 'battery' },
            target: { kind: 'charging', name: 'target-soc' },
            amp: { kind: 'charging', name: 'amp-limit' },
          });
          const nowMs = deps.nowMs?.() ?? Date.now();
          const vin = maskVin(found.vehicle.vin, deps.redactVin);
          const refuse = (reason: string): ToolResult =>
            withData(`Refused: ${reason}`, { refused: true, reason }, { vin });

          // Departure: the caller's argument, or the next repeating climate timer.
          let departureMs: number;
          let departureSource: string;
          if (args.departureAt !== undefined) {
            if (!ZONED_ISO.test(args.departureAt.trim())) {
              return refuse('departureAt must be an ISO 8601 timestamp with a UTC offset or Z (for example "2026-09-20T14:00:00+02:00"), so the local time is unambiguous.');
            }
            const parsed = Date.parse(args.departureAt);
            if (!Number.isFinite(parsed)) {
              return refuse(`departureAt ${JSON.stringify(args.departureAt)} is not a valid timestamp.`);
            }
            departureMs = parsed;
            departureSource = 'the departureAt argument';
          } else {
            if (climate === null) {
              return withData(
                `Unknown, not reported: vehicle ${found.vehicle.label} does not report the parking climate timer, so no departure time can be derived. Pass departureAt as an ISO 8601 timestamp with a UTC offset.`,
                { refused: true, reason: 'parking-climate-timer not reported and no departureAt given', unknown: ['parking-climate-timer'] },
                { vin },
              );
            }
            const timers = climateTimerEntries(climate);
            if (timers.length === 0) {
              return refuse('no parking climate timer is configured on the car, so the next departure time cannot be derived. Pass departureAt explicitly.');
            }
            const repeating = timers.filter((entry) => entry.repeat === true && entry.hour !== undefined && entry.weekdays.length > 0);
            if (repeating.length === 0) {
              return refuse('the parking climate timer is a one-shot timer with no date field in this API, so the departure time cannot be resolved without guessing. Pass departureAt explicitly.');
            }
            const candidates = repeating
              .flatMap((entry) => entry.weekdays.map((weekday) => nextWeekdayHourMs(weekday, entry.hour!, entry.offsetMinutes ?? 0, nowMs)))
              .filter((candidate): candidate is number => candidate !== undefined);
            if (candidates.length === 0) {
              return refuse('the repeating parking climate timer did not resolve to a future departure. Pass departureAt explicitly.');
            }
            departureMs = Math.min(...candidates);
            departureSource = 'the next repeating parking climate timer';
          }
          if (departureMs <= nowMs) {
            return refuse(`the requested departure ${new Date(departureMs).toISOString()} is not in the future.`);
          }
          if (departureMs - nowMs > 8 * DAY_MS) {
            return refuse('the requested departure is more than 8 days ahead, beyond the horizon this readiness check evaluates.');
          }

          if (timer === null) {
            return unknownData(found.vehicle, [{ kind: 'charging', name: 'global-charge-timer' }], 'Without the charge window the latest charge deadline cannot be computed.');
          }
          if (battery === null) {
            return unknownData(found.vehicle, [{ kind: 'telemetry', name: 'battery' }], 'Without the charge level the energy needed by the departure cannot be computed.');
          }

          const window = chargeWindow(timer);
          const shape = window === undefined ? undefined : windowShape(window);
          if (window === undefined || shape === undefined) {
            return refuse('no charge window start and stop hours are configured (global-charge-timer is unset), so the charge deadline cannot be computed.');
          }
          const reportedTarget = targetSoc(target).levelPct;
          if (reportedTarget === undefined) {
            return refuse('the car does not report a target charge level (charging/target-soc), so "charged by the departure" has no defined level. Set a target in the Polestar app.');
          }
          const batterySeen = batteryView(battery);
          const model = chargeModel({
            socPct: batterySeen.chargeLevelPct,
            targetPct: reportedTarget,
            ampLimitA: ampLimitA(amp),
            reportedVolts: batterySeen.volts,
            livePowerW: batterySeen.powerWatts,
            energyAvailableKwh: batterySeen.energyAvailableKwh,
            distanceToEmptyKm: batterySeen.distanceToEmptyKm,
            consumptionKwhPer100Km: batterySeen.consumptionKwhPer100Km,
            suppliedCapacityKwh: args.capacityKwh,
            phases: args.phases ?? 3,
          });
          if (model.problems.length > 0) return refuse(model.problems.join('; '));
          const soc = batterySeen.chargeLevelPct;
          if (soc === undefined) return refuse(model.missingEnergy.join('; ') || 'the car does not report its state of charge.');
          const powerKw = model.powerKw;
          if (powerKw === undefined) return refuse(model.missing.join('; '));
          const capacityKwh = model.capacityKwh;
          if (capacityKwh === undefined) return refuse(`pack capacity is unknown. missing: ${model.missingEnergy.join('; ')}`);

          const energyNeededKwh = model.energyNeededKwh ?? 0;
          const deadlineMs = latestWindowCloseMs(departureMs, shape);
          const windowHours = completeWindowHours(nowMs, deadlineMs, shape);
          const requiredHours = energyNeededKwh / powerKw;
          const enoughWindow = energyNeededKwh <= powerKw * windowHours + 1e-9;
          const chargeReadiness: 'yes' | 'short-window' | 'window-inactive' | 'activation-unknown' = !enoughWindow
            ? 'short-window'
            : window.activated === true
              ? 'yes'
              : window.activated === false
                ? 'window-inactive'
                : 'activation-unknown';
          const preconditioning = evaluatePreconditioning(climate, departureMs);

          const reasons: string[] = [];
          if (chargeReadiness === 'short-window') {
            reasons.push(`the window offers ${windowHours} complete hour(s) before the deadline, but ${roundTo(requiredHours, 2)}h at ${powerKw.toFixed(1)} kW is needed for ${energyNeededKwh.toFixed(1)} kWh`);
          }
          if (chargeReadiness === 'window-inactive') reasons.push('the charge window is defined but INACTIVE on the car, so the car will not charge on its own');
          if (chargeReadiness === 'activation-unknown') reasons.push('the charge window activation is not reported, so automatic charging cannot be confirmed');
          if (preconditioning.status !== 'scheduled') reasons.push(preconditioning.detail);
          const definiteNo = chargeReadiness === 'short-window'
            || chargeReadiness === 'window-inactive'
            || preconditioning.status === 'inactive'
            || preconditioning.status === 'not-scheduled'
            || preconditioning.status === 'none-configured';
          const unknown = !definiteNo
            && (chargeReadiness === 'activation-unknown'
              || preconditioning.status === 'unknown'
              || preconditioning.status === 'one-shot-unconfirmed');
          const verdict: 'yes' | 'no' | 'unknown' = definiteNo ? 'no' : unknown ? 'unknown' : 'yes';

          const departureLocal = localReading(departureMs, shape.offsetMinutes);
          const deadlineLocal = localReading(deadlineMs, shape.offsetMinutes);
          const offsetText = formatUtcOffset(shape.offsetMinutes) ?? 'UTC';
          const windowStateText = window.activated === true ? 'active' : window.activated === false ? 'defined but inactive' : 'activation not reported';
          const windowText = `${String(shape.startHour).padStart(2, '0')}:00 → ${String(shape.endHour).padStart(2, '0')}:00 (${offsetText}) (${windowStateText})`;
          const verdictLine = verdict === 'yes'
            ? `Yes: the car can be charged to ${reportedTarget}% by ${departureLocal.time} ${offsetText} and is scheduled to precondition.`
            : verdict === 'no'
              ? `No: ${reasons.join('; ')}.`
              : `Unknown: ${reasons.join('; ')}.`;
          const advice = [
            'This server is read-only and cannot start charging or climate; act in the Polestar app.',
            ...(chargeReadiness === 'short-window' ? ['To be charged in time, start earlier, lower the target, or extend the charge window.'] : []),
            ...(chargeReadiness === 'window-inactive' ? ['Activate the charge window in the app.'] : []),
            ...(chargeReadiness === 'activation-unknown' ? ['Check that the charge window is active in the app.'] : []),
            ...(preconditioning.status === 'inactive' ? ['Activate the parking climate timer in the app.'] : []),
            ...(preconditioning.status === 'not-scheduled' || preconditioning.status === 'none-configured'
              ? ['Set a parking climate timer for the departure if the car should be preconditioned.']
              : []),
            ...(preconditioning.status === 'one-shot-unconfirmed' ? ['Confirm the one-shot climate timer in the app; this API carries no date for it.'] : []),
            ...(preconditioning.status === 'unknown' ? ['The car does not report a parking climate timer, so preconditioning cannot be arranged from here.'] : []),
          ];
          const lines = [
            `Departure readiness, ${found.vehicle.label}`,
            `• Departure: ${new Date(departureMs).toISOString()} (${departureLocal.time} ${offsetText}); source: ${departureSource}.`,
            `• Charge window: ${windowText}.`,
            `• Latest charge deadline: ${deadlineLocal.time} ${offsetText} (the last window close at or before departure).`,
            `• Energy needed: ${energyNeededKwh.toFixed(1)} kWh at the battery to reach ${reportedTarget}% (now ${soc}%).`,
            `• Charging time needed: ${durationText(Math.round(requiredHours * 60))} at ${powerKw.toFixed(1)} kW.`,
            `• Window time before the deadline: ${durationText(windowHours * 60)} (${windowHours} complete hour(s)).`,
            `• Preconditioning: ${preconditioning.detail}.`,
            `• Verdict: ${verdictLine}`,
            `Read-only advice: ${advice.join(' ')}`,
          ];
          return withData(lines.join('\n'), {
            refused: false,
            ready: verdict === 'yes' ? true : verdict === 'no' ? false : null,
            verdict,
            departureAt: new Date(departureMs).toISOString(),
            departureSource,
            deadlineAt: new Date(deadlineMs).toISOString(),
            chargeWindow: {
              activated: window.activated ?? null,
              startHour: shape.startHour,
              stopHour: shape.endHour,
              offsetMinutes: shape.offsetMinutes,
              fullDay: shape.fullDay,
            },
            preconditioning: { status: preconditioning.status, detail: preconditioning.detail },
            chargeReadiness,
            energyNeededKwh: roundTo(energyNeededKwh, 3),
            minutesNeeded: Math.round(requiredHours * 60),
            windowMinutesAvailable: windowHours * 60,
            powerKw: roundTo(powerKw, 3),
            targetPct: reportedTarget,
            socPct: soc,
            capacityKwh: roundTo(capacityKwh, 3),
            capacitySource: model.capacitySource ?? null,
            reasons,
            advice,
          }, { vin });
        } catch (err) {
          return errorResult(err);
        }
      },
    },
  ];
}
