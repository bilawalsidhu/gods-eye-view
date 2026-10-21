/**
 * Resolution governor: draw the globe in device pixels on high-DPI screens,
 * and give pixels back only while the GPU cannot keep up.
 *
 * Cesium's default `useBrowserRecommendedResolution: true` draws at one
 * drawing-buffer pixel per CSS pixel, so a 2x screen pixel-doubles a half-size
 * frame and lines look stair-stepped. The viewer now draws at `ratio` device
 * pixels per CSS pixel, where
 *
 *   1 <= ratio <= ceiling = max(1, min(devicePixelRatio, maxPixelRatio,
 *                                      sqrt(maxDrawingPixels / CSS pixels)))
 *
 * The floor is the old behaviour, so no screen ever draws fewer pixels than
 * before. The pixel budget bounds framebuffer memory on large displays. Tile
 * detail does not change with the ratio: Cesium divides screen-space error by
 * `frameState.pixelRatio`.
 *
 * The policy watches the smoothed frame interval while frames are
 * back-to-back (continuous render, or the camera is moving). Discrete
 * request-mode frames and pauses longer than `gapMs` say nothing about GPU
 * cost and are skipped, so an idle globe never changes resolution. Its
 * windows count sampled frame time, not wall time: on-time frames from
 * several short pans add up to a step back up. The first `warmupMs` after
 * the viewer starts are skipped, because loading, not drawing, sets the
 * frame time then.
 *
 * - Over `budgetMs` and not back under `onTimeMs` for `slowMs`: step down by
 *   `step`, never below the floor. The gap between the two thresholds stops a
 *   frame time that hovers at the budget from resetting the slow window.
 * - At or under `onTimeMs` for the recovery wait (`recoverMs`, first 8 s):
 *   step up.
 * - A step up that is followed by a step down failed: the wait doubles, up
 *   to `maxRecoverMs`. A full on-time wait resets it.
 * - A devicePixelRatio change (window moved to another screen, browser zoom)
 *   restarts at the new ceiling. A resize keeps the current ratio inside the
 *   new ceiling, and follows the ceiling when it was not stepped down.
 *
 * The governor has no timers. Its listeners live on the viewer's scene and
 * camera and end with the viewer.
 */

/** Tuning shared by the policy, the viewer and the tests. */
export const RESOLUTION_POLICY = Object.freeze({
  maxPixelRatio: 2,
  // A 4K frame: every laptop screen gets its full 2x; larger displays less.
  maxDrawingPixels: 3840 * 2160,
  step: 0.25,
  budgetMs: 20,
  onTimeMs: 18,
  smoothing: 0.1,
  slowMs: 2000,
  recoverMs: 8000,
  maxRecoverMs: 64000,
  gapMs: 250,
  warmupMs: 5000,
});

/** Upper bound accepted from the `maxPixelRatio` URL parameter. */
const MAX_PIXEL_RATIO_LIMIT = 3;

/**
 * Read the `maxPixelRatio` URL parameter (`?maxPixelRatio=1` restores the
 * old one-pixel-per-CSS-pixel drawing). Invalid values use the default.
 * @param {string} [search] `location.search`.
 * @param {number} [fallback]
 * @returns {number}
 */
export function readMaxPixelRatio(
  search = globalThis.location?.search || '',
  fallback = RESOLUTION_POLICY.maxPixelRatio,
) {
  const raw = new URLSearchParams(String(search)).get('maxPixelRatio');
  const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_PIXEL_RATIO_LIMIT, Math.max(1, value));
}

/**
 * Highest ratio the screen, the cap and the pixel budget allow. Never below
 * 1, the ratio the viewer drew at before this governor.
 * @param {number} devicePixelRatio
 * @param {number} maxPixelRatio
 * @param {number} [cssPixels] Canvas CSS width × height; 0 skips the budget.
 * @param {number} [maxDrawingPixels]
 * @returns {number}
 */
export function pixelRatioCeiling(
  devicePixelRatio,
  maxPixelRatio,
  cssPixels = 0,
  maxDrawingPixels = RESOLUTION_POLICY.maxDrawingPixels,
) {
  const dpr = Number(devicePixelRatio) > 0 ? Number(devicePixelRatio) : 1;
  // Whole steps keep the budgeted ratio on the governor's 0.25 grid.
  const budget =
    cssPixels > 0
      ? Math.floor(Math.sqrt(maxDrawingPixels / cssPixels) * 4) / 4
      : Infinity;
  return Math.max(1, Math.min(dpr, maxPixelRatio, budget));
}

/**
 * MSAA samples for a drawing ratio. From 1.5 up, two samples already give at
 * least the 4 coverage samples per CSS pixel that 4x MSAA gave at ratio 1
 * (ratio² × samples), at about half the multisample memory and fill cost.
 * @param {number} ratio
 * @returns {number}
 */
export function msaaSamplesForRatio(ratio) {
  return ratio >= 1.5 ? 2 : 4;
}

/**
 * Pure step policy. Feed it back-to-back frame intervals; read `ratio`.
 * @param {{devicePixelRatio?: number, cssPixels?: number,
 *   maxPixelRatio?: number}} [options]
 *   Plus any `RESOLUTION_POLICY` field, for tests.
 */
export function createResolutionPolicy(options = {}) {
  const config = { ...RESOLUTION_POLICY, ...options };
  let devicePixelRatio = Number(options.devicePixelRatio) || 1;
  let cssPixels = Number(options.cssPixels) || 0;
  const ceilingFor = () =>
    pixelRatioCeiling(
      devicePixelRatio,
      config.maxPixelRatio,
      cssPixels,
      config.maxDrawingPixels,
    );
  let ceiling = ceilingFor();
  let ratio = ceiling;
  // Sampled frame time: advances only by accepted intervals.
  let clock = 0;
  let smoothed = null;
  let slowSince = null;
  let onTimeSince = null;
  let recoverMs = config.recoverMs;
  let probing = false;
  let stepsDown = 0;
  let stepsUp = 0;

  const restartWindows = () => {
    smoothed = null;
    slowSince = null;
    onTimeSince = null;
  };

  return {
    get ratio() {
      return ratio;
    },
    get ceiling() {
      return ceiling;
    },
    /**
     * Record one frame interval.
     * @param {number} intervalMs Time since the previous back-to-back frame.
     * @returns {boolean} True when `ratio` changed.
     */
    frame(intervalMs) {
      if (!(intervalMs > 0) || intervalMs > config.gapMs) {
        smoothed = null;
        return false;
      }
      clock += intervalMs;
      const now = clock;
      smoothed =
        smoothed === null
          ? intervalMs
          : smoothed + config.smoothing * (intervalMs - smoothed);
      if (smoothed > config.onTimeMs) onTimeSince = null;
      if (smoothed > config.budgetMs) {
        slowSince ??= now;
        if (now - slowSince < config.slowMs || ratio <= 1) return false;
        if (probing) recoverMs = Math.min(recoverMs * 2, config.maxRecoverMs);
        probing = false;
        ratio = Math.max(1, ratio - config.step);
        stepsDown++;
        restartWindows();
        return true;
      }
      if (smoothed > config.onTimeMs) return false;
      slowSince = null;
      onTimeSince ??= now;
      if (now - onTimeSince < recoverMs) return false;
      if (probing) {
        probing = false;
        recoverMs = config.recoverMs;
      }
      onTimeSince = now;
      if (ratio >= ceiling) return false;
      ratio = Math.min(ceiling, ratio + config.step);
      probing = true;
      stepsUp++;
      restartWindows();
      return true;
    },
    /** The next frame starts a new run; the windows keep their progress. */
    pause() {
      smoothed = null;
    },
    /**
     * Follow a screen or canvas change.
     * @param {{devicePixelRatio?: number, cssPixels?: number}} next
     * @returns {boolean} True when `ratio` changed.
     */
    setViewport(next) {
      const dpr =
        Number(next.devicePixelRatio) > 0
          ? Number(next.devicePixelRatio)
          : devicePixelRatio;
      const pixels = next.cssPixels ?? cssPixels;
      if (dpr === devicePixelRatio && pixels === cssPixels) return false;
      const previous = ratio;
      const wasAtCeiling = ratio >= ceiling;
      const screenChanged = dpr !== devicePixelRatio;
      devicePixelRatio = dpr;
      cssPixels = pixels;
      ceiling = ceilingFor();
      if (screenChanged) {
        ratio = ceiling;
        recoverMs = config.recoverMs;
        probing = false;
        restartWindows();
      } else {
        ratio = wasAtCeiling ? ceiling : Math.min(ratio, ceiling);
      }
      return ratio !== previous;
    },
    diagnostics() {
      return {
        ratio,
        ceiling,
        devicePixelRatio,
        cssPixels,
        maxPixelRatio: config.maxPixelRatio,
        smoothedMs: smoothed,
        recoverMs,
        stepsDown,
        stepsUp,
      };
    },
  };
}

const installed = new WeakMap();

/**
 * Drive `viewer.resolutionScale` and `scene.msaaSamples` from the policy.
 * The viewer must be created with `useBrowserRecommendedResolution: false`.
 * @param {object} viewer Cesium viewer.
 * @param {{maxPixelRatio?: number, windowRef?: {devicePixelRatio?: number},
 *   now?: () => number}} [options]
 * @returns {() => void} Disposer.
 */
export function installResolutionGovernor(
  viewer,
  {
    maxPixelRatio = RESOLUTION_POLICY.maxPixelRatio,
    windowRef = globalThis.window,
    now = () => performance.now(),
  } = {},
) {
  const scene = viewer?.scene;
  const camera = scene?.camera;
  if (!scene?.postRender || !camera?.moveStart)
    throw new TypeError('installResolutionGovernor requires a Cesium viewer');
  const readDpr = () => Number(windowRef?.devicePixelRatio) || 1;
  const readCssPixels = () =>
    (Number(viewer.canvas?.clientWidth) || 0) *
    (Number(viewer.canvas?.clientHeight) || 0);
  let dpr = readDpr();
  let cssPixels = readCssPixels();
  const policy = createResolutionPolicy({
    devicePixelRatio: dpr,
    cssPixels,
    maxPixelRatio,
  });

  // Cesium asks for nearest-neighbour upscaling. That is exact at a
  // whole-number factor; at a fractional one (a step of 1.5 on a 2x screen)
  // it doubles every third row, so the browser filters instead.
  const canvasStyle = viewer.canvas?.style;
  const crispRendering = canvasStyle?.imageRendering || '';
  const apply = () => {
    const scale = policy.ratio / dpr;
    if (viewer.resolutionScale !== scale) viewer.resolutionScale = scale;
    if (canvasStyle)
      canvasStyle.imageRendering = Number.isInteger(dpr / policy.ratio)
        ? crispRendering
        : 'auto';
    const samples = msaaSamplesForRatio(policy.ratio);
    if (scene.msaaSamples !== samples) scene.msaaSamples = samples;
  };
  apply();

  const startedAt = now();
  let cameraMoving = false;
  let lastFrameAt = null;
  const removers = [
    camera.moveStart.addEventListener(() => {
      cameraMoving = true;
    }),
    camera.moveEnd.addEventListener(() => {
      cameraMoving = false;
      lastFrameAt = null;
    }),
    scene.postRender.addEventListener(() => {
      const at = now();
      const nextDpr = readDpr();
      const nextCssPixels = readCssPixels();
      if (nextDpr !== dpr || nextCssPixels !== cssPixels) {
        dpr = nextDpr;
        cssPixels = nextCssPixels;
        policy.setViewport({ devicePixelRatio: dpr, cssPixels });
        lastFrameAt = null;
        apply();
        return;
      }
      // Request-mode frames arrive on demand; their spacing is not cost.
      if (scene.requestRenderMode && !cameraMoving) {
        lastFrameAt = null;
        policy.pause();
        return;
      }
      const previous = lastFrameAt;
      lastFrameAt = at;
      if (previous === null || at - startedAt < RESOLUTION_POLICY.warmupMs)
        return;
      if (policy.frame(at - previous)) {
        lastFrameAt = null;
        apply();
      }
    }),
  ];

  const dispose = () => {
    if (installed.get(viewer) !== entry) return;
    installed.delete(viewer);
    for (const remove of removers) remove();
  };
  const entry = { policy, dispose };
  installed.get(viewer)?.dispose();
  installed.set(viewer, entry);
  return dispose;
}

/**
 * Current ratio and policy state for a viewer, or null without a governor.
 * @param {object} viewer
 */
export function getResolutionDiagnostics(viewer) {
  const entry = installed.get(viewer);
  if (!entry) return null;
  return {
    ...entry.policy.diagnostics(),
    resolutionScale: viewer.resolutionScale,
    msaaSamples: viewer.scene.msaaSamples,
  };
}
