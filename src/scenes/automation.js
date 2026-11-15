/**
 * Development-only automation handle for the SceneDirector.
 *
 * Lets a headless driver (e.g. a Playwright recording script) load a Director
 * scene document, play it, and learn when playback ends without clicking the
 * Scenes panel:
 *
 *   await page.evaluate((doc) => window.__gevDirector.importScene(doc), json);
 *   const result = await page.evaluate(() => window.__gevDirector.play());
 *   // result: { started, shots, cancelled, startedAt, endedAt, ... }
 *
 * `play()` resolves when the run finishes (or is stopped). Drivers that would
 * rather not hold an evaluate() open can listen for the window event
 * `gev:director-playback-finished` (detail = the same result), or call
 * `whenFinished()` later.
 *
 * Installed only when `import.meta.env.DEV` is true; see src/app/tools.js.
 */

export const DIRECTOR_AUTOMATION_GLOBAL = '__gevDirector';
export const DIRECTOR_FINISHED_EVENT = 'gev:director-playback-finished';

/**
 * Build the automation API around a director.
 * @param {import('./director.js').SceneDirector} director
 * @param {{ target?: EventTarget }} [options] - Where the finished event is
 *   dispatched (defaults to `window`).
 */
export function createDirectorAutomation(director, { target } = {}) {
  const eventTarget = target ?? globalThis.window;
  let currentRun = null;
  let lastResult = null;

  const finish = (result) => {
    const run = director._lastRun;
    const summary = {
      ...result,
      cancelled: result.started ? run?.wasCancelled === true : false,
      startedAt: result.started ? (run?.startedAt ?? null) : null,
      endedAt: result.started ? (run?.endedAt ?? null) : null,
      estimatedDurationSec: result.started
        ? (run?.estimatedDurationSec ?? null)
        : null,
    };
    lastResult = summary;
    if (eventTarget?.dispatchEvent && typeof CustomEvent === 'function') {
      eventTarget.dispatchEvent(
        new CustomEvent(DIRECTOR_FINISHED_EVENT, { detail: summary }),
      );
    }
    return summary;
  };

  return {
    /** The underlying director, for anything this handle does not cover. */
    director,

    /**
     * Replace the current project with a scene document, through the same
     * path as the panel's Import button.
     * @param {object|string} document - Parsed scene JSON (or its text)
     * @param {{ name?: string }} [options] - File name reported in the status
     * @returns {Promise<Array>} The imported project's scene list
     */
    async importScene(document, { name = 'automation-scene.json' } = {}) {
      const text =
        typeof document === 'string' ? document : JSON.stringify(document);
      const file = new File([text], name, { type: 'application/json' });
      const imported = await director.importProjectFile(file);
      if (imported !== true) {
        const status = director._presentation?.status;
        throw new Error(status || 'Scene import failed');
      }
      return director.listScenes();
    },

    /**
     * Start playback and resolve when it ends.
     * @param {string} [sceneId] - Scene to start from (default: first/selected)
     * @param {object} [options] - Passed to SceneDirector.startScene
     * @returns {Promise<object>} Result with `started`, `cancelled`, timings
     */
    play(sceneId, options) {
      if (currentRun) return currentRun;
      currentRun = director
        .startScene(sceneId, options)
        .then(finish, (error) => {
          finish({ started: false, reason: error?.message || 'run-failed' });
          throw error;
        })
        .finally(() => {
          currentRun = null;
        });
      return currentRun;
    },

    /** Stop playback; resolves with the run's result once it has wound down. */
    stop(reason) {
      const run = currentRun;
      director.stopScene(reason);
      return run ?? Promise.resolve(lastResult);
    },

    /** Resolve when the current run ends, or immediately with the last result. */
    whenFinished() {
      return currentRun ?? Promise.resolve(lastResult);
    },

    get running() {
      return director.running;
    },

    status() {
      return director.getPlaybackStatus();
    },

    listScenes() {
      return director.listScenes();
    },
  };
}

/**
 * Expose the automation API on `window.__gevDirector`.
 * @returns {() => void} Removes the global if it is still ours.
 */
export function installDirectorAutomation(director) {
  if (typeof window === 'undefined') return () => {};
  const api = createDirectorAutomation(director, { target: window });
  window[DIRECTOR_AUTOMATION_GLOBAL] = api;
  return () => {
    if (window[DIRECTOR_AUTOMATION_GLOBAL] === api)
      delete window[DIRECTOR_AUTOMATION_GLOBAL];
  };
}
