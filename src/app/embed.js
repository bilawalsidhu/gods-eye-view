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

import * as Cesium from 'cesium';
import { announceNavigationAuthority } from '../navigationPolicy.js';
import {
  annotationsFromParams,
  createView,
  followFromParams,
  streetLevelFromParams,
} from '../view/index.js';

const EMBED_VIEW_MESSAGE = 'gev:view';
const EMBED_APPLIED_MESSAGE = 'gev:view-applied';
const EMBED_READY_MESSAGE = 'gev:ready';

const STREET_LEVEL_LAYER = 'street-level';
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

// A panel keeps drawing at about this rate when its host stops animation
// frames; see keepPanelRendering.
const PANEL_FRAME_MS = 33;
const MISSED_FRAMES_MS = 250;

/** A render error's details, including the plain objects workers report. */
function describeError(error) {
  if (error instanceof Error)
    return `${error.name}: ${error.message}\n${error.stack}`;
  try {
    return JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}));
  } catch {
    return String(error);
  }
}

/**
 * Keep the globe drawing in an inline panel. Some hosts report a panel on
 * screen as hidden, which stops the browser's animation frames and with them
 * Cesium's render loop; while frames stop arriving, draw from a timer.
 * Returns a function that stops it.
 */
export function keepPanelRendering(
  viewer,
  { windowRef = globalThis.window, now = () => performance.now() } = {},
) {
  let lastFrame = now();
  let frameRequest = null;
  const onFrame = () => {
    lastFrame = now();
    frameRequest = windowRef.requestAnimationFrame(onFrame);
  };
  frameRequest = windowRef.requestAnimationFrame(onFrame);
  // Cesium stops drawing after a render error, and so does the timer.
  // Report the error in full: workers report plain objects, which Cesium
  // prints as [object Object].
  let failed = false;
  const removeErrorListener = viewer.scene?.renderError?.addEventListener(
    (_scene, error) => {
      failed = true;
      console.error(
        "[God's Eye View panel] render error:",
        describeError(error),
      );
    },
  );
  const timer = windowRef.setInterval(() => {
    if (
      failed ||
      now() - lastFrame < MISSED_FRAMES_MS ||
      viewer.isDestroyed?.()
    )
      return;
    viewer.resize();
    viewer.render();
  }, PANEL_FRAME_MS);
  return () => {
    windowRef.clearInterval(timer);
    windowRef.cancelAnimationFrame(frameRequest);
    removeErrorListener?.();
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
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        camera.altitude_m,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(camera.heading_deg),
        pitch: Cesium.Math.toRadians(camera.pitch_deg),
        roll: 0,
      },
      duration: FLIGHT_SECONDS,
      complete: () => resolve(true),
      cancel: () => resolve(false),
    });
  });
}

/**
 * The `show_street_level` arguments for a view's street-level photos. A plain
 * link (`autoOpen: false`) never loads a photo from a source that bills every
 * load: the app arms the panel and the OPEN button is one click away. A view
 * posted into the embedded app is the client's own request and opens.
 */
function streetLevelArgs(streetLevel, { autoOpen = true } = {}) {
  return {
    latitude: streetLevel.lat,
    longitude: streetLevel.lon,
    ...(streetLevel.provider ? { provider: streetLevel.provider } : {}),
    fly: true,
    ...(autoOpen ? {} : { autoOpen: false }),
  };
}

const STREET_LEVEL_PANEL_ID = 'street-level-panel';
const ARMED_TOAST =
  'Street View is ready: press OPEN GOOGLE STREET VIEW to load it';

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
    // The street-level action lights its source first, then the layer.
    if (view.street_level && layerId === STREET_LEVEL_LAYER) continue;
    if (!dataManager.isEnabled(layerId))
      await act('set_layer_visibility', { layerId, enabled: true });
  }
  if (!view.follow) await act('stop_tracking', {});
  // Annotations go first: drawing them may frame the marks, and the view's
  // own camera should have the last word.
  await act('clear_annotations', {});
  if (view.annotations.length)
    await act('annotate_map', { annotations: [...view.annotations] });
  if (view.street_level) {
    // The photos frame the camera: the action flies to the point at street
    // level, lights the source and opens the nearest photo. When it fails
    // before flying, the view's own camera still applies.
    const result = await act(
      'show_street_level',
      streetLevelArgs(view.street_level),
    );
    if (result?.ok !== true && !result?.location)
      steps.push({ step: 'camera', ok: await flyTo(viewer, view.camera) });
    return steps;
  }
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
 */
export function installViews({
  shell,
  viewer,
  dataManager,
  run,
  signal,
  location = globalThis.location,
  windowRef = globalThis.window,
}) {
  const ready = Promise.resolve(shell.initialRestorePromise).catch(() => {});
  const hashParams = new URLSearchParams(
    String(location?.hash || '').replace(/^#/, ''),
  );
  // What the link itself asks for runs first, one thing at a time; posted
  // views queue behind it. One failing step does not take the next with it.
  // The camera's owner at restore: anyone who navigates while the link's
  // steps wait (a gesture, a search, the assistant) takes it, and a passive
  // link must not fly over them.
  let generationAtRestore = null;
  let queue = ready.then(() => {
    generationAtRestore = shell._navigationGeneration;
  });
  const navigatedSinceRestore = () =>
    Number.isFinite(generationAtRestore) &&
    shell._navigationGeneration !== generationAtRestore;
  const linkStep = (work) =>
    queue.then(async () => {
      if (signal?.aborted) return;
      try {
        await work();
      } catch {
        /* reported by the action itself */
      }
    });
  const linked = annotationsFromParams(hashParams);
  if (linked.length)
    queue = linkStep(() => run('annotate_map', { annotations: linked }));
  // A link to street-level photos opens them once the link has restored. A
  // link anyone can publish stops short of a billed load and leaves it to a
  // click; only the panel page's own link (inline embed) is the client's
  // request. A link that follows an entity keeps the camera on it.
  const streetLevel = followFromParams(hashParams)
    ? null
    : streetLevelFromParams(hashParams);
  if (streetLevel)
    queue = linkStep(async () => {
      if (navigatedSinceRestore()) return;
      const result = await run(
        'show_street_level',
        streetLevelArgs(streetLevel, { autoOpen: isEmbeddedInline() }),
      );
      // The restore window keeps the panel collapsed; OPEN must be in view.
      // Embed mode hides the rail that holds it, so there the link only arms
      // (a posted view is the way to open a photo in a frame).
      if (result?.armed === true && !isEmbedded(location)) {
        shell.setPanelCollapsed?.(STREET_LEVEL_PANEL_ID, false, {
          explicit: true,
        });
        shell._showToast?.(ARMED_TOAST);
      }
    });
  if (!isEmbedded(location)) return () => {};

  windowRef.document.body.classList.add('ui-embed');
  shell.setCleanView?.(true);
  const stopRendering = isEmbeddedInline()
    ? keepPanelRendering(viewer, { windowRef })
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
