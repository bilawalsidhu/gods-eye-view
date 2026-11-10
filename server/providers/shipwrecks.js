import {
  EMODNET_WFS_URL,
  WIKIDATA_QUERY,
  mergeShipwreckRecords,
  normalizeEmodnetFeatures,
  normalizeWikidataResults,
} from '../../src/layers/shipwrecks/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

const MIB = 1024 * 1024;
/** EMODnet republishes the wreck layer about once a year; Wikidata daily at most. */
const REFRESH_MS = 24 * 60 * 60 * 1000;
/** A source's last good records keep being served this long, marked stale. */
const STALE_MAX_MS = 7 * REFRESH_MS;
/** After a source fails, it is not asked again for this long. */
const RETRY_MS = 15 * 60 * 1000;
/** A refresh with fewer than this share of the last good records is refused. */
const MIN_KEEP_RATIO = 0.5;
// Only the columns the card uses; ship_char/obj_desc histories can name people
// and are not read beyond a short vessel type.
const EMODNET_PROPERTIES = [
  'source_id',
  'country',
  'name',
  'least_depth',
  'depth_prec',
  'loc_prec',
  'sink_context',
  'sink_yr',
  'dating',
  'period',
  'statutory',
  'ship_char',
  'obj_type',
  'artefacts',
  'source_inf',
  'website1',
  'point_info',
  'the_geom',
].join(',');
const EMODNET_URL = `${EMODNET_WFS_URL}&propertyName=${EMODNET_PROPERTIES}`;
const WIKIDATA_URL =
  'https://query.wikidata.org/sparql?format=json&query=' +
  encodeURIComponent(WIKIDATA_QUERY);
// Wikimedia asks automated clients to name themselves.
const USER_AGENT =
  "God's Eye View shipwrecks layer (https://github.com/bilawalsidhu/gods-eye-view)";

/** Fixed-origin, cached EMODnet + Wikidata shipwreck snapshot for dev and preview. */
export function shipwrecksProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  // Each source keeps its last good records on its own, so one failing (or
  // answering with nothing usable) never removes the other's wrecks or its
  // own earlier ones. `retryAt` holds a failed source back for RETRY_MS.
  const sources = {
    emodnet: { load: fetchEmodnet, good: null, retryAt: 0 },
    wikidata: { load: fetchWikidata, good: null, retryAt: 0 },
  };
  let snapshot = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function upstreamJson(url, maxBytes) {
    const signal = AbortSignal.timeout(90_000);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, maxBytes, signal);
  }

  async function fetchEmodnet() {
    const records = normalizeEmodnetFeatures(
      await upstreamJson(EMODNET_URL, 32 * MIB),
    );
    if (!records.length) throw new Error('invalid_emodnet_layer');
    return records;
  }

  async function fetchWikidata() {
    const payload = await upstreamJson(WIKIDATA_URL, 16 * MIB);
    if (!Array.isArray(payload?.results?.bindings))
      throw new Error('invalid_wikidata_results');
    const records = normalizeWikidataResults(payload);
    // Wikidata lists over a thousand wrecks; none at all is a broken answer.
    if (!records.length) throw new Error('invalid_wikidata_results');
    return records;
  }

  const fresh = (state, at) =>
    state.good !== null && at - state.good.fetchedAt < REFRESH_MS;
  const usable = (state, at) =>
    state.good !== null && at - state.good.fetchedAt <= STALE_MAX_MS;
  const due = (state, at) => !fresh(state, at) && at >= state.retryAt;

  /** Refresh the sources that are due; failures keep their last good records. */
  async function refresh() {
    const at = now();
    const names = Object.keys(sources).filter((name) => due(sources[name], at));
    const results = await Promise.allSettled(
      names.map((name) => sources[name].load()),
    );
    const done = now();
    results.forEach((result, i) => {
      const state = sources[names[i]];
      // A valid answer far smaller than the last good set (a truncated or
      // half-built upstream) is a failure too, until the old set expires.
      const shrunk =
        result.status === 'fulfilled' &&
        usable(state, done) &&
        result.value.length < state.good.records.length * MIN_KEEP_RATIO;
      if (result.status === 'fulfilled' && !shrunk)
        state.good = { records: result.value, fetchedAt: done };
      else state.retryAt = done + RETRY_MS;
      if (shrunk)
        console.warn(
          `[shipwrecks] ${names[i]} refresh refused: ${result.value.length} ` +
            `records against ${state.good.records.length} last good`,
        );
    });
  }

  /** The served snapshot: every source with usable records, merged once. */
  function compose(at) {
    const sourceFlags = {};
    // How old each source's records are, on this clock, so the page can
    // expire them by its own clock without comparing the two.
    const ages = {};
    let stale = false;
    let fetchedAt = null;
    for (const [name, state] of Object.entries(sources)) {
      sourceFlags[name] = usable(state, at);
      ages[name] = sourceFlags[name] ? at - state.good.fetchedAt : null;
      if (!sourceFlags[name]) continue;
      if (!fresh(state, at)) stale = true;
      fetchedAt = Math.min(fetchedAt ?? Infinity, state.good.fetchedAt);
    }
    if (!sourceFlags.emodnet && !sourceFlags.wikidata) return null;
    const key = `${sourceFlags.emodnet && sources.emodnet.good.fetchedAt}:${
      sourceFlags.wikidata && sources.wikidata.good.fetchedAt
    }`;
    if (snapshot?.key !== key) {
      // The merge writes EMODnet facts into Wikidata records: work on copies
      // so a source's kept records stay as fetched.
      const copy = (name) =>
        sourceFlags[name]
          ? sources[name].good.records.map((record) => ({ ...record }))
          : [];
      snapshot = {
        key,
        records: mergeShipwreckRecords(copy('emodnet'), copy('wikidata')),
      };
    }
    return {
      value: {
        fetchedAt,
        version: key,
        sources: sourceFlags,
        ages,
        maxAgeMs: STALE_MAX_MS,
        records: snapshot.records,
      },
      stale,
    };
  }

  async function acquire() {
    const at = now();
    if (Object.values(sources).some((state) => due(state, at)))
      await coalesceProxyRequest(inFlight, 'refresh', refresh).promise;
    const composed = compose(now());
    if (!composed) throw new Error('shipwrecks_unavailable');
    return composed;
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
    try {
      const { value, stale } = await acquire();
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch {
      json(502, { error: 'shipwrecks_unavailable' });
    }
  }

  return {
    name: 'shipwrecks',
    configureServer({ middlewares }) {
      middlewares.use('/api/shipwrecks', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/shipwrecks', handler);
    },
  };
}
