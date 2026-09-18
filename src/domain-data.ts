/**
 * Reading a Domain payload.
 *
 * `PolestarClient` unwraps the Envelope, so everything above it holds the
 * `data` object, but that object's *shape* was re-derived at twenty-four call
 * sites with inline casts, in four modules that could each be wrong on their
 * own. These readers own the nested paths; a renamed or moved field is now one
 * edit, and an unreported value is `undefined` by type rather than by comment.
 */

type Payload = Record<string, unknown> | null | undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Current charge level, percent. */
export function chargeLevelPct(battery: Payload): number | undefined {
  return asNumber(asRecord(battery)?.batteryChargeLevelPercentage);
}

/** Reported range to empty, kilometres. The car may also report miles; km is the source of truth. */
export function distanceToEmptyKm(battery: Payload): number | undefined {
  return asNumber(asRecord(battery)?.estimatedDistanceToEmptyKm);
}

/** Energy the pack says it can still deliver, kWh, the basis for implied capacity. */
export function energyAvailableKwh(battery: Payload): number | undefined {
  const info = asRecord(asRecord(battery)?.dischargeInfo);
  return asNumber(info?.energyAvailable);
}

/** Live charging power, watts, when the car is actually charging. */
export function chargingPowerWatts(battery: Payload): number | undefined {
  return asNumber(asRecord(battery)?.chargingPowerWatts);
}

/** Line voltage the car reports; undefined when this credential's domain does not carry it. */
export function chargingVoltageVolts(battery: Payload): number | undefined {
  return asNumber(asRecord(battery)?.chargingVoltageVolts);
}

/** Car's own estimate of minutes to full, when it reports one. */
export function timeToFullMinutes(battery: Payload): number | undefined {
  return asNumber(asRecord(battery)?.estimatedChargingTimeToFullMinutes);
}

export interface TargetSoc {
  levelPct?: number;
  settingType?: string;
}

/** `charging/target-soc` nests its values under `targetSoc`. */
export function targetSoc(data: Payload): TargetSoc {
  const nested = asRecord(asRecord(data)?.targetSoc) ?? {};
  const out: TargetSoc = {};
  const level = asNumber(nested.batteryChargeTargetLevel);
  const type = asString(nested.chargeTargetLevelSettingType);
  if (level !== undefined) out.levelPct = level;
  if (type !== undefined) out.settingType = type;
  return out;
}

/** `charging/amp-limit` nests the number under `ampLimit`. */
export function ampLimitA(data: Payload): number | undefined {
  const nested = asRecord(asRecord(data)?.ampLimit);
  return asNumber(nested?.ampLimit) ?? asNumber(asRecord(data)?.ampLimit);
}

/**
 * The amp-limit change the cloud has recorded but the car has not confirmed yet.
 * Measured live: the Data Portal answers this beside `ampLimit`, and its absence
 * means there is no change waiting, not that the limit is zero.
 */
export function pendingAmpLimitA(data: Payload): number | undefined {
  return asNumber(asRecord(asRecord(data)?.pendingAmpLimit)?.ampLimit);
}

export interface ChargeWindow {
  activated?: boolean;
  startHour?: number;
  stopHour?: number;
  offsetMinutes?: number;
}

/** The recurring charge window from `charging/global-charge-timer`. */
export function chargeWindow(data: Payload): ChargeWindow | undefined {
  const timer = asRecord(asRecord(data)?.globalChargeTimer);
  if (timer === undefined) return undefined;
  const start = asRecord(timer.start);
  const stop = asRecord(timer.stop);
  const zone = asRecord(start?.timeZone);
  const out: ChargeWindow = {};
  const activated = timer.activated;
  const startHour = asNumber(start?.hour);
  const stopHour = asNumber(stop?.hour);
  const offset = asNumber(zone?.offsetMinutes);
  if (typeof activated === 'boolean') out.activated = activated;
  if (startHour !== undefined) out.startHour = startHour;
  if (stopHour !== undefined) out.stopHour = stopHour;
  if (offset !== undefined) out.offsetMinutes = offset;
  return out;
}

/** A numeric field read straight off a payload, undefined when unreported. */
export function numberField(data: Payload, key: string): number | undefined {
  return asNumber(asRecord(data)?.[key]);
}

/** Odometer reading in metres. */
export function odometerMeters(data: Payload): number | undefined {
  return asNumber(asRecord(data)?.odometerMeters);
}

/** When the cloud last heard from the car, epoch ms, the Availability timestamp. */
export function observedAtMs(data: Payload): number | undefined {
  const record = asRecord(data);
  if (record === undefined) return undefined;
  const ts = asRecord(record.timestamp);
  const seconds = ts?.seconds;
  if (typeof seconds === 'string' && /^\d+$/.test(seconds)) return Number(seconds) * 1000;
  const meta = record.metaReceivedAt;
  if (typeof meta === 'string') {
    const parsed = Date.parse(meta);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export interface Position {
  latitude?: number;
  longitude?: number;
  heading?: number;
  speedKmh?: number;
}

/** `telemetry/location` nests the coordinates under `coordinate`. */
export function position(data: Payload): Position | undefined {
  const record = asRecord(data);
  const coord = asRecord(record?.coordinate);
  if (coord === undefined) return undefined;
  const out: Position = {};
  const lat = asNumber(coord.latitude);
  const lon = asNumber(coord.longitude);
  const heading = asNumber(record?.heading);
  const speed = asNumber(record?.speed);
  if (lat !== undefined) out.latitude = lat;
  if (lon !== undefined) out.longitude = lon;
  if (heading !== undefined) out.heading = heading;
  if (speed !== undefined) out.speedKmh = speed;
  return out;
}

/** A nested `{ seconds: "1234567890" }` timestamp, as epoch ms. */
export function epochSecondsMs(value: unknown): number | undefined {
  const seconds = asRecord(value)?.seconds;
  if (typeof seconds !== 'string' || !/^\d+$/.test(seconds)) return undefined;
  return Number(seconds) * 1000;
}
