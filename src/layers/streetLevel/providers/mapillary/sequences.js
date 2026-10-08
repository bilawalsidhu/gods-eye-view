import * as Cesium from 'cesium';
import { imageConeGlyph } from '../../glyphs.js';
import { passesImageryFilter, resolveFilter } from '../../filter.js';
import { createHorizonCull, metresBetween } from '../../view.js';
import {
  COLORS,
  IMAGE_CONE_MIN_SPACING_M,
  IMAGE_CONE_SIZE_PX,
  PICK_PREFIX,
} from './policy.js';

const SPRITE_ID = 'street-level:mapillary-cones';

/** How many recently viewed sequences keep their image list in memory. */
const SEQUENCE_CACHE_SIZE = 40;

/** Normalize a graph image record into the shape the cones use. */
function normalizeSequenceImage(record) {
  const coordinates = record?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  return {
    id: String(record.id),
    lon: Number(coordinates[0]),
    lat: Number(coordinates[1]),
    compassAngle: Number(record.compass_angle) || 0,
    capturedAt: Number(record.captured_at) || 0,
    isPano: record.is_pano === true,
  };
}

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

/** Image cones for one selected sequence. */
export function createSequences({ state, source, parts }) {
  const { render, sprites } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('mapillary-sequence');
  }

  function notify() {
    state.notify?.();
  }

  /** Drawn cone billboards. */
  let cones = [];

  // The cones skip the depth test: hide the ones behind the globe.
  const horizon = createHorizonCull({
    getViewer: () => state.viewer,
    items: () => cones,
    onChange: requestRender,
  });

  function ensureCollections(viewer) {
    if (state.sequence.collection) return;
    state.sequence.collection = new Cesium.BillboardCollection({
      scene: viewer.scene,
    });
    viewer.scene.primitives.add(state.sequence.collection);
    sprites?.registerSpriteCollection?.(SPRITE_ID, state.sequence.collection);
  }

  function clearCones() {
    state.sequence.collection?.removeAll();
    state.sequence.images = [];
    cones = [];
    horizon.stop();
  }

  function renderCones(images) {
    const collection = state.sequence.collection;
    if (!collection) return;
    collection.removeAll();
    cones = [];
    // One colour per source; 360° images keep the ring shape.
    const cone = imageConeGlyph({ size: 32, color: COLORS.coverage });
    const ring = imageConeGlyph({
      size: 32,
      color: COLORS.coverage,
      pano: true,
    });
    // Resolved now, so a "since N days" window keeps up with the clock.
    const filter = resolveFilter(state.filter);
    for (const image of images) {
      if (!passesImageryFilter(image, filter)) continue;
      const billboard = collection.add({
        id: `${PICK_PREFIX.image}${image.id}`,
        position: Cesium.Cartesian3.fromDegrees(image.lon, image.lat),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        image: image.isPano ? ring : cone,
        imageId: image.isPano ? 'mly-cone-pano' : 'mly-cone',
        width: IMAGE_CONE_SIZE_PX,
        height: IMAGE_CONE_SIZE_PX,
        rotation: -Cesium.Math.toRadians(image.compassAngle),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(200, 1.1, 6000, 0.35),
      });
      cones.push(billboard);
    }
    horizon.update();
    requestRender();
  }

  function remember(sequenceId, images) {
    const { cache } = state.sequence;
    cache.delete(sequenceId);
    cache.set(sequenceId, images);
    while (cache.size > SEQUENCE_CACHE_SIZE)
      cache.delete(cache.keys().next().value);
  }

  /** Select a sequence: highlight its line and load its image cones. */
  async function select(sequenceId) {
    if (!sequenceId || !state.viewer) return;
    // Already on screen, or already on its way.
    if (
      state.sequence.selectedId === sequenceId &&
      (state.sequence.images.length || state.sequence.abort)
    )
      return;
    state.sequence.abort?.abort();
    state.sequence.selectedId = sequenceId;
    parts.coverage.highlight(sequenceId);
    const cached = state.sequence.cache.get(sequenceId);
    if (cached) {
      state.sequence.abort = null;
      state.sequence.loading = false;
      state.sequence.images = cached;
      renderCones(cached);
      state.sequence.error = null;
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
      const records = await source.getSequenceImages(sequenceId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const images = thinImages(
        records
          .map(normalizeSequenceImage)
          .filter(Boolean)
          .sort((a, b) => a.capturedAt - b.capturedAt),
      );
      remember(sequenceId, images);
      state.sequence.images = images;
      renderCones(images);
      state.sequence.error = null;
    } catch (error) {
      if (!controller.signal.aborted) {
        // Nothing to show: drop the highlight, so a click asks again.
        parts.coverage.highlight(null);
        state.sequence.selectedId = null;
        state.sequence.error = error?.message || 'Sequence images unavailable';
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
    if (state.sequence.selectedId) parts.coverage.highlight(null);
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
    if (state.sequence.collection) state.sequence.collection.show = visible;
    requestRender();
  }

  function destroy(viewer) {
    state.sequence.abort?.abort();
    horizon.stop();
    cones = [];
    const collection = state.sequence.collection;
    if (collection) {
      sprites?.unregisterSpriteCollection?.(SPRITE_ID, collection);
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
