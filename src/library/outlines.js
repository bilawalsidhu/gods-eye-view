/**
 * Coverage outlines for Data Library imagery: the borders of the countries an
 * entry covers, so the edge of an aerial photo layer is plain on the map.
 *
 * Borders come from the bundled Natural Earth 1:10m admin-0 countries pack
 * (public domain, pinned; see src/data/local_data/natural_earth/README.md),
 * read once the first outline needs it. Pure apart from
 * `loadCountryOutlines`.
 */
import { loadBundledJson } from '../data/bundledJson.js';
import { decodeRing } from '../data/adminBoundaries.js';

const COUNTRIES_PACK_URL = new URL(
  '../data/local_data/natural_earth/countries.json',
  import.meta.url,
);
/** Outline modes a manifest may ask for. */
export const OUTLINE_MODES = Object.freeze(['coverage', 'countries', 'bbox']);

let pending = null;

/**
 * Country features with closed outer rings, in the GeoJSON shape
 * `outlineRings` reads, loaded once per page.
 * @param {(url: URL) => Promise<object>} [loadPack]
 * @returns {Promise<object[]>}
 */
export function loadCountryOutlines(loadPack = loadBundledJson) {
  pending ||= (async () => {
    const pack = await loadPack(COUNTRIES_PACK_URL);
    if (!Array.isArray(pack?.features)) throw new Error('not a country pack');
    const decimals = pack.meta?.decimals;
    return pack.features.map((feature) => ({
      type: 'Feature',
      properties: { ISO_A2: feature.iso2 },
      geometry: {
        type: 'MultiPolygon',
        coordinates: (feature.polygons || []).map((polygon) =>
          polygon.map((encoded) => {
            const ring = decodeRing(encoded, feature.d ?? decimals);
            return ring.length ? [...ring, ring[0]] : ring;
          }),
        ),
      },
    }));
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
