import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { ALPINE_NETWORK_IDS } from './networks.js';
import { alpineStationRecord } from './records.js';

/**
 * Read the merged Alpine station snapshot from the same-origin proxy.
 *
 * The proxy has already joined and validated every network, so this re-runs
 * the record validator rather than a second parser: the browser must not be
 * the only thing standing between a malformed payload and the renderer, and
 * `alpineStationRecord` is the same gate the proxy used.
 *
 * A station that fails validation is dropped individually. The envelope is
 * rejected only when it is not an envelope at all, because one bad record must
 * never blank the layer: a failed first update makes the lifecycle disable it.
 */

/** Ceiling on the merged payload. Measured at ~240 KB for ~650 stations. */
export const ALPINE_RESPONSE_LIMIT = 8 * 1024 * 1024;

const malformed = () => new Error('Malformed Alpine station snapshot');

function networkState(raw) {
  if (!raw || typeof raw !== 'object') throw malformed();
  if (!ALPINE_NETWORK_IDS.includes(raw.id)) throw malformed();
  if (!['ok', 'stale', 'unavailable'].includes(raw.status)) throw malformed();
  return {
    id: raw.id,
    label: typeof raw.label === 'string' ? raw.label : raw.id,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    country: typeof raw.country === 'string' ? raw.country : '',
    attribution: typeof raw.attribution === 'string' ? raw.attribution : '',
    licence: typeof raw.licence === 'string' ? raw.licence : '',
    licenceUrl: typeof raw.licenceUrl === 'string' ? raw.licenceUrl : '',
    homepage: typeof raw.homepage === 'string' ? raw.homepage : '',
    parameters: Array.isArray(raw.parameters)
      ? raw.parameters.filter((id) => typeof id === 'string')
      : [],
    cadenceMinutes: Number.isFinite(raw.cadenceMinutes)
      ? raw.cadenceMinutes
      : null,
    status: raw.status,
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
    stationCount: Number.isFinite(raw.stationCount) ? raw.stationCount : 0,
  };
}

/** Normalize the proxy envelope, dropping individually unusable stations. */
export function readAlpineSnapshot(payload) {
  if (!payload || typeof payload !== 'object') throw malformed();
  if (!Array.isArray(payload.stations) || !Array.isArray(payload.networks))
    throw malformed();
  const stations = [];
  for (const raw of payload.stations) {
    const record = alpineStationRecord(raw);
    if (record) stations.push(record);
  }
  return {
    stations,
    networks: payload.networks.map(networkState),
    attribution:
      typeof payload.attribution === 'string' ? payload.attribution : '',
    fetchedAt: typeof payload.fetchedAt === 'string' ? payload.fetchedAt : null,
    stale: payload.stale === true,
    unavailable: payload.unavailable === true,
    reason: typeof payload.reason === 'string' ? payload.reason : null,
  };
}

/** Request a merged snapshot through the bounded, same-origin proxy. */
export function createAlpineStationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/alpine-stations', { signal });
      if (!response.ok)
        throw new Error(`Alpine stations HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        ALPINE_RESPONSE_LIMIT,
        signal,
      );
      signal?.throwIfAborted();
      return readAlpineSnapshot(payload);
    },
  };
}
