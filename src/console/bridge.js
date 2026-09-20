/**
 * The console's read-only window onto the running application.
 *
 * The console is additive chrome: it owns no scene state and constructs
 * nothing. It reads the debug handle the application publishes on `window`,
 * and drives existing behaviour through the controls that already own it —
 * the layer lifecycle for feeds, the style manager for visual presets, and a
 * panel's own disclosure button for panels. Nothing here reimplements an
 * action the application already performs, so a console command and the
 * equivalent click settle in exactly the same state.
 *
 * Every accessor is defensive. The handle appears only once bootstrap has
 * finished, disappears on teardown, and the viewer can be destroyed while a
 * frame is still in flight, so a missing piece degrades the readout rather
 * than throwing into the render loop.
 */

const HANDLE_KEY = '__godsEyeView';
const HANDLE_POLL_MS = 120;

/** The application's debug handle, or null before bootstrap and after teardown. */
export function applicationHandle(win = window) {
  const handle = win?.[HANDLE_KEY];
  return handle && typeof handle === 'object' ? handle : null;
}

/** Whether a Cesium viewer is still usable this frame. */
function liveViewer(viewer) {
  if (!viewer || typeof viewer !== 'object') return null;
  try {
    if (viewer.isDestroyed?.()) return null;
  } catch {
    return null;
  }
  return viewer.scene ? viewer : null;
}

/**
 * Resolve the application handle, then call back once.
 * @param {object} [options]
 * @param {Window} [options.win] Host window.
 * @param {AbortSignal} [options.signal] Cancels the wait.
 * @param {(handle: object) => void} options.onReady Receives the handle.
 * @returns {{ destroy: () => void }} Idempotent cancellation.
 */
export function whenApplicationReady({ win = window, signal, onReady } = {}) {
  let timer = null;
  let settled = false;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const attempt = () => {
    if (settled || signal?.aborted) return true;
    const handle = applicationHandle(win);
    if (!handle?.viewer) return false;
    settled = true;
    stop();
    onReady?.(handle);
    return true;
  };
  if (!attempt()) {
    timer = setInterval(attempt, HANDLE_POLL_MS);
    signal?.addEventListener?.('abort', stop, { once: true });
  }
  return { destroy: stop };
}

const DEGREES = 180 / Math.PI;

/**
 * Camera position and attitude in degrees and metres.
 * @param {object|null} viewer Cesium viewer from the application handle.
 * @returns {{latitude:number,longitude:number,height:number,heading:number,pitch:number}|null}
 */
export function cameraTelemetry(viewer) {
  const live = liveViewer(viewer);
  if (!live) return null;
  try {
    const camera = live.camera;
    const carto = camera?.positionCartographic;
    if (!carto) return null;
    return {
      latitude: carto.latitude * DEGREES,
      longitude: carto.longitude * DEGREES,
      height: carto.height,
      heading: camera.heading * DEGREES,
      pitch: camera.pitch * DEGREES,
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe to rendered globe frames.
 * Counts the same event the existing frame-rate readout counts, so the two
 * never disagree about what a frame is.
 * @param {object|null} viewer Cesium viewer.
 * @param {() => void} onFrame Called once per rendered frame.
 * @returns {() => void} Unsubscribe; safe to call after teardown.
 */
export function onRenderedFrame(viewer, onFrame) {
  const live = liveViewer(viewer);
  const event = live?.scene?.postRender;
  if (!event?.addEventListener) return () => {};
  let remove;
  try {
    remove = event.addEventListener(onFrame);
  } catch {
    return () => {};
  }
  return () => {
    try {
      remove?.();
    } catch {
      /* the scene was torn down first; the listener went with it */
    }
  };
}

/** A registered panel element, whether or not it is currently open. */
export function panelElement(panelId, documentRef = document) {
  if (!panelId) return null;
  return documentRef.getElementById(panelId);
}

/** Whether a panel is presently expanded. */
export function isPanelOpen(panelId, documentRef = document) {
  const panel = panelElement(panelId, documentRef);
  return Boolean(panel) && !panel.classList.contains('collapsed');
}

/**
 * The control that owns a panel's disclosure.
 * Dock trays and stacked panels use different buttons; both are the panel's
 * own control, so clicking one runs the application's disclosure logic —
 * focus handling, pinning and rail layout included.
 */
export function panelDisclosureControl(panelId, documentRef = document) {
  if (!panelId) return null;
  return documentRef.querySelector(
    `[data-dock-toggle-target="${panelId}"], [data-collapse-target="${panelId}"]`,
  );
}

/**
 * Toggle a panel through its own disclosure control.
 * @returns {boolean} Whether a control was found to click.
 */
export function togglePanel(panelId, documentRef = document) {
  const control = panelDisclosureControl(panelId, documentRef);
  if (!control) return false;
  control.click();
  return true;
}

/** Open or close a panel, leaving it alone when it already matches. */
export function setPanelOpen(panelId, open, documentRef = document) {
  if (isPanelOpen(panelId, documentRef) === Boolean(open)) return true;
  return togglePanel(panelId, documentRef);
}

/** Click an existing application control, reporting whether it was present. */
export function clickControl(selector, documentRef = document) {
  const element = documentRef.querySelector(selector);
  if (!element || element.disabled) return false;
  element.click();
  return true;
}

/** The visual style the application currently has applied. */
export function activeStyleName(documentRef = document) {
  return documentRef.documentElement?.dataset?.gevStyle || 'normal';
}

/**
 * Layers the application has registered, normalized for console rendering.
 * @param {object|null} dataManager Layer lifecycle from the handle.
 * @returns {Array<object>} One entry per user-visible layer; empty when absent.
 */
export function layerRoster(dataManager) {
  if (typeof dataManager?.getAll !== 'function') return [];
  let layers;
  try {
    layers = dataManager.getAll();
  } catch {
    return [];
  }
  if (!Array.isArray(layers)) return [];
  return layers
    .filter((layer) => layer && layer.showInTogglePanel !== false)
    .map((layer) => ({
      id: layer.id,
      name: layer.name || layer.id,
      icon: layer.icon || '',
      enabled: Boolean(layer.enabled),
      lifecycleState: layer.lifecycleState || '',
      stats: layer.stats || {},
      keyRequired: layer.stats?.keyRequired === true,
    }));
}

/**
 * Request a layer visibility change through the lifecycle that owns it.
 * Marked as user origin so it obeys the same precedence as a panel click.
 * @returns {Promise<boolean>} Whether the request was accepted.
 */
export async function setLayerEnabled(dataManager, layerId, enabled) {
  if (typeof dataManager?.setEnabled !== 'function') return false;
  try {
    await dataManager.setEnabled(layerId, Boolean(enabled), {
      origin: 'user',
    });
    return true;
  } catch {
    return false;
  }
}

/** Subscribe to layer lifecycle changes; returns a no-op when unavailable. */
export function subscribeLayers(dataManager, listener) {
  if (typeof dataManager?.subscribe !== 'function') return () => {};
  try {
    return dataManager.subscribe(listener) || (() => {});
  } catch {
    return () => {};
  }
}

/** Apply a visual preset through the style manager that owns the transition. */
export function applyVisualStyle(styleManager, styleName) {
  if (typeof styleManager?.setStyle !== 'function') return false;
  try {
    styleManager.setStyle(styleName);
    return true;
  } catch {
    return false;
  }
}
