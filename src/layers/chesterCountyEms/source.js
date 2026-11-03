import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Read only the local Chester County proxy; never send locations to a geocoder. */
export function createChesterCountyEmsSource({
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
    async getIncidentDetails(id, { signal } = {}) {
      const deadline = AbortSignal.timeout(12000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const response = await fetchImpl(
        '/api/chester-county-ems/details?' +
          new URLSearchParams({ incident: id }),
        { signal: combined },
      );
      if (!response.ok) throw new Error('Incident details unavailable');
      const details = await readResponseJsonCapped(response, 128000, combined);
      if (
        details?.incidentNumber !== id.split(':').at(-1) ||
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
      const response = await fetchImpl('/api/chester-county-ems', {
        signal: combined,
      });
      if (!response.ok) throw new Error('Chester County incidents unavailable');
      const snapshot = await readResponseJsonCapped(
        response,
        1024000,
        combined,
      );
      if (
        !Array.isArray(snapshot?.rows) ||
        snapshot.rows.length > 500 ||
        !Number.isFinite(snapshot.observedAt) ||
        !Number.isFinite(snapshot.fetchedAt)
      )
        throw new Error('Invalid EMS snapshot');
      return snapshot;
    },
  };
}
