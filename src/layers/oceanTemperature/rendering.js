import { createShellSurface } from '../weather/shellRendering.js';
import { orderWeatherImagery } from '../weather/imageryOrder.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';
import { buildTileUrl } from './source.js';
import { gibsTileTemplate } from '../../maps/gibs.js';
import { msg } from '../../i18n/index.js';

const TILE_RETRIES = 2;

export function createOceanProvider(cesium, product, date) {
  const maxLevel = Number(product.matrixSet.match(/Level(\d+)$/)[1]);
  return new cesium.UrlTemplateImageryProvider({
    url: gibsTileTemplate({ layer: product.layer, date, maxLevel }),
    tilingScheme: new cesium.WebMercatorTilingScheme(),
    maximumLevel: maxLevel,
    tileWidth: 256,
    tileHeight: 256,
    credit: new cesium.Credit(
      'JPL MUR MEaSUREs / NASA JPL PO.DAAC · NASA GIBS',
    ),
    enablePickFeatures: false,
  });
}

export function createOceanRendering({
  cesium,
  getViewer,
  getHost,
  onChange,
  document = globalThis.document,
  eventTarget = globalThis.window,
  createShell = createShellSurface,
}) {
  let field = null;
  let imagery = null;
  let shell = null;
  let host = null;
  let error = null;
  let generation = 0;
  let offError = null;
  function clearSurface() {
    generation++;
    offError?.();
    offError = null;
    if (imagery && !host.collection.isDestroyed?.())
      host.collection.remove(imagery, true);
    shell?.destroy();
    imagery = shell = null;
    getViewer()?.scene?.requestRender?.();
  }
  async function install() {
    clearSurface();
    error = null;
    host = getHost();
    if (!field) return;
    if (host.kind === 'none') {
      error = NO_IMAGERY_HOST;
      onChange();
      return;
    }
    const current = generation;
    try {
      const provider = createOceanProvider(cesium, field.product, field.date);
      if (host.kind === 'globe') {
        imagery = host.collection.addImageryProvider(provider);
        imagery.alpha = 0.6;
        orderWeatherImagery(host.collection, imagery, 0);
        // One dropped tile is not an outage: retry each tile twice before
        // reporting, as a fetch blip would otherwise mark the layer degraded.
        const retries = new Map();
        offError = provider.errorEvent.addEventListener((failure) => {
          const key = `${failure?.level}/${failure?.x}/${failure?.y}`;
          const count = retries.get(key) ?? 0;
          if (failure && count < TILE_RETRIES) {
            retries.set(key, count + 1);
            failure.retry = true;
            return;
          }
          error = msg('Ocean imagery unavailable');
          onChange();
        });
      } else {
        const mosaic = document.createElement('canvas');
        mosaic.width = mosaic.height = 1024;
        const context = mosaic.getContext('2d');
        const images = await Promise.all(
          Array.from({ length: 16 }, async (_, index) => {
            const x = index % 4;
            const y = Math.floor(index / 4);
            // ImageryProvider image bitmaps are flipped for WebGL upload, not
            // for canvas mosaics. Request north-up source pixels explicitly.
            const url = buildTileUrl({
              ...field.product,
              date: field.date,
              z: 2,
              x,
              y,
            });
            const image = await new cesium.Resource({ url }).fetchImage({
              preferImageBitmap: false,
              flipY: false,
            });
            if (!image) throw new Error('Ocean tile request deferred');
            return { image, x, y };
          }),
        );
        if (current !== generation) return;
        for (const { image, x, y } of images)
          context.drawImage(image, x * 256, y * 256);
        const texture = document.createElement('canvas');
        texture.width = 1024;
        texture.height = 512;
        const target = texture.getContext('2d');
        target.imageSmoothingEnabled = false;
        for (let row = 0; row < 512; row++) {
          const lat = 90 - ((row + 0.5) / 512) * 180;
          if (Math.abs(lat) > 85.0511287798066) continue;
          const sin = Math.sin((lat * Math.PI) / 180);
          const y = Math.floor(
            (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 1024,
          );
          target.drawImage(mosaic, 0, y, 1024, 1, 0, row, 1024, 1);
        }
        shell = createShell({
          viewer: getViewer(),
          cesium,
          rectangle: cesium.Rectangle.MAX_VALUE,
          height: 5100,
        });
        shell.setImage(texture);
        shell.setAlpha(0.6);
        shell.setShow(true);
      }
      getViewer()?.scene?.requestRender?.();
    } catch (cause) {
      if (current !== generation) return;
      clearSurface();
      error = msg('Ocean imagery unavailable');
    }
    onChange();
  }
  const rehome = () => {
    const next = getHost();
    if (
      field &&
      (next.kind !== host?.kind || next.collection !== host?.collection)
    )
      void install();
  };
  eventTarget?.addEventListener('gev:map-stack-changed', rehome);
  return {
    setField(product, date) {
      field = { product, date };
      return install();
    },
    rehome,
    clear() {
      field = null;
      clearSurface();
      error = null;
    },
    getDiagnostics: () => ({
      imageryActive: Boolean(imagery || shell),
      host: shell ? 'shell' : imagery ? 'globe' : null,
      imageryError: error,
    }),
    destroy() {
      this.clear();
      eventTarget?.removeEventListener('gev:map-stack-changed', rehome);
    },
  };
}
