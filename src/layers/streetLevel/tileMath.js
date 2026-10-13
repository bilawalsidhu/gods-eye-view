/** Web-Mercator tile math, without Cesium, shared by the browser layer and the server executor. */

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
 * Squared distance (in tiles) from tile (x, y)'s centre to the segment
 * `from` → `to` at zoom z, measured the short way round the date line.
 */
function segmentDistance2(tile, from, to, z) {
  const n = 2 ** z;
  const px = tile.x + 0.5;
  const py = tile.y + 0.5;
  const ax = tileXAt(from.lon, z);
  const ay = tileYAt(from.lat, z);
  let bx = to ? tileXAt(to.lon, z) : ax;
  const by = to ? tileYAt(to.lat, z) : ay;
  if (bx - ax > n / 2) bx -= n;
  else if (ax - bx > n / 2) bx += n;
  let best = Infinity;
  for (const shift of [-n, 0, n]) {
    const x = px + shift;
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2
      ? Math.max(0, Math.min(1, ((x - ax) * vx + (py - ay) * vy) / len2))
      : 0;
    const dx = x - (ax + t * vx);
    const dy = py - (ay + t * vy);
    best = Math.min(best, dx * dx + dy * dy);
  }
  return best;
}

/**
 * Tiles at zoom z covering a bbox (west > east crosses the date line), from
 * the centre outwards, capped at `limit`. With `focus`, tiles rank by distance
 * from the segment `from` (ground under the camera) to `to` (screen centre):
 * a tilted view's box centre can sit kilometres ahead of both.
 * @param {{limit?: number, focus?: {from: {lon: number, lat: number}, to?: {lon: number, lat: number}|null}|null}} [options]
 * @returns {{tiles: Array<{x:number,y:number,z:number}>, truncated: boolean, total: number}}
 */
export function tilesForBbox(bbox, z, { limit = Infinity, focus = null } = {}) {
  const n = 2 ** z;
  const tiles = [];
  let centre;
  if (Array.isArray(bbox) && Number(bbox[0]) > Number(bbox[2])) {
    // A box across the date line comes as west > east: split it at ±180°.
    const [west, south, east, north] = bbox.map(Number);
    for (const half of [
      [west, south, 180, north],
      [-180, south, east, north],
    ]) {
      const box = normalizeBbox(half);
      if (box) tiles.push(...tileGrid(box, z).tiles);
    }
    centre = {
      x: ((lonToTileX(west, z) + lonToTileX(east, z) + n) / 2) % n,
      y: (latToTileY(north, z) + latToTileY(south, z)) / 2,
    };
  } else {
    const box = normalizeBbox(bbox);
    if (!box) return { tiles: [], truncated: false, total: 0 };
    const grid = tileGrid(box, z);
    tiles.push(...grid.tiles);
    centre = { x: (grid.x0 + grid.x1) / 2, y: (grid.y0 + grid.y1) / 2 };
  }
  const distance2 = focus?.from
    ? (tile) => segmentDistance2(tile, focus.from, focus.to, z)
    : (tile) => {
        // Measured the short way round the date line.
        const dx = Math.abs(tile.x - centre.x);
        return Math.min(dx, n - dx) ** 2 + (tile.y - centre.y) ** 2;
      };
  // Each tile's distance is computed once; ties keep their row order.
  const ranked = tiles
    .map((tile) => ({ tile, d: distance2(tile) }))
    .sort((a, b) => a.d - b.d)
    .map(({ tile }) => tile);
  const truncated = ranked.length > limit;
  return {
    tiles: truncated ? ranked.slice(0, limit) : ranked,
    truncated,
    total: ranked.length,
  };
}

/** The tiles at zoom z in a normalized box, row by row, and their range. */
function tileGrid(box, z) {
  const x0 = lonToTileX(box.west, z);
  const x1 = lonToTileX(box.east, z);
  const y0 = latToTileY(box.north, z);
  const y1 = latToTileY(box.south, z);
  const tiles = [];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) tiles.push({ x, y, z });
  return { tiles, x0, x1, y0, y1 };
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

/**
 * Overview-point zoom (z0–5) above 60 km, where sequence tiles are too heavy;
 * null below, where `coverageZoomForHeight` takes over.
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
