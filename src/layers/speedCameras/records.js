import { QUERY_LIMIT, QUERY_SNAP_DEGREES } from './policy.js';

export function textTag(value) {
  const t = String(value ?? '').trim();
  return t || null;
}

export function numTag(value) {
  // `Number('')` and `Number('   ')` are 0, not NaN — a blank tag value must
  // read as missing, never as a zero limit or due-north bearing.
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an OSM `maxspeed` tag to km/h. Plain numbers are km/h by OSM
 * convention; an explicit `mph` suffix converts. Walk/none values and other
 * non-numeric advisories read as missing rather than inventing a limit.
 * @param {*} value - raw `maxspeed` tag value.
 * @returns {number|null} km/h, or null when unparseable.
 */
export function parseMaxspeedKph(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const mph = /^(\d+(?:\.\d+)?)\s*mph$/.exec(raw);
  if (mph) return Math.round(Number(mph[1]) * 1.609344);
  const kph = numTag(raw);
  return kph != null && kph > 0 ? kph : null;
}

/**
 * Map one raw Overpass node element to a plain camera record, or null for
 * anything unusable. Only `highway=speed_camera` nodes are cameras — the query
 * selects them, and normalization re-asserts it so a future query change can
 * never quietly admit foreign elements.
 */
export function normalizeSpeedCameraNode(el) {
  if (
    !el ||
    el.type !== 'node' ||
    !Number.isSafeInteger(el.id) ||
    el.id <= 0 ||
    !Number.isFinite(el.lat) ||
    Math.abs(el.lat) > 90 ||
    !Number.isFinite(el.lon) ||
    Math.abs(el.lon) > 180
  )
    return null;
  const tags = el.tags || {};
  if (tags.highway !== 'speed_camera') return null;
  return {
    id: `speed-camera:${el.id}`,
    osmId: el.id,
    latitude: el.lat,
    longitude: el.lon,
    // Numeric bearings only; compass words ("N"/"NE") simply render unrotated.
    directionDeg: normalizeDirection(
      tags['camera:direction'] ?? tags.direction,
    ),
    maxspeedKph: parseMaxspeedKph(tags.maxspeed),
    enforcement: textTag(tags.enforcement),
    operator: textTag(tags.operator),
    ref: textTag(tags.ref),
    lastVerified: textTag(tags.check_date) || textTag(tags['survey:date']),
    source: textTag(tags.source),
  };
}

export function normalizeDirection(value) {
  const degrees = numTag(value);
  return degrees != null && degrees >= 0 && degrees <= 360
    ? degrees % 360
    : null;
}

/**
 * Snap a viewport box OUTWARD to the query grid, clamped to valid ranges.
 * Pure so the reuse contract is pinnable.
 * @param {{south:number,west:number,north:number,east:number}} box
 * @param {number} [step=QUERY_SNAP_DEGREES]
 */
export function snapSpeedCameraBox(box, step = QUERY_SNAP_DEGREES) {
  const down = (v) => Math.floor(v / step) * step;
  const up = (v) => Math.ceil(v / step) * step;
  return {
    south: Math.max(-90, down(box.south)),
    west: Math.max(-180, down(box.west)),
    north: Math.min(90, up(box.north)),
    east: Math.min(180, up(box.east)),
  };
}

/** Whether `inner` lies entirely within `outer` (the viewport gate already rejects east <= west). */
export function boxContains(outer, inner) {
  if (!outer || !inner) return false;
  return (
    inner.south >= outer.south &&
    inner.north <= outer.north &&
    inner.west >= outer.west &&
    inner.east <= outer.east
  );
}

/** Overpass QL for the viewport. Exported so the query shape is pinnable. */
export function buildSpeedCameraQuery(south, west, north, east) {
  return (
    `[out:json][timeout:20];node["highway"="speed_camera"]` +
    `(${south},${west},${north},${east});out body ${QUERY_LIMIT};`
  );
}

/**
 * Validate a source-independent snapshot before replacing the accepted
 * display: shape and per-record coordinates, plus duplicate ids (Overpass
 * dedupes by element, so a repeat id means a malformed payload).
 * @returns {{records: Array<object>, stale: boolean, saturated: boolean}}
 */
export function validateSpeedCameraSnapshot(snapshot) {
  if (
    !Array.isArray(snapshot?.records) ||
    typeof snapshot.stale !== 'boolean' ||
    typeof snapshot.saturated !== 'boolean'
  ) {
    throw new TypeError('Speed camera source returned an invalid snapshot');
  }
  const ids = new Set();
  for (const record of snapshot.records) {
    if (
      !record ||
      typeof record.id !== 'string' ||
      !record.id.trim() ||
      ids.has(record.id) ||
      !Number.isFinite(record.latitude) ||
      Math.abs(record.latitude) > 90 ||
      !Number.isFinite(record.longitude) ||
      Math.abs(record.longitude) > 180 ||
      (record.directionDeg != null &&
        (!Number.isFinite(record.directionDeg) ||
          record.directionDeg < 0 ||
          record.directionDeg >= 360)) ||
      (record.maxspeedKph != null &&
        (!Number.isFinite(record.maxspeedKph) || record.maxspeedKph <= 0))
    )
      throw new TypeError('Speed camera source returned an invalid record');
    ids.add(record.id);
  }
  return snapshot;
}
