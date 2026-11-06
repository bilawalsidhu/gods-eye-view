/**
 * The area a Data Library layer covers, for "Zoom to layer". Pure: no
 * Cesium, so the server, tests and the browser share it.
 *
 * An extent is `{ west, south, east, north }` in degrees. `east` may exceed
 * 180 when the set crosses the antimeridian (Fiji, the Aleutians), so the
 * shorter way round is kept rather than a box spanning the whole planet.
 */

/** The whole world, short of the poles a Web Mercator map cannot show. */
export const WORLD_EXTENT = Object.freeze({
  west: -180,
  south: -85,
  east: 180,
  north: 85,
});
/** Smallest box a zoom frames, so a single point is not a ground-level dive. */
export const MIN_EXTENT_SPAN_DEG = 0.05;

function visit(coordinates, push) {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === 'number') {
    const [lon, lat] = coordinates;
    if (
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90
    )
      push(lon, lat);
    return;
  }
  for (const child of coordinates) visit(child, push);
}

/**
 * The bounding box of GeoJSON features, taking the shorter way round the
 * antimeridian.
 * @param {Array<{ geometry?: { coordinates?: unknown } }>} features
 * @returns {{ west: number, south: number, east: number, north: number } | null}
 */
export function featureExtent(features) {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  // The same longitudes shifted to 0–360, for sets that straddle ±180.
  let westShifted = Infinity;
  let eastShifted = -Infinity;
  let count = 0;
  for (const feature of features || [])
    visit(feature?.geometry?.coordinates, (lon, lat) => {
      count += 1;
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      const shifted = lon < 0 ? lon + 360 : lon;
      westShifted = Math.min(westShifted, shifted);
      eastShifted = Math.max(eastShifted, shifted);
    });
  if (!count) return null;
  // A set that straddles ±180 is narrower in 0–360 terms; `east` then
  // exceeds 180 (all-negative longitudes never take this branch).
  if (eastShifted - westShifted < east - west)
    return { west: westShifted, south, east: eastShifted, north };
  return { west, south, east, north };
}

/** A manifest's declared coverage as an extent (the world when global). */
export function coverageExtent(entry) {
  const bbox = entry?.coverage?.bbox;
  if (!entry?.coverage?.global && Array.isArray(bbox) && bbox.length === 4) {
    const [west, south, east, north] = bbox;
    return { west, south, east, north };
  }
  return { ...WORLD_EXTENT };
}

/**
 * Grow a box to at least `minSpan` degrees each way and clamp it to what the
 * map can frame.
 * @param {{ west: number, south: number, east: number, north: number }} extent
 * @param {number} [minSpan]
 */
export function padExtent(extent, minSpan = MIN_EXTENT_SPAN_DEG) {
  const grow = (low, high) => {
    const missing = Math.max(0, minSpan - (high - low)) / 2;
    return [low - missing, high + missing];
  };
  const [west, east] = grow(extent.west, extent.east);
  const [south, north] = grow(extent.south, extent.north);
  return {
    west,
    east,
    south: Math.max(WORLD_EXTENT.south, south),
    north: Math.min(WORLD_EXTENT.north, north),
  };
}

/** Whether a box is so wide the zoom should show the whole globe instead. */
export function isWorldScale(extent) {
  return extent.east - extent.west >= 300;
}
