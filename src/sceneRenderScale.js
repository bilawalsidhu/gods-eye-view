/**
 * Render-resolution scale policy (Phase 9 Batch R — docs/PLAN.md).
 *
 * Cesium renders the scene into a backing store of `CSS size × devicePixelRatio`.
 * On a 2560×1440 viewport at DPR 2 the backing store is 5120×2880 — ~59 MiB of
 * color + ~47 MiB of depth = ~106 MiB of dedicated GPU memory, plus ~4× the
 * per-pixel fragment cost vs native resolution. The visible benefit at full
 * DPR is marginal: photoreal tile imagery hides the difference and overlay
 * canvases cap their own DPR at 1.5 (worldOverlay.js).
 *
 * Policy:
 *   - DPR ≤ 1.5: render at native (scale 1.0) — cheap, no benefit from
 *     downsampling.
 *   - DPR > 1.5: scale to 1.0 / DPR (a 0.67 scale at DPR 2 keeps the GPU bill
 *     near a native 1.5× display while preserving the same CSS pixel size).
 *     Cesium upscales the result to the canvas; the upscale is essentially
 *     free and the visual loss is below the operator-detection threshold
 *     when combined with MSAA 2×.
 *
 * Escape hatch: `?renderScale=N` (0.5..2) forces an explicit scale.
 *
 * @param {object} [options]
 * @param {string} [options.search] Query string to read overrides from
 *   (defaults to the live location, injectable for tests).
 * @param {number} [options.devicePixelRatio] Reported DPR (defaults to the
 *   live value, injectable for tests).
 * @returns {number} Scale to apply to `viewer.sceneResolutionScale`.
 */
export const DEFAULT_RENDER_SCALE_HIGH_DPR = 0.75; // DPR > 1.5 → scale 0.75 (~56% GPU bandwidth)
export const DEFAULT_RENDER_SCALE_LOW_DPR = 1.0;
const HIGH_DPR_THRESHOLD = 1.5;
const MIN_RENDER_SCALE = 0.5;
const MAX_RENDER_SCALE = 2.0;

/**
 * Clamp an override (or null) into the documented render-scale range.
 * @param {*} value - Raw `?renderScale=` value or any number.
 * @returns {number|null} Clamped value, or null when the input is non-finite.
 */
function clampRenderScale(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(MIN_RENDER_SCALE, Math.min(MAX_RENDER_SCALE, value));
}

/**
 * Resolve the render-resolution scale for `viewer.sceneResolutionScale`.
 * Honors `?renderScale=N`; otherwise picks the default for the live DPR.
 * @param {object} [options] - Injection seam.
 * @param {string} [options.search] Query string (defaults to live location).
 * @param {number} [options.devicePixelRatio] Reported DPR (defaults to live).
 * @returns {{scale: number, source: 'override'|'high-dpr'|'low-dpr'}}
 *   The scale plus the policy branch that produced it (for diagnostics).
 */
export function resolveSceneRenderScale({
  search = globalThis.location?.search ?? '',
  devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
} = {}) {
  const params = new URLSearchParams(search);
  const rawOverride = params.get('renderScale');
  const override = rawOverride === null ? null : clampRenderScale(Number(rawOverride));
  if (override !== null) {
    return { scale: override, source: 'override' };
  }
  if (devicePixelRatio > HIGH_DPR_THRESHOLD) {
    return { scale: DEFAULT_RENDER_SCALE_HIGH_DPR, source: 'high-dpr' };
  }
  return { scale: DEFAULT_RENDER_SCALE_LOW_DPR, source: 'low-dpr' };
}

/**
 * Apply the render-resolution scale to a live Cesium viewer.
 * Idempotent; safe to call multiple times.
 * @param {object|null} viewer - Cesium viewer (duck-typed: needs `scene`).
 * @param {object} [resolved] - Pre-resolved policy (defaults to live).
 * @returns {object|null} The applied policy, or null when no viewer.
 */
export function applySceneRenderScale(viewer, resolved = resolveSceneRenderScale()) {
  if (!viewer || !viewer.scene) return null;
  viewer.scene.sceneResolutionScale = resolved.scale;
  return resolved;
}
