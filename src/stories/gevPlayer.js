import { chapterAt } from './format.js';

/** Longest Stories waits for a scene to tear down before going on anyway. */
export const SETTLE_LIMIT_MS = 15000;

/**
 * Resolves once the director is idle: no run, and every LOAD, seek and
 * interaction settled (SceneDirector.whenIdle). A teardown that never
 * finishes is given SETTLE_LIMIT_MS, so a stuck scene cannot leave Stories
 * unable to close; that case is logged, and the scene's layer cleanup still
 * in flight loses its say over layers (SceneDirector.revokeSceneRelease), so
 * it cannot turn off a layer the caller puts back next.
 * @param {import('../scenes/director.js').SceneDirector} director
 * @returns {Promise<boolean>} True once idle, false when the limit ran out.
 */
export function directorSettled(director) {
  let timer = 0;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn('Stories: the scene did not finish tearing down; going on');
      director.revokeSceneRelease?.();
      resolve(false);
    }, SETTLE_LIMIT_MS);
  });
  // A failure to wait counts as settled: the view still comes back.
  const idle = Promise.resolve()
    .then(() => director.whenIdle())
    .then(
      () => true,
      () => true,
    );
  return Promise.race([idle, limit]).finally(() => clearTimeout(timer));
}

/**
 * Plays a scene GEV already ships through SceneDirector, the way the Scene
 * panel plays it, and reports the scene clock in the shape the Stories
 * timeline reads. SceneDirector has no pause: pausing seeks to the current
 * moment (which stops the run and frames it), and playing again starts the
 * run from that same moment.
 *
 * @param {import('../scenes/director.js').SceneDirector} director
 * @param {object} story A catalog story of kind 'gev'.
 * @param {{onTick?: (state: object) => void}} [hooks]
 */
export function createGevPlayer(director, story, hooks = {}) {
  const sceneId = story.sceneId;
  let wallMs = 0;
  let durationMs = story.durationMs;
  let playing = false;
  let shotIndex = 0;
  let destroyed = false;
  let pendingSeek = null;
  // Each Play, Pause, Seek and Destroy takes a new number; a Play that waited
  // for a teardown or a run to finish acts only if nothing came after it.
  let request = 0;

  const state = () => ({
    wallMs,
    durationMs,
    playing,
    chapterIndex: Math.min(shotIndex, story.chapters.length - 1),
  });
  const tick = () => {
    if (!destroyed) hooks.onTick?.(state());
  };

  function applyClock(snap) {
    if (snap.sceneDurationSec) durationMs = snap.sceneDurationSec * 1000;
    wallMs = (snap.sceneElapsedSec ?? 0) * 1000;
    shotIndex = snap.shotIndex ?? shotIndex;
    playing = !!snap.running && !snap.seeking;
    if (!playing && !snap.seeking && wallMs >= durationMs - 250)
      wallMs = durationMs;
    tick();
  }

  const unsubscribe = director.subscribeSceneClock((snap) => {
    if (destroyed || !snap || snap.sceneId !== sceneId) return;
    if (pendingSeek) {
      if (snap.seeking) pendingSeek.snapshot = snap;
      return;
    }
    applyClock(snap);
  });

  function seekToCurrentTime(options) {
    playing = false;
    const seek = { snapshot: null };
    // seekScene stops the old run synchronously. Keep its last clock
    // snapshots from overwriting this position while the seek settles.
    pendingSeek = seek;
    const settle = (applied) => {
      if (pendingSeek !== seek) return;
      pendingSeek = null;
      if (applied === true && seek.snapshot) applyClock(seek.snapshot);
    };
    Promise.resolve(
      director.seekScene(
        sceneId,
        durationMs ? wallMs / durationMs : 0,
        options,
      ),
    ).then(settle, () => settle(false));
    tick();
  }

  // A run from the previous story may still be releasing the camera.
  async function idle() {
    if (!director.running) return;
    director.stopScene();
    await directorSettled(director);
  }

  return {
    kind: 'gev',
    story,
    get state() {
      return state();
    },
    async play() {
      const mine = ++request;
      await idle();
      if (destroyed || mine !== request || director.running) return;
      pendingSeek = null;
      // Natural completion is rounded up by the clock subscriber; a
      // paused shared time inside the last 250 ms is not completion.
      if (wallMs >= durationMs) {
        wallMs = 0;
        shotIndex = 0;
      }
      playing = true;
      tick();
      // Go on from the exact moment shown: partway into its shot, with the
      // camera, the hold and the clock carrying on from there.
      const result = await director.startScene(sceneId, {
        single: true,
        fromProgress: durationMs ? wallMs / durationMs : 0,
        preview: true,
      });
      // startScene resolves after the run finishes, not when it starts.
      // A newer pause, seek or play already owns the director by then.
      if (destroyed || mine !== request) return;
      if (!result?.started) {
        playing = false;
        tick();
      }
    },
    pause() {
      request += 1;
      seekToCurrentTime();
    },
    seek(ms, options) {
      request += 1;
      wallMs = Math.max(0, Math.min(durationMs, ms));
      shotIndex = chapterAt(story, wallMs);
      seekToCurrentTime(options);
    },
    /** A key moment: go to that point of the scene. */
    focus(event) {
      if (event?.wallMs != null) this.seek(event.wallMs);
    },
    destroy() {
      request += 1;
      destroyed = true;
      pendingSeek = null;
      unsubscribe?.();
      director.stopScene();
    },
  };
}
