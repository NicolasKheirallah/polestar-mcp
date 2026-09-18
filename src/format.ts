import {
  ampLimitA,
  pendingAmpLimitA,
  chargeLevelPct,
  chargeWindow,
  distanceToEmptyKm,
  epochSecondsMs,
  numberField,
  odometerMeters,
  position,
  targetSoc,
  timeToFullMinutes,
} from './domain-data.js';

/**
 * The humanizer: turns raw domain payloads into short prose an LLM (or a
 * human) can read at a glance, enum labels, sane units, data age. Raw
 * payloads stay available via each tool's `raw` argument; the summaries
 * exist so agents stop re-deriving "CHARGING_STATUS_V2_IDLE means idle"
 * on every call.
 */

export function humanizeEnum(value: unknown): string {
  if (typeof value !== 'string') return String(value ?? 'n/a');
  if (value === 'NO_WARNING' || value.endsWith('_NO_WARNING')) return 'OK';
  if (value.endsWith('_UNSPECIFIED')) return 'Off';
  const stripped = value
    .replace(/^CHARGING_STATUS_V2_/, '')
    .replace(/^CHARGING_STATUS_/, '')
    .replace(/^CHARGER_CONNECTION_STATUS_/, '')
    .replace(/^CHARGER_POWER_STATUS_/, '')
    .replace(/^CHARGING_TYPE_/, '')
    .replace(/^OPEN_STATUS_/, '')
    .replace(/^LOCK_STATUS_/, '')
    .replace(/^ALARM_STATUS_/, '')
    .replace(/^AVAILABILITY_STATUS_/, '')
    .replace(/^USAGE_MODE_/, '')
    .replace(/^RUNNING_STATUS_/, '')
    .replace(/^HEATING_INTENSITY_/, '')
    .replace(/^VENTILATION_/, '')
    .replace(/^SERVICE_WARNING_/, '')
    .replace(/^EXTERIOR_LIGHT_WARNING_/, '');
  const titled = stripped
    .toLowerCase()
    .split('_')
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
  const overrides: Record<string, string> = {
    'Abandoned': 'Asleep / not in use',
    'Idle': 'Idle',
    'Charging': 'Charging',
    'Done': 'Charge complete',
    'Disconnected': 'Unplugged',
    'Connected': 'Plugged in',
    'No Power Available': 'No power at charger',
  };
  return overrides[titled] ?? titled;
}

/** How far a value is allowed to travel: the operator's stated preference. */
export type Units = 'km' | 'mi';

/**
 * Kilometres, with miles in parentheses when the operator prefers mi. The unit is a
 * required argument:
 * it used to be a process-wide setting with a parameter default shadowing it,
 * and half the rendering sites silently printed kilometres under `mi`.
 */
export function distance(kmValue: number | undefined, units: Units): string {
  if (kmValue === undefined) return 'n/a';
  return units === 'mi' ? `${Math.round(kmValue)} km (${Math.round(kmValue * 0.621371)} mi)` : `${kmValue} km`;
}

/**
 * A distance the API only gives in kilometres. Rendered in the operator's unit
 * alone: showing a converted value twice, `2873 km (1785 mi)`, next to an odometer
 * reading that shows one, is two conventions inside one summary.
 */
export function fromKm(kmValue: number | undefined, units: Units): string {
  if (kmValue === undefined) return 'n/a';
  return units === 'mi'
    ? `${Math.round(kmValue * 0.621371).toLocaleString('en-US')} mi`
    : `${kmValue.toLocaleString('en-US', { maximumFractionDigits: 0 })} km`;
}

export function km(meters: number | undefined, units: Units): string {
  if (meters === undefined) return 'n/a';
  const kilometres = meters / 1000;
  return units === 'mi'
    ? `${Math.round(kilometres * 0.621371).toLocaleString('en-US')} mi`
    : `${kilometres.toLocaleString('en-US', { maximumFractionDigits: 0 })} km`;
}

export function pct(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${value}%`;
}

export function formatAge(observedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - observedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Observation time of a domain payload, epoch ms. Owned by the reader module. */
export { observedAtMs } from './domain-data.js';

/** The owner's word for a VIN, when they supplied one. */
function labelFor(vin: string, labels: Record<string, string>): string | undefined {
  return labels[vin.toUpperCase()];
}

/**
 * The one masking rule behind POLESTAR_REDACT_VIN.
 * Used to be retyped at three call sites with two different shapes of mask.
 */
export function maskVin(vin: string, redact: boolean): string {
  return redact ? `${vin.slice(0, 3)}…${vin.slice(-3)}` : vin;
}

export function vinLabel(vin: string, redact: boolean, labels?: Record<string, string>): string {
  const label = labels !== undefined ? labelFor(vin, labels) : undefined;
  if (label !== undefined) return label;
  return maskVin(vin, redact);
}

// Both are live: domain tool summaries and subscribed resources render through
// summarizeDomain, and the aggregate tools read activeWarnings.

/**
 * Humanized per-domain summary lines. Returns `null` when the Domain has no
 * summarizer. Units arrive as an argument rather than as process state, so a
 * caller cannot render one line in miles and the next in kilometres.
 */
export function summarizeDomain(name: string, data: Record<string, unknown>, units: Units): string[] | null {
  switch (name) {
    case 'battery': {
      const lines = [
        `Charge: ${pct(chargeLevelPct(data))} · range ${distance(distanceToEmptyKm(data), units)}`,
        `Charging: ${humanizeEnum(data.chargingStatusV2 ?? data.chargingStatus)} · ${humanizeEnum(data.chargerConnectionStatus)}`,
      ];
      const power = data.chargingPowerWatts;
      if (typeof power === 'number' && power > 0) {
        lines.push(
          `Charge power: ${(power / 1000).toFixed(1)} kW (${data.chargingVoltageVolts ?? 'n/a'} V / ${data.chargingCurrentAmps ?? 'n/a'} A)`,
        );
      }
      const eta = timeToFullMinutes(data);
      if (eta !== undefined && eta > 0) lines.push(`Time to full: ~${eta} min`);
      const consumption = data.averageEnergyConsumptionKwhPer100Km;
      if (typeof consumption === 'number') lines.push(`Average consumption: ${consumption} kWh/100km`);
      return lines;
    }
    case 'odometer':
      return [
        `Odometer: ${km(odometerMeters(data), units)}`,
        `Trip meters: ${fromKm(numberField(data, 'tripMeterManualKm'), units)} manual · ${fromKm(numberField(data, 'tripMeterAutomaticKm'), units)} automatic`,
      ];
    case 'location': {
      const coordinate = position(data);
      if (coordinate === undefined || coordinate.latitude === undefined) return ['Position unknown'];
      return [
        `Position: ${coordinate.latitude.toFixed(5)}, ${coordinate.longitude?.toFixed(5) ?? 'n/a'} (heading ${coordinate.heading ?? ''}°, ${coordinate.speedKmh ?? 0} km/h)`,
        `Map: https://www.google.com/maps?q=${coordinate.latitude},${coordinate.longitude}`,
      ];
    }
    case 'exterior': {
      const openItems = openEntries(data);
      const lock = humanizeEnum(data.centralLock);
      const alarm = humanizeEnum(data.alarm);
      return [
        openItems.length === 0
          ? `All doors, windows, hood and tailgate closed · ${lock} · alarm ${alarm.toLowerCase()}`
          : `Open: ${openItems.join(', ')} · ${lock} · alarm ${alarm.toLowerCase()}`,
      ];
    }
    case 'health': {
      const warnings = activeWarnings(data);
      const lines = [
        `Service in ${data.daysToService ?? 'n/a'} days / ${distance(data.distanceToServiceKm as number | undefined, units)}`,
        warnings.length === 0 ? 'No warnings' : `Warnings: ${warnings.join(', ')}`,
      ];
      return lines;
    }
    case 'availability':
      return [`Availability: ${humanizeEnum(data.availabilityStatus)} · ${humanizeEnum(data.usageMode)}`];
    case 'parking-climatization':
      return [
        `Preheat/pre-cool: ${humanizeEnum(data.runningStatus)}`,
        typeof data.runtimeLeftMinutes === 'number' && data.runtimeLeftMinutes > 0
          ? `Runtime left: ${data.runtimeLeftMinutes} min`
          : 'Not running',
      ];
    case 'pre-cleaning': {
      const pm = data.measuredParticulateMatter25;
      return [
        `Cabin air: PM2.5 ${pm ?? 'n/a'} µg/m³ · pre-cleaning ${String(humanizeEnum(data.runningStatus)).toLowerCase()}`,
        epochSecondsMs(data.lastCycleCompleted) !== undefined ? `Last cycle completed ${new Date(epochSecondsMs(data.lastCycleCompleted)!).toISOString()}` : 'No completed cycle recorded',
      ];
    }
    case 'amp-limit': {
      const applied = ampLimitA(data);
      const pending = pendingAmpLimitA(data);
      const lines = [`AC charge current limit: ${applied ?? 'n/a'} A`];
      if (pending !== undefined && pending !== applied) {
        lines.push(`Change to ${pending} A is recorded but not yet confirmed by the car`);
      }
      return lines;
    }
    case 'target-soc': {
      const target = targetSoc(data);
      return [`Target charge level: ${target.levelPct ?? 'n/a'}% (${humanizeEnum(target.settingType)})`];
    }
    case 'global-charge-timer': {
      const timer = chargeWindow(data);
      if (timer === undefined) return ['No global charge timer set'];
      const hours = `${timer.startHour ?? 'n/a'}:00 → ${timer.stopHour ?? 'n/a'}:00`;
      return [timer.activated ? `Charge window: ${hours} (active)` : `Charge window: ${hours} (defined but inactive)`];
    }
    case 'parking-climate-timer': {
      const timers = (data.parkingClimateTimers as { activated?: boolean; readyAt?: { hour?: number }; weekdays?: string[] }[] | undefined) ?? [];
      if (timers.length === 0) return ['No parking climate timers'];
      return timers.map((t) => `Climate timer: ready ${t.readyAt?.hour ?? 'n/a'}:00 ${t.weekdays?.join(',') ?? ''} · ${t.activated ? 'active' : 'inactive'}`);
    }
    case 'charge-now':
      return [`Charge-now override: ${data.syncedOverrideChargeTimer ? 'present (synced)' : 'none'}`];
    case 'charge-locations': {
      const list = data.chargeLocations as unknown[] | undefined;
      return [list === undefined ? 'No saved charge locations reported' : `Saved charge locations: ${list.length}`];
    }
    case 'is-at-charge-location':
      return [`At saved charge location: ${humanizeEnum(data.isAtChargeLocation ?? 'unknown')}`];
    default:
      return null;
  }
}

function openEntries(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === 'OPEN_STATUS_OPEN') out.push(key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
  }
  return out;
}

/**
 * Every active warning in a payload, up to four levels of nesting.
 *
 * The old version read only top-level string values, which silently missed
 * `health.lightWarnings`, an object of nineteen bulb positions that the real
 * payload always contains. A burnt-out brake light therefore never reached
 * get_needs_attention. Walked recursively instead, with the rule stated on the
 * value: a string that names a warning and is not the "no warning" value.
 */
export function activeWarnings(data: Record<string, unknown>): string[] {
  const found: string[] = [];

  const labelFor = (path: string[], key: string): string => {
    const words = [...path, key.replace(/Warnings?$/, '')]
      .filter((w) => w.length > 0 && !/warnings?$/i.test(w))
      .join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .trim();
    return words;
  };

  const walk = (obj: Record<string, unknown>, path: string[], depth: number): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (value !== null && typeof value === 'object' && depth < 4) {
        if (Array.isArray(value)) {
          for (const item of value) if (item !== null && typeof item === 'object') walk(item as Record<string, unknown>, path, depth + 1);
        } else {
          walk(value as Record<string, unknown>, [...path, key], depth + 1);
        }
        continue;
      }
      if (typeof value !== 'string') continue;
      const upper = value.toUpperCase();
      if (!upper.includes('WARNING') || upper.includes('NO_WARNING')) continue;
      const label = labelFor(path, key) || 'warning';
      if (!found.includes(label)) found.push(label);
    }
  };

  walk(data, [], 0);
  return found;
}
