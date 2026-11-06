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
 * Whether the scene has a render pending that its next tick will draw in
 * request-render mode: a request, or a depth-buffer or HDR change. With
 * `cameraMovedSinceRender` and the time check, this is the test
 * `Scene.render` makes after `preUpdate`, so the frame port can say at
 * `preUpdate` whether the tick draws.
 * @param {object} scene Cesium Scene.
 * @returns {boolean}
 */
export function renderPending(scene) {
  return Boolean(
    scene._renderRequested || scene._logDepthBufferDirty || scene._hdrDirty,
  );
}

/**
 * Calls `cb` each time Cesium completes a request or a worker task, in any
 * scene. A scene redraws on its own after each (its `requestRenderAfterFrame`
 * listeners): a terrain picker build after the camera moves, say, which no
 * loading flag shows. `whenSettled` uses it to tell when that work has
 * stopped. Both events are marked private.
 * @param {{RequestScheduler: object, TaskProcessor: object}} cesium The
 *   Cesium namespace.
 * @param {() => void} cb
 * @returns {() => void} Removes the listeners.
 */
export function onEngineWorkCompleted({ RequestScheduler, TaskProcessor }, cb) {
  const offs = [
    RequestScheduler.requestCompletedEvent.addEventListener(() => cb()),
    TaskProcessor.taskCompletedEvent.addEventListener(() => cb()),
  ];
  return () => offs.forEach((off) => off());
}

/**
 * Runs `fn` at the end of the scene's current tick, drawn or not: Cesium's
 * after-render queue, which every `Scene.render` empties after its draw (if
 * any) and before `postRender`. `fn` must return nothing; a truthy return
 * asks for another frame.
 * @param {object} scene Cesium Scene.
 * @param {() => void} fn
 */
export function atEndOfTick(scene, fn) {
  scene._frameState.afterRender.push(fn);
}

/**
 * The scene time of the last drawn frame, for `maximumRenderTimeChange`.
 * @param {object} scene Cesium Scene.
 * @returns {object|undefined} Cesium JulianDate.
 */
export function lastRenderTime(scene) {
  return scene._lastRenderTime;
}

/**
 * The camera as the scene last saw it move, which `Scene.render` compares
 * the camera with to decide whether it moved.
 * @param {object} scene Cesium Scene.
 * @returns {object|undefined} Cesium Camera.
 */
export function lastSeenCamera(scene) {
  return scene._view?._cameraClone;
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
 * The entity Cesium's EntityView tracks: set once tracking has started and
 * framed its entity, which can be frames after `trackedEntity` is set.
 * @param {object} widget Viewer or CesiumWidget.
 * @returns {object|null} Entity.
 */
export function trackedEntityViewEntity(widget) {
  return (widget?._cesiumWidget ?? widget)?._entityView?.entity ?? null;
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

/**
 * The error a billboard's image failed to load with, if it did: Cesium
 * keeps `ready` false then, so `whenSettled` reports the failure instead of
 * waiting out its timeout.
 * @param {object} billboard Cesium Billboard.
 * @returns {Error|undefined}
 */
export function billboardLoadError(billboard) {
  return billboard.loadError;
}

const NO_CREDITS = Object.freeze([]);

/**
 * What a credit display shows, for the credits port to report: its static
 * credits, the credit elements of the frame under way or last drawn (each
 * `{credit, count}`, a static one counted `Number.MAX_VALUE`) and the logo
 * credit it shows first. Cesium's public API only adds and removes static
 * credits; the per-frame ones (imagery, terrain and tile credits) are seen
 * nowhere else.
 * @param {object} display Cesium CreditDisplay.
 * @returns {{statics: object[], screen: object[], lightbox: object[],
 *   logo: object|undefined}}
 */
export function creditDisplayContents(display) {
  const frame = display?._currentFrameCredits;
  return {
    statics: display?._staticCredits ?? NO_CREDITS,
    screen: frame?.screenCredits?.values ?? NO_CREDITS,
    lightbox: frame?.lightboxCredits?.values ?? NO_CREDITS,
    logo: display?._currentCesiumCredit,
  };
}
