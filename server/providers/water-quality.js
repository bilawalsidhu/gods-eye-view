import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { coalesceProxyRequest, readResponseTextCapped } from './common/http.js';
import {
  WQ_MAX_RESPONSE_BYTES,
  WQ_RESULT_CAP,
  WQ_SITE_CAP,
  WQ_STALE_MS,
  WQ_UPSTREAM,
  WQ_UPSTREAM_TIMEOUT_MS,
} from './water-quality/constants.js';
import {
  _waterQualityCache,
  resolveWaterQualityTier,
  trimWaterQualityCache,
} from './water-quality/cache.js';
import {
  normalizeMeasurement,
  parseWaterQualityCsv,
} from './water-quality/csv.js';
import {
  quantizeWaterQualityBox,
  resolveCharacteristicType,
  resolveWindowYears,
  validSiteIdentifier,
  validWaterQualityBox,
  waterQualityBBoxParam,
  waterQualityCacheKey,
  waterQualityFailureReason,
  windowStart,
} from './water-quality/query.js';

/**
 * Tighter than the Overpass-backed proxies on purpose: the Water Quality Portal
 * is a small federal service and its responses are heavy.
 */
const _waterQualityRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 120,
});

const _waterQualityInFlight = new Map();

async function fetchUpstream(path, search) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WQ_UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(`${WQ_UPSTREAM}${path}?${search}`, {
      signal: controller.signal,
      headers: { Accept: '*/*' },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`Water Quality Portal HTTP ${response.status}`),
        {
          waterQualityReason:
            response.status === 429 ? 'rate_limited' : 'query_failed',
        },
      );
    const body = await readResponseTextCapped(response, WQ_MAX_RESPONSE_BYTES);
    return { body, headers: response.headers };
  } catch (error) {
    if (error?.name === 'AbortError')
      throw Object.assign(new Error('Water Quality Portal timed out'), {
        waterQualityReason: 'timeout',
      });
    if (error?.code === 'RESPONSE_TOO_LARGE')
      throw Object.assign(
        new Error('Water Quality Portal response exceeded the size cap'),
        { waterQualityReason: 'query_failed' },
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function waterQualityProxy() {
  async function refreshSites({ box, characteristicTypes, window, key }) {
    const search = new URLSearchParams({
      bBox: waterQualityBBoxParam(box),
      startDateLo: window.upstream,
      mimeType: 'geojson',
    });
    // The upstream unions repeated values; one family can span several.
    for (const type of characteristicTypes)
      search.append('characteristicType', type);
    const { body, headers } = await fetchUpstream(
      '/data/Station/search',
      search,
    );
    const parsed = JSON.parse(body);
    const features = Array.isArray(parsed?.features) ? parsed.features : [];
    // The upstream reports the true match count in a header, so truncation is a
    // fact we can state rather than a ceiling we have to infer.
    const reported = Number(headers.get('total-site-count'));
    const totalSiteCount = Number.isFinite(reported)
      ? reported
      : features.length;
    const sites = features
      .slice(0, WQ_SITE_CAP)
      .map((feature) => {
        const [longitude, latitude] = feature?.geometry?.coordinates || [];
        const properties = feature?.properties || {};
        return {
          id: String(properties.MonitoringLocationIdentifier || ''),
          name: String(properties.MonitoringLocationName || '').trim(),
          latitude,
          longitude,
          locationType:
            properties.ResolvedMonitoringLocationTypeName ||
            properties.MonitoringLocationTypeName ||
            null,
          organization: properties.OrganizationFormalName || null,
          provider: properties.ProviderName || null,
          resultCount: Number(properties.resultCount) || 0,
          siteUrl: properties.siteUrl || null,
        };
      })
      .filter(
        (site) =>
          site.id &&
          Number.isFinite(site.latitude) &&
          Number.isFinite(site.longitude),
      );
    const payload = {
      sites,
      totalSiteCount,
      saturated: sites.length < totalSiteCount,
      siteCap: WQ_SITE_CAP,
      sampledSince: window.iso,
      retrievedAt: new Date().toISOString(),
      status: 'ready',
    };
    const entry = { payload, cachedAt: Date.now() };
    _waterQualityCache.set(key, entry);
    trimWaterQualityCache();
    return payload;
  }

  async function refreshResults({ site, characteristicTypes, window, key }) {
    const search = new URLSearchParams({
      siteid: site,
      startDateLo: window.upstream,
      mimeType: 'csv',
    });
    for (const type of characteristicTypes)
      search.append('characteristicType', type);
    const { body } = await fetchUpstream('/data/Result/search', search);
    const measurements = parseWaterQualityCsv(body, WQ_RESULT_CAP)
      .map(normalizeMeasurement)
      .filter(Boolean)
      .sort((a, b) =>
        String(b.sampledAt || '').localeCompare(String(a.sampledAt || '')),
      );
    const payload = {
      site,
      measurements,
      measurementCap: WQ_RESULT_CAP,
      saturated: measurements.length >= WQ_RESULT_CAP,
      sampledSince: window.iso,
      retrievedAt: new Date().toISOString(),
      status: 'ready',
    };
    const entry = { payload, cachedAt: Date.now() };
    _waterQualityCache.set(key, entry);
    trimWaterQualityCache();
    return payload;
  }

  /** Answer from cache or upstream, serving last-good data when upstream fails. */
  async function answer(res, key, refresh) {
    const now = Date.now();
    const cached = _waterQualityCache.get(key);
    const preflight = resolveWaterQualityTier({
      cacheKey: key,
      inFlight: _waterQualityInFlight,
      now,
    });
    if (preflight.source === 'MEMORY') {
      sendJson(
        res,
        200,
        { ...preflight.entry.payload, status: 'cached' },
        { 'X-Water-Quality': 'MEMORY' },
      );
      return;
    }
    const request = coalesceProxyRequest(_waterQualityInFlight, key, refresh);
    try {
      const payload = await request.promise;
      sendJson(res, 200, payload, {
        'X-Water-Quality': request.shared ? 'INFLIGHT' : 'MISS',
      });
    } catch (error) {
      if (cached && now - cached.cachedAt <= WQ_STALE_MS) {
        sendJson(
          res,
          200,
          { ...cached.payload, status: 'stale' },
          { 'X-Water-Quality': 'STALE' },
        );
        return;
      }
      sendJson(res, 503, {
        error: 'Water quality monitoring data is temporarily unavailable',
        reason: waterQualityFailureReason(error),
      });
    }
  }

  /** Shared method, rate-limit and analyte-family gate for both endpoints. */
  function admit(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return null;
    }
    if (!_waterQualityRateLimiter(clientKey(req))) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '5',
      });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return null;
    }
    const url = new URL(req.url, 'http://localhost');
    const resolved = resolveCharacteristicType(url.searchParams.get('family'));
    if (!resolved) {
      sendJson(res, 400, { error: 'A supported analyte family is required' });
      return null;
    }
    return {
      params: url.searchParams,
      family: resolved.family,
      characteristicTypes: resolved.characteristicTypes,
      window: windowStart(
        resolveWindowYears(url.searchParams.get('sinceYears')),
      ),
    };
  }

  function install(middlewares) {
    middlewares.use('/api/water-quality/sites', async (req, res) => {
      const admitted = admit(req, res);
      if (!admitted) return;
      const requested = validWaterQualityBox(admitted.params);
      if (!requested) {
        sendJson(res, 400, {
          error: 'A non-dateline bbox no larger than 2 degrees is required',
        });
        return;
      }
      // Query the SNAPPED box so neighbouring views share one cache entry; an
      // outward snap always covers what was asked for, and the client re-filters
      // the superset against its own viewport before rendering.
      const box = quantizeWaterQualityBox(requested);
      const key = `sites:${admitted.family}:${admitted.window.iso}:${waterQualityCacheKey(box)}`;
      await answer(res, key, () =>
        refreshSites({
          box,
          characteristicTypes: admitted.characteristicTypes,
          window: admitted.window,
          key,
        }),
      );
    });

    middlewares.use('/api/water-quality/results', async (req, res) => {
      const admitted = admit(req, res);
      if (!admitted) return;
      const site = validSiteIdentifier(admitted.params.get('site'));
      if (!site) {
        sendJson(res, 400, {
          error: 'A monitoring site identifier is required',
        });
        return;
      }
      const key = `results:${admitted.family}:${admitted.window.iso}:${site}`;
      await answer(res, key, () =>
        refreshResults({
          site,
          characteristicTypes: admitted.characteristicTypes,
          window: admitted.window,
          key,
        }),
      );
    });
  }

  return {
    name: 'water-quality-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { waterQualityProxy };

export {
  WQ_CHARACTERISTIC_TYPES,
  WQ_SITE_CAP,
} from './water-quality/constants.js';
export {
  parseWaterQualityCsv,
  normalizeMeasurement,
} from './water-quality/csv.js';
export { resolveWaterQualityTier } from './water-quality/cache.js';
export {
  quantizeWaterQualityBox,
  resolveCharacteristicType,
  resolveWindowYears,
  validSiteIdentifier,
  validWaterQualityBox,
  waterQualityBBoxParam,
  waterQualityCacheKey,
  waterQualityFailureReason,
  windowStart,
} from './water-quality/query.js';
