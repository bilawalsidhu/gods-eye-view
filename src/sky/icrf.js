/**
 * @module sky/icrf
 * @description The precise ICRF-to-fixed rotation, from the renderer that
 * has the tables for it (the Cesium adapter's starry sky provides it as it
 * loads, `src/render/cesium/starrySky.js`). Cesium-free: with none
 * provided, or before its tables load, it answers null and callers fall
 * back to `temeToPseudoFixed` (`src/geo/frames.js`).
 */

let provided = null;

/**
 * Provide the precise rotation; a later call replaces it.
 * @param {(ms: number) => ({x: object, y: object, z: object} | null)} axesAt
 */
export function provideIcrfToFixed(axesAt) {
  provided = axesAt;
}

/**
 * The precise ICRF-to-fixed rotation at `ms` (epoch milliseconds) as its
 * axes (the matrix's columns), or null while it is unknown.
 * @param {number} ms
 * @returns {{x: object, y: object, z: object} | null}
 */
export function icrfToFixedAxes(ms) {
  return provided ? provided(ms) : null;
}
