/**
 * Frame cadence policy for the StyleManager style-animation loop
 * (Phase 9 Batch P — docs/PLAN.md).
 *
 * The loop advances per-frame post-processing uniforms (CRT scanlines,
 * retro phosphor noise). Those shaders are time-based: the uniform is a
 * wall-clock `Date.now()` delta, so the animation's SPEED is independent of
 * how often it is sampled. Sampling a scanline drift at 30 Hz instead of
 * every vsync is visually indistinguishable, and it halves the loop's CPU
 * share while it holds continuous scene render.
 *
 * It pairs with the render governor's low-demand frame-rate policy
 * (`LOW_DEMAND_FPS` in renderGovernor.js): when the camera is parked and
 * EVERY continuous-render holder is a wall-clock-timed animator — the style
 * loop among them — the governor drops the scene loop to the same 30 fps, so
 * a parked-camera session of live layers costs half the GPU submissions
 * (2026-09-23 idle-GPU audit fix; the policy began life scoped to this loop).
 * One constant (`STYLE_ANIM_LOW_DEMAND_FPS`, a back-compat alias owned by the
 * dependency-free governor) feeds both, so the uniform cadence and the scene
 * cadence can never drift apart.
 *
 * `?styleAnimFps=N` forces a specific uniform-advance rate (1..120) for A/B
 * capture — same escape-hatch pattern as `?msaa=` and `?overlayDpr=`.
 */

/** Shared with the render governor's low-demand scene frame rate. */
import { STYLE_ANIM_LOW_DEMAND_FPS } from '../renderGovernor.js';

/** Default uniform-advance cadence of the style loop, in ms (~33 ms). */
export const STYLE_ANIM_FRAME_INTERVAL_MS = Math.round(1000 / STYLE_ANIM_LOW_DEMAND_FPS);

/** Upper bound for the `?styleAnimFps=` override (display-class refresh). */
export const STYLE_ANIM_FPS_OVERRIDE_CAP = 120;

/**
 * Resolve the minimum interval between style-loop advances.
 * @param {object} [options] Injectable inputs; defaults read the live page
 *   location, tests pass a literal string instead.
 * @param {string} [options.search] Query string to read overrides from
 *   (defaults to the live location, injectable for tests).
 * @returns {number} Milliseconds between advances; 1..1000/1.
 */
export function resolveStyleAnimFrameIntervalMs({
  search = globalThis.location?.search ?? '',
} = {}) {
  const override = Number(new URLSearchParams(search).get('styleAnimFps'));
  if (Number.isFinite(override) && override >= 1) {
    const fps = Math.min(STYLE_ANIM_FPS_OVERRIDE_CAP, Math.round(override));
    return Math.max(1, Math.round(1000 / fps));
  }
  return STYLE_ANIM_FRAME_INTERVAL_MS;
}

/**
 * Whether the style loop should advance on this rAF tick.
 * @param {number} lastAdvanceMs Timestamp (performance.now) of the last
 *   advance, or any value ≤ now - interval for "advance immediately"
 *   (-Infinity on a fresh arm).
 * @param {number} nowMs Current performance.now().
 * @param {number} [minIntervalMs] Minimum spacing between advances.
 * @returns {boolean} True when the loop should do its (non-trivial) work.
 */
export function styleAnimShouldAdvance(lastAdvanceMs, nowMs, minIntervalMs = STYLE_ANIM_FRAME_INTERVAL_MS) {
  const interval = Number(minIntervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return true;
  return Number(nowMs) - Number(lastAdvanceMs) >= interval;
}
