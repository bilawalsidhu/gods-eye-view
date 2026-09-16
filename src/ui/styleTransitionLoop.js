/**
 * Pure decision/sampling core of the StyleManager style-animation loop
 * (Batch G carve-out — docs/PLAN.md).
 *
 * The loop itself lives in `StyleManager._startAnimationLoop` (it owns the
 * rAF handle, the stage registry, and the render-governor hold); everything
 * here is the deterministic math it runs each tick, extracted so the
 * crossfade easing, stage-clock advance, and settle decision can be unit
 * tested without a Cesium viewer or fake rAF harness.
 *
 * No DOM, no timing sources: every function takes its `now`/state as
 * arguments.
 */

/** Crossfade duration for style stage intensity, in ms. */
export const STYLE_TRANSITION_DURATION_MS = 500;

/** Intensity above which an enabled stage counts as actually visible. */
export const ANIMATED_STAGE_VISIBLE_EPSILON = 0.001;

/**
 * Ease-in-out quadratic: smooth acceleration then deceleration.
 * @param {number} t Progress in [0, 1].
 * @returns {number} Eased progress in [0, 1].
 */
export function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Sample a crossfade at a point in time.
 * @param {object} transition Active transition record
 *   ({ start, from, to } — performance.now ms epoch and intensities).
 * @param {number} nowMs Current performance.now().
 * @param {number} [durationMs] Total crossfade duration.
 * @returns {{ value: number, done: boolean }} Interpolated intensity and
 *   whether the transition has reached (or passed) its target.
 */
export function sampleStyleTransition(transition, nowMs, durationMs = STYLE_TRANSITION_DURATION_MS) {
  const elapsed = Math.max(0, Number(nowMs) - Number(transition.start));
  const t = Math.min(elapsed / Number(durationMs), 1);
  const eased = easeInOutQuad(t);
  return {
    value: transition.from + (transition.to - transition.from) * eased,
    done: t >= 1,
  };
}

/**
 * Advance every stage's wall-clock `time` uniform and report whether any
 * stage is actually on screen. Mutates `stage.uniforms.time` exactly as the
 * inline loop did — entries without a time uniform (static stages) are
 * skipped, and only enabled+visible stages keep the loop alive.
 * @param {Iterable<[string, object]>} stageEntries Entries of the stage map
 *   ([name, stage] pairs; stage = { enabled, uniforms: { time?, intensity? } }).
 * @param {number} elapsedSec Wall-clock seconds since the style session began.
 * @returns {boolean} True when at least one enabled stage with a time
 *   uniform is visible (intensity above the epsilon).
 */
export function advanceStageClocks(stageEntries, elapsedSec) {
  let animatedStageVisible = false;
  for (const [, stage] of stageEntries) {
    if (stage.enabled && stage.uniforms.time !== undefined) {
      stage.uniforms.time = elapsedSec;
      // Chain mode keeps zero-intensity stages ENABLED for pass parity —
      // only a stage that is actually VISIBLE keeps the loop (and the
      // continuous-render hold) alive, or a settled CRT session would
      // hold the loop forever via an invisible snow stage.
      if (stage.uniforms.intensity > ANIMATED_STAGE_VISIBLE_EPSILON) {
        animatedStageVisible = true;
      }
    }
  }
  return animatedStageVisible;
}

/**
 * Whether the style loop still has work after a tick (governs the
 * continuous-render hold and the self-stop).
 * @param {number} transitionCount Active crossfade count.
 * @param {boolean} animatedStageVisible Any visible animated stage.
 * @returns {boolean} True to keep the loop (and its render hold) alive.
 */
export function styleLoopNeedsWork(transitionCount, animatedStageVisible) {
  return transitionCount > 0 || animatedStageVisible === true;
}
