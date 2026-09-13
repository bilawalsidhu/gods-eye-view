/**
 * Regional briefing (`/api/regional-brief`) and weather-effects (`/api/weather-effects`) proxies.
 *
 * Extracted verbatim from vite.config.js (Batch 4, PLAN.md) so each
 * endpoint can be unit-tested in isolation; vite.config.js assembles the
 * plugin list from these modules.
 */

import { clientKey, coalesceProxyRequest, makeRateLimiter, readResponseJsonCapped, readResponseTextCapped } from './_shared.js';
import { normalizeRegionalArticles, normalizeRegionalPlace, normalizeRegionalWeather } from '../../src/data/regionalBrief.js';
import {
  WEATHER_EFFECTS_CACHE_MS,
  WEATHER_EFFECTS_MAX_CACHE,
  WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
  WEATHER_EFFECTS_STALE_MS,
  buildOpenMeteoWeatherUrl,
  buildWeatherEffectsPayload,
  validRegionalPoint,
  regionalPointCacheKey,
} from '../../src/data/weatherEffectsPolicy.js';

// The weather-effects policy (validation, 0.1° cache key, upstream URL,
// payload shape, TTLs) lives in the worker-safe
// `src/data/weatherEffectsPolicy.js` so functions/api/weather-effects.js
// cannot drift from this middleware. Re-exported for the test suite.
export {
  WEATHER_EFFECTS_CACHE_MS,
  WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
  WEATHER_EFFECTS_STALE_MS,
  validRegionalPoint,
};

// ---------------------------------------------------------------------------
// Regional cockpit briefing proxy
// ---------------------------------------------------------------------------
export const REGIONAL_BRIEF_CACHE_MS = 5 * 60_000;

export const REGIONAL_BRIEF_STALE_MS = 60 * 60_000;

export const REGIONAL_BRIEF_MAX_CACHE = 120;

export const REGIONAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const _regionalBriefCache = new Map();

export const _regionalBriefInFlight = new Map();

export const _regionalBriefRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 90 });

export const _weatherEffectsCache = new Map();

export const _weatherEffectsInFlight = new Map();

export const _weatherEffectsRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 45, globalMax: 120 });

export let _nominatimQueue = Promise.resolve();

export let _nominatimLastRequestAt = 0;

export function trimRegionalBriefCache() {
  while (_regionalBriefCache.size > REGIONAL_BRIEF_MAX_CACHE) {
    const oldest = _regionalBriefCache.keys().next().value;
    if (oldest === undefined) break;
    _regionalBriefCache.delete(oldest);
  }
}

export function trimWeatherEffectsCache() {
  while (_weatherEffectsCache.size > WEATHER_EFFECTS_MAX_CACHE) {
    const oldest = _weatherEffectsCache.keys().next().value;
    if (oldest === undefined) break;
    _weatherEffectsCache.delete(oldest);
  }
}

export async function fetchRegionalJson(url, {
  headers = {},
  timeoutMs = 9000,
  maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return readResponseJsonCapped(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRegionalText(url, {
  headers = {},
  timeoutMs = 9000,
  maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return readResponseTextCapped(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

export function decodeRssText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function rssTag(block, tag) {
  return decodeRssText(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)?.[1] || '');
}

export function normalizeRssArticles(xml, limit = 5) {
  const seen = new Set();
  const articles = [];
  for (const match of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = rssTag(item, 'title').slice(0, 180);
    const url = rssTag(item, 'link');
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { continue; }
    if (!title || !['http:', 'https:'].includes(parsedUrl.protocol)) continue;
    const source = rssTag(item, 'source');
    const signature = `${title.toLowerCase()}|${source.toLowerCase() || parsedUrl.hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const rawDate = rssTag(item, 'pubDate');
    articles.push({
      title,
      url: parsedUrl.href,
      domain: source || parsedUrl.hostname.replace(/^www\./, ''),
      publishedAt: Number.isNaN(Date.parse(rawDate)) ? null : new Date(rawDate).toISOString(),
      sourceCountry: null,
    });
    if (articles.length >= limit) break;
  }
  return articles;
}

export function fetchRegionalPlace(point) {
  const task = _nominatimQueue.then(async () => {
    const waitMs = Math.max(0, 1100 - (Date.now() - _nominatimLastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    _nominatimLastRequestAt = Date.now();
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: point.latitude.toFixed(5),
      lon: point.longitude.toFixed(5),
      zoom: '10',
      addressdetails: '1',
      'accept-language': 'en',
    });
    const payload = await fetchRegionalJson(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      headers: {
        'User-Agent': 'GodsEyeView/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
        Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
      },
    });
    return normalizeRegionalPlace(payload);
  });
  _nominatimQueue = task.catch(() => null);
  return task;
}

export async function fetchRegionalNews(place) {
  const query = place?.locality || place?.region || place?.country;
  if (!query) return { status: 'unavailable', query: null, articles: [], source: null };
  const rssParams = new URLSearchParams({
    q: String(query).replace(/["\\]/g, ' ').trim(),
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  try {
    const xml = await fetchRegionalText(`https://news.google.com/rss/search?${rssParams}`, {
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
      timeoutMs: 12_000,
    });
    const articles = normalizeRssArticles(xml, 5);
    if (articles.length) return { status: 'ready', query, articles, source: 'Google News RSS' };
  } catch { /* fall through to the existing free index */ }
  const params = new URLSearchParams({
    query: `"${String(query).replace(/["\\]/g, ' ').trim()}"`,
    mode: 'artlist',
    format: 'json',
    maxrecords: '5',
    sort: 'datedesc',
    timespan: '48h',
  });
  try {
    const payload = await fetchRegionalJson(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
      timeoutMs: 12_000,
    });
    const articles = normalizeRegionalArticles(payload, 5);
    return { status: articles.length ? 'ready' : 'empty', query, articles, source: 'GDELT fallback' };
  } catch {
    return { status: 'unavailable', query, articles: [], source: null };
  }
}

export async function fetchRegionalWeather(point) {
  try {
    const payload = await fetchRegionalJson(buildOpenMeteoWeatherUrl(point), {
      maxBytes: WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
    });
    return normalizeRegionalWeather(payload);
  } catch {
    return null;
  }
}

/** True when at least one regional source produced usable data. */
export function regionalBriefHasAnySource({ place, weather, news } = {}) {
  return Boolean(place || weather || (news && news.status !== 'unavailable'));
}

export function regionalBriefProxy() {
  async function refresh(point, key) {
    const [placeResult, weatherResult] = await Promise.allSettled([
      fetchRegionalPlace(point),
      fetchRegionalWeather(point),
    ]);
    const place = placeResult.status === 'fulfilled' ? placeResult.value : null;
    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const news = await fetchRegionalNews(place);
    if (!regionalBriefHasAnySource({ place, weather, news })) {
      throw new Error('All regional briefing sources unavailable');
    }
    const payload = {
      status: place && weather && news.status !== 'unavailable' ? 'ready' : 'partial',
      retrievedAt: new Date().toISOString(),
      coordinates: point,
      place,
      placeStatus: place ? 'ready' : 'unavailable',
      weather,
      weatherStatus: weather ? 'ready' : 'unavailable',
      newsStatus: news.status,
      newsQuery: news.query,
      newsSource: news.source,
      articles: news.articles,
    };
    _regionalBriefCache.set(key, { payload, cachedAt: Date.now() });
    trimRegionalBriefCache();
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/regional-brief', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_regionalBriefRateLimiter(clientKey(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '10' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid latitude and longitude are required' }));
        return;
      }
      const key = regionalPointCacheKey(point);
      const now = Date.now();
      const cached = _regionalBriefCache.get(key);
      if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_CACHE_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'X-Regional-Brief': 'HIT' });
        res.end(JSON.stringify({ ...cached.payload, status: 'cached' }));
        return;
      }
      const request = coalesceProxyRequest(_regionalBriefInFlight, key, () => refresh(point, key));
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Regional-Brief': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_STALE_MS) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Regional-Brief': 'STALE' });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Regional briefing is temporarily unavailable' }));
      }
    });
  }

  return {
    name: 'regional-brief-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export function weatherEffectsProxy() {
  async function refresh(point, key) {
    const weather = await fetchRegionalWeather(point);
    if (!weather) throw new Error('Weather observation unavailable');
    const payload = buildWeatherEffectsPayload(point, weather, new Date().toISOString());
    _weatherEffectsCache.set(key, { payload, cachedAt: Date.now() });
    trimWeatherEffectsCache();
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/weather-effects', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_weatherEffectsRateLimiter(clientKey(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '10' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid latitude and longitude are required' }));
        return;
      }
      const key = regionalPointCacheKey(point);
      const now = Date.now();
      const cached = _weatherEffectsCache.get(key);
      if (cached && now - cached.cachedAt <= WEATHER_EFFECTS_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Weather-Effects': 'HIT',
        });
        res.end(JSON.stringify({ ...cached.payload, status: 'cached' }));
        return;
      }
      const request = coalesceProxyRequest(_weatherEffectsInFlight, key, () => refresh(point, key));
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Weather-Effects': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= WEATHER_EFFECTS_STALE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Weather-Effects': 'STALE',
          });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Weather effects are temporarily unavailable' }));
      }
    });
  }

  return {
    name: 'weather-effects-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
