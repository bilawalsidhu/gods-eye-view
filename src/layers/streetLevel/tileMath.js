/** Web-Mercator tile math for Street Level coverage, without Cesium. */

const MAX_LAT = 85.05112878;

function clampLat(lat) {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

/** Wrap a longitude, or a difference of two, into [-180, 180]: the short way round. */
export function wrapLon(lon) {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Fractional tile column of a longitude in [-180, 180] at zoom z. */
function tileXAt(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Fractional tile row of a latitude at zoom z. */
function tileYAt(lat, z) {
  const rad = (clampLat(lat) * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
  );
}

export function lonToTileX(lon, z) {
  const n = 2 ** z;
  // 180° is the east edge of the last column, not the west edge of the first.
  if (lon >= 180) return n - 1;
  return Math.min(n - 1, Math.max(0, Math.floor(tileXAt(wrapLon(lon), z))));
}

export function latToTileY(lat, z) {
  const n = 2 ** z;
  return Math.min(n - 1, Math.max(0, Math.floor(tileYAt(lat, z))));
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

/** @returns {{west:number,south:number,east:number,north:number}} degrees */
export function tileBounds(x, y, z) {
  return {
    west: tileXToLon(x, z),
    east: tileXToLon(x + 1, z),
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
  };
}

/** A [west, south, east, north] array or object as finite, ordered bounds; null if unusable. */
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

/**
 * Tiles at zoom z covering a [west, south, east, north] box (west > east
 * crosses the date line), nearest to `from` first (default: the box centre),
 * capped at `limit`. Distances are measured the short way round ±180°.
 * @param {{limit?: number, from?: {lon: number, lat: number}|null}} [options]
 * @returns {{tiles: Array<{x:number,y:number,z:number}>, truncated: boolean, total: number}}
 */
export function tilesForBbox(bbox, z, { limit = Infinity, from = null } = {}) {
  const [west, south, east, north] = Array.isArray(bbox)
    ? bbox.map(Number)
    : [];
  const across = west > east;
  // A box across the date line is split at ±180°.
  const halves = across
    ? [
        [west, south, 180, north],
        [-180, south, east, north],
      ]
    : [bbox];
  const tiles = halves
    .map(normalizeBbox)
    .filter(Boolean)
    .flatMap((box) => tileGrid(box, z));
  const n = 2 ** z;
  const centre = from || {
    lon: wrapLon(west + (east - west + (across ? 360 : 0)) / 2),
    lat: (south + north) / 2,
  };
  const cx = tileXAt(wrapLon(centre.lon), z);
  const cy = tileYAt(centre.lat, z);
  // Each tile's distance is computed once; ties keep their row order.
  const ranked = tiles
    .map((tile) => {
      const dx = Math.abs(tile.x + 0.5 - cx);
      const d = Math.min(dx, n - dx) ** 2 + (tile.y + 0.5 - cy) ** 2;
      return { tile, d };
    })
    .sort((a, b) => a.d - b.d)
    .map(({ tile }) => tile);
  const truncated = ranked.length > limit;
  return {
    tiles: truncated ? ranked.slice(0, limit) : ranked,
    truncated,
    total: ranked.length,
  };
}

/** The tiles at zoom z in a normalized box, row by row. */
function tileGrid(box, z) {
  const x0 = lonToTileX(box.west, z);
  const x1 = lonToTileX(box.east, z);
  const y0 = latToTileY(box.north, z);
  const y1 = latToTileY(box.south, z);
  const tiles = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) tiles.push({ x, y, z });
  return tiles;
}

/** A vector-tile-local coordinate (0..extent) in tile (x, y, z) as [lon, lat]. */
export function tileLocalToLonLat(px, py, extent, x, y, z) {
  const n = 2 ** z;
  const lon = ((x + px / extent) / n) * 360 - 180;
  const merc = Math.PI - (2 * Math.PI * (y + py / extent)) / n;
  const lat =
    (180 / Math.PI) * Math.atan(0.5 * (Math.exp(merc) - Math.exp(-merc)));
  return [lon, lat];
}

/** Sequence-tile zoom for a camera height above ground (m); Mapillary stops at z14. */
export function coverageZoomForHeight(heightM) {
  if (!Number.isFinite(heightM)) return null;
  if (heightM > 60_000) return null;
  if (heightM > 12_000) return 11;
  if (heightM > 5_000) return 12;
  if (heightM > 1_800) return 13;
  return 14;
}
