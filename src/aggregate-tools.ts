import { z } from 'zod';
import { activeWarnings, distance, formatAge, humanizeEnum, km, observedAtMs, pct, vinLabel } from './format.js';
import { ampLimitA, chargeLevelPct, chargingPowerWatts, chargingVoltageVolts, energyAvailableKwh, targetSoc, timeToFullMinutes } from './domain-data.js';
import { chargeModel } from './charge-model.js';
import { errorResult, text, vinArg, type ToolDeps, type VinArgs } from './tool-output.js';
import type { ToolSpec } from './tools.js';

/** get_charging_estimate adds the AC phase count to the plain Vehicle argument. */
type EstimateArgs = VinArgs & { phases?: number };

/**
 * Aggregate tools: the questions people actually ask ("how is the car?",
 * "is everything locked?", "when will it be charged?") answered in one call
 * over data the per-domain tools already serve, through the cache, so an
 * aggregate costs at most one live call per constituent domain and usually
 * zero.
 */

export function aggregateToolSpecs(deps: ToolDeps): ToolSpec[] {
  return [
  {
    name: 'get_car_status',
    title: 'Get full car status',
    description:
        'One-call status of the car: charge level and state, range, lock/doors, availability, odometer, service countdown, and data age for each. Costs several domain reads (cached); use instead of calling five get_* tools.',
    args: { ...vinArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: VinArgs) => {
      try {
        const vin = await deps.client.resolveVin(args?.vin);
        const [battery, exterior, availability, odometer, health] = await Promise.all([
          deps.client.domain(vin, 'telemetry', 'battery'),
          deps.client.domain(vin, 'telemetry', 'exterior'),
          deps.client.domain(vin, 'telemetry', 'availability'),
          deps.client.domain(vin, 'telemetry', 'odometer'),
          deps.client.domain(vin, 'telemetry', 'health'),
        ]);
        const label = vinLabel(vin, deps.redactVin, deps.vehicleLabels);
        const nowMs = deps.nowMs?.() ?? Date.now();

        const lines: string[] = [`Car status, ${label}`];

        if (battery) {
          lines.push(
            `• Battery: ${pct(battery.batteryChargeLevelPercentage as number | undefined)} · ${distance(battery.estimatedDistanceToEmptyKm as number | undefined, deps.units)} range · ${humanizeEnum(battery.chargingStatusV2 ?? battery.chargingStatus)} · ${humanizeEnum(battery.chargerConnectionStatus)}`,
          );
        }
        if (exterior) {
          const open = Object.entries(exterior).filter(([, v]) => v === 'OPEN_STATUS_OPEN').length;
          lines.push(`• Exterior: ${open === 0 ? 'everything closed' : `${open} item(s) open`} · ${humanizeEnum(exterior.centralLock)} · alarm ${humanizeEnum(exterior.alarm).toLowerCase()}`);
        }
        if (availability) {
          lines.push(`• Car is ${humanizeEnum(availability.availabilityStatus).toLowerCase()} (${humanizeEnum(availability.usageMode)})`);
        }
        if (odometer) {
          lines.push(`• Odometer: ${km(Number(odometer.odometerMeters), deps.units)}`);
        }
        if (health) {
          const warnings = activeWarnings(health);
          lines.push(`• Service: in ${health.daysToService ?? 'n/a'} days / ${distance(health.distanceToServiceKm as number | undefined, deps.units)} · ${warnings.length === 0 ? 'no warnings' : `warnings: ${warnings.join(', ')}`}`);
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
    args: { ...vinArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: VinArgs) => {
      try {
        const vin = await deps.client.resolveVin(args?.vin);
        const exterior = await deps.client.domain(vin, 'telemetry', 'exterior');
        if (exterior === null) return text(`No exterior data available for ${vinLabel(vin, deps.redactVin, deps.vehicleLabels)}.`);
        const open = Object.entries(exterior)
          .filter(([key, value]) => value === 'OPEN_STATUS_OPEN' && key !== 'tankLid')
          .map(([key]) => key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
        const locked = exterior.centralLock === 'LOCK_STATUS_LOCKED' && exterior.tailgateLock === 'LOCK_STATUS_LOCKED';
        const summary = [
          locked && open.length === 0
            ? `Yes, car is secure (locked, all closed). Alarm: ${humanizeEnum(exterior.alarm).toLowerCase()}.`
            : `No, ${[open.length > 0 ? `open: ${open.join(', ')}` : null, !locked ? 'not fully locked' : null].filter(Boolean).join('; ')}.`,
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
    args: { ...vinArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: EstimateArgs) => {
      try {
        const vin = await deps.client.resolveVin(args?.vin);
        const health = await deps.client.domain(vin, 'telemetry', 'health');
        if (health === null) return text(`No health data available for ${vinLabel(vin, deps.redactVin, deps.vehicleLabels)}.`);
        const warnings = activeWarnings(health);
        const lines = [
          warnings.length === 0
            ? 'Nothing needs attention, all health checks report OK.'
            : `Needs attention: ${warnings.join(', ')}`,
          `Next service in ${health.daysToService ?? 'n/a'} days or ${distance(health.distanceToServiceKm as number | undefined, deps.units)} (whichever first).`,
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
    args: { ...vinArg, phases: z.number().int().min(1).max(3).optional().describe('AC phases at your charger (default 3).') },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: EstimateArgs) => {
      try {
        const vin = await deps.client.resolveVin(args?.vin);
        const phases = args?.phases ?? 3;
        const [battery, target, amp] = await Promise.all([
          deps.client.domain(vin, 'telemetry', 'battery'),
          deps.client.domain(vin, 'charging', 'target-soc'),
          deps.client.domain(vin, 'charging', 'amp-limit'),
        ]);
        if (battery === null) return text('No battery data available, cannot estimate.');

        const model = chargeModel({
          socPct: chargeLevelPct(battery),
          targetPct: targetSoc(target).levelPct ?? 80,
          ampLimitA: ampLimitA(amp),
          reportedVolts: chargingVoltageVolts(battery),
          livePowerW: chargingPowerWatts(battery),
          energyAvailableKwh: energyAvailableKwh(battery),
          phases,
        });
        const soc = chargeLevelPct(battery);
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
        const eta = timeToFullMinutes(battery);
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
