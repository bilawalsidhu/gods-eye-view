// functions/api/radio/_broker.js
/**
 * Worker-safe Radio Browser catalog broker — the single implementation behind
 * `/api/radio` in BOTH runtimes:
 *
 *   - dev: `createRadioProxyMiddleware` in `vite.config.js` adapts this broker
 *     onto Connect, injecting a DNS-pinned transport (`node:dns` resolve +
 *     `node:https` with a pinned `lookup`).
 *   - Pages: `functions/api/radio/[[path]].js` adapts it onto the Pages
 *     Function contract, using the runtime's global `fetch`.
 *
 * This module owns the destination policy (host allowlist, fixed paths,
 * redirect refusal), the response byte cap, station normalization, the
 * bounded catalog refresh with its health policy, generation bookkeeping and
 * the served-station set that gates click pings.
 *
 * Security posture per runtime — the honest difference:
 *   - dev resolves every mirror hostname itself and refuses any non-global
 *     address BEFORE connecting, then pins the TLS connection to the
 *     validated address (see `resolveRadioProxyAddresses` /
 *     `fetchPinnedRadioResponse` in `vite.config.js`).
 *   - workerd has no `node:dns`/`node:net`, so the Pages side cannot pin.
 *     Its SSRF surface is bounded instead by the host allowlist
 *     (`*.api.radio-browser.info` — the Radio Browser project's own domain),
 *     the fixed path allowlist, `redirect: 'manual'` + refusal, response
 *     schema validation, and the hard byte cap.
 *
 * Worker-safe only: `fetch`, `AbortController`, `crypto.randomUUID`,
 * `BigInt` — no `Buffer`, no `node:*` imports.
 *
 * @module functions/api/radio/_broker
 */

import { readTextCapped } from '../../_upstream.js';
import { normalizeRadioCountryInput } from '../../../src/data/radioCountry.js';

/** How long a healthy catalog is served without a refresh. */
export const RADIO_DIRECTORY_CACHE_MS = 45 * 60 * 1000;
/** How long a stale catalog may still be served after refreshes fail. */
export const RADIO_DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Mirror-list discovery TTL. */
export const RADIO_MIRROR_CACHE_MS = 6 * 60 * 60 * 1000;
/** Per-request upstream bound. */
export const RADIO_FETCH_TIMEOUT_MS = 12_000;
/** Hard cap on any single upstream JSON document. */
export const RADIO_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
/** Hard cap on the served catalog. */
export const RADIO_DIRECTORY_LIMIT = 750;
/** Health policy: how many of the nine tag queries must succeed. */
export const RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES = 5;
/** Health policy: the broad query must yield at least this many stations. */
export const RADIO_CATALOG_HEALTHY_MIN_STATIONS = Math.ceil(RADIO_DIRECTORY_LIMIT / 2);
export const RADIO_USER_AGENT = 'GodsEyeView/1.0 (Radio Browser directory client)';
export const RADIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RADIO_FALLBACK_MIRRORS = Object.freeze([
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
]);

export function cleanRadioText(value, maxLength) {
  // eslint-disable-next-line no-control-regex -- the match exists to strip control characters from upstream text
  return String(value ?? '').replaceAll(/[\u0000-\u001f\u007f]/g, ' ').replaceAll(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

function isNonGlobalIpv4(hostname) {
  const pieces = hostname.split('.');
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) return false;
  const values = pieces.map(Number);
  if (values.some((value) => value > 255)) return true;
  const [a, b, c] = values;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/** Return a normalized public HTTPS URL, or null for local/private targets. */
export function publicRadioHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const hostname = url.hostname.toLowerCase().replaceAll(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !hostname) return null;
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || isNonGlobalIpv4(hostname)
      || hostname.includes(':')
    ) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Normalize one Radio Browser station and omit favicons and unsafe streams. */
export function normalizeRadioBrowserStation(raw) {
  const id = cleanRadioText(raw?.stationuuid, 40).toLowerCase();
  const lat = raw?.geo_lat === null || raw?.geo_lat === '' ? null : Number(raw?.geo_lat);
  const lon = raw?.geo_long === null || raw?.geo_long === '' ? null : Number(raw?.geo_long);
  const codec = cleanRadioText(raw?.codec, 16).toUpperCase();
  const streamUrl = publicRadioHttpsUrl(raw?.url_resolved || raw?.url);
  if (
    !RADIO_UUID_RE.test(id)
    || Number(raw?.lastcheckok) !== 1
    || Number(raw?.hls) === 1
    || !Number.isFinite(lat) || lat < -90 || lat > 90
    || !Number.isFinite(lon) || lon < -180 || lon > 180
    || !/^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(codec)
    || !streamUrl
  ) return null;

  const name = cleanRadioText(raw?.name, 140);
  if (!name) return null;
  const tags = String(raw?.tags ?? '')
    .split(',')
    .map((tag) => cleanRadioText(tag, 80).toLocaleLowerCase().replaceAll(/[_-]+/g, ' ').replaceAll(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 24);
  const languages = String(raw?.language ?? '')
    .split(',')
    .map((language) => cleanRadioText(language, 40))
    .filter(Boolean)
    .slice(0, 8);
  const rawCountryCode = cleanRadioText(raw?.countrycode, 2).toUpperCase();
  const normalizedCode = normalizeRadioCountryInput(rawCountryCode);
  const normalizedCountry = normalizedCode.valid && !normalizedCode.empty
    ? normalizedCode
    : normalizeRadioCountryInput(cleanRadioText(raw?.country, 80));
  const bitrate = Number(raw?.bitrate);
  return {
    id,
    name,
    lat,
    lon,
    streamUrl,
    homepage: publicRadioHttpsUrl(raw?.homepage),
    tags,
    languages,
    state: cleanRadioText(raw?.state, 80),
    country: normalizedCountry.valid && !normalizedCountry.empty
      ? normalizedCountry.name
      : cleanRadioText(raw?.country, 80),
    countryCode: normalizedCountry.valid ? normalizedCountry.code : '',
    metadataTrust: 'untrusted-community',
    codec,
    bitrate: Number.isInteger(bitrate) && bitrate >= 8 && bitrate <= 1024 ? bitrate : null,
    clickCount: Math.max(0, Math.min(10_000_000, Number(raw?.clickcount) || 0)),
  };
}

export function publicRadioStation(station) {
  return {
    id: station.id,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    streamUrl: station.streamUrl,
    homepage: station.homepage,
    tags: station.tags,
    languages: station.languages,
    state: station.state,
    country: station.country,
    countryCode: station.countryCode,
    metadataTrust: station.metadataTrust,
    codec: station.codec,
    bitrate: station.bitrate,
  };
}

function radioMirrorOrigin(value) {
  const hostname = String(value ?? '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(hostname)) return null;
  return `https://${hostname}`;
}

/** Return whether a resolved Radio Browser address is safe for an outbound request. */
export function isPublicRadioAddress(value) {
  const address = String(value ?? '').trim().toLowerCase().replaceAll(/^\[|\]$/g, '');
  if (!address) return false;
  if (!address.includes(':')) {
    const ipv4 = address.split('.');
    return ipv4.length === 4
      && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
      && !isNonGlobalIpv4(address);
  }
  const pieces = address.split('::');
  if (pieces.length > 2) return false;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return false;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
  const numeric = groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
  const inCidr = (base, prefix) => {
    const shift = 128n - BigInt(prefix);
    return (numeric >> shift) === (base >> shift);
  };
  const base = (text) => text.split(':').reduce(
    (total, group) => (total << 16n) | BigInt(`0x${group || '0'}`),
    0n,
  );
  const cidr = (text, prefix) => inCidr(base(text), prefix);
  return cidr('2000:0:0:0:0:0:0:0', 3)
    && !cidr('2001:0:0:0:0:0:0:0', 23)
    && !cidr('2001:db8:0:0:0:0:0:0', 32)
    && !cidr('2002:0:0:0:0:0:0:0', 16)
    && !cidr('3fff:0:0:0:0:0:0:0', 20);
}

/**
 * The one destination policy for every outbound radio request: allowlisted
 * mirror hosts only, fixed paths only, no credentials/ports/fragments, and
 * the discovery host accepts exactly `/json/servers` with no query.
 *
 * @param {string|URL} value
 * @returns {URL|null}
 */
export function radioProxyDestination(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const origin = radioMirrorOrigin(url.hostname);
  if (
    !origin
    || url.origin !== origin
    || url.username
    || url.password
    || url.port
    || url.hash
  ) return null;
  const discovery = url.hostname.toLowerCase() === 'all.api.radio-browser.info'
    && url.pathname === '/json/servers'
    && !url.search;
  const directory = url.pathname === '/json/stations/search';
  const click = /^\/json\/url\/[0-9a-f-]+$/i.test(url.pathname) && !url.search;
  return discovery || directory || click ? url : null;
}

async function mapRadioConcurrent(values, concurrency, mapper) {
  const results = Array.from({length: values.length});
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Create one radio catalog broker instance.
 *
 * The instance is process-scoped on the dev server and isolate-scoped on
 * Pages; the `catalogInstance` UUID scopes generation numbering so a client
 * that lands on a fresh instance restarts the sequence instead of misreading
 * it as a repeat or a regression.
 *
 * @param {object} [options]
 * @param {(destination: URL, options: {headers: object, signal: AbortSignal, redirect: 'manual'}) => Promise<Response>} [options.transport]
 *   Outbound transport. Dev injects a DNS-pinned one; when omitted the
 *   runtime's global `fetch` is used (Pages).
 * @param {() => number} [options.now] Clock injection for tests.
 */
export function createRadioCatalogBroker({ transport = null, now = Date.now } = {}) {
  let mirrorCache = { origins: [...RADIO_FALLBACK_MIRRORS], cachedAt: 0 };
  let mirrorPromise = null;
  let catalogCache = null;
  let catalogGeneration = 0;
  const catalogInstance = crypto.randomUUID();
  let servedStationIds = new Set();
  let refreshPromise = null;

  async function fetchJson(url, maxBytes = RADIO_RESPONSE_MAX_BYTES) {
    const destination = radioProxyDestination(url);
    if (!destination) throw new Error('Radio Browser destination is not permitted');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RADIO_FETCH_TIMEOUT_MS);
    try {
      const options = {
        headers: { Accept: 'application/json', 'User-Agent': RADIO_USER_AGENT },
        signal: controller.signal,
        redirect: 'manual',
      };
      const response = transport
        ? await transport(destination, options)
        : await fetch(destination.href, options);
      if (response.status >= 300 && response.status < 400) {
        try { await response.body?.cancel?.(); } catch { /* no-op */ }
        throw new Error('Radio Browser redirects are refused');
      }
      if (!response.ok) throw new Error(`Radio Browser returned ${response.status}`);
      const { tooLarge, text } = await readTextCapped(response, maxBytes);
      if (tooLarge) throw new Error('Radio Browser response exceeded the byte cap');
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function mirrors() {
    if (now() - mirrorCache.cachedAt < RADIO_MIRROR_CACHE_MS) return mirrorCache.origins;
    if (!mirrorPromise) {
      mirrorPromise = (async () => {
        try {
          const rows = await fetchJson('https://all.api.radio-browser.info/json/servers', 256 * 1024);
          const discovered = [...new Set((Array.isArray(rows) ? rows : []).map((row) => radioMirrorOrigin(row?.name)).filter(Boolean))];
          if (discovered.length) {
            mirrorCache = { origins: [...discovered, ...RADIO_FALLBACK_MIRRORS.filter((origin) => !discovered.includes(origin))], cachedAt: now() };
          }
        } catch {
          mirrorCache = { ...mirrorCache, cachedAt: now() };
        }
        return mirrorCache.origins;
      })().finally(() => { mirrorPromise = null; });
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
    const queries = [null, 'news', 'talk', 'weather', 'emergency', 'scanner', 'aviation', 'marine', 'traffic'];
    const outcomes = await mapRadioConcurrent(queries, 3, async (tag, index) => {
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
        if (!Array.isArray(rows)) throw new Error('Radio Browser catalog payload was not an array');
        if (!rows.every((row) => (
          row
          && typeof row === 'object'
          && !Array.isArray(row)
          && typeof row.stationuuid === 'string'
          && typeof row.name === 'string'
          && (typeof row.url_resolved === 'string' || typeof row.url === 'string')
        ))) throw new Error('Radio Browser catalog contained a malformed station row');
        const stations = rows.map(normalizeRadioBrowserStation).filter(Boolean);
        const requestedTag = cleanRadioText(tag, 80)
          .toLocaleLowerCase()
          .replaceAll(/[_-]+/g, ' ')
          .replaceAll(/\s+/g, ' ')
          .trim();
        const requestedTagCovered = !requestedTag || stations.some((station) => (
          station.tags.some((stationTag) => stationTag === requestedTag || stationTag.includes(requestedTag))
        ));
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
    });
    const resultSets = outcomes.map((outcome) => outcome.stations);

    const selected = [];
    const seen = new Set();
    const take = (station) => {
      if (!station || seen.has(station.id) || selected.length >= RADIO_DIRECTORY_LIMIT) return;
      seen.add(station.id);
      selected.push(station);
    };
    // Seed specialist station-tag queries before popularity fill so operational
    // categories remain represented even when global click charts skew musical.
    for (const rows of resultSets.slice(1)) rows.slice(0, 45).forEach(take);
    resultSets.flat().sort((a, b) => b.clickCount - a.clickCount || a.name.localeCompare(b.name)).forEach(take);
    const timestamp = now();
    const successfulQueries = outcomes.filter((outcome) => outcome.succeeded).length;
    const broadQueryHealthy = outcomes[0].succeeded && outcomes[0].stations.length > 0;
    const healthReasons = [];
    if (!broadQueryHealthy) healthReasons.push('broad-query-unhealthy');
    if (successfulQueries < RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES) healthReasons.push('query-coverage-below-policy');
    if (selected.length < RADIO_CATALOG_HEALTHY_MIN_STATIONS) healthReasons.push('station-coverage-below-policy');
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
      const error = new Error('Radio Browser catalog refresh did not meet health policy');
      error.radioCatalogDegraded = true;
      error.radioDegradedReason = nextCatalog.degradedReason;
      error.radioCoverage = coverage;
      throw error;
    }
    if (degraded && !selected.length) {
      const error = new Error('Radio Browser catalog refresh returned no usable stations');
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
    if (catalogCache && now() - catalogCache.cachedAt < RADIO_DIRECTORY_CACHE_MS) {
      return { ...catalogCache, stale: false };
    }
    if (!refreshPromise) {
      refreshPromise = refreshCatalog().finally(() => { refreshPromise = null; });
    }
    try {
      return { ...await refreshPromise, stale: false };
    } catch (error) {
      if (catalogCache && now() - catalogCache.cachedAt <= RADIO_DIRECTORY_STALE_MS) {
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

  return {
    catalogInstance,
    getCatalog,
    fetchPath,
    /** The exact JSON body the /stations route serves. */
    async catalogResponseBody() {
      const catalog = await getCatalog();
      return {
        stations: catalog.stations,
        updatedAt: catalog.updatedAt,
        stale: catalog.stale,
        degraded: Boolean(catalog.degraded),
        degradedReason: catalog.degradedReason || null,
        coverage: catalog.coverage || null,
        acceptedGeneration: catalog.acceptedGeneration ?? null,
        catalogInstance,
      };
    },
    /** Whether a click-ping id is a well-formed UUID served by this instance. */
    isServedStation(id) {
      return RADIO_UUID_RE.test(id) && servedStationIds.has(id);
    },
    /** Fire-and-forget click-count ping; caller has already answered 204. */
    pingStation(id) {
      void fetchPath(`/json/url/${id}`).catch(() => {});
    },
  };
}
