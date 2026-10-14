import * as Cesium from 'cesium';
import { imageConeGlyph } from './glyphs.js';
import { passesImageryFilter } from './filter.js';
import { refineHeights } from './groundCast.js';
import { createHorizonCull, metresBetween } from './view.js';
import { meshCellKey } from './meshSampler.js';

/** How many recently viewed sequences keep their image list in memory. */
const SEQUENCE_CACHE_SIZE = 40;

/** Cones closer than this to the previous kept one are dropped. */
export const IMAGE_CONE_MIN_SPACING_M = 3;
export const IMAGE_CONE_SIZE_PX = 26;

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
 * Image cones for one selected sequence, any provider's. A cone's pick id is
 * `pickPrefix` + the image id; 360° images draw as rings.
 *
 * @param {object} options
 * @param {object} options.state  Provider state: `context`, `services`, `viewer`, `sequence`.
 * @param {(sequenceId: string, init: {signal: AbortSignal}) => Promise<Array<ConeImage>>} options.loadImages
 *   The sequence's images in capture order, thinned (see `thinImages`).
 * @param {{coverage: string}} options.colors
 * @param {string} options.pickPrefix   Pick-id prefix of the cones.
 * @param {string} options.spriteId     Sprite-order id of the cone collection.
 * @param {string} options.renderKey    Render-governor reason.
 * @param {(sequenceId: string, selected: boolean) => void} [options.onHighlight]
 *   Highlight (or stop highlighting) the sequence's coverage line.
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

  const nothingDrawn = () => ({ images: [], cones: [], cells: new Set() });
  /** Drawn cones, plus the mesh cells under them, so a sample moves only those. */
  let drawn = nothingDrawn();

  // The cones skip the depth test: hide the ones behind the globe.
  const horizon = createHorizonCull({
    getViewer: () => state.viewer,
    items: () => drawn.cones.map((cone) => cone.billboard),
    onChange: requestRender,
  });

  function ensureCollections(viewer) {
    if (state.sequence.collection) return;
    state.sequence.collection = new Cesium.BillboardCollection({
      scene: viewer.scene,
    });
    viewer.scene.primitives.add(state.sequence.collection);
    sprites?.registerSpriteCollection?.(spriteId, state.sequence.collection);
  }

  function clearCones() {
    state.sequence.collection?.removeAll();
    state.sequence.images = [];
    drawn = nothingDrawn();
    horizon.stop();
  }

  /** Where a cone stands: at `height`, or clamped to the ground when null. */
  function placement(image, height) {
    return {
      position: Cesium.Cartesian3.fromDegrees(
        image.lon,
        image.lat,
        height ?? 0,
      ),
      heightReference:
        height === null
          ? Cesium.HeightReference.CLAMP_TO_GROUND
          : Cesium.HeightReference.NONE,
    };
  }

  /**
   * Terrain-mode cone heights on the street, not on roofs: bare earth refined
   * by mesh samples. Null when draped or while terrain heights are fetched.
   */
  function coneHeights(images, { request = true } = {}) {
    const ground = state.context.groundCaster;
    if (state.context.getSurface?.() !== 'terrain' || !ground) return null;
    const dems = images.map((image) => ground.groundAt(image.lon, image.lat));
    if (dems.includes(null)) {
      ground
        .prepare(images.map((image) => [image.lon, image.lat]))
        .then((ready) => {
          if (ready && state.sequence.images === images) renderCones(images);
        });
      return null;
    }
    const sampler = state.context.meshSampler;
    if (request)
      sampler?.request(images.map((image) => [image.lon, image.lat]));
    return refineHeights(
      images.map((image, i) => ({
        dem: dems[i],
        mesh: sampler?.meshAt(image.lon, image.lat),
      })),
    );
  }

  function renderCones(images) {
    const collection = state.sequence.collection;
    if (!collection) return;
    collection.removeAll();
    drawn = { ...nothingDrawn(), images };
    const heights = coneHeights(images);
    // One colour per source; 360° images keep the ring shape.
    const cone = imageConeGlyph({ size: 32, color: colors.coverage });
    const ring = imageConeGlyph({
      size: 32,
      color: colors.coverage,
      pano: true,
    });
    // Resolved now, so a "since N days" window keeps up with the clock.
    const filter = state.context.getFilter();
    images.forEach((image, index) => {
      if (!passes(image, filter)) return;
      const height = heights?.[index] ?? null;
      const billboard = collection.add({
        id: `${pickPrefix}${image.id}`,
        ...placement(image, height),
        image: image.isPano ? ring : cone,
        imageId: image.isPano ? `${spriteId}:pano` : `${spriteId}:flat`,
        width: IMAGE_CONE_SIZE_PX,
        height: IMAGE_CONE_SIZE_PX,
        rotation: -Cesium.Math.toRadians(image.compassAngle),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(200, 1.1, 6000, 0.35),
      });
      drawn.cones.push({ index, billboard, height });
      drawn.cells.add(meshCellKey(image.lon, image.lat));
    });
    horizon.update();
    requestRender();
  }

  /**
   * Re-place cones whose height new mesh samples changed. A sample can move
   * a neighbour too, so every height is recomputed but only moved cones touched.
   */
  function onMeshSampled(batch) {
    if (state.context.getSurface?.() !== 'terrain' || !drawn.cones.length)
      return;
    if (!batch.some(([lon, lat]) => drawn.cells.has(meshCellKey(lon, lat))))
      return;
    const { images, cones } = drawn;
    // Already asked for when drawn; a missing terrain cell redraws them all.
    const heights = coneHeights(images, { request: false });
    if (!heights) return;
    const moved = [];
    for (const cone of cones) {
      const height = heights[cone.index] ?? null;
      if (height === cone.height) continue;
      cone.height = height;
      const { position, heightReference } = placement(
        images[cone.index],
        height,
      );
      cone.billboard.heightReference = heightReference;
      cone.billboard.position = position;
      moved.push(cone.billboard);
    }
    if (!moved.length) return;
    horizon.update(moved);
    requestRender();
  }

  function remember(sequenceId, images) {
    const { cache } = state.sequence;
    cache.delete(sequenceId);
    cache.set(sequenceId, images);
    while (cache.size > SEQUENCE_CACHE_SIZE)
      cache.delete(cache.keys().next().value);
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
    if (state.sequence.selectedId && state.sequence.selectedId !== sequenceId)
      onHighlight(state.sequence.selectedId, false);
    state.sequence.abort?.abort();
    state.sequence.selectedId = sequenceId;
    onHighlight(sequenceId, true);
    const cached = force ? null : state.sequence.cache.get(sequenceId);
    if (cached) {
      state.sequence.abort = null;
      state.sequence.loading = false;
      state.sequence.images = cached;
      renderCones(cached);
      state.context.actions.reportError(null);
      notify();
      return;
    }
    // The previous sequence's cones must not stay clickable under the new
    // highlight while this one loads, nor after its load fails.
    clearCones();
    requestRender();
    const controller = new AbortController();
    state.sequence.abort = controller;
    state.sequence.loading = true;
    notify();
    try {
      const images = await loadImages(sequenceId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      remember(sequenceId, images);
      state.sequence.images = images;
      renderCones(images);
      state.context.actions.reportError(null);
    } catch (error) {
      if (!controller.signal.aborted) {
        // Nothing to show: drop the highlight, so a click asks again.
        onHighlight(sequenceId, false);
        state.sequence.selectedId = null;
        state.context.actions.reportError(
          error?.message || 'Sequence images unavailable',
        );
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
    if (state.sequence.selectedId)
      onHighlight(state.sequence.selectedId, false);
    state.sequence.selectedId = null;
    state.sequence.loading = false;
    clearCones();
    // An error about the sequence goes with it.
    state.context.actions.reportError(null);
    requestRender();
    notify();
  }

  /** Re-draw the current sequence's cones (after an imagery filter change). */
  function rerender() {
    if (state.sequence.images.length) renderCones(state.sequence.images);
  }

  // New mesh samples may move the cones onto (or off) the road surface.
  const stopMeshListener = state.context.meshSampler?.onSampled(onMeshSampled);

  function setVisible(visible) {
    if (state.sequence.collection) state.sequence.collection.show = visible;
    requestRender();
  }

  function destroy(viewer) {
    state.sequence.abort?.abort();
    horizon.stop();
    drawn = nothingDrawn();
    stopMeshListener?.();
    const collection = state.sequence.collection;
    if (collection) {
      sprites?.unregisterSpriteCollection?.(spriteId, collection);
      viewer?.scene?.primitives?.remove(collection);
      state.sequence.collection = null;
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
