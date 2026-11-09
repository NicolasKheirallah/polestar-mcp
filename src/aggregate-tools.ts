import { z } from 'zod';
import { activeWarnings, distance, formatAge, humanizeEnum, km, observedAtMs, pct } from './format.js';
import { ampLimitA, availabilityView, batteryView, exteriorView, healthView, odometerMeters, targetSoc } from './domain-data.js';
import { chargeModel } from './charge-model.js';
import { delegatedAccountArg, errorResult, text, vinArg, type ToolDeps, type VinArgs } from './tool-output.js';
import { noData, readDomains, unknownData, vehicleFor, type DomainTarget } from './vehicle-read.js';
import type { ToolSpec } from './tools.js';

/** get_charging_estimate adds the AC phase count and an optional capacity to the plain Vehicle argument. */
type EstimateArgs = VinArgs & { phases?: number; capacityKwh?: number };

/** The charging Domains the estimator reads together, named the way its body uses them. */
const CHARGING_READS = {
  battery: { kind: 'telemetry', name: 'battery' },
  target: { kind: 'charging', name: 'target-soc' },
  amp: { kind: 'charging', name: 'amp-limit' },
} as const;

/**
 * The status briefing's constituent Domains. `target-soc` joins the five
 * telemetry domains because "is it plugged in and charged to what" needs it.
 */
const STATUS_READS = {
  battery: { kind: 'telemetry', name: 'battery' },
  exterior: { kind: 'telemetry', name: 'exterior' },
  availability: { kind: 'telemetry', name: 'availability' },
  odometer: { kind: 'telemetry', name: 'odometer' },
  health: { kind: 'telemetry', name: 'health' },
  target: { kind: 'charging', name: 'target-soc' },
} as const;

const STATUS_DOMAINS: readonly DomainTarget[] = Object.values(STATUS_READS);

const EXTERIOR_DOMAIN: DomainTarget = { kind: 'telemetry', name: 'exterior' };
const HEALTH_DOMAIN: DomainTarget = { kind: 'telemetry', name: 'health' };

const minutesToHours = (minutes: number): string => `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

/**
 * Aggregate tools: the questions people actually ask ("how is the car?",
 * "is everything locked?", "when will it be charged?") answered in one call
 * over data the per-domain tools already serve, through the cache, so an
 * aggregate costs at most one live call per constituent domain and usually
 * zero.
 *
 * Absence is disclosed, never answered from. An aggregate names every
 * constituent Domain that did not report, prints each reported Domain's age,
 * marks the oldest, and starts a verdict with "Unknown" when the fields the
 * verdict rests on are unreported.
 */
export function aggregateToolSpecs(deps: ToolDeps): ToolSpec[] {
  return [
  {
    name: 'get_car_status',
    title: 'Get full car status',
    description:
        'One-call status of the car: charge level and charging state, target charge level, energy and the car\'s own time to full, range, lock/doors, availability, odometer, service countdown, plus the data age of each Domain and every Domain the car did not report. Costs several domain reads (cached); use instead of calling the get_* tools one by one.',
    args: { ...vinArg, ...delegatedAccountArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: VinArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-status');
        if (!found.ok) return found.result;
        const { battery, exterior, availability, odometer, health, target } = await readDomains(found.vehicle, STATUS_READS);
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
          const lock = seen.lockState === 'locked' ? 'locked' : seen.lockState === 'unlocked' ? 'not fully locked' : 'lock state not reported';
          lines.push(`• Exterior: ${seen.open.length === 0 ? 'everything closed' : `${seen.open.length} item(s) open`} · ${lock} · alarm ${humanizeEnum(seen.alarm).toLowerCase()}`);
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

        // The charging answer: plugged or not, what level the car is set to, and
        // how much energy that means. Each line names its source, and an assumed
        // or derived figure says so.
        if (battery) {
          const seen = batteryView(battery);
          lines.push(`• Charging state: ${humanizeEnum(seen.connection)} · ${humanizeEnum(seen.status)} (telemetry/battery)`);
          const reportedTarget = targetSoc(target).levelPct;
          if (reportedTarget !== undefined) {
            lines.push(`• Target charge level: ${reportedTarget}% (charging/target-soc)`);
          } else {
            lines.push('• Target charge level: not reported by charging/target-soc');
          }
          const model = chargeModel({
            socPct: seen.chargeLevelPct,
            targetPct: reportedTarget,
            reportedVolts: seen.volts,
            livePowerW: seen.powerWatts,
            energyAvailableKwh: seen.energyAvailableKwh,
            distanceToEmptyKm: seen.distanceToEmptyKm,
            consumptionKwhPer100Km: seen.consumptionKwhPer100Km,
            phases: 3,
          });
          if (model.problems.length > 0) {
            lines.push(`• Energy to target: cannot compute (${model.problems.join('; ')})`);
          } else if (model.energyNeededKwh !== undefined && model.gridEnergyKwh !== undefined) {
            lines.push(
              `• Energy to target: ${model.energyNeededKwh.toFixed(1)} kWh at the battery, ${model.gridEnergyKwh.toFixed(1)} kWh from the grid (capacity ${model.capacityKwh?.toFixed(1)} kWh ${model.capacitySource}; ${(model.efficiency * 100).toFixed(0)}% AC efficiency)`,
            );
          } else {
            lines.push(`• Energy to target: cannot compute. Missing: ${model.missingEnergy.join('; ')}`);
          }
          const eta = seen.timeToFullMinutes;
          if (eta !== undefined && eta > 0) {
            lines.push(`• Car's own time to full: ~${minutesToHours(eta)} (the car's estimate; its reference level is not stated)`);
          } else {
            lines.push("• Car's own time to full: not reported by the car");
          }
        }

        const reportedDomains = [
          ['battery', battery],
          ['exterior', exterior],
          ['availability', availability],
          ['odometer', odometer],
          ['health', health],
          ['target-soc', target],
        ] as const;
        const unreported = reportedDomains.filter(([, data]) => data === null).map(([name]) => name);
        const ages = reportedDomains
          .flatMap(([name, data]) => {
            if (data === null) return [];
            const observed = observedAtMs(data);
            return observed === undefined ? [] : [{ name, observed, age: formatAge(observed, nowMs) }];
          });
        if (ages.length > 0) {
          lines.push(`Domain ages: ${ages.map((entry) => `${entry.name} ${entry.age}`).join('; ')}.`);
          const oldest = ages.reduce((oldestEntry, entry) => (entry.observed < oldestEntry.observed ? entry : oldestEntry));
          lines.push(`Oldest: ${oldest.name} (${oldest.age}).`);
        }
        if (unreported.length === reportedDomains.length) {
          return unknownData(found.vehicle, STATUS_DOMAINS, 'Without a single one of these readings nothing about the car can be answered, so this is unknown rather than a clean or a failing car.');
        }
        if (unreported.length > 0) {
          lines.push(`Not reported: ${unreported.join(', ')} (the API returned DATA_NOT_AVAILABLE; absence is not a negative).`);
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
    description: 'Security check over the exterior Domain: are all doors, windows, hood and tailgate closed, the central and tailgate locks engaged, and the alarm not triggered? A triggered alarm or an open door answers No. A lock or alarm the car does not report is unknown, not unlocked, and the answer says so.',
    args: { ...vinArg, ...delegatedAccountArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: VinArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-secure');
        if (!found.ok) return found.result;
        const { exterior } = await readDomains(found.vehicle, { exterior: EXTERIOR_DOMAIN });
        if (exterior === null) {
          return unknownData(found.vehicle, [EXTERIOR_DOMAIN], 'Without the exterior state the locks and alarm cannot be checked, so the car is neither reported secure nor reported insecure.');
        }

        const seen = exteriorView(exterior);
        const open = seen.openSecurityRelevant;
        const knownProblems: string[] = [];
        if (seen.lockState === 'unlocked') knownProblems.push(`not fully locked (${seen.unlockedLocks.join(', ')})`);
        if (open.length > 0) knownProblems.push(`open: ${open.join(', ')}`);
        if (seen.alarmState === 'triggered') knownProblems.push(`alarm ${humanizeEnum(seen.alarm).toLowerCase()}`);
        const unknown: string[] = [];
        if (seen.lockState === 'unknown') unknown.push(`${seen.unknownLocks.join(' and ')} not reported`);
        if (seen.alarmState === 'unknown') unknown.push('alarm state not reported');

        if (knownProblems.length > 0) {
          const unknownSuffix = unknown.length > 0 ? ` Also unknown: ${unknown.join('; ')}.` : '';
          return text(`No, car is not secure: ${knownProblems.join('; ')}.${unknownSuffix}`);
        }
        if (unknown.length > 0) {
          return text(
            `Unknown, not reported: ${unknown.join('; ')}. What is known: ${open.length === 0 ? 'all doors, windows, hood and tailgate closed' : `open ${open.join(', ')}`}. The answer is not a no.`,
          );
        }
        return text(`Yes, car is secure (locked, all closed). Alarm: ${humanizeEnum(seen.alarm).toLowerCase()}.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_needs_attention',
    title: 'Health warnings needing attention',
    description: 'Only the active warnings from the health Domain (fluids, lights, 12V, service) plus the service countdown. An empty warning list means nothing reported a warning. If the car does not report health, the answer is unknown rather than "nothing needs attention".',
    args: { ...vinArg, ...delegatedAccountArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: VinArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-attention');
        if (!found.ok) return found.result;
        const { health } = await readDomains(found.vehicle, { health: HEALTH_DOMAIN });
        if (health === null) {
          return unknownData(found.vehicle, [HEALTH_DOMAIN], 'The car reports no health data, so there is nothing to call clear or to call attention.');
        }

        const seen = healthView(health);
        const warnings = activeWarnings(health);
        const lines = [
          warnings.length === 0
            ? 'Nothing needs attention: the health Domain is reported and carries no active warning.'
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
        'Estimates the energy and time needed to reach the target charge level from the current SoC. Capacity comes from the car\'s usable energy, else range times average consumption, else the capacityKwh argument; grid energy and time use the amp limit and an assumed 90% AC efficiency, with every assumption stated. When the car reports its own time to full it is shown, labelled as the car\'s estimate, only when a figure follows.',
    args: {
      ...vinArg,
      ...delegatedAccountArg,
      phases: z.number().int().min(1).max(3).optional().describe('AC phases at your charger (default 3). A voltage the car reports is treated as line-to-line.'),
      capacityKwh: z.number().positive().optional().describe('Usable pack capacity; used only when the car reports neither dischargeInfo.energyAvailable nor a range with average consumption.'),
    },
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
        const reportedTarget = targetSoc(target).levelPct;
        const assumptions: string[] = [];
        if (reportedTarget === undefined) {
          assumptions.push('the car does not report a target charge level, so 80 percent was assumed');
        }
        const targetPct = reportedTarget ?? 80;
        const model = chargeModel({
          socPct: seen.chargeLevelPct,
          targetPct,
          ampLimitA: ampLimitA(amp),
          reportedVolts: seen.volts,
          livePowerW: seen.powerWatts,
          energyAvailableKwh: seen.energyAvailableKwh,
          distanceToEmptyKm: seen.distanceToEmptyKm,
          consumptionKwhPer100Km: seen.consumptionKwhPer100Km,
          suppliedCapacityKwh: args?.capacityKwh,
          phases,
        });

        const lines: string[] = [];
        const eta = seen.timeToFullMinutes;
        const hasCarEstimate = eta !== undefined && eta > 0;
        if (model.problems.length > 0) {
          lines.push(`Cannot compute an estimate: ${model.problems.join('; ')}.`);
        } else if (model.energyNeededKwh !== undefined && model.gridEnergyKwh !== undefined && seen.chargeLevelPct !== undefined) {
          lines.push(
            `Energy to ${targetPct}%: ${model.energyNeededKwh.toFixed(1)} kWh at the battery, ${model.gridEnergyKwh.toFixed(1)} kWh from the grid at ${(model.efficiency * 100).toFixed(0)}% AC efficiency (now ${seen.chargeLevelPct}%).`,
          );
          if (model.capacityKwh !== undefined) {
            lines.push(`Capacity: ${model.capacityKwh.toFixed(1)} kWh (${model.capacitySource}).`);
          }
          if (model.powerKw !== undefined) {
            lines.push(`Time at ${model.powerKw.toFixed(1)} kW: ~${minutesToHours(Math.round((model.energyNeededKwh / model.powerKw) * 60))}.`);
          } else {
            lines.push('Time: not computed; the car reports no charging power or amp limit.');
          }
        } else if (hasCarEstimate) {
          lines.push(
            `Energy to the target cannot be computed from what the car reports. Missing: ${model.missingEnergy.join('; ')}. Showing the car's own estimate to full instead: ~${minutesToHours(eta!)}.`,
          );
        } else {
          lines.push(
            `Energy to the target cannot be computed from what the car reports. Missing: ${model.missingEnergy.join('; ')}. The car does not report its own time to full either (estimatedChargingTimeToFullMinutes is absent or 0).`,
          );
        }
        if (
          hasCarEstimate
          && model.energyNeededKwh !== undefined
        ) {
          lines.push(`Car's own estimate to full: ~${minutesToHours(eta!)} (the car's estimate; its reference level is not stated, so it is not labelled as a target figure).`);
        }
        const allAssumptions = [...assumptions, ...model.assumptions];
        lines.push(`Assumptions: ${allAssumptions.length > 0 ? allAssumptions.join('; ') : 'none needed'}.`);
        return text(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  },
  ];
}
