import { withBase } from '../../services/apiBase.js';
import { readResponseJsonCapped } from '../../sources/httpBody.js';

export const WEATHER_PRODUCTS = Object.freeze([
  'radar',
  'clouds',
  'clouds-regional',
  'lightning',
]);

/** Only bounded, explicit observations may become imagery requests. */
export function validateWeatherSnapshot(value, product) {
  if (!value || value.schemaVersion !== 1 || value.product !== product)
    throw new Error('Malformed weather manifest');
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
    throw new Error('Malformed weather manifest');
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
  return `${withBase('/api/weather/image')}?product=${product}&time=${encodeURIComponent(time)}${box}${size}`;
}

export function weatherTileUrl(product, time, { size } = {}) {
  if (!WEATHER_PRODUCTS.includes(product) || !Number.isFinite(Date.parse(time)))
    throw new Error('Invalid weather frame');
  if (size !== undefined && ![256, 512, 1024].includes(size))
    throw new Error('Invalid weather tile size');
  // Construct locally; never accept a manifest-provided host or template.
  return `${withBase('/api/weather/tile')}?product=${product}&time=${encodeURIComponent(time)}&z={z}&x={x}&y={y}${size === undefined ? '' : `&size=${size}`}`;
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
        () => controller.abort(new Error('Weather request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(
          `${withBase('/api/weather/manifest')}?product=${product}`,
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
  };
}
