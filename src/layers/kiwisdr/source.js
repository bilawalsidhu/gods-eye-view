import { KIWISDR_MAX_STATIONS } from '../../sources/kiwisdr.js';

const ENDPOINT = '/api/kiwisdr';

function validStation(row) {
  return (
    row &&
    typeof row === 'object' &&
    typeof row.id === 'string' &&
    typeof row.name === 'string' &&
    typeof row.host === 'string' &&
    Number.isFinite(row.lat) &&
    Math.abs(row.lat) <= 90 &&
    Number.isFinite(row.lon) &&
    Math.abs(row.lon) <= 180 &&
    Number.isInteger(row.port) &&
    row.port > 0 &&
    row.port < 65536 &&
    Number.isInteger(row.users) &&
    Number.isInteger(row.usersMax) &&
    row.usersMax > 0
  );
}

/** Fetch the proxied receiver directory; the browser never contacts the upstream list itself. */
export function createKiwiSdrSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getDirectory({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(ENDPOINT, { signal });
      if (!response.ok) {
        // The proxy says why in a short code (e.g. kiwisdr_fetch_failed).
        const detail = await response
          .json()
          .then((body) => String(body?.reason || ''))
          .catch(() => '');
        throw new Error(
          `KiwiSDR directory returned ${response.status}${/^kiwisdr_[a-z0-9_]+$/.test(detail) ? ` (${detail})` : ''}`,
        );
      }
      const body = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(body?.stations))
        throw new Error('Malformed KiwiSDR directory');
      const stations = body.stations
        .filter(validStation)
        .slice(0, KIWISDR_MAX_STATIONS);
      if (!stations.length) throw new Error('KiwiSDR directory was empty');
      return { fetchedAt: body.fetchedAt ?? null, stations };
    },
  };
}
