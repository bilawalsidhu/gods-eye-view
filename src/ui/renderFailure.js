import { useStatusStore } from './stores/status.js';
import { applicationPinia } from './vueRuntime.js';
import { describeError } from '../app/errors.js';
import { appRootUrl } from '../share/shareLinkPath.js';

/**
 * Tell the user when the globe stops drawing, rather than leave a black globe
 * behind controls that still respond. Cesium stops its render loop after a
 * render error, and a page whose WebGL context was lost never draws again.
 *
 * Retry restarts the loop, and the notice stays until a frame renders without
 * an error; after a context loss Retry reloads the page. Reset opens the app's
 * root address. With `allowReload: false`, Reset is left out, and so is Retry
 * after a context loss. Returns a function that removes the notice.
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
  const canvas = viewer.canvas ?? scene.canvas;
  let notice = null;
  let contextLost = false;
  // The error Scene raised as a render error and, with rethrowRenderErrors,
  // throws on: the render() wrapper must not raise it a second time.
  let raisedByScene = null;
  let frameFailed = false;
  let removeFrameListeners = null;

  function retry() {
    if (contextLost) {
      locationRef.reload();
      return;
    }
    viewer.useDefaultRenderLoop = true;
    scene.requestRender?.();
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
      retry: contextLost && !allowReload ? null : retry,
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
    present('');
  };

  const removeRenderError = scene.renderError.addEventListener(onRenderError);
  // An error thrown outside Scene's own error handling (a preRender or
  // postRender listener, the clock's onTick, a resize) also stops Cesium's
  // render loop, but raises no renderError, and Cesium reports it only in the
  // panel the app turns off. Raise it as a render error, so Cesium's handler,
  // an inline panel's timer and this notice all see it. Such an error passes
  // here before anything else runs, so finish the raises of frameEvents() it
  // cut short first: listeners added or removed while the loop is stopped
  // then apply at once, in order.
  const unguard = ['resize', 'render'].map((name) =>
    reportThrown(viewer.cesiumWidget, name, (error) => {
      frameEvents(viewer).forEach(finishRaise);
      if (!raisedByScene || raisedByScene.error !== error)
        scene.renderError.raiseEvent(scene, error);
      raisedByScene = null;
    }),
  );
  canvas?.addEventListener?.('webglcontextlost', onContextLost);
  return () => {
    removeRenderError();
    unguard.forEach((restore) => restore());
    canvas?.removeEventListener?.('webglcontextlost', onContextLost);
    clear();
  };
}

/**
 * The events Cesium raises in a frame outside Scene's own error handling, so
 * that a listener's error cuts their raise short: Scene's frame events, the
 * camera's and the clock's, and those raised after the frame renders, the
 * globe's tile load progress and the load events of the scene's tilesets.
 * Tilesets nested in a collection are not reached.
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
      tileset?.tileLoad,
    );
  }
  return events;
}

/**
 * Finish the raise a throwing listener cut short. Cesium's `Event.raiseEvent`
 * marks the event as raising until every listener returns, and until then it
 * only queues the listeners added or removed. Apply the queue as the raise
 * would have, so listeners added or removed from here on take effect at once.
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
 * Report an error the widget's `name` method throws, and throw it on.
 *
 * A render error marks Cesium's render loop stopped, but a call made while
 * the loop ran leaves the loop's next animation frame queued: the loop queues
 * it after a call that returns, and a frame an inline panel's timer draws
 * leaves it queued. That frame stops the loop itself, and a Retry or a shown
 * tab that comes first must not start a second loop beside it, so the loop
 * stays marked running. A call from the loop that throws is still marked
 * stopped by the loop's own catch.
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
