import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Read only the local Chester County proxy; never send locations to a geocoder. */
export function createChesterCountyEmsSource({
  fetchImpl = globalThis.fetch,
} = {}) {
  return {
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
