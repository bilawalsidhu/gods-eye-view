import { imageConeGlyph } from './glyphs.js';
import { passesImageryFilter } from './filter.js';
import { createHorizonCull, metresBetween } from './view.js';
import { msg } from '../../i18n/index.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf } from '../../render/rendererOf.js';

/** Cones closer than this to the previous kept one are dropped. */
const IMAGE_CONE_MIN_SPACING_M = 3;
const IMAGE_CONE_SIZE_PX = 26;
/** Cones a little larger near the eye, a third of their size far off. */
const IMAGE_CONE_SCALE = Object.freeze({
  near: 200,
  nearValue: 1.1,
  far: 6000,
  farValue: 0.35,
});

/** Draw-set ids of the cone sets made so far, so every provider instance has its own. */
let coneSets = 0;

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
 * Image cones for one selected sequence, any provider's, clamped to the
 * ground. A cone's pick id is `pickPrefix` + the image id; 360° images draw
 * as rings. Why a sequence could not load stays in `state.sequence.error`
 * until it goes.
 *
 * @param {object} options
 * @param {object} options.state  Provider state: `context`, `services`, `viewer`, `sequence`.
 * @param {(sequenceId: string, init: {signal: AbortSignal}) => Promise<Array<ConeImage>>} options.loadImages
 *   The sequence's images in capture order, thinned (see `thinImages`).
 * @param {{coverage: string}} options.colors
 * @param {string} options.pickPrefix   Pick-id prefix of the cones.
 * @param {string} options.spriteId     Sprite-order id of the cone set (and its draw-set id's stem).
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
  const { render, sprites } = state.services;

  function requestRender() {
    render?.governorRequestRender?.(renderKey);
  }

  function notify() {
    state.context.notify();
  }

  /** Drawn cones: `{icon, position, show}` each, `icon` as last sent. */
  let cones = [];

  // The cones skip the depth test: hide the ones behind the globe.
  const horizon = createHorizonCull({
    getViewer: () => state.viewer,
    items: () => cones,
    onChange: (changed) => {
      state.sequence.set?.upsert(
        changed.map((cone) => ({ ...cone.icon, show: cone.show })),
      );
      requestRender();
    },
  });

  function ensureCollections(viewer) {
    if (state.sequence.set) return;
    state.sequence.set = drawOf(viewer).icons({
      id: `${spriteId}:${++coneSets}`,
    });
    // Drawn from now, empty: the cones keep their place over the marker.
    state.sequence.set.set([]);
    state.sequence.sprite =
      sprites?.registerSpriteSet?.(spriteId, state.sequence.set.id) ?? null;
  }

  function clearCones() {
    state.sequence.set?.clear();
    state.sequence.images = [];
    cones = [];
    horizon.stop();
  }

  function renderCones(images) {
    const set = state.sequence.set;
    if (!set) return;
    // One colour per source; 360° images keep the ring shape.
    const cone = imageConeGlyph({ size: 32, color: colors.coverage });
    const ring = imageConeGlyph({
      size: 32,
      color: colors.coverage,
      pano: true,
    });
    // Resolved now, so a "since N days" window keeps up with the clock.
    const filter = state.context.getFilter();
    cones = [];
    for (const image of images) {
      if (!passes(image, filter)) continue;
      cones.push({
        position: fromDegrees(image.lon, image.lat),
        show: true,
        icon: {
          id: `${pickPrefix}${image.id}`,
          pos: { lon: image.lon, lat: image.lat },
          height: 'clampGround',
          image: image.isPano ? ring : cone,
          size: [IMAGE_CONE_SIZE_PX, IMAGE_CONE_SIZE_PX],
          rotationMode: 'course',
          course: image.compassAngle,
          anchor: 'center',
          disableDepthTest: Number.POSITIVE_INFINITY,
          scaleByDistance: IMAGE_CONE_SCALE,
        },
      });
    }
    // Culled before they are drawn, so far-side cones never show.
    horizon.update(cones, { quiet: true });
    set.set(cones.map((item) => ({ ...item.icon, show: item.show })));
    requestRender();
  }

  /**
   * Select a sequence: highlight its line and load its image cones. `force`
   * reloads a selected one (a provider that loads part of a sequence moved on).
   */
  async function select(sequenceId, { force = false } = {}) {
    if (!sequenceId || !state.viewer) return;
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
    if (state.sequence.set) state.sequence.set.show = visible;
    requestRender();
  }

  function destroy(viewer) {
    state.sequence.abort?.abort();
    horizon.stop();
    cones = [];
    const set = state.sequence.set;
    if (set) {
      sprites?.unregisterSpriteCollection?.(spriteId, state.sequence.sprite);
      set.dispose();
      state.sequence.set = null;
      state.sequence.sprite = null;
    }
    state.sequence.images = [];
    state.sequence.selectedId = null;
  }

  return {
    ensureCollections,
    select,
    clearSelection,
    rerender,
    setVisible,
    destroy,
  };
}
