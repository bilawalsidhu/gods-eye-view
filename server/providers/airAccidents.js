import {
  CENIPA_BASE_URL,
  WIKIDATA_QUERY,
  mergeAirAccidentRecords,
  normalizeCenipaTables,
  normalizeWikidataResults,
  parseSemicolonCsv,
} from '../../src/layers/airAccidents/records.js';
import {
  coalesceProxyRequest,
  readResponseBytesCapped,
  readResponseJsonCapped,
} from './common/http.js';
import { createNtsbStore } from './airAccidentsNtsb.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

const MIB = 1024 * 1024;
/**
 * CENIPA republishes a few times a year, NTSB weekly; Wikidata changes daily
 * at most.
 */
const REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failed refresh keeps serving the last snapshot this long, marked stale. */
const STALE_MAX_MS = 7 * REFRESH_MS;
const CENIPA_TABLES = Object.freeze({
  occurrences: 'ocorrencia.csv',
  aircraft: 'aeronave.csv',
  types: 'ocorrencia_tipo.csv',
});
const WIKIDATA_URL =
  'https://query.wikidata.org/sparql?format=json&query=' +
  encodeURIComponent(WIKIDATA_QUERY);
// Wikimedia asks automated clients to name themselves.
const USER_AGENT =
  "God's Eye View air-accidents layer (https://github.com/bilawalsidhu/gods-eye-view)";

/** Fixed-origin, cached CENIPA + NTSB + Wikidata accident snapshot for dev and preview. */
export function airAccidentsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  createNtsb = createNtsbStore,
} = {}) {
  let snapshot = null;
  // Set when the NTSB store finishes its first build, so the next request
  // rebuilds the snapshot instead of waiting for the daily refresh.
  let dirty = false;
  const ntsbStore = createNtsb({
    fetchImpl,
    now,
    userAgent: USER_AGENT,
    onChange: () => {
      dirty = true;
    },
  });
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });

  async function upstream(url, timeout) {
    const signal = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return { response, signal };
  }

  async function fetchCenipa() {
    // The tables are Latin-1 (Windows-1252), as the dados.gov.br page says.
    const decoder = new TextDecoder('windows-1252');
    const tables = {};
    for (const [key, file] of Object.entries(CENIPA_TABLES)) {
      const { response, signal } = await upstream(
        `${CENIPA_BASE_URL}${file}`,
        60_000,
      );
      const bytes = await readResponseBytesCapped(response, 32 * MIB, signal);
      tables[key] = parseSemicolonCsv(decoder.decode(bytes));
    }
    const records = normalizeCenipaTables(tables);
    if (!records.length) throw new Error('invalid_cenipa_tables');
    return records;
  }

  async function fetchWikidata() {
    const { response, signal } = await upstream(WIKIDATA_URL, 60_000);
    return normalizeWikidataResults(
      await readResponseJsonCapped(response, 16 * MIB, signal),
    );
  }

  /** One source failing still serves the other; both failing is an error. */
  async function load() {
    const [cenipa, wikidata, us] = await Promise.allSettled([
      fetchCenipa(),
      fetchWikidata(),
      ntsbStore.records(),
    ]);
    const usRecords = us.status === 'fulfilled' ? us.value : null;
    if (
      cenipa.status === 'rejected' &&
      wikidata.status === 'rejected' &&
      !usRecords
    )
      throw new Error('air_accidents_unavailable');
    const records = mergeAirAccidentRecords(
      [
        ...(cenipa.status === 'fulfilled' ? cenipa.value : []),
        ...(usRecords || []),
      ],
      wikidata.status === 'fulfilled' ? wikidata.value : [],
    );
    return {
      fetchedAt: now(),
      sources: {
        cenipa: cenipa.status === 'fulfilled',
        wikidata: wikidata.status === 'fulfilled',
        // null while the first NTSB build is still running.
        ntsb: usRecords ? true : null,
      },
      records,
    };
  }

  async function acquire() {
    if (snapshot && !dirty && now() - snapshot.fetchedAt < REFRESH_MS)
      return { value: snapshot, stale: false };
    try {
      dirty = false;
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
      // Empty fields are left out: with tens of thousands of records, the
      // nulls alone would add megabytes.
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
