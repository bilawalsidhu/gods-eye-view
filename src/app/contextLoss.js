/**
 * WebGL context-loss guard for the main application viewer.
 *
 * Cesium has no context-loss handling of its own (upstream
 * CesiumGS/cesium#5991, open since 2017): when the browser drops or evicts
 * the canvas' WebGL context — GPU process crash, OS backgrounding eviction,
 * driver reset — the drawing buffer collapses to 0×0 while the canvas'
 * layout size is unchanged, and the next frame dies in
 * `FramebufferManager → Texture` with
 * `DeveloperError: Expected width to be greater than 0`, permanently
 * stopping the render loop behind Cesium's "Rendering has stopped" panel.
 * A layout zero-size cannot hit this: Cesium skips rendering a 0×0 canvas,
 * and the drawing buffer is rebuilt once real dimensions return.
 *
 * This guard is the app-side minimum Cesium expects its embedders to
 * provide:
 *
 * - `webglcontextlost` is answered with `preventDefault()`. Without it the
 *   browser never offers the context back, so no recovery can even start.
 * - the render loop is stopped immediately, so Cesium never renders into
 *   the dead context and the error panel never appears.
 * - `scene.renderError` is a fallback detector for drivers that deliver the
 *   event late or not at all: a render error while the context reports lost
 *   counts as the same loss.
 *
 * Even with `preventDefault()`, a restored context is not enough — Cesium
 * keeps no way to rebuild its GPU resources — so recovery belongs to the
 * application lifecycle (see `createApplicationScene`, which rebuilds by
 * reloading the page; the share-link hash already persists camera, layers
 * and style). The panel runtime embeds the app into a host page it must
 * never reload, and keeps its own notice-based UX.
 */

const NOTICE_ID = 'gev-context-loss-notice';

/**
 * Install context-loss detection on a viewer. The guard always calls
 * `preventDefault()` and stops the render loop; `onLost` / `onRestored`
 * receive the events so the embedder can decide recovery. Loss reporting is
 * delivered once per loss, whichever detector sees it first.
 * @param {Cesium.Viewer} viewer
 * @param {{onLost?:Function, onRestored?:Function}} [handlers]
 * @returns {Function} Disposer removing every listener the guard installed.
 */
export function installContextLossGuard(viewer, { onLost, onRestored } = {}) {
  if (!viewer?.canvas || !viewer?.scene)
    throw new TypeError('A created Cesium viewer is required');

  let lost = false;
  let reported = false;

  const canvasContext = () =>
    viewer.canvas.getContext('webgl2') || viewer.canvas.getContext('webgl');

  const haltRenderLoop = () => {
    if (viewer.isDestroyed?.()) return;
    viewer.useDefaultRenderLoop = false;
  };

  const reportLost = (details) => {
    haltRenderLoop();
    if (reported) return;
    reported = true;
    onLost?.(details);
  };

  const onContextLost = (event) => {
    event.preventDefault();
    lost = true;
    reportLost({ reason: 'event' });
  };

  const onRenderError = (_scene, error) => {
    if (!lost && !canvasContext()?.isContextLost?.()) return;
    lost = true;
    reportLost({ reason: 'render-error', error });
  };

  const onContextRestored = () => {
    // The context is usable again, but Cesium's GPU resources are gone and
    // it cannot rebuild them; staying stopped keeps the recovery decision
    // (reload or notice) with the embedder instead of failing a second time.
    lost = false;
    reported = false;
    onRestored?.();
  };

  viewer.canvas.addEventListener('webglcontextlost', onContextLost);
  viewer.canvas.addEventListener('webglcontextrestored', onContextRestored);
  const removeRenderError =
    viewer.scene.renderError?.addEventListener(onRenderError);

  return () => {
    viewer.canvas?.removeEventListener('webglcontextlost', onContextLost);
    viewer.canvas?.removeEventListener(
      'webglcontextrestored',
      onContextRestored,
    );
    removeRenderError?.();
  };
}

/**
 * Replace Cesium's dead "Rendering has stopped" panel with a plain notice.
 * Idempotent: a repeated loss reuses the element already on screen.
 * `allowManualReload` adds the button for the standalone terminal case (the
 * guarded automatic reload did not run); the inline panel omits it because
 * the host page owns this document.
 * @param {{document?:Document, location?:Location, allowManualReload?:boolean, message?:string}} [options]
 * @returns {HTMLElement|null} The notice element, or null without a document.
 */
export function showContextLossNotice({
  document: documentRef = globalThis.document,
  location = globalThis.location,
  allowManualReload = false,
  message,
} = {}) {
  if (!documentRef?.body) return null;
  let notice = documentRef.getElementById(NOTICE_ID);
  if (!notice) {
    notice = documentRef.createElement('div');
    notice.id = NOTICE_ID;
    notice.setAttribute('role', 'alert');
    Object.assign(notice.style, {
      position: 'fixed',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '99999',
      maxWidth: 'min(560px, calc(100vw - 32px))',
      padding: '12px 18px',
      borderRadius: '10px',
      background: 'rgba(10, 14, 20, 0.92)',
      border: '1px solid rgba(255, 255, 255, 0.18)',
      color: '#e8edf4',
      font: '14px/1.5 system-ui, sans-serif',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.45)',
    });
    documentRef.body.appendChild(notice);
  }
  const text = message ?? "God's Eye View lost its 3D graphics context.";
  let body = notice.querySelector('span');
  if (!body) {
    body = documentRef.createElement('span');
    notice.appendChild(body);
  }
  body.textContent = text;
  let button = notice.querySelector('button');
  if (allowManualReload && !button) {
    button = documentRef.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload';
    Object.assign(button.style, {
      marginLeft: '12px',
      padding: '4px 14px',
      borderRadius: '8px',
      border: '1px solid rgba(255, 255, 255, 0.3)',
      background: 'rgba(255, 255, 255, 0.08)',
      color: '#e8edf4',
      cursor: 'pointer',
      font: 'inherit',
    });
    button.addEventListener('click', () => location?.reload?.());
    notice.appendChild(button);
  }
  return notice;
}

/**
 * Remove Cesium's "Rendering has stopped" panel when recovery takes over.
 * The error-first route (the loss event arriving after a frame already
 * rendered) gets the panel from Cesium right after it raises the
 * `renderError` event, so the removal is scheduled as a task. Harmless when
 * the event-first route never let a frame fail.
 * @param {{document?:Document, schedule?:Function}} [options] Injectable for tests.
 * @returns {void}
 */
export function dismissCesiumErrorPanel({
  document: documentRef = globalThis.document,
  schedule = (fn) => setTimeout(fn, 0),
} = {}) {
  schedule(() => {
    documentRef
      ?.querySelectorAll('.cesium-widget-errorPanel')
      .forEach((panel) => panel.remove());
  });
}

/** sessionStorage flag holding the time of the last recovery reload. */
const RELOAD_FLAG = 'gev:context-loss-reload-at';
/** A loss right after a recovery reload means the machine cannot hold a
 * context (or boot itself loses one); stop reloading and ask instead. */
const RELOAD_WINDOW_MS = 30_000;

/**
 * Whether an automatic recovery reload is allowed right now. Refused (never
 * allowed) when web storage is unavailable, and blocked within the cooldown
 * window after a previous recovery reload.
 * @param {{sessionStorage?:Storage, now?:Function}} [options] Injectable for tests.
 * @returns {boolean}
 */
export function canReloadAfterContextLoss({
  sessionStorage = globalThis.sessionStorage,
  now = Date.now,
} = {}) {
  try {
    const last = Number(sessionStorage?.getItem(RELOAD_FLAG));
    return !Number.isFinite(last) || now() - last > RELOAD_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Record that a recovery reload is starting, arming the cooldown window.
 * @param {{sessionStorage?:Storage, now?:Function}} [options] Injectable for tests.
 * @returns {void}
 */
export function markContextLossReload({
  sessionStorage = globalThis.sessionStorage,
  now = Date.now,
} = {}) {
  try {
    sessionStorage?.setItem(RELOAD_FLAG, String(now()));
  } catch {
    // Unreachable after canReloadAfterContextLoss refused the same storage;
    // without the flag the cooldown simply does not arm.
  }
}
