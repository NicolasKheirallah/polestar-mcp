import { z } from 'zod';
import { planCheapestCharge, type PriceSlot } from './planner.js';
import { ampLimitA, batteryView, chargeWindow, targetSoc } from './domain-data.js';
import { chargeModel } from './charge-model.js';
import { delegatedAccountArg, errorResult, text, vinArg, type ToolContext, type ToolDeps, type ToolResult } from './tool-output.js';
import { noData, readDomains, vehicleFor } from './vehicle-read.js';
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

          if (model.problems.length > 0) {
            return text(`Cannot plan: ${model.problems.join('; ')}.`);
          }
          if (typeof soc !== 'number' || typeof targetPct !== 'number') {
            return text('Missing required data (battery SoC or target SoC), cannot plan.');
          }
          if (window?.startHour === undefined || window.stopHour === undefined) {
            return text(
              'No charge window is configured on the car (global-charge-timer is unset). Set one in the Polestar app first, or ask the user for a window.',
            );
          }
          const powerKw = model.powerKw;
          if (powerKw === undefined) {
            return text(`Cannot plan: ${model.missing.join('; ')}.`);
          }
          const capacityKwh = model.capacityKwh;
          if (capacityKwh === undefined) {
            return text(
              'Pack capacity is unknown: the car reports neither dischargeInfo.energyAvailable nor estimatedDistanceToEmptyKm with averageEnergyConsumptionKwhPer100Km, and no capacityKwh argument was given. Pass capacityKwh explicitly, e.g. 78 for a long range dual motor.',
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
          return text(lines.join('\n'));
        } catch (err) {
          return errorResult(err);
        }
      },
    },
  ];
}
