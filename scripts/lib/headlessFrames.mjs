/**
 * Deterministic waiting for headless Chrome QA harnesses.
 *
 * Headless Chrome services `requestAnimationFrame` ONLY while the compositor
 * produces BeginFrames. A settled scene (render governor in on-demand mode,
 * no CSS/JS animations) stops producing them, so a rAF-scheduled pass — a
 * panel layout, a class-driven reveal, an accordion release — sits PENDING
 * through any wall-clock sleep. A suite that sleeps N ms and then measures
 * is therefore asserting on a frozen frame, and it fails deterministically
 * on a quiet box (under load, other tenants' frames keep flowing, which
 * masks the bug). Proven 2026-09-20: a layout frame id was frozen across a
 * 360 ms wait and released by one forced frame; a class-driven reveal
 * measured 0×0 same-tick and 70.7×28 after one frame.
 *
 * The two rules this module encodes:
 *
 * 1. NEVER sleep-then-measure. Poll the REAL contract — a laid-out rect,
 *    an app-level flag the rAF consumes — and let the poll drive frames.
 *    Never wait on "rAF handle === null" either: ambient activity keeps
 *    re-scheduling frames, so the handle may never be null even though the
 *    work landed (the app-level flags the rAF consumes are the drain
 *    contract — e.g. StyleManager's `_leftStackReconsiderAutoCollapse`).
 * 2. Pump BeginFrames from Node. A screenshot forces the compositor to
 *    produce a frame; exposed as a page binding, an in-page `await` can
 *    drive it mid-evaluate (see `installCompositorFramePump`).
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Install the BeginFrame pump as a page binding, so BOTH Node-side helpers
 * and in-evaluate `await window.__qaForceCompositorFrame()` calls can force
 * the compositor to produce a frame. Call once per page, before `goto` —
 * `page.exposeFunction` survives navigation only when installed first.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<void>}
 */
export async function installCompositorFramePump(page) {
  await page.exposeFunction('__qaForceCompositorFrame', () => {
    return page.screenshot({ optimizeForSpeed: true }).catch(() => null);
  });
}

/**
 * Poll an element until it has a non-degenerate laid-out rect, pumping a
 * compositor frame between attempts. Returns null (do NOT throw — the
 * caller owns the failure message and its check detail) if the element is
 * missing or still 0×0 after `attempts` tries.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} elementId
 * @param {{ attempts?: number, intervalMs?: number }} [options]
 * @returns {Promise<{ width: number, height: number } | null>}
 */
export async function waitForLaidOutRect(page, elementId, { attempts = 12, intervalMs = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rect = await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }, elementId);
    if (rect && rect.width > 0 && rect.height > 0) return rect;
    await page.evaluate(() => window.__qaForceCompositorFrame?.());
    await sleep(intervalMs);
  }
  return null;
}

/**
 * Poll an in-page counter until two consecutive samples agree (every
 * scheduled async producer has drained), with a bounded number of samples.
 * Use this to wait out debounce + idle-callback chains whose total duration
 * depends on load: an instant snapshot races a just-scheduled warm, and a
 * fixed sleep is either wasteful or too short. Returns the stable value.
 *
 * @param {() => Promise<number> | number} sample polled counter/value
 * @param {{ intervalMs?: number, samples?: number }} [options]
 * @returns {Promise<number>} the agreed value (last sample if never stable)
 */
export async function waitForStable(sample, { intervalMs = 600, samples = 12 } = {}) {
  let last = null;
  for (let i = 0; i < samples; i += 1) {
    const value = await sample();
    if (last !== null && value === last) return value;
    last = value;
    await sleep(intervalMs);
  }
  return Number(last);
}
