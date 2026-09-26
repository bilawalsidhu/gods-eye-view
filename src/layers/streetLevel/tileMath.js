/**
 * Web-Mercator tile arithmetic for Mapillary vector tiles. Pure functions,
 * no Cesium dependency, shared by the browser layer and the server executor.
 */

const MAX_LAT = 85.05112878;

function clampLat(lat) {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** Tile column for a longitude at zoom z. */
export function lonToTileX(lon, z) {
  const n = 2 ** z;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Math.min(n - 1, Math.max(0, Math.floor(((wrapped + 180) / 360) * n)));
}

/** Tile row for a latitude at zoom z. */
export function latToTileY(lat, z) {
  const n = 2 ** z;
  const rad = (clampLat(lat) * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  );
  return Math.min(n - 1, Math.max(0, y));
}

/** West longitude of tile column x at zoom z. */
function tileXToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}

/** North latitude of tile row y at zoom z. */
function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Geographic bounds of one tile.
 * @returns {{west:number,south:number,east:number,north:number}}
 */
export function tileBounds(x, y, z) {
  return {
    west: tileXToLon(x, z),
    east: tileXToLon(x + 1, z),
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
  };
}

/**
 * Normalize a bbox given as [west, south, east, north] (or an object) into
 * finite, ordered numbers. Returns null when the input is not a usable box.
 */
export function normalizeBbox(input) {
  const values = Array.isArray(input)
    ? input
    : input && typeof input === 'object'
      ? [input.west, input.south, input.east, input.north]
      : null;
  if (!values || values.length !== 4) return null;
  const [w, s, e, n] = values.map(Number);
  if (![w, s, e, n].every(Number.isFinite)) return null;
  const west = Math.max(-180, Math.min(w, e));
  const east = Math.min(180, Math.max(w, e));
  const south = Math.max(-MAX_LAT, Math.min(s, n));
  const north = Math.min(MAX_LAT, Math.max(s, n));
  if (east - west <= 0 || north - south <= 0) return null;
  return { west, south, east, north };
}

/** Area of a bbox in square degrees (Mapillary's bbox limit unit). */
export function bboxAreaDeg2(bbox) {
  const box = normalizeBbox(bbox);
  return box ? (box.east - box.west) * (box.north - box.south) : 0;
}

/**
 * Number of tiles at zoom z covering a bbox, without allocating them.
 */
export function countTilesForBbox(bbox, z) {
  const box = normalizeBbox(bbox);
  if (!box) return 0;
  const x0 = lonToTileX(box.west, z);
  const x1 = lonToTileX(box.east, z);
  const y0 = latToTileY(box.north, z);
  const y1 = latToTileY(box.south, z);
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

/**
 * Enumerate the tiles at zoom z covering a bbox, ordered from the centre of
 * the box outwards so a progressive renderer fills in what the user is most
 * likely looking at first. `limit` caps the list; the result reports whether
 * the cap was hit.
 * @returns {{tiles: Array<{x:number,y:number,z:number}>, truncated: boolean, total: number}}
 */
export function tilesForBbox(bbox, z, { limit = Infinity } = {}) {
  const box = normalizeBbox(bbox);
  if (!box) return { tiles: [], truncated: false, total: 0 };
  const x0 = lonToTileX(box.west, z);
  const x1 = lonToTileX(box.east, z);
  const y0 = latToTileY(box.north, z);
  const y1 = latToTileY(box.south, z);
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const tiles = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) tiles.push({ x, y, z });
  tiles.sort(
    (a, b) =>
      (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2),
  );
  const truncated = tiles.length > limit;
  return { tiles: truncated ? tiles.slice(0, limit) : tiles, truncated, total };
}

/**
 * Convert a vector-tile-local coordinate (0..extent) into longitude and
 * latitude for tile (x, y, z).
 * @returns {[number, number]} [lon, lat]
 */
export function tileLocalToLonLat(px, py, extent, x, y, z) {
  const n = 2 ** z;
  const lon = ((x + px / extent) / n) * 360 - 180;
  const merc = Math.PI - (2 * Math.PI * (y + py / extent)) / n;
  const lat =
    (180 / Math.PI) * Math.atan(0.5 * (Math.exp(merc) - Math.exp(-merc)));
  return [lon, lat];
}

/**
 * Pick a coverage zoom for a camera height (metres above ground). Higher
 * cameras get coarser sequence tiles; below the floor Mapillary has no
 * finer tiles than z14.
 */
export function coverageZoomForHeight(heightM) {
  if (!Number.isFinite(heightM)) return null;
  if (heightM > 60_000) return null;
  if (heightM > 12_000) return 11;
  if (heightM > 5_000) return 12;
  if (heightM > 1_800) return 13;
  return 14;
}

/**
 * Pick the low-zoom `overview` tile level for a camera far above the ground.
 * Mapillary publishes coverage points at z0–5; sequences start at z6 and are
 * far too heavy for a continent-sized view. Returns null below the overview
 * ceiling (60 km), where `coverageZoomForHeight` takes over.
 */
export function overviewZoomForHeight(heightM) {
  if (!Number.isFinite(heightM) || heightM <= 60_000) return null;
  if (heightM > 15_000_000) return 0;
  if (heightM > 7_000_000) return 1;
  if (heightM > 3_000_000) return 2;
  if (heightM > 1_200_000) return 3;
  if (heightM > 400_000) return 4;
  return 5;
}
