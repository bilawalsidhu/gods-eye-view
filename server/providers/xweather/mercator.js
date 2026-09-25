/** Web Mercator stops here; Xweather has no imagery beyond it. */
export const MERCATOR_MAX_LAT = 85.0511287798;
const TILE = 256;

const clampLat = (lat) =>
  Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
/** Global pixel x at zoom z for a longitude. */
export const mercatorX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
/** Global pixel y at zoom z for a latitude, clamped to Mercator coverage. */
export function mercatorY(lat, z) {
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
}

/**
 * Mercator tiles covering a bbox at one zoom.
 *
 * @param {number[]} bbox [west, south, east, north] in degrees.
 * @param {number} z Mercator zoom.
 * @returns {{z:number,x0:number,x1:number,y0:number,y1:number,count:number}}
 */
export function mercatorTileRange([west, south, east, north], z) {
  const last = 2 ** z - 1;
  const x0 = Math.max(0, Math.floor(mercatorX(west, z) / TILE));
  const x1 = Math.min(last, Math.floor((mercatorX(east, z) - 1e-9) / TILE));
  const y0 = Math.max(0, Math.floor(mercatorY(north, z) / TILE));
  const y1 = Math.min(last, Math.floor((mercatorY(south, z) - 1e-9) / TILE));
  return { z, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

/**
 * The sharpest zoom worth fetching for an image `widthPx` wide over `bbox`,
 * lowered until it fits `maxTiles` so one image has a bounded cost.
 */
export function chooseMercatorZoom(bbox, widthPx, { maxZoom, maxTiles }) {
  const wanted = widthPx / (bbox[2] - bbox[0]);
  let z = 0;
  while (z < maxZoom && (TILE * 2 ** z) / 360 < wanted) z++;
  let range = mercatorTileRange(bbox, z);
  while (range.z > 0 && range.count > maxTiles)
    range = mercatorTileRange(bbox, range.z - 1);
  return range;
}

/**
 * Resample Mercator tiles into an equirectangular RGBA image of `bbox`.
 * Bilinear inside the mosaic; rows outside Mercator coverage and pixels of
 * missing tiles stay transparent.
 */
export function reprojectToGeographic({ bbox, width, height, range, tile }) {
  const [west, south, east, north] = bbox;
  const { z, x0, x1, y0, y1 } = range;
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const mw = cols * TILE;
  const mh = rows * TILE;
  const mosaic = new Uint8Array(mw * mh * 4);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const pixels = tile(tx, ty);
      if (!pixels) continue;
      for (let r = 0; r < TILE; r++)
        mosaic.set(
          pixels.subarray(r * TILE * 4, (r + 1) * TILE * 4),
          (((ty - y0) * TILE + r) * mw + (tx - x0) * TILE) * 4,
        );
    }
  // The column terms do not depend on the row: compute them once.
  const columnX = new Int32Array(width);
  const columnF = new Float64Array(width);
  for (let col = 0; col < width; col++) {
    const lon = west + ((col + 0.5) / width) * (east - west);
    const px = Math.min(
      mw - 1,
      Math.max(0, mercatorX(lon, z) - x0 * TILE - 0.5),
    );
    columnX[col] = Math.min(mw - 2, Math.floor(px));
    columnF[col] = px - columnX[col];
  }
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const lat = north - ((row + 0.5) / height) * (north - south);
    if (Math.abs(lat) > MERCATOR_MAX_LAT) continue;
    const py = Math.min(
      mh - 1,
      Math.max(0, mercatorY(lat, z) - y0 * TILE - 0.5),
    );
    const yi = Math.min(mh - 2, Math.floor(py));
    const fy = py - yi;
    for (let col = 0; col < width; col++) {
      const xi = columnX[col];
      const fx = columnF[col];
      const a = (yi * mw + xi) * 4;
      const c = a + mw * 4;
      const o = (row * width + col) * 4;
      for (let k = 0; k < 4; k++)
        out[o + k] =
          (mosaic[a + k] * (1 - fx) + mosaic[a + 4 + k] * fx) * (1 - fy) +
          (mosaic[c + k] * (1 - fx) + mosaic[c + 4 + k] * fx) * fy;
    }
  }
  return out;
}
