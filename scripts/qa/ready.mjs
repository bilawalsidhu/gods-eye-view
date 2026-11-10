import { createSettledState } from '../../src/app/qaProbe.js';

/** A CPU-ready pick can precede the GPU hit delivered for a real click. */
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
    await page.waitForFunction(() => window.__godsEyeView?.engine, {
      timeout: timeoutMs,
      polling: 50,
    });
  } catch {
    throw new Error(
      'Readiness timeout: engineStarted, initialViewRestored, frameDrawn, noFlight, cameraInputsEnabled, cameraPoseStable',
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
      const status = state.settled({ frames });
      if (window.__godsEyeView?.engine !== engine)
        status.unmet.push('engineUnchanged');
      finish(
        new Error(
          `Readiness timeout: ${status.unmet.join(', ')}${status.restoreError ? ': ' + status.restoreError : ''}`,
        ),
      );
    }, timeoutMs);
    remove = engine.frames.postRender.addEventListener(() => {
      const status = state.settled({ frames });
      if (window.__godsEyeView?.engine !== engine)
        return finish(new Error('Readiness interrupted: engineChanged'));
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
/** Wait for drawn frames when the scenario deliberately keeps a follow or orbit moving. */
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
    () => window.__godsEyeView?.engine?.surface.tilesLoaded(),
    { timeout: timeoutMs, polling: 100 },
  );
  await handle.dispose();
}
/** Wait for finite panel transitions without waiting on decorative looping animations. */
export async function whenUiSettled(page) {
  const handle = await page.waitForFunction(
    () => {
      const app = window.__godsEyeView;
      app?.engine?.render.request('qa-ui-readiness');
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
