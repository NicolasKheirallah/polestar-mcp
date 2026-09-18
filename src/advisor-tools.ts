import { z } from 'zod';
import { planCheapestCharge, type PriceSlot } from './planner.js';
import { ampLimitA, chargeLevelPct, chargeWindow, chargingPowerWatts, chargingVoltageVolts, energyAvailableKwh, targetSoc } from './domain-data.js';
import { ASSUMED_LINE_VOLTS, chargeModel } from './charge-model.js';
import { errorResult, text, vinArg, type ToolContext, type ToolDeps, type ToolResult } from './tool-output.js';
import type { ToolSpec } from './tools.js';

const planArgs = {
  ...vinArg,
  prices: z
    .array(z.object({ startsAt: z.string(), price: z.number() }))
    .describe('Hourly prices from your spot-price provider: [{startsAt: "2026-09-19T22:00:00+02:00", price: 0.42}, ...]'),
  phases: z.number().int().min(1).max(3).optional().describe('AC phases at your charger (default 3, Swedish 400V three-phase).'),
  capacityKwh: z
    .number()
    .positive()
    .optional()
    .describe('Usable pack capacity; auto-derived from dischargeInfo.energyAvailable when the car reports it.'),
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
 * a price curve the caller supplies, and computes the cheapest contiguous
 * hours that reach the target. No writes, no external fetches: prices arrive
 * as an argument so the LLM can paste them from any tariff source.
 */
export function advisorToolSpecs(deps: ToolDeps): ToolSpec[] {
  return [
    {
      name: 'plan_cheapest_charge',
      title: 'Plan the cheapest charge',
      description:
        'Given hourly electricity prices, computes the cheapest hours inside the car\'s charge window (from global-charge-timer) that deliver enough energy to reach the target charge level.',
      args: planArgs,
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (args: PlanArgs, _ctx: ToolContext): Promise<ToolResult> => {
        try {
          const vin = await deps.client.resolveVin(args.vin);
          const phases = args.phases ?? 3;
          const [battery, target, amp, timer] = await Promise.all([
            deps.client.domain(vin, 'telemetry', 'battery'),
            deps.client.domain(vin, 'charging', 'target-soc'),
            deps.client.domain(vin, 'charging', 'amp-limit'),
            deps.client.domain(vin, 'charging', 'global-charge-timer'),
          ]);

          const window = chargeWindow(timer);
          const model = chargeModel({
            socPct: chargeLevelPct(battery),
            targetPct: targetSoc(target).levelPct,
            ampLimitA: ampLimitA(amp),
            reportedVolts: chargingVoltageVolts(battery),
            livePowerW: chargingPowerWatts(battery),
            energyAvailableKwh: energyAvailableKwh(battery),
            phases,
          });
          const soc = chargeLevelPct(battery);
          const targetPct = targetSoc(target).levelPct;
          const amps = ampLimitA(amp);

          if (typeof soc !== 'number' || typeof targetPct !== 'number' || amps === undefined) {
            return text('Missing required data (battery SoC, target SoC, or amp limit), cannot plan.');
          }
          if (window?.startHour === undefined || window.stopHour === undefined) {
            return text(
              'No charge window is configured on the car (global-charge-timer is unset). Set one in the Polestar app first, or ask the user for a window.',
            );
          }

          // Power and capacity come from the same model get_charging_estimate
          // uses, so the two tools cannot disagree about one car.
          const powerKw = model.powerKw ?? (amps * ASSUMED_LINE_VOLTS * phases) / 1000;
          const capacityKwh = args.capacityKwh ?? model.capacityKwh;
          if (capacityKwh === undefined) {
            return text(
              'Pack capacity is unknown (the car did not report dischargeInfo.energyAvailable and no capacityKwh argument was given). Pass capacityKwh explicitly, e.g. 78 for a long range dual motor.',
            );
          }

          const plan = planCheapestCharge({
            prices: (args.prices ?? []) as PriceSlot[],
            socPct: soc,
            targetPct,
            capacityKwh,
            powerKw,
            windowStartHour: window.startHour,
            windowEndHour: window.stopHour,
            windowOffsetMinutes: window.offsetMinutes ?? 0,
            ...(deps.nowMs !== undefined ? { nowMs: deps.nowMs() } : {}),
          });

          const lines = [
            `Charge plan (${window.activated === true ? 'car window active' : 'note: the car window is defined but INACTIVE on the car'})`,
            `Need: ${plan.energyNeededKwh} kWh to go ${soc}% → ${targetPct}% ≈ ${plan.hoursNeeded}h at ${powerKw.toFixed(1)} kW`,
            '',
          ];
          if (!plan.feasible) {
            lines.push(`Not feasible: ${plan.reason}`);
          } else if (plan.steps.length === 0) {
            lines.push('Nothing to do, target already reached.');
          } else {
            for (const step of plan.steps) {
              lines.push(
                `• ${step.startsAt} → ${step.endsAt}${step.price !== undefined ? ` @ ${step.price}` : ' (price unknown)'}: ${step.energyKwh.toFixed(1)} kWh`,
              );
            }
            if (plan.totalCost !== undefined) lines.push(`Estimated cost: ${plan.totalCost}`);
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
