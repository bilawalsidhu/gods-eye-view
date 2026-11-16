/**
 * Lighting options shared by every aircraft 3D model (Flights, Military
 * Flights, Local ADS-B).
 *
 * Cesium gives each Model a dynamic environment map: it renders the sky around
 * the model and reads the result back from the GPU (`readPixels`) to light it,
 * when the model is first placed and again when it moves more than 1 km, when
 * the scene's atmosphere settings change, or every scene hour under sunlight
 * lighting. Without it they are lit from Cesium's default spherical
 * harmonics. Measured 2026-10-24 (Intel Arc, Google 3D, ~150 models in the
 * scene): GPU per frame at rest 14.3-14.8 -> 12.1-12.5 ms.
 */
export const AIRCRAFT_ENVIRONMENT_MAP_OPTIONS = Object.freeze({
  enabled: false,
});

const HIGHLIGHT = Object.freeze({ mode: 'highlight' });
const FLAT = Object.freeze({ mode: 'mix', amount: 1 });

/**
 * How an aircraft model's colour meets its mesh, as a draw item's
 * `colorBlend`. `highlight` multiplies, so white draws the mesh's own
 * colours as built, and the tracked or emergency colour tints the mesh
 * without hiding its paint. The IR boost draws the model flat white instead
 * (`mix` at 1, unlit).
 * @param {boolean} irBoost
 * @returns {{mode: 'highlight'|'mix', amount?: number}}
 */
export function aircraftModelBlend(irBoost) {
  return irBoost ? FLAT : HIGHLIGHT;
}
