/**
 * Bilinear value of a north-to-south, longitude-wrapped grid at a point,
 * blending only its finite corners (NaN marks land or no data), or null when
 * none is. `offset` reads a component stored after another in one array.
 * @param {{nx: number, ny: number, lo1: number, la1: number, dx: number,
 *   dy: number}} grid
 * @param {ArrayLike<number>} values
 */
export function sampleMaskedGrid(grid, values, lon, lat, offset = 0) {
  if (!grid || !values || !Number.isFinite(lon) || !Number.isFinite(lat))
    return null;
  const { nx, ny, lo1, la1, dx, dy } = grid;
  const x = ((((lon - lo1) % 360) + 360) % 360) / dx;
  const y = Math.max(0, Math.min(ny - 1, (la1 - lat) / dy));
  const x0 = Math.floor(x) % nx;
  const x1 = (x0 + 1) % nx;
  const y0 = Math.floor(y);
  const y1 = Math.min(ny - 1, y0 + 1);
  const fx = x - Math.floor(x);
  const fy = y - y0;
  let sum = 0;
  let weight = 0;
  for (const [index, w] of [
    [y0 * nx + x0, (1 - fx) * (1 - fy)],
    [y0 * nx + x1, fx * (1 - fy)],
    [y1 * nx + x0, (1 - fx) * fy],
    [y1 * nx + x1, fx * fy],
  ]) {
    const value = values[offset + index];
    if (w > 0 && Number.isFinite(value)) {
      sum += value * w;
      weight += w;
    }
  }
  return weight > 0 ? sum / weight : null;
}
