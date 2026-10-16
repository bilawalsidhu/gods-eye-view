/**
 * Draped change map for the AlphaEarth Change layer: one single-tile imagery
 * layer over the comparison box, on whichever host the map stack offers. The
 * grid is coloured in a canvas here, so a threshold change repaints without a
 * new request. The layer is removed from the collection that owns it, so a
 * host switch or a new comparison never strands one.
 */
import * as Cesium from 'cesium';
import { colorizeChange } from './model.js';

const NO_HOST = Object.freeze({ collection: null, kind: 'none' });

function clampAlpha(value) {
  const alpha = Number(value);
  return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
}

/** Paint the grid into a PNG data URL; null without a canvas. */
function paint(documentRef, grid, width, height, threshold) {
  const canvas = documentRef?.createElement?.('canvas');
  const context = canvas?.getContext?.('2d');
  if (!context) return null;
  canvas.width = width;
  canvas.height = height;
  const image = context.createImageData(width, height);
  colorizeChange(grid, threshold, image.data);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Create the renderer.
 * @param {{ cesium?: object, documentRef?: object, requestRender?: (reason: string) => void, credit?: string, paintImpl?: Function }} [options]
 */
export function createAlphaEarthRenderer({
  cesium = Cesium,
  documentRef = globalThis.document,
  requestRender = () => {},
  credit = 'AlphaEarth Foundations',
  paintImpl = paint,
} = {}) {
  let host = NO_HOST;
  let destroyed = false;
  /** What should be shown, independent of whether a host exists. */
  let shown = null;
  /** @type {null | { layer: object, collection: object, url: string }} */
  let owned = null;

  function removeOwned() {
    const record = owned;
    if (!record) return false;
    owned = null;
    try {
      record.collection.remove(record.layer, true);
    } catch {
      /* the collection is already gone */
    }
    return true;
  }

  function mount() {
    if (!shown || !host.collection || destroyed) return false;
    const { box, width, height, url } = shown;
    const provider = new cesium.SingleTileImageryProvider({
      url,
      tileWidth: width,
      tileHeight: height,
      rectangle: cesium.Rectangle.fromDegrees(
        box.west,
        box.south,
        box.east,
        box.north,
      ),
      credit,
    });
    const layer = host.collection.addImageryProvider(provider);
    layer.alpha = shown.alpha;
    owned = { layer, collection: host.collection, url };
    return true;
  }

  return {
    /**
     * Drape a change grid, replacing whatever was draped.
     * @param {{ grid: Uint8Array, width: number, height: number, box: object, threshold: number, alpha?: number }} change
     * @returns {boolean} Whether a layer is now draped.
     */
    show({ grid, width, height, box, threshold, alpha = 0.85 }) {
      if (destroyed || !grid || !box) return false;
      const url = paintImpl(documentRef, grid, width, height, threshold);
      if (!url) return false;
      shown = {
        grid,
        width,
        height,
        box,
        threshold,
        alpha: clampAlpha(alpha),
        url,
      };
      removeOwned();
      const mounted = mount();
      requestRender('alpha-earth-show');
      return mounted;
    },

    /** Repaint the current grid at a new threshold. */
    setThreshold(threshold) {
      if (!shown || shown.threshold === threshold) return false;
      return this.show({ ...shown, threshold });
    },

    setAlpha(alpha) {
      if (!shown) return;
      shown.alpha = clampAlpha(alpha);
      if (owned) {
        owned.layer.alpha = shown.alpha;
        requestRender('alpha-earth-alpha');
      }
    },

    hide() {
      shown = null;
      if (removeOwned()) requestRender('alpha-earth-hide');
    },

    /**
     * Move the drape to a new host. It is rebuilt there, never re-parented,
     * so the old collection is left as it was found.
     */
    rebind(nextHost) {
      host = nextHost || NO_HOST;
      if (owned?.collection === host.collection) return;
      const changed = removeOwned();
      if (mount() || changed) requestRender('alpha-earth-rebind');
    },

    /** What is draped right now. */
    getOwned() {
      return owned ? { kind: host.kind, alpha: owned.layer.alpha } : null;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      shown = null;
      const changed = removeOwned();
      host = NO_HOST;
      if (changed) requestRender('alpha-earth-destroy');
    },
  };
}
