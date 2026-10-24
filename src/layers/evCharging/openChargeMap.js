/** Re-ask a status that failed transiently no more than once a minute. */
const STATUS_RETRY_MS = 60_000;
const READ_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Name Open Charge Map in the fixed forms the layer row translates
 * (`translateFeedError`), never with transport or proxy text.
 * @param {number|null} status Proxy status, or null for a transport failure.
 * @param {object|null} body Proxy error body.
 */
function ocmFeedError(status, body) {
  const message =
    status === 429
      ? 'Open Charge Map rate limited'
      : status === null || status === 504 || body?.error === 'network'
        ? 'Open Charge Map network error'
        : body?.error === 'malformed'
          ? 'Malformed Open Charge Map response'
          : `Open Charge Map HTTP ${
              Number.isInteger(body?.upstreamStatus)
                ? body.upstreamStatus
                : status
            }`;
  return Object.assign(new Error(message), { status });
}

const finite = (value) => Number.isFinite(value);

/** A proxy site as the layer uses it, or null when it is not one. */
function readSite(site) {
  if (
    !Number.isInteger(site?.id) ||
    !finite(site.latitude) ||
    !finite(site.longitude) ||
    !Number.isInteger(site.provider?.id)
  )
    return null;
  return site;
}

/**
 * The browser side of `/api/ocm` (server/providers/openChargeMap.js). It asks
 * the local server whether a key is configured and reads licence-filtered
 * sites for one box; the key never reaches the browser.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] Injected fetch, for tests.
 * @param {() => number} [options.now] Clock, for tests.
 */
export function createOpenChargeMapClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {?boolean} A definitive answer, kept for the session. */
  let configured = null;
  let retryAt = 0;

  return {
    /**
     * Whether the server has an Open Charge Map key. A host without the
     * route (a static build answers 404) is "no"; a transient failure is "no"
     * for now and asked again later. Never throws except on abort.
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<boolean>}
     */
    async isConfigured({ signal } = {}) {
      if (configured !== null) return configured;
      if (now() < retryAt) return false;
      try {
        const timeout = AbortSignal.timeout(8000);
        const response = await fetchImpl('/api/ocm/status', {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.status === 404) {
          configured = false;
          return false;
        }
        if (!response.ok) throw new Error('status');
        const body = await response.json();
        if (typeof body?.hasKey !== 'boolean') throw new Error('status');
        configured = body.hasKey;
        return configured;
      } catch (error) {
        if (signal?.aborted) throw error;
        retryAt = now() + STATUS_RETRY_MS;
        return false;
      }
    },

    /**
     * Sites inside `box`. Rejects with a fixed-form error on failure.
     * @param {{south:number, west:number, north:number, east:number}} box
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{sites: Array<object>, saturated: boolean,
     *   stale: boolean}>}
     */
    async getSites(box, { signal } = {}) {
      const params = new URLSearchParams(
        ['south', 'west', 'north', 'east'].map((name) => [
          name,
          box[name].toFixed(5),
        ]),
      );
      const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
      let response;
      try {
        response = await fetchImpl(`/api/ocm/poi?${params}`, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw ocmFeedError(null, null);
      }
      if (response.status === 503) {
        // The key went away (POWER UP cleared it): stop asking this session.
        const body = await response.json().catch(() => null);
        if (body?.error === 'no_key') {
          configured = false;
          return { sites: [], saturated: false, stale: false, unkeyed: true };
        }
        throw ocmFeedError(503, body);
      }
      let body = null;
      try {
        const declared = Number(response.headers?.get?.('content-length'));
        if (finite(declared) && declared > MAX_BODY_BYTES) throw new Error();
        body = await response.json();
      } catch (error) {
        if (signal?.aborted) throw error;
        throw ocmFeedError(response.ok ? 502 : response.status, {
          error: response.ok ? 'malformed' : null,
        });
      }
      signal?.throwIfAborted();
      if (!response.ok) throw ocmFeedError(response.status, body);
      if (!Array.isArray(body?.sites))
        throw ocmFeedError(502, { error: 'malformed' });
      return {
        sites: body.sites
          .map(readSite)
          .filter(Boolean)
          .filter(
            (site) =>
              site.latitude >= box.south &&
              site.latitude <= box.north &&
              site.longitude >= box.west &&
              site.longitude <= box.east,
          ),
        saturated: body.saturated === true,
        stale: body.stale === true,
      };
    },
  };
}
