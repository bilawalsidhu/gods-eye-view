/** A completed wider query remains valid during inward zoom. Panning outside
 * it does not. This is query coverage, never a fabricated marker position. */
export function coversViewport(loaded, current) {
  if (!loaded || !current) return loaded === current;
  if (loaded[1] > current[1] || loaded[3] < current[3]) return false;
  const width = (b) => (b[2] >= b[0] ? b[2] - b[0] : b[2] - b[0] + 360);
  if (width(loaded) === 360) return true;
  const offset = (current[0] - loaded[0] + 360) % 360;
  return offset + width(current) <= width(loaded) + 1e-9;
}
