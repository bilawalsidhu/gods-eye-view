/**
 * @module layers/vigicruesFloods/model
 *
 * Vigicrues flood-warning zones and river sensors, normalized. Pure — no
 * Cesium, no network.
 *
 * Two things are shown: the flood-warning ZONES (the polygons the operator
 * publishes for each vigilance entity) and the river SENSORS (hydro stations
 * with their positions and vigilance state).
 */
// A portable export (package.json): no i18n here. The labels stay English
// data; the Layers panel shows them translated.
const msg = (text) => text;

export const VIGICRUES_OVERLAY_SOURCE_ID = 'vigicrues-floods';
export const VIGICRUES_OVERLAY_COHORT_LIMIT = 48;
export const VIGICRUES_OVERLAY_COLLISION_CAPACITY = 32;

/**
 * The layer's own description of what it shows, so the row states the
 * coverage instead of implying it.
 */
export const VIGICRUES_DESCRIPTION = msg(
  'French flood-warning zones and river sensors · Vigicrues (France)',
);

/**
 * The vigilance levels the operator publishes, from calm to the worst.
 *
 * `NivInfViCr` is the level of the warning zone; a zone at level 3 is in
 * the highest vigilance band.
 */
export const VIGICRUES_LEVEL_COLORS = Object.freeze([
  Object.freeze({ id: 1, color: '#ffd43b', label: msg('Vigilance 1') }),
  Object.freeze({ id: 2, color: '#ff9f1c', label: msg('Vigilance 2') }),
  Object.freeze({ id: 3, color: '#e5383b', label: msg('Vigilance 3') }),
]);

/** The colour used for a zone whose level the feed does not name. */
export const VIGICRUES_UNKNOWN_COLOR = '#6b7785';

/** The geometry types the warning-zone feed publishes. */
export const VIGICRUES_ZONE_GEOMETRY_TYPES = Object.freeze([
  'MultiLineString',
  'MultiPolygon',
  'Polygon',
  'LineString',
]);

/** Accent colour for a vigilance level. */
export function vigicruesLevelColor(level) {
  const value = Number(level);
  if (!Number.isFinite(value)) return VIGICRUES_UNKNOWN_COLOR;
  return (
    VIGICRUES_LEVEL_COLORS.find((entry) => entry.id === value)?.color ||
    VIGICRUES_UNKNOWN_COLOR
  );
}

/** The label for a vigilance level. */
export function vigicruesLevelLabel(level) {
  const value = Number(level);
  if (!Number.isFinite(value)) return msg('Vigilance unknown');
  return (
    VIGICRUES_LEVEL_COLORS.find((entry) => entry.id === value)?.label ||
    msg('Vigilance unknown')
  );
}

/**
 * Validate the proxy's station payload.
 *
 * Atomic: a structurally broken payload returns null so the caller keeps
 * its last good snapshot. A station without coordinates is skipped.
 *
 * @param {object} payload The proxy's JSON body.
 * @returns {{stations: Array<object>, total: number, observedAt: number|null}|null}
 */
export function normalizeVigicruesStationPayload(payload) {
  if (!Array.isArray(payload?.stations)) return null;
  const stations = [];
  const seen = new Set();
  for (const raw of payload.stations) {
    const id = String(raw?.id ?? '').trim();
    const lon = Number(raw?.lon);
    const lat = Number(raw?.lat);
    if (!id) continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    stations.push({
      id,
      name: String(raw?.name ?? '').trim() || id,
      river: String(raw?.river ?? '').trim() || null,
      commune: String(raw?.commune ?? '').trim() || null,
      lon,
      lat,
      hasBulletin: raw?.hasBulletin === true,
      color: raw?.hasBulletin === true ? '#e5383b' : '#4cc9f0',
    });
  }
  const total = Number(payload?.total);
  const observedAt = Number(payload?.observedAt);
  return {
    stations,
    total: Number.isFinite(total) && total >= 0 ? total : stations.length,
    observedAt: Number.isFinite(observedAt) ? observedAt : null,
  };
}

/**
 * Validate the proxy's warning-zone payload.
 *
 * @param {object} payload The proxy's JSON body.
 * @returns {{zones: Array<object>, bbox: number[]|null}|null} Null when
 *   malformed.
 */
export function normalizeVigicruesZonePayload(payload) {
  if (!Array.isArray(payload?.zones)) return null;
  const zones = [];
  const seen = new Set();
  for (const raw of payload.zones) {
    const id = String(raw?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const geometry = raw?.geometry ?? null;
    // A zone without geometry cannot be drawn; drop it rather than
    // publishing an anchor with no shape.
    if (!geometry || typeof geometry !== 'object') continue;
    const type = String(geometry.type || '');
    if (!VIGICRUES_ZONE_GEOMETRY_TYPES.includes(type)) continue;
    if (!Array.isArray(geometry.coordinates)) continue;
    const level = Number(raw?.level);
    zones.push({
      id,
      label: String(raw?.label ?? '').trim() || id,
      territory: String(raw?.territory ?? '').trim() || null,
      level: Number.isFinite(level) ? level : null,
      color: vigicruesLevelColor(level),
      geometry,
    });
  }
  const bbox = Array.isArray(payload?.bbox) ? payload.bbox : null;
  return { zones, bbox };
}

/**
 * Map one station to a JSON-safe analyst record.
 * @param {object|null|undefined} raw
 * @param {number} [index=0]
 * @returns {object}
 */
export function mapVigicruesStationRecord(raw, index = 0) {
  const text = (value) => {
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
  };
  const num = (value) => (Number.isFinite(value) ? value : null);
  return {
    id: text(raw?.id) || `VIG-${String(index).padStart(4, '0')}`,
    name: text(raw?.name),
    river: text(raw?.river),
    commune: text(raw?.commune),
    hasBulletin: raw?.hasBulletin === true,
    lat: num(raw?.lat),
    lon: num(raw?.lon),
  };
}

/**
 * Build the source-owned presentation for one sensor label.
 * @param {object} input
 * @returns {object}
 */
export function createVigicruesOverlayEntry({ id, position, title, accent }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority: 0,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep a bounded cohort of labels, with stable identity as the tie-break. */
export function selectVigicruesOverlayCohort(
  entries,
  limit = VIGICRUES_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(VIGICRUES_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, cap);
}

/**
 * The colour a vigilance level is drawn in. Re-exported under a short name
 * so the layer's legend can use it directly.
 * @param {number|null|undefined} level
 * @returns {string} CSS colour.
 */
export function zoneColor(level) {
  return vigicruesLevelColor(level);
}

/**
 * Flatten one zone's GeoJSON geometry into the list of linestrings it
 * contains.
 *
 * The warning-zone feed publishes MultiLineString geometry: each vigilance
 * entity is a set of river-course segments. A polygon would be returned as
 * its rings, so one helper covers every shape the feed uses.
 *
 * @param {object|null|undefined} geometry A GeoJSON geometry.
 * @returns {Array<Array<{lon: number, lat: number}>>} One entry per line.
 */
export function zoneLines(geometry) {
  const type = String(geometry?.type || '');
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates)) return [];
  const toLine = (raw) => {
    if (!Array.isArray(raw)) return [];
    const line = [];
    for (const point of raw) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const lon = Number(point[0]);
      const lat = Number(point[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
      line.push({ lon, lat });
    }
    return line;
  };
  if (type === 'LineString') {
    const line = toLine(coordinates);
    return line.length ? [line] : [];
  }
  if (type === 'MultiLineString') {
    return coordinates.map(toLine).filter((line) => line.length >= 2);
  }
  if (type === 'Polygon') {
    // A polygon's rings are closed; the first is the outline.
    const line = toLine(coordinates[0]);
    return line.length >= 2 ? [line] : [];
  }
  if (type === 'MultiPolygon') {
    return coordinates
      .map((polygon) => toLine(polygon?.[0]))
      .filter((line) => line.length >= 2);
  }
  return [];
}
