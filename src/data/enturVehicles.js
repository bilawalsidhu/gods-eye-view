/**
 * @module enturVehicles
 * @description Decoder for Entur's Vehicles GraphQL API (realtime v2).
 *
 * Entur's Vehicles API answers JSON; this module turns one response into the
 * snapshot shape `decodeVehiclePositions` gives the proxy, so the layer never
 * knows which wire format it came from.
 *
 * The query it answers is `ENTUR_VEHICLES_QUERY` in transitFeeds.js; keep the
 * two in step. Pure: no Node built-ins, shared by the proxy and node:test.
 */

import {
  GTFS_INCREMENTALITY_FULL_DATASET,
  GTFS_MAX_ENTITIES,
  GTFS_MAX_STRING_CHARS,
  isPlausibleVehiclePosition,
} from './gtfsRealtime.js';

/** Entur's VehicleModeEnumeration → the Transit layer's modes. */
const ENTUR_MODE = Object.freeze({
  BUS: 'bus',
  COACH: 'bus',
  TRAM: 'tram',
  METRO: 'subway',
  RAIL: 'rail',
  FERRY: 'ferry',
});

/**
 * Transit mode for an Entur vehicle mode.
 * @param {unknown} mode VehicleModeEnumeration value.
 * @returns {string|null} A Transit mode, or null when Entur did not say.
 */
export function enturVehicleMode(mode) {
  return typeof mode === 'string' && Object.hasOwn(ENTUR_MODE, mode)
    ? ENTUR_MODE[mode]
    : null;
}

function text(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= GTFS_MAX_STRING_CHARS
    ? value
    : null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Flatten one Entur vehicle into the record the Transit layer renders, or null
 * when it has no usable position or id.
 * @param {object} vehicle One element of `data.vehicles`.
 * @returns {object|null}
 */
export function normalizeEnturVehicle(vehicle) {
  if (!vehicle || typeof vehicle !== 'object') return null;
  const lat = finite(vehicle.location?.latitude);
  const lon = finite(vehicle.location?.longitude);
  if (!isPlausibleVehiclePosition(lat, lon)) return null;
  const id = text(vehicle.vehicleId);
  if (!id) return null;
  const bearing = finite(vehicle.bearing);
  const stamp = finite(vehicle.lastUpdatedEpochSecond);
  return {
    id,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    bearing: bearing === null ? null : ((bearing % 360) + 360) % 360,
    // Entur does not document the unit of `speed`, so none is claimed.
    speedMps: null,
    timestamp: stamp !== null && stamp > 0 ? Math.floor(stamp) : null,
    routeId: text(vehicle.line?.lineRef),
    tripId: text(vehicle.serviceJourney?.id),
    directionId: null,
    label: null,
    stopId: text(vehicle.monitoredCall?.stopPointRef),
    status: null,
    occupancy: null,
    mode: enturVehicleMode(vehicle.mode),
  };
}

/**
 * Decode a Vehicles API response into the snapshot shape of
 * `decodeVehiclePositions`. Duplicate vehicle ids keep the newest report.
 * @param {Uint8Array|ArrayBuffer} bytes UTF-8 JSON response body.
 * @returns {{ version: null, timestamp: null, incrementality: number,
 *   entityCount: number, truncated: boolean, vehicles: object[] }}
 * @throws {Error} When the body is not a Vehicles API answer, or reports errors for half or more of its records.
 */
export function decodeEnturVehicles(bytes) {
  const body = JSON.parse(new TextDecoder().decode(bytes));
  const list = body?.data?.vehicles;
  if (!Array.isArray(list)) {
    throw new Error(
      `Entur vehicles response has no vehicle list${errorReason(body)}`,
    );
  }
  const errors = Array.isArray(body?.errors) ? body.errors.length : 0;
  const truncated = list.length > GTFS_MAX_ENTITIES;
  const read = truncated ? list.slice(0, GTFS_MAX_ENTITIES) : list;
  const byId = new Map();
  let usable = 0;
  for (const vehicle of read) {
    const record = normalizeEnturVehicle(vehicle);
    if (!record) continue;
    usable += 1;
    const existing = byId.get(record.id);
    if (!existing || (record.timestamp ?? 0) >= (existing.timestamp ?? 0)) {
      byId.set(record.id, record);
    }
  }
  // GraphQL answers a failed field with null and an `errors` entry. A list that
  // is mostly such nulls is a failed answer, not a quiet country.
  if (errors > 0 && usable * 2 <= read.length) {
    throw new Error(
      `Entur vehicles response is partial: ${errors} errors, ${read.length - usable} of ${read.length} records unusable${errorReason(body)}`,
    );
  }
  return {
    version: null,
    timestamp: null,
    incrementality: GTFS_INCREMENTALITY_FULL_DATASET,
    entityCount: list.length,
    truncated,
    vehicles: [...byId.values()],
  };
}

/** The first GraphQL error's message as a log-safe suffix, or ''. */
function errorReason(body) {
  const reason = body?.errors?.[0]?.message;
  if (!reason) return '';
  return `: ${String(reason)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .slice(0, 120)}`;
}
