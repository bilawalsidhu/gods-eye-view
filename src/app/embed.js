/**
 * Embed mode and views in the running app.
 *
 * With `?embed=1` the app shows only the globe: clean view, with the HUD,
 * welcome and setup prompts hidden. A page that frames it changes what it
 * shows by posting `{ type: 'gev:view', id, view }`; the app applies the view
 * through its own actions and answers `{ type: 'gev:view-applied', id, ok,
 * steps }`. It announces `{ type: 'gev:ready' }` once it can take views.
 *
 * Annotations in a share link are drawn once the link has been restored,
 * embedded or not.
 */

import { announceNavigationAuthority } from '../navigationPolicy.js';
import { toRadians } from '../geo/index.js';
import { cameraOf } from '../render/rendererOf.js';
import { annotationsFromParams, createView } from '../view/index.js';

const EMBED_VIEW_MESSAGE = 'gev:view';
const EMBED_APPLIED_MESSAGE = 'gev:view-applied';
const EMBED_READY_MESSAGE = 'gev:ready';

const FOLLOW_LAYERS = {
  aircraft: 'flights',
  military_aircraft: 'military',
  satellite: 'satellites',
};
const FOLLOW_ATTEMPTS = 20;
const FOLLOW_RETRY_MS = 1000;
const FLIGHT_SECONDS = 2;

/**
 * Whether this page shows the app embedded: `?embed=1` when another page
 * frames it, or inline when a panel page loads the app into itself and sets
 * `globalThis.GEV_EMBED_INLINE` first.
 */
export function isEmbedded(location = globalThis.location) {
  return (
    isEmbeddedInline() ||
    new URLSearchParams(location?.search || '').get('embed') === '1'
  );
}

/** Whether a panel page loaded the app into itself. */
export function isEmbeddedInline() {
  return globalThis.GEV_EMBED_INLINE === true;
}

/**
 * `doc`'s visibility for work that pauses in a hidden page. A panel's host
 * may report it hidden while it is on screen (see keepPanelRendering in
 * render/cesium/panelRendering.js), so an
 * inline panel always reads as visible.
 */
export function panelAwareVisibility(doc = globalThis.document) {
  const hidden = () =>
    (doc.hidden === true || doc.visibilityState === 'hidden') &&
    !isEmbeddedInline();
  return {
    get hidden() {
      return hidden();
    },
    get visibilityState() {
      return hidden() ? 'hidden' : 'visible';
    },
    addEventListener: (type, listener) => doc.addEventListener(type, listener),
    removeEventListener: (type, listener) =>
      doc.removeEventListener(type, listener),
  };
}

const delay = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Fly the camera to a view's camera and resolve when the flight ends. */
function flyTo(viewer, camera) {
  announceNavigationAuthority('embed-view');
  return new Promise((resolve) => {
    cameraOf(viewer).flyTo(
      { lon: camera.lon, lat: camera.lat, height: camera.altitude_m },
      {
        orientation: {
          heading: toRadians(camera.heading_deg),
          pitch: toRadians(camera.pitch_deg),
          roll: 0,
        },
        durationS: FLIGHT_SECONDS,
        onComplete: () => resolve(true),
        onCancel: () => resolve(false),
      },
    );
  });
}

/**
 * Make the app show a view: style and map, exactly the view's layers,
 * annotations, the camera, and the followed entity. Each step runs through the
 * app's own actions (`run(name, args)`); a failed step is reported and the
 * rest still run. Resolves to the steps and whether each succeeded.
 */
export async function applyView(
  view,
  { viewer, dataManager, run, signal, retryMs = FOLLOW_RETRY_MS },
) {
  const steps = [];
  const act = async (name, args) => {
    let result = null;
    try {
      result = await run(name, args);
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    steps.push({
      step: name,
      ok: result?.ok !== false,
      ...(result?.error ? { error: result.error } : {}),
    });
    return result;
  };
  if (view.style) await act('set_visual_style', { style: view.style });
  if (view.map) await act('set_map_stack', { stack: view.map });
  const wanted = new Set(view.layers);
  for (const layer of dataManager.getAll()) {
    if (layer.enabled && !wanted.has(layer.id))
      await act('set_layer_visibility', { layerId: layer.id, enabled: false });
  }
  for (const layerId of view.layers) {
    if (!dataManager.isEnabled(layerId))
      await act('set_layer_visibility', { layerId, enabled: true });
  }
  if (!view.follow) await act('stop_tracking', {});
  // Annotations go first: drawing them may frame the marks, and the view's
  // own camera should have the last word.
  await act('clear_annotations', {});
  if (view.annotations.length)
    await act('annotate_map', { annotations: [...view.annotations] });
  if (!view.follow) {
    steps.push({ step: 'camera', ok: await flyTo(viewer, view.camera) });
    return steps;
  }
  // A followed entity owns the camera, and a camera flight would end the
  // follow, so fly to the view only while the entity is not there yet. It
  // appears once its layer has data; retry until then.
  const layerId = FOLLOW_LAYERS[view.follow.kind];
  const follow = async () => {
    try {
      return (
        (await run('track_entity', { query: view.follow.id, layerId }))?.ok ===
        true
      );
    } catch {
      return false;
    }
  };
  let followed = await follow();
  if (!followed) {
    steps.push({ step: 'camera', ok: await flyTo(viewer, view.camera) });
    for (let attempt = 1; attempt < FOLLOW_ATTEMPTS && !followed; attempt++) {
      if (signal?.aborted) break;
      await delay(retryMs, signal);
      followed = await follow();
    }
  }
  steps.push({ step: 'follow', ok: followed });
  if (followed && view.follow.cockpit)
    await act('control_cockpit', { action: 'enter', targetLayer: layerId });
  return steps;
}

/**
 * Install embed mode when the page asks for it, and draw any annotations the
 * opening link carries. Returns a function that removes the message handler.
 * `keepRendering({windowRef})` keeps the globe drawing in an inline panel
 * whose host stops animation frames, and returns a function that stops it;
 * the application scene gives it (`keepPanelRendering`).
 */
export function installViews({
  shell,
  viewer,
  dataManager,
  run,
  signal,
  keepRendering = null,
  location = globalThis.location,
  windowRef = globalThis.window,
}) {
  const ready = Promise.resolve(shell.initialRestorePromise).catch(() => {});
  const linked = annotationsFromParams(
    new URLSearchParams(String(location?.hash || '').replace(/^#/, '')),
  );
  if (linked.length)
    void ready.then(() => {
      if (!signal?.aborted) void run('annotate_map', { annotations: linked });
    });
  if (!isEmbedded(location)) return () => {};

  windowRef.document.body.classList.add('ui-embed');
  shell.setCleanView?.(true);
  const stopRendering =
    isEmbeddedInline() && keepRendering
      ? keepRendering({ windowRef })
      : () => {};
  // A framing page talks to the app across frames; an inline panel shares
  // the page with it and talks through the page's own window.
  const peer = isEmbeddedInline() ? windowRef : windowRef.parent;
  // Answers go back only to the origin that asked. An inline panel posts to
  // its own window, and a sandboxed framing page has no origin to name.
  const post = (message, origin = '*') => {
    if (peer && (peer !== windowRef || isEmbeddedInline()))
      peer.postMessage(message, origin);
  };
  // Views apply one at a time, in the order they arrive.
  let queue = ready;
  const onMessage = (event) => {
    if (event.source !== peer || event.data?.type !== EMBED_VIEW_MESSAGE)
      return;
    const { id = null } = event.data;
    const replyOrigin =
      isEmbeddedInline() || !event.origin || event.origin === 'null'
        ? '*'
        : event.origin;
    let view;
    try {
      view = createView(event.data.view);
    } catch (error) {
      post(
        {
          type: EMBED_APPLIED_MESSAGE,
          id,
          ok: false,
          error: error.message,
        },
        replyOrigin,
      );
      return;
    }
    queue = queue.then(async () => {
      if (signal?.aborted) return;
      const steps = await applyView(view, { viewer, dataManager, run, signal });
      post(
        {
          type: EMBED_APPLIED_MESSAGE,
          id,
          ok: steps.every((step) => step.ok),
          steps,
        },
        replyOrigin,
      );
    });
  };
  windowRef.addEventListener('message', onMessage);
  void ready.then(() => {
    if (!signal?.aborted) post({ type: EMBED_READY_MESSAGE });
  });
  return () => {
    stopRendering();
    windowRef.removeEventListener('message', onMessage);
  };
}
