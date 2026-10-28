// A screen grid of conservative projected volumes. Prefix-sum storage has
// no feature/cell cap: overlapping shapes retain their source order.
export const GRID_COLS = 64;
export const GRID_ROWS = 40;
export function createGroundGrid(count) {
  const counts = new Uint32Array(GRID_COLS * GRID_ROWS);
  const offsets = new Uint32Array(counts.length);
  const cursor = new Uint32Array(counts.length);
  const bounds = new Float64Array(count * 4);
  const ranges = new Int32Array(count * 4);
  let indices = new Uint32Array(0);
  const clamp = (value, max) => Math.min(max - 1, Math.max(0, value));
  return {
    bounds,
    counts,
    offsets,
    get indices() {
      return indices;
    },
    pack() {
      counts.fill(0);
      for (let i = 0; i < count; i++) {
        const b = i * 4;
        const valid =
          bounds[b] <= bounds[b + 2] &&
          bounds[b + 1] <= bounds[b + 3] &&
          bounds[b] <= 1 &&
          bounds[b + 1] <= 1 &&
          bounds[b + 2] >= -1 &&
          bounds[b + 3] >= -1;
        ranges[b] = valid
          ? clamp(Math.floor((bounds[b] * 0.5 + 0.5) * GRID_COLS), GRID_COLS)
          : -1;
        ranges[b + 1] = clamp(
          Math.floor((bounds[b + 1] * 0.5 + 0.5) * GRID_ROWS),
          GRID_ROWS,
        );
        ranges[b + 2] = clamp(
          Math.floor((bounds[b + 2] * 0.5 + 0.5) * GRID_COLS),
          GRID_COLS,
        );
        ranges[b + 3] = clamp(
          Math.floor((bounds[b + 3] * 0.5 + 0.5) * GRID_ROWS),
          GRID_ROWS,
        );
        if (!valid) continue;
        for (let y = ranges[b + 1]; y <= ranges[b + 3]; y++)
          for (let x = ranges[b]; x <= ranges[b + 2]; x++)
            counts[y * GRID_COLS + x]++;
      }
      let total = 0;
      for (let i = 0; i < counts.length; i++) {
        offsets[i] = total;
        total += counts[i];
        cursor[i] = offsets[i];
      }
      if (indices.length < total)
        indices = new Uint32Array(Math.max(total, indices.length * 2));
      for (let i = 0; i < count; i++) {
        const b = i * 4;
        if (ranges[b] < 0) continue;
        for (let y = ranges[b + 1]; y <= ranges[b + 3]; y++)
          for (let x = ranges[b]; x <= ranges[b + 2]; x++)
            indices[cursor[y * GRID_COLS + x]++] = i;
      }
      return total;
    },
  };
}
