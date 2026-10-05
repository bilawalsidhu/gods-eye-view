import { isUnavailableCapability } from '../sources/capability.js';
import { createOverpassFeatureSource } from '../sources/overpassFeatures.js';
/** Parse bounded retry information from a service response. */
function retryAfterMs(value) {
  if (value == null || String(value).trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Construct independent request services for compatible application protocols. */
export function createApplicationRequestServices({
  fetchImpl = (...args) => fetch(...args),
  signal: lifetime,
  endpoints = {},
  features,
  boundaryProbe = { timeoutMs: 3000, retryMs: 30_000 },
} = {}) {
  const urls = {
    boundaries: '/api/overpass',
    terrain: '/api/terrain/heights',
    regional: '/api/regional-brief',
    weather: '/api/weather-effects',
    summary: '/api/openai/hud-summary',
    ...endpoints,
  };
  async function request(endpoint, { signal, ...init } = {}) {
    signal = AbortSignal.any([lifetime, signal].filter(Boolean));
    signal.throwIfAborted();
    const response = await fetchImpl(endpoint, {
      ...init,
      signal,
      redirect: 'error',
    });
    signal.throwIfAborted();
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* Status remains authoritative for non-JSON errors. */
    }
    signal.throwIfAborted();
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      data,
    };
  }
  function pointUrl(endpoint, latitude, longitude) {
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    )
      throw new TypeError('Valid coordinates are required');
    return `${endpoint}?${new URLSearchParams({ latitude: latitude.toFixed(5), longitude: longitude.toFixed(5) })}`;
  }
  function requireOk(response, label) {
    if (!response.ok)
      throw new Error(`${label} unavailable (${response.status})`);
    return response.data;
  }
  // Learn once per page whether the server has an Overpass instance, so an
  // unconfigured server is never asked (and never answers with an error).
  // Discovery is bounded; a failed or timed-out probe is forgotten and not
  // retried for a short backoff, during which queries go to the server as
  // they would against an older server without the probe.
  let boundaryCapability = null;
  let boundaryProbeRetryAt = 0;
  function boundariesConfigured() {
    if (boundaryCapability) return boundaryCapability;
    if (Date.now() < boundaryProbeRetryAt) return Promise.resolve(null);
    boundaryCapability = request(`${urls.boundaries}/status`, {
      signal: AbortSignal.timeout(boundaryProbe.timeoutMs),
    }).then(
      (response) =>
        response.ok && typeof response.data?.configured === 'boolean'
          ? response.data.configured
          : null, // an older server: fall back to asking per query
      (error) => {
        boundaryCapability = null;
        if (lifetime?.aborted) throw error;
        boundaryProbeRetryAt = Date.now() + boundaryProbe.retryMs;
        return null;
      },
    );
    return boundaryCapability;
  }
  /** Wait for a shared promise, but give up when this caller's signal aborts. */
  function untilAborted(promise, signal) {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  }
  const services = {
    boundaries: {
      async query(query, { signal } = {}) {
        if ((await untilAborted(boundariesConfigured(), signal)) === false) {
          signal?.throwIfAborted();
          return {
            unavailable: true,
            code: 'OVERPASS_NOT_CONFIGURED',
            retryable: false,
          };
        }
        const response = await request(urls.boundaries, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (isUnavailableCapability(response.data))
          return {
            unavailable: true,
            code: 'OVERPASS_NOT_CONFIGURED',
            retryable: false,
          };
        const retry = response.headers?.get?.('Retry-After');
        if (
          response.status === 406 ||
          response.status === 429 ||
          (response.status === 503 && retry != null)
        )
          return { rateLimited: true, retryAfterMs: retryAfterMs(retry) };
        if (!response.ok) return null;
        const remark = String(response.data?.remark || '').toLowerCase();
        if (/runtime error|timed out|out of memory/.test(remark)) return null;
        return Array.isArray(response.data?.elements)
          ? response.data.elements
          : null;
      },
    },
    terrain: {
      async getHeights(points, { signal } = {}) {
        const query = points
          .map(({ lat, lon }) => `${lon.toFixed(5)},${lat.toFixed(5)}`)
          .join(';');
        return requireOk(
          await request(`${urls.terrain}?points=${encodeURIComponent(query)}`, {
            signal,
          }),
          'Terrain heights',
        )?.results;
      },
    },
    regional: {
      async getBrief(latitude, longitude, options) {
        return requireOk(
          await request(pointUrl(urls.regional, latitude, longitude), options),
          'Regional brief',
        );
      },
    },
    weather: {
      async getConditions(latitude, longitude, options) {
        return requireOk(
          await request(pointUrl(urls.weather, latitude, longitude), options),
          'Weather',
        );
      },
    },
    summary: {
      async summarize(context, { signal } = {}) {
        return request(urls.summary, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(context),
        });
      },
    },
  };
  services.features =
    features ??
    createOverpassFeatureSource({
      boundarySource: services.boundaries,
      signal: lifetime,
    });
  return services;
}
