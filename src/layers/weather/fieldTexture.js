import { msg } from '../../i18n/index.js';
import { orderWeatherImagery } from './imageryOrder.js';
import { NO_IMAGERY_HOST } from './imageryHost.js';
import { createShellSurface } from './shellRendering.js';

/**
 * Own one global RGBA raster on the map: a single-tile imagery layer on the
 * globe host, or a raised shell over 3D Tiles. Global model fields (sea state,
 * ocean currents) draw through this; it has no network or animation state.
 * @param {{cesium: object, createCanvas: () => HTMLCanvasElement,
 *   priority: number, shellHeight: number}} options
 */
export function createGlobeFieldTexture({
  cesium,
  createCanvas,
  priority,
  shellHeight,
}) {
  let imagery = null;
  let imageryCollection = null;
  let shell = null;
  let installedKind = null;

  function remove() {
    if (imagery && imageryCollection && !imageryCollection.isDestroyed?.())
      imageryCollection.remove(imagery, true);
    imagery = null;
    imageryCollection = null;
    shell?.destroy();
    shell = null;
    installedKind = null;
  }

  /**
   * Replace what is drawn. Returns null, or the English reason nothing could
   * be drawn; a null raster (nothing to colour) draws nothing without error.
   */
  function install({ viewer, collection, kind, raster }) {
    remove();
    if (kind === 'none') return NO_IMAGERY_HOST;
    if (!raster) return null;
    try {
      const texture = createCanvas();
      texture.width = raster.width;
      texture.height = raster.height;
      const ctx = texture.getContext('2d');
      const pixels = ctx.createImageData(raster.width, raster.height);
      pixels.data.set(raster.rgba);
      ctx.putImageData(pixels, 0, 0);
      if (kind === 'tileset') {
        shell = createShellSurface({
          viewer,
          cesium,
          rectangle: cesium.Rectangle.MAX_VALUE,
          height: shellHeight,
        });
        shell.setImage(texture);
        shell.setAlpha(1);
        shell.setShow(true);
      } else {
        const provider = new cesium.SingleTileImageryProvider({
          url: texture.toDataURL('image/png'),
          tileWidth: raster.width,
          tileHeight: raster.height,
          rectangle: cesium.Rectangle.MAX_VALUE,
        });
        imagery = collection.addImageryProvider(provider);
        orderWeatherImagery(collection, imagery, priority);
        imageryCollection = collection;
      }
      installedKind = kind;
      viewer.scene?.requestRender?.();
      return null;
    } catch {
      remove();
      return msg('Globe field image unavailable');
    }
  }

  return {
    install,
    remove,
    /** The host kind drawn on now ('globe' or 'tileset'), or null. */
    get kind() {
      return installedKind;
    },
  };
}
