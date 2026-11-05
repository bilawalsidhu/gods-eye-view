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
/** A failed refresh keeps serving the last snapshot this long, marked stale. */
const STALE_MAX_MS = 7 * REFRESH_MS;
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
    return normalizeWikidataResults(await upstreamJson(WIKIDATA_URL, 16 * MIB));
  }

  /** One source failing still serves the other; both failing is an error. */
  async function load() {
    const [emodnet, wikidata] = await Promise.allSettled([
      fetchEmodnet(),
      fetchWikidata(),
    ]);
    if (emodnet.status === 'rejected' && wikidata.status === 'rejected')
      throw new Error('shipwrecks_unavailable');
    const records = mergeShipwreckRecords(
      emodnet.status === 'fulfilled' ? emodnet.value : [],
      wikidata.status === 'fulfilled' ? wikidata.value : [],
    );
    return {
      fetchedAt: now(),
      sources: {
        emodnet: emodnet.status === 'fulfilled',
        wikidata: wikidata.status === 'fulfilled',
      },
      records,
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
