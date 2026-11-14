import { useStatusStore } from './stores/status.js';
import { applicationPinia } from './vueRuntime.js';
import { describeError } from '../app/errors.js';
import { appRootUrl } from '../share/shareLinkPath.js';

/**
 * Show a recoverable notice when the globe stops drawing, instead of a black
 * globe behind working controls. Retry restarts the render loop, or reloads
 * after a lost WebGL context; Reset opens the app's root address. With
 * `allowReload: false`, Reset is dropped and a lost context shows no notice:
 * only a reload draws again, and the page says so itself.
 * Returns a function that removes the notice.
 */
export function installRenderFailureNotice(
  viewer,
  {
    store = useStatusStore(applicationPinia()),
    locationRef = globalThis.location,
    allowReload = true,
    logError = (error) =>
      console.error('[Render] The globe stopped drawing:', error),
  } = {},
) {
  const { scene } = viewer;
  const { canvas } = viewer;
  let notice = null;
  let contextLost = false;
  // With rethrowRenderErrors, Scene throws the error it has just raised;
  // the render() wrapper must not raise it again.
  let raisedByScene = null;
  let frameFailed = false;
  let removeFrameListeners = null;

  function retry() {
    if (contextLost) {
      locationRef.reload();
      return;
    }
    viewer.useDefaultRenderLoop = true;
    scene.requestRender();
  }

  function reset() {
    locationRef.assign(appRootUrl(locationRef.href));
  }

  function stopWatchingFrames() {
    removeFrameListeners?.();
    removeFrameListeners = null;
  }

  function clear() {
    stopWatchingFrames();
    if (store.renderFailure === notice) store.publishRenderFailure(null);
    notice = null;
  }

  // Cesium raises postRender after a failed frame too, so only a frame that
  // starts and ends without a render error clears the notice.
  function watchFrames() {
    if (removeFrameListeners || contextLost) return;
    const removeStart = scene.preUpdate.addEventListener(() => {
      frameFailed = false;
      raisedByScene = null;
    });
    const removeEnd = scene.postRender.addEventListener(() => {
      if (!frameFailed) clear();
    });
    removeFrameListeners = () => {
      removeStart();
      removeEnd();
    };
  }

  function present(detail) {
    const reason = contextLost ? 'context-lost' : 'render-error';
    // A loop restarted into the same error keeps the notice as it was.
    if (notice?.reason === reason && notice.detail === detail) return;
    notice = {
      reason,
      detail,
      retry,
      reset: allowReload ? reset : null,
    };
    store.publishRenderFailure(notice);
    watchFrames();
  }

  const onRenderError = (_scene, error) => {
    raisedByScene = { error };
    frameFailed = true;
    logError(error);
    // A lost context fails every frame after it; the notice keeps saying why.
    if (contextLost) return;
    present(error ? describeError(error) : '');
  };
  const onContextLost = () => {
    contextLost = true;
    // No frame can clear this one; only a reload draws again.
    stopWatchingFrames();
    // A page that must not reload has nothing to offer: an inline panel
    // shows its own lost-context notice (src/app/globePanelRuntime.js).
    if (!allowReload) {
      clear();
      return;
    }
    present('');
  };

  const removeRenderError = scene.renderError.addEventListener(onRenderError);
  // An error thrown outside Scene's error handling (a frame listener, onTick,
  // resize) stops the loop without a renderError. Raise one, so Cesium, an
  // inline panel's timer and this notice all see it. First finish the event
  // raises it cut short, so listeners added or removed meanwhile apply.
  const unguard = ['resize', 'render'].map((name) =>
    reportThrown(viewer.cesiumWidget, name, (error) => {
      frameEvents(viewer).forEach(finishRaise);
      if (!raisedByScene || raisedByScene.error !== error)
        scene.renderError.raiseEvent(scene, error);
      raisedByScene = null;
    }),
  );
  canvas.addEventListener('webglcontextlost', onContextLost);
  return () => {
    removeRenderError();
    unguard.forEach((restore) => restore());
    canvas.removeEventListener('webglcontextlost', onContextLost);
    clear();
  };
}

/**
 * Events Cesium raises in a frame outside Scene's error handling, which a
 * listener's error can leave mid-raise. Only top-level tilesets are reached.
 */
function frameEvents(viewer) {
  const { scene } = viewer;
  const events = [
    scene.preUpdate,
    scene.postUpdate,
    scene.preRender,
    scene.postRender,
    scene.camera?.changed,
    scene.camera?.moveStart,
    scene.camera?.moveEnd,
    viewer.clock?.onTick,
    viewer.clock?.onStop,
    scene.globe?.tileLoadProgressEvent,
  ];
  const primitives = scene.primitives;
  for (let i = 0; i < (primitives?.length ?? 0); i += 1) {
    const tileset = primitives.get(i);
    events.push(
      tileset?.loadProgress,
      tileset?.allTilesLoaded,
      tileset?.initialTilesLoaded,
    );
  }
  return events;
}

/**
 * Finish a raise a throwing listener cut short. Until a raise ends, Cesium's
 * `Event` only queues added and removed listeners; apply that queue.
 * These are Cesium's private fields (`_invokingListeners`, `_toAdd`,
 * `_toRemove`, `_listeners`, and the widget's `_renderLoopRunning`), checked
 * against cesium 1.138 / @cesium/engine 22.3.0; the render loop fixture tests
 * drive the real classes and fail when an upgrade renames them.
 */
function finishRaise(event) {
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
 * Report an error the widget's `name` method throws, and rethrow it.
 *
 * A render error marks the loop stopped, but a call made while it ran leaves
 * its next frame queued, and that frame stops it. Keep the loop marked
 * running, so a Retry or a shown tab before that frame starts no second loop.
 * After a throw, the loop's own catch still marks it stopped.
 */
function reportThrown(widget, name, report) {
  const original = widget?.[name];
  if (typeof original !== 'function') return () => {};
  const own = Object.hasOwn(widget, name);
  const guarded = function (...args) {
    const looping = widget._renderLoopRunning;
    try {
      return original.apply(this, args);
    } catch (error) {
      report(error);
      throw error;
    } finally {
      if (looping) widget._renderLoopRunning = true;
    }
  };
  widget[name] = guarded;
  return () => {
    if (widget[name] !== guarded) return;
    if (own) widget[name] = original;
    else delete widget[name];
  };
}
