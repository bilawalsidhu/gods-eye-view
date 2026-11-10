// The page's engine switch: one layer session, one engine at a time.
//
// The address (?engine=) is the source of truth, except while a picked
// engine starts: the scene host holds that choice until it runs, and only then
// is written to the address as a new history entry. A switch from the picker
// (select) and a history visit (Back/Forward, a pasted address) both hand the
// session off: the running engine is released, the requested engine starts on
// the retained session. They differ in what the incoming engine shows: a pick
// keeps the running view and layers, a visit restores the entry's view and
// the layers its entry changed (as a same-engine Back does) on the retained
// layer models.
// Requests that arrive while a switch or a recovery runs are never dropped:
// once the current attempt settles, the address is read again and reconciled.

import { createSceneHost } from '../app/sceneHost.js';

/** A started engine whose first frame takes longer than this is shown anyway. */
const FIRST_FRAME_WAIT_MS = 10_000;

/** Drive engine requests through the scene host's transition owner. */
export function createEngineSwitch({
  sceneHost = createSceneHost(),
  ...options
}) {
  return sceneHost.createSwitcher(options);
}

/**
 * The engine choice in the page address. A pick leaves the address alone
 * while its engine starts; a successful one adds the history entry (the
 * earlier entry keeps the outgoing engine and view), so Back returns to the
 * previous engine, and a failed or superseded pick changes no entry.
 */
export function createEngineAddress({ location, history, flush = () => {} }) {
  const withEngine = (engine) => {
    const url = new URL(location.href);
    url.searchParams.set('engine', engine);
    return url.href;
  };
  return Object.freeze({
    /** Snapshot the outgoing entry: its engine and its latest view. */
    select(from) {
      flush();
      return from ? withEngine(from) : null;
    },
    commit(previous, engine) {
      const next = withEngine(engine);
      // Without a running engine to return to, the pick names this entry.
      if (!previous) return history.replaceState(history.state, '', next);
      history.replaceState(history.state, '', previous);
      history.pushState(null, '', next);
    },
    restore(engine) {
      history.replaceState(history.state, '', withEngine(engine));
    },
  });
}

/**
 * Hand the session off before the running engine is released: record the
 * layer models so the next engine retains them, and park the cameras and the
 * Director scene instead of ending them. Every engine change in this page
 * hands off, whatever started it. The incoming engine reads the view
 * (camera, style, map) from the address it starts with. Each layer records
 * whether it runs and whether the outgoing address listed it
 * (`addressLayerIds`): the layer-state coordinator keeps it running as it
 * was where the incoming address agrees (always after a pick) and follows a
 * visited entry where it differs (handoffTargetEnabled).
 * @param {import('../app/layerSession.js').LayerSession} session
 * @param {object} [options]
 * @param {Iterable<string> | null} [options.addressLayerIds] Layers listed by the outgoing address.
 * @param {boolean} [options.visit=false] Restore a history entry's layer options; a picker change keeps the live options.
 */
export function handOffSession(
  session,
  { addressLayerIds = null, visit = false } = {},
) {
  const manager = session.manager;
  const listed = addressLayerIds ? new Set(addressLayerIds) : null;
  session.handoffLayers = new Map(
    [...manager.layers].map(([id, entry]) => [
      id,
      {
        entry: entry.module.attachRenderer ? entry : null,
        enabled: manager.isEffectivelyEnabled(id),
        durable: listed ? listed.has(id) : undefined,
        visit,
      },
    ]),
  );
  manager.layers.get('directions')?.module.suspendCamera?.();
  manager.layers.get('satellites')?.module.suspendCamera?.();
  session.director?.suspendScene();
}

/** Resume what handOffSession parked, once the incoming view is restored. */
export function resumeSession(session) {
  for (const { module } of session.manager.layers.values())
    module.resumeViewport?.();
  if (session.handoffLayers)
    session.manager.layers.get('directions')?.module.resumeCamera?.();
  session.director?.resumeScene();
}

/**
 * Wait for a started engine's first frame before the cover over it goes.
 *
 * A switch succeeds when the engine has started with the session attached;
 * this wait never fails it. It resolves true on the first drawn frame and
 * false when the tab is hidden (a hidden tab draws nothing and shows nothing,
 * so there is nothing to wait for) or after `timeoutMs` of visible time
 * without a frame, so a slow GPU leaves the new globe uncovered rather than
 * rolling a healthy engine back.
 */
export function waitForFirstFrame(
  engine,
  {
    document = globalThis.document,
    timeoutMs = FIRST_FRAME_WAIT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  const outcome = (path) => {
    if (engine.host?.canvas?.dataset)
      engine.host.canvas.dataset.firstFrameOutcome = path;
  };
  if (document?.hidden) {
    outcome('hidden');
    return Promise.resolve(false);
  }
  outcome('pending');
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    let remove = () => {};
    const finish = (path) => {
      if (finished) return;
      finished = true;
      outcome(path);
      remove();
      clearTimer(timer);
      document?.removeEventListener?.('visibilitychange', hidden);
      resolve(path === 'frame');
    };
    function hidden() {
      if (document.hidden) finish('hidden');
    }
    remove = engine.frames.postRender.addEventListener(() => finish('frame'));
    timer = setTimer(() => finish('timeout'), timeoutMs);
    document?.addEventListener?.('visibilitychange', hidden);
    engine.render.request('engine-switch');
  });
}
