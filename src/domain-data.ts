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

/**
 * A number the live contract sometimes sends as a JSON string. Location is the
 * measured case: `speed` and `altitude` arrive as `"45"` and `"12"`, and reading
 * them as numbers alone turned a moving car into 0 km/h. Kept separate from
 * `asNumber` so a payload shape change elsewhere is not silently coerced.
 */
const asNumeric = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

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

/** Deepest nesting the value-clock search walks: settings nest their clock under metadata. */
const VALUE_CLOCK_MAX_DEPTH = 4;

/** A protobuf timestamp object, or an epoch-millisecond string, as epoch ms. */
const valueClockMs = (value: unknown): number | undefined => {
  const seconds = epochSecondsMs(value);
  if (seconds !== undefined) return seconds;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

/**
 * The first `updatedAtTimestamp` below the payload's top level. Settings carry
 * their own clock there (`ampLimit.updatedAtTimestamp`,
 * `globalChargeTimer.metadata.updatedAtTimestamp`), and it is the value's time,
 * not the cloud receive time the top-level `metaReceivedAt` records.
 */
function nestedUpdatedAtMs(node: unknown, depth: number): number | undefined {
  if (node === null || typeof node !== 'object' || depth > VALUE_CLOCK_MAX_DEPTH) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = nestedUpdatedAtMs(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const own = valueClockMs(record.updatedAtTimestamp);
  if (own !== undefined) return own;
  for (const child of Object.values(record)) {
    const found = nestedUpdatedAtMs(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * When the value itself was observed, epoch ms.
 *
 * Order matters and used to be wrong: the old reader took the top-level
 * `timestamp` and then `metaReceivedAt`, so a charging setting changed 24 days
 * before the capture printed as fresh because the cloud only just re-sent it.
 * The value's own clocks come first, then the payload's sync clock, then the
 * receive clock:
 *
 * 1. a nested `updatedAtTimestamp` (settings: `ampLimit`, both timers)
 * 2. `targetSoc.timestamp` (the target value nests its clock)
 * 3. the top-level `updatedAtTimestamp`
 * 4. the top-level `timestamp.seconds`
 * 5. `metaReceivedAt`, the cloud receive clock, which is still better than the
 *    read clock a history record would otherwise store
 */
export function valueObservedAtMs(data: Payload): number | undefined {
  const record = asRecord(data);
  if (record === undefined) return undefined;

  for (const [key, child] of Object.entries(record)) {
    if (key === 'updatedAtTimestamp') continue;
    const nested = nestedUpdatedAtMs(child, 1);
    if (nested !== undefined) return nested;
  }

  const targetClock = epochSecondsMs(asRecord(record.targetSoc)?.timestamp);
  if (targetClock !== undefined) return targetClock;

  const updatedAt = valueClockMs(record.updatedAtTimestamp);
  if (updatedAt !== undefined) return updatedAt;

  const topLevel = epochSecondsMs(record.timestamp);
  if (topLevel !== undefined) return topLevel;

  const meta = record.metaReceivedAt;
  if (typeof meta === 'string') {
    const parsed = Date.parse(meta);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** The observation time of a payload; same answer as {@link valueObservedAtMs}. */
export function observedAtMs(data: Payload): number | undefined {
  return valueObservedAtMs(data);
}

export interface Position {
  latitude?: number;
  longitude?: number;
  altitude?: number;
  heading?: number;
  speedKmh?: number;
}

/**
 * `telemetry/location` nests the coordinates under `coordinate`; speed and
 * altitude are JSON strings in the live contract even though heading is a number,
 * so the two string-encoded fields are read with the numeric-string tolerance.
 */
export function position(data: Payload): Position | undefined {
  const record = asRecord(data);
  const coord = asRecord(record?.coordinate);
  if (coord === undefined) return undefined;
  const out: Position = {};
  const lat = asNumber(coord.latitude);
  const lon = asNumber(coord.longitude);
  const altitude = asNumeric(record?.altitude);
  const heading = asNumber(record?.heading);
  const speed = asNumeric(record?.speed);
  if (lat !== undefined) out.latitude = lat;
  if (lon !== undefined) out.longitude = lon;
  if (altitude !== undefined) out.altitude = altitude;
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

/*
 * Whole-payload views.
 *
 * The readers above are one field each, which is the right shape for a value
 * that nests (targetSoc.batteryChargeTargetLevel, dischargeInfo.energyAvailable).
 * For a payload several consumers read end to end it is the wrong shape: a
 * consumer that reads six fields indexes the payload six times, and a rule about
 * the payload gets written once per consumer. A view is one call for the whole
 * Domain, so the field names and the rules that rest on them have one home.
 */

/**
 * Whether a charging status means the car is taking power. `endsWith`, not
 * `includes`: `CHARGING_STATUS_V2_IDLE` contains "CHARGING" as part of the enum
 * namespace, so a substring test reports every parked car as charging.
 */
export function isChargingStatus(status: unknown): boolean {
  return typeof status === 'string' && status.endsWith('_CHARGING');
}

export interface BatteryView {
  chargeLevelPct?: number | undefined;
  distanceToEmptyKm?: number | undefined;
  powerWatts?: number | undefined;
  volts?: number | undefined;
  /** Reported only by some credentials; `undefined` means unreported, not zero. */
  amps?: number | undefined;
  consumptionKwhPer100Km?: number | undefined;
  timeToFullMinutes?: number | undefined;
  energyAvailableKwh?: number | undefined;
  /** `chargingStatusV2` supersedes V1 and a car reports one or the other. */
  status: unknown;
  connection: unknown;
}

export function batteryView(data: Payload): BatteryView {
  const battery = asRecord(data) ?? {};
  const out: BatteryView = {
    status: battery.chargingStatusV2 ?? battery.chargingStatus,
    connection: battery.chargerConnectionStatus,
  };
  const chargeLevelPctValue = chargeLevelPct(data);
  const distanceToEmptyKmValue = distanceToEmptyKm(data);
  const powerWatts = chargingPowerWatts(data);
  const volts = chargingVoltageVolts(data);
  const amps = asNumber(battery.chargingCurrentAmps);
  const consumptionKwhPer100Km = asNumber(battery.averageEnergyConsumptionKwhPer100Km);
  const timeToFull = timeToFullMinutes(data);
  const energy = energyAvailableKwh(data);
  if (chargeLevelPctValue !== undefined) out.chargeLevelPct = chargeLevelPctValue;
  if (distanceToEmptyKmValue !== undefined) out.distanceToEmptyKm = distanceToEmptyKmValue;
  if (powerWatts !== undefined) out.powerWatts = powerWatts;
  if (volts !== undefined) out.volts = volts;
  if (amps !== undefined) out.amps = amps;
  if (consumptionKwhPer100Km !== undefined) out.consumptionKwhPer100Km = consumptionKwhPer100Km;
  if (timeToFull !== undefined) out.timeToFullMinutes = timeToFull;
  if (energy !== undefined) out.energyAvailableKwh = energy;
  return out;
}

const OPEN_STATUS_OPEN = 'OPEN_STATUS_OPEN';
const LOCK_STATUS_LOCKED = 'LOCK_STATUS_LOCKED';

/** `frontLeftWindow` reads as "front left window": the payload's names are camelCase. */
const spokenFieldName = (key: string): string => key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function openFields(record: Record<string, unknown>, include: (key: string) => boolean): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value !== OPEN_STATUS_OPEN || !include(key)) continue;
    out.push(spokenFieldName(key));
  }
  return out;
}

export type LockState = 'locked' | 'unlocked' | 'unknown';
export type AlarmState = 'ok' | 'triggered' | 'unknown';

const lockStateOf = (value: unknown): LockState => {
  if (value === LOCK_STATUS_LOCKED) return 'locked';
  if (value === 'LOCK_STATUS_UNLOCKED') return 'unlocked';
  return 'unknown';
};

/**
 * A triggered alarm is a fact; an unreported alarm is not an OK one. The
 * distinction matters because the verdict sentence is read as a yes/no.
 */
const alarmStateOf = (value: unknown): AlarmState => {
  if (typeof value !== 'string' || value === '') return 'unknown';
  const upper = value.toUpperCase();
  if (upper.includes('TRIGGERED')) return 'triggered';
  if (upper.endsWith('_UNSPECIFIED')) return 'unknown';
  return 'ok';
};

export interface ExteriorView {
  /** Every exterior field the car reports open, the charge flap included. */
  open: string[];
  /**
   * The open fields that bear on the car being shut and locked.
   *
   * The tank lid is deliberately not one of them: a charge flap left open is a
   * fact worth reporting and is not a lock failure, so `is_car_secure` and
   * `get_car_status` ask two different questions. They ask them from these two
   * fields rather than from two filters written independently, which is how the
   * exclusion was one silent `key !== 'tankLid'` in one tool and absent from the
   * other.
   */
  openSecurityRelevant: string[];
  /**
   * True only when both locks report locked, false when either reports unlocked,
   * undefined when either is unreported. Absence must not read as "unlocked": the
   * old boolean said a car with no `tailgateLock` was open when the car had simply
   * not reported the field.
   */
  locked?: boolean | undefined;
  lockState: LockState;
  centralLock: unknown;
  tailgateLock: unknown;
  /** Lock fields the car did not report, in the words the summaries use. */
  unknownLocks: string[];
  /** Lock fields the car reported not locked, in the words the summaries use. */
  unlockedLocks: string[];
  alarm: unknown;
  alarmState: AlarmState;
}

export function exteriorView(data: Payload): ExteriorView {
  const exterior = asRecord(data) ?? {};
  const centralState = lockStateOf(exterior.centralLock);
  const tailgateState = lockStateOf(exterior.tailgateLock);
  const states = [
    { name: spokenFieldName('centralLock'), state: centralState },
    { name: spokenFieldName('tailgateLock'), state: tailgateState },
  ];
  const lockState: LockState = states.some((s) => s.state === 'unlocked')
    ? 'unlocked'
    : states.some((s) => s.state === 'unknown')
      ? 'unknown'
      : 'locked';
  return {
    open: openFields(exterior, () => true),
    openSecurityRelevant: openFields(exterior, (key) => key !== 'tankLid'),
    ...(lockState === 'unknown' ? {} : { locked: lockState === 'locked' }),
    lockState,
    centralLock: exterior.centralLock,
    tailgateLock: exterior.tailgateLock,
    unknownLocks: states.filter((s) => s.state === 'unknown').map((s) => s.name),
    unlockedLocks: states.filter((s) => s.state === 'unlocked').map((s) => s.name),
    alarm: exterior.alarm,
    alarmState: alarmStateOf(exterior.alarm),
  };
}

export interface HealthView {
  daysToService?: number | undefined;
  distanceToServiceKm?: number | undefined;
}

/** Service countdown for whichever of the two limits the car reports first. */
export function healthView(data: Payload): HealthView {
  const health = asRecord(data) ?? {};
  const out: HealthView = {};
  const days = asNumber(health.daysToService);
  const distanceToService = asNumber(health.distanceToServiceKm);
  if (days !== undefined) out.daysToService = days;
  if (distanceToService !== undefined) out.distanceToServiceKm = distanceToService;
  return out;
}

export interface AvailabilityView {
  /** Whether the car is reachable or asleep. */
  status: unknown;
  usageMode: unknown;
}

export function availabilityView(data: Payload): AvailabilityView {
  const availability = asRecord(data) ?? {};
  return { status: availability.availabilityStatus, usageMode: availability.usageMode };
}
