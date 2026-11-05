import { useStatusStore } from './stores/status.js';
import { applicationPinia } from './vueRuntime.js';
import { describeError } from '../app/errors.js';
import { appRootUrl } from '../share/shareLinkPath.js';

/**
 * Tell the user when the globe stops drawing, rather than leave a black globe
 * behind controls that still respond. Cesium stops its render loop after a
 * render error, and a page whose WebGL context was lost never draws again.
 *
 * The notice is published to the status store, which the scene chrome
 * renders. Retry restarts the render loop after an error, and the notice stays
 * until a frame renders without one; after a context loss it reloads the page,
 * whose address keeps the view. Reset opens the app's root address, without
 * the view restored from the address bar. Where the page must not reload
 * itself (`allowReload: false`), Reset is left out, and so is Retry after a
 * context loss.
 *
 * Returns a function that removes the listeners and the notice.
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
  const scene = viewer?.scene;
  if (!scene?.renderError) return () => {};
  const canvas = viewer.canvas ?? scene.canvas;
  let notice = null;
  let shown = 0;
  let contextLost = false;
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
      shown: notice ? notice.shown : ++shown,
      retry: contextLost && !allowReload ? null : retry,
      reset: allowReload ? reset : null,
    };
    store.publishRenderFailure(notice);
    watchFrames();
  }

  const onRenderError = (_scene, error) => {
    frameFailed = true;
    logError(error);
    present(describeError(error));
  };
  const onContextLost = () => {
    contextLost = true;
    // No frame can clear this one; only a reload draws again.
    stopWatchingFrames();
    present('');
  };

  const removeRenderError = scene.renderError.addEventListener(onRenderError);
  canvas?.addEventListener?.('webglcontextlost', onContextLost);
  return () => {
    removeRenderError();
    canvas?.removeEventListener?.('webglcontextlost', onContextLost);
    clear();
  };
}
