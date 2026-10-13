import { z } from 'zod';
import { activeWarnings, distance, formatAge, humanizeEnum, km, observedAtMs, pct } from './format.js';
import { ampLimitA, availabilityView, batteryView, exteriorView, healthView, odometerMeters, targetSoc } from './domain-data.js';
import { chargeModel } from './charge-model.js';
import { delegatedAccountArg, errorResult, text, vinArg, type ToolDeps, type VinArgs } from './tool-output.js';
import { noData, readDomains, vehicleFor } from './vehicle-read.js';
import type { ToolSpec } from './tools.js';

/** get_charging_estimate adds the AC phase count to the plain Vehicle argument. */
type EstimateArgs = VinArgs & { phases?: number };

/** The four charging Domains these tools read together, named the way each body uses them. */
const CHARGING_READS = {
  battery: { kind: 'telemetry', name: 'battery' },
  target: { kind: 'charging', name: 'target-soc' },
  amp: { kind: 'charging', name: 'amp-limit' },
} as const;

/**
 * Aggregate tools: the questions people actually ask ("how is the car?",
 * "is everything locked?", "when will it be charged?") answered in one call
 * over data the per-domain tools already serve, through the cache, so an
 * aggregate costs at most one live call per constituent domain and usually
 * zero.
 *
 * Every body here is now only its own prose. Which Vehicle, under which
 * delegation, read through which client, with what to say when a car reports
 * nothing: those were four steps copied into each tool, and one of them
 * (delegation) was missing from all four.
 */

export function aggregateToolSpecs(deps: ToolDeps): ToolSpec[] {
  return [
  {
    name: 'get_car_status',
    title: 'Get full car status',
    description:
        'One-call status of the car: charge level and state, range, lock/doors, availability, odometer, service countdown, and data age for each. Costs several domain reads (cached); use instead of calling five get_* tools.',
    args: { ...vinArg, ...delegatedAccountArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: VinArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-status');
        if (!found.ok) return found.result;
        const { battery, exterior, availability, odometer, health } = await readDomains(found.vehicle, {
          battery: { kind: 'telemetry', name: 'battery' },
          exterior: { kind: 'telemetry', name: 'exterior' },
          availability: { kind: 'telemetry', name: 'availability' },
          odometer: { kind: 'telemetry', name: 'odometer' },
          health: { kind: 'telemetry', name: 'health' },
        });
        const nowMs = deps.nowMs?.() ?? Date.now();

        const lines: string[] = [`Car status, ${found.vehicle.label}`];
        if (battery) {
          const seen = batteryView(battery);
          lines.push(
            `• Battery: ${pct(seen.chargeLevelPct)} · ${distance(seen.distanceToEmptyKm, deps.units)} range · ${humanizeEnum(seen.status)} · ${humanizeEnum(seen.connection)}`,
          );
        }
        if (exterior) {
          const seen = exteriorView(exterior);
          lines.push(`• Exterior: ${seen.open.length === 0 ? 'everything closed' : `${seen.open.length} item(s) open`} · ${humanizeEnum(seen.centralLock)} · alarm ${humanizeEnum(seen.alarm).toLowerCase()}`);
        }
        if (availability) {
          const seen = availabilityView(availability);
          lines.push(`• Car is ${humanizeEnum(seen.status).toLowerCase()} (${humanizeEnum(seen.usageMode)})`);
        }
        if (odometer) {
          lines.push(`• Odometer: ${km(odometerMeters(odometer), deps.units)}`);
        }
        if (health) {
          const seen = healthView(health);
          const warnings = activeWarnings(health);
          lines.push(`• Service: in ${seen.daysToService ?? 'n/a'} days / ${distance(seen.distanceToServiceKm, deps.units)} · ${warnings.length === 0 ? 'no warnings' : `warnings: ${warnings.join(', ')}`}`);
        }
        if (lines.length === 1) {
          return noData(found.vehicle, { kind: 'telemetry', name: 'battery' }, 'Not one of the five domains answered, so there is nothing to summarize.');
        }

        const ages = [battery, exterior, availability, odometer, health]
          .filter((d): d is Record<string, unknown> => d !== null)
          .map((d) => observedAtMs(d))
          .filter((t): t is number => t !== undefined);
        if (ages.length > 0) {
          lines.push(`Data as of ${formatAge(Math.max(...ages), nowMs)} (newest domain).`);
        }
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'is_car_secure',
    title: 'Is the car closed and locked',
    description: 'True/false security check: are all doors, windows, hood and tailgate closed, central lock engaged, alarm OK? Names anything open.',
    args: { ...vinArg, ...delegatedAccountArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: VinArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-secure');
        if (!found.ok) return found.result;
        const { exterior } = await readDomains(found.vehicle, { exterior: { kind: 'telemetry', name: 'exterior' } });
        if (exterior === null) return noData(found.vehicle, { kind: 'telemetry', name: 'exterior' });

        const seen = exteriorView(exterior);
        const open = seen.openSecurityRelevant;
        const summary = [
          seen.locked && open.length === 0
            ? `Yes, car is secure (locked, all closed). Alarm: ${humanizeEnum(seen.alarm).toLowerCase()}.`
            : `No, ${[open.length > 0 ? `open: ${open.join(', ')}` : null, !seen.locked ? 'not fully locked' : null].filter(Boolean).join('; ')}.`,
        ];
        return text(summary.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_needs_attention',
    title: 'Health warnings needing attention',
    description: 'Only the active warnings from the health domain (fluids, lights, 12V, service) plus the service countdown. Empty means nothing needs attention.',
    args: { ...vinArg, ...delegatedAccountArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: VinArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-attention');
        if (!found.ok) return found.result;
        const { health } = await readDomains(found.vehicle, { health: { kind: 'telemetry', name: 'health' } });
        if (health === null) return noData(found.vehicle, { kind: 'telemetry', name: 'health' });

        const seen = healthView(health);
        const warnings = activeWarnings(health);
        const lines = [
          warnings.length === 0
            ? 'Nothing needs attention, all health checks report OK.'
            : `Needs attention: ${warnings.join(', ')}`,
          `Next service in ${seen.daysToService ?? 'n/a'} days or ${distance(seen.distanceToServiceKm, deps.units)} (whichever first).`,
        ];
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_charging_estimate',
    title: 'Charging time and energy estimate',
    description:
        'Estimates the energy and time needed to reach the target charge level from the current SoC, using the reported usable energy (dischargeInfo.energyAvailable) when available, the configured amp limit for power, and the car\'s own time-to-full when charging.',
    args: { ...vinArg, ...delegatedAccountArg, phases: z.number().int().min(1).max(3).optional().describe('AC phases at your charger (default 3).') },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: EstimateArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-estimate');
        if (!found.ok) return found.result;
        const { battery, target, amp } = await readDomains(found.vehicle, CHARGING_READS);
        if (battery === null) {
          return noData(found.vehicle, CHARGING_READS.battery, 'Without the charge level there is nothing to estimate from.');
        }

        const phases = args?.phases ?? 3;
        const seen = batteryView(battery);
        const model = chargeModel({
          socPct: seen.chargeLevelPct,
          targetPct: targetSoc(target).levelPct ?? 80,
          ampLimitA: ampLimitA(amp),
          reportedVolts: seen.volts,
          livePowerW: seen.powerWatts,
          energyAvailableKwh: seen.energyAvailableKwh,
          phases,
        });
        const soc = seen.chargeLevelPct;
        const targetPct = targetSoc(target).levelPct ?? 80;

        const lines: string[] = [];
        if (model.energyNeededKwh !== undefined && soc !== undefined && model.capacityKwh !== undefined) {
          lines.push(`Energy to ${targetPct}%: ${model.energyNeededKwh.toFixed(1)} kWh (now ${soc}%).`);
          if (model.powerKw !== undefined && model.energyNeededKwh > 0) {
            const minutes = Math.round((model.energyNeededKwh / model.powerKw) * 60);
            lines.push(`Time at ${model.powerKw.toFixed(1)} kW: ~${Math.floor(minutes / 60)}h ${minutes % 60}m.`);
          }
        } else {
          lines.push(`Usable-energy data not reported; showing the car's own estimate instead.`);
        }
        const eta = seen.timeToFullMinutes;
        if (eta !== undefined && eta > 0) lines.push(`Car's own estimate to 100%: ~${Math.floor(eta / 60)}h ${eta % 60}m.`);
        lines.push(`Assumptions: ${model.assumptions.length > 0 ? model.assumptions.join('; ') : 'none needed'}.`);
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },
  ];
}
