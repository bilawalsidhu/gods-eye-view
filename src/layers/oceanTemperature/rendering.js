import { createShellSurface } from '../weather/shellRendering.js';
import { orderWeatherImagery } from '../weather/imageryOrder.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';
import { buildTileUrl } from './source.js';
import { gibsTileTemplate } from '../../maps/gibs.js';
import { msg } from '../../i18n/index.js';
import {
  smoothGibsProvider,
  smoothGibsTile,
} from '../../maps/gibsSmoothing.js';

const TILE_RETRIES = 2;
const SHELL_LEVEL = 3;

export function createOceanProvider(
  cesium,
  product,
  date,
  document = globalThis.document,
) {
  const maxLevel = Number(product.matrixSet.match(/Level(\d+)$/)[1]);
  const provider = new cesium.UrlTemplateImageryProvider({
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
  // MUR25 is a 0.25° grid that GIBS draws as hard squares.
  return smoothGibsProvider(provider, {
    Resource: cesium.Resource,
    document,
    cellDegrees: 0.25,
    tileUrl: (z, x, y) => buildTileUrl({ ...product, date, z, x, y }),
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
      const provider = createOceanProvider(
        cesium,
        field.product,
        field.date,
        document,
      );
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
        // The raised shell takes one whole-globe image. Level 3 (2048 px
        // square) keeps its pixels finer than the 0.25° grid, and each tile
        // is smoothed with its neighbours like the globe path's tiles.
        const n = 2 ** SHELL_LEVEL;
        const size = n * 256;
        const tiles = await Promise.all(
          Array.from({ length: n * n }, async (_, index) => {
            const x = index % n;
            const y = Math.floor(index / n);
            // ImageryProvider image bitmaps are flipped for WebGL upload, not
            // for canvas mosaics. Request north-up source pixels explicitly.
            const url = buildTileUrl({
              ...field.product,
              date: field.date,
              z: SHELL_LEVEL,
              x,
              y,
            });
            // GIBS fails the odd tile with a 500: retry it, and leave a tile
            // that still fails transparent rather than losing the globe.
            for (let attempt = 0; attempt <= TILE_RETRIES; attempt++) {
              try {
                const image = await new cesium.Resource({ url }).fetchImage({
                  preferImageBitmap: false,
                  flipY: false,
                });
                if (!image) throw new Error('Ocean tile request deferred');
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 256;
                const context = canvas.getContext('2d', {
                  willReadFrequently: true,
                });
                context.drawImage(image, 0, 0);
                return context.getImageData(0, 0, 256, 256).data;
              } catch {
                if (attempt < TILE_RETRIES)
                  await new Promise((done) =>
                    setTimeout(done, 500 * (attempt + 1)),
                  );
              }
            }
            return null;
          }),
        );
        if (tiles.filter((tile) => !tile).length > (n * n) / 4)
          throw new Error('Ocean tiles unavailable');
        if (current !== generation) return;
        const mosaic = document.createElement('canvas');
        mosaic.width = mosaic.height = size;
        const context = mosaic.getContext('2d');
        const tileAt = (x, y) =>
          y < 0 || y >= n ? null : tiles[y * n + ((x + n) % n)];
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const rgba = smoothGibsTile(
              (dx, dy) => tileAt(x + dx, y + dy),
              SHELL_LEVEL,
              y,
              0.25,
            );
            if (!rgba) continue;
            const image = context.createImageData(256, 256);
            image.data.set(rgba);
            context.putImageData(image, x * 256, y * 256);
          }
        }
        // Mercator rows to equirectangular rows, one output row per sample.
        const texture = document.createElement('canvas');
        texture.width = size;
        texture.height = size / 2;
        const target = texture.getContext('2d');
        target.imageSmoothingEnabled = false;
        for (let row = 0; row < size / 2; row++) {
          const lat = 90 - ((row + 0.5) / (size / 2)) * 180;
          if (Math.abs(lat) > 85.0511287798066) continue;
          const sin = Math.sin((lat * Math.PI) / 180);
          const y = Math.floor(
            (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
          );
          target.drawImage(mosaic, 0, y, size, 1, 0, row, size, 1);
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
