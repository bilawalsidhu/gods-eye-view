import { readResponseTextCapped } from '../common/http.js';
import { normalizeIodaSnapshot } from '../../../src/layers/cyber/ioda.js';

const IODA_EVENTS_URL =
  'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events';
const IODA_TTL_MS = 5 * 60_000;
const IODA_MAX_STALE_MS = 6 * 60 * 60_000;
const IODA_TIMEOUT_MS = 12_000;
const IODA_RESPONSE_LIMIT = 256 * 1024;
const IODA_EVENT_LIMIT = 250;
const IODA_WINDOW_SECONDS = 24 * 60 * 60;

function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

/** Public, keyless IODA outage-event client with a bounded server-side cache. */
export function createIodaProvider({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const cache = { entry: null, pending: null };

  async function fetchSnapshot(signal) {
    const end = Math.floor(now() / 1000);
    const url = new URL(IODA_EVENTS_URL);
    url.search = new URLSearchParams({
      from: String(end - IODA_WINDOW_SECONDS),
      until: String(end),
      entityType: 'country',
      limit: String(IODA_EVENT_LIMIT),
      extendWindow: '0',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IODA_TIMEOUT_MS);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Gods Eye View (IODA connectivity events)',
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) throw failure('rate_limited', 429);
        throw failure('upstream_unavailable');
      }
      const body = await readResponseTextCapped(
        response,
        IODA_RESPONSE_LIMIT,
        controller.signal,
      );
      signal?.throwIfAborted();
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw failure('invalid_provider_data');
      }
      if (payload?.error || !Array.isArray(payload?.data))
        throw failure('invalid_provider_data');
      const fetchedAt = new Date(now()).toISOString();
      const snapshot = normalizeIodaSnapshot({
        provider: 'ioda',
        fetchedAt,
        events: payload.data,
      });
      if (payload.data.length > 0 && snapshot.events.length === 0)
        throw failure('invalid_provider_data');
      return { value: snapshot, fetchedAt: now() };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || new Error('cancelled');
      if (error?.code) throw error;
      throw failure('upstream_unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function requestSnapshot({ signal, force = false } = {}) {
    if (!force && cache.entry && now() - cache.entry.fetchedAt < IODA_TTL_MS)
      return cache.entry;
    if (cache.pending) return cache.pending;
    const operation = (async () => {
      try {
        const entry = await fetchSnapshot(signal);
        cache.entry = entry;
        return entry;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (cache.entry && now() - cache.entry.fetchedAt <= IODA_MAX_STALE_MS)
          return {
            ...cache.entry,
            value: { ...cache.entry.value, stale: true },
          };
        throw error;
      } finally {
        cache.pending = null;
      }
    })();
    cache.pending = operation;
    return operation;
  }

  return Object.freeze({ requestSnapshot });
}
