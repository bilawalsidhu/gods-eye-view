/**
 * regionalBriefPolicy.js — the shared regional-briefing core (worker-safe).
 *
 * The Pages Function `functions/api/regional-brief/index.js` used to be a
 * stub that always answered `{ headlines: [], status: 'ok' }`, so the cockpit
 * Regional News page was permanently empty on production deployments while
 * the dev middleware served the real thing. This module closes that gap with
 * the repo's established parity pattern (geocodePolicy.js): ONE
 * request-resolution core, imported by BOTH runtimes, with per-runtime state
 * (cache, single-flight, rate limiting, the Nominatim pacing queue) injected
 * by the caller so tests run with no network, clock, or server.
 *
 * Worker-safe on purpose: web primitives only (URL/URLSearchParams, fetch,
 * Map, Date.now, TextDecoder) — no node:*, fs, Buffer, or process — so the
 * same file runs under Connect middleware and workerd.
 *
 * Upstream chain (mirrors the historical dev middleware verbatim):
 *   place   → Nominatim /reverse, paced at ≥1.1 s between requests
 *   weather → Open-Meteo forecast via the shared weatherEffectsPolicy URL
 *   news    → Google News RSS, falling back to GDELT DOC 2.0 on failure
 * A response is served when at least one source produced usable data;
 * otherwise the refresh throws and the caller serves stale or 503.
 */

import {
  WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
  buildOpenMeteoWeatherUrl,
  regionalPointCacheKey,
  validRegionalPoint,
} from './weatherEffectsPolicy.js';
import {
  normalizeRegionalArticles,
  normalizeRegionalPlace,
  normalizeRegionalWeather,
} from './regionalBrief.js';

/** Fresh-payload TTL — a 0.1° cell is re-fetched after five minutes. */
export const REGIONAL_BRIEF_CACHE_MS = 5 * 60_000;
/** Stale-while-revalidate window — stale answers survive one hour. */
export const REGIONAL_BRIEF_STALE_MS = 60 * 60_000;
/** LRU-ish ceiling on cached cells per isolate (evict-oldest on overflow). */
export const REGIONAL_BRIEF_MAX_CACHE = 120;
/** Hard cap on any single upstream body (RSS feeds can be large). */
export const REGIONAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Maximum headlines served per brief (both feeds are clipped to this). */
export const REGIONAL_NEWS_ARTICLE_LIMIT = 5;
/** Nominatim public-instance pacing — at most one request per second. */
export const REGIONAL_NOMINATIM_MIN_INTERVAL_MS = 1100;

export { validRegionalPoint };

const NOMINATIM_REVERSE_ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
const GOOGLE_NEWS_RSS_ENDPOINT = 'https://news.google.com/rss/search';
const GDELT_DOC_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GEV_USER_AGENT = 'GodsEyeView/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)';

/**
 * Nominatim pacing state. One instance per runtime is correct (per isolate in
 * workerd, per dev process in Node — the same per-isolate honesty note as
 * every other in-memory guard here). The adapters share the module singleton;
 * tests pass a fresh one so pacing never sleeps.
 * @returns {{queue: Promise<null>, lastRequestAt: number}} mutable pacing slot
 */
export function createNominatimPacing() {
  return { queue: Promise.resolve(), lastRequestAt: 0 };
}

/** @type {ReturnType<typeof createNominatimPacing>} module-singleton pacing slot */
const sharedPacing = createNominatimPacing();

/**
 * Decode an RSS/XML fragment into plain text: unwrap CDATA, resolve the five
 * XML entities the feeds actually use, strip tags, collapse whitespace.
 * @param {unknown} value raw XML fragment or anything coercible
 * @returns {string} cleaned text
 */
export function decodeRssText(value) {
  return String(value || '')
    .replaceAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll(/<[^>]+>/g, ' ').replaceAll(/\s+/g, ' ').trim();
}

/**
 * Extract and decode one tag's text from an RSS `<item>` block.
 * @param {string} block the `<item>…</item>` fragment
 * @param {string} tag tag name to read
 * @returns {string} decoded text, empty when absent
 */
export function rssTag(block, tag) {
  return decodeRssText(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)?.[1] || '');
}

/**
 * Normalize a Google News RSS document into client-shaped articles.
 *
 * Rows are dropped (not clamped) when the title is empty or the link is not
 * an http(s) URL — an unparseable item must not become a clickable card.
 * Deduplication keys on title+source so the same wire story republished by
 * the feed does not crowd out distinct headlines.
 * @param {unknown} xml raw RSS document text
 * @param {number} [limit] maximum articles (default 5)
 * @returns {Array<{title: string, url: string, domain: string, publishedAt: string|null, sourceCountry: null}>}
 *   client-shaped articles, upstream order, unusable rows dropped
 */
export function normalizeRssArticles(xml, limit = REGIONAL_NEWS_ARTICLE_LIMIT) {
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

/**
 * Read a fetch Response body as text under a hard byte cap (worker-safe).
 * Rejects early on an oversized declared Content-Length, then streams with a
 * running cap so a chunked or length-omitted body cannot blow past the limit.
 * Throws an error with `code: 'RESPONSE_TOO_LARGE'`.
 * @param {Response} response upstream response (body consumed)
 * @param {number} maxBytes hard cap in bytes
 * @returns {Promise<string>} decoded body text
 */
export async function readRegionalTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error('Upstream response too large');
    err.code = 'RESPONSE_TOO_LARGE';
    throw err;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) {
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    return text;
  }
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      const err = new Error('Upstream response too large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/**
 * Parse a fetch Response body as JSON under a hard byte cap (see
 * readRegionalTextCapped for the cap semantics).
 * @param {Response} response upstream response (body consumed)
 * @param {number} maxBytes hard cap in bytes
 * @returns {Promise<object>} parsed JSON body
 */
async function readRegionalJsonCapped(response, maxBytes) {
  return JSON.parse(await readRegionalTextCapped(response, maxBytes));
}

/**
 * Fetch an upstream JSON body under the regional byte cap and timeout.
 * @param {string} url upstream URL
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, headers?: object}} [opts] options bag (defaults: global fetch, 9 s, 2 MB, no extra headers)
 * @returns {Promise<object>} parsed JSON
 */
export async function fetchRegionalJson(url, {
  fetchImpl = fetch,
  timeoutMs = 9000,
  maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
  headers = {},
} = {}) {
  const response = await fetchImpl(url, {
    headers,
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  return readRegionalJsonCapped(response, maxBytes);
}

/**
 * Fetch an upstream text (RSS/XML) body under the regional byte cap and timeout.
 * @param {string} url upstream URL
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, headers?: object}} [opts] options bag (defaults: global fetch, 9 s, 2 MB, no extra headers)
 * @returns {Promise<string>} decoded text
 */
export async function fetchRegionalText(url, {
  fetchImpl = fetch,
  timeoutMs = 9000,
  maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
  headers = {},
} = {}) {
  const response = await fetchImpl(url, {
    headers,
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  return readRegionalTextCapped(response, maxBytes);
}

/**
 * Reverse-geocode a point with Nominatim, paced through the shared queue so
 * the public instance's 1 req/s budget holds even under coalesced bursts.
 * Failures propagate — the caller treats a place miss as `place: null`.
 * @param {{latitude: number, longitude: number}} point validated coordinates
 * @param {{fetchImpl?: typeof fetch, pacing?: ReturnType<typeof createNominatimPacing>, timeoutMs?: number}} [opts] options bag (defaults: global fetch, shared pacing slot, 9 s)
 * @returns {Promise<object|null>} normalized place (normalizeRegionalPlace shape)
 */
export function fetchRegionalPlace(point, {
  fetchImpl = fetch,
  pacing = sharedPacing,
  timeoutMs = 9000,
} = {}) {
  const task = pacing.queue.then(async () => {
    const waitMs = Math.max(0, REGIONAL_NOMINATIM_MIN_INTERVAL_MS - (Date.now() - pacing.lastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    pacing.lastRequestAt = Date.now();
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: point.latitude.toFixed(5),
      lon: point.longitude.toFixed(5),
      zoom: '10',
      addressdetails: '1',
      'accept-language': 'en',
    });
    const payload = await fetchRegionalJson(`${NOMINATIM_REVERSE_ENDPOINT}?${params}`, {
      fetchImpl,
      timeoutMs,
      headers: {
        'User-Agent': GEV_USER_AGENT,
        Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
      },
    });
    return normalizeRegionalPlace(payload);
  });
  pacing.queue = task.catch(() => null);
  return task;
}

/**
 * Fetch locality-matched headlines: Google News RSS first, GDELT DOC 2.0 as
 * the fail-soft fallback. Both clamp to the article limit; an upstream that
 * answers but yields zero rows stays a distinct `empty` status, never
 * silently repackaged as `unavailable`.
 * @param {object|null} place normalized place (its locality/region/country drives the query)
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts] options bag (defaults: global fetch, 12 s timeout)
 * @returns {Promise<{status: 'ready'|'empty'|'unavailable', query: string|null, articles: object[], source: string|null}>} the news outcome
 */
export async function fetchRegionalNews(place, {
  fetchImpl = fetch,
  timeoutMs = 12_000,
} = {}) {
  const query = place?.locality || place?.region || place?.country;
  if (!query) return { status: 'unavailable', query: null, articles: [], source: null };
  const rssParams = new URLSearchParams({
    q: String(query).replaceAll(/["\\]/g, ' ').trim(),
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  try {
    const xml = await fetchRegionalText(`${GOOGLE_NEWS_RSS_ENDPOINT}?${rssParams}`, {
      fetchImpl,
      timeoutMs,
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
    });
    const articles = normalizeRssArticles(xml, REGIONAL_NEWS_ARTICLE_LIMIT);
    if (articles.length) return { status: 'ready', query, articles, source: 'Google News RSS' };
  } catch { /* fall through to the existing free index */ }
  const params = new URLSearchParams({
    query: `"${String(query).replaceAll(/["\\]/g, ' ').trim()}"`,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(REGIONAL_NEWS_ARTICLE_LIMIT),
    sort: 'datedesc',
    timespan: '48h',
  });
  try {
    const payload = await fetchRegionalJson(`${GDELT_DOC_ENDPOINT}?${params}`, {
      fetchImpl,
      timeoutMs,
      headers: { 'User-Agent': 'GodsEyeView/0.1' },
    });
    const articles = normalizeRegionalArticles(payload, REGIONAL_NEWS_ARTICLE_LIMIT);
    return { status: articles.length ? 'ready' : 'empty', query, articles, source: 'GDELT fallback' };
  } catch {
    return { status: 'unavailable', query, articles: [], source: null };
  }
}

/**
 * Fetch current conditions for the cockpit Local Info page (Open-Meteo, via
 * the shared weather-effects URL builder). Failures collapse to null —
 * weather is optional context, never a reason to fail the brief.
 * @param {{latitude: number, longitude: number}} point validated coordinates
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts] options bag (defaults: global fetch, 9 s timeout)
 * @returns {Promise<object|null>} normalized weather or null
 */
export async function fetchRegionalWeather(point, {
  fetchImpl = fetch,
  timeoutMs = 9000,
} = {}) {
  try {
    const payload = await fetchRegionalJson(buildOpenMeteoWeatherUrl(point), {
      fetchImpl,
      timeoutMs,
      maxBytes: WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
    });
    return normalizeRegionalWeather(payload);
  } catch {
    return null;
  }
}

/**
 * True when at least one regional source produced usable data.
 * @param {{place?: object|null, weather?: object|null, news?: {status: string}|null}} [sources] the three source outcomes
 * @returns {boolean} whether the brief should be served at all
 */
export function regionalBriefHasAnySource({ place, weather, news } = {}) {
  return Boolean(place || weather || (news && news.status !== 'unavailable'));
}

/**
 * Compose the client-facing brief payload (the dev contract, verbatim):
 * `ready` when every source landed, `partial` otherwise; per-source status
 * fields stay explicit so empty and unavailable remain distinguishable.
 * @param {{latitude: number, longitude: number}} point validated coordinates
 * @param {object|null} place normalized place or null
 * @param {object|null} weather normalized weather or null
 * @param {{status: string, query: string|null, articles: object[], source: string|null}} news news outcome
 * @param {() => number} now clock
 * @returns {object} the cached payload (status field is 'ready'|'partial' here)
 */
export function buildRegionalBriefPayload(point, place, weather, news, now = Date.now) {
  return {
    status: place && weather && news.status !== 'unavailable' ? 'ready' : 'partial',
    retrievedAt: new Date(now()).toISOString(),
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
}

/**
 * Resolve one /api/regional-brief request — the ENTIRE contract, shared
 * verbatim by the dev middleware and the Pages Function. Dependencies are
 * injected so tests run with no network, clock, or server.
 *
 * Contract (both runtimes):
 *   non-GET            → 405 {"error":"Method Not Allowed"}, no header
 *   bad coordinates    → 400 {"error":"Valid latitude and longitude are required"}, no header
 *   cache hit (5 min)  → 200 payload with status:'cached',
 *                        X-Regional-Brief: HIT, public max-age=60
 *   refreshed          → 200 payload with status:'ready'|'partial',
 *                        X-Regional-Brief: MISS (this request went upstream)
 *                        or INFLIGHT (joined a concurrent refresh)
 *   refresh failure with a fresh-enough entry → 200 payload with status:'stale',
 *                        X-Regional-Brief: STALE, no-store
 *   refresh failure, no stale entry → 503
 *                        {"error":"Regional briefing is temporarily unavailable"}, no-store
 * Rate limiting is the adapter's job (per-runtime limiter, clientKey).
 *
 * @param {object} deps injected request context — everything varies per test
 * @param {string} [deps.method] request method (default GET)
 * @param {URLSearchParams} deps.searchParams request query (latitude, longitude)
 * @param {Map<string,{payload: object, cachedAt: number}>} deps.cache per-isolate result cache
 * @param {Map<string,Promise<object>>} deps.inFlight single-flight refresh map
 * @param {ReturnType<typeof createNominatimPacing>} [deps.pacing] Nominatim pacing slot
 * @param {() => number} [deps.now] clock (Date.now in production)
 * @param {typeof fetch} [deps.fetchImpl] upstream fetch
 * @returns {Promise<{status: number, payload: object, cacheState: 'HIT'|'INFLIGHT'|'MISS'|'STALE'|'NONE', cacheControl: 'public, max-age=60'|'no-store'|null}>}
 *   the response triple the caller writes straight to the wire
 */
export async function resolveRegionalBriefRequest({
  method = 'GET',
  searchParams,
  cache,
  inFlight,
  pacing = sharedPacing,
  now = () => Date.now(),
  fetchImpl = fetch,
}) {
  if (method !== 'GET') {
    return { status: 405, payload: { error: 'Method Not Allowed' }, cacheState: 'NONE', cacheControl: 'no-store' };
  }
  const point = validRegionalPoint(searchParams);
  if (!point) {
    return { status: 400, payload: { error: 'Valid latitude and longitude are required' }, cacheState: 'NONE', cacheControl: 'no-store' };
  }

  const key = regionalPointCacheKey(point);
  const at = now();
  const cached = cache.get(key);
  if (cached && at - cached.cachedAt <= REGIONAL_BRIEF_CACHE_MS) {
    return {
      status: 200,
      payload: { ...cached.payload, status: 'cached' },
      cacheState: 'HIT',
      cacheControl: 'public, max-age=60',
    };
  }

  const pending = inFlight.get(key);
  if (pending) {
    try {
      return {
        status: 200,
        payload: await pending,
        cacheState: 'INFLIGHT',
        cacheControl: 'public, max-age=60',
      };
    } catch {
      return serveStaleOrUnavailable(cached, at);
    }
  }

  const refresh = (async () => {
    const [placeResult, weatherResult] = await Promise.allSettled([
      fetchRegionalPlace(point, { fetchImpl, pacing }),
      fetchRegionalWeather(point, { fetchImpl }),
    ]);
    const place = placeResult.status === 'fulfilled' ? placeResult.value : null;
    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const news = await fetchRegionalNews(place, { fetchImpl });
    if (!regionalBriefHasAnySource({ place, weather, news })) {
      throw new Error('All regional briefing sources unavailable');
    }
    const payload = buildRegionalBriefPayload(point, place, weather, news, now);
    cache.set(key, { payload, cachedAt: now() });
    while (cache.size > REGIONAL_BRIEF_MAX_CACHE) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    return payload;
  })();
  inFlight.set(key, refresh);
  try {
    return {
      status: 200,
      payload: await refresh,
      cacheState: 'MISS',
      cacheControl: 'public, max-age=60',
    };
  } catch {
    return serveStaleOrUnavailable(cached, at);
  } finally {
    if (inFlight.get(key) === refresh) inFlight.delete(key);
  }
}

/**
 * The two failure tails of resolveRegionalBriefRequest: serve the cached
 * payload as `stale` inside the revalidate window, else 503.
 * @param {{payload: object, cachedAt: number}|undefined} cached prior cache entry
 * @param {number} at request timestamp
 * @returns {{status: number, payload: object, cacheState: string, cacheControl: string}} the stale-serve or 503 response triple
 */
function serveStaleOrUnavailable(cached, at) {
  if (cached && at - cached.cachedAt <= REGIONAL_BRIEF_STALE_MS) {
    return {
      status: 200,
      payload: { ...cached.payload, status: 'stale' },
      cacheState: 'STALE',
      cacheControl: 'no-store',
    };
  }
  return {
    status: 503,
    payload: { error: 'Regional briefing is temporarily unavailable' },
    cacheState: 'NONE',
    cacheControl: 'no-store',
  };
}
