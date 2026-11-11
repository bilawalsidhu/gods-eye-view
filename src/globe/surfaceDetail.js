// engine.surface.sampleHeightDetailed, the engine-neutral part: its options
// and the quality rule callers apply to an answer. An answer is
// { height, source: 'tiles' | 'terrain', tileSizeM? }: `tileSizeM` is the
// size of the tile that answered (Navara; Cesium does not say), the quality
// signal, since a coarse tile's surface can sit tens of metres off the
// ground (a 20 m error measured at Austin while the tiles were streaming).

/**
 * @param {{ exclude?: any[] }} [options] `exclude`: mover sets (or their
 *   ids), lines, or engine objects the ray passes through.
 */
export function normalizeSurfaceOptions(options = {}) {
  const exclude = options.exclude ?? [];
  if (!Array.isArray(exclude))
    throw new TypeError('surface exclude must be an array');
  return { exclude };
}

/**
 * The height to use from a detailed answer, or undefined (a miss): tiles
 * larger than `maxTileSizeM` are too coarse, and terrain counts only with
 * `terrain: true`.
 */
export function acceptedSurfaceHeight(
  detail,
  { maxTileSizeM = Infinity, terrain = false } = {},
) {
  if (!detail || !Number.isFinite(detail.height)) return undefined;
  if (detail.source === 'terrain') return terrain ? detail.height : undefined;
  if (Number.isFinite(detail.tileSizeM) && detail.tileSizeM > maxTileSizeM)
    return undefined;
  return detail.height;
}
