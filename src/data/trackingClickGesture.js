import * as Cesium from 'cesium';

export const MAX_TRACKING_CLICK_TRAVEL_PX = 6;
export const MAX_TRACKING_CLICK_DURATION_MS = 400;
// Decay time constant for the recent-peak frame gap: a stalled pipeline's
// spike inflates the quantization floor for roughly this long after the
// stall, then the floor relaxes back toward the machine's steady cadence.
export const FRAME_GAP_PEAK_DECAY_TAU_MS = 30_000;

/**
 * Decide whether a completed press stayed spatially click-like. Duration is
 * deliberately ignored so a stationary long press may still select a contact;
 * callers apply the full click classifier before destructive deselection.
 * @param {{travelPx?: number}} gesture - Accumulated pointer path.
 * @returns {boolean} True when travel stays within the click limit.
 */
export function isTrackingSelectionGesture(gesture = {}) {
  const travelPx = Number.isFinite(gesture.travelPx)
    ? Math.max(0, gesture.travelPx)
    : Number.POSITIVE_INFINITY;
  return travelPx <= MAX_TRACKING_CLICK_TRAVEL_PX;
}

/**
 * Decide whether a completed press is a clean click suitable for deselection
 * or another action that requires both short duration and low travel.
 * @param {{travelPx?: number, durationMs?: number}} gesture - Accumulated path and press time.
 * @returns {boolean} True when the gesture stays within both click limits.
 */
export function isTrackingClickGesture(gesture = {}) {
  const durationMs = Number.isFinite(gesture.durationMs)
    ? Math.max(0, gesture.durationMs)
    : Number.POSITIVE_INFINITY;
  return isTrackingSelectionGesture(gesture)
    && durationMs <= MAX_TRACKING_CLICK_DURATION_MS;
}

/**
 * A `now` seam that measures press duration from the browser's event-arrival
 * stamps instead of handler-processing time. Under load (software rendering,
 * heavy layers) the LEFT_UP action can run hundreds of milliseconds after the
 * physical release because a render task sat between the two events in the
 * main thread's queue — `performance.now()` then reports a "long press" for
 * an instant tap, and the duration classifier silently eats every click.
 *
 * DOM stamps survive handler delay but not event-CREATION delay: a saturated
 * main thread stamps the mouseup one or more frames after the mousedown, so a
 * stamp gap can never be more precise than the frame cadence. The clock
 * therefore tracks that cadence and reports the press time beyond a
 * quantization floor of `max(2 × recent-peak frame gap, observed tap
 * quantization)`, both exponentially decayed. A decaying peak, not an
 * average: an input burst queues both stamps behind several long frames, so
 * the gap that must be forgiven is the pipeline's worst recent frame, not
 * its typical one. And rAF cadence alone is not enough — input-event
 * creation is its own pipeline that diverges from frames under load — so
 * the floor also learns from completed presses: an instant tap's stamp gap
 * IS pure quantization, and the recent minimum press gap measures exactly
 * that baseline. When the floor itself reaches the click window, sub-window
 * durations are unmeasurable by construction and the clock reports presses
 * as instant, leaving travel as the only enforceable gate. Healthy machines
 * keep near-true durations and the duration gate behaves exactly as
 * designed; moderately loaded machines get burst forgiveness up to the
 * floor; a machine that cannot express the tap/hold distinction must not
 * lose working clicks over it.
 *
 * Attach to the same element the ScreenSpaceEventHandler listens on. Cesium's
 * normalized events carry no stamp, so the clock watches the DOM directly —
 * via POINTER events when the browser has them: Cesium's handler is
 * pointer-based, and on some pipelines (CDP-driven headless Chrome) the
 * compatibility mousedown/mouseup pair is never generated at all, so a
 * mouse-event clock silently degenerates to wall-clock handler-processing
 * time and eats every click. Mouse events remain the fallback for engines
 * without PointerEvent. The two families are never mixed: for one physical
 * press pointerdown always precedes mousedown, and interleaved stamps would
 * corrupt the measured gap.
 * Falls back to wall-clock `performance.now()` when no stamps are available
 * (e.g. synthetic touch sequences), so duration never regresses to Infinity.
 * @param {Element|object|null} element - Element the gesture handler binds.
 * @returns {{now: () => number, dispose: () => void}} Clock seam + cleanup.
 */
export function domEventPressClock(element) {
  let downStamp = null;
  let upStamp = null;
  let pressUnmeasurable = false;
  let prevFrameAt = 0;
  let peakFrameGapMs = 0;
  let minPressGapMs = 0;
  let lastSampleAt = 0;
  let frameHandle = 0;
  const stampOf = (e) => (typeof e?.timeStamp === 'number' ? e.timeStamp : null);
  // Listener-level starvation: the event was created well before the main
  // thread got around to running this handler.
  const unmeasurable = (stamp) => (stamp === null
    || Math.max(0, performance.now() - stamp) > MAX_TRACKING_CLICK_DURATION_MS);
  const decayEstimates = (t) => {
    // Exponential decay (τ = 30 s) keeps a one-off stall from disabling the
    // duration gate indefinitely; sustained samples at the machine's real
    // cadence re-arm the estimates within a few frames of any change.
    if (lastSampleAt) {
      const decay = Math.exp(-(t - lastSampleAt) / FRAME_GAP_PEAK_DECAY_TAU_MS);
      peakFrameGapMs *= decay;
      minPressGapMs *= decay;
    }
    lastSampleAt = t;
  };
  const onFrame = (t) => {
    frameHandle = 0;
    if (prevFrameAt) {
      const gap = t - prevFrameAt;
      decayEstimates(t);
      if (gap > peakFrameGapMs) peakFrameGapMs = gap;
    }
    prevFrameAt = t;
    if (typeof window !== 'undefined' && typeof requestAnimationFrame === 'function') {
      frameHandle = requestAnimationFrame(onFrame);
    }
  };
  const startCadenceSampling = () => {
    if (!frameHandle && typeof window !== 'undefined' && typeof requestAnimationFrame === 'function') {
      frameHandle = requestAnimationFrame(onFrame);
    }
  };
  const onDown = (e) => {
    downStamp = stampOf(e);
    pressUnmeasurable = unmeasurable(downStamp);
    upStamp = null;
  };
  const onUp = (e) => {
    upStamp = stampOf(e);
    if (unmeasurable(upStamp)) pressUnmeasurable = true;
  };
  // Pointer events where available (Cesium's pipeline, CDP-driven input);
  // mouse events only where PointerEvent is missing. Never both.
  const pressTypes = (typeof window !== 'undefined' && typeof window.PointerEvent === 'function')
    ? { down: 'pointerdown', up: 'pointerup', cancel: 'pointercancel' }
    : { down: 'mousedown', up: 'mouseup', cancel: null };
  element?.addEventListener?.(pressTypes.down, onDown, { capture: true, passive: true });
  element?.addEventListener?.(pressTypes.up, onUp, { capture: true, passive: true });
  if (pressTypes.cancel) {
    // A canceled pointer (touch scroll takeover) ends the press: keep the
    // clock consistent even though no pointerup will arrive.
    element?.addEventListener?.(pressTypes.cancel, onUp, { capture: true, passive: true });
  }
  // Warm the cadence estimate from construction: the FIRST click on a loaded
  // machine is exactly the one that must not be eaten, so the EMA cannot
  // wait for presses to sample. The loop is one arithmetic comparison per
  // frame and does not schedule rendering.
  startCadenceSampling();
  return {
    // Before this press's release stamp arrives, the stored up-stamp is the
    // PREVIOUS press's (stamps are monotonic, so it sorts below the fresh
    // down-stamp) — return the down-stamp, i.e. the press's start time. Once
    // the matching up-stamp lands, return the hold time BEYOND the pipeline's
    // quantization floor — unless the floor itself reaches the click window,
    // in which case the machine cannot express sub-window durations at all
    // and every press reads as instant. Completing a press also feeds the
    // learned quantization baseline: its raw stamp gap is a sample of what
    // the pipeline did to the shortest possible press.
    now: () => {
      if (downStamp === null) return performance.now();
      if (upStamp !== null && upStamp >= downStamp) {
        if (pressUnmeasurable) return downStamp;
        const gap = upStamp - downStamp;
        // Measure against the baseline learned from PREVIOUS presses — a
        // press must never be forgiven by its own gap. This press's raw gap
        // then feeds the baseline for the next one (its smallest observed
        // value is what the pipeline did to the shortest possible press).
        const quantizationFloorMs = Math.max(2 * peakFrameGapMs, minPressGapMs);
        if (gap < minPressGapMs || minPressGapMs === 0) minPressGapMs = gap;
        if (quantizationFloorMs >= MAX_TRACKING_CLICK_DURATION_MS) return downStamp;
        if (gap <= quantizationFloorMs) return downStamp;
        return downStamp + (gap - quantizationFloorMs);
      }
      return downStamp;
    },
    dispose: () => {
      if (frameHandle && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameHandle);
        frameHandle = 0;
      }
      element?.removeEventListener?.(pressTypes.down, onDown, { capture: true });
      element?.removeEventListener?.(pressTypes.up, onUp, { capture: true });
      if (pressTypes.cancel) {
        element?.removeEventListener?.(pressTypes.cancel, onUp, { capture: true });
      }
    },
  };
}

/**
 * Bind LEFT_DOWN/MOUSE_MOVE/LEFT_UP accounting ahead of a scene click.
 * Travel is accumulated segment-by-segment, so an orbit nudge that returns to
 * its starting pixel cannot masquerade as a zero-distance click. Every scene
 * click reaches `onClick` with its gesture metadata; the caller decides whether
 * selection (travel-only) or deselection (travel + duration) is allowed.
 *
 * Pass `now: domEventPressClock(element).now` on production binding sites so
 * press duration tracks physical press time rather than main-thread queueing
 * delay (see that helper).
 * @param {Cesium.ScreenSpaceEventHandler|object} handler - Input handler.
 * @param {(click: object, gesture: {travelPx: number, durationMs: number}) => void} onClick - Scene-click callback.
 * @param {{now?: () => number, eventTypes?: object, onMouseMove?: (event: object) => void}} [options] - Test/interop seams.
 * @returns {void}
 */
export function bindTrackingClickGesture(handler, onClick, options = {}) {
  const now = options.now || (() => performance.now());
  const eventTypes = options.eventTypes || Cesium.ScreenSpaceEventType;
  let pressActive = false;
  let pressStartedAt = 0;
  let previousPosition = null;
  let travelPx = 0;
  let completedGesture = null;

  const appendTravel = (position) => {
    if (!pressActive || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
    if (previousPosition) {
      travelPx += Math.hypot(
        position.x - previousPosition.x,
        position.y - previousPosition.y,
      );
    }
    previousPosition = { x: position.x, y: position.y };
  };

  const finishPress = (position) => {
    if (!pressActive) return;
    appendTravel(position);
    completedGesture = {
      travelPx,
      durationMs: Math.max(0, now() - pressStartedAt),
    };
    pressActive = false;
    previousPosition = null;
  };

  handler.setInputAction((event) => {
    pressActive = true;
    pressStartedAt = now();
    previousPosition = null;
    travelPx = 0;
    completedGesture = null;
    appendTravel(event?.position);
  }, eventTypes.LEFT_DOWN);

  handler.setInputAction((event) => {
    appendTravel(event?.endPosition ?? event?.position);
    options.onMouseMove?.(event);
  }, eventTypes.MOUSE_MOVE);

  handler.setInputAction((event) => {
    finishPress(event?.position);
  }, eventTypes.LEFT_UP);

  handler.setInputAction((click) => {
    if (pressActive) finishPress(click?.position);
    const gesture = completedGesture || { travelPx: 0, durationMs: 0 };
    completedGesture = null;
    onClick(click, gesture);
  }, eventTypes.LEFT_CLICK);
}
