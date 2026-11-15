import { readResponseJsonCapped } from '../../sources/httpBody.js';

// Shared with the AI tools, so no i18n import: failures stay English here and
// the weather layer translates them where it shows them (t / translateKnown).
const msg = (text) => text;

const WEATHER_PRODUCTS = Object.freeze([
  'radar',
  'clouds',
  'clouds-regional',
  'lightning',
]);

/** Only bounded, explicit observations may become imagery requests. */
export function validateWeatherSnapshot(value, product) {
  if (!value || value.schemaVersion !== 1 || value.product !== product)
    throw new Error(msg('Malformed weather manifest'));
  if (value.unavailable) return value;
  const { bounds, times } = value;
  if (
    !bounds ||
    !['west', 'south', 'east', 'north'].every((key) =>
      Number.isFinite(bounds[key]),
    ) ||
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north ||
    !Array.isArray(times) ||
    times.length < 1 ||
    times.length > 13 ||
    times.some(
      (time, i) =>
        typeof time !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) ||
        !Number.isFinite(Date.parse(time)) ||
        new Date(time).toISOString() !== time ||
        (i > 0 && time <= times[i - 1]),
    ) ||
    value.latest !== times.at(-1) ||
    value.tileSize !== 256 ||
    value.maxLevel !== 6 ||
    value.tilingScheme !== 'geographic'
  )
    throw new Error(msg('Malformed weather manifest'));
  return value;
}

/** Largest whole-extent image per product; also the proxy default size. */
export const WEATHER_IMAGE_SIZES = Object.freeze({
  radar: Object.freeze({ width: 4096, height: 2048 }),
  'clouds-regional': Object.freeze({ width: 4096, height: 2048 }),
  clouds: Object.freeze({ width: 2048, height: 1024 }),
  lightning: Object.freeze({ width: 4096, height: 2048 }),
});
/** Largest detail-window image for every product; also the proxy default. */
export const WEATHER_DETAIL_SIZE = Object.freeze({ width: 4096, height: 2048 });

/** A whole-extent image, or with `bbox` ({ west, south, east, north } degrees)
 * a detail window of the same product. */
export function weatherImageUrl(
  product,
  time,
  { width, height } = {},
  bbox = null,
) {
  if (!WEATHER_PRODUCTS.includes(product) || !Number.isFinite(Date.parse(time)))
    throw new Error('Invalid weather frame');
  let box = '';
  if (bbox !== null) {
    const edges = [bbox.west, bbox.south, bbox.east, bbox.north];
    if (
      !edges.every(Number.isFinite) ||
      edges[0] >= edges[2] ||
      edges[1] >= edges[3]
    )
      throw new Error('Invalid weather window');
    box = `&bbox=${edges.join(',')}`;
  }
  const largest =
    bbox === null ? WEATHER_IMAGE_SIZES[product] : WEATHER_DETAIL_SIZE;
  let size = '';
  if (width !== undefined || height !== undefined) {
    if (
      ![1024, 2048, 4096].includes(width) ||
      height !== width / 2 ||
      width > largest.width
    )
      throw new Error('Invalid weather image size');
    // The largest size is the proxy default: one frame has one URL.
    if (width !== largest.width) size = `&size=${width}x${height}`;
  }
  return `/api/weather/image?product=${product}&time=${encodeURIComponent(time)}${box}${size}`;
}

export function weatherTileUrl(product, time, { size } = {}) {
  if (!WEATHER_PRODUCTS.includes(product) || !Number.isFinite(Date.parse(time)))
    throw new Error('Invalid weather frame');
  if (size !== undefined && ![256, 512, 1024].includes(size))
    throw new Error('Invalid weather tile size');
  // Construct locally; never accept a manifest-provided host or template.
  return `/api/weather/tile?product=${product}&time=${encodeURIComponent(time)}&z={z}&x={x}&y={y}${size === undefined ? '' : `&size=${size}`}`;
}

/**
 * Decoded pixels a host hands the weather layer. The layer takes ownership:
 * it draws them once and closes a VideoFrame or ImageBitmap afterwards, so a
 * host returns a fresh object for every call.
 * @typedef {ImageBitmap|ImageData|HTMLCanvasElement|OffscreenCanvas|VideoFrame} WeatherPixels
 */

/**
 * A weather feed may also be a frame source: a host can supply decoded frames
 * in place of the bounded image and tile routes. Both methods are optional and
 * independent; a product or path without one keeps the routes.
 *
 * `getFrameImage` returns one image exactly `size` pixels, covering the
 * product's whole extent, or with `bbox` ({ west, south, east, north }
 * degrees) a detail window of it. `getFrameTile` returns one `size`-pixel tile
 * of the geographic tiling scheme, or null for a transparent tile. Rows run
 * top-down (north first), as an image does. Both honour `signal`.
 * @typedef {object} WeatherFrameFeed
 * @property {(request: { product: string, time: string,
 *   size: { width: number, height: number },
 *   bbox: { west: number, south: number, east: number, north: number } | null,
 *   signal: AbortSignal }) => Promise<WeatherPixels>} [getFrameImage]
 * @property {(request: { product: string, time: string, z: number, x: number,
 *   y: number, size: number, signal: AbortSignal })
 *   => Promise<WeatherPixels | null>} [getFrameTile]
 */

/**
 * The frame source a feed provides, or null when it has neither method. A
 * missing method is left undefined, so that path keeps the routes.
 * @param {WeatherFrameFeed | undefined} feed
 * @returns {{ getImage?: Function, getTile?: Function } | null}
 */
export function weatherFrameSource(feed) {
  const image = typeof feed?.getFrameImage === 'function';
  const tile = typeof feed?.getFrameTile === 'function';
  if (!image && !tile) return null;
  return {
    getImage: image
      ? ({ product, time, size, bbox = null, signal }) =>
          feed.getFrameImage({ product, time, size, bbox, signal })
      : undefined,
    getTile: tile
      ? ({ product, time, z, x, y, size, signal }) =>
          feed.getFrameTile({ product, time, z, x, y, size, signal })
      : undefined,
  };
}

/** Width and height of supplied pixels; a VideoFrame draws at its display size. */
export function weatherPixelSize(pixels) {
  return {
    width: pixels?.displayWidth ?? pixels?.width,
    height: pixels?.displayHeight ?? pixels?.height,
  };
}

/** Draw supplied pixels at the canvas origin, at their own size. */
export function drawWeatherPixels(context, pixels) {
  if (typeof ImageData !== 'undefined' && pixels instanceof ImageData)
    context.putImageData(pixels, 0, 0);
  else context.drawImage(pixels, 0, 0);
}

/** Release supplied pixels that hold decoder or GPU memory. */
export function closeWeatherPixels(pixels) {
  if (typeof pixels?.close === 'function') pixels.close();
}

/** Acquisition is lazy and shares the application's existing source contract. */
export function createWeatherSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ product = 'radar', signal } = {}) {
      if (!WEATHER_PRODUCTS.includes(product))
        throw new Error('Unknown weather product');
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(msg('Weather request timed out'))),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(
          `/api/weather/manifest?product=${product}`,
          { signal: controller.signal, cache: 'no-store', redirect: 'error' },
        );
        if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
        return validateWeatherSnapshot(
          await readResponseJsonCapped(response, 16_384, controller.signal),
          product,
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
    /** Read one image frame through the bounded image route. */
    async getImage({ product, time, size, bbox = null, signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        weatherImageUrl(product, time, size, bbox),
        { signal, redirect: 'error' },
      );
      if (!response.ok)
        throw new Error(`Weather image HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      const type = response.headers.get('content-type') || '';
      return { contentType: type.split(';')[0].trim().toLowerCase(), bytes };
    },
  };
}
