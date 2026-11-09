/**
 * One model of "what will it take to charge this car".
 *
 * `get_charging_estimate` used the voltage the car reported and fell back to
 * 230 V with the assumption stated; `plan_cheapest_charge` hard-coded 230 V and
 * ignored the reported voltage. Same car, same minute, two kilowatt figures
 * and the plan an agent acts on was built from the coarser one. Both now derive
 * power, capacity and energy from here, so the assumption is one decision.
 *
 * Two conventions are decisions, not inferences:
 *
 * - A reported charging voltage is treated as line-to-line (a three-phase
 *   supply is named by its line voltage, 400 V in Europe). The per-phase voltage
 *   is therefore `reported / sqrt(3)` and 16 A on three phases is
 *   `sqrt(3) x 400 x 16 = 11.1 kW`, not `3 x 400 x 16 = 19.2 kW`. When the car
 *   reports no voltage the fallback 230 V is a line-to-neutral figure, which is
 *   why it is multiplied by the phase count.
 * - Pack capacity falls back in one order: the usable energy the car reports,
 *   then range times average consumption, then a capacity the caller supplied.
 *   Each source is named in the assumptions, and no source outside a plausible
 *   usable-capacity range is presented as arithmetic.
 */

/** Line-to-neutral voltage assumed when the car reports none: 16 A on 3 phases draws 11.0 kW. */
export const ASSUMED_LINE_VOLTS = 230;

/** Wall-to-battery efficiency assumed for grid energy and cost. */
export const DEFAULT_AC_EFFICIENCY = 0.9;

/** Usable pack capacities outside this range are implausible for a passenger EV. */
export const CAPACITY_MIN_KWH = 10;
export const CAPACITY_MAX_KWH = 300;

export type CapacitySource =
  | 'dischargeInfo.energyAvailable'
  | 'estimatedDistanceToEmptyKm and averageEnergyConsumptionKwhPer100Km'
  | 'caller-supplied capacity';

export interface ChargeModelInput {
  /** Current state of charge, percent. */
  socPct?: number | undefined;
  /** Target state of charge, percent. */
  targetPct?: number | undefined;
  /** Configured AC current limit, amps. */
  ampLimitA?: number | undefined;
  /** Line voltage the car reports, when this domain reports one. Treated as line-to-line. */
  reportedVolts?: number | undefined;
  /** Live charging power in watts, when the car is charging right now. */
  livePowerW?: number | undefined;
  /** Usable energy the car says remains, kWh. */
  energyAvailableKwh?: number | undefined;
  /** Range to empty, kilometres, for the capacity fallback. */
  distanceToEmptyKm?: number | undefined;
  /** Average consumption, kWh per 100 km, for the capacity fallback. */
  consumptionKwhPer100Km?: number | undefined;
  /** Usable capacity the caller passed, used only when the car reports neither energy nor range. */
  suppliedCapacityKwh?: number | undefined;
  /** AC phase count at the charger, 1 to 3. */
  phases: number;
  /** Wall-to-battery efficiency, a fraction above 0 and at most 1. Defaults to 0.9. */
  efficiency?: number | undefined;
}

export interface ChargeModel {
  /** kW available for the calculation, from live power or from amps and voltage. */
  powerKw?: number | undefined;
  /** Full-pack usable capacity, from the fallback chain. */
  capacityKwh?: number | undefined;
  /** Which link of the capacity chain answered. */
  capacitySource?: CapacitySource | undefined;
  /** kWh needed at the battery to reach the target. */
  energyNeededKwh?: number | undefined;
  /** kWh drawn from the grid for that battery energy, at the stated efficiency. */
  gridEnergyKwh?: number | undefined;
  efficiency: number;
  /** Every simplification the numbers rest on, in the caller's voice. */
  assumptions: string[];
  /** Named inputs that prevent a figure, e.g. no capacity and no range. */
  missing: string[];
  /** The subset of `missing` that prevents the energy-to-target figure. */
  missingEnergy: string[];
  /** Inputs that are invalid, contradictory or implausible; no answer is presented from them. */
  problems: string[];
  /** True when power and capacity are both known, i.e. exact maths is possible. */
  exact: boolean;
}

const isFiniteAbove = (value: number | undefined, floor: number): value is number =>
  value !== undefined && Number.isFinite(value) && value > floor;

const plausibleCapacity = (kWh: number): boolean => kWh >= CAPACITY_MIN_KWH && kWh <= CAPACITY_MAX_KWH;

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Per-phase volts from a reported voltage. A reported figure is line-to-line,
 * so a three-phase phase voltage is `line / sqrt(3)`; a single-phase load across
 * the reported pair gets the full line voltage.
 */
const phaseVolts = (reportedVolts: number, phases: number): number =>
  phases === 1 ? reportedVolts : reportedVolts / Math.sqrt(3);

export function chargeModel(input: ChargeModelInput): ChargeModel {
  const assumptions: string[] = [];
  const problems: string[] = [];
  const efficiency = input.efficiency ?? DEFAULT_AC_EFFICIENCY;

  if (!(Number.isFinite(efficiency) && efficiency > 0 && efficiency <= 1)) {
    problems.push(`AC efficiency ${efficiency} is not a fraction above 0 and at most 1`);
  }
  const phasesValid = Number.isInteger(input.phases) && input.phases >= 1 && input.phases <= 3;
  if (!phasesValid) {
    problems.push(`phase count ${input.phases} is not 1, 2 or 3`);
  }
  if (input.socPct !== undefined && !(input.socPct >= 0 && input.socPct <= 100)) {
    problems.push(`state of charge ${input.socPct}% is outside 0 to 100`);
  }
  if (input.targetPct !== undefined && !(input.targetPct >= 0 && input.targetPct <= 100)) {
    problems.push(`target charge level ${input.targetPct}% is outside 0 to 100`);
  }
  if (
    input.socPct !== undefined
    && input.targetPct !== undefined
    && input.targetPct < input.socPct
    && input.targetPct >= 0
    && input.targetPct <= 100
    && input.socPct >= 0
    && input.socPct <= 100
  ) {
    assumptions.push(`target ${input.targetPct}% is below the current ${input.socPct}%; there is no energy to add`);
  }

  let powerKw: number | undefined;
  if (isFiniteAbove(input.livePowerW, 0)) {
    powerKw = input.livePowerW / 1000;
    assumptions.push(`using the live charging power ${powerKw.toFixed(1)} kW the car reports`);
  } else if (isFiniteAbove(input.ampLimitA, 0)) {
    if (phasesValid) {
      const reportedVolts = isFiniteAbove(input.reportedVolts, 0) ? input.reportedVolts : undefined;
      const perPhase = reportedVolts !== undefined ? phaseVolts(reportedVolts, input.phases) : ASSUMED_LINE_VOLTS;
      powerKw = (input.ampLimitA * perPhase * input.phases) / 1000;
      assumptions.push(
        reportedVolts !== undefined
          ? `power ${powerKw.toFixed(1)} kW estimated from ${input.ampLimitA} A on ${input.phases} phase(s); the reported ${reportedVolts} V is treated as line-to-line, so ${perPhase.toFixed(0)} V per phase (the three-phase convention)`
          : `power ${powerKw.toFixed(1)} kW estimated from ${input.ampLimitA} A x ${ASSUMED_LINE_VOLTS} V assumed per phase x ${input.phases} phase(s); the car reports no charging voltage`,
      );
    }
  } else if (input.ampLimitA !== undefined) {
    problems.push(`amp limit ${input.ampLimitA} A is not positive`);
  }

  let capacityKwh: number | undefined;
  let capacitySource: CapacitySource | undefined;
  if (isFiniteAbove(input.energyAvailableKwh, 0) && isFiniteAbove(input.socPct, 0)) {
    const derived = (input.energyAvailableKwh / input.socPct) * 100;
    if (plausibleCapacity(derived)) {
      capacityKwh = derived;
      capacitySource = 'dischargeInfo.energyAvailable';
      assumptions.push(
        `capacity ${derived.toFixed(1)} kWh derived from dischargeInfo.energyAvailable (${input.energyAvailableKwh} kWh at ${input.socPct}% SoC)`,
      );
    } else {
      problems.push(
        `usable-energy ${input.energyAvailableKwh} kWh at ${input.socPct}% SoC implies a ${derived.toFixed(1)} kWh pack, outside the ${CAPACITY_MIN_KWH} to ${CAPACITY_MAX_KWH} kWh plausibility range`,
      );
    }
  }
  if (
    capacityKwh === undefined
    && isFiniteAbove(input.distanceToEmptyKm, 0)
    && isFiniteAbove(input.consumptionKwhPer100Km, 0)
    && isFiniteAbove(input.socPct, 0)
  ) {
    const derived = (input.distanceToEmptyKm * input.consumptionKwhPer100Km) / input.socPct;
    if (plausibleCapacity(derived)) {
      capacityKwh = derived;
      capacitySource = 'estimatedDistanceToEmptyKm and averageEnergyConsumptionKwhPer100Km';
      assumptions.push(
        `capacity ${derived.toFixed(1)} kWh derived from ${input.distanceToEmptyKm} km range and ${input.consumptionKwhPer100Km} kWh/100 km at ${input.socPct}% SoC`,
      );
    } else {
      problems.push(
        `range and consumption imply a ${derived.toFixed(1)} kWh pack, outside the ${CAPACITY_MIN_KWH} to ${CAPACITY_MAX_KWH} kWh plausibility range`,
      );
    }
  }
  if (capacityKwh === undefined && input.suppliedCapacityKwh !== undefined) {
    if (isFiniteAbove(input.suppliedCapacityKwh, 0) && plausibleCapacity(input.suppliedCapacityKwh)) {
      capacityKwh = input.suppliedCapacityKwh;
      capacitySource = 'caller-supplied capacity';
      assumptions.push(`capacity ${input.suppliedCapacityKwh} kWh supplied by the caller`);
    } else {
      problems.push(
        `caller-supplied capacity ${input.suppliedCapacityKwh} kWh is outside the ${CAPACITY_MIN_KWH} to ${CAPACITY_MAX_KWH} kWh plausibility range`,
      );
    }
  }

  let energyNeededKwh: number | undefined;
  let gridEnergyKwh: number | undefined;
  if (capacityKwh !== undefined && input.socPct !== undefined && input.targetPct !== undefined) {
    energyNeededKwh = Math.max(0, (capacityKwh * (input.targetPct - input.socPct)) / 100);
    if (Number.isFinite(efficiency) && efficiency > 0) {
      gridEnergyKwh = energyNeededKwh / efficiency;
      assumptions.push(`grid energy assumes ${(efficiency * 100).toFixed(0)}% AC efficiency (battery energy / efficiency)`);
    }
  }

  const missingEnergy: string[] = [];
  if (input.socPct === undefined) missingEnergy.push('current state of charge (batteryChargeLevelPercentage)');
  if (capacityKwh === undefined) {
    missingEnergy.push(
      'usable pack capacity (dischargeInfo.energyAvailable, or estimatedDistanceToEmptyKm with averageEnergyConsumptionKwhPer100Km, or a capacityKwh argument)',
    );
  }
  if (input.targetPct === undefined) missingEnergy.push('target charge level (batteryChargeTargetLevel on charging/target-soc)');
  const missing = [...missingEnergy];
  if (powerKw === undefined) missing.push('charging power (live chargingPowerWatts or the amp limit on charging/amp-limit)');

  const model: ChargeModel = {
    efficiency,
    assumptions,
    missing,
    missingEnergy,
    problems,
    exact: powerKw !== undefined && capacityKwh !== undefined && problems.length === 0,
  };
  if (powerKw !== undefined) model.powerKw = powerKw;
  if (capacityKwh !== undefined) model.capacityKwh = capacityKwh;
  if (capacitySource !== undefined) model.capacitySource = capacitySource;
  if (energyNeededKwh !== undefined) model.energyNeededKwh = round(energyNeededKwh, 3);
  if (gridEnergyKwh !== undefined) model.gridEnergyKwh = round(gridEnergyKwh, 3);
  return model;
}
