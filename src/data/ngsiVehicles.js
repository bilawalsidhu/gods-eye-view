/**
 * @module ngsiVehicles
 * @description Decoder for FIWARE NGSI v2 `Vehicle` entities (the Smart Data
 * Models schema) into the same vehicle records the GTFS-Realtime decoder
 * produces, so the Transit layer never learns that a feed was not GTFS-RT.
 *
 * NGSI v2 `GET /v2/entities` answers with a JSON array. Each attribute is
 * normally wrapped as `{ type, value, metadata }`; `options=keyValues` brokers
 * send the bare value instead, and both are read here. Fields used:
 *
 *   fleetVehicleId      the number on the bus (falls back to the entity id)
 *   location            GeoJSON Point, `[lon, lat]`
 *   bearing / heading   degrees clockwise from north
 *   speed               m/s, the Smart Data Models unit
 *   observationDateTime ISO 8601 time of the fix
 *   annotations         operator tags, e.g. `stcp:route:200`, `stcp:sentido:0`
 *
 * The same ceilings the protobuf decoder applies hold here: entities past
 * `GTFS_MAX_ENTITIES` are not read, and a record with any string over
 * `GTFS_MAX_STRING_CHARS` is dropped whole, never truncated. The body itself
 * is already capped by the proxy before it is parsed.
 *
 * Pure: safe to import from the browser layer, the proxy, and node:test.
 */

import {
  GTFS_INCREMENTALITY_FULL_DATASET,
  GTFS_MAX_ENTITIES,
  GTFS_MAX_STRING_CHARS,
  isPlausibleVehiclePosition,
} from './gtfsRealtime.js';

/** Strict ISO 8601 date-time with an explicit zone; anything else is no time. */
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** `<operator>:route:<id>` — the route tag in an annotation list. */
const ROUTE_ANNOTATION = /^[a-z0-9_-]{1,32}:route:(.+)$/i;
/** `<operator>:sentido:<0|1>` (Portuguese) or `:direction:` — the GTFS direction_id. */
const DIRECTION_ANNOTATION = /^[a-z0-9_-]{1,32}:(?:sentido|direction):([01])$/i;

/** Unwrap a normalized `{ type, value }` attribute, or pass a keyValues one through. */
function attributeValue(attribute) {
  if (attribute && typeof attribute === 'object' && 'value' in attribute) {
    return attribute.value;
  }
  return attribute;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A short, non-empty string, or null. A string past the ceiling marks the
 * record oversize so the caller drops it.
 */
function boundedString(value, flags) {
  if (typeof value === 'number' && Number.isFinite(value))
    value = String(value);
  if (typeof value !== 'string') return null;
  if (value.length > GTFS_MAX_STRING_CHARS) {
    flags.oversize = true;
    return null;
  }
  const text = value.trim();
  return text ? text : null;
}

/** Epoch seconds from a strict ISO 8601 string, or null. */
function isoToEpochSeconds(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return null;
  // Date.parse normalizes dates such as February 30 into another month.
  // Never turn an impossible operator observation into a live vehicle fix.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1])
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

/** Route id and direction from an operator's annotation tags. */
function readAnnotations(value, flags) {
  const out = { routeId: null, directionId: null };
  if (!Array.isArray(value)) return out;
  for (const tag of value.slice(0, 32)) {
    if (typeof tag !== 'string') continue;
    if (tag.length > GTFS_MAX_STRING_CHARS) {
      flags.oversize = true;
      return out;
    }
    const route = ROUTE_ANNOTATION.exec(tag);
    if (route && out.routeId === null) {
      out.routeId = boundedString(route[1], flags);
      continue;
    }
    const direction = DIRECTION_ANNOTATION.exec(tag);
    if (direction && out.directionId === null) {
      out.directionId = Number(direction[1]);
    }
  }
  return out;
}

/**
 * Flatten one NGSI v2 `Vehicle` entity into the record the Transit layer
 * renders, or null when it carries no usable position or identity.
 * @param {object} entity One element of the `/v2/entities` array.
 * @returns {object|null}
 */
export function normalizeNgsiVehicle(entity) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    return null;
  }
  const flags = { oversize: false };
  const location = attributeValue(entity.location);
  const coordinates =
    location && location.type === 'Point' && Array.isArray(location.coordinates)
      ? location.coordinates
      : null;
  const lon = finiteOrNull(coordinates?.[0]);
  const lat = finiteOrNull(coordinates?.[1]);
  if (!isPlausibleVehiclePosition(lat, lon)) return null;
  const fleetId = boundedString(attributeValue(entity.fleetVehicleId), flags);
  const id = fleetId || boundedString(entity.id, flags);
  const { routeId, directionId } = readAnnotations(
    attributeValue(entity.annotations),
    flags,
  );
  if (flags.oversize || !id) return null;
  const bearing =
    finiteOrNull(attributeValue(entity.bearing)) ??
    finiteOrNull(attributeValue(entity.heading));
  const speed = finiteOrNull(attributeValue(entity.speed));
  return {
    id,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    bearing: bearing === null ? null : ((bearing % 360) + 360) % 360,
    speedMps: speed === null || speed < 0 ? null : speed,
    timestamp: isoToEpochSeconds(attributeValue(entity.observationDateTime)),
    routeId,
    tripId: null,
    directionId,
    label: fleetId,
    stopId: null,
    status: null,
    occupancy: null,
  };
}

/**
 * Decode an NGSI v2 entity array into the shape `decodeVehiclePositions`
 * returns. An NGSI query answers with the whole current state, never a diff,
 * so the snapshot is always a full dataset.
 *
 * A body that is not JSON, or not an array, throws a plain Error: to the proxy
 * that is an upstream failure (serve stale, back off), not a feed that has
 * changed shape under us.
 *
 * @param {Uint8Array|ArrayBuffer|string} bytes Raw response body.
 * @returns {{ version: string|null, timestamp: number|null, incrementality: number,
 *   entityCount: number, truncated: boolean, vehicles: object[] }}
 */
export function decodeNgsiVehicles(bytes) {
  const text =
    typeof bytes === 'string'
      ? bytes
      : new TextDecoder('utf-8').decode(
          bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        );
  let entities;
  try {
    entities = JSON.parse(text);
  } catch {
    throw new Error('upstream body is not JSON');
  }
  if (!Array.isArray(entities)) {
    throw new Error('upstream body is not an NGSI entity array');
  }
  const truncated = entities.length > GTFS_MAX_ENTITIES;
  const byId = new Map();
  for (const entity of entities.slice(0, GTFS_MAX_ENTITIES)) {
    const record = normalizeNgsiVehicle(entity);
    if (!record) continue;
    const existing = byId.get(record.id);
    if (!existing || (record.timestamp ?? 0) >= (existing.timestamp ?? 0)) {
      byId.set(record.id, record);
    }
  }
  return {
    version: null,
    timestamp: null,
    incrementality: GTFS_INCREMENTALITY_FULL_DATASET,
    entityCount: entities.length,
    truncated,
    vehicles: [...byId.values()],
  };
}
