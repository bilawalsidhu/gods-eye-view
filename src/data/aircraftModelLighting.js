/**
 * Lighting options shared by every aircraft 3D model (Flights, Military
 * Flights, Local ADS-B).
 *
 * Cesium gives each Model a dynamic environment map: it renders the sky around
 * the model and reads the result back from the GPU (`readPixels`) to light it,
 * when the model is first placed and again when it moves more than 1 km, when
 * the scene's atmosphere settings change, or every scene hour under sunlight
 * lighting. Aircraft models take 94% of their surface from the class colour
 * (`colorBlendAmount`), so that lighting contributes little; without it they
 * are lit from Cesium's default spherical harmonics. Measured 2026-10-24
 * (Intel Arc, Google 3D, ~150 models in the scene): GPU per frame at rest
 * 14.3-14.8 -> 12.1-12.5 ms.
 */
export const AIRCRAFT_ENVIRONMENT_MAP_OPTIONS = Object.freeze({
  enabled: false,
});
