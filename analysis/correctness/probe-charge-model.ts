/**
 * Probe: three-phase power model in src/charge-model.ts and the estimate tool.
 *
 * The fallback assumes 230 V per phase and multiplies by the phase count
 * (3 x 230 V, correct for 3 x 16 A = 11.0 kW). When the car reports 400 V it takes
 * that as the voltage and *still* multiplies by the phase count, giving
 * 3 x 400 x 16 = 19.2 kW. A 3-phase 400 V supply at 16 A delivers
 * sqrt(3) x 400 x 16 = 11.1 kW, so the two paths disagree by a factor of 1.73
 * about what "volts" means. test/charge-model.test.ts pins 19.2 kW as correct.
 */
import { ASSUMED_LINE_VOLTS, chargeModel } from '../../src/charge-model.js';
import { aggregateToolSpecs } from '../../src/aggregate-tools.js';
import { toolSpec } from '../../src/tools.js';
import type { PolestarClient } from '../../src/client.js';
import type { ToolDeps } from '../../src/tool-output.js';

const out: Record<string, unknown> = {};

const assumed = chargeModel({ socPct: 40, targetPct: 80, ampLimitA: 16, phases: 3 });
const reported400 = chargeModel({ socPct: 40, targetPct: 80, ampLimitA: 16, reportedVolts: 400, phases: 3 });
const physical3ph400 = (Math.sqrt(3) * 400 * 16) / 1000;
const physical3ph230 = (230 * 3 * 16) / 1000;

out.model = {
  assumed_230V_x_3phases_kW: assumed.powerKw,
  reported_400V_x_3phases_kW: reported400.powerKw,
  physical_3x16A_at_400V_line_to_line_kW: Math.round(physical3ph400 * 1000) / 1000,
  physical_3x16A_at_230V_per_phase_kW: Math.round(physical3ph230 * 1000) / 1000,
  assumedLineVolts: ASSUMED_LINE_VOLTS,
  ratio_400V_path_vs_physical: Math.round((reported400.powerKw! / physical3ph400) * 100) / 100,
};

// What the tool prints for the repo's own test payload (battery reports 400 V, 40% SoC).
const PAYLOADS: Record<string, Record<string, unknown>> = {
  'telemetry/battery': {
    batteryChargeLevelPercentage: 40,
    chargingVoltageVolts: 400,
    dischargeInfo: { energyAvailable: 31.2 },
  },
  'charging/target-soc': { targetSoc: { batteryChargeTargetLevel: 80 } },
  'charging/amp-limit': { ampLimit: { ampLimit: 16 } },
};
const client = {
  async resolveVin(v?: string) {
    return v ?? 'YSMTEST22PL000001';
  },
  async vehicles() {
    return ['YSMTEST22PL000001'];
  },
  async domain(_vin: string, kind: string, name: string) {
    return PAYLOADS[`${kind}/${name}`] ?? null;
  },
} as unknown as PolestarClient;
const deps: ToolDeps = { client, redactVin: false, vehicleLabels: {}, delegatedAccounts: [], units: 'km' };
const estimate = await toolSpec(aggregateToolSpecs(deps), 'get_charging_estimate').run({}, {});
out.get_charging_estimate_text = estimate.content[0]!.text;

console.log(JSON.stringify(out, null, 2));
