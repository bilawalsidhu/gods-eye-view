import { readResponseJsonCapped } from '../../sources/httpBody.js';

export const WEATHER_PRODUCTS = Object.freeze([
  'radar',
  'clouds',
  'clouds-regional',
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

export function weatherImageUrl(time) {
  if (!Number.isFinite(Date.parse(time)))
    throw new Error('Invalid weather frame');
  return `/api/weather/image?product=clouds&time=${encodeURIComponent(time)}`;
}

export function weatherTileUrl(product, time) {
  if (!WEATHER_PRODUCTS.includes(product) || !Number.isFinite(Date.parse(time)))
    throw new Error('Invalid weather frame');
  // Construct locally; never accept a manifest-provided host or template.
  return `/api/weather/tile?product=${product}&time=${encodeURIComponent(time)}&z={z}&x={x}&y={y}`;
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
  };
}
