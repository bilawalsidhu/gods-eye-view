import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Validate the bounded same-origin OVATION forecast snapshot. */
export function validateAuroraSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || value.product !== 'ovation-aurora')
    throw new Error('Malformed aurora forecast');
  if (value.unavailable) {
    if (value.stale !== true || typeof value.reason !== 'string')
      throw new Error('Malformed aurora forecast');
    return value;
  }
  const grid = value.grid;
  if (
    !Number.isFinite(Date.parse(value.forecastTime)) ||
    new Date(value.forecastTime).toISOString() !== value.forecastTime ||
    !Number.isFinite(Date.parse(value.observationTime)) ||
    new Date(value.observationTime).toISOString() !== value.observationTime ||
    !Array.isArray(value.coordinateOrder) ||
    value.coordinateOrder.join(',') !== 'longitude,latitude,probability' ||
    grid?.nx !== 360 ||
    grid?.ny !== 181 ||
    grid?.lo1 !== 0 ||
    grid?.la1 !== -90 ||
    grid?.dx !== 1 ||
    grid?.dy !== 1 ||
    !Array.isArray(value.probabilities) ||
    (value.stale !== false && value.stale !== true) ||
    value.unavailable !== false ||
    value.horizonMinutes?.min !== 30 ||
    value.horizonMinutes?.max !== 90 ||
    value.horizonMinutes?.variable !== true ||
    value.probabilities.length !== grid.nx * grid.ny ||
    value.probabilities.some(
      (probability) =>
        !Number.isFinite(probability) || probability < 0 || probability > 100,
    )
  )
    throw new Error('Malformed aurora forecast');
  return value;
}

export function createAuroraSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Aurora request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/aurora/forecast', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        const body = await readResponseJsonCapped(
          response,
          1_000_000,
          controller.signal,
        );
        if (!response.ok && !body?.unavailable)
          throw new Error(`Aurora HTTP ${response.status}`);
        return validateAuroraSnapshot(body);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
