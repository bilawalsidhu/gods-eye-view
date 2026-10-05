import { lookup as lookupDns } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';

import { readResponseTextCapped } from '../common/http.js';
import {
  normalizeRadioBrowserStation,
  publicRadioStation,
  cleanRadioText,
} from './stations.js';
import {
  radioMirrorOrigin,
  radioProxyDestination,
  resolveRadioProxyAddresses,
  fetchPinnedRadioResponse,
} from './transport.js';
import {
  RADIO_DIRECTORY_CACHE_MS,
  RADIO_DIRECTORY_STALE_MS,
  RADIO_MIRROR_CACHE_MS,
  RADIO_FETCH_TIMEOUT_MS,
  RADIO_RESPONSE_MAX_BYTES,
  RADIO_DIRECTORY_LIMIT,
  RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES,
  RADIO_CATALOG_HEALTHY_MIN_STATIONS,
  RADIO_USER_AGENT,
  RADIO_UUID_RE,
  RADIO_FALLBACK_MIRRORS,
} from './constants.js';
export async function mapRadioConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Create the testable Connect middleware backing `/api/radio`. */
export function createRadioProxyMiddleware({
  fetchImpl = null,
  lookupImpl = lookupDns,
  now = Date.now,
} = {}) {
  let mirrorCache = { origins: [...RADIO_FALLBACK_MIRRORS], cachedAt: 0 };
  let mirrorPromise = null;
  let catalogCache = null;
  let catalogGeneration = 0;
  // The generation counter is process-local, so it restarts from 1 with the
  // server. The instance token scopes each generation sequence: a client that
  // sees a new instance must treat the catalog as a fresh sequence, never as a
  // repeat ("still generation 1") or a regression ("generation went backward").
  const catalogInstance = randomUUID();
  let servedStationIds = new Set();
  let refreshPromise = null;

  async function fetchJson(url, maxBytes = RADIO_RESPONSE_MAX_BYTES) {
    const destination = radioProxyDestination(url);
    if (!destination)
      throw new Error('Radio Browser destination is not permitted');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RADIO_FETCH_TIMEOUT_MS);
    try {
      const addresses = await resolveRadioProxyAddresses(
        destination.hostname,
        lookupImpl,
      );
      const options = {
        headers: { Accept: 'application/json', 'User-Agent': RADIO_USER_AGENT },
        signal: controller.signal,
        redirect: 'manual',
      };
      const response = fetchImpl
        ? await fetchImpl(destination.href, options)
        : await fetchPinnedRadioResponse(destination, options, addresses);
      if (response.status >= 300 && response.status < 400) {
        try {
          await response.body?.cancel?.();
        } catch {
          /* no-op */
        }
        throw new Error('Radio Browser redirects are refused');
      }
      if (!response.ok)
        throw new Error(`Radio Browser returned ${response.status}`);
      const text = await readResponseTextCapped(response, maxBytes);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function mirrors() {
    if (now() - mirrorCache.cachedAt < RADIO_MIRROR_CACHE_MS)
      return mirrorCache.origins;
    if (!mirrorPromise) {
      mirrorPromise = (async () => {
        try {
          const rows = await fetchJson(
            'https://all.api.radio-browser.info/json/servers',
            256 * 1024,
          );
          const discovered = [
            ...new Set(
              (Array.isArray(rows) ? rows : [])
                .map((row) => radioMirrorOrigin(row?.name))
                .filter(Boolean),
            ),
          ];
          if (discovered.length) {
            mirrorCache = {
              origins: [
                ...discovered,
                ...RADIO_FALLBACK_MIRRORS.filter(
                  (origin) => !discovered.includes(origin),
                ),
              ],
              cachedAt: now(),
            };
          }
        } catch {
          mirrorCache = { ...mirrorCache, cachedAt: now() };
        }
        return mirrorCache.origins;
      })().finally(() => {
        mirrorPromise = null;
      });
    }
    return mirrorPromise;
  }

  async function fetchPath(pathname) {
    let lastError = null;
    for (const origin of await mirrors()) {
      try {
        return await fetchJson(`${origin}${pathname}`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('No Radio Browser mirror is available');
  }

  async function refreshCatalog() {
    const queries = [
      null,
      'news',
      'talk',
      'weather',
      'emergency',
      'scanner',
      'aviation',
      'marine',
      'traffic',
    ];
    const outcomes = await mapRadioConcurrent(
      queries,
      3,
      async (tag, index) => {
        const params = new URLSearchParams({
          has_geo_info: 'true',
          is_https: 'true',
          hidebroken: 'true',
          order: 'clickcount',
          reverse: 'true',
          limit: index === 0 ? '1800' : '220',
        });
        if (tag) params.set('tag', tag);
        try {
          const rows = await fetchPath(`/json/stations/search?${params}`);
          if (!Array.isArray(rows))
            throw new Error('Radio Browser catalog payload was not an array');
          if (
            !rows.every(
              (row) =>
                row &&
                typeof row === 'object' &&
                !Array.isArray(row) &&
                typeof row.stationuuid === 'string' &&
                typeof row.name === 'string' &&
                (typeof row.url_resolved === 'string' ||
                  typeof row.url === 'string'),
            )
          )
            throw new Error(
              'Radio Browser catalog contained a malformed station row',
            );
          const stations = rows
            .map(normalizeRadioBrowserStation)
            .filter(Boolean);
          const requestedTag = cleanRadioText(tag, 80)
            .toLocaleLowerCase()
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const requestedTagCovered =
            !requestedTag ||
            stations.some((station) =>
              station.tags.some(
                (stationTag) =>
                  stationTag === requestedTag ||
                  stationTag.includes(requestedTag),
              ),
            );
          return {
            // Query coverage is based on accepted rows, not merely a payload that
            // happens to match the upstream schema. Specialist responses must
            // also contain an accepted station tagged for the requested category.
            succeeded: stations.length > 0 && requestedTagCovered,
            stations,
          };
        } catch {
          return { succeeded: false, stations: [] };
        }
      },
    );
    const resultSets = outcomes.map((outcome) => outcome.stations);

    const selected = [];
    const seen = new Set();
    const take = (station) => {
      if (
        !station ||
        seen.has(station.id) ||
        selected.length >= RADIO_DIRECTORY_LIMIT
      )
        return;
      seen.add(station.id);
      selected.push(station);
    };
    // Seed specialist station-tag queries before popularity fill so operational
    // categories remain represented even when global click charts skew musical.
    for (const rows of resultSets.slice(1)) rows.slice(0, 45).forEach(take);
    resultSets
      .flat()
      .sort(
        (a, b) => b.clickCount - a.clickCount || a.name.localeCompare(b.name),
      )
      .forEach(take);
    const timestamp = now();
    const successfulQueries = outcomes.filter(
      (outcome) => outcome.succeeded,
    ).length;
    const broadQueryHealthy =
      outcomes[0].succeeded && outcomes[0].stations.length > 0;
    const healthReasons = [];
    if (!broadQueryHealthy) healthReasons.push('broad-query-unhealthy');
    if (successfulQueries < RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES)
      healthReasons.push('query-coverage-below-policy');
    if (selected.length < RADIO_CATALOG_HEALTHY_MIN_STATIONS)
      healthReasons.push('station-coverage-below-policy');
    const degraded = healthReasons.length > 0;
    const coverage = {
      successfulQueries,
      totalQueries: queries.length,
      stationCount: selected.length,
      healthyStationMinimum: RADIO_CATALOG_HEALTHY_MIN_STATIONS,
    };
    const nextCatalog = {
      cachedAt: timestamp,
      updatedAt: new Date(timestamp).toISOString(),
      stations: selected.map(publicRadioStation),
      stationIds: new Set(selected.map((station) => station.id)),
      degraded,
      degradedReason: degraded ? healthReasons.join(',') : null,
      coverage,
    };
    if (degraded && catalogCache) {
      const error = new Error(
        'Radio Browser catalog refresh did not meet health policy',
      );
      error.radioCatalogDegraded = true;
      error.radioDegradedReason = nextCatalog.degradedReason;
      error.radioCoverage = coverage;
      throw error;
    }
    if (degraded && !selected.length) {
      const error = new Error(
        'Radio Browser catalog refresh returned no usable stations',
      );
      error.radioCatalogDegraded = true;
      error.radioDegradedReason = nextCatalog.degradedReason;
      error.radioCoverage = coverage;
      throw error;
    }
    if (degraded) {
      servedStationIds = nextCatalog.stationIds;
      return { ...nextCatalog, acceptedGeneration: null };
    }
    catalogCache = {
      ...nextCatalog,
      acceptedGeneration: ++catalogGeneration,
    };
    servedStationIds = catalogCache.stationIds;
    return catalogCache;
  }

  async function getCatalog() {
    if (
      catalogCache &&
      now() - catalogCache.cachedAt < RADIO_DIRECTORY_CACHE_MS
    ) {
      return { ...catalogCache, stale: false };
    }
    if (!refreshPromise) {
      refreshPromise = refreshCatalog().finally(() => {
        refreshPromise = null;
      });
    }
    try {
      return { ...(await refreshPromise), stale: false };
    } catch (error) {
      if (
        catalogCache &&
        now() - catalogCache.cachedAt <= RADIO_DIRECTORY_STALE_MS
      ) {
        return {
          ...catalogCache,
          stale: true,
          degraded: true,
          degradedReason: error?.radioDegradedReason || 'refresh-failed',
          coverage: error?.radioCoverage || catalogCache.coverage,
        };
      }
      throw error;
    }
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  return async function radioProxyMiddleware(req, res) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (requestUrl.pathname === '/stations') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      try {
        const catalog = await getCatalog();
        sendJson(res, 200, {
          stations: catalog.stations,
          updatedAt: catalog.updatedAt,
          stale: catalog.stale,
          degraded: Boolean(catalog.degraded),
          degradedReason: catalog.degradedReason || null,
          coverage: catalog.coverage || null,
          acceptedGeneration: catalog.acceptedGeneration ?? null,
          catalogInstance,
        });
      } catch (error) {
        sendJson(res, 503, {
          error: 'Radio directory is temporarily unavailable',
          degraded: Boolean(error?.radioCatalogDegraded),
          degradedReason: error?.radioDegradedReason || null,
        });
      }
      return;
    }

    const clickMatch = requestUrl.pathname.match(/^\/click\/([0-9a-f-]+)$/i);
    if (clickMatch) {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const id = clickMatch[1].toLowerCase();
      if (!RADIO_UUID_RE.test(id) || !servedStationIds.has(id)) {
        sendJson(res, 404, { error: 'Unknown radio station' });
        return;
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      void fetchPath(`/json/url/${id}`).catch(() => {});
      return;
    }

    sendJson(res, 404, { error: 'Unknown radio route' });
  };
}
