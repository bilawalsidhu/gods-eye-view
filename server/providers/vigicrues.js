/**
 * Vigicrues proxy — France's flood-warning network: river sensors and
 * flood-warning zones.
 *
 * Upstream: the open Vigicrues REST service on www.vigicrues.gouv.fr. No key,
 * no registration.
 *
 * Three feeds are combined:
 *   /services/observations.json                  -> the sensor catalogue: every
 *                                                 station id with its latest
 *                                                 observation time
 *   /services/station.json?CdStationHydro=...   -> one station: Lambert-93
 *                                                 coordinates, river, vigilance
 *   /services/InfoVigiCru.geojson               -> the flood-warning zone
 *                                                 geometry
 *
 * WHY THE COORDINATES ARE CONVERTED HERE: the station feed publishes
 * `CoordStationHydro.CoordXStationHydro` / `CoordYStationHydro` in
 * Lambert-93 metres (EPSG:2154). The globe needs degrees, and no projection
 * library ships with this app, so the inverse projection lives in
 * `src/sources/lambert93.js` and is applied at the proxy boundary - the
 * browser never sees projected coordinates.
 *
 * WHY THE SWEEP IS INCREMENTAL: no single upstream document carries every
 * station's position. `station.json?format=geojson` lists all 2 376 stations
 * but WITHOUT coordinates, and `observations.json?CdStationHydro=` answers a
 * station's WHOLE history (about 315 kB), not one reading. The only source
 * of positions is the per-station detail document, and the operator answers
 * HTTP 429 after roughly 30 rapid requests. So the proxy keeps a persistent
 * station cache and hydrates a BOUNDED BATCH per request, paced to stay
 * under the operator's throttle. The layer states the coverage it actually
 * has rather than pretending the whole network is loaded.
 *
 * Routes (the browser names a route, never a URL):
 *   GET /api/vigicrues/stations   -> station list with converted positions
 *   GET /api/vigicrues/zones      -> flood warning zone geometry
 */

import {
  createOpenDataService,
  openDataRedirectDecision,
} from '../../src/sources/openDataProxy.js';
import { readResponseJsonCapped } from '../../src/sources/httpBody.js';
import { lambert93ToLonLat } from '../../src/sources/lambert93.js';

const SERVICE_BASE = 'https://www.vigicrues.gouv.fr/services';

/*
 * The station detail endpoint 302s to /services/station.json/index.php.
 * Asking for the final URL directly saves a round trip on every station.
 */
export const STATION_DETAIL_URL = SERVICE_BASE + '/station.json/index.php';
/** The station catalogue: ids plus each station's latest observation time. */
export const STATION_LIST_URL = SERVICE_BASE + '/observations.json';
/** The flood-warning zone geometry. The .json variant of this file is 404. */
export const ZONES_URL = SERVICE_BASE + '/InfoVigiCru.geojson';
/** The station catalogue changes on the order of days, not minutes. */
export const STATION_TTL_MS = 6 * 3600_000;
/** Max same-origin redirects followed for one upstream read. */
export const VIGICRUES_MAX_REDIRECTS = 3;
/** The upstream answers HTTP 429 after roughly 30 rapid requests. */
export const STATION_SWEEP_DELAY_MS = 400;
/** How many consecutive 429s end a sweep instead of waiting it out. */
export const STATION_MAX_THROTTLE = 3;
/**
 * How many stations ONE request may hydrate. At the paced delay this is a
 * short, bounded burst; the cache keeps what it learned, so the coverage
 * grows across refreshes without any single request taking minutes.
 */
export const STATION_BATCH_SIZE = 60;
/** The zone geometry is one 2.2 MB document; cap it explicitly. */
export const MAX_ZONE_BYTES = 8 * 1024 * 1024;
/** The station catalogue document is about 140 kB; cap it explicitly. */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
/**
 * Parse one station detail payload into a station row.
 * @param {object} raw Station payload.
 * @returns {object|null} Normalized station, or null without coordinates.
 */
export function normalizeVigicruesStation(raw) {
  const id = String(raw?.CdStationHydro ?? '').trim();
  if (!id) return null;
  const position = lambert93ToLonLat(
    raw?.CoordStationHydro?.CoordXStationHydro,
    raw?.CoordStationHydro?.CoordYStationHydro,
  );
  if (!position) return null;
  const vigilance = raw?.VigilanceCrues ?? {};
  const bulletin = vigilance?.PereBoitEntVigiCru ?? null;
  return {
    id,
    name: String(raw?.LbStationHydro ?? '').trim() || null,
    river: String(raw?.LbCoursEau ?? '').trim() || null,
    commune: String(raw?.CdCommune ?? '').trim() || null,
    lon: position.lon,
    lat: position.lat,
    hasBulletin: Boolean(bulletin),
    bulletinId: bulletin?.CdEntVigiCru ?? null,
    photo: vigilance?.Photo ?? null,
  };
}

/**
 * Parse the station catalogue into the list of station ids and the newest
 * observation time across them.
 *
 * @param {object} payload observations.json payload.
 * @returns {{ids: string[], observedAt: number|null, total: number}}
 */
export function normalizeVigicruesStationList(payload) {
  const stations = payload?.Observations?.ListeStation;
  const total = Number(payload?.NbElements);
  if (!Array.isArray(stations))
    return {
      ids: [],
      observedAt: null,
      total: Number.isFinite(total) ? total : 0,
    };
  const ids = [];
  let observedAt = null;
  for (const entry of stations) {
    const id = String(entry?.CdStationHydro ?? '').trim();
    if (!id) continue;
    ids.push(id);
    const at = Number(entry?.DtObsHydro);
    if (Number.isFinite(at) && (observedAt === null || at > observedAt)) {
      observedAt = at;
    }
  }
  return {
    ids,
    observedAt,
    total: Number.isFinite(total) ? total : ids.length,
  };
}

/**
 * Reduce the warning-zone GeoJSON to the features worth drawing.
 *
 * @param {object} payload InfoVigiCru.geojson payload.
 * @returns {{zones: object[], bbox: number[]|null}}
 */
export function normalizeVigicruesZones(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const zones = [];
  for (const feature of features) {
    const properties = feature?.properties ?? {};
    const id = String(properties.id ?? properties.CdEntCru ?? '').trim();
    if (!id) continue;
    zones.push({
      id,
      label: String(properties.lbentcru ?? '').trim() || null,
      territory: String(properties.CdTCC ?? '').trim() || null,
      level: Number.isFinite(Number(properties.NivInfViCr))
        ? Number(properties.NivInfViCr)
        : null,
      geometry: feature?.geometry ?? null,
    });
  }
  const bbox = Array.isArray(payload?.bbox) ? payload.bbox : null;
  return { zones, bbox };
}

/** Pause between upstream station requests so the operator does not throttle us. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The persistent station cache: what the proxy has learned so far.
 *
 * It lives inside the service instance (never a module global), so two
 * services in one process do not share state and the cache dies with the
 * service.
 */
function createStationCache() {
  /** @type {Map<string, object>} */
  const stations = new Map();
  /** Station ids already attempted, so a failed one is not retried forever. */
  const attempted = new Set();
  let total = 0;
  let observedAt = null;
  let catalogAt = 0;
  return {
    stations,
    attempted,
    get total() {
      return total;
    },
    get observedAt() {
      return observedAt;
    },
    get catalogAt() {
      return catalogAt;
    },
    setCatalog(ids, at, totalCount) {
      observedAt = at;
      total = totalCount;
      catalogAt = Date.now();
      // A station that vanished upstream is dropped from the cache.
      const known = new Set(ids);
      for (const id of [...stations.keys()])
        if (!known.has(id)) stations.delete(id);
    },
  };
}

/**
 * Fetch one upstream document, following a SAME-ORIGIN redirect by hand.
 *
 * WHY THIS IS NEEDED: the operator serves /services/observations.json as a
 * 302 to /services/observations.json/index.php - the same 302 shape the
 * station detail endpoint has. A plain `redirect: 'manual'` therefore sees a
 * 302 and calls it a fatal upstream error, which is why the station route
 * answered 502 while the zone route worked. The shared open-data proxy
 * (src/sources/openDataProxy.js) already implements exactly this: follow the
 * Location manually, but only while it stays on the registered upstream's own
 * https origin.
 *
 * The cross-origin refusal is a real SSRF guard and is NOT relaxed here: an
 * upstream that bounced the proxy at a third party would turn the allow-list
 * into a suggestion.
 *
 * @param {string} url The registered upstream URL.
 * @param {typeof fetch} fetchImpl Injected fetch.
 * @param {AbortSignal} [signal] Abort signal.
 * @param {string} accept Accept header for the upstream read.
 * @returns {Promise<Response>} The final, non-redirect response.
 */
async function fetchVigicruesUpstream(url, fetchImpl, signal, accept) {
  let current = url;
  for (let hop = 0; hop <= VIGICRUES_MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, {
      signal,
      redirect: 'manual',
      headers: { Accept: accept },
    });
    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect) return response;
    const decision = openDataRedirectDecision(
      url,
      response.headers.get('location'),
    );
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    if (!decision.ok)
      throw new Error(`upstream redirect refused (${decision.reason})`);
    if (hop === VIGICRUES_MAX_REDIRECTS)
      throw new Error('upstream redirected too many times');
    current = decision.url;
  }
  throw new Error('upstream redirected too many times');
}

/**
 * Load the station catalogue (ids and observation times).
 *
 * @param {typeof fetch} fetchImpl Injected fetch.
 * @param {AbortSignal} [signal] Abort signal.
 * @returns {Promise<{ids: string[], observedAt: number|null, total: number}>}
 */
export async function loadVigicruesCatalog(fetchImpl, signal) {
  const response = await fetchVigicruesUpstream(
    STATION_LIST_URL,
    fetchImpl,
    signal,
    'application/json',
  );
  if (!response.ok) {
    const error = new Error(`upstream HTTP ${response.status}`);
    error.upstreamStatus = response.status;
    throw error;
  }
  const payload = await readResponseJsonCapped(
    response,
    MAX_CATALOG_BYTES,
    signal,
  );
  return normalizeVigicruesStationList(payload);
}

/**
 * Hydrate one bounded batch of stations into the cache.
 *
 * @param {object} options
 * @param {typeof fetch} options.fetchImpl Injected fetch.
 * @param {AbortSignal} [options.signal] Abort signal.
 * @param {object} options.cache The persistent station cache.
 * @param {string[]} options.ids Every station id the catalogue knows.
 * @param {number} [options.batch=STATION_BATCH_SIZE] How many to hydrate.
 * @returns {Promise<{hydrated: number, throttled: boolean}>}
 */
export async function hydrateVigicruesStations({
  fetchImpl,
  signal,
  cache,
  ids,
  batch = STATION_BATCH_SIZE,
}) {
  const pending = ids.filter((id) => !cache.attempted.has(id));
  let hydrated = 0;
  let throttled = false;
  let consecutiveThrottle = 0;
  for (const id of pending.slice(0, Math.max(0, batch))) {
    signal?.throwIfAborted();
    cache.attempted.add(id);
    if (hydrated || consecutiveThrottle) await sleep(STATION_SWEEP_DELAY_MS);
    try {
      const response = await fetchVigicruesUpstream(
        STATION_DETAIL_URL + '?CdStationHydro=' + encodeURIComponent(id),
        fetchImpl,
        signal,
        'application/json',
      );
      if (response.status === 429) {
        // The operator throttles bursts. Back off rather than hammering it:
        // three in a row means this batch is done.
        consecutiveThrottle += 1;
        if (consecutiveThrottle >= STATION_MAX_THROTTLE) {
          throttled = true;
          break;
        }
        await sleep(STATION_SWEEP_DELAY_MS * 4);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      const payload = await readResponseJsonCapped(
        response,
        MAX_CATALOG_BYTES,
        signal,
      );
      const row = normalizeVigicruesStation(payload);
      if (row) {
        cache.stations.set(row.id, row);
        hydrated += 1;
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // One unreachable station must not sink the whole snapshot.
    }
  }
  return { hydrated, throttled };
}

/**
 * Load the flood-warning zone geometry.
 *
 * @param {typeof fetch} fetchImpl Injected fetch.
 * @param {AbortSignal} [signal] Abort signal.
 * @returns {Promise<{fetchedAt: number, count: number, zones: object[], bbox: number[]|null}>}
 */
export async function loadVigicruesZones(fetchImpl, signal) {
  const response = await fetchVigicruesUpstream(
    ZONES_URL,
    fetchImpl,
    signal,
    'application/geo+json, application/json',
  );
  if (!response.ok) {
    const error = new Error(`upstream HTTP ${response.status}`);
    error.upstreamStatus = response.status;
    throw error;
  }
  const payload = await readResponseJsonCapped(
    response,
    MAX_ZONE_BYTES,
    signal,
  );
  const { zones, bbox } = normalizeVigicruesZones(payload);
  return { fetchedAt: Date.now(), count: zones.length, zones, bbox };
}

/**
 * Build the Vigicrues open-data service.
 *
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {{handle: Function, close: Function}}
 */
export function createVigicruesService({ fetchImpl = fetch } = {}) {
  const cache = createStationCache();
  const service = createOpenDataService({
    id: 'vigicrues',
    routes: new Map([
      ['stations', STATION_LIST_URL],
      ['zones', ZONES_URL],
    ]),
    loader: async (route, fetchImplArg, signal) => {
      if (route === 'zones') return loadVigicruesZones(fetchImplArg, signal);
      if (route !== 'stations') throw new Error(`unknown route ${route}`);
      const catalog = await loadVigicruesCatalog(fetchImplArg, signal);
      cache.setCatalog(catalog.ids, catalog.observedAt, catalog.total);
      const { hydrated, throttled } = await hydrateVigicruesStations({
        fetchImpl: fetchImplArg,
        signal,
        cache,
        ids: catalog.ids,
      });
      const stations = [...cache.stations.values()];
      return {
        fetchedAt: Date.now(),
        count: stations.length,
        total: cache.total,
        observedAt: cache.observedAt,
        // The coverage the proxy actually has, stated plainly: the catalogue
        // knows every station, the cache holds the ones whose position has
        // been fetched so far.
        hydrated,
        throttled,
        stations,
      };
    },
    ttlMs: STATION_TTL_MS,
    maxBytes: MAX_ZONE_BYTES,
    maxPerWindow: 4,
    globalMaxPerWindow: 12,
    timeoutMs: 120_000,
    fetchImpl,
  });
  return service;
}

/**
 * Vite plugin wrapping the Vigicrues proxy.
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {import('vite').Plugin}
 */
export function vigicruesProxy(options = {}) {
  const service = createVigicruesService(options);
  function install(server) {
    server.middlewares.use('/api/vigicrues', async (req, res) => {
      const response = await service.handle({
        url: 'http://localhost/api/vigicrues' + (req.url || '/'),
        method: req.method,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    });
    server.httpServer?.once('close', service.close);
  }
  return {
    name: 'vigicrues-proxy',
    closeBundle: service.close,
    configureServer: install,
    configurePreviewServer: install,
  };
}
