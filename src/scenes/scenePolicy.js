// src/scenes/scenePolicy.js — pure decisions for cinematic scene playback.
//
// The scene director was written when the app shipped four data layers, and its
// shot recipes (src/scenes/recipes.js) still declare exactly those four:
// flights, satellites, earthquakes, traffic. The registry has since grown to
// sixteen. The original reconcile walked the LIVE registry and forced every
// layer absent from the shot to off, so a recipe that never had an opinion
// about CCTV, vessels, fires, cables, dams or datacenters silently tore
// them down — and nothing puts them back, because playback has no restore pass.
//
// A shot's layer map is an assertion about the layers it NAMES, not a claim of
// authority over every layer that will ever exist. Recipes already spell out
// the layers they want OFF, so honouring only the declared keys keeps
// every authored intent intact while leaving undeclared layers alone.
//
// Operator-captured shots are unaffected: captureShot() snapshots the whole
// registry (director._captureLayerStates), so those shots declare all sixteen
// keys and still reconcile in full.

/**
 * Layer params that re-establish a tracked contact — and with it a SECOND
 * writer on the camera.
 *
 * A capture taken while following a plane snapshots that layer's whole param
 * set, tracking id included. Replaying it would hand the camera back to the
 * follow loop the scene just took it from (see director._claimCameraOwnership
 * and src/data/trackedCamera.js): the shot flight and the follow camera then
 * both write the frame, which is the documented jitter failure mode.
 *
 * So playback NEVER re-establishes tracking. The keys stay in the stored
 * capture — a project file is a record of what the operator saw, and a future
 * reader may want it — they are simply dropped on the way to the layer.
 *
 * @constant {ReadonlyArray<string>}
 */
export const SCENE_TRACKING_PARAM_KEYS = Object.freeze([
  'selectedFlightsTrackingId',
  'selectedMilitaryTrackingId',
  'selectedSatTrackingId',
]);

/**
 * Selection params that look like the ones above and are deliberately KEPT.
 *
 * `selectedCameraId` (cctv) activates a camera and raises its monitor plane.
 * It never writes viewer.trackedEntity or moves the camera — only the separate
 * `focusSelected` option does that — so it is composition the operator meant
 * to capture, not a second writer on the camera. The vessels layer exposes no
 * getParams() surface at all, so its selection cannot be captured today.
 *
 * The list exists so the decision is RECORDED rather than implied by absence:
 * scenePolicy.test.mjs sweeps every layer's getParams() for the selection
 * naming family and requires each match to appear on this list or the one
 * above. A future param named `trackedVesselMmsi` therefore cannot slip
 * through merely by not matching the older `selected…TrackingId` spelling.
 * @constant {ReadonlyArray<string>}
 */
export const SCENE_KEPT_SELECTION_PARAM_KEYS = Object.freeze([
  'selectedCameraId',
]);

/**
 * Names belonging to the selection/tracking family, whatever their spelling.
 * Deliberately wider than the three params that exist today — the sweep's job
 * is to force a decision about a NEW name, not to recognise the current ones.
 * @constant {RegExp}
 */
export const SCENE_SELECTION_PARAM_PATTERN =
  /^(?:selected|tracked)[A-Z0-9]|TrackingId$|(?:Mmsi|Norad|Icao|Callsign)$/;

/**
 * Drop every camera-tracking key from one shot's layer params.
 *
 * @param {Object|undefined} params Params as stored on the shot.
 * @returns {Object|undefined} Params safe to push at the layer, or undefined
 *   when nothing survives (a params bag that was tracking and nothing else).
 */
export function stripSceneTrackingParams(params) {
  if (!params || typeof params !== 'object') return undefined;
  if (!SCENE_TRACKING_PARAM_KEYS.some((key) => Object.hasOwn(params, key))) return params;

  const kept = {};
  for (const [key, value] of Object.entries(params)) {
    if (SCENE_TRACKING_PARAM_KEYS.includes(key)) continue;
    kept[key] = value;
  }
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Reserved layer id used ONLY to interrogate a Context mode's enable guard.
 *
 * The probe asks "would this mode refuse a layer it has no opinion about?" —
 * so it must name a layer that can never exist. The double-underscore form is
 * outside the kebab-case convention every real layer id follows, and
 * scenePolicy.test.mjs asserts no registered layer claims it, so the reservation
 * is enforced rather than assumed.
 * @constant {string}
 */
export const SCENE_EXCLUSIVITY_PROBE_LAYER_ID = '__scene-exclusivity-probe__';

/**
 * Whether an active Context mode must be exited before a shot's layers can be
 * applied.
 *
 * @param {string|null} contextMode Active (or entering) Context mode.
 * @returns {boolean} Whether playback must leave the mode first.
 */
export function sceneRequiresContextModeExit(contextMode) {
  return false;
}

/**
 * Build the ordered layer reconcile plan for one shot.
 *
 * Only layers the shot explicitly declares are touched. Declared layers that
 * are no longer registered (an imported or long-stored project referencing a
 * retired layer) are skipped rather than pushed at the data manager. Camera
 * tracking params are stripped here, on the way out — see
 * SCENE_TRACKING_PARAM_KEYS.
 *
 * @param {Object.<string, { enabled: boolean, params?: Object }>} targetStates
 *   The shot's normalized layer map.
 * @param {Set<string>|Iterable<string>} [registeredIds] Layer ids the data
 *   manager currently knows about. Omit to skip the registration filter.
 * @returns {Array<{ id: string, enabled: boolean, params: Object|undefined }>}
 */
export function sceneLayerPlan(targetStates, registeredIds) {
  const known = registeredIds instanceof Set
    ? registeredIds
    : (registeredIds ? new Set(registeredIds) : null);

  const plan = [];
  for (const [id, target] of Object.entries(targetStates || {})) {
    if (known && !known.has(id)) continue;
    plan.push({
      id,
      enabled: !!(target && target.enabled),
      params: target && target.params ? stripSceneTrackingParams(target.params) : undefined,
    });
  }
  return plan;
}
