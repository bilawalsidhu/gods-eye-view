/**
 * Resample a GRIB wind grid into a compact equirectangular grid.
 *
 * Source grids are north-to-south (`la1` at the top, `dj` increasing toward the
 * south) and start at `lo1`. Longitude wraps across the seam; latitude clamps.
 *
 * @param {{u: ArrayLike<number>, v: ArrayLike<number>, ni: number, nj: number,
 *   lo1: number, la1: number, di: number, dj: number, dx?: number, dy?: number}} input
 * @returns {{nx: number, ny: number, lo1: number, la1: number, dx: number,
 *   dy: number, u: Float32Array, v: Float32Array}}
 */
export function resampleWindGrid({
  u,
  v,
  ni,
  nj,
  lo1,
  la1,
  di,
  dj,
  dx = 1,
  dy = 1,
}) {
  const nx = Math.round(360 / dx);
  const ny = Math.round(180 / dy) + 1;
  const outU = new Float32Array(nx * ny);
  const outV = new Float32Array(nx * ny);
  const sample = (source, lon, lat) => {
    const x = ((lon - lo1) / di + ni) % ni;
    const y = Math.max(0, Math.min(nj - 1, (la1 - lat) / dj));
    const x0 = Math.floor(x);
    const x1 = (x0 + 1) % ni;
    const y0 = Math.floor(y);
    const y1 = Math.min(nj - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const top = source[y0 * ni + x0] * (1 - fx) + source[y0 * ni + x1] * fx;
    const bottom = source[y1 * ni + x0] * (1 - fx) + source[y1 * ni + x1] * fx;
    return top * (1 - fy) + bottom * fy;
  };
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const index = y * nx + x;
      const lon = x * dx;
      const lat = 90 - y * dy;
      outU[index] = sample(u, lon, lat);
      outV[index] = sample(v, lon, lat);
    }
  }
  return { nx, ny, lo1: 0, la1: 90, dx, dy, u: outU, v: outV };
}
