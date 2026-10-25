/**
 * @module maps/gibsSmoothing
 * @description Presentation smoothing for gridded GIBS products. GIBS draws
 * each grid cell as a hard square with an all-or-nothing coastline, so the
 * globe shows blocks and stair-stepped shores. Two box passes one cell wide
 * turn the squares into the bilinear ramp between cell centres, and the
 * blurred coverage is cut at its midpoint, so a coastline follows the smooth
 * contour instead of the cell edges (the same idea as the gravity layer's
 * land-mask coverage). Readouts sample raw tiles and are unaffected.
 *
 * Pure: no imports.
 */

const TILE = 256;
const CACHE_TILES = 96;
const NEIGHBOURS = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => [dx, dy]));

/** Cell size in tile pixels at one level and latitude: [across, down]. */
export function cellPixels(level, latitude, cellDegrees) {
  const across = (cellDegrees * TILE * 2 ** level) / 360;
  const cos = Math.max(0.05, Math.cos((latitude * Math.PI) / 180));
  return [across, across / cos];
}

/** Latitude of a Web Mercator tile's centre row, in degrees. */
export function tileCentreLatitude(level, y) {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** level;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

function boxPass(source, target, width, height, radius, horizontal) {
  // Running-sum box filter of 2 * radius + 1 taps over premultiplied RGBA,
  // clamped at the mosaic edges (the margin keeps clamping off the tile).
  const span = 2 * radius + 1;
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const step = horizontal ? 4 : width * 4;
  const sums = new Float64Array(4);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width * 4 : line * 4;
    const at = (i) => base + Math.min(length - 1, Math.max(0, i)) * step;
    sums.fill(0);
    for (let i = -radius; i <= radius; i++) {
      const p = at(i);
      for (let c = 0; c < 4; c++) sums[c] += source[p + c];
    }
    for (let i = 0; i < length; i++) {
      const out = base + i * step;
      for (let c = 0; c < 4; c++) target[out + c] = sums[c] / span;
      const drop = at(i - radius);
      const add = at(i + radius + 1);
      for (let c = 0; c < 4; c++) sums[c] += source[add + c] - source[drop + c];
    }
  }
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Smooth the centre tile of a 3x3 neighbourhood.
 * @param {(dx:number, dy:number) => Uint8ClampedArray|null} tileAt RGBA of
 *   the neighbour at (dx, dy) in -1..1, or null where there is none.
 * @param {number} level Tile level.
 * @param {number} y Tile row (for the cell's height in Mercator pixels).
 * @param {number} cellDegrees The product's grid spacing in degrees.
 * @returns {Uint8ClampedArray} RGBA for the 256x256 centre tile.
 */
export function smoothGibsTile(tileAt, level, y, cellDegrees) {
  const centre = tileAt(0, 0);
  const [across, down] = cellPixels(
    level,
    tileCentreLatitude(level, y),
    cellDegrees,
  );
  // A margin of two radii must fit inside the neighbouring tiles.
  const rx = Math.min(TILE / 4, Math.round(across / 2));
  const ry = Math.min(TILE / 4, Math.round(down / 2));
  if (rx < 1 && ry < 1) return centre;
  const mx = 2 * rx;
  const my = 2 * ry;
  const width = TILE + 2 * mx;
  const height = TILE + 2 * my;
  const mosaic = new Float32Array(width * height * 4);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tile = tileAt(dx, dy);
      if (!tile) continue;
      const x0 = Math.max(0, dx * TILE + mx);
      const x1 = Math.min(width, dx * TILE + mx + TILE);
      const y0 = Math.max(0, dy * TILE + my);
      const y1 = Math.min(height, dy * TILE + my + TILE);
      for (let row = y0; row < y1; row++) {
        const sourceRow = row - dy * TILE - my;
        for (let col = x0; col < x1; col++) {
          const s = (sourceRow * TILE + (col - dx * TILE - mx)) * 4;
          const d = (row * width + col) * 4;
          const alpha = tile[s + 3] / 255;
          mosaic[d] = tile[s] * alpha;
          mosaic[d + 1] = tile[s + 1] * alpha;
          mosaic[d + 2] = tile[s + 2] * alpha;
          mosaic[d + 3] = alpha;
        }
      }
    }
  }
  const scratch = new Float32Array(mosaic.length);
  if (rx >= 1) {
    boxPass(mosaic, scratch, width, height, rx, true);
    boxPass(scratch, mosaic, width, height, rx, true);
  }
  if (ry >= 1) {
    boxPass(mosaic, scratch, width, height, ry, false);
    boxPass(scratch, mosaic, width, height, ry, false);
  }
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  for (let row = 0; row < TILE; row++) {
    for (let col = 0; col < TILE; col++) {
      const s = ((row + my) * width + col + mx) * 4;
      const coverage = mosaic[s + 3];
      const alpha = smoothstep(0.35, 0.65, coverage);
      if (alpha === 0) continue;
      const d = (row * TILE + col) * 4;
      out[d] = mosaic[s] / coverage;
      out[d + 1] = mosaic[s + 1] / coverage;
      out[d + 2] = mosaic[s + 2] / coverage;
      out[d + 3] = alpha * 255;
    }
  }
  return out;
}

/**
 * Make a Cesium imagery provider draw smoothed tiles. Each tile's eight
 * neighbours are fetched too, so the smoothing runs across tile seams; a small
 * cache shares them between tiles.
 * @param {object} provider A Web Mercator, 256 px tile provider.
 * @param {{Resource:Function, document:Document, cellDegrees:number,
 *   tileUrl:(level:number, x:number, y:number) => string}} options
 * @returns {object} The same provider.
 */
export function smoothGibsProvider(
  provider,
  { Resource, document, cellDegrees, tileUrl },
) {
  if (!Resource || !document?.createElement) return provider;
  const cache = new Map();
  const canvas = () => {
    const element = document.createElement('canvas');
    element.width = element.height = TILE;
    return element;
  };
  const pixels = (level, x, y) => {
    const n = 2 ** level;
    if (y < 0 || y >= n) return Promise.resolve(null);
    const column = ((x % n) + n) % n;
    const key = `${level}/${column}/${y}`;
    let entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
      return entry;
    }
    // Source pixels north-up: provider bitmaps are flipped for WebGL upload.
    entry = new Resource({ url: tileUrl(level, column, y) })
      .fetchImage({ preferImageBitmap: false, flipY: false })
      .then((image) => {
        if (!image) throw new Error('GIBS tile request deferred');
        const context = canvas().getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, TILE, TILE);
        return context.getImageData(0, 0, TILE, TILE).data;
      });
    entry.catch(() => cache.delete(key));
    cache.set(key, entry);
    if (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value);
    return entry;
  };
  provider.requestImage = async (x, y, level) => {
    const centre = await pixels(level, x, y);
    const around = await Promise.all(
      NEIGHBOURS.map(([dx, dy]) =>
        dx === 0 && dy === 0
          ? centre
          : pixels(level, x + dx, y + dy).catch(() => null),
      ),
    );
    const rgba = smoothGibsTile(
      (dx, dy) => around[(dy + 1) * 3 + dx + 1],
      level,
      y,
      cellDegrees,
    );
    const element = canvas();
    const context = element.getContext('2d');
    const image = context.createImageData(TILE, TILE);
    image.data.set(rgba);
    context.putImageData(image, 0, 0);
    return element;
  };
  return provider;
}
