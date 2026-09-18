/**
 * The Domain registry: the one list of what this server can read, with the
 * facts that belong to each entry, its route, its scope, how fast its value
 * can change, and whether background sampling should keep an eye on it.
 *
 * These facts used to be spread across a regex table in the cache, a four-entry
 * list in the sampler, a switch in the humanizer and two hand-copied lists in
 * the gates. Adding a Domain then meant remembering all of them: the ones that
 * were forgotten failed silently, one of them by spending real daily quota.
 */
import type { DomainKind as Kind } from './client.js';

/** Re-exported because the registry is the natural place a caller looks for it. */
export type DomainKind = Kind;

export interface DomainSpec {
  kind: DomainKind;
  /** URL path segment, e.g. `target-soc`. */
  name: string;
  scope: string;
  description: string;
  /**
   * Cache lifetime for this Domain. It used to live in a regex table in the
   * transport, where forgetting an entry silently produced a 60-second TTL on a
   * live credential that costs real quota.
   */
  ttlMs: number;
  /** Whether background sampling should read it; the fast movers only. */
  sampled: boolean;
  /**
   * The key set the captured fixture must hold. It used to live only in the test
   * file, which meant a new Domain could join the registry with nothing checking
   * its shape. An empty list is the honest statement that the Domain has no
   * payload to pin (it answers DATA_NOT_AVAILABLE on the cars seen so far).
   */
  pinnedKeys: readonly string[];
}

export const TTL = {
  /** The vehicle list changes when you buy a car. */
  hour: 60 * 60 * 1000,
  fast: 30 * 1000,
  minute: 60 * 1000,
  settings: 5 * 60 * 1000,
  slow: 10 * 60 * 1000,
  rare: 30 * 60 * 1000,
} as const;

/** The fifteen read domains of the M2M v1 API (the documented API is read-only). */
export const DOMAINS: readonly DomainSpec[] = [
  {
    kind: 'telemetry',
    name: 'availability',
    scope: 'pdp-telemetry/availability',
    description:
      'Vehicle availability: availabilityStatus and usageMode (whether the car is currently reachable/awake).',
    ttlMs: TTL.minute,
    sampled: false,
    pinnedKeys: [
      'availabilityStatus',
      'metaEventId',
      'metaReceivedAt',
      'timestamp',
      'usageMode',
      'vin',
    ],
  },
  {
    kind: 'telemetry',
    name: 'battery',
    scope: 'pdp-telemetry/battery',
    description:
      'Battery state: charge level %, charging status (V1/V2/type), charger connection and power status, estimated distance to empty (km and miles), estimated time to full, and average consumption kWh/100km. The contract also defines charging current and voltage, charging power, since-charge and automatic-trip consumption averages, and an energy-consumption breakdown: those appear only when the car reports them, so a missing field means unreported, not zero. The reference vehicle answered with 14 fields and none of the optional ones.',
    ttlMs: TTL.fast,
    sampled: true,
    pinnedKeys: [
      'averageEnergyConsumptionKwhPer100Km',
      'batteryChargeLevelPercentage',
      'chargerConnectionStatus',
      'chargerPowerStatus',
      'chargingStatus',
      'chargingStatusV2',
      'chargingType',
      'estimatedChargingTimeToFullMinutes',
      'estimatedDistanceToEmptyKm',
      'estimatedDistanceToEmptyMiles',
      'metaEventId',
      'metaReceivedAt',
      'timestamp',
      'vin',
    ],
  },
  {
    kind: 'telemetry',
    name: 'exterior',
    scope: 'pdp-telemetry/exterior',
    description:
      'Exterior state: doors, windows, hood, tailgate, tank lid (open/closed), central lock, tailgate lock, alarm.',
    ttlMs: TTL.fast,
    sampled: true,
    pinnedKeys: [
      'alarm',
      'centralLock',
      'frontLeftDoor',
      'frontLeftWindow',
      'frontRightDoor',
      'frontRightWindow',
      'hood',
      'metaEventId',
      'metaReceivedAt',
      'rearLeftDoor',
      'rearLeftWindow',
      'rearRightDoor',
      'rearRightWindow',
      'tailgate',
      'tailgateLock',
      'tankLid',
      'timestamp',
      'vin',
    ],
  },
  {
    kind: 'telemetry',
    name: 'health',
    scope: 'pdp-telemetry/health',
    description:
      'Service health: days/distance/engine-hours to service, service warning, and fluid/light/12V warnings (brake fluid, coolant, oil, washer fluid, 19 exterior light positions).',
    ttlMs: TTL.slow,
    sampled: false,
    pinnedKeys: [
      'brakeFluidLevelWarning',
      'daysToService',
      'distanceToServiceKm',
      'engineCoolantLevelWarning',
      'engineHoursToService',
      'lightWarnings',
      'lowVoltageBatteryWarning',
      'metaEventId',
      'metaReceivedAt',
      'oilLevelWarning',
      'serviceWarning',
      'timestamp',
      'vin',
      'washerFluidLevelWarning',
    ],
  },
  {
    kind: 'telemetry',
    name: 'location',
    scope: 'pdp-telemetry/location',
    description:
      'Last known position: latitude, longitude, altitude, heading, speed, with timestamp.',
    ttlMs: TTL.fast,
    sampled: true,
    pinnedKeys: [
      'altitude',
      'coordinate',
      'heading',
      'metaEventId',
      'metaReceivedAt',
      'speed',
      'timestamp',
      'vin',
    ],
  },
  {
    kind: 'telemetry',
    name: 'odometer',
    scope: 'pdp-telemetry/odometer',
    description:
      'Odometer meters, trip meters (manual and automatic, km), average speeds (km/h).',
    ttlMs: TTL.minute,
    sampled: true,
    pinnedKeys: [
      'averageSpeedKmPerHour',
      'averageSpeedKmPerHourAutomatic',
      'metaEventId',
      'metaReceivedAt',
      'odometerMeters',
      'timestamp',
      'tripMeterAutomaticKm',
      'tripMeterManualKm',
      'vin',
    ],
  },
  {
    kind: 'telemetry',
    name: 'parking-climatization',
    scope: 'pdp-telemetry/parkingClimatization',
    description:
      'Parking climate (preheat/pre-cool): running status, runtime left, requested seat and steering-wheel heating intensities, ventilation.',
    ttlMs: TTL.minute,
    sampled: false,
    pinnedKeys: [
      'metaEventId',
      'metaReceivedAt',
      'requestedFrontLeftSeat',
      'requestedFrontRightSeat',
      'requestedRearLeftSeat',
      'requestedRearRightSeat',
      'requestedSteeringWheelHeating',
      'runningStatus',
      'runtimeLeftMinutes',
      'timestamp',
      'ventilation',
      'vin',
    ],
  },
  {
    kind: 'telemetry',
    name: 'pre-cleaning',
    scope: 'pdp-telemetry/preCleaning',
    description:
      'Cabin air pre-cleaning: running status, measured PM2.5 / air quality index, last cycle validity and completion time.',
    ttlMs: TTL.rare,
    sampled: false,
    pinnedKeys: [
      'lastCycleCompleted',
      'lastCycleValid',
      'measuredAirQualityIndex',
      'measuredParticulateMatter25',
      'measurementDate',
      'metaEventId',
      'metaReceivedAt',
      'runningStatus',
      'runtimeLeftMinutes',
      'startedAt',
      'timestamp',
      'vin',
    ],
  },
  {
    kind: 'charging',
    name: 'amp-limit',
    scope: 'pdp-charging/ampLimit',
    description:
      'Configured maximum AC charging current (amps) with its source and last update, plus pendingAmpLimit when a change is recorded but the car has not confirmed it. Measured live.',
    ttlMs: TTL.settings,
    sampled: false,
    pinnedKeys: [
      'ampLimit',
      'id',
      'metaEventId',
      'metaReceivedAt',
      'pendingAmpLimit',
      'updatedAt',
      'updatedAtTimestamp',
      'vin',
    ],
  },
  {
    kind: 'charging',
    name: 'charge-locations',
    scope: 'pdp-charging/chargeLocations',
    description:
      'Configured charge locations. Over M2M this answers as a settings record \u2014 typically only an id and a utc0 flag, not a list of addresses \u2014 so finding no coordinates is normal rather than a failure.',
    ttlMs: TTL.settings,
    sampled: false,
    pinnedKeys: ['id', 'metaEventId', 'metaReceivedAt', 'utc0', 'vin'],
  },
  {
    kind: 'charging',
    name: 'charge-now',
    scope: 'pdp-charging/overrideChargeTimer',
    description:
      'Charge-now override state. Over M2M it typically carries only the last sync timestamp of the override, not an active/inactive boolean.',
    ttlMs: TTL.settings,
    sampled: false,
    pinnedKeys: [
      'id',
      'metaEventId',
      'metaReceivedAt',
      'syncedOverrideChargeTimer',
      'vin',
    ],
  },
  {
    kind: 'charging',
    name: 'global-charge-timer',
    scope: 'pdp-charging/globalChargeTimer',
    description:
      'Recurring charge window: start/stop hour with timezone offset, activation flag and sync status. Pending changes appear only when an edit has not yet reached the car; an empty pending block means nothing is queued.',
    ttlMs: TTL.settings,
    sampled: false,
    pinnedKeys: [
      'globalChargeTimer',
      'id',
      'metaEventId',
      'metaReceivedAt',
      'pendingGlobalChargeTimer',
      'vin',
    ],
  },
  {
    kind: 'charging',
    name: 'parking-climate-timer',
    scope: 'pdp-charging/parkingClimateTimer',
    description:
      'Scheduled parking-climate timers: ready-at hour, weekdays, repeat flag, activation.',
    ttlMs: TTL.settings,
    sampled: false,
    pinnedKeys: [
      'id',
      'metaEventId',
      'metaReceivedAt',
      'parkingClimateTimers',
      'updatedAt',
      'updatedAtTimestamp',
      'utc0',
      'vin',
    ],
  },
  {
    kind: 'charging',
    name: 'target-soc',
    scope: 'pdp-charging/targetSoc',
    description: 'Target battery state of charge (%), setting type (CUSTOM/PRESET), last update.',
    ttlMs: TTL.settings,
    sampled: false,
    pinnedKeys: [
      'id',
      'metaEventId',
      'metaReceivedAt',
      'targetSoc',
      'timestamp',
      'updatedAt',
      'vin',
    ],
  },
  {
    kind: 'charging',
    name: 'is-at-charge-location',
    scope: 'pdp-charging/isAtChargeLocation',
    description:
      'Whether the vehicle is currently at a saved charge location. Often unsupported on a vehicle (returns DATA_NOT_AVAILABLE).',
    ttlMs: TTL.settings,
    sampled: false,
    pinnedKeys: [],
  },
] as const;

/** The upstream route for one Domain, the single spelling of the path grammar. */
export function domainPath(kind: DomainKind, name: string): string {
  return `/v1/vehicles/{vin}/${kind}/${name}`;
}

export function toolName(domain: DomainSpec): string {
  return `get_${domain.name.replace(/-/g, '_')}`;
}

/** The vehicle list route, cached far longer than any per-Vehicle Domain. */
export const VEHICLES_TTL_MS = TTL.hour;

/** Every get_* tool name derived from the registry. */
export function domainToolNames(domains: readonly DomainSpec[] = DOMAINS): string[] {
  return domains.map(toolName);
}

/** Find a registered Domain by the two parts of its route. Both parts match
 * case-insensitively; an unregistered pair returns undefined. */
export function findDomain(kind: string, name: string): DomainSpec | undefined {
  const wanted = name.toLowerCase();
  return DOMAINS.find((d) => d.kind === kind.toLowerCase() && d.name.toLowerCase() === wanted);
}

/**
 * The route grammar in one place: the upstream path the client builds
 * (`/…/v1/vehicles/{vin}/{kind}/{name}`), the cached copy of that path, the
 * fixture adapter's lookup, and the resource URI a client subscribes to
 * (`polestar://vehicle/{vin}/{kind}/{name}`) all arrive here. Three regexes used
 * to spell this, one of them differently, and a missed change degraded the cache
 * and the history recording silently. The upstream plural and the resource
 * singular are both accepted; the Domain must still exist in the registry.
 */
const DOMAIN_ROUTE = /\/vehicles?\/([^/]+)\/(telemetry|charging)\/([a-z-]+)$/i;

export interface DomainRef {
  vin: string;
  kind: DomainKind;
  name: string;
}

/**
 * A resource URI, which is NOT a path: in `polestar://vehicle/{vin}/{kind}/{name}`
 * the word `vehicle` is the URL host, so the path part starts at the VIN. Reading
 * it as a path is what made subscriptions silently inert: every parse returned
 * nothing, so no subscribed URI was ever primed or polled.
 */
export function parseResourceUri(uri: string): DomainRef | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  const path = parsed.host === 'vehicle' ? `/vehicle${parsed.pathname}` : parsed.pathname;
  const ref = parseDomainPath(path);
  return ref === undefined ? undefined : { ...ref, name: ref.name };
}

export function parseDomainPath(pathname: string): DomainRef | undefined {
  const m = DOMAIN_ROUTE.exec(pathname);
  const [rawVin, rawKind, rawName] = m?.slice(1) ?? [];
  if (rawVin === undefined || rawKind === undefined || rawName === undefined) return undefined;
  const spec = findDomain(rawKind, rawName);
  if (spec === undefined) return undefined;
  return { vin: decodeURIComponent(rawVin), kind: spec.kind, name: spec.name };
}
/** Deduplicated OAuth scopes for every registered domain. */
export function collectScopes(domains: readonly DomainSpec[] = DOMAINS): string[] {
  return [...new Set(domains.map((d) => d.scope))];
}
