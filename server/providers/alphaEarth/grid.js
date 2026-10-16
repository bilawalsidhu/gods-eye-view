import {
  ALPHA_EARTH_BANDS,
  ALPHA_EARTH_BASE_METERS,
  ALPHA_EARTH_BAND_TILE_BYTES,
  ALPHA_EARTH_COG_PX,
  ALPHA_EARTH_GRID_NODATA,
  ALPHA_EARTH_GRID_SCALE,
  ALPHA_EARTH_MAX_GRID_PX,
  ALPHA_EARTH_MAX_LEVEL,
  ALPHA_EARTH_NODATA_INT8,
  ALPHA_EARTH_TILE_PX,
} from './constants.js';

const METERS_PER_DEGREE = 111_320;

/**
 * De-quantisation table for the mirror's signed 8-bit values:
 * `sign(v) · (v / 127.5)²`, with the NoData value (-128) mapped to NaN.
 * Indexed by `v & 0xff` so an Int8Array can be read through a Uint8Array view.
 */
export const DEQUANTIZE = (() => {
  const table = new Float32Array(256);
  for (let byte = 0; byte < 256; byte += 1) {
    const v = byte > 127 ? byte - 256 : byte;
    if (v === ALPHA_EARTH_NODATA_INT8) table[byte] = Number.NaN;
    else {
      const s = v / 127.5;
      table[byte] = Math.sign(v) * s * s;
    }
  }
  return table;
})();

export function dequantize(value) {
  return DEQUANTIZE[value & 0xff];
}

/** `EPSG:326zz` / `EPSG:327zz` → `{ zone, south }`, or null for anything else. */
export function utmZoneFromCrs(crs) {
  const match = /^EPSG:32([67])(\d{2})$/.exec(String(crs || '').trim());
  if (!match) return null;
  const zone = Number(match[2]);
  if (zone < 1 || zone > 60) return null;
  return { zone, south: match[1] === '7' };
}

// WGS84 transverse Mercator (Snyder 1987, eqs. 8-9 to 8-12), sub-metre in-zone.
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const M1 = 1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256;
const M2 = (3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 * E2 * E2) / 1024;
const M3 = (15 * E2 * E2) / 256 + (45 * E2 * E2 * E2) / 1024;
const M4 = (35 * E2 * E2 * E2) / 3072;

/** Forward UTM projection into an explicit zone (the zone need not contain `lon`). */
export function lonLatToUtm(lon, lat, zone, south) {
  const phi = (lat * Math.PI) / 180;
  const lambda0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const n = A / Math.sqrt(1 - E2 * sin * sin);
  const t = tan * tan;
  const c = EP2 * cos * cos;
  const a = cos * (lambda - lambda0);
  const m =
    A *
    (M1 * phi -
      M2 * Math.sin(2 * phi) +
      M3 * Math.sin(4 * phi) -
      M4 * Math.sin(6 * phi));
  const easting =
    K0 *
      n *
      (a +
        ((1 - t + c) * a ** 3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120) +
    500_000;
  let northing =
    K0 *
    (m +
      n *
        tan *
        ((a * a) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720));
  if (south) northing += 10_000_000;
  return [easting, northing];
}

/** Validate a WGS84 box and return its approximate metric size, or null. */
export function measureBox({ west, south, east, north }) {
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90) return null;
  if (!(east > west) || !(north > south)) return null;
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  return {
    widthMeters: (east - west) * METERS_PER_DEGREE * Math.cos(midLat),
    heightMeters: (north - south) * METERS_PER_DEGREE,
  };
}

export function levelPixelMeters(level) {
  return ALPHA_EARTH_BASE_METERS * 2 ** level;
}

/**
 * The UTM window a WGS84 box occupies in one zone: the extent of its corners
 * and edge midpoints (UTM edges bow relative to meridians/parallels), padded
 * by one pixel at the given resolution.
 */
export function boxUtmExtent(box, zone, south, padMeters = 0) {
  const lons = [box.west, (box.west + box.east) / 2, box.east];
  const lats = [box.south, (box.south + box.north) / 2, box.north];
  let minE = Infinity;
  let minN = Infinity;
  let maxE = -Infinity;
  let maxN = -Infinity;
  for (const lon of lons) {
    for (const lat of lats) {
      const [e, n] = lonLatToUtm(lon, lat, zone, south);
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
    }
  }
  return {
    minE: minE - padMeters,
    minN: minN - padMeters,
    maxE: maxE + padMeters,
    maxN: maxN + padMeters,
  };
}

/**
 * Pixel window of a box inside one COG at one overview level. Rows count up
 * from the COG's SOUTH edge: the mirror's GeoTIFFs are stored bottom-up
 * (positive y resolution), so file row 0 is the southernmost row.
 *
 * @param {{utmWest:number, utmSouth:number, utmEast:number, utmNorth:number, zone:number, south:boolean}} cog
 * @returns {?{x0:number, y0:number, x1:number, y1:number, pixelMeters:number}}
 */
export function cogWindow(cog, box, level) {
  const pixelMeters = levelPixelMeters(level);
  const extent = boxUtmExtent(box, cog.zone, cog.south, pixelMeters);
  const levelPx = Math.max(1, Math.ceil(ALPHA_EARTH_COG_PX / 2 ** level));
  const cols = Math.min(
    levelPx,
    Math.round((cog.utmEast - cog.utmWest) / pixelMeters),
  );
  const rows = Math.min(
    levelPx,
    Math.round((cog.utmNorth - cog.utmSouth) / pixelMeters),
  );
  const x0 = Math.max(0, Math.floor((extent.minE - cog.utmWest) / pixelMeters));
  const x1 = Math.min(
    cols,
    Math.ceil((extent.maxE - cog.utmWest) / pixelMeters),
  );
  const y0 = Math.max(
    0,
    Math.floor((extent.minN - cog.utmSouth) / pixelMeters),
  );
  const y1 = Math.min(
    rows,
    Math.ceil((extent.maxN - cog.utmSouth) / pixelMeters),
  );
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1, pixelMeters };
}

/** Upstream bytes needed to read one window at one level (all 64 bands). */
export function windowCostBytes(window, level) {
  const levelPx = Math.max(1, Math.ceil(ALPHA_EARTH_COG_PX / 2 ** level));
  const tilePx = Math.min(ALPHA_EARTH_TILE_PX, levelPx);
  const tilesX =
    Math.floor((window.x1 - 1) / tilePx) - Math.floor(window.x0 / tilePx) + 1;
  const tilesY =
    Math.floor((window.y1 - 1) / tilePx) - Math.floor(window.y0 / tilePx) + 1;
  const fill = (tilePx / ALPHA_EARTH_TILE_PX) ** 2;
  return (
    tilesX * tilesY * ALPHA_EARTH_BANDS * ALPHA_EARTH_BAND_TILE_BYTES * fill
  );
}

/**
 * Finest overview level whose output grid fits the pixel cap and whose
 * upstream reads (summed over both years' COGs) fit the byte budget. Falls
 * back to the coarsest level when nothing fits.
 *
 * @param {object} box - WGS84 box
 * @param {Array<object>} cogs - every COG to read, across both years
 * @param {number} budgetBytes
 * @returns {{level:number, pixelMeters:number, estimatedBytes:number}}
 */
export function chooseLevel(box, cogs, budgetBytes) {
  const size = measureBox(box);
  let fallback = null;
  for (let level = 0; level <= ALPHA_EARTH_MAX_LEVEL; level += 1) {
    const pixelMeters = levelPixelMeters(level);
    const gridOk =
      size.widthMeters / pixelMeters <= ALPHA_EARTH_MAX_GRID_PX &&
      size.heightMeters / pixelMeters <= ALPHA_EARTH_MAX_GRID_PX;
    let estimatedBytes = 0;
    for (const cog of cogs) {
      const window = cogWindow(cog, box, level);
      if (window) estimatedBytes += windowCostBytes(window, level);
    }
    fallback = { level, pixelMeters, estimatedBytes };
    if (gridOk && estimatedBytes <= budgetBytes) return fallback;
  }
  return fallback;
}

/** Regular WGS84 output grid at roughly `pixelMeters`, capped per side. */
export function outputGrid(box, pixelMeters) {
  const size = measureBox(box);
  const width = Math.max(
    1,
    Math.min(
      ALPHA_EARTH_MAX_GRID_PX,
      Math.round(size.widthMeters / pixelMeters),
    ),
  );
  const height = Math.max(
    1,
    Math.min(
      ALPHA_EARTH_MAX_GRID_PX,
      Math.round(size.heightMeters / pixelMeters),
    ),
  );
  return {
    width,
    height,
    /** Column centre longitude. */
    lon: (i) => box.west + ((i + 0.5) * (box.east - box.west)) / width,
    /** Row centre latitude; row 0 is the NORTH edge (image order). */
    lat: (j) => box.north - ((j + 0.5) * (box.north - box.south)) / height,
  };
}

/**
 * Sample embeddings from one or more COG windows onto the output grid by
 * nearest neighbour. Later windows only fill pixels earlier ones left empty,
 * so overlapping COGs never double-write.
 *
 * @param {{width:number,height:number,lon:Function,lat:Function}} grid
 * @param {Array<{cog:object, window:object, data:Int8Array}>} reads - `data`
 *   is band-interleaved (64 values per pixel), window rows counted from south.
 * @returns {{values: Int8Array, filled: Uint8Array}}
 */
export function sampleEmbeddings(grid, reads) {
  const count = grid.width * grid.height;
  const values = new Int8Array(count * ALPHA_EARTH_BANDS);
  const filled = new Uint8Array(count);
  for (const { cog, window, data } of reads) {
    const w = window.x1 - window.x0;
    const h = window.y1 - window.y0;
    const p = window.pixelMeters;
    for (let j = 0; j < grid.height; j += 1) {
      const lat = grid.lat(j);
      for (let i = 0; i < grid.width; i += 1) {
        const index = j * grid.width + i;
        if (filled[index]) continue;
        const [e, n] = lonLatToUtm(grid.lon(i), lat, cog.zone, cog.south);
        const col = Math.floor((e - cog.utmWest) / p) - window.x0;
        const row = Math.floor((n - cog.utmSouth) / p) - window.y0;
        if (col < 0 || row < 0 || col >= w || row >= h) continue;
        const source = (row * w + col) * ALPHA_EARTH_BANDS;
        if (data[source] === ALPHA_EARTH_NODATA_INT8) continue;
        values.set(
          data.subarray(source, source + ALPHA_EARTH_BANDS),
          index * ALPHA_EARTH_BANDS,
        );
        filled[index] = 1;
      }
    }
  }
  return { values, filled };
}

/**
 * Per-pixel change `1 − cos(a, b)` between two sampled embedding grids,
 * quantised to 0..254 over [0, 1] (values above 1 — opposite vectors — clamp),
 * 255 where either year has no data. Re-normalises after de-quantisation, so
 * the result is a true cosine even though quantisation breaks unit length.
 */
export function computeChange(a, b, threshold) {
  const count = a.filled.length;
  const grid = new Uint8Array(count);
  const changes = [];
  let sum = 0;
  let changed = 0;
  for (let index = 0; index < count; index += 1) {
    if (!a.filled[index] || !b.filled[index]) {
      grid[index] = ALPHA_EARTH_GRID_NODATA;
      continue;
    }
    const offset = index * ALPHA_EARTH_BANDS;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let band = 0; band < ALPHA_EARTH_BANDS; band += 1) {
      const va = DEQUANTIZE[a.values[offset + band] & 0xff];
      const vb = DEQUANTIZE[b.values[offset + band] & 0xff];
      dot += va * vb;
      na += va * va;
      nb += vb * vb;
    }
    const denom = Math.sqrt(na * nb);
    const change = denom > 0 ? 1 - dot / denom : 0;
    const clamped = Math.max(0, Math.min(1, change));
    grid[index] = Math.round(clamped * ALPHA_EARTH_GRID_SCALE);
    changes.push(clamped);
    sum += clamped;
    if (clamped >= threshold) changed += 1;
  }
  return { grid, stats: changeStats(changes, sum, changed, count) };
}

function changeStats(changes, sum, changed, count) {
  const valid = changes.length;
  if (!valid) {
    return {
      validFraction: 0,
      meanChange: null,
      medianChange: null,
      p95Change: null,
      changedFraction: null,
    };
  }
  const sorted = Float32Array.from(changes).sort();
  const at = (q) => sorted[Math.min(valid - 1, Math.floor(q * valid))];
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    validFraction: round(valid / count),
    meanChange: round(sum / valid),
    medianChange: round(at(0.5)),
    p95Change: round(at(0.95)),
    changedFraction: round(changed / valid),
  };
}
