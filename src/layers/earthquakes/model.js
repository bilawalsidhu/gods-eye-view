import * as Cesium from 'cesium';
export const EARTHQUAKE_OVERLAY_SOURCE_ID = 'earthquakes';
export const EARTHQUAKE_OVERLAY_COHORT_LIMIT = 96;
export const EARTHQUAKE_OVERLAY_COLLISION_CAPACITY = 48;

/**
 * The smallest magnitude the timeline marks. Most quakes are small shakes;
 * M6 and up come about once every two days worldwide, so each is an event
 * worth stepping to. The map still draws every quake.
 */
export const EARTHQUAKE_MARK_MAGNITUDE = 6;

/** The longest place a timeline mark's label carries, ellipsis and all. */
const MARK_PLACE_LENGTH = 40;

/** A magnitude as the map's labels show it: `M6.4`. */
export const earthquakeMagnitudeTitle = (magnitude) =>
  `M${Number(magnitude).toFixed(1)}`;

/**
 * A strong quake's timeline label: its magnitude and, where the feed names
 * one, its place, cut short (`M6.4 · 113 km SSE of Lata, Solomon Islands`).
 * @param {{mag: number, place?: string | null}} event
 * @returns {string}
 */
export function earthquakeMarkLabel({ mag, place }) {
  const title = earthquakeMagnitudeTitle(mag);
  const where =
    typeof place === 'string' ? place.replace(/\s+/g, ' ').trim() : '';
  if (!where) return title;
  const short =
    where.length > MARK_PLACE_LENGTH
      ? `${where.slice(0, MARK_PLACE_LENGTH - 1).trimEnd()}…`
      : where;
  return `${title} · ${short}`;
}

/**
 * The time a world clock's timeline can show for `events` (`{mag, time,
 * place?, usgsId?}`, time in ms): the span of the quakes of
 * EARTHQUAKE_MARK_MAGNITUDE and up, each one a mark labelled with its
 * magnitude and place, or null with none, so the layer never stretches the
 * timeline past what its feed covers.
 * @returns {{start: number, end: number, marks: Array<{time: number, label: string, id?: string, kind: string}>} | null}
 */
export function earthquakeCoverage(events) {
  const marks = events
    .filter(
      ({ mag, time }) =>
        mag >= EARTHQUAKE_MARK_MAGNITUDE && Number.isFinite(time),
    )
    .map((event) => ({
      time: event.time,
      label: earthquakeMarkLabel(event),
      ...(event.usgsId ? { id: String(event.usgsId) } : {}),
      kind: 'earthquake',
    }))
    .sort((a, b) => a.time - b.time);
  return marks.length
    ? { start: marks[0].time, end: marks.at(-1).time, marks }
    : null;
}

/**
 * Color by depth:
 *  - Shallow (<70km): Red
 *  - Intermediate (70-300km): Orange
 *  - Deep (>300km): Yellow
 */
export function depthColor(depthKm) {
  if (depthKm < 70) return Cesium.Color.RED;
  if (depthKm < 300) return Cesium.Color.ORANGE;
  return Cesium.Color.YELLOW;
}

/**
 * Build the source-owned presentation for one ambient magnitude label.
 * Magnitude formatting deliberately remains here instead of moving into the
 * shared renderer.
 * @param {object} input
 * @param {string} input.id Stable USGS or deterministic fallback id.
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the pulse.
 * @param {number} input.magnitude USGS magnitude.
 * @param {string} input.accent Source-owned depth-band color.
 * @returns {object}
 */
export function createEarthquakeOverlayEntry({
  id,
  position,
  magnitude,
  accent,
}) {
  const mag = Number(magnitude);
  return {
    id: String(id),
    position,
    variant: 'label',
    title: earthquakeMagnitudeTitle(mag),
    accent,
    priority: Math.round(mag * 1000),
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

/** Keep the largest events, with stable identity as the tie-break. */
export function selectEarthquakeOverlayCohort(
  entries,
  limit = EARTHQUAKE_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(EARTHQUAKE_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
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
 * Map one earthquake's raw plain values to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined. Falls back to an index-based id
 * when the USGS event id is absent.
 * @param {Object|null|undefined} raw - Plain values pulled off the entity:
 *   {id, mag, place, time, depth, lat, lon}.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {{id: string, magnitude: number|null, depthKm: number|null,
 *   lat: number|null, lon: number|null, timeMs: number|null, place: string|null}}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(raw?.id) || `QUAKE-${String(index).padStart(4, '0')}`,
    magnitude: num(raw?.mag),
    depthKm: num(raw?.depth),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    timeMs: num(raw?.time), // USGS epoch ms
    place: text(raw?.place),
  };
}

export { normalizeEarthquakeSnapshot } from './records.js';
