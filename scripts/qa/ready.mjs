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
