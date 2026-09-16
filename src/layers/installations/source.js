import { normalizeMilitaryInstallations } from '../../data/militaryInstallationData.js';

/** Preserve legacy cache admission even when the explicit saturation flag is absent. */
export function installationResponseSaturated(payload) {
  if (typeof payload?.saturated === 'boolean') return payload.saturated;
  const cap = Number(payload?.elementCap);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return Array.isArray(payload?.elements) && payload.elements.length >= cap;
}

/** Read mapped installations and explicit nearby-place searches through fixed endpoints. */
export function createInstallationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getMappedSites(box, { exact = false, signal } = {}) {
      const { south, west, north, east } = box || {};
      if (
        ![south, west, north, east].every(Number.isFinite) ||
        south < -90 ||
        north > 90 ||
        west < -180 ||
        east > 180 ||
        north <= south ||
        east <= west ||
        north - south > 10 ||
        east - west > 10
      )
        throw new TypeError('A bounded installation viewport is required');
      signal?.throwIfAborted();
      const query = new URLSearchParams(
        Object.entries({ south, west, north, east }).map(([key, value]) => [
          key,
          value.toFixed(5),
        ]),
      );
      if (exact) query.set('exact', '1');
      const response = await fetchImpl(`/api/military-installations?${query}`, {
        signal,
      });
      const body = await response.json();
      signal?.throwIfAborted();
      if (!response.ok)
        throw Object.assign(
          new Error(body?.error || `Installation feed HTTP ${response.status}`),
          {
            failureReason: ['rate_limited', 'timeout', 'query_failed'].includes(
              body?.reason,
            )
              ? body.reason
              : 'unavailable',
          },
        );
      if (!Array.isArray(body?.elements))
        throw new Error('Malformed installation snapshot');
      return {
        ...normalizeMilitaryInstallations(
          body,
          body.retrievedAt || new Date().toISOString(),
        ),
        status: body.status,
        saturated: installationResponseSaturated(body),
      };
    },
    async searchNearby({ latitude, longitude, radiusM }, { signal } = {}) {
      if (
        ![latitude, longitude, radiusM].every(Number.isFinite) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180 ||
        radiusM < 1000 ||
        radiusM > 50000
      )
        throw new TypeError('Invalid nearby installation search');
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `/api/google/text-search?${new URLSearchParams({
          q: 'military installation',
          lat: latitude.toFixed(5),
          lon: longitude.toFixed(5),
          radiusM: String(radiusM),
        })}`,
        { signal },
      );
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!response.ok)
        throw new Error(
          payload?.error || `Google Places HTTP ${response.status}`,
        );
      if (!Array.isArray(payload?.places))
        throw new Error('Malformed nearby-place snapshot');
      return payload;
    },
  };
}
