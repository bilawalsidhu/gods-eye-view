import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { readResponseTextCapped } from '../common/http.js';

const SHODAN_API = 'https://api.shodan.io';
const GREYNOISE_API = 'https://api.greynoise.io/v3/community';
const IP_GEO_API = 'https://ipwho.is';
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT = 512 * 1024;
const HOST_TTL_MS = 6 * 60 * 60_000;
const SEARCH_TTL_MS = 15 * 60_000;
const GREYNOISE_TTL_MS = 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 100;
const MAX_SEARCH_PAGE = 3;
const SHODAN_RESULT_LIMIT = 10;
const SHODAN_SEARCH_FIELDS = [
  'ip_str',
  'ip',
  'port',
  'transport',
  'product',
  'version',
  'timestamp',
  'org',
  'isp',
  'asn',
  'hostnames',
  'location',
  'os',
].join(',');
const GEOLOCATION_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_GEO_REQUESTS_PER_DAY = 500;
const MAX_AREA_RADIUS_KM = 1_000;

function failure(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function safeTransportCode(error) {
  const candidate = error?.code ?? error?.cause?.code;
  return typeof candidate === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate)
    ? candidate
    : null;
}

function safeText(value, max = 160) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= max && !/[\u0000-\u001f<>]/.test(result)
    ? result
    : null;
}

function safeList(value, maxRows, maxText = 120) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxRows)
    .map((item) => safeText(String(item), maxText))
    .filter(Boolean);
}

function publicIPv4(value) {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function requirePublicIPv4(value) {
  const ip = String(value || '').trim();
  if (!publicIPv4(ip)) throw failure('invalid_ip');
  return ip;
}

function validSearchQuery(value) {
  const query = String(value || '').trim();
  if (!query || query.length > 120 || /[\u0000-\u001f<>#?&=;]/.test(query))
    throw failure('invalid_query');
  return query;
}

function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    return null;
  return new Date(value).toISOString();
}

function coordinate(value) {
  if (
    value === null ||
    value === undefined ||
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ipFromShodanRow(row) {
  if (typeof row?.ip_str === 'string' && isIP(row.ip_str) === 4)
    return row.ip_str;
  if (!Number.isInteger(row?.ip) || row.ip < 0 || row.ip > 0xffffffff)
    return null;
  return [24, 16, 8, 0].map((shift) => (row.ip >>> shift) & 255).join('.');
}

function normalizeShodanHost(ip, payload, fetchedAt) {
  const services =
    Array.isArray(payload?.data) && payload.data.length
      ? payload.data.slice(0, 12).map((row) => ({
          port:
            Number.isInteger(row?.port) && row.port >= 0 && row.port <= 65535
              ? row.port
              : null,
          transport: safeText(row?.transport, 12),
          product: safeText(row?.product, 100),
          version: safeText(row?.version, 80),
          timestamp: iso(row?.timestamp),
          cpe: safeList(row?.cpe, 12, 160),
          vulnerabilities: safeList(Object.keys(row?.vulns || {}), 20, 32),
          banner: safeText(row?.data, 320),
        }))
      : Number.isInteger(payload?.port)
        ? [
            {
              port:
                payload.port >= 0 && payload.port <= 65535
                  ? payload.port
                  : null,
              transport: safeText(payload?.transport, 12),
              product: safeText(payload?.product, 100),
              version: safeText(payload?.version, 80),
              timestamp: iso(payload?.timestamp),
              cpe: safeList(payload?.cpe, 12, 160),
              vulnerabilities: safeList(
                Object.keys(payload?.vulns || {}),
                20,
                32,
              ),
              banner: safeText(payload?.data, 320),
            },
          ]
        : [];
  const location = payload?.location || {};
  const latitude = coordinate(location.latitude ?? payload?.latitude);
  const longitude = coordinate(location.longitude ?? payload?.longitude);
  const hasCoordinates =
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180;
  return Object.freeze({
    provider: 'shodan',
    ip,
    fetchedAt,
    ports: Object.freeze(
      safeList(payload?.ports, 64, 8)
        .map(Number)
        .filter((port) => Number.isInteger(port) && port >= 0 && port <= 65535),
    ),
    services: Object.freeze(services),
    hostnames: Object.freeze(safeList(payload?.hostnames, 10, 253)),
    domains: Object.freeze(safeList(payload?.domains, 10, 253)),
    tags: Object.freeze(safeList(payload?.tags, 12, 80)),
    organization: safeText(payload?.org, 120),
    isp: safeText(payload?.isp, 120),
    asn: safeText(payload?.asn, 24),
    operatingSystem: safeText(payload?.os, 100),
    city: safeText(location.city, 100),
    region: safeText(location.region_code, 64),
    country: safeText(location.country_name, 100),
    countryCode: safeText(location.country_code, 2),
    latitude: hasCoordinates ? latitude : null,
    longitude: hasCoordinates ? longitude : null,
    geographicPrecision: hasCoordinates ? 'network-approximate' : null,
    geographicMethod: hasCoordinates
      ? safeText(payload?.geographicMethod, 120) || 'Shodan IP geolocation'
      : null,
    geographicProvenance: hasCoordinates
      ? safeText(payload?.geographicProvenance, 200) ||
        'Shodan location associated with this public IP; approximate network location, not a device or person location.'
      : null,
    attribution: 'Shodan InternetDB / host intelligence',
  });
}

function normalizeGreyNoise(ip, payload, fetchedAt) {
  if (!payload || typeof payload !== 'object')
    throw failure('invalid_provider_data');
  const responseIp = String(payload.ip || ip);
  if (responseIp !== ip || isIP(responseIp) !== 4)
    throw failure('invalid_provider_data');
  return Object.freeze({
    provider: 'greynoise',
    ip,
    fetchedAt,
    noise: typeof payload.noise === 'boolean' ? payload.noise : null,
    riot: typeof payload.riot === 'boolean' ? payload.riot : null,
    classification: safeText(payload.classification, 40),
    organization: safeText(payload.name, 120),
    lastSeen: iso(payload.last_seen),
    link:
      typeof payload.link === 'string' &&
      /^https:\/\/viz\.greynoise\.io\/(?:ip|riot)\/[0-9.]+$/.test(payload.link)
        ? payload.link
        : `https://viz.greynoise.io/ip/${ip}`,
    message: safeText(payload.message, 160),
    attribution: 'GreyNoise Community API',
  });
}

async function requestJson(
  fetchImpl,
  url,
  { signal, headers = {}, allowNotFound = false } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...headers },
    });
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw failure('invalid_credentials');
      if (response.status === 402) throw failure('insufficient_credits');
      if (response.status === 429) throw failure('rate_limited');
      if (response.status === 404) throw failure('not_found');
      throw failure('upstream_unavailable', {
        providerStatus: response.status,
      });
    }
    const text = await readResponseTextCapped(
      response,
      RESPONSE_LIMIT,
      controller.signal,
    );
    signal?.throwIfAborted();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw failure('invalid_provider_data');
    }
    if (!response.ok && response.status === 404)
      return { status: 404, payload };
    return { status: response.status, payload };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new Error('cancelled');
    if (error?.code === 'RESPONSE_TOO_LARGE')
      throw failure('provider_response_too_large');
    if (
      [
        'missing_credentials',
        'invalid_credentials',
        'insufficient_credits',
        'rate_limited',
        'not_found',
        'invalid_provider_data',
        'upstream_unavailable',
        'upstream_timeout',
        'upstream_network_error',
      ].includes(error?.code)
    )
      throw error;
    if (controller.signal.aborted) throw failure('upstream_timeout');
    throw failure('upstream_network_error', {
      transportCode: safeTransportCode(error),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function makeCache() {
  return { entries: new Map(), pending: new Map() };
}

function cacheKey(secret, identity) {
  return `${createHash('sha256').update(secret).digest('hex')}:${identity}`;
}

function memoized(cache, key, { now, ttl, maxEntries }, load) {
  const current = cache.entries.get(key);
  if (current && now() - current.cachedAt < ttl)
    return Promise.resolve(current.value);
  if (cache.pending.has(key)) return cache.pending.get(key);
  const operation = Promise.resolve()
    .then(load)
    .then((value) => {
      cache.entries.delete(key);
      cache.entries.set(key, { value, cachedAt: now() });
      while (cache.entries.size > maxEntries)
        cache.entries.delete(cache.entries.keys().next().value);
      return value;
    })
    .finally(() => cache.pending.delete(key));
  cache.pending.set(key, operation);
  return operation;
}

function keyFromEnv(name) {
  const key = String(process.env[name] || '').trim();
  if (!key) throw failure('missing_credentials');
  return key;
}

/** Server-only, on-demand Shodan and GreyNoise operations with bounded memory caches. */
export function createCyberEnrichmentProviders({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const hostCache = makeCache();
  const searchCache = makeCache();
  const noiseCache = makeCache();
  const geoCache = makeCache();
  let lastShodanSearchAt = null;
  let geoRequestDay = '';
  let geoRequestsToday = 0;

  async function shodanInfo({ signal } = {}) {
    const key = keyFromEnv('SHODAN_API_KEY');
    const url = new URL(`${SHODAN_API}/api-info`);
    url.searchParams.set('key', key);
    const { payload } = await requestJson(fetchImpl, url.href, { signal });
    const credits = Number(payload?.query_credits);
    const plan = safeText(payload?.plan, 60);
    if (
      !payload ||
      typeof payload !== 'object' ||
      (!plan && !Number.isFinite(credits))
    )
      throw failure('invalid_provider_data');
    return {
      message:
        Number.isFinite(credits) && credits >= 0
          ? `Shodan connection succeeded · ${credits} query credits available${plan ? ` · ${plan} plan` : ''}.`
          : `Shodan connection succeeded${plan ? ` · ${plan} plan` : ''}.`,
      queryCredits: Number.isFinite(credits) && credits >= 0 ? credits : null,
      plan,
    };
  }

  async function lookupShodanHost(value, { signal, force = false } = {}) {
    const ip = requirePublicIPv4(value);
    const key = keyFromEnv('SHODAN_API_KEY');
    const identity = cacheKey(key, `host:${ip}`);
    if (!force && hostCache.entries.has(identity)) {
      const entry = hostCache.entries.get(identity);
      if (now() - entry.cachedAt < HOST_TTL_MS) return entry.value;
    }
    return memoized(
      hostCache,
      identity,
      { now, ttl: HOST_TTL_MS, maxEntries: MAX_CACHE_ENTRIES },
      async () => {
        const url = new URL(
          `${SHODAN_API}/shodan/host/${encodeURIComponent(ip)}`,
        );
        url.searchParams.set('key', key);
        url.searchParams.set('minify', 'false');
        const { payload } = await requestJson(fetchImpl, url.href, { signal });
        if (ipFromShodanRow(payload) && ipFromShodanRow(payload) !== ip)
          throw failure('invalid_provider_data');
        return normalizeShodanHost(ip, payload, new Date(now()).toISOString());
      },
    );
  }

  async function searchShodan(
    value,
    pageValue = 1,
    { signal, geolocateMissing = false } = {},
  ) {
    const query = validSearchQuery(value);
    const page = Number(pageValue);
    if (!Number.isInteger(page) || page < 1 || page > MAX_SEARCH_PAGE)
      throw failure('invalid_page');
    const key = keyFromEnv('SHODAN_API_KEY');
    const identity = cacheKey(
      key,
      `search:${geolocateMissing ? 'area' : 'manual'}:${page}:${query.toLowerCase()}`,
    );
    return memoized(
      searchCache,
      identity,
      { now, ttl: SEARCH_TTL_MS, maxEntries: 30 },
      async () => {
        if (lastShodanSearchAt !== null && now() - lastShodanSearchAt < 2_000)
          throw failure('rate_limited');
        lastShodanSearchAt = now();
        const url = new URL(`${SHODAN_API}/shodan/host/search`);
        url.searchParams.set('key', key);
        url.searchParams.set('query', query);
        url.searchParams.set('page', String(page));
        // Shodan's fields parameter is mutually exclusive with minify=true.
        // Request only the compact device fields our normalized popup/map use.
        url.searchParams.set('minify', 'false');
        url.searchParams.set('fields', SHODAN_SEARCH_FIELDS);
        const { payload } = await requestJson(fetchImpl, url.href, { signal });
        if (!Array.isArray(payload?.matches) || payload.matches.length > 100)
          throw failure('invalid_provider_data');
        const fetchedAt = new Date(now()).toISOString();
        const matches = [
          ...new Set(
            payload.matches
              .map((row) => ipFromShodanRow(row))
              .filter((ip) => ip && publicIPv4(ip)),
          ),
        ]
          .slice(0, SHODAN_RESULT_LIMIT)
          .map((ip, index) => {
            const row = payload.matches.find(
              (item) => ipFromShodanRow(item) === ip,
            );
            return {
              ...normalizeShodanHost(ip, row, fetchedAt),
              rank: (page - 1) * 100 + index + 1,
            };
          });
        // Only enrich the first ten displayed results, and only where Shodan
        // has no usable coordinates. The IPs are public IPs returned by the
        // operator-triggered Shodan query; requests stay on the local server.
        if (geolocateMissing) await enrichMissingCoordinates(matches, signal);
        const total =
          Number.isSafeInteger(payload.total) && payload.total >= 0
            ? payload.total
            : null;
        return Object.freeze({
          provider: 'shodan',
          query,
          page,
          pageLimit: MAX_SEARCH_PAGE,
          pageSize: SHODAN_RESULT_LIMIT,
          total,
          fetchedAt,
          matches: Object.freeze(matches),
          attribution: 'Shodan',
        });
      },
    );
  }

  async function geolocateIp(ip, signal) {
    const identity = `ipwhois:${ip}`;
    return memoized(
      geoCache,
      identity,
      { now, ttl: GEOLOCATION_TTL_MS, maxEntries: MAX_CACHE_ENTRIES },
      async () => {
        const currentDay = new Date(now()).toISOString().slice(0, 10);
        if (geoRequestDay !== currentDay) {
          geoRequestDay = currentDay;
          geoRequestsToday = 0;
        }
        if (geoRequestsToday >= MAX_GEO_REQUESTS_PER_DAY) return null;
        geoRequestsToday++;
        const { payload } = await requestJson(
          fetchImpl,
          `${IP_GEO_API}/${encodeURIComponent(ip)}`,
          { signal },
        );
        const latitude = coordinate(payload?.latitude);
        const longitude = coordinate(payload?.longitude);
        if (
          payload?.success !== true ||
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90 ||
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180
        )
          return null;
        return {
          latitude,
          longitude,
          city: safeText(payload?.city, 100),
          region: safeText(payload?.region_code || payload?.region, 64),
          country: safeText(payload?.country, 100),
          countryCode: safeText(payload?.country_code, 2),
        };
      },
    );
  }

  async function enrichMissingCoordinates(matches, signal) {
    const pending = matches.filter(
      (match) => match.latitude == null || match.longitude == null,
    );
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(3, pending.length) },
      async () => {
        while (cursor < pending.length) {
          const match = pending[cursor++];
          try {
            const location = await geolocateIp(match.ip, signal);
            if (!location) continue;
            Object.assign(match, {
              city: location.city || match.city,
              region: location.region || match.region,
              country: location.country || match.country,
              countryCode: location.countryCode || match.countryCode,
              latitude: location.latitude,
              longitude: location.longitude,
              geographicPrecision: 'network-approximate',
              geographicMethod: 'IPwho.is IP geolocation',
              geographicProvenance:
                'Approximate network geolocation from IPwho.is using the public IP address; not a device or person location.',
            });
          } catch {
            // Search results remain useful without fallback geography.
          }
        }
      },
    );
    await Promise.all(workers);
  }

  async function searchShodanArea(
    latitudeValue,
    longitudeValue,
    radiusValue,
    { signal } = {},
  ) {
    const latitude = Number(latitudeValue);
    const longitude = Number(longitudeValue);
    const radiusKm = Math.ceil(Number(radiusValue));
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isInteger(radiusKm) ||
      radiusKm < 1 ||
      radiusKm > MAX_AREA_RADIUS_KM
    )
      throw failure('invalid_area');
    return searchShodan(
      `geo:${latitude.toFixed(4)},${longitude.toFixed(4)},${radiusKm}`,
      1,
      { signal, geolocateMissing: true },
    );
  }

  async function lookupGreyNoise(value, { signal, force = false } = {}) {
    const ip = requirePublicIPv4(value);
    const key = keyFromEnv('GREYNOISE_API_KEY');
    const identity = cacheKey(key, `community:${ip}`);
    return memoized(
      noiseCache,
      identity,
      {
        now,
        ttl: force ? 0 : GREYNOISE_TTL_MS,
        maxEntries: MAX_CACHE_ENTRIES,
      },
      async () => {
        const url = `${GREYNOISE_API}/${encodeURIComponent(ip)}`;
        const { payload, status } = await requestJson(fetchImpl, url, {
          signal,
          headers: { key },
          allowNotFound: true,
        });
        if (status === 404 && (!payload || typeof payload !== 'object'))
          throw failure('invalid_provider_data');
        return normalizeGreyNoise(ip, payload, new Date(now()).toISOString());
      },
    );
  }

  async function testGreyNoise({ signal } = {}) {
    if (!String(process.env.GREYNOISE_API_KEY || '').trim())
      throw failure('missing_credentials');
    await lookupGreyNoise('1.1.1.1', { signal, force: true });
    return {
      message:
        'GreyNoise connection succeeded. This test performs and caches one Community lookup (1.1.1.1), which counts toward GreyNoise lookup limits.',
    };
  }

  return Object.freeze({
    testShodanConnection: shodanInfo,
    testGreyNoiseConnection: testGreyNoise,
    lookupShodanHost,
    searchShodan,
    searchShodanArea,
    lookupGreyNoise,
  });
}

export {
  MAX_SEARCH_PAGE as SHODAN_MAX_SEARCH_PAGE,
  SHODAN_RESULT_LIMIT,
  normalizeGreyNoise,
  normalizeShodanHost,
  publicIPv4,
  validSearchQuery,
};
