/**
 * Detection holds no continuous render. It repaints on change and requests one more
 * frame while the enable fade-in, a label fade in either direction, or a deferred label
 * solve is outstanding. Each ends, so the chain stops by itself. The host samples
 * performance.now() once into frame.timestamp for both paint and policy. The frame
 * that paints the final state ends demand. detection.js applies these pure policies.
 */

/** Duration of the fade-in when detection (re)activates, in ms. */
export const DETECTION_ENABLE_FADE_MS = 220;

/**
 * Cadence of the scanline's scroll, in ms per 2px step — one frame at 60 fps.
 *
 * Derived rather than written as `16`: a rounded 16 ms is 62.5 Hz, which against
 * a real 60 fps frame clock beats slowly and repeats an offset every few frames
 * instead of alternating. Deriving the cadence from a clock rather than from a
 * frame counter is what lets the animation rest without a render hold.
 */
export const SCANLINE_STEP_MS = 1000 / 60;

/** Scanline pattern period in px — the offset walks 0, 2, 0, 2, … */
export const SCANLINE_PERIOD_PX = 4;

/**
 * Scanline scroll offset for a monotonic frame timestamp.
 *
 * @param {number} nowMs - Frame timestamp in ms (`performance.now()`).
 * @returns {number} Vertical offset in px, within [0, SCANLINE_PERIOD_PX).
 */
export function scanlineOffsetPx(nowMs) {
  if (!Number.isFinite(nowMs)) return 0;
  return (Math.floor(nowMs / SCANLINE_STEP_MS) * 2) % SCANLINE_PERIOD_PX;
}

/**
 * Whether detection still has work spanning frames, and therefore needs one more
 * frame after the one it just painted.
 *
 * Returns false for everything change-driven: those paths already request their
 * own frame through `invalidateHost()`, and asking here as well would turn a
 * bounded chain into a permanent one.
 *
 * @param {object} input
 * @param {boolean} input.active - Detection is on and not suspended.
 * @param {number} input.nowMs - The frame's monotonic timestamp (see header).
 * @param {number} input.enabledAtMs - When detection last (re)activated, same clock.
 * @param {number} [input.fadeMs] - Enable fade-in duration.
 * @param {number} [input.animatingLabelCount] - Labels mid-fade, IN or out.
 * @param {boolean} [input.solvePending] - A label solve is owed but did not run.
 * @returns {boolean} True when one more frame is owed.
 */
export function detectionNeedsFollowUpFrame({
  active,
  nowMs,
  enabledAtMs,
  fadeMs = DETECTION_ENABLE_FADE_MS,
  animatingLabelCount = 0,
  solvePending = false,
} = {}) {
  if (!active) return false;
  if (Number(animatingLabelCount) > 0) return true;
  if (solvePending === true) return true;
  if (!Number.isFinite(nowMs) || !Number.isFinite(enabledAtMs)) return false;
  const age = nowMs - enabledAtMs;
  // `age >= 0` is the fail-toward-idle guard. It cannot trip on the monotonic
  // clock this is fed, but if a caller ever mixes clocks the wrong answer must
  // be "stop asking", never "keep asking until time catches up".
  return age >= 0 && age < fadeMs;
}

/**
 * Paint cost above which the relief valve may skip alternate detection paints.
 */
export const DETECTION_PAINT_SKIP_THRESHOLD_MS = 22;

/**
 * Whether to skip this detection paint under pathological load: alternate
 * frames while the last paint cost more than the threshold. A skip is a
 * deferral, so the caller must request another frame for every skip.
 * @param {object} input
 * @param {boolean} input.layoutChanged - The host's layout revision moved this frame.
 * @param {number} input.lastPaintMs - Cost of the previous detection paint.
 * @param {number} input.frameCount - Monotonic detection frame counter.
 * @returns {boolean}
 */
export function detectionPaintSkipDecision({
  layoutChanged,
  lastPaintMs,
  frameCount,
} = {}) {
  return (
    !layoutChanged &&
    Number(lastPaintMs) > DETECTION_PAINT_SKIP_THRESHOLD_MS &&
    Number(frameCount) % 2 !== 0
  );
}

/**
 * Whether a rendered label row's alpha will still change on a later frame.
 *
 * A `selected` row is still climbing while its alpha is below 1. An unselected
 * row only survives the arbiter's render pass while its exit tail is above 0, so
 * any that reaches here is by definition still moving. Stateless rows have hard
 * cliffs (exactly 1, or gone) and never animate.
 *
 * @param {{selected?: boolean, temporalAlpha?: number}} entry - Arbiter render row.
 * @returns {boolean}
 */
export function renderEntryIsAnimating(entry) {
  if (!entry) return false;
  if (!entry.selected) return true;
  return Number(entry.temporalAlpha) < 1;
}

/**
 * Count rendered rows whose alpha is still moving, in either direction.
 * @param {Array<{selected?: boolean, temporalAlpha?: number}>} renderEntries
 * @returns {number}
 */
export function countAnimatingRenderEntries(renderEntries) {
  let count = 0;
  for (let i = 0; i < renderEntries.length; i++) {
    if (renderEntryIsAnimating(renderEntries[i])) count++;
  }
  return count;
}
