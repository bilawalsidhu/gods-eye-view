import {
  weatherPixelSize,
  drawWeatherPixels,
  closeWeatherPixels,
} from './source.js';

/** Tile a bounded decoded canvas without network requests or scene state. */
export function createRasterTileProvider({
  cesium,
  texture,
  credit,
  createCanvas,
  rectangle = cesium.Rectangle.MAX_VALUE,
  tilingScheme = new cesium.GeographicTilingScheme({ rectangle }),
  maximumLevel = 2,
  tileSize = 256,
}) {
  return {
    tilingScheme,
    rectangle,
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    tileDiscardPolicy: undefined,
    credit,
    errorEvent: new cesium.Event(),
    hasAlphaChannel: true,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    requestImage(x, y, level) {
      const tile = createCanvas();
      tile.width = tile.height = tileSize;
      const ctx = tile.getContext('2d');
      const width =
        texture.width / tilingScheme.getNumberOfXTilesAtLevel(level);
      const height =
        texture.height / tilingScheme.getNumberOfYTilesAtLevel(level);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        texture,
        x * width,
        y * height,
        width,
        height,
        0,
        0,
        tileSize,
        tileSize,
      );
      // ImageryLayer consumes requestImage results as promises.
      return Promise.resolve(tile);
    },
  };
}

/**
 * Tile one product time from a host frame source. Every resolved tile is a
 * canvas: supplied pixels are drawn into a new one and released, and a null
 * tile is one shared transparent canvas. Beyond `maxConcurrent` tiles in
 * flight requestImage returns undefined, Cesium's signal to ask again later. A
 * failed tile rejects, which Cesium reports through errorEvent. Aborting
 * `signal` cancels every tile in flight.
 */
export function createFrameTileProvider({
  cesium,
  frameSource,
  product,
  time,
  tilingScheme,
  rectangle = cesium.Rectangle.MAX_VALUE,
  maximumLevel,
  credit,
  createCanvas,
  tileSize = 256,
  maxConcurrent = 6,
  signal,
}) {
  let inFlight = 0;
  let empty = null;
  const canvas = () => {
    const tile = createCanvas();
    tile.width = tile.height = tileSize;
    return tile;
  };
  async function load(x, y, level, request) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      const pixels = await frameSource.getTile({
        product,
        time,
        z: level,
        x,
        y,
        size: tileSize,
        signal: controller.signal,
      });
      if (pixels === null) {
        controller.signal.throwIfAborted();
        return (empty ??= canvas());
      }
      try {
        controller.signal.throwIfAborted();
        const { width, height } = weatherPixelSize(pixels);
        if (width !== tileSize || height !== tileSize)
          throw new Error('Invalid weather tile dimensions');
        const tile = canvas();
        drawWeatherPixels(tile.getContext('2d'), pixels);
        return tile;
      } finally {
        closeWeatherPixels(pixels);
      }
    } catch (error) {
      // A cancelled tile is unloaded, not failed, so Cesium may ask again.
      if (controller.signal.aborted && request && cesium.RequestState)
        request.state = cesium.RequestState.CANCELLED;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    tilingScheme,
    rectangle,
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    tileDiscardPolicy: undefined,
    credit,
    errorEvent: new cesium.Event(),
    hasAlphaChannel: true,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    requestImage(x, y, level, request) {
      if (inFlight >= maxConcurrent) return undefined;
      inFlight++;
      return load(x, y, level, request).finally(() => {
        inFlight--;
      });
    },
  };
}
