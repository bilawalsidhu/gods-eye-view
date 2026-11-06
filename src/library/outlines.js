/**
 * Coverage outlines for Data Library imagery: the borders of the countries an
 * entry covers, so the edge of an aerial photo layer is plain on the map.
 *
 * Borders come from Natural Earth's 1:50m admin-0 countries (public domain),
 * a provider-hosted file fetched live and kept for the session, so nothing is
 * bundled. Pure apart from `loadCountryOutlines`, which takes `fetchImpl`.
 */
import { readResponseTextCapped } from '../sources/httpBody.js';

export const COUNTRY_OUTLINES_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
/** The 1:50m file is about 3 MB. */
const OUTLINES_MAX_BYTES = 8 * 1024 * 1024;
/** Outline modes a manifest may ask for. */
export const OUTLINE_MODES = Object.freeze(['coverage', 'countries', 'bbox']);

let pending = null;

/**
 * Natural Earth country features, fetched once per page.
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<object[]>}
 */
export function loadCountryOutlines(
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  pending ||= (async () => {
    const response = await fetchImpl(COUNTRY_OUTLINES_URL, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await readResponseTextCapped(response, OUTLINES_MAX_BYTES);
    const features = JSON.parse(text)?.features;
    if (!Array.isArray(features)) throw new Error('not a FeatureCollection');
    return features;
  })().catch((error) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** For tests: forget the cached outlines. */
export function resetCountryOutlines() {
  pending = null;
}

const ringBox = (ring) => {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
};

const intersects = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/**
 * The outer rings to draw for an entry. `countries` draws every part of each
 * covered country; `coverage` only the parts inside the entry's coverage bbox
 * (the European Netherlands, not its Caribbean islands).
 * Natural Earth gives France and Norway ISO_A2 "-99"; ISO_A2_EH carries the
 * code, so both are read.
 * @param {object[]} features Natural Earth admin-0 features.
 * @param {object} entry Validated library entry with `display.outline`.
 * @returns {Array<Array<[number, number]>>}
 */
export function outlineRings(features, entry) {
  const box = entry?.coverage?.bbox;
  if (entry?.display?.outline === 'bbox')
    return box
      ? [
          [
            [box[0], box[1]],
            [box[2], box[1]],
            [box[2], box[3]],
            [box[0], box[3]],
            [box[0], box[1]],
          ],
        ]
      : [];
  const codes = new Set(entry?.coverage?.countries || []);
  const bbox = entry?.coverage?.bbox;
  const onlyInside = entry?.display?.outline === 'coverage' && bbox;
  const rings = [];
  for (const feature of features || []) {
    const properties = feature?.properties || {};
    const code = [properties.ISO_A2_EH, properties.ISO_A2].find(
      (value) => typeof value === 'string' && codes.has(value),
    );
    if (!code) continue;
    const { type, coordinates } = feature.geometry || {};
    const polygons =
      type === 'Polygon'
        ? [coordinates]
        : type === 'MultiPolygon'
          ? coordinates
          : [];
    for (const polygon of polygons) {
      const outer = polygon?.[0];
      if (!Array.isArray(outer) || outer.length < 3) continue;
      if (onlyInside && !intersects(ringBox(outer), bbox)) continue;
      rings.push(outer);
    }
  }
  return rings;
}
