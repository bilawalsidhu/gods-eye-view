// The page session's annotation board, Draw and Import on the experimental
// Navara engine (src/app/sessionTools.js holds the tools themselves). Loaded
// with src/app/navaraMode.js, so the Cesium-mode bundle carries none of it.

/**
 * The annotation board drawn on this Navara scene. Returns the board, or
 * null while the engine draws no annotations.
 */
export function attachNavaraAnnotations() {
  return null;
}

/** UTILITIES ▸ Draw on this Navara scene; null while it has none. */
export function attachNavaraDraw() {
  return null;
}

/** UTILITIES ▸ Import on this Navara scene; null while it has none. */
export function attachNavaraGeoImport() {
  return null;
}
