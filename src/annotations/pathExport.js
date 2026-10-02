/**
 * Board export: the marks on the whiteboard as a GeoJSON file.
 *
 * Draw and the importer both put geometry ON the board; this takes it back
 * off, so a drawing outlives the session it was made in. The output is a plain
 * RFC 7946 FeatureCollection — lines, polygons and points with a `name` — which
 * any GIS tool reads and which `pathGeoJson.js` reads back, so Export followed
 * by Import returns the same shapes.
 *
 * It exports what the board holds as GEOMETRY: areas with an outline, routes,
 * and pins or point highlights. An arrow is a pointer between two places and a
 * label is a caption; neither is a shape someone would take to another map, so
 * they are left out and counted.
 *
 * No Cesium, no DOM.
 */

/**
 * @param {object[]} annotations The engine's `.list()`.
 * @returns {{geojson: object, exported: number, skipped: number}}
 */
export function annotationsToGeoJson(annotations) {
  const features = [];
  let skipped = 0;
  for (const anno of Array.isArray(annotations) ? annotations : []) {
    const geometry = geometryOf(anno);
    if (!geometry) {
      skipped += 1;
      continue;
    }
    const properties = { kind: anno.type };
    const name = nameOf(anno);
    if (name) properties.name = name;
    if (anno.color) properties.color = anno.color;
    features.push({ type: 'Feature', properties, geometry });
  }
  return {
    geojson: { type: 'FeatureCollection', features },
    exported: features.length,
    skipped,
  };
}

function geometryOf(anno) {
  if (!anno) return null;
  if (anno.type === 'route') {
    const coordinates = positions(anno.path);
    return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
  }
  if (anno.type === 'arrow' || anno.type === 'label') return null;
  const ring = positions(anno.ring);
  if (ring.length >= 3) return { type: 'Polygon', coordinates: [closed(ring)] };
  const anchor = position(anno.anchor);
  return anchor ? { type: 'Point', coordinates: anchor } : null;
}

/** [lon, lat] pairs from either `{lon, lat}` objects or pairs; unusable entries dropped. */
function positions(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const pair = position(entry);
    if (pair) out.push(pair);
  }
  return out;
}

function position(entry) {
  const lon = Array.isArray(entry) ? entry[0] : entry?.lon;
  const lat = Array.isArray(entry) ? entry[1] : entry?.lat;
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

/** RFC 7946 requires a linear ring to repeat its first position at the end. */
function closed(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1]
    ? ring
    : [...ring, [first[0], first[1]]];
}

/**
 * The mark's caption without the measurement the engine appended to a route
 * ("Ridge walk — 12 km" → "Ridge walk"). The distance is derived from the
 * geometry, so carrying it in the name would stack a second one on re-import.
 */
function nameOf(anno) {
  const label = typeof anno.label === 'string' ? anno.label.trim() : '';
  if (!label || anno.type !== 'route') return label;
  const measure = /^\d+(?:\.\d+)? k?m(?: · .*)?$/;
  if (measure.test(label)) return '';
  const cut = label.lastIndexOf(' — ');
  return cut > 0 && measure.test(label.slice(cut + 3))
    ? label.slice(0, cut)
    : label;
}

/**
 * `gods-eye-board-2026-10-02T14-05-09.geojson` — sortable, and safe on every
 * filesystem (no colons).
 * @param {Date} [now]
 * @returns {string}
 */
export function exportFileName(now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  return `gods-eye-board-${stamp}.geojson`;
}
