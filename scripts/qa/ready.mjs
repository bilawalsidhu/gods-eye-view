import { createSettledState } from '../../src/app/qaProbe.js';

/** Verify real click selection, including targets the CPU picker cannot answer. */
export async function clickUntilSelected(page, click, selected) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await click();
    let handle;
    try {
      handle = await page.waitForFunction(selected, { timeout: 2000 });
      return;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      if (attempt === 4)
        throw new Error('Readiness timeout: selection after 5 clicks', {
          cause: error,
        });
    } finally {
      await handle?.dispose();
    }
  }
}

/** Viewport CSS coordinates (or a page-side locator); predicate runs beside the picker. */
export async function whenPickable(
  page,
  windowPosition,
  predicate,
  { timeoutMs = 30000 } = {},
) {
  const position =
    typeof windowPosition === 'function'
      ? `(${windowPosition})()`
      : JSON.stringify(windowPosition);
  let handle;
  try {
    handle = await page.waitForFunction(
      `(() => {
        const engine = window.__godsEyeView?.engine;
        if (!engine || engine.isDestroyed()) return false;
        engine.render.request('qa-pick-readiness');
        const position = ${position};
        if (!position) return false;
        const box = engine.host.canvas.getBoundingClientRect();
        const picked = engine.picker.pick({
          x: position.x - box.left,
          y: position.y - box.top,
        });
        return (${predicate})(picked, position) ? position : false;
      })()`,
      { polling: 50, timeout: timeoutMs },
    );
    return await handle.jsonValue();
  } catch (error) {
    if (error.name === 'TimeoutError')
      throw new Error('Readiness timeout: pickable target', { cause: error });
    throw error;
  } finally {
    await handle?.dispose();
  }
}

/** Wait for the restored camera over drawn frames, including request-mode globes. */
export async function whenSettled(
  page,
  { frames = 3, timeoutMs = 120000 } = {},
) {
  const started = Date.now();
  try {
    const handle = await page.waitForFunction(
      () => {
        if (!window.__godsEyeView?.engine) return false;
        const cover = globalThis.document?.querySelector('#loading-screen');
        return !cover || getComputedStyle(cover).visibility === 'hidden';
      },
      { timeout: timeoutMs, polling: 50 },
    );
    await handle?.dispose();
  } catch {
    throw new Error(
      'Readiness timeout: engineStarted, initialViewRestored, startupUiReady, frameDrawn, noFlight, cameraInputsEnabled, cameraPoseStable; observed: inputsEnabled=unknown, following=unknown, cockpitActive=unknown, lastPoseDelta=null',
    );
  }
  return page.evaluate(
    `(${waitForSettled})(${createSettledState}, ${JSON.stringify({ frames, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)) })})`,
  );
}

/** Self-contained so production pages need no QA module. */
export function waitForSettled(createState, { frames, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const { engine } = window.__godsEyeView;
    const state = createState(engine);
    let previousPose = null;
    let lastPoseDelta = null;
    const statusOf = () => {
      const status = state.settled({ frames });
      const started = status.conditions.engineStarted;
      const following = started && Boolean(engine.camera.following());
      const cockpitActive = Boolean(
        window.__godsEyeView?.styleManager?.getCockpitState?.()?.active,
      );
      // A running Space Missions replay flies the camera until it ends.
      const drawn = window.__godsEyeView?.dataManager?.layers
        ?.get('rocket-launches')
        ?.module?.qaDrawn?.();
      const replaying = Boolean(drawn?.replay?.active && !drawn.paused);
      status.observed = {
        inputsEnabled: status.conditions.cameraInputsEnabled,
        following,
        cockpitActive,
        replaying,
        lastPoseDelta,
      };
      // Only a live camera owner excuses motion or held inputs, never a scenario flag.
      if (following || cockpitActive || replaying) {
        status.conditions.cameraInputsEnabled = true;
        status.conditions.cameraPoseStable = true;
      }
      status.conditions.frameDrawn = status.framesDrawn >= frames;
      status.unmet = Object.keys(status.conditions).filter(
        (key) => !status.conditions[key],
      );
      status.settled = !status.unmet.length;
      return status;
    };
    let finished = false;
    let remove = () => {};
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      remove();
      state.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      const status = statusOf();
      if (window.__godsEyeView?.engine !== engine)
        status.unmet.push('engineUnchanged');
      finish(
        new Error(
          `Readiness timeout: ${status.unmet.join(', ')}${status.restoreError ? ': ' + status.restoreError : ''}; observed: ${JSON.stringify(status.observed)}`,
        ),
      );
    }, timeoutMs);
    remove = engine.frames.postRender.addEventListener(() => {
      if (window.__godsEyeView?.engine !== engine)
        return finish(new Error('Readiness interrupted: engineChanged'));
      if (!engine.isDestroyed()) {
        const pose = engine.camera.pose();
        const values = ['position', 'direction', 'up'].flatMap((key) =>
          ['x', 'y', 'z'].map((axis) => pose[key][axis]),
        );
        values.push(pose.fovy, pose.aspectRatio);
        if (previousPose) {
          const delta = values.map((value, i) =>
            Math.abs(value - previousPose[i]),
          );
          lastPoseDelta = {
            positionM: Math.hypot(...delta.slice(0, 3)),
            orientation: Math.max(...delta.slice(3, 9)),
            projection: Math.max(...delta.slice(9)),
          };
        }
        previousPose = values;
      }
      const status = statusOf();
      if (status.settled) finish(null, status);
      else
        queueMicrotask(() => {
          if (!finished && !engine.isDestroyed())
            engine.render.request('qa-readiness');
        });
    });
    engine.render.request('qa-readiness');
  });
}
/** Wait for drawing independently of camera rest or input ownership. */
export async function whenFramesDrawn(
  page,
  { frames = 3, timeoutMs = 30000 } = {},
) {
  return page.evaluate(
    ({ frames, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const { engine } = window.__godsEyeView;
        let drawn = 0;
        const timer = setTimeout(() => {
          remove();
          reject(new Error('Readiness timeout: drawn frames'));
        }, timeoutMs);
        const remove = engine.frames.postRender.addEventListener(() => {
          if (++drawn >= frames) {
            clearTimeout(timer);
            remove();
            resolve();
          } else {
            queueMicrotask(() => engine.render.request('qa-drawn-frames'));
          }
        });
        engine.render.request('qa-drawn-frames');
      }),
    { frames, timeoutMs },
  );
}
/** Tile readiness is independent of camera rest, including a keyless globe. */
export async function whenTilesLoaded(page, { timeoutMs = 30000 } = {}) {
  const handle = await page.waitForFunction(
    () => {
      const engine = window.__godsEyeView?.engine;
      if (!engine || engine.isDestroyed()) return false;
      return engine.surface.tilesLoaded();
    },
    { timeout: timeoutMs, polling: 100 },
  );
  await handle.dispose();
}
/** Wait for finite panel transitions without waiting on decorative looping animations. */
export async function whenUiSettled(page) {
  const handle = await page.waitForFunction(
    () => {
      const app = window.__godsEyeView;
      return (
        !app?.styleManager?.transitions?.size &&
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== 'running' ||
              animation.effect.getTiming().iterations === Infinity,
          )
      );
    },
    { polling: 'raf', timeout: 15000 },
  );
  await handle.dispose();
}
/** Predicate polling keeps timeout-as-evidence scenarios explicit. */
export async function pollPage(
  page,
  predicate,
  { timeoutMs, intervalMs = 250, args = [] },
) {
  let handle;
  try {
    handle = await page.waitForFunction(
      predicate,
      { timeout: timeoutMs, polling: intervalMs },
      ...args,
    );
    return true;
  } catch (error) {
    if (error.name === 'TimeoutError') return false;
    throw error;
  } finally {
    await handle?.dispose();
  }
}
/** Poll scenario state outside the page without duplicating timeout loops. */
export async function until(
  predicate,
  { timeoutMs = 30000, intervalMs = 100, label = 'scenario state' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw new Error(`Readiness timeout: ${label}`);
}
