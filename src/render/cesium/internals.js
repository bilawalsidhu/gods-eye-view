/**
 * @module render/cesium/internals
 * @description Every read or write of a private Cesium field, in one place.
 *
 * Core otherwise uses Cesium's public API. Each helper here names one private
 * field Core depends on and says why; `internals.test.mjs` fails when the
 * installed Cesium no longer declares one of them, and a source scan fails
 * when a private field is reached anywhere else.
 */

/**
 * The scene's main view, whose per-pass command arrays outlive a frame.
 * Used by `sceneCommandRelease.js` to drop references to destroyed commands.
 * @param {object} scene Cesium Scene.
 * @returns {object|undefined} Cesium `View`.
 */
export function defaultView(scene) {
  return scene?._defaultView;
}

/**
 * The offscreen view `sampleHeight` and `pickFromRay` render into.
 * @param {object} scene Cesium Scene.
 * @returns {object|undefined} Cesium `View`.
 */
export function pickOffscreenView(scene) {
  return scene?._picking?._pickOffscreenView;
}

/**
 * A view's command-extent records, each holding the command it last drew.
 * @param {object} view Cesium `View`.
 * @returns {Array<{command: object}>}
 */
export function commandExtents(view) {
  return view?._commandExtents || [];
}

/**
 * The collection a picked billboard belongs to; Cesium's pick result names
 * the billboard, not its collection.
 * @param {object} billboard Cesium Billboard.
 * @returns {object|undefined} Cesium BillboardCollection.
 */
export function billboardCollectionOf(billboard) {
  return billboard?._billboardCollection;
}

/**
 * The point collection an `EntityCluster` draws its cluster markers into.
 * @param {object} clustering Cesium EntityCluster.
 * @returns {object|null} Cesium PointPrimitiveCollection.
 */
export function clusterPointCollection(clustering) {
  return clustering?._clusterPointCollection || null;
}

/**
 * Close the widget's pending render-loop latch after `useDefaultRenderLoop`
 * is set false, so a callback already queued sees the loop as stopped and
 * manual renders start without waiting a vsync.
 * @param {object} viewer Cesium Viewer.
 */
export function closeRenderLoopLatch(viewer) {
  const widget = viewer?._cesiumWidget;
  if (widget) widget._renderLoopRunning = false;
}

/**
 * The scene's WebGL context, for diagnostics that read the GPU directly.
 * @param {object} scene Cesium Scene.
 * @returns {WebGLRenderingContext|WebGL2RenderingContext|undefined}
 */
export function webglContext(scene) {
  return scene?.context?._gl;
}

/**
 * Whether a camera flight is under way. Cesium clears it before calling a
 * flight's `complete`, so it reads false inside that callback.
 * @param {object} camera Cesium Camera.
 * @returns {boolean}
 */
export function cameraFlightActive(camera) {
  return camera?._currentFlight != null;
}

/**
 * Run the camera's `changed` check, as a scene does once a frame. For a
 * camera driven without a scene (the reference camera traces).
 * @param {object} camera Cesium Camera.
 */
export function updateCameraChanged(camera) {
  camera._updateCameraChanged();
}
