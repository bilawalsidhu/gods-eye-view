import { lookupStop, parseColormap } from './colormap.js';
import { TILE_PIXELS, locateTilePixel, metresPerPixel } from './tiles.js';
import {
  COLORMAP_URL,
  GIBS_LAYER,
  GIBS_MAX_LEVEL,
  GIBS_TILE_MATRIX_SET,
  SAMPLE_TILE_CACHE_MAX,
} from './policy.js';

/** @param {string} date Frame time key. @param {object} at Tile location. @returns {string} Tile URL. */
export function sampleTileUrl(date, { level, tileX, tileY }) {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_LAYER}/default/${date}/${GIBS_TILE_MATRIX_SET}/${level}/${tileY}/${tileX}.png`;
}

/**
 * Read one tile pixel by drawing the tile to an offscreen canvas.
 *
 * Reads the TILE, not the Cesium canvas. The rendered globe has the overlay
 * composited at whatever opacity the operator chose, over a basemap, under
 * lighting and a post-process shader — sampling that would measure the
 * screenshot, not the data. The tile is the product as published, and GIBS
 * sends `Access-Control-Allow-Origin: *` on tiles it has, so `crossOrigin`
 * makes the canvas readable instead of tainted.
 * @param {string} url Tile URL.
 * @param {{signal?:AbortSignal}} options Cancellation.
 * @returns {Promise<?ImageData>} Tile pixels, or null when the tile is absent.
 */
function loadTilePixels(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      image.onload = null;
      image.onerror = null;
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onAbort = () =>
      finish(
        Object.assign(new Error('Temperature sample aborted'), {
          name: 'AbortError',
        }),
      );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    image.onerror = () => finish(null);
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = TILE_PIXELS;
        canvas.height = TILE_PIXELS;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          finish(null);
          return;
        }
        // Nearest-neighbour: smoothing would blend neighbouring palette
        // entries into colours the colour map never produced, and the reverse
        // lookup would then report a temperature that was never measured.
        context.imageSmoothingEnabled = false;
        context.drawImage(image, 0, 0, TILE_PIXELS, TILE_PIXELS);
        finish(context.getImageData(0, 0, TILE_PIXELS, TILE_PIXELS));
      } catch (error) {
        // A tainted canvas throws here; report it as unsampleable rather than
        // failing the click.
        finish(null);
      }
    };
    image.src = url;
  });
}

/**
 * Point sampler for the rendered monthly frames.
 *
 * Holds the parsed colour map and a small tile cache, because a run of clicks
 * in one area hits the same tile and re-fetching it per click would be both
 * slow and rude to the service.
 * @param {{fetchImpl?:Function, loadPixels?:Function}} options Injected transport.
 * @returns {{sample:Function, reset:Function}} Sampler.
 */
export function createTemperatureSampler({
  fetchImpl = (...args) => globalThis.fetch(...args),
  loadPixels = loadTilePixels,
} = {}) {
  let stops = null;
  let colormapPromise = null;
  const tiles = new Map();

  async function ensureColormap(signal) {
    if (stops) return stops;
    if (!colormapPromise) {
      colormapPromise = (async () => {
        const response = await fetchImpl(COLORMAP_URL, { signal });
        if (!response.ok) throw new Error(`Colour map HTTP ${response.status}`);
        const parsed = parseColormap(await response.text());
        if (!parsed.length) throw new Error('Colour map contained no stops');
        return parsed;
      })().catch((error) => {
        // Let the next click retry rather than caching the failure forever.
        colormapPromise = null;
        throw error;
      });
    }
    stops = await colormapPromise;
    return stops;
  }

  async function tilePixels(url, signal) {
    if (tiles.has(url)) return tiles.get(url);
    const pixels = await loadPixels(url, { signal });
    if (tiles.size >= SAMPLE_TILE_CACHE_MAX) {
      const oldest = tiles.keys().next().value;
      if (oldest !== undefined) tiles.delete(oldest);
    }
    tiles.set(url, pixels);
    return pixels;
  }

  return {
    /**
     * Sample a monthly frame at a geographic point.
     * @param {{latitude:number, longitude:number, date:string, signal?:AbortSignal}} request Point and frame.
     * @returns {Promise<object>} Sample outcome.
     */
    async sample({ latitude, longitude, date, signal }) {
      const at = locateTilePixel(latitude, longitude, GIBS_MAX_LEVEL);
      if (!at) return { outcome: 'outside-projection' };
      const colormap = await ensureColormap(signal);
      signal?.throwIfAborted();
      const pixels = await tilePixels(sampleTileUrl(date, at), signal);
      signal?.throwIfAborted();
      if (!pixels) return { outcome: 'no-tile' };
      const index = (at.pixelY * TILE_PIXELS + at.pixelX) * 4;
      const stop = lookupStop(colormap, {
        r: pixels.data[index],
        g: pixels.data[index + 1],
        b: pixels.data[index + 2],
        a: pixels.data[index + 3],
      });
      return {
        outcome: stop ? 'measured' : 'no-value',
        stop,
        latitude,
        longitude,
        resolutionM: metresPerPixel(latitude, GIBS_MAX_LEVEL),
      };
    },

    /** Drop cached tiles; they are date-keyed by URL but the cache is bounded. */
    reset() {
      tiles.clear();
    },
  };
}
