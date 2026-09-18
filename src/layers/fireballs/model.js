import * as Cesium from 'cesium';
export const FIREBALL_OVERLAY_SOURCE_ID = 'fireballs';
export const FIREBALL_OVERLAY_COHORT_LIMIT = 96;
export const FIREBALL_OVERLAY_COLLISION_CAPACITY = 48;
// How far back a fireball keeps rendering before it drops out of the
// snapshot on the next poll — the feed itself is a rolling recent window,
// this just keeps the displayed set from creeping past "recent".
export const FIREBALL_MAX_AGE_MS = 365 * 24 * 3600_000;

/**
 * Color by approximate impact energy (kilotons of TNT-equivalent):
 *  - Sub-kiloton (<0.05 kt): faint yellow — routine small bolides.
 *  - Small (0.05-1 kt): orange.
 *  - Significant (>=1 kt): red — Chelyabinsk-class and larger.
 */
export function energyColor(impactKt) {
  const kt = Number(impactKt) || 0;
  if (kt >= 1) return Cesium.Color.RED;
  if (kt >= 0.05) return Cesium.Color.ORANGE;
  return Cesium.Color.YELLOW;
}

/** Format kt for display, switching to tonnes below 0.01 kt so it never reads as "0.0". */
export function formatImpactEnergy(impactKt) {
  const kt = Number(impactKt);
  if (!Number.isFinite(kt) || kt <= 0) return null;
  if (kt < 0.01) return `${Math.round(kt * 1000)} t`;
  return `${kt < 1 ? kt.toFixed(2) : kt.toFixed(1)} kt`;
}

/**
 * Build the source-owned presentation for one ambient fireball label.
 * @param {object} input
 * @param {string} input.id Stable deterministic id.
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the marker.
 * @param {number|null} input.impactKt Approximate impact energy in kilotons.
 * @param {string} input.accent Source-owned energy-band color.
 */
export function createFireballOverlayEntry({ id, position, impactKt, accent }) {
  const formatted = formatImpactEnergy(impactKt);
  const kt = Number(impactKt) || 0;
  return {
    id: String(id),
    position,
    variant: 'label',
    title: formatted ? `☄ ${formatted}` : '☄ fireball',
    accent,
    priority: Math.round(kt * 1000),
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

/** Keep the highest-energy events, with stable identity as the tie-break. */
export function selectFireballOverlayCohort(
  entries,
  limit = FIREBALL_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(FIREBALL_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
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
 * Map one fireball's raw plain values to a JSON-safe analyst record (analyst
 * query engine seam). Pure — no Cesium types. Missing/unknown fields are
 * null, never NaN/undefined.
 * @param {Object|null|undefined} raw - {id, impactKt, energyE10J, altKm, velKmS, lat, lon, timeMs}.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(raw?.id) || `FIREBALL-${String(index).padStart(4, '0')}`,
    impactEnergyKt: num(raw?.impactKt),
    radiatedEnergyE10J: num(raw?.energyE10J),
    altitudeKm: num(raw?.altKm),
    velocityKmS: num(raw?.velKmS),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    timeMs: num(raw?.timeMs),
  };
}

export { normalizeFireballSnapshot } from './records.js';
