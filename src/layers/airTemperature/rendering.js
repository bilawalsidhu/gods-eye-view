import {
  createShellSurface,
  WEATHER_SHELL_HEIGHTS,
} from '../weather/shellRendering.js';
import { orderWeatherImagery } from '../weather/imageryOrder.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';
import { createTemperatureRaster } from './fields.js';
import { msg } from '../../i18n/index.js';

const FIELD_ALPHA = 0.6;
// The globe's ground atmosphere washes imagery towards pale beige from orbit;
// doubled saturation restores the ramp's hues without hiding the coastlines.
// The raised 3D Tiles shell is not hazed, so it keeps the palette as drawn.
const GLOBE_SATURATION = 2;

/** One static field owned by the active globe collection or photorealistic shell. */
export function createAirTemperatureRendering({
  cesium,
  getViewer,
  getHost,
  onStatusChange,
  createShell = createShellSurface,
  document = globalThis.document,
  eventTarget = globalThis.window,
} = {}) {
  let snapshot = null;
  let imagery = null;
  let shell = null;
  let collection = null;
  let kind = null;
  let error = null;
  let removeError = null;
  const clearSurface = () => {
    removeError?.();
    removeError = null;
    if (imagery && !collection?.isDestroyed?.())
      collection.remove(imagery, true);
    shell?.destroy();
    imagery = shell = collection = kind = null;
    getViewer()?.scene?.requestRender?.();
  };
  function install() {
    clearSurface();
    error = null;
    if (!snapshot) return;
    const host = getHost();
    const viewer = getViewer();
    kind = host.kind;
    collection = host.collection;
    if (kind === 'none') {
      error = NO_IMAGERY_HOST;
      onStatusChange?.();
      return;
    }
    try {
      // Half-degree pixels: the bilinear field reads as a gradient up close.
      const raster = createTemperatureRaster(snapshot, {
        width: 720,
        height: 360,
      });
      if (!raster) throw new Error('Temperature field unavailable');
      const texture = document.createElement('canvas');
      texture.width = raster.width;
      texture.height = raster.height;
      const ctx = texture.getContext('2d');
      const pixels = ctx.createImageData(raster.width, raster.height);
      pixels.data.set(raster.rgba);
      ctx.putImageData(pixels, 0, 0);
      if (kind === 'tileset') {
        shell = createShell({
          viewer,
          cesium,
          rectangle: cesium.Rectangle.MAX_VALUE,
          height: WEATHER_SHELL_HEIGHTS.wind + 100,
        });
        shell.setImage(texture);
        shell.setAlpha(FIELD_ALPHA);
        shell.setShow(true);
      } else {
        const provider = new cesium.SingleTileImageryProvider({
          url: texture.toDataURL('image/png'),
          tileWidth: raster.width,
          tileHeight: raster.height,
          rectangle: cesium.Rectangle.MAX_VALUE,
        });
        imagery = collection.addImageryProvider(provider);
        imagery.alpha = FIELD_ALPHA;
        imagery.saturation = GLOBE_SATURATION;
        orderWeatherImagery(collection, imagery, 0);
        removeError = provider.errorEvent?.addEventListener(() => {
          error = msg('Globe field image unavailable');
          onStatusChange?.();
        });
      }
      viewer.scene?.requestRender?.();
    } catch {
      clearSurface();
      error = msg('Globe field image unavailable');
    }
    onStatusChange?.();
  }
  function rehome() {
    const host = getHost();
    if (snapshot && (host.kind !== kind || host.collection !== collection))
      install();
  }
  return {
    attach() {
      eventTarget?.addEventListener('gev:map-stack-changed', rehome);
    },
    setField(next) {
      snapshot = next;
      install();
    },
    rehome,
    clear() {
      snapshot = null;
      clearSurface();
      error = null;
    },
    destroy() {
      this.clear();
      eventTarget?.removeEventListener('gev:map-stack-changed', rehome);
    },
    getDiagnostics() {
      return {
        imageryActive: Boolean(imagery || shell),
        host: shell ? 'shell' : imagery ? 'globe' : null,
        imageryError: error,
      };
    },
  };
}
