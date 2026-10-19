import * as Cesium from 'cesium';
import { SPEED_CAMERA_COLOR } from './policy.js';

export const OVERLAY_SOURCE_ID = 'speed-cameras';
export const OVERLAY_COHORT_LIMIT = 96;
export const OVERLAY_COLLISION_CAPACITY = 48;

/** Single accent for every camera: one category, one color. */
export function cameraAccent() {
  return Cesium.Color.fromCssColorString(SPEED_CAMERA_COLOR);
}

/**
 * Build the source-owned presentation for one ambient speed limit label.
 * @param {object} input
 * @param {string} input.id Stable record id (`speed-camera:<osm id>`).
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the marker.
 * @param {number|null} input.maxspeedKph Parsed limit, when tagged.
 * @param {string} input.accent Source-owned accent color.
 * @returns {object}
 */
export function createSpeedCameraOverlayEntry({
  id,
  position,
  maxspeedKph,
  accent,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: maxspeedKph != null ? `${maxspeedKph} km/h` : 'camera',
    accent,
    priority: 500,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the nearest cameras when a dense metro overflows the cohort. */
export function selectSpeedCameraOverlayCohort(
  entries,
  limit = OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Map one entity-backed record to a JSON-safe analyst record (analyst query
 * engine seam). Pure — no Cesium types. Missing fields stay null.
 * @param {object} raw - entity properties snapshot.
 * @returns {object}
 */
export function mapAnalystRecord(raw) {
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t && t !== 'undefined' && t !== 'null' ? t : null;
  };
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id: text(raw?.id),
    osmId: num(raw?.osmId),
    latitude: num(raw?.latitude),
    longitude: num(raw?.longitude),
    maxspeedKph: num(raw?.maxspeedKph),
    enforcement: text(raw?.enforcement),
    operator: text(raw?.operator),
    ref: text(raw?.ref),
    directionDeg: num(raw?.directionDeg),
    lastVerified: text(raw?.lastVerified),
    source: text(raw?.source),
  };
}
