/**
 * Compact, typed data views for the 15 Domains.
 *
 * The humanized summary is prose written for a model; a client that renders a
 * value or branches on it needs the same facts as fields. This module is the one
 * place those fields are named, so a Domain's structured shape and its prose
 * cannot drift into two vocabularies. Values keep the units the API sends
 * (percent, kilometres, metres, watts); display conversion stays in `format.ts`.
 */
import {
  ampLimitA,
  availabilityView,
  batteryView,
  chargeWindow,
  epochSecondsMs,
  exteriorView,
  healthView,
  isChargingStatus,
  numberField,
  odometerMeters,
  pendingAmpLimitA,
  position,
  targetSoc,
} from './domain-data.js';

type Payload = Record<string, unknown>;

/** The documented `structuredContent.data` shape for one Domain read. */
export type DomainView = Record<string, unknown>;

const recordOf = (value: unknown): Payload | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : undefined;

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * One Domain's machine-readable view.
 *
 * Absent fields are omitted rather than sent as `null`: the API reports latest
 * known values, so a missing field means "this car did not report it", and a
 * client that receives `null` would have to guess which of the two it is.
 */
export function domainView(name: string, payload: Payload): DomainView {
  switch (name) {
    case 'availability': {
      const seen = availabilityView(payload);
      return { availabilityStatus: seen.status, usageMode: seen.usageMode };
    }
    case 'battery': {
      const seen = batteryView(payload);
      const view: DomainView = {
        chargeLevelPct: seen.chargeLevelPct,
        distanceToEmptyKm: seen.distanceToEmptyKm,
        chargingStatus: seen.status,
        chargerConnectionStatus: seen.connection,
        isCharging: isChargingStatus(seen.status),
        chargingPowerKw: seen.powerWatts === undefined ? undefined : round(seen.powerWatts / 1000, 2),
        chargingVolts: seen.volts,
        chargingAmps: seen.amps,
        timeToFullMinutes: seen.timeToFullMinutes,
        consumptionKwhPer100Km: seen.consumptionKwhPer100Km,
        energyAvailableKwh: seen.energyAvailableKwh,
      };
      return withoutUndefined(view);
    }
    case 'exterior': {
      const seen = exteriorView(payload);
      return withoutUndefined({
        open: seen.open,
        openSecurityRelevant: seen.openSecurityRelevant,
        lockState: seen.lockState,
        locked: seen.locked,
        unknownLocks: seen.unknownLocks,
        unlockedLocks: seen.unlockedLocks,
        alarmState: seen.alarmState,
      });
    }
    case 'health': {
      const seen = healthView(payload);
      return withoutUndefined({
        daysToService: seen.daysToService,
        distanceToServiceKm: seen.distanceToServiceKm,
        engineHoursToService: numberField(payload, 'engineHoursToService'),
      });
    }
    case 'location': {
      const seen = position(payload);
      if (seen === undefined) return {};
      return withoutUndefined({
        latitude: seen.latitude,
        longitude: seen.longitude,
        altitude: seen.altitude,
        heading: seen.heading,
        speedKmh: seen.speedKmh,
      });
    }
    case 'odometer': {
      const meters = odometerMeters(payload);
      return withoutUndefined({
        odometerMeters: meters,
        odometerKm: meters === undefined ? undefined : round(meters / 1000, 3),
        tripMeterManualKm: numberField(payload, 'tripMeterManualKm'),
        tripMeterAutomaticKm: numberField(payload, 'tripMeterAutomaticKm'),
        averageSpeedKmh: numberField(payload, 'averageSpeedKmPerHour'),
        averageSpeedAutomaticKmh: numberField(payload, 'averageSpeedKmPerHourAutomatic'),
      });
    }
    case 'parking-climatization':
      return withoutUndefined({
        runningStatus: payload.runningStatus,
        runtimeLeftMinutes: numberField(payload, 'runtimeLeftMinutes'),
        requestedFrontLeftSeat: payload.requestedFrontLeftSeat,
        requestedFrontRightSeat: payload.requestedFrontRightSeat,
        requestedRearLeftSeat: payload.requestedRearLeftSeat,
        requestedRearRightSeat: payload.requestedRearRightSeat,
        requestedSteeringWheelHeating: payload.requestedSteeringWheelHeating,
        ventilation: payload.ventilation,
      });
    case 'pre-cleaning':
      return withoutUndefined({
        runningStatus: payload.runningStatus,
        runtimeLeftMinutes: numberField(payload, 'runtimeLeftMinutes'),
        pm25: numberField(payload, 'measuredParticulateMatter25'),
        airQualityIndex: numberField(payload, 'measuredAirQualityIndex'),
        lastCycleValid: payload.lastCycleValid,
        lastCycleCompletedMs: epochSecondsMs(payload.lastCycleCompleted),
      });
    case 'amp-limit': {
      const nested = recordOf(payload.ampLimit);
      return withoutUndefined({
        ampLimitA: ampLimitA(payload),
        pendingAmpLimitA: pendingAmpLimitA(payload),
        source: nested?.source,
        updatedAtMs: epochSecondsMs(nested?.updatedAtTimestamp),
      });
    }
    case 'charge-locations': {
      const list = payload.chargeLocations;
      return withoutUndefined({
        savedChargeLocations: Array.isArray(list) ? list.length : 0,
        utc0: payload.utc0,
      });
    }
    case 'charge-now': {
      const synced = recordOf(payload.syncedOverrideChargeTimer);
      return withoutUndefined({
        overrideSynced: synced !== undefined,
        overrideSyncedAtMs: epochSecondsMs(synced?.updatedAtTimestamp),
      });
    }
    case 'global-charge-timer': {
      const window = chargeWindow(payload);
      const pending = recordOf(payload.pendingGlobalChargeTimer);
      // The registry says an empty pending block means nothing is queued, so a
      // block with only `metadata` is not a change waiting for the car.
      const pendingChanges = pending !== undefined && Object.keys(pending).some((key) => key !== 'metadata');
      return withoutUndefined({
        activated: window?.activated,
        startHour: window?.startHour,
        stopHour: window?.stopHour,
        offsetMinutes: window?.offsetMinutes,
        pendingChanges,
      });
    }
    case 'parking-climate-timer': {
      const timers = Array.isArray(payload.parkingClimateTimers) ? payload.parkingClimateTimers : [];
      return {
        timers: timers.flatMap((entry) => {
          const timer = recordOf(entry);
          if (timer === undefined) return [];
          const readyAt = recordOf(timer.readyAt);
          const zone = recordOf(readyAt?.timeZone);
          return [
            withoutUndefined({
              index: numberField(timer, 'index'),
              activated: timer.activated,
              repeat: timer.repeat,
              readyAtHour: numberField(readyAt, 'hour'),
              offsetMinutes: numberField(zone, 'offsetMinutes'),
              weekdays: Array.isArray(timer.weekdays) ? timer.weekdays : undefined,
            }),
          ];
        }),
      };
    }
    case 'target-soc': {
      const seen = targetSoc(payload);
      const nested = recordOf(payload.targetSoc);
      return withoutUndefined({
        targetPct: seen.levelPct,
        settingType: seen.settingType,
        updatedAtMs: epochSecondsMs(nested?.timestamp),
      });
    }
    case 'is-at-charge-location':
      return withoutUndefined({ isAtChargeLocation: payload.isAtChargeLocation });
    default:
      return {};
  }
}

/** Drop keys whose value is `undefined`, so the view never sends a null placeholder. */
function withoutUndefined(view: DomainView): DomainView {
  const out: DomainView = {};
  for (const [key, value] of Object.entries(view)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
