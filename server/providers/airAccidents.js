import {
  WIKIDATA_PLACED_QUERY,
  WIKIDATA_QUERY,
  mergeAirAccidentRecords,
  normalizeWikidataResults,
} from '../../src/layers/airAccidents/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

const MIB = 1024 * 1024;
/** Wikidata changes daily at most. */
const REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failed refresh keeps serving the last snapshot this long, marked stale. */
const STALE_MAX_MS = 7 * REFRESH_MS;
const sparqlUrl = (query) =>
  'https://query.wikidata.org/sparql?format=json&query=' +
  encodeURIComponent(query);
// Wikimedia asks automated clients to name themselves.
const USER_AGENT =
  "God's Eye View air-accidents layer (https://github.com/bilawalsidhu/gods-eye-view)";

/** Fixed-origin, cached Wikidata accident snapshot for dev and preview. */
export function airAccidentsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let snapshot = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function query(text) {
    // The query service stops a query at 60 s.
    const signal = AbortSignal.timeout(75_000);
    const response = await fetchImpl(sparqlUrl(text), {
      signal,
      redirect: 'error',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const payload = await readResponseJsonCapped(response, 32 * MIB, signal);
    if (!Array.isArray(payload?.results?.bindings))
      throw new Error('invalid_wikidata_results');
    return payload;
  }

  /**
   * A query that runs past the service's 60 s limit comes back as a 200 whose
   * JSON is cut off by a stack trace, and the edge cache keeps that answer for
   * five minutes. Ask once more with a comment that changes the URL, so the
   * retry reaches the query service instead of the cached failure.
   */
  async function queryWithRetry(text) {
    try {
      return await query(text);
    } catch {
      return query(`${text}
# retry ${now()}`);
    }
  }

  /**
   * The accidents with their own coordinates are required; the ones placed
   * at their location item are added when that query answers.
   */
  async function load() {
    const [own, placed] = await Promise.allSettled([
      queryWithRetry(WIKIDATA_QUERY),
      queryWithRetry(WIKIDATA_PLACED_QUERY),
    ]);
    if (own.status === 'rejected') throw own.reason;
    const records = normalizeWikidataResults(own.value);
    if (!records.length) throw new Error('invalid_wikidata_results');
    return {
      fetchedAt: now(),
      complete: placed.status === 'fulfilled',
      records: mergeAirAccidentRecords(
        records,
        placed.status === 'fulfilled'
          ? normalizeWikidataResults(placed.value, { approximate: true })
          : [],
      ),
    };
  }

  async function acquire() {
    if (snapshot && now() - snapshot.fetchedAt < REFRESH_MS)
      return { value: snapshot, stale: false };
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'snapshot', load);
      snapshot = await promise;
      return { value: snapshot, stale: false };
    } catch (error) {
      if (snapshot && now() - snapshot.fetchedAt <= STALE_MAX_MS)
        return { value: snapshot, stale: true };
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
      // Empty fields are left out to keep the snapshot small.
      res.end(
        JSON.stringify(value, (_key, item) =>
          item === null ? undefined : item,
        ),
      );
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    try {
      const { value, stale } = await acquire();
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch {
      json(502, { error: 'air_accidents_unavailable' });
    }
  }

  return {
    name: 'air-accidents',
    configureServer({ middlewares }) {
      middlewares.use('/api/air-accidents', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/air-accidents', handler);
    },
  };
}
