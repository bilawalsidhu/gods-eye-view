import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Read only the local Chester County proxy; never send locations to a geocoder. */
export function createChesterCountyEmsSource({
  fetchImpl = globalThis.fetch,
  basePath = '/api/chester-county-ems',
} = {}) {
  return {
    async getIncidentDetails(id, { signal } = {}) {
      const deadline = AbortSignal.timeout(12000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const response = await fetchImpl(
        basePath + '/details?' + new URLSearchParams({ incident: id }),
        { signal: combined },
      );
      if (!response.ok) throw new Error('Incident details unavailable');
      const details = await readResponseJsonCapped(response, 128000, combined);
      if (
        (details?.id
          ? details.id !== id
          : details?.incidentNumber !== id.split(':').at(-1)) ||
        !Number.isFinite(details?.observedAt) ||
        !Array.isArray(details.units) ||
        details.units.length > 128 ||
        details.units.some(
          (unit) =>
            !['unit', 'status', 'entered'].every(
              (key) => typeof unit[key] === 'string' && unit[key].length <= 200,
            ),
        )
      )
        throw new Error('Invalid incident details');
      return details;
    },
    async getSnapshot({ signal } = {}) {
      const deadline = AbortSignal.timeout(45000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const response = await fetchImpl(basePath, {
        signal: combined,
      });
      if (!response.ok)
        throw new Error(
          basePath === '/api/chester-county-ems'
            ? 'Chester County incidents unavailable'
            : 'County incidents unavailable',
        );
      const snapshot = await readResponseJsonCapped(
        response,
        1024000,
        combined,
      );
      if (
        !Array.isArray(snapshot?.rows) ||
        snapshot.rows.length > 2000 ||
        !Number.isFinite(snapshot.observedAt) ||
        !Number.isFinite(snapshot.fetchedAt)
      )
        throw new Error('Invalid EMS snapshot');
      return snapshot;
    },
  };
}

/** Combined public county coverage through the same bounded source contract. */
export function createCountyEmsSource(options = {}) {
  return createChesterCountyEmsSource({
    ...options,
    basePath: '/api/county-ems',
  });
}
