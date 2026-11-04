import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  READING_MAX_AGE_MS,
  RIVER_LEVEL_PROVIDERS,
  STATION_ID_PATTERN,
  riverBandById,
} from './model.js';

const MIB = 1024 * 1024;
const finite = (value) => Number.isFinite(value);

/**
 * One server station → the record the layer draws, or null. Everything the
 * scene and the card read is checked here, so a malformed row is dropped
 * rather than drawn wrong.
 */
export function normalizeRiverStation(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id || '');
  if (!STATION_ID_PATTERN.test(id)) return null;
  const provider = id.split(':')[0];
  if (row.provider !== provider || !RIVER_LEVEL_PROVIDERS[provider])
    return null;
  if (!finite(row.lat) || !finite(row.lon) || Math.abs(row.lat) > 90)
    return null;
  if (!finite(row.level) || !finite(row.observedMs)) return null;
  if (now - row.observedMs > READING_MAX_AGE_MS) return null;
  const refs = {};
  for (const [key, value] of Object.entries(row.refs || {}))
    if (finite(value)) refs[key] = value;
  return {
    id,
    provider,
    code: typeof row.code === 'string' ? row.code : null,
    name: String(row.name || '').slice(0, 80) || id,
    nativeName: row.nativeName ? String(row.nativeName).slice(0, 80) : null,
    river: String(row.river || '').slice(0, 80),
    riverNative: row.riverNative ? String(row.riverNative).slice(0, 80) : null,
    lat: row.lat,
    lon: row.lon,
    level: row.level,
    observedMs: row.observedMs,
    refs,
    band: riverBandById(row.band).id,
    trend: finite(row.trend) ? row.trend : null,
  };
}

/** Same-origin river gauge routes (server/providers/riverLevels). */
export function createRiverLevelsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /**
   * @returns {Promise<{stations: object[], providers: object, fetchedAt: number|null}>}
   */
  async function getSnapshotDetail({ signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl('/api/river-levels', { signal });
    if (!response.ok) throw new Error(`River levels HTTP ${response.status}`);
    const payload = await readResponseJsonCapped(response, 16 * MIB, signal);
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.stations))
      throw new Error('Malformed river levels snapshot');
    const at = now();
    return {
      stations: payload.stations
        .map((row) => normalizeRiverStation(row, at))
        .filter(Boolean),
      providers:
        payload.providers && typeof payload.providers === 'object'
          ? payload.providers
          : {},
      fetchedAt: finite(payload.fetchedAt) ? payload.fetchedAt : null,
    };
  }

  return {
    async getSnapshot(options = {}) {
      return (await getSnapshotDetail(options)).stations;
    },
    getSnapshotDetail,
    /**
     * Recent readings of one gauge for its card.
     * @returns {Promise<{points: Array<[number, number]>, partial: boolean, trend: number|null}>}
     */
    async getStationSeries(id, { signal } = {}) {
      if (!STATION_ID_PATTERN.test(String(id)))
        throw new Error('Invalid station id');
      const [provider, code] = String(id).split(':');
      const response = await fetchImpl(
        `/api/river-levels/station/${provider}/${encodeURIComponent(code)}`,
        { signal },
      );
      if (!response.ok) throw new Error(`River series HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(response, 2 * MIB, signal);
      const points = Array.isArray(payload?.points)
        ? payload.points.filter(
            (p) => Array.isArray(p) && finite(p[0]) && finite(p[1]),
          )
        : [];
      return {
        points,
        partial: payload?.partial === true,
        trend: finite(payload?.trend) ? payload.trend : null,
      };
    },
  };
}
