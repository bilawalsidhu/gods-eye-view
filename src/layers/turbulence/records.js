/**
 * Normalize NOAA Aviation Weather Center turbulence products into one record
 * shape, shared by the proxy (server/providers/turbulence.js) and the layer.
 *
 * - G-AIRMET (product `tango`): US forecast areas valid at one moment each,
 *   base/top in hundreds of feet as strings (`"SFC"` for the surface).
 * - SIGMET: worldwide warnings valid over a period, base/top in feet.
 * - PIREP: pilot reports at a flight level in hundreds of feet.
 *
 * Individually invalid features are skipped; only a payload that is not a
 * feature collection at all is refused. Pure: no i18n catalog, no Cesium.
 */

import { ringAreaM2 } from '../../sources/featureGeometry.js';

export const TURBULENCE_SCHEMA_VERSION = 1;
export const FEET_TO_METERS = 0.3048;
/** Low/high split used by the altitude filter: FL180, as G-AIRMETs split. */
export const FL180_FT = 18_000;
/** A SIGMET with no stated top is drawn to this height and flagged. */
export const UNKNOWN_TOP_FT = 60_000;
/** Pilot reports older than this, at the time shown, are not drawn. */
export const REPORT_WINDOW_MS = 3 * 60 * 60 * 1000;

export const TURBULENCE_SEVERITIES = Object.freeze([
  'light',
  'moderate',
  'severe',
  'extreme',
]);
export const TURBULENCE_KINDS = Object.freeze([
  'forecast',
  'warning',
  'report',
]);

const MAX_FEATURES = 4000;
const MAX_RING_VERTICES = 256;
const MAX_RAW_CHARS = 600;
/** Rings smaller than this (m²) are slivers, not areas. */
const MIN_RING_AREA_M2 = 1_000;

const SEVERITY_RANK = Object.freeze({
  light: 1,
  moderate: 2,
  severe: 3,
  extreme: 4,
});
const INTENSITY_WORDS = Object.freeze({
  LGT: 'light',
  LIGHT: 'light',
  MOD: 'moderate',
  MODERATE: 'moderate',
  SEV: 'severe',
  SEVERE: 'severe',
  EXTRM: 'extreme',
  EXTREME: 'extreme',
  XTRM: 'extreme',
});

const textOrNull = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
};

/** Epoch ms from an ISO string, epoch seconds or epoch ms; else null. */
export function epochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value))
    return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The highest turbulence intensity a report or qualifier names, or null for
 * none, NEG or smooth air. Ranges (`LGT-MOD`, `MOD-SEV`) read as their
 * upper end; `SMTH-LGT` is light.
 */
export function turbulenceIntensity(text) {
  if (typeof text !== 'string') return null;
  let best = null;
  for (const word of text.toUpperCase().split(/[^A-Z]+/)) {
    const severity = INTENSITY_WORDS[word];
    if (severity && (!best || SEVERITY_RANK[severity] > SEVERITY_RANK[best]))
      best = severity;
  }
  return best;
}

/** 1 (light) to 4 (extreme); 0 for anything else. */
export const severityRank = (severity) => SEVERITY_RANK[severity] ?? 0;

/** `low`, `high` or `both`: which side(s) of FL180 a layer of air spans. */
export function altitudeBand(baseFt, topFt) {
  const low = baseFt < FL180_FT;
  const high = topFt > FL180_FT;
  return low && high ? 'both' : high ? 'high' : 'low';
}

/** Keep about `max` vertices of a closed ring, its closing point kept. */
function decimateRing(ring) {
  if (ring.length <= MAX_RING_VERTICES) return ring;
  const open = ring.slice(0, -1);
  const step = open.length / (MAX_RING_VERTICES - 1);
  const kept = [];
  for (let i = 0; i < MAX_RING_VERTICES - 1; i++)
    kept.push(open[Math.floor(i * step)]);
  kept.push(kept[0]);
  return kept;
}

/** A closed ring of finite [lon, lat] pairs, or null. */
function normalizeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3 || ring.length > 100_000)
    return null;
  const points = [];
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) return null;
    const lon = Number(position[0]);
    const lat = Number(position[1]);
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    points.push([lon, lat]);
  }
  const [firstLon, firstLat] = points[0];
  const [lastLon, lastLat] = points.at(-1);
  if (firstLon !== lastLon || firstLat !== lastLat)
    points.push([firstLon, firstLat]);
  if (points.length < 4) return null;
  return decimateRing(points);
}

/**
 * Polygon/MultiPolygon geometry as polygons of closed rings (outer first,
 * then holes). A polygon whose outer ring is invalid or a sliver is dropped;
 * an invalid hole is dropped alone. Returns [] when nothing usable remains.
 */
export function normalizePolygons(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return [];
  if (!Array.isArray(polygons)) return [];
  const result = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length) continue;
    const outer = normalizeRing(rings[0]);
    if (!outer || ringAreaM2(outer) < MIN_RING_AREA_M2) continue;
    const holes = rings
      .slice(1)
      .map(normalizeRing)
      .filter((ring) => ring && ringAreaM2(ring) >= MIN_RING_AREA_M2);
    result.push([outer, ...holes]);
  }
  return result;
}

/** G-AIRMET altitude: hundreds of feet as a string, or `SFC`. */
function gairmetFeet(value) {
  const text = textOrNull(typeof value === 'number' ? String(value) : value);
  if (!text) return null;
  if (text.toUpperCase() === 'SFC') return 0;
  if (!/^\d{1,3}$/.test(text)) return null;
  return Number(text) * 100;
}

const trimRaw = (value) => {
  const text = textOrNull(value);
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > MAX_RAW_CHARS
    ? `${flat.slice(0, MAX_RAW_CHARS - 1)}…`
    : flat;
};

function features(collection) {
  if (!Array.isArray(collection?.features)) return null;
  return collection.features.slice(0, MAX_FEATURES);
}

function uniqueId(ids, base) {
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}~${n}`;
  ids.add(id);
  return id;
}

/** FNV-1a, base 36: a short deterministic fingerprint of text. */
export function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Turbulence forecast areas from one G-AIRMET collection (one forecast
 * hour). Other Tango hazards (surface wind, LLWS) are skipped.
 * @returns {object[]|null} null when the payload is not a collection.
 */
export function normalizeGairmet(collection, { now = Date.now() } = {}) {
  const list = features(collection);
  if (!list) return null;
  const ids = new Set();
  const records = [];
  for (const feature of list) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object') continue;
    const hazard = textOrNull(p.hazard)?.toUpperCase();
    if (hazard !== 'TURB-HI' && hazard !== 'TURB-LO') continue;
    const validAt = epochMs(p.validTime);
    if (validAt === null || validAt < now - 12 * 3_600_000) continue;
    const baseFt = gairmetFeet(p.base);
    const topFt = gairmetFeet(p.top);
    if (baseFt === null || topFt === null || topFt <= baseFt) continue;
    const polygons = normalizePolygons(feature.geometry);
    if (!polygons.length) continue;
    records.push({
      id: uniqueId(
        ids,
        `forecast:${validAt}:${hazard}:${textOrNull(p.tag) || fingerprint(JSON.stringify(polygons))}`,
      ),
      kind: 'forecast',
      hazard,
      severity: turbulenceIntensity(p.severity) || 'moderate',
      band: hazard === 'TURB-LO' ? 'low' : altitudeBand(baseFt, topFt),
      baseFt,
      topFt,
      baseIsSurface: baseFt === 0,
      topUnknown: false,
      validAt,
      issuedAt: epochMs(p.issueTime),
      region: 'US',
      raw: null,
      polygons,
    });
  }
  return records;
}

/**
 * Turbulence and mountain-wave SIGMETs still in force at `now` (or starting
 * later). Other hazards are skipped.
 * @returns {object[]|null} null when the payload is not a collection.
 */
export function normalizeSigmets(collection, { now = Date.now() } = {}) {
  const list = features(collection);
  if (!list) return null;
  const ids = new Set();
  const records = [];
  for (const feature of list) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object') continue;
    const hazard = textOrNull(p.hazard)?.toUpperCase();
    if (hazard !== 'TURB' && hazard !== 'MTW') continue;
    const validFrom = epochMs(p.validTimeFrom);
    const validTo = epochMs(p.validTimeTo);
    if (validFrom === null || validTo === null || validTo <= validFrom)
      continue;
    if (validTo < now) continue;
    const base = Number(p.base);
    const baseFt = p.base == null || !Number.isFinite(base) ? 0 : base;
    const top = Number(p.top);
    const topUnknown = p.top == null || !Number.isFinite(top);
    const topFt = topUnknown ? UNKNOWN_TOP_FT : top;
    if (baseFt < 0 || topFt <= baseFt || topFt > 100_000) continue;
    const polygons = normalizePolygons(feature.geometry);
    if (!polygons.length) continue;
    const office = textOrNull(p.icaoId) || textOrNull(p.firId) || 'SIGMET';
    records.push({
      id: uniqueId(
        ids,
        `warning:${office}:${textOrNull(p.seriesId) || fingerprint(JSON.stringify(polygons))}:${validFrom}`,
      ),
      kind: 'warning',
      hazard,
      // A turbulence SIGMET is issued for severe turbulence; the qualifier
      // can only raise it.
      severity:
        turbulenceIntensity(p.qualifier) === 'extreme' ? 'extreme' : 'severe',
      band: altitudeBand(baseFt, topFt),
      baseFt,
      topFt,
      baseIsSurface: baseFt === 0,
      topUnknown,
      validFrom,
      validTo,
      issuedAt: null,
      region: textOrNull(p.firName) || textOrNull(p.firId),
      raw: trimRaw(p.rawSigmet),
      polygons,
    });
  }
  return records;
}

/**
 * Pilot reports of light or stronger turbulence within REPORT_WINDOW_MS
 * before `now`. Smooth-air (NEG) and icing-only reports are skipped.
 * @returns {object[]|null} null when the payload is not a collection.
 */
export function normalizePireps(collection, { now = Date.now() } = {}) {
  const list = features(collection);
  if (!list) return null;
  const ids = new Set();
  const records = [];
  for (const feature of list) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object') continue;
    const severity = turbulenceIntensity(
      [p.tbInt1, p.tbInt2].filter((v) => typeof v === 'string').join(' '),
    );
    if (!severity) continue;
    const coordinates = feature.geometry?.coordinates;
    if (feature.geometry?.type !== 'Point' || !Array.isArray(coordinates))
      continue;
    const lon = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) continue;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    const level = Number(p.fltlvl);
    if (p.fltlvl == null || !Number.isFinite(level) || level < 0 || level > 700)
      continue;
    const observedAt = epochMs(p.obsTime);
    if (observedAt === null) continue;
    if (observedAt < now - REPORT_WINDOW_MS || observedAt > now + 600_000)
      continue;
    const altitudeFt = level * 100;
    const raw = trimRaw(p.rawOb);
    records.push({
      id: uniqueId(
        ids,
        `report:${observedAt}:${fingerprint(raw || `${lon},${lat},${level}`)}`,
      ),
      kind: 'report',
      hazard: 'PIREP',
      severity,
      band: altitudeFt <= FL180_FT ? 'low' : 'high',
      baseFt: altitudeFt,
      topFt: altitudeFt,
      baseIsSurface: altitudeFt === 0,
      topUnknown: false,
      observedAt,
      region: textOrNull(p.icaoId),
      aircraft: textOrNull(p.acType),
      raw,
      lon,
      lat,
    });
  }
  return records;
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const validPolygons = (polygons) =>
  Array.isArray(polygons) &&
  polygons.length > 0 &&
  polygons.every(
    (rings) =>
      Array.isArray(rings) &&
      rings.length > 0 &&
      rings.every(
        (ring) =>
          Array.isArray(ring) &&
          ring.length >= 4 &&
          ring.length <= MAX_RING_VERTICES &&
          ring.every(
            (point) =>
              Array.isArray(point) &&
              finite(point[0]) &&
              finite(point[1]) &&
              Math.abs(point[0]) <= 180 &&
              Math.abs(point[1]) <= 90,
          ),
      ),
  );

/** Whether one record from the proxy has the shape the layer draws. */
function validRecord(record, kind) {
  if (!record || typeof record !== 'object' || record.kind !== kind)
    return false;
  if (typeof record.id !== 'string' || !record.id) return false;
  if (!Object.hasOwn(SEVERITY_RANK, record.severity)) return false;
  if (!['low', 'high', 'both'].includes(record.band)) return false;
  if (!finite(record.baseFt) || !finite(record.topFt)) return false;
  if (record.topFt < record.baseFt) return false;
  if (kind === 'forecast')
    return finite(record.validAt) && validPolygons(record.polygons);
  if (kind === 'warning')
    return (
      finite(record.validFrom) &&
      finite(record.validTo) &&
      validPolygons(record.polygons)
    );
  return (
    finite(record.observedAt) &&
    finite(record.lon) &&
    finite(record.lat) &&
    Math.abs(record.lon) <= 180 &&
    Math.abs(record.lat) <= 90
  );
}

/**
 * Check a proxy response before the layer draws it: the envelope must be the
 * known schema; a record that does not fit is dropped rather than failing
 * the snapshot.
 * @throws {Error} when the payload is not a turbulence snapshot at all.
 */
export function validateTurbulenceSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed turbulence snapshot');
  if (value.schemaVersion !== TURBULENCE_SCHEMA_VERSION)
    throw new Error('Unsupported turbulence snapshot');
  const list = (key, kind) =>
    Array.isArray(value[key])
      ? value[key].slice(0, MAX_FEATURES).filter((r) => validRecord(r, kind))
      : [];
  return {
    schemaVersion: TURBULENCE_SCHEMA_VERSION,
    fetchedAt: finite(value.fetchedAt) ? value.fetchedAt : null,
    stale: value.stale === true,
    partial: value.partial === true,
    unavailable: value.unavailable === true,
    reason: textOrNull(value.reason),
    forecasts: list('forecasts', 'forecast'),
    warnings: list('warnings', 'warning'),
    reports: list('reports', 'report'),
  };
}
