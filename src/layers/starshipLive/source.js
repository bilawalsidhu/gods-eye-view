import { readResponseJsonCapped } from '../../sources/httpBody.js';

const RESPONSE_LIMIT = 256 * 1024;
const malformed = () => new Error('Malformed Starship telemetry snapshot');

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Validate and retain only the bounded Starship telemetry contract. */
export function validateStarshipLiveSnapshot(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.source !== 'string' ||
    !Number.isFinite(value.fetchedAt) ||
    typeof value.active !== 'boolean' ||
    !Array.isArray(value.vehicles) ||
    value.vehicles.length > 2
  )
    throw malformed();

  const vehicles = value.vehicles.map((vehicle) => {
    if (
      typeof vehicle?.id !== 'string' ||
      !vehicle.id ||
      typeof vehicle.name !== 'string' ||
      !vehicle.name
    )
      throw malformed();
    const lat = finite(vehicle.lat);
    const lon = finite(vehicle.lon);
    const alt = finite(vehicle.alt);
    const speed = finite(vehicle.speed);
    const heading = finite(vehicle.heading);
    const positionAt = finite(vehicle.positionAt);
    if (
      lat === null ||
      lat < -90 ||
      lat > 90 ||
      lon === null ||
      lon < -180 ||
      lon > 180 ||
      alt === null ||
      alt < -1000 ||
      alt > 1_000_000 ||
      speed === null ||
      speed < 0 ||
      heading === null ||
      heading < 0 ||
      heading >= 360 ||
      positionAt === null
    )
      throw malformed();
    return {
      id: vehicle.id,
      name: vehicle.name,
      lat,
      lon,
      alt,
      speed,
      heading,
      positionAt,
    };
  });

  return {
    schemaVersion: 1,
    source: value.source,
    fetchedAt: value.fetchedAt,
    active: value.active,
    vehicles,
    status:
      value.status === null || value.status === undefined
        ? null
        : {
            connected: value.status.connected === true,
            t0: finite(value.status.t0),
            serverTime: finite(value.status.serverTime),
          },
  };
}

/** Same-origin Starship telemetry source with deadline and cancellation. */
export function createStarshipLiveSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 10_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () =>
          controller.abort(new Error('Starship telemetry request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/starship-live', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Starship telemetry HTTP ${response.status}`);
        }
        const payload = await readResponseJsonCapped(
          response,
          RESPONSE_LIMIT,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return validateStarshipLiveSnapshot(payload);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
