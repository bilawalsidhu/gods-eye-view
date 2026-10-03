import { readResponseJsonCapped } from '../../sources/httpBody.js';

export const TIDE_RESPONSE_LIMIT = 256 * 1024;
const STATION_PATTERN = /^\d{7}$/;
const malformed = () => new Error('Malformed tide predictions');

/**
 * Validate the /api/tides payload into sorted turning points.
 * @returns {{stationId: string, turns: Array<{timeMs: number, height: number, type: 'H'|'L'}>}}
 */
export function normalizeTidePayload(payload, stationId) {
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    payload.station !== stationId ||
    !Array.isArray(payload.predictions) ||
    payload.predictions.length < 2 ||
    payload.predictions.length > 400
  )
    throw malformed();
  const turns = payload.predictions.map((row) => {
    const timeMs = Date.parse(row?.time);
    if (
      typeof row?.time !== 'string' ||
      !Number.isFinite(timeMs) ||
      !Number.isFinite(row.height) ||
      Math.abs(row.height) > 20 ||
      (row.type !== 'H' && row.type !== 'L')
    )
      throw malformed();
    return { timeMs, height: row.height, type: row.type };
  });
  for (let i = 1; i < turns.length; i++)
    if (turns[i].timeMs <= turns[i - 1].timeMs) throw malformed();
  return { stationId, turns };
}

/** Tide predictions through the local /api/tides proxy (NOAA CO-OPS). */
export function createNoaaTideSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getPredictions({ stationId, beginMs, endMs, signal } = {}) {
      if (!STATION_PATTERN.test(String(stationId)))
        throw new TypeError('A seven-digit NOAA station id is required');
      if (!Number.isFinite(beginMs) || !Number.isFinite(endMs) || endMs <= beginMs)
        throw new TypeError('A forward time window is required');
      signal?.throwIfAborted();
      const query = new URLSearchParams({
        station: stationId,
        begin: new Date(beginMs).toISOString(),
        end: new Date(endMs).toISOString(),
      });
      const response = await fetchImpl(`/api/tides?${query}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Tide proxy HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        TIDE_RESPONSE_LIMIT,
        signal,
      );
      signal?.throwIfAborted();
      return normalizeTidePayload(payload, stationId);
    },
  };
}
