import { imageConeGlyph } from './glyphs.js';
import { passesImageryFilter } from './filter.js';
import { metresBetween } from './view.js';
import { CONE_SPRITE_ORDER } from './policy.js';
import { msg } from '../../i18n/index.js';

/** Cones closer than this to the previous kept one are dropped. */
const IMAGE_CONE_MIN_SPACING_M = 3;
const IMAGE_CONE_SIZE_PX = 26;
/** NearFarScalar [nearM, nearScale, farM, farScale]: cones shrink with distance. */
export const IMAGE_CONE_SCALE_BY_DISTANCE = Object.freeze([
  200, 1.1, 6000, 0.35,
]);

/**
 * @typedef {object} ConeImage   One image of a sequence, as the cones draw it.
 * @property {string} id
 * @property {number} lon
 * @property {number} lat
 * @property {number} compassAngle   Degrees clockwise from north.
 * @property {number} capturedAt     Epoch ms (0 when unknown).
 * @property {boolean} isPano
 */

/** Drop images closer than the spacing to the previous kept one. */
export function thinImages(images, spacingM = IMAGE_CONE_MIN_SPACING_M) {
  const kept = [];
  let last = null;
  for (const image of images) {
    if (!last || metresBetween(last, image) >= spacingM) {
      kept.push(image);
      last = image;
    }
  }
  return kept;
}

/**
 * Image cones for one selected sequence, any provider's, on the ground
 * (sprites of the display, render/display.js). A cone's pick id is `pickPrefix` + the image id; 360° images draw
 * as rings. Why a sequence could not load stays in `state.sequence.error`
 * until it goes.
 *
 * @param {object} options
 * @param {object} options.state  Provider state: `context`, `services`, `viewer`, `sequence`.
 * @param {(sequenceId: string, init: {signal: AbortSignal}) => Promise<Array<ConeImage>>} options.loadImages
 *   The sequence's images in capture order, thinned (see `thinImages`).
 * @param {{coverage: string}} options.colors
 * @param {string} options.pickPrefix   Pick-id prefix of the cones.
 * @param {string} options.spriteId     Id of the cone sprites.
 * @param {string} options.renderKey    Render-governor reason.
 * @param {(sequenceId: string|null) => void} [options.onHighlight]
 *   Highlight the sequence's coverage line (null: none).
 * @param {(image: ConeImage, filter: object) => boolean} [options.passes]
 *   Whether the imagery filter keeps a cone.
 */
export function createSequenceCones({
  state,
  loadImages,
  colors,
  pickPrefix,
  spriteId,
  renderKey,
  onHighlight = () => {},
  passes = passesImageryFilter,
}) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.(renderKey, state.map?.engine);
  }

  function notify() {
    state.context.notify();
  }

  function ensureCollections(view) {
    if (state.sequence.collection || !view?.sprites) return;
    state.sequence.collection = view.sprites(spriteId, {
      order: CONE_SPRITE_ORDER,
    });
  }

  function clearCones() {
    state.sequence.collection?.removeAll();
    state.sequence.images = [];
  }

  function renderCones(images) {
    const collection = state.sequence.collection;
    if (!collection) return;
    collection.removeAll();
    // One colour per source; 360° images keep the ring shape.
    const cone = imageConeGlyph({ size: 32, color: colors.coverage });
    const ring = imageConeGlyph({
      size: 32,
      color: colors.coverage,
      pano: true,
    });
    // Resolved now, so a "since N days" window keeps up with the clock.
    const filter = state.context.getFilter();
    for (const image of images) {
      if (!passes(image, filter)) continue;
      collection.add({
        pickId: `${pickPrefix}${image.id}`,
        lon: image.lon,
        lat: image.lat,
        bearing: image.compassAngle,
        image: image.isPano ? ring : cone,
        imageKey: image.isPano ? 'pano' : 'flat',
        sizePx: IMAGE_CONE_SIZE_PX,
        scaleByDistance: IMAGE_CONE_SCALE_BY_DISTANCE,
      });
    }
    requestRender();
  }

  /**
   * Select a sequence: highlight its line and load its image cones. `force`
   * reloads a selected one (a provider that loads part of a sequence moved on).
   */
  async function select(sequenceId, { force = false } = {}) {
    if (!sequenceId || (!state.map && state.context.viewReady?.() !== false))
      return;
    // Already on screen, or already on its way.
    if (
      !force &&
      state.sequence.selectedId === sequenceId &&
      (state.sequence.images.length || state.sequence.abort)
    )
      return;
    state.sequence.abort?.abort();
    state.sequence.selectedId = sequenceId;
    onHighlight(sequenceId);
    // The previous sequence's cones must not stay clickable under the new
    // highlight while this one loads, nor after its load fails.
    clearCones();
    requestRender();
    const controller = new AbortController();
    state.sequence.abort = controller;
    state.sequence.loading = true;
    // An earlier sequence's error does not belong to this one.
    state.sequence.error = null;
    notify();
    try {
      const images = await loadImages(sequenceId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      state.sequence.images = images;
      renderCones(images);
      state.sequence.error = null;
    } catch (error) {
      if (!controller.signal.aborted) {
        // Nothing to show: drop the highlight, so a click asks again.
        onHighlight(null);
        state.sequence.selectedId = null;
        state.sequence.error =
          error?.message || msg('Sequence images unavailable');
      }
    } finally {
      if (state.sequence.abort === controller) {
        state.sequence.loading = false;
        state.sequence.abort = null;
      }
      notify();
    }
  }

  function clearSelection() {
    state.sequence.abort?.abort();
    state.sequence.abort = null;
    if (state.sequence.selectedId) onHighlight(null);
    state.sequence.selectedId = null;
    state.sequence.loading = false;
    clearCones();
    // An error about the sequence goes with it.
    state.sequence.error = null;
    requestRender();
    notify();
  }

  /** Re-draw the current sequence's cones (after an imagery filter change). */
  function rerender() {
    if (state.sequence.images.length) renderCones(state.sequence.images);
  }

  function setVisible(visible) {
    state.sequence.collection?.show(visible);
    requestRender();
  }

  function releaseCollection() {
    state.sequence.collection?.destroy();
    state.sequence.collection = null;
  }
  function destroy() {
    state.sequence.abort?.abort();
    releaseCollection();
    state.sequence.images = [];
    state.sequence.selectedId = null;
  }

  return {
    ensureCollections,
    releaseCollection,
    select,
    clearSelection,
    rerender,
    setVisible,
    destroy,
  };
}
