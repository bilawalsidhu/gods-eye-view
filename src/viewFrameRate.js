/**
 * The Display panel's Frame rate: the most frames a second the globe draws,
 * whatever moves (src/renderGovernor.js `setFrameRateCap`), from 30 to 240 or
 * unlimited (the display's own rate). 60 until the user sets it; their choice
 * is kept across visits.
 */
import { DEFAULT_FRAME_RATE, setFrameRateCap } from './renderGovernor.js';

const STORAGE_KEY = 'godsEyeView.frameRate';
/** The lowest and highest rates the slider sets, and its step. */
export const MIN_FRAME_RATE = 30;
export const MAX_FRAME_RATE = 240;
export const FRAME_RATE_STEP = 10;
/** The slider's stop past MAX_FRAME_RATE: unlimited. */
export const UNLIMITED_STOP = MAX_FRAME_RATE + FRAME_RATE_STEP;

/**
 * A rate as kept: a whole number of frames a second in range, or 0 for
 * unlimited; null for anything else.
 * @param {unknown} value
 * @returns {number|null}
 */
export function frameRateOf(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps)) return null;
  if (fps === 0 || fps > MAX_FRAME_RATE) return 0;
  return Math.min(MAX_FRAME_RATE, Math.max(MIN_FRAME_RATE, Math.round(fps)));
}

/** The saved rate, or DEFAULT_FRAME_RATE. */
function readSaved(storage) {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    return (
      (saved === null || saved === undefined ? null : frameRateOf(saved)) ??
      DEFAULT_FRAME_RATE
    );
  } catch {
    return DEFAULT_FRAME_RATE;
  }
}

/**
 * @param {object} options
 * @param {{publishFrameRate: Function, connect: Function, detach: Function}} options.store
 *   The Display store: the panel's Frame rate row and its control.
 * @param {Storage} [options.storage]
 * @param {(fps: number) => void} [options.apply] Where the rate goes (the
 *   render governor's cap).
 * @returns {{destroy: () => void}}
 */
export function createViewFrameRate({
  store,
  storage = globalThis.localStorage,
  apply = setFrameRateCap,
}) {
  let fps = readSaved(storage);
  apply(fps);

  function publish() {
    store?.publishFrameRate?.({
      fps,
      stop: fps === 0 ? UNLIMITED_STOP : fps,
      min: MIN_FRAME_RATE,
      max: UNLIMITED_STOP,
      step: FRAME_RATE_STEP,
    });
  }

  const token = store?.connect?.({
    /** The slider's stop: a rate, or UNLIMITED_STOP. */
    setFrameRate(stop) {
      const next = frameRateOf(stop);
      if (next === null || next === fps) return;
      fps = next;
      apply(fps);
      try {
        storage?.setItem(STORAGE_KEY, String(fps));
      } catch {
        // Private mode: the choice lasts the visit.
      }
      publish();
    },
  });

  publish();

  return {
    destroy() {
      if (token) store?.detach?.(token);
      store?.publishFrameRate?.(null);
    },
  };
}
