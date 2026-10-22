import { msg } from '../../i18n/marker.js';
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

const malformed = () => new Error(msg('Malformed Alpine station snapshot'));

/**
 * Which network this is, and whether it answered.
 *
 * Nothing else: every other property of a network is identity, and identity
 * lives in ALPINE_NETWORKS, which this module's callers already import. A
 * second copy arriving over the wire could only ever disagree with it.
 */
function networkState(raw) {
  if (!raw || typeof raw !== 'object') throw malformed();
  if (!ALPINE_NETWORK_IDS.includes(raw.id)) throw malformed();
  if (!['ok', 'stale', 'unavailable'].includes(raw.status)) throw malformed();
  return { id: raw.id, status: raw.status };
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
