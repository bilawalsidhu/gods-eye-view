/** Card model for one selected special-use airspace zone. Pure — no Cesium types. */

import { t } from '../../i18n/index.js';

export const DRONE_AIRSPACE_OVERLAY_SOURCE_ID = 'drone-airspace';

/** Fill/line CSS color for a zone by TYPE_CODE. */
export function droneAirspaceAccent(typeCode) {
  return typeCode === 'P' ? '#ff3b30' : '#ff7a00';
}

/** Shoelace area (degree², sign dropped) — relative sizes only. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/**
 * Anchor point for the zone card: the centroid of the largest polygon's
 * outer ring. Degrees, so callers own the Cartesian conversion.
 * @param {Array<Array<Array<[number, number]>>>} polygons
 * @returns {{lon: number, lat: number}}
 */
export function droneAirspaceAnchorDegrees(polygons) {
  let best = null;
  let bestArea = -1;
  for (const rings of polygons) {
    const outer = rings[0];
    const area = ringArea(outer);
    if (area > bestArea) {
      bestArea = area;
      best = outer;
    }
  }
  let lon = 0;
  let lat = 0;
  const count = best.length - 1;
  for (let i = 0; i < count; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  return { lon: lon / count, lat: lat / count };
}

function altitudeLine(row) {
  const lower = row.lowerAltitude;
  const upper = row.upperAltitude;
  if (lower && upper) return t('{lower} to {upper}', { lower, upper });
  if (upper) return t('Up to {upper}', { upper });
  if (lower) return t('From {lower}', { lower });
  return null;
}

function placeLine(row) {
  if (row.city && row.state) return `${row.city}, ${row.state}`;
  return row.city || row.state || null;
}

/**
 * Build the overlay-host entry for one selected zone. The caller supplies
 * `position` (Cartesian) separately — this model stays JSON-safe for tests.
 * @param {Object} row - Normalized zone row (see records.js).
 * @returns {Object} World-overlay entry without `position`.
 */
export function buildDroneAirspaceCard(row) {
  const facts = [row.type ? t(row.type) : row.typeCode].filter(Boolean);
  const altitude = altitudeLine(row);
  if (altitude) facts.push(altitude);
  if (row.timesOfUse) facts.push(row.timesOfUse);

  const details = [facts.join(' · ')];
  const place = placeLine(row);
  if (place) details.push(place);
  if (row.agency) details.push(row.agency);
  details.push(t('Informational only · not for flight planning'));

  const type = row.type ? t(row.type) : 'SUA';
  const title = `${type.toUpperCase()} · ${row.name || t('Unnamed zone')}`;
  return {
    id: `drone-airspace-card:${row.stableId}`,
    selected: true,
    interactive: false,
    title,
    details,
    accent: droneAirspaceAccent(row.typeCode),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
