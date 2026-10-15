import { createGibsImagery } from '../../maps/imagery.js';
import {
  CROSSFADE_SHARE,
  GIBS_LAYER,
  GIBS_MAX_LEVEL,
  GIBS_TILE_MATRIX_SET,
  MAX_ALPHA,
  MIN_ALPHA,
  PRELOAD_TIMEOUT_MS,
} from './policy.js';

/** @param {number} value Unit interval. @returns {number} Eased value, flat at both ends. */
function smoothstep(value) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

/**
 * Where a continuous playhead sits between two frames.
 *
 * Each frame interval holds first and blends last, so at play speed a month is
 * on screen, still, before it turns into the next one.
 * @param {number} count Frame count.
 * @param {number} position Playhead in frames; wraps.
 * @returns {{from:number, to:number, mix:number}} Frames and blend (0 = `from`).
 */
export function playheadAt(count, position) {
  const wrapped = ((position % count) + count) % count;
  const from = Math.floor(wrapped);
  const hold = 1 - CROSSFADE_SHARE;
  const into = wrapped - from;
  const mix = into <= hold ? 0 : smoothstep((into - hold) / CROSSFADE_SHARE);
  return { from, to: (from + 1) % count, mix };
}

/** @param {number} count Frame count. @param {number} position Playhead. @returns {number} Frame most on screen. */
export function dominantFrame(count, position) {
  const { from, to, mix } = playheadAt(count, position);
  return mix < 0.5 ? from : to;
}

/**
 * Per-frame opacity for a playhead, keeping the overlay's total opacity fixed.
 *
 * Two stacked layers at the same alpha read darker than one: over the basemap
 * they cover 1 − (1 − a)² of it, not a. So the upper frame of the blending
 * pair takes its share of the target directly and the lower one takes what
 * leaves the pair at exactly the target: 1 − (1 − a) / (1 − upper). At either
 * end of the blend that is one frame at the target and the other at zero, so
 * there is no pop when a frame drops out.
 * @param {number} count Frame count; frames are stacked in index order.
 * @param {number} position Playhead.
 * @param {number} alpha Target overlay opacity.
 * @returns {Array<number>} Alpha per frame.
 */
export function blendAlphas(count, position, alpha) {
  const alphas = new Array(count).fill(0);
  if (count < 1) return alphas;
  if (count === 1) {
    alphas[0] = alpha;
    return alphas;
  }
  const { from, to, mix } = playheadAt(count, position);
  const upper = Math.max(from, to);
  const lower = Math.min(from, to);
  const upperAlpha = (upper === to ? mix : 1 - mix) * alpha;
  alphas[upper] = upperAlpha;
  alphas[lower] =
    upperAlpha >= 1
      ? 0
      : Math.min(1, Math.max(0, 1 - (1 - alpha) / (1 - upperAlpha)));
  return alphas;
}

/**
 * The playback frames as one stack of imagery layers.
 *
 * Every frame is added up front at alpha zero: Cesium streams tiles for a
 * shown, transparent layer but skips drawing it, so a whole year loads once
 * and each step is an alpha change rather than a wait on the network. A new
 * year loads the same way underneath the one on screen and replaces it only
 * once its tiles have landed, so switching year never blanks the globe.
 *
 * `addImageryProvider` appends, and MapSourceController inserts its basemap at
 * index 0 and only ever removes its own layer — so the frames survive a basemap
 * switch and composite on top of whichever stack is active.
 */
export function createFilmstrip({ state: layerState, services }) {
  const { governorRequestRender } = services.render;
  /** A year still loading underneath the shown one. */
  let pending = null;

  /**
   * Resolve once the globe has drawn every tile it wants, twice running, or
   * after PRELOAD_TIMEOUT_MS. One quiet frame is not enough: Cesium can report
   * loaded between requesting a level and receiving it.
   * @param {AbortSignal} [signal] Cancellation.
   * @returns {Promise<boolean>} False when cancelled.
   */
  function whenTilesSettle(signal) {
    const scene = layerState.viewer.scene;
    return new Promise((resolve) => {
      let quiet = 0;
      let done = false;
      const finish = (ready) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        offRender?.();
        signal?.removeEventListener('abort', onAbort);
        resolve(ready);
      };
      const onAbort = () => finish(false);
      const timeout = setTimeout(() => finish(true), PRELOAD_TIMEOUT_MS);
      const offRender = scene.postRender.addEventListener(() => {
        if (scene.globe?.show === false || scene.globe?.tilesLoaded) quiet += 1;
        else quiet = 0;
        if (quiet >= 2) finish(true);
        else governorRequestRender('temperature-frames-load');
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      governorRequestRender('temperature-frames-load');
    });
  }

  function removeLayers(strip) {
    for (const layer of strip?.layers ?? [])
      layerState.viewer?.imageryLayers?.remove(layer, true);
  }

  /** Drop the shown year and any year still loading. */
  function clear() {
    removeLayers(pending);
    pending = null;
    const strip = layerState.filmstrip;
    if (!strip) return;
    layerState.filmstrip = null;
    removeLayers(strip);
    governorRequestRender('temperature-frames-clear');
  }

  /**
   * Load a year's frames underneath the shown ones, then take their place.
   * @param {Array<string>} dates Frame time keys, oldest first.
   * @param {{signal?:AbortSignal}} [options] Cancellation.
   * @returns {Promise<boolean>} Whether the new frames are now the shown stack.
   */
  async function load(dates, { signal } = {}) {
    if (!layerState.viewer || signal?.aborted) return false;
    removeLayers(pending);
    const collection = layerState.viewer.imageryLayers;
    const strip = {
      dates,
      position: 0,
      layers: dates.map((date) => {
        const imagery = collection.addImageryProvider(
          createGibsImagery({
            layer: GIBS_LAYER,
            date,
            tileMatrixSet: GIBS_TILE_MATRIX_SET,
            maximumLevel: GIBS_MAX_LEVEL,
          }),
        );
        imagery.alpha = 0;
        return imagery;
      }),
    };
    pending = strip;
    const ready = await whenTilesSettle(signal);
    if (pending !== strip) return false;
    pending = null;
    if (!ready) {
      removeLayers(strip);
      return false;
    }
    removeLayers(layerState.filmstrip);
    layerState.filmstrip = strip;
    return true;
  }

  /** @param {number} position Playhead in frames. */
  function setPosition(position) {
    const strip = layerState.filmstrip;
    if (!strip) return;
    strip.position = position;
    const alphas = blendAlphas(strip.layers.length, position, layerState.alpha);
    strip.layers.forEach((layer, index) => {
      if (layer.alpha !== alphas[index]) layer.alpha = alphas[index];
    });
    governorRequestRender('temperature-frames');
  }

  /** @param {number} value Requested opacity. @returns {number} Applied opacity. */
  function setAlpha(value) {
    const alpha = Math.min(
      MAX_ALPHA,
      Math.max(MIN_ALPHA, Number.isFinite(value) ? value : layerState.alpha),
    );
    layerState.alpha = alpha;
    setPosition(layerState.filmstrip?.position ?? 0);
    return alpha;
  }

  return { load, clear, setPosition, setAlpha };
}
