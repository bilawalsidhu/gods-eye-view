import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeRiverGaugeSnapshot } from './records.js';
import { msg } from '../../i18n/marker.js';

/**
 * The national snapshot is built on the server from seven sequential NWPS
 * reads; the first build took 83 s live, so the wait leaves room for a slow day.
 */
const SNAPSHOT_TIMEOUT_MS = 240_000;
const DETAIL_TIMEOUT_MS = 20_000;
/** About 13,000 trimmed gauges are ~3.5 MB of JSON before gzip. */
const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const DETAIL_MAX_BYTES = 256 * 1024;

/**
 * Name a failure in the fixed forms the layer row translates
 * (`translateFeedError`), never with raw transport or parser text.
 */
function feedError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const message = status
    ? `NWPS HTTP ${status}`
    : error?.name === 'TimeoutError' || error instanceof TypeError
      ? 'NWPS network error'
      : 'Malformed NWPS response';
  return Object.assign(new Error(message, { cause: error }), { status });
}

/**
 * Read river gauges from the same-origin NWPS proxy (`/api/nwps/*`). The
 * browser never calls NWPS directly: a national read is too slow for it.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] Injected fetch, for tests.
 * @returns {{getSnapshot: Function, getGauge: Function, label: string}}
 */
export function createRiverGaugeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function getJson(url, maxBytes, timeoutMs, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(url, {
        signal: combined,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        void response.body?.cancel?.().catch(() => {});
        throw Object.assign(new Error('upstream status'), {
          status: response.status,
        });
      }
      return await readResponseJsonCapped(response, maxBytes, combined);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw feedError(error);
    }
  }

  return {
    /**
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{gauges: Array<object>, generatedAt: string|null,
     *   stale: boolean, failedRegions: number}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const payload = await getJson(
        '/api/nwps/gauges',
        SNAPSHOT_MAX_BYTES,
        SNAPSHOT_TIMEOUT_MS,
        signal,
      );
      const snapshot = normalizeRiverGaugeSnapshot(payload);
      if (!snapshot) throw new Error('Malformed NWPS response');
      return snapshot;
    },

    /**
     * Flood stages, crests and the USGS id of one gauge.
     * @param {string} lid NWS location id.
     * @param {{signal?: AbortSignal}} [options]
     */
    async getGauge(lid, { signal } = {}) {
      if (!/^[A-Z]{4}[0-9]$/.test(String(lid)))
        throw new TypeError('Invalid gauge id');
      const payload = await getJson(
        `/api/nwps/gauge/${lid}`,
        DETAIL_MAX_BYTES,
        DETAIL_TIMEOUT_MS,
        signal,
      );
      if (payload?.lid !== lid) throw new Error('Malformed NWPS response');
      return payload;
    },

    label: msg('NOAA NWPS · OBSERVED'),
  };
}
