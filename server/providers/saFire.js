import {
  normalizeSaIncidents,
  normalizeSaWarnings,
} from '../../src/layers/saFire/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const USER_AGENT =
  'gods-eye-view-sa-fire-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

// South Australian Country Fire Service / Metropolitan Fire Service current
// incidents (ESO public JSON, keyless). The retired CRIIMSON XML URLs now
// answer HTTP 200 with an HTML "File Unavailable" page, so a 200 alone proves
// nothing: the content type must be JSON and the payload shape is checked
// below.
const INCIDENTS_URL =
  'https://data.eso.sa.gov.au/feeds/prod/cfs_current_incidents.json';

// CFS public warnings (ArcGIS Feature Service): layer 0 points, layer 1 polygons.
const WARNINGS_SERVICE =
  'https://cfs.geohub.sa.gov.au/server/rest/services/CFS_Warnings_Read/' +
  'SACFS_Warnings_Public/FeatureServer';
const WARNINGS_QUERY = 'where=1%3D1&outFields=*&outSR=4326&f=geojson';
const MAX_WARNING_PAGES = 3;

const MIB = 1024 * 1024;
const INCIDENTS_TTL_MS = 60_000;
const WARNINGS_TTL_MS = 120_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const MAX_RETRY_AFTER_MS = 15 * 60_000;

const JSON_TYPE = /^application\/(?:[\w.+-]*\+)?json\b/i;

const warningsUrl = (layer, offset) =>
  `${WARNINGS_SERVICE}/${layer}/query?${WARNINGS_QUERY}${
    offset ? `&resultOffset=${offset}` : ''
  }`;

/** Retry-After as milliseconds (delta-seconds or HTTP date), capped; null when absent. */
function retryAfterMs(response, nowMs) {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  const delta = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - nowMs;
  return Number.isFinite(delta)
    ? Math.min(Math.max(delta, 0), MAX_RETRY_AFTER_MS)
    : null;
}

/**
 * Fixed-origin, bounded South Australian fire incident and warning route for
 * dev and preview. Each upstream keeps its own cache and last good snapshot.
 */
export function saFireProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });
  const states = {
    incidents: makeState(INCIDENTS_TTL_MS),
    warnings: makeState(WARNINGS_TTL_MS),
  };

  function makeState(ttl) {
    return { ttl, value: null, savedAt: 0, failures: 0, nextAttemptAt: 0 };
  }

  /** GET a fixed URL and return its capped, parsed JSON (plus the response), or throw. */
  async function upstreamJson(url, cap, timeout) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      const error = new Error('upstream_unavailable');
      if (response.status === 429)
        error.retryAfterMs = retryAfterMs(response, now()) ?? MAX_BACKOFF_MS;
      await response.body?.cancel();
      throw error;
    }
    if (!JSON_TYPE.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new Error('unexpected_content_type');
    }
    const payload = await readResponseJsonCapped(response, cap, signal);
    return { payload, response };
  }

  async function fetchIncidents() {
    const { payload, response } = await upstreamJson(
      INCIDENTS_URL,
      MIB,
      15_000,
    );
    const rows = normalizeSaIncidents(payload);
    if (!rows) throw new Error('invalid_snapshot');
    const modified = Date.parse(response.headers.get('last-modified') || '');
    return {
      rows,
      fetchedAt: now(),
      modified: Number.isFinite(modified) ? modified : null,
    };
  }

  /** Read one ArcGIS layer, following exceededTransferLimit; incomplete data is a failure. */
  async function fetchLayer(layer) {
    const features = [];
    for (let page = 0; page < MAX_WARNING_PAGES; page++) {
      const { payload } = await upstreamJson(
        warningsUrl(layer, features.length),
        8 * MIB,
        20_000,
      );
      // ArcGIS reports errors as HTTP 200 with an {error} body.
      if (!Array.isArray(payload?.features)) throw new Error('invalid_layer');
      features.push(...payload.features);
      const more =
        payload.exceededTransferLimit === true ||
        payload.properties?.exceededTransferLimit === true;
      if (!more || !payload.features.length)
        return { type: 'FeatureCollection', features };
    }
    throw new Error('incomplete_layer');
  }

  async function fetchWarnings() {
    const [points, polygons] = await Promise.all([
      fetchLayer(0),
      fetchLayer(1),
    ]);
    const fetchedAt = now();
    const rows = normalizeSaWarnings({ points, polygons }, fetchedAt);
    if (!rows) throw new Error('invalid_snapshot');
    return { rows, fetchedAt };
  }

  /**
   * Serve the fresh value inside its TTL; otherwise refresh, and on failure
   * fall back to the last good value. A failed upstream is not retried before
   * its backoff expires (at least one TTL, doubling per consecutive failure).
   */
  async function acquire(key, load) {
    const state = states[key];
    const t = now();
    if (state.value && t - state.savedAt < state.ttl)
      return { value: state.value, stale: false };
    if (t < state.nextAttemptAt) {
      if (state.value) return { value: state.value, stale: true };
      throw new Error('backing_off');
    }
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        try {
          const value = await load();
          state.value = value;
          state.savedAt = now();
          state.failures = 0;
          state.nextAttemptAt = 0;
          return value;
        } catch (error) {
          state.failures++;
          const backoff = Math.min(
            state.ttl * 2 ** (state.failures - 1),
            MAX_BACKOFF_MS,
          );
          state.nextAttemptAt =
            now() + Math.max(backoff, error?.retryAfterMs ?? 0);
          throw error;
        }
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (state.value) return { value: state.value, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const [incidents, warnings] = await Promise.allSettled([
      acquire('incidents', fetchIncidents),
      acquire('warnings', fetchWarnings),
    ]);
    // Warnings are secondary; incidents that have never loaded are an outage.
    if (incidents.status !== 'fulfilled')
      return json(502, { error: 'sa_fire_unavailable' });
    const nowMs = now();
    const warningRows =
      warnings.status === 'fulfilled'
        ? warnings.value.value.rows.filter(
            (row) => row.expiryTime == null || row.expiryTime >= nowMs,
          )
        : [];
    const stale =
      incidents.value.stale ||
      (warnings.status === 'fulfilled' && warnings.value.stale);
    json(
      200,
      {
        incidents: incidents.value.value.rows,
        warnings: warningRows,
        warningsAvailable: warnings.status === 'fulfilled',
        incidentsFetchedAt: incidents.value.value.fetchedAt,
        warningsFetchedAt:
          warnings.status === 'fulfilled'
            ? warnings.value.value.fetchedAt
            : null,
        upstreamModified: incidents.value.value.modified,
        stale,
      },
      stale,
    );
  }

  return {
    name: 'sa-fire',
    configureServer({ middlewares }) {
      middlewares.use('/api/sa-fire', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sa-fire', handler);
    },
  };
}
