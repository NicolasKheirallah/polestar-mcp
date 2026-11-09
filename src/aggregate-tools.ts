import { z } from 'zod';
import {
  activeWarnings,
  distance,
  formatAge,
  humanizeEnum,
  km,
  maskVin,
  observedAtMs,
  pct,
  summarizeDomain,
} from './format.js';
import {
  ampLimitA,
  availabilityView,
  batteryView,
  chargeWindow,
  exteriorView,
  healthView,
  odometerMeters,
  pendingAmpLimitA,
  targetSoc,
} from './domain-data.js';
import { chargeModel } from './charge-model.js';
import { delegatedAccountArg, errorResult, vinArg, withData, type ToolData, type ToolDeps, type VinArgs } from './tool-output.js';
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

/** Seconds of staleness for one payload, when the payload carries a clock. */
function ageSecondsOf(data: Record<string, unknown> | null, nowMs: number): number | undefined {
  if (data === null) return undefined;
  const observed = observedAtMs(data);
  return observed === undefined ? undefined : Math.max(0, Math.round((nowMs - observed) / 1000));
}

/** The age a setting line prints, or an explicit unknown rather than "fresh". */
const observationText = (data: Record<string, unknown>, nowMs: number): string => {
  const observed = observedAtMs(data);
  return observed === undefined ? 'freshness unknown' : formatAge(observed, nowMs);
};

/**
 * The seven charging settings get_charging_setup reads together. `charge-locations`
 * and `charge-now` are metadata-only over M2M, and `is-at-charge-location` answers
 * DATA_NOT_AVAILABLE on the reference car, so naming them is the value they carry.
 */
const CHARGING_SETTINGS_READS = {
  'amp-limit': { kind: 'charging', name: 'amp-limit' },
  'target-soc': { kind: 'charging', name: 'target-soc' },
  'global-charge-timer': { kind: 'charging', name: 'global-charge-timer' },
  'parking-climate-timer': { kind: 'charging', name: 'parking-climate-timer' },
  'charge-locations': { kind: 'charging', name: 'charge-locations' },
  'charge-now': { kind: 'charging', name: 'charge-now' },
  'is-at-charge-location': { kind: 'charging', name: 'is-at-charge-location' },
} as const;

const asRecordValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** One clock entry of the parking-climate-timer payload. */
export interface ClimateTimerEntry {
  activated?: boolean | undefined;
  hour?: number | undefined;
  weekdays: string[];
  repeat?: boolean | undefined;
  offsetMinutes?: number | undefined;
}

/**
 * The parking climate timers as typed values. Shape-tolerant on purpose: the
 * humanizer once threw on a non-array `parkingClimateTimers`, and this reader
 * must answer [] rather than take a whole aggregate down.
 *
 * Exported because get_departure_readiness reads the same list; the seven-setting
 * aggregate is the tool that owns the charging-setting payload shapes.
 */
export function climateTimerEntries(data: Record<string, unknown> | null | undefined): ClimateTimerEntry[] {
  const timers = asRecordValue(data)?.parkingClimateTimers;
  if (!Array.isArray(timers)) return [];
  const entries: ClimateTimerEntry[] = [];
  for (const item of timers) {
    const record = asRecordValue(item);
    if (record === undefined) continue;
    const readyAt = asRecordValue(record.readyAt);
    const zone = asRecordValue(readyAt?.timeZone);
    const hour = typeof readyAt?.hour === 'number' && Number.isFinite(readyAt.hour) ? readyAt.hour : undefined;
    const offsetMinutes = typeof zone?.offsetMinutes === 'number' && Number.isFinite(zone.offsetMinutes) ? zone.offsetMinutes : undefined;
    const weekdays = Array.isArray(record.weekdays)
      ? record.weekdays.filter((day): day is string => typeof day === 'string')
      : [];
    entries.push({
      ...(hour !== undefined ? { hour } : {}),
      ...(offsetMinutes !== undefined ? { offsetMinutes } : {}),
      ...(typeof record.activated === 'boolean' ? { activated: record.activated } : {}),
      ...(typeof record.repeat === 'boolean' ? { repeat: record.repeat } : {}),
      weekdays,
    });
  }
  return entries;
}

/** The typed values of one charging setting, for the structured `data` payload. */
function chargingSettingData(name: string, data: Record<string, unknown>, nowMs: number): ToolData {
  const ageSeconds = ageSecondsOf(data, nowMs);
  const out: ToolData = { reported: true, ...(ageSeconds !== undefined ? { ageSeconds } : {}) };
  if (name === 'amp-limit') {
    out.ampLimitA = ampLimitA(data) ?? null;
    out.pendingAmpLimitA = pendingAmpLimitA(data) ?? null;
  } else if (name === 'target-soc') {
    const target = targetSoc(data);
    out.targetPct = target.levelPct ?? null;
    out.settingType = target.settingType ?? null;
  } else if (name === 'global-charge-timer') {
    const window = chargeWindow(data);
    out.window = window === undefined
      ? null
      : {
          activated: window.activated ?? null,
          startHour: window.startHour ?? null,
          stopHour: window.stopHour ?? null,
          offsetMinutes: window.offsetMinutes ?? null,
        };
  } else if (name === 'parking-climate-timer') {
    out.timers = climateTimerEntries(data);
  } else if (name === 'charge-locations') {
    out.note = 'Over M2M this is a settings record; no charge-location list is returned.';
  } else if (name === 'charge-now') {
    out.note = 'Over M2M this carries only the last sync timestamp; not an active or inactive state.';
  } else if (name === 'is-at-charge-location') {
    out.atChargeLocation = data.isAtChargeLocation ?? null;
  }
  return out;
}

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
        const data: ToolData = {};
        if (battery) {
          const seen = batteryView(battery);
          lines.push(
            `• Battery: ${pct(seen.chargeLevelPct)} · ${distance(seen.distanceToEmptyKm, deps.units)} range · ${humanizeEnum(seen.status)} · ${humanizeEnum(seen.connection)}`,
          );
          data.battery = {
            chargePct: seen.chargeLevelPct ?? null,
            rangeKm: seen.distanceToEmptyKm ?? null,
            chargingStatus: humanizeEnum(seen.status),
            connection: humanizeEnum(seen.connection),
            timeToFullMinutes: seen.timeToFullMinutes ?? null,
          };
        }
        if (exterior) {
          const seen = exteriorView(exterior);
          const lock = seen.lockState === 'locked' ? 'locked' : seen.lockState === 'unlocked' ? 'not fully locked' : 'lock state not reported';
          lines.push(`• Exterior: ${seen.open.length === 0 ? 'everything closed' : `${seen.open.length} item(s) open`} · ${lock} · alarm ${humanizeEnum(seen.alarm).toLowerCase()}`);
          data.exterior = {
            openItems: seen.open,
            lockState: seen.lockState,
            alarmState: seen.alarmState,
            alarm: humanizeEnum(seen.alarm),
          };
        }
        if (availability) {
          const seen = availabilityView(availability);
          lines.push(`• Car is ${humanizeEnum(seen.status).toLowerCase()} (${humanizeEnum(seen.usageMode)})`);
          data.availability = { status: humanizeEnum(seen.status), usageMode: humanizeEnum(seen.usageMode) };
        }
        if (odometer) {
          lines.push(`• Odometer: ${km(odometerMeters(odometer), deps.units)}`);
          data.odometerMeters = odometerMeters(odometer) ?? null;
        }
        if (health) {
          const seen = healthView(health);
          const warnings = activeWarnings(health);
          lines.push(`• Service: in ${seen.daysToService ?? 'n/a'} days / ${distance(seen.distanceToServiceKm, deps.units)} · ${warnings.length === 0 ? 'no warnings' : `warnings: ${warnings.join(', ')}`}`);
          data.health = {
            daysToService: seen.daysToService ?? null,
            distanceToServiceKm: seen.distanceToServiceKm ?? null,
            warnings,
          };
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
          data.charging = {
            targetPct: reportedTarget ?? null,
            targetReported: reportedTarget !== undefined,
            energyNeededKwh: model.energyNeededKwh ?? null,
            gridEnergyKwh: model.gridEnergyKwh ?? null,
            capacityKwh: model.capacityKwh ?? null,
            capacitySource: model.capacitySource ?? null,
            efficiency: model.efficiency,
            carTimeToFullMinutes: eta ?? null,
            problems: model.problems,
          };
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
        data.agesSeconds = Object.fromEntries(
          ages.map((entry) => [entry.name, Math.max(0, Math.round((nowMs - entry.observed) / 1000))]),
        );
        data.unreported = unreported;
        return withData(lines.join('\n'), data, { vin: maskVin(found.vehicle.vin, deps.redactVin) });
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

        const secureData = (secure: boolean | null): ToolData => ({
          secure,
          lockState: seen.lockState,
          centralLock: humanizeEnum(seen.centralLock),
          tailgateLock: humanizeEnum(seen.tailgateLock),
          alarmState: seen.alarmState,
          alarm: humanizeEnum(seen.alarm),
          openSecurityRelevant: open,
          unknownLocks: seen.unknownLocks,
          unlockedLocks: seen.unlockedLocks,
        });
        const vin = maskVin(found.vehicle.vin, deps.redactVin);
        if (knownProblems.length > 0) {
          const unknownSuffix = unknown.length > 0 ? ` Also unknown: ${unknown.join('; ')}.` : '';
          return withData(`No, car is not secure: ${knownProblems.join('; ')}.${unknownSuffix}`, secureData(false), { vin });
        }
        if (unknown.length > 0) {
          return withData(
            `Unknown, not reported: ${unknown.join('; ')}. What is known: ${open.length === 0 ? 'all doors, windows, hood and tailgate closed' : `open ${open.join(', ')}`}. The answer is not a no.`,
            secureData(null),
            { vin },
          );
        }
        return withData(`Yes, car is secure (locked, all closed). Alarm: ${humanizeEnum(seen.alarm).toLowerCase()}.`, secureData(true), { vin });
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
        return withData(
          lines.join('\n'),
          {
            warnings,
            daysToService: seen.daysToService ?? null,
            distanceToServiceKm: seen.distanceToServiceKm ?? null,
          },
          { vin: maskVin(found.vehicle.vin, deps.redactVin) },
        );
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
        const estimateData: ToolData = {
          socPct: seen.chargeLevelPct ?? null,
          targetPct,
          targetAssumed: reportedTarget === undefined,
        };
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
        Object.assign(estimateData, {
          energyNeededKwh: model.energyNeededKwh ?? null,
          gridEnergyKwh: model.gridEnergyKwh ?? null,
          capacityKwh: model.capacityKwh ?? null,
          capacitySource: model.capacitySource ?? null,
          powerKw: model.powerKw ?? null,
          minutesToTarget: model.energyNeededKwh !== undefined && model.powerKw !== undefined
            ? Math.round((model.energyNeededKwh / model.powerKw) * 60)
            : null,
          carTimeToFullMinutes: eta ?? null,
          assumptions: allAssumptions,
          missing: model.missing,
          problems: model.problems,
        });
        return withData(lines.join('\n'), estimateData, { vin: maskVin(found.vehicle.vin, deps.redactVin) });
      } catch (err) {
        return errorResult(err);
      }
    },
  },

  {
    name: 'get_charging_setup',
    title: 'Get charging setup',
    description:
        'One cached call over the seven charging settings: AC amp limit, target charge level, global charge window, parking climate timers, saved charge locations, charge-now override, and whether the car is at a saved charge location. Each reported setting carries its data age; an is-at-charge-location DATA_NOT_AVAILABLE is reported as unsupported on this vehicle (normal), and any other unreported setting is named rather than omitted.',
    args: { ...vinArg, ...delegatedAccountArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args: VinArgs, ctx) => {
      try {
        const found = await vehicleFor(deps, ctx, args ?? {}, 'pick-vehicle-charging-setup');
        if (!found.ok) return found.result;
        const payloads = await readDomains(found.vehicle, CHARGING_SETTINGS_READS);
        const nowMs = deps.nowMs?.() ?? Date.now();
        const names = Object.keys(CHARGING_SETTINGS_READS) as (keyof typeof CHARGING_SETTINGS_READS)[];

        const lines: string[] = [`Charging setup, ${found.vehicle.label}`];
        const settings: ToolData = {};
        const unreported: string[] = [];
        const unsupported: string[] = [];
        for (const name of names) {
          const data = payloads[name];
          if (data === null) {
            if (name === 'is-at-charge-location') {
              unsupported.push(name);
              lines.push(`• ${name}: unsupported on this vehicle (the API returned DATA_NOT_AVAILABLE); this is not a failure, the car just does not report at-charge-location state`);
              settings[name] = { supported: false, reported: false, note: 'DATA_NOT_AVAILABLE; unsupported on this vehicle, not a failure' };
            } else {
              unreported.push(name);
              lines.push(`• ${name}: not reported (the API returned DATA_NOT_AVAILABLE)`);
              settings[name] = { reported: false };
            }
            continue;
          }
          let summary: string[];
          try {
            summary = summarizeDomain(name, data, deps.units) ?? [];
          } catch {
            // One malformed payload shape must not take the whole setup answer
            // down; the typed readers below stay tolerant, and the per-domain
            // tool remains the raw view.
            summary = ['summary unavailable for this payload shape; read the raw payload from the per-domain tool'];
          }
          lines.push(`• ${name} (${observationText(data, nowMs)}): ${summary.join(' / ')}`);
          settings[name] = chargingSettingData(name, data, nowMs);
        }
        if (unsupported.length > 0) {
          lines.push(`Unsupported here (not a failure): ${unsupported.join(', ')}.`);
        }
        if (unreported.length > 0) {
          lines.push(`Not reported: ${unreported.join(', ')} (absence is not a negative).`);
        }
        const oldest = names
          .flatMap((name) => {
            const data = payloads[name];
            if (data === null) return [];
            const observed = observedAtMs(data);
            return observed === undefined ? [] : [{ name, observed }];
          })
          .reduce<{ name: string; observed: number } | undefined>(
            (current, entry) => (current === undefined || entry.observed < current.observed ? entry : current),
            undefined,
          );
        if (oldest !== undefined) lines.push(`Oldest setting: ${oldest.name} (${formatAge(oldest.observed, nowMs)}).`);

        return withData(lines.join('\n'), {
          settings,
          unsupported,
          unreported,
          ...(oldest !== undefined ? { oldestSetting: oldest.name } : {}),
        }, { vin: maskVin(found.vehicle.vin, deps.redactVin) });
      } catch (err) {
        return errorResult(err);
      }
    },
  },
  ];
}
