import { densifyRhumb } from '../../geo/rhumb.js';
import { greatCircleKm } from '../../geoDistance.js';
import {
  featureLabel,
  featureReference,
  geometryParts,
  normalizeFeatures,
} from './geometry.js';

/** Target maximum spacing along a cable, in km. */
const PART_SPACING_KM = 40;
/** Keep a sample when a detour adds at least this much travel, in km. */
const PART_DETOUR_KM = 5;
const DEGREES = 180 / Math.PI;
const RADIANS = Math.PI / 180;

/**
 * Points along each line of a cable feature, spaced by route distance.
 * Long rhumb legs are split and close vertices are thinned, keeping each
 * line's ends and significant detours. Nearby measures a cable to the nearest
 * of these.
 * @returns {Array<{lat: number, lon: number}>}
 */
export function cableLinePoints(feature) {
  const out = [];
  for (const line of geometryParts(feature?.geometry).lines) {
    const path = [];
    for (const coordinate of line ?? []) {
      const lon = Number(coordinate?.[0]);
      const lat = Number(coordinate?.[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat))
        path.push({ lon: lon * RADIANS, lat: lat * RADIANS, at: { lat, lon } });
    }
    if (!path.length) continue;
    // The line's own vertices keep their exact degrees.
    const dense = densifyRhumb(path, PART_SPACING_KM * 1000).map(
      (point) =>
        point.at || { lat: point.lat * DEGREES, lon: point.lon * DEGREES },
    );
    out.push(dense[0]);
    let kmSinceSample = 0;
    for (let i = 1; i < dense.length; i++) {
      const stepKm = greatCircleKm(dense[i - 1], dense[i]);
      const routeKm = kmSinceSample + stepKm;
      if (
        kmSinceSample > 0 &&
        (routeKm > PART_SPACING_KM ||
          routeKm - greatCircleKm(out.at(-1), dense[i]) >= PART_DETOUR_KM)
      ) {
        out.push(dense[i - 1]);
        kmSinceSample = stepKm;
      } else {
        kmSinceSample = routeKm;
      }
    }
    if (dense.length > 1) out.push(dense.at(-1));
  }
  return out;
}

/** A record can use a drawn line even when there is no map label point. */
export function cableRecordReference(feature) {
  const reference = featureReference(feature);
  if (reference) return reference;
  for (const line of geometryParts(feature?.geometry).lines) {
    for (const coordinate of line ?? []) {
      const lon = Number(coordinate?.[0]);
      const lat = Number(coordinate?.[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat };
    }
  }
  return null;
}

/**
 * A cable's representative point: the vertex of its drawn line nearest the
 * point its label stands on (TeleGeography's own label point when the
 * feature carries one, else the average of its vertices). It lies on the
 * cable, which the average of a long cable's vertices often does not.
 */
export function cableRepresentativePoint(feature) {
  const reference = cableRecordReference(feature);
  if (!reference) return null;
  const cosLat = Math.cos((reference.lat * Math.PI) / 180);
  let best = null;
  let bestD = Infinity;
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] !== 'number') {
      for (const child of value) visit(child);
      return;
    }
    const [lon, lat] = value;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const dLon = (((lon - reference.lon + 540) % 360) - 180) * cosLat;
    const d = dLon * dLon + (lat - reference.lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { lon, lat };
    }
  };
  visit(feature?.geometry?.coordinates);
  return best || reference;
}

/** Records built from one pair of fetched collections, kept with them. */
const built = new WeakMap();

/**
 * The cables and landing points the layer drew, as plain records for the
 * analyst and the Context panel: one per cable (at its first feature's
 * representative point, above) and one per landing point (at the landing).
 * `feature` says which. A cable is one record however many features and
 * lines it is drawn as: `parts` lists points along every line of every
 * feature (cableLinePoints), so Nearby and In View find it by its nearest
 * stretch. Ids are prefixed by what they are, since a cable and a landing
 * can share TeleGeography's id. Built once per fetched dataset, then
 * reused; `parts` and its points are frozen and shared between calls.
 * @param {object} state The cable layer's state.
 * @param {number} [maxCount]
 * @returns {Array<object>}
 */
export function cableAnalystRecords(state, maxCount = Infinity) {
  if (!state?._enabled || !state._loaded) return [];
  const cables = state._cachedCableJson;
  const landings = state._cachedLandingJson;
  if (!cables || !landings) return [];
  let records = built.get(cables)?.landings === landings && built.get(cables);
  if (!records) {
    records = { landings, list: [] };
    const byCable = new Map();
    for (const feature of normalizeFeatures(cables, 'cable')) {
      const at = cableRepresentativePoint(feature);
      if (!at) continue;
      // The cable's own id (its pieces share it), else its name.
      const cable = feature.id || featureLabel(feature);
      const points = cableLinePoints(feature);
      const known = byCable.get(cable);
      if (known) {
        known.parts.push(...points);
        continue;
      }
      const record = {
        id: `cable:${cable}`,
        name: featureLabel(feature) || null,
        feature: 'cable',
        lat: at.lat,
        lon: at.lon,
        parts: points,
      };
      byCable.set(cable, record);
      records.list.push(record);
    }
    for (const record of records.list) {
      for (const part of record.parts) Object.freeze(part);
      Object.freeze(record.parts);
    }
    const landingIds = new Set();
    for (const feature of normalizeFeatures(landings, 'landing')) {
      const at = featureReference(feature);
      if (!at || landingIds.has(feature.id)) continue;
      landingIds.add(feature.id);
      records.list.push({
        id: `landing:${feature.id}`,
        name: featureLabel(feature) || null,
        feature: 'landing point',
        lat: at.lat,
        lon: at.lon,
        planned: feature?.properties?.is_tbd === true,
      });
    }
    built.set(cables, records);
  }
  const limit = Number.isFinite(maxCount)
    ? Math.max(0, Math.floor(maxCount))
    : records.list.length;
  // Copies (parts are frozen): a caller may not change what the next call
  // returns.
  return records.list.slice(0, limit).map((record) => ({ ...record }));
}
