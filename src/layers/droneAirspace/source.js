import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request a normalized snapshot through the bounded, same-origin FAA proxy. */
export function createDroneAirspaceSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /**
   * The rows with how fresh they are: the proxy answers from its last
   * snapshot, marked stale, while the FAA service is unreachable.
   * @returns {Promise<{rows: object[], stale: boolean, fetchedAt: number|null}>}
   */
  async function getSnapshotDetail({ signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl('/api/drone-airspace', { signal });
    if (!response.ok) throw new Error(`FAA SUA HTTP ${response.status}`);
    const payload = await readResponseJsonCapped(
      response,
      80 * 1024 * 1024,
      signal,
    );
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.rows))
      throw new Error('Malformed drone airspace snapshot');
    return {
      rows: payload.rows,
      stale: payload.stale === true,
      fetchedAt: Number.isFinite(payload.fetchedAt) ? payload.fetchedAt : null,
    };
  }

  return {
    /** The zone rows (see getSnapshotDetail for staleness). */
    async getSnapshot(options = {}) {
      return (await getSnapshotDetail(options)).rows;
    },
    getSnapshotDetail,
  };
}
