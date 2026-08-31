import { coalesceProxyRequest, readResponseTextCapped } from './proxyUtils.js';

const ARPOISE_DIRECTORY_URL = 'https://www.arpoise.com/php/dir/web/porpoise.php';
const ARPOISE_LAYER_NAME = 'Arpoise-Directory';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FRESH_CACHE_MS = 60_000;
const STALE_CACHE_MS = 15 * 60_000;
const MAX_EXPERIENCES_PER_PROVIDER = 250;
const MAX_OSCP_INSTANCES = 24;
const MAX_PROVIDER_CONCURRENCY = 4;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

const PROVIDER_COLORS = Object.freeze({
  geoverse: '#44d7b6',
  meshmap: '#8b7cff',
  arpoise: '#ffb347',
  oscp: '#4aa8ff',
});

function cleanText(value, maxLength = 240) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, maxLength).trim() : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validCoordinates(lat, lon) {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function configuredBaseUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
      return null;
    }
    url.hash = '';
    url.search = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function configuredNearbyPath(value, fallback) {
  const path = cleanText(value, 160);
  if (!path || !path.startsWith('/') || /[\\\s]/.test(path)) return fallback;
  try {
    const base = new URL('https://configured-provider.invalid/');
    const resolved = new URL(path, base);
    if (resolved.origin !== base.origin) return fallback;
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return fallback;
  }
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function safeLaunchUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'arpoisedeeplink:') {
      return url.href;
    }
  } catch {
    // Invalid provider URLs are omitted rather than reflected to the browser.
  }
  return null;
}

function normalizedIso(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function providerReason(configured, enabled, disabledReason) {
  if (!configured) return 'Provider endpoint is not configured';
  if (!enabled) return disabledReason || 'Provider is disabled';
  return null;
}

function geoverseProviderReason(apiUrl, webUrl, enabled) {
  if (!apiUrl) return 'Provider endpoint is not configured';
  if (!webUrl) return 'Provider launch URL is not configured';
  return providerReason(true, enabled);
}

/**
 * Build the server-only provider registry. Secrets remain on private fields and
 * are removed before descriptors reach the browser.
 */
export function buildArProviderCatalog(env = process.env) {
  const geoverseApiUrl = configuredBaseUrl(env.GEOVERSE_API_URL);
  const geoverseWebUrl = configuredBaseUrl(env.GEOVERSE_WEB_URL);
  const geoverseConfigured = Boolean(geoverseApiUrl && geoverseWebUrl);
  const geoverseEnabled = geoverseConfigured
    && !/^(0|false|off)$/i.test(String(env.GEOVERSE_AR_ENABLED ?? 'true'));
  const meshmapApiUrl = configuredBaseUrl(env.MESHMAP_API_URL);
  const meshmapEnabled = Boolean(meshmapApiUrl) && !/^(0|false|off)$/i.test(String(env.MESHMAP_AR_ENABLED ?? 'true'));
  const arpoiseEnabled = boolEnv(env.ARPOISE_ENABLED, false);

  const providers = [
    {
      id: 'geoverse',
      label: 'Geoverse',
      protocol: 'geoverse',
      configured: geoverseConfigured,
      enabled: geoverseEnabled,
      reason: geoverseProviderReason(geoverseApiUrl, geoverseWebUrl, geoverseEnabled),
      color: PROVIDER_COLORS.geoverse,
      attribution: 'Geoverse',
      website: geoverseWebUrl,
      maxRadiusM: 5_000,
      _baseUrl: geoverseApiUrl,
      _webUrl: geoverseWebUrl,
      _nearbyPath: '/v1/experiences/nearby',
    },
    {
      id: 'meshmap',
      label: 'MeshMap',
      protocol: 'meshmap',
      configured: Boolean(meshmapApiUrl),
      enabled: meshmapEnabled,
      reason: providerReason(Boolean(meshmapApiUrl), meshmapEnabled),
      color: PROVIDER_COLORS.meshmap,
      attribution: 'MeshMap',
      website: 'https://www.meshmap.com/',
      maxRadiusM: 100_000,
      _baseUrl: meshmapApiUrl,
      _nearbyPath: configuredNearbyPath(env.MESHMAP_NEARBY_PATH, '/api/location/pins'),
      _apiKey: cleanText(env.MESHMAP_API_KEY, 2048),
    },
    {
      id: 'arpoise',
      label: 'ARpoise',
      protocol: 'arpoise',
      configured: true,
      enabled: arpoiseEnabled,
      reason: providerReason(
        true,
        arpoiseEnabled,
        'Awaiting lightweight maintainer permission and rate-limit confirmation',
      ),
      color: PROVIDER_COLORS.arpoise,
      attribution: 'ARpoise · Tamiko Thiel and Peter Graf',
      website: 'https://arpoise.com/',
      maxRadiusM: 5_000,
      _baseUrl: ARPOISE_DIRECTORY_URL,
    },
  ];

  let oscpCount = 0;
  for (const [index, entry] of parseJsonArray(env.OSCP_INSTANCES_JSON).entries()) {
    if (oscpCount >= MAX_OSCP_INSTANCES) break;
    const slug = cleanText(entry?.id, 48)?.toLowerCase();
    const baseUrl = configuredBaseUrl(entry?.baseUrl);
    if (!slug || !PROVIDER_ID_RE.test(slug) || !baseUrl) continue;
    const label = cleanText(entry?.name || entry?.operator, 80) || `OSCP Provider ${index + 1}`;
    const enabled = entry?.enabled !== false;
    const apiKeyEnv = cleanText(entry?.apiKeyEnv, 80);
    providers.push({
      id: `oscp:${slug}`,
      label,
      protocol: 'oscp',
      configured: true,
      enabled,
      reason: providerReason(true, enabled),
      color: cleanText(entry?.color, 24) || PROVIDER_COLORS.oscp,
      attribution: cleanText(entry?.attribution, 180) || `${label} via Open AR Cloud OSCP`,
      website: safeHttpUrl(entry?.website),
      maxRadiusM: 100_000,
      _baseUrl: baseUrl,
      _nearbyPath: configuredNearbyPath(entry?.nearbyPath, '/search/nearby'),
      _apiKey: cleanText(entry?.apiKey, 2048) || (apiKeyEnv ? cleanText(env[apiKeyEnv], 2048) : null),
      _launchUrlTemplate: cleanText(entry?.launchUrlTemplate, 512),
    });
    oscpCount += 1;
  }

  return providers;
}

export function publicArProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    configured: provider.configured === true,
    enabled: provider.enabled === true,
    reason: provider.reason || null,
    color: provider.color,
    attribution: provider.attribution,
    website: provider.website || null,
    maxRadiusM: provider.maxRadiusM,
  };
}

function requestUrl(provider, path) {
  const base = new URL(provider._baseUrl);
  return new URL(path, `${base.origin}/`);
}

export function buildArpoiseRequestUrl(provider, query) {
  const url = new URL(provider?._baseUrl || ARPOISE_DIRECTORY_URL);
  // This path is the critical safety/product boundary: the CGI front-end
  // injects synthetic defaults when no local installation exists.
  url.pathname = '/php/dir/web/porpoise.php';
  url.search = '';
  url.searchParams.set('lat', String(query.lat));
  url.searchParams.set('lon', String(query.lon));
  url.searchParams.set('layerName', ARPOISE_LAYER_NAME);
  url.searchParams.set('userId', 'public');
  url.searchParams.set('radius', String(Math.max(100, Math.min(5_000, Math.round(query.radiusM)))));
  url.searchParams.set('accuracy', '100');
  return url;
}

function haversineDistanceM(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function normalizedDistance(value, lat, lon, query) {
  const supplied = finiteNumber(value);
  if (supplied !== null && supplied >= 0) return supplied;
  return validCoordinates(lat, lon) && validCoordinates(query?.lat, query?.lon)
    ? haversineDistanceM(query.lat, query.lon, lat, lon)
    : null;
}

function normalizeExperience(candidate, provider, query) {
  const lat = finiteNumber(candidate.lat);
  const lon = finiteNumber(candidate.lon);
  if (!validCoordinates(lat, lon)) return null;
  const id = cleanText(candidate.id, 160);
  if (!id) return null;
  const title = cleanText(candidate.title, 120) || 'Untitled AR experience';
  return {
    id,
    providerId: provider.id,
    providerLabel: provider.label,
    protocol: provider.protocol,
    title,
    description: cleanText(candidate.description, 500),
    creator: cleanText(candidate.creator, 120),
    lat,
    lon,
    altitudeM: finiteNumber(candidate.altitudeM),
    distanceM: normalizedDistance(candidate.distanceM, lat, lon, query),
    contentType: cleanText(candidate.contentType, 80),
    launchUrl: safeLaunchUrl(candidate.launchUrl),
    sourceUrl: safeHttpUrl(candidate.sourceUrl),
    updatedAt: normalizedIso(candidate.updatedAt),
    startsAt: normalizedIso(candidate.startsAt),
    endsAt: normalizedIso(candidate.endsAt),
    attribution: cleanText(candidate.attribution, 180) || provider.attribution,
  };
}

function compactNormalized(items) {
  return items.filter(Boolean).slice(0, MAX_EXPERIENCES_PER_PROVIDER);
}

export function normalizeGeoverseExperiences(payload, provider, query) {
  const experiences = Array.isArray(payload?.experiences) ? payload.experiences : [];
  return compactNormalized(experiences.map((entry) => {
    const id = cleanText(entry?.id, 160);
    const detailUrl = id && provider?._webUrl
      ? `${provider._webUrl}/e/${encodeURIComponent(id)}`
      : null;
    return normalizeExperience({
      id,
      title: entry?.name,
      description: entry?.description,
      creator: entry?.creatorName || entry?.creatorId,
      lat: entry?.lat ?? entry?.anchor?.lat,
      lon: entry?.lng ?? entry?.lon ?? entry?.anchor?.lng,
      altitudeM: entry?.altitude ?? entry?.anchor?.altitude,
      distanceM: entry?.distanceM,
      contentType: 'GXP',
      launchUrl: detailUrl,
      sourceUrl: detailUrl,
      updatedAt: entry?.updatedAt,
      startsAt: entry?.startsAt,
      endsAt: entry?.endsAt,
    }, provider, query);
  }));
}

export function normalizeMeshmapExperiences(payload, provider, query) {
  const pins = Array.isArray(payload?.pins)
    ? payload.pins
    : (Array.isArray(payload) ? payload : []);
  return compactNormalized(pins.map((pin) => {
    if (pin?.visibility !== 'public') return null;
    const pose = pin?.geoPose?.position || pin?.geoPose || {};
    return normalizeExperience({
      id: pin?.id,
      title: pin?.title,
      description: pin?.description || pin?.scanInstructions,
      creator: pin?.creator || pin?.userName || pin?.userId,
      lat: pin?.latitude ?? pose.lat ?? pose.latitude,
      lon: pin?.longitude ?? pose.lon ?? pose.lng ?? pose.longitude,
      altitudeM: pose.h ?? pose.altitude,
      distanceM: pin?.distance ?? pin?.distanceM,
      contentType: pin?.contentType,
      launchUrl: pin?.contentUrl,
      sourceUrl: pin?.contentUrl,
      updatedAt: pin?.updatedAt,
      startsAt: pin?.startsAt || pin?.startDate,
      endsAt: pin?.endsAt || pin?.endDate,
    }, provider, query);
  }));
}

function arpoiseCoordinate(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return number / 1_000_000;
}

export function normalizeArpoiseExperiences(payload, provider, query) {
  if (finiteNumber(payload?.errorCode) !== 0) return [];
  const hotspots = Array.isArray(payload?.hotspots) ? payload.hotspots : [];
  return compactNormalized(hotspots.map((hotspot) => {
    const layerName = cleanText(hotspot?.title || hotspot?.layer, 160);
    const launchUrl = layerName
      ? `arpoisedeeplink://DeeplinkLayer?${encodeURIComponent(layerName)}`
      : null;
    return normalizeExperience({
      id: hotspot?.id || layerName,
      title: hotspot?.line1 || layerName,
      description: [hotspot?.line3, hotspot?.line4, hotspot?.comment].filter(Boolean).join(' · '),
      creator: hotspot?.line2,
      lat: arpoiseCoordinate(hotspot?.lat),
      lon: arpoiseCoordinate(hotspot?.lon),
      altitudeM: hotspot?.alt,
      distanceM: hotspot?.distance,
      contentType: 'ARpoise layer',
      launchUrl,
      sourceUrl: provider?.website,
      updatedAt: hotspot?.updatedAt || hotspot?.lastUpdate,
      startsAt: hotspot?.startsAt || hotspot?.startDate,
      endsAt: hotspot?.endsAt || hotspot?.endDate,
      attribution: hotspot?.attribution || hotspot?.line2,
    }, provider, query);
  }));
}

function applyUrlTemplate(template, values) {
  if (!template) return null;
  let result = String(template);
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, encodeURIComponent(String(value ?? '')));
  }
  return result;
}

export function normalizeOscpExperiences(payload, provider, query) {
  const objects = Array.isArray(payload?.data) ? payload.data : [];
  const normalized = [];
  for (const wrapper of objects) {
    const feature = wrapper?.object || wrapper;
    const properties = feature?.properties || {};
    const contents = Array.isArray(properties.content) && properties.content.length
      ? properties.content
      : [{}];
    for (const [index, content] of contents.entries()) {
      const position = content?.geopose?.position || {};
      const coordinates = feature?.geometry?.coordinates || [];
      const tags = content?.tags || {};
      const objectId = wrapper?.id || properties.id || feature?.id;
      const id = `${objectId || 'content'}:${index}`;
      const launchUrl = applyUrlTemplate(provider?._launchUrlTemplate, {
        id: objectId,
        contentIndex: index,
      }) || content?.url;
      normalized.push(normalizeExperience({
        id,
        title: tags.name || tags.title || content?.description || properties.name,
        description: content?.description || tags.description,
        creator: tags.artist || tags.creator || tags.author,
        lat: position.lat ?? coordinates[1],
        lon: position.lon ?? position.lng ?? coordinates[0],
        altitudeM: position.h ?? position.altitude ?? coordinates[2],
        distanceM: wrapper?.distance,
        contentType: content?.contenttype || content?.metatype,
        launchUrl,
        sourceUrl: content?.url,
        updatedAt: tags.updatedAt || properties.updatedAt,
        startsAt: tags.startsAt || tags.startDate,
        endsAt: tags.endsAt || tags.endDate,
        attribution: tags.attribution,
      }, provider, query));
    }
  }
  return compactNormalized(normalized);
}

export function filterExperiencesByTime(experiences, { includePast = false, now = Date.now() } = {}) {
  if (includePast) return [...experiences];
  return experiences.filter((experience) => {
    if (!experience?.endsAt) return true;
    const end = Date.parse(experience.endsAt);
    return !Number.isFinite(end) || end >= now;
  });
}

async function readJsonCapped(response) {
  let text;
  try {
    text = await readResponseTextCapped(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error?.code === 'RESPONSE_TOO_LARGE') {
      throw new Error('AR provider response exceeds the size limit');
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('AR provider returned malformed JSON');
  }
}

function providerHeaders(provider) {
  const headers = { Accept: 'application/json' };
  if (provider.protocol === 'meshmap' && provider._apiKey) {
    headers['x-app-api-key'] = provider._apiKey;
  }
  if (provider.protocol === 'oscp' && provider._apiKey) {
    headers['x-api-key'] = provider._apiKey;
  }
  return headers;
}

function buildProviderRequest(provider, query) {
  if (provider.protocol === 'arpoise') return buildArpoiseRequestUrl(provider, query);
  const url = requestUrl(provider, provider._nearbyPath);
  url.searchParams.set('lat', String(query.lat));
  url.searchParams.set(provider.protocol === 'geoverse' ? 'lng' : 'lon', String(query.lon));
  if (provider.protocol === 'geoverse') {
    url.searchParams.set('radiusM', String(Math.min(5_000, Math.round(query.radiusM))));
  } else {
    url.searchParams.set('radius', String(Math.min(100_000, Math.round(query.radiusM))));
  }
  return url;
}

async function fetchProviderExperiences(provider, query, fetchImpl) {
  const response = await fetchImpl(buildProviderRequest(provider, query), {
    headers: providerHeaders(provider),
    redirect: 'error',
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${provider.label} returned HTTP ${response.status}`);
  const payload = await readJsonCapped(response);
  if (provider.protocol === 'geoverse') return normalizeGeoverseExperiences(payload, provider, query);
  if (provider.protocol === 'meshmap') return normalizeMeshmapExperiences(payload, provider, query);
  if (provider.protocol === 'arpoise') return normalizeArpoiseExperiences(payload, provider, query);
  return normalizeOscpExperiences(payload, provider, query);
}

function createRateLimiter(maxPerMinute, now = () => Date.now()) {
  if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) return () => true;
  const hits = new Map();
  return (key) => {
    const timestamp = now();
    const recent = (hits.get(key) || []).filter((time) => timestamp - time < 60_000);
    if (recent.length >= maxPerMinute) {
      hits.set(key, recent);
      return false;
    }
    recent.push(timestamp);
    hits.set(key, recent);
    if (hits.size > 512) {
      for (const [candidate, times] of hits) {
        if (!times.length || timestamp - times.at(-1) >= 60_000) hits.delete(candidate);
      }
    }
    return true;
  };
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

function parsedQuery(req) {
  const url = new URL(req.url || '', 'http://localhost');
  const lat = finiteNumber(url.searchParams.get('lat'));
  const lon = finiteNumber(url.searchParams.get('lon'));
  const radiusM = finiteNumber(url.searchParams.get('radiusM'));
  if (!validCoordinates(lat, lon) || radiusM === null || radiusM < 100 || radiusM > 100_000) {
    return null;
  }
  const providers = cleanText(url.searchParams.get('providers'), 512) || 'all';
  const includePast = /^(1|true)$/i.test(url.searchParams.get('includePast') || '');
  return { lat, lon, radiusM: Math.round(radiusM), providers, includePast };
}

function selectedProviderIds(selection, providers) {
  const available = providers.filter((provider) => provider.enabled && provider.configured);
  if (selection === 'all') return new Set(available.map(({ id }) => id));
  if (selection === 'none') return new Set();
  const valid = new Set(available.map(({ id }) => id));
  return new Set(selection.split(',').map((value) => value.trim()).filter((id) => valid.has(id)));
}

function cacheKey(provider, query) {
  return `${provider.id}:${query.lat}:${query.lon}:${query.radiusM}`;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

/** Vite dev/preview plugin for the same-origin AR aggregation endpoint. */
export function createArContentProxyPlugin({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const providers = buildArProviderCatalog(env);
  const cache = new Map();
  const inFlight = new Map();
  const configuredLimit = Number(env.GEV_RATELIMIT_AR_PER_MIN ?? 60);
  const allowRequest = createRateLimiter(configuredLimit, now);

  async function loadProvider(provider, query) {
    const key = cacheKey(provider, query);
    const cached = cache.get(key);
    const age = cached ? now() - cached.cachedAt : Number.POSITIVE_INFINITY;
    if (age <= FRESH_CACHE_MS) return { experiences: cached.experiences, cache: 'hit' };
    try {
      const request = coalesceProxyRequest(inFlight, key, async () => {
        const experiences = await fetchProviderExperiences(provider, query, fetchImpl);
        cache.set(key, { experiences, cachedAt: now() });
        if (cache.size > 300) cache.delete(cache.keys().next().value);
        return { experiences, cache: 'upstream' };
      });
      return await request.promise;
    } catch (error) {
      if (cached && age <= STALE_CACHE_MS) {
        return { experiences: cached.experiences, cache: 'stale', error: cleanText(error?.message, 180) };
      }
      throw error;
    }
  }

  function install(middlewares) {
    middlewares.use('/api/ar-content', async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed', providers: [], experiences: [] });
        return;
      }
      if (!allowRequest(String(req.socket?.remoteAddress || 'local'))) {
        sendJson(
          res,
          429,
          { error: 'Rate limit exceeded', providers: [], experiences: [] },
          { 'Retry-After': '5' },
        );
        return;
      }
      const query = parsedQuery(req);
      if (!query) {
        sendJson(res, 400, {
          error: 'Valid lat, lon, and radiusM (100-100000) are required',
          providers: providers.map(publicArProvider),
          experiences: [],
        });
        return;
      }

      const selected = selectedProviderIds(query.providers, providers);
      const statuses = new Map();
      const groups = await mapWithConcurrency(providers, MAX_PROVIDER_CONCURRENCY, async (provider) => {
        if (!provider.configured) {
          statuses.set(provider.id, { status: 'unconfigured', count: 0, error: provider.reason });
          return [];
        }
        if (!provider.enabled) {
          statuses.set(provider.id, { status: 'disabled', count: 0, error: provider.reason });
          return [];
        }
        if (!selected.has(provider.id)) {
          statuses.set(provider.id, { status: 'filtered', count: 0, error: null });
          return [];
        }
        try {
          const result = await loadProvider(provider, query);
          const experiences = filterExperiencesByTime(result.experiences, {
            includePast: query.includePast,
            now: now(),
          });
          statuses.set(provider.id, {
            status: result.cache === 'stale' ? 'stale' : 'ok',
            count: experiences.length,
            error: result.error || null,
          });
          return experiences;
        } catch (error) {
          statuses.set(provider.id, {
            status: 'error',
            count: 0,
            error: cleanText(error?.message, 180) || 'Provider request failed',
          });
          return [];
        }
      });
      const experiences = groups.flat()
        .sort((a, b) => (a.distanceM ?? Number.POSITIVE_INFINITY) - (b.distanceM ?? Number.POSITIVE_INFINITY))
        .slice(0, MAX_EXPERIENCES_PER_PROVIDER * Math.max(1, selected.size));
      sendJson(res, 200, {
        query: { lat: query.lat, lon: query.lon, radiusM: query.radiusM, includePast: query.includePast },
        providers: providers.map((provider) => ({
          ...publicArProvider(provider),
          effectiveRadiusM: Math.min(query.radiusM, provider.maxRadiusM),
          coverageLimited: query.radiusM > provider.maxRadiusM,
          ...(statuses.get(provider.id) || { status: 'filtered', count: 0, error: null }),
        })),
        experiences,
      });
    });
  }

  return {
    name: 'ar-content-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
