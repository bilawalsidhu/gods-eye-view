/**
 * @module render/cesium/internals
 * @description Every read or write of a private Cesium field, in one place.
 *
 * The app otherwise uses Cesium's public API. Each helper here names one private
 * field the app depends on and says why; `internals.test.mjs` fails when the
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
 * Whether the widget's render loop is marked running. The render failure
 * notice keeps it marked while a frame it wraps throws, so a Retry before the
 * loop's queued frame starts no second loop.
 * @param {object} widget CesiumWidget.
 * @returns {boolean}
 */
export function renderLoopRunning(widget) {
  return widget?._renderLoopRunning === true;
}

/**
 * Mark the widget's render loop running again (see `renderLoopRunning`).
 * @param {object} widget CesiumWidget.
 */
export function markRenderLoopRunning(widget) {
  if (widget) widget._renderLoopRunning = true;
}

/**
 * Finish a raise a throwing listener cut short. Until a raise ends, Cesium's
 * `Event` only queues added and removed listeners (`_toAdd`, `_toRemove`);
 * apply that queue to `_listeners` and end the raise
 * (`_invokingListeners`). Used by the render failure notice.
 * @param {object} event Cesium Event.
 */
export function finishEventRaise(event) {
  if (!event?._invokingListeners) return;
  event._invokingListeners = false;
  for (const [listener, scopes] of event._toAdd) {
    const added = event._listeners.get(listener) ?? new Set();
    scopes.forEach((scope) => added.add(scope));
    event._listeners.set(listener, added);
  }
  event._toAdd.clear();
  for (const [listener, scopes] of event._toRemove) {
    const left = event._listeners.get(listener);
    scopes.forEach((scope) => left?.delete(scope));
    if (left?.size === 0) event._listeners.delete(listener);
  }
  event._toRemove.clear();
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
  // A scene without Cesium's frame state (a stand-in) has no tick to end.
  scene._frameState?.afterRender?.push(fn);
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
 * Whether the scene drew its globe depth into its own framebuffer this frame,
 * the depth a direct read of the pick-depth textures relies on.
 * @param {object} scene Cesium Scene.
 * @returns {boolean|undefined}
 */
export function usesGlobeDepthFramebuffer(scene) {
  return scene?._environmentState?.useGlobeDepthFramebuffer;
}

/**
 * A Cesium Framebuffer's own WebGL framebuffer.
 * @param {object} framebuffer Cesium Framebuffer.
 * @returns {WebGLFramebuffer|undefined}
 */
export function rawFramebuffer(framebuffer) {
  return framebuffer?._framebuffer;
}

/**
 * A Cesium Texture's own WebGL texture.
 * @param {object} texture Cesium Texture.
 * @returns {WebGLTexture|undefined}
 */
export function rawTexture(texture) {
  return texture?._texture;
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

/**
 * Frees the globe tiles the frame just drawn did not use. Cesium trims its
 * tile cache only while tiles are loading, so a settled view never would;
 * the renderer's `releaseUnused` trims it after a drawn frame, while the
 * queue still marks what that frame drew.
 * @param {object} globe Cesium Globe.
 */
export function trimGlobeTiles(globe) {
  globe?._surface?._tileReplacementQueue?.trimTiles(0);
}

/**
 * The globe tiles the last frame drew, for timed imagery to tell when a
 * frame's own imagery is what they draw (`imageryFrames.js`); Cesium says
 * only whether every tile has loaded, prefetched layers included.
 * @param {object} globe Cesium Globe.
 * @returns {object[]} Cesium QuadtreeTiles.
 */
export function globeTilesDrawn(globe) {
  return globe?._surface?._tilesToRender ?? [];
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

/**
 * The texture a material holds for an image uniform. A material takes a
 * texture handed to a uniform (and destroys it when it takes the next one,
 * or is destroyed) only when it next updates; `draw.js` destroys one handed
 * over but never taken, so it does not leak.
 * @param {object} material Cesium Material.
 * @param {string} uniform The uniform's name.
 * @returns {object|undefined} Cesium Texture.
 */
export function materialTexture(material, uniform) {
  return material?._textures?.[uniform];
}
