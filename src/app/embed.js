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
import {
  announceNavigationAuthority,
  watchCameraOwner,
} from '../navigationPolicy.js';
import { t, translateKnown } from '../i18n/index.js';
import { GOOGLE_LABEL } from '../layers/streetLevel/providers/google/policy.js';
import {
  annotationsFromParams,
  createView,
  followFromParams,
  groundedLookAt,
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
/** How long a posted view waits for the terrain under its camera. */
const TERRAIN_WAIT_MS = 2000;

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
 * Whether the panel page started the app for a tool result issued just now,
 * not one its host handed back on mounting the panel again.
 */
function isFreshPanelResult() {
  return isEmbeddedInline() && globalThis.GEV_EMBED_FRESH === true;
}

/**
 * `doc`'s visibility for work that pauses in a hidden page. A panel's host
 * may report it hidden while it is on screen (see keepPanelRendering), so an
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
 * link (`autoOpen: false`) only arms a source that bills every load; a view
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
/** Dispatched on the window when a link opened after start-up has restored. */
const SHARE_NAVIGATION_RESTORED_EVENT = 'gev:share-navigation-restore-settled';

/** The armed link's toast, naming the OPEN button as the panel shows it. */
function armedToast() {
  return t('Street View is ready: press {open} to load it', {
    open: t('OPEN {labels}', { labels: translateKnown(GOOGLE_LABEL) }),
  });
}

/** Why a link's photo stays shut: its source has no working key here. */
function keyToast(result) {
  return t(
    "{source} cannot open this link's street-level photo without a working key",
    { source: translateKnown(result.providerName || 'Street Level') },
  );
}

/**
 * Make the app show a view: style and map, exactly the view's layers,
 * annotations, the camera, and the followed entity. Each step runs through the
 * app's own actions (`run(name, args)`); a failed step is reported and the
 * rest still run. Resolves to the steps and whether each succeeded.
 */
export async function applyView(
  view,
  {
    viewer,
    dataManager,
    run,
    signal,
    autoOpen = true,
    retryMs = FOLLOW_RETRY_MS,
  },
) {
  const steps = [];
  const act = async (name, args, options) => {
    let result = null;
    try {
      result = await run(name, args, options);
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
    // The photos frame the camera; when the action fails before flying, the
    // view's own camera still applies.
    // A posted view replays someone else's view, as a link does: the source
    // it lights is not saved as the visitor's own choice.
    const result = await act(
      'show_street_level',
      streetLevelArgs(view.street_level, { autoOpen }),
      { origin: 'programmatic' },
    );
    if (result?.ok !== true) {
      // Overtaken (a click on the map, a newer request): hands off.
      if (result?.cancelled || result?.superseded) return steps;
      // An earlier view's photo must not stay over a place this view left.
      // From the imagery stage on the action has settled the panel itself
      // (a photo it could not load keeps its error).
      if (result?.stage !== 'imagery')
        dataManager.layers?.get?.(STREET_LEVEL_LAYER)?.module?.closeViewer?.();
      if (!result?.location)
        steps.push({ step: 'camera', ok: await flyTo(viewer, view.camera) });
    }
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
  terrain = null,
  location = globalThis.location,
  windowRef = globalThis.window,
}) {
  const ready = Promise.resolve(shell.initialRestorePromise).catch(() => {});
  const hashParams = new URLSearchParams(
    String(location?.hash || '').replace(/^#/, ''),
  );
  // The link's own steps run first, one at a time, and posted views queue
  // behind them; one failing step does not take the next with it. A passive
  // link never flies over someone who took the camera: its steps are skipped
  // when a newer link superseded it, when its flight never landed (the
  // recipient dragged or searched), or after any navigation since the
  // generation its restore flight owned.
  const cameraLanded = (outcome) => outcome?.share?.camera === 'applied';
  const restoreGeneration = (outcome) =>
    Number.isInteger(outcome?.navigationToken)
      ? outcome.navigationToken
      : shell._navigationGeneration;
  let generationAtRestore = null;
  let startSuperseded = false;
  let queue = ready.then((outcome) => {
    generationAtRestore = restoreGeneration(outcome);
    startSuperseded =
      outcome?.status === 'superseded' ||
      (Boolean(outcome?.share) && !cameraLanded(outcome));
  });
  const navigatedSince = (generation) =>
    Number.isFinite(generation) && shell._navigationGeneration !== generation;
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
  // A link's street-level photos open once it has restored. A billed source
  // only arms, except for the panel page's own link to a result issued just
  // now. A link that follows an entity keeps the camera on it.
  const linkedStreetLevel = (params) =>
    followFromParams(params) ? null : streetLevelFromParams(params);
  const openLinkedStreetLevel = async (
    streetLevel,
    { generation, autoOpen = false },
  ) => {
    if (navigatedSince(generation)) return;
    // The link replays the sender's view: nothing it switches becomes the
    // recipient's own preference.
    const result = await run(
      'show_street_level',
      streetLevelArgs(streetLevel, { autoOpen }),
      { origin: 'programmatic' },
    );
    // A source without a working key changes nothing: say why, or the link
    // looks broken. In a frame the host reads the result instead.
    if (result?.stage === 'key' && !isEmbedded(location)) {
      shell._showToast?.(keyToast(result));
      return;
    }
    // OPEN must be in view, but embed mode hides the rail that holds it: in
    // a frame a posted view is the way to open a photo.
    if (result?.armed === true && !isEmbedded(location)) {
      // Opened for this link only: the recipient's saved layout stays theirs.
      shell.setPanelCollapsed?.(STREET_LEVEL_PANEL_ID, false, {
        explicit: true,
        persist: false,
      });
      // On a phone the panel sits in a tab sheet: open it so OPEN shows.
      shell.revealPanel?.(STREET_LEVEL_PANEL_ID);
      shell._showToast?.(armedToast());
    }
  };
  const startStreetLevel = linkedStreetLevel(hashParams);
  if (startStreetLevel)
    queue = linkStep(() =>
      startSuperseded
        ? undefined
        : openLinkedStreetLevel(startStreetLevel, {
            generation: generationAtRestore,
            autoOpen: isFreshPanelResult(),
          }),
    );
  // A link pasted into the open tab: its photos follow once its restore
  // settles, under the same rules.
  const onNavigatedRestore = (event) => {
    if (event?.detail?.status !== 'settled' || !cameraLanded(event.detail))
      return;
    const streetLevel = linkedStreetLevel(
      new URLSearchParams(String(location?.hash || '').replace(/^#/, '')),
    );
    if (!streetLevel) return;
    const generation = restoreGeneration(event.detail);
    queue = linkStep(() => openLinkedStreetLevel(streetLevel, { generation }));
  };
  windowRef?.addEventListener?.(
    SHARE_NAVIGATION_RESTORED_EVENT,
    onNavigatedRestore,
  );
  const stopNavigatedRestores = () =>
    windowRef?.removeEventListener?.(
      SHARE_NAVIGATION_RESTORED_EVENT,
      onNavigatedRestore,
    );
  if (!isEmbedded(location)) return stopNavigatedRestores;

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
    // A panel's host can hand back old results on a remount: only one issued
    // just now may open a billed photo. A framing page's view is its own.
    const autoOpen = !isEmbeddedInline() || event.data.fresh === true;
    // Photos asked for without a point open where the camera looks, measured
    // from the ground under it, as show_in_gods_eye_view places them.
    const asked = event.data.view?.street_level;
    const unplaced =
      asked &&
      typeof asked === 'object' &&
      asked.lat == null &&
      asked.lon == null;
    queue = queue
      .then(async () => {
        if (signal?.aborted) return;
        if (unplaced && view.street_level) {
          // A terrain service that does not answer soon leaves the view's
          // own estimate.
          const wait = AbortSignal.timeout(TERRAIN_WAIT_MS);
          const owner = watchCameraOwner(viewer, shell);
          const point = await groundedLookAt(
            view.camera,
            terrain,
            signal ? AbortSignal.any([signal, wait]) : wait,
          )
            .catch(() => null)
            .finally(() => owner.stop());
          if (signal?.aborted) return;
          // Whoever takes the camera while the terrain answers (a drag, a
          // search, the assistant) keeps it: the view stands down.
          if (owner.taken()) {
            post(
              {
                type: EMBED_APPLIED_MESSAGE,
                id,
                ok: false,
                steps: [{ step: 'street_level', ok: false, superseded: true }],
              },
              replyOrigin,
            );
            return;
          }
          if (point)
            view = createView({
              ...event.data.view,
              street_level: { ...asked, ...point },
            });
        }
        const steps = await applyView(view, {
          viewer,
          dataManager,
          run,
          signal,
          autoOpen,
        });
        post(
          {
            type: EMBED_APPLIED_MESSAGE,
            id,
            ok: steps.every((step) => step.ok),
            steps,
          },
          replyOrigin,
        );
      })
      // A view that fails is answered, and the views behind it still apply.
      .catch((error) =>
        post(
          {
            type: EMBED_APPLIED_MESSAGE,
            id,
            ok: false,
            error: error?.message || String(error),
          },
          replyOrigin,
        ),
      );
  };
  windowRef.addEventListener('message', onMessage);
  void ready.then(() => {
    if (!signal?.aborted) post({ type: EMBED_READY_MESSAGE });
  });
  return () => {
    stopRendering();
    stopNavigatedRestores();
    windowRef.removeEventListener('message', onMessage);
  };
}
