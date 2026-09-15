import { QUERY_LIMIT, QUERY_SNAP_DEGREES } from './policy.js';

export function textTag(value) {
  const t = String(value ?? '').trim();
  return t || null;
}

export function numTag(value) {
  // `Number('')` and `Number('   ')` are 0, not NaN — a blank or whitespace-only
  // tag value must read as missing, never as a due-north bearing.
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Snap a viewport box OUTWARD to the query grid, clamped to valid ranges.
 * Pure so the reuse contract is pinnable.
 * @param {{south:number,west:number,north:number,east:number}} box
 * @param {number} [step=QUERY_SNAP_DEGREES]
 */
export function snapAlprBox(box, step = QUERY_SNAP_DEGREES) {
  const down = (v) => Math.floor(v / step) * step;
  const up = (v) => Math.ceil(v / step) * step;
  return {
    south: Math.max(-90, down(box.south)),
    west: Math.max(-180, down(box.west)),
    north: Math.min(90, up(box.north)),
    east: Math.min(180, up(box.east)),
  };
}

/** Whether `inner` lies entirely within `outer` (no dateline handling; the viewport gate already rejects east <= west). */
export function boxContains(outer, inner) {
  if (!outer || !inner) return false;
  return (
    inner.south >= outer.south &&
    inner.north <= outer.north &&
    inner.west >= outer.west &&
    inner.east <= outer.east
  );
}

/**
 * Backoff progression for the unavailable-state retry: 30 s, doubling to a
 * 240 s ceiling. Pure so the progression is pinnable without booting the layer.
 */
export function alprRetryDelayMs(prevDelayMs) {
  const RETRY_MIN_MS = 30000;
  const RETRY_CEIL_MS = 240000;
  if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
  return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
}

/**
 * Whether a `surveillance:type` value denotes an ALPR camera. OSM allows
 * semicolon multi-values (`camera;ALPR`) and mixed case, so an exact match
 * would silently miss tagged cameras.
 * @param {*} value - raw `surveillance:type` tag value
 * @returns {boolean}
 */
export function isAlprSurveillanceType(value) {
  return String(value ?? '')
    .split(';')
    .some((part) => part.trim().toUpperCase() === 'ALPR');
}

/** Map one raw Overpass node element to a plain camera record. Null for anything unusable. */
export function normalizeAlprNode(el) {
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
  if (!isAlprSurveillanceType(tags['surveillance:type'])) return null;
  return {
    id: `alpr:${el.id}`,
    osmId: el.id,
    latitude: el.lat,
    longitude: el.lon,
    operator: textTag(tags.operator),
    manufacturer: textTag(tags.manufacturer),
    cameraType: textTag(tags['camera:type']),
    zone: textTag(tags['surveillance:zone']),
    // Only numeric bearings are parsed; compass-word directions ("N"/"NE")
    // are rare on this tag and simply render with no facing line.
    directionDeg: normalizeDirection(
      tags['camera:direction'] ?? tags.direction,
    ),
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
 * Overpass QL for the viewport. The tag match is a case-insensitive regex, not
 * an exact `="ALPR"`, because OSM semicolon multi-values such as
 * `surveillance:type=camera;ALPR` are common and an exact match drops them.
 * Exported so the query shape is pinnable.
 */
export function buildOverpassQuery(south, west, north, east) {
  return (
    `[out:json][timeout:20];node["man_made"="surveillance"]["surveillance:type"~"(^|;)\\s*ALPR\\s*(;|$)",i]` +
    `(${south},${west},${north},${east});out body ${QUERY_LIMIT};`
  );
}

/** Validate a source-independent snapshot before replacing the accepted display. */
export function validateAlprSnapshot(snapshot) {
  if (
    !Array.isArray(snapshot?.records) ||
    typeof snapshot.stale !== 'boolean' ||
    typeof snapshot.saturated !== 'boolean'
  ) {
    throw new TypeError('Camera source returned an invalid snapshot');
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
          record.directionDeg >= 360))
    ) {
      throw new TypeError('Camera source returned an invalid record');
    }
    ids.add(record.id);
  }
  return snapshot;
}
