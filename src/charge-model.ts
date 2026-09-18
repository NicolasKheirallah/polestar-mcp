/**
 * One model of "what will it take to charge this car".
 *
 * `get_charging_estimate` used the voltage the car reported and fell back to
 * 230 V with the assumption stated; `plan_cheapest_charge` hard-coded 230 V and
 * ignored the reported voltage. Same car, same minute, two kilowatt figures 
 * and the plan an agent acts on was built from the coarser one. Both now derive
 * power, capacity and energy from here, so the assumption is one decision.
 */

export const ASSUMED_LINE_VOLTS = 230;

export interface ChargeModelInput {
  /** Current state of charge, percent. */
  socPct?: number | undefined;
  /** Target state of charge, percent. */
  targetPct?: number | undefined;
  /** Configured AC current limit, amps. */
  ampLimitA?: number | undefined;
  /** Line voltage the car reports, when this domain reports one. */
  reportedVolts?: number | undefined;
  /** Live charging power in watts, when the car is charging right now. */
  livePowerW?: number | undefined;
  /** Usable energy the car says remains, kWh. */
  energyAvailableKwh?: number | undefined;
  /** AC phase count at the charger. */
  phases: number;
}

export interface ChargeModel {
  /** kW available for the calculation, from live power or from amps × volts × phases. */
  powerKw?: number | undefined;
  /** Full-pack usable capacity implied by the reported energy at the current SoC. */
  capacityKwh?: number | undefined;
  /** kWh needed to reach the target, when both SoC values and a capacity are known. */
  energyNeededKwh?: number | undefined;
  /** Every simplification the numbers rest on, in the caller's voice. */
  assumptions: string[];
  /** True when power and capacity are both known, i.e. exact maths is possible. */
  exact: boolean;
}

export function chargeModel(input: ChargeModelInput): ChargeModel {
  const assumptions: string[] = [];
  let powerKw: number | undefined;

  if (input.livePowerW !== undefined && input.livePowerW > 0) {
    powerKw = input.livePowerW / 1000;
    assumptions.push(`using live charging power ${powerKw.toFixed(1)} kW`);
  } else if (input.ampLimitA !== undefined) {
    const usesReported = input.reportedVolts !== undefined && input.reportedVolts > 0;
    const volts = usesReported ? input.reportedVolts! : ASSUMED_LINE_VOLTS;
    powerKw = (input.ampLimitA * volts * input.phases) / 1000;
    assumptions.push(
      usesReported
        ? `power estimated from ${input.ampLimitA} A × ${volts} V (reported) × ${input.phases} phase(s)`
        : `power estimated from ${input.ampLimitA} A × ${ASSUMED_LINE_VOLTS} V assumed × ${input.phases} phase(s); the car reports no charging voltage`,
    );
  }

  let capacityKwh: number | undefined;
  if (
    input.energyAvailableKwh !== undefined
    && input.energyAvailableKwh > 0
    && input.socPct !== undefined
    && input.socPct > 0
  ) {
    capacityKwh = (input.energyAvailableKwh / input.socPct) * 100;
    assumptions.push(`capacity ${capacityKwh.toFixed(1)} kWh derived from dischargeInfo.energyAvailable at ${input.socPct}%`);
  }

  let energyNeededKwh: number | undefined;
  if (capacityKwh !== undefined && input.socPct !== undefined && input.targetPct !== undefined) {
    energyNeededKwh = Math.max(0, (capacityKwh * (input.targetPct - input.socPct)) / 100);
  }

  return {
    ...(powerKw !== undefined ? { powerKw } : {}),
    ...(capacityKwh !== undefined ? { capacityKwh } : {}),
    ...(energyNeededKwh !== undefined ? { energyNeededKwh } : {}),
    assumptions,
    exact: powerKw !== undefined && capacityKwh !== undefined,
  };
}
