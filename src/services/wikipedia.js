/**
 * Wikipedia spatial intelligence and article lookup service.
 * Connects to MediaWiki Geosearch API and Wikipedia REST Summary API.
 * Free, keyless, CORS-enabled endpoints.
 */

const WIKIPEDIA_USER_AGENT =
  'GodsEyeView/1.0 (https://github.com/bilawalsidhu/gods-eye-view)';

const CACHE_TTL_MS = 5 * 60 * 1000;
const nearbyCache = new Map();
const summaryCache = new Map();
const pendingNearby = new Map();
const pendingSummaries = new Map();

let inFlightRequests = 0;
const MAX_CONCURRENT_REQUESTS = 4;
const pendingQueue = [];

async function acquireRequestSlot() {
  if (inFlightRequests < MAX_CONCURRENT_REQUESTS) {
    inFlightRequests++;
    return;
  }
  await new Promise((resolve) => pendingQueue.push(resolve));
}

function releaseRequestSlot() {
  if (pendingQueue.length > 0) {
    const next = pendingQueue.shift();
    next();
  } else {
    inFlightRequests = Math.max(0, inFlightRequests - 1);
  }
}

async function executeWikipediaFetch(url, options, fetchImpl) {
  await acquireRequestSlot();
  try {
    return await fetchImpl(url, options);
  } finally {
    releaseRequestSlot();
  }
}

function sanitizeCoordinate(value, min, max, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new TypeError(`Valid ${label} between ${min} and ${max} is required`);
  }
  return num;
}

/**
 * Fetch Wikipedia articles geographically close to a coordinate point.
 * @param {object} options
 * @param {number} options.latitude - Latitude in degrees [-90, 90]
 * @param {number} options.longitude - Longitude in degrees [-180, 180]
 * @param {number} [options.radius=10000] - Search radius in meters (10 to 10000)
 * @param {number} [options.limit=10] - Maximum number of results (1 to 50)
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @param {Function} [options.fetchImpl=fetch] - Fetch implementation
 * @returns {Promise<Array<{pageId: number, title: string, latitude: number, longitude: number, distanceMeters: number, primary: boolean}>>}
 */
export async function fetchWikipediaNearby({
  latitude,
  longitude,
  radius = 10000,
  limit = 10,
  signal,
  fetchImpl = fetch,
} = {}) {
  const lat = sanitizeCoordinate(latitude, -90, 90, 'latitude');
  const lon = sanitizeCoordinate(longitude, -180, 180, 'longitude');
  const clampedRadius = Math.min(
    10000,
    Math.max(10, Math.round(Number(radius) || 10000)),
  );
  const clampedLimit = Math.min(
    50,
    Math.max(1, Math.round(Number(limit) || 10)),
  );

  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${clampedRadius},${clampedLimit}`;
  const cached = nearbyCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  if (pendingNearby.has(cacheKey)) {
    const existing = pendingNearby.get(cacheKey);
    if (!signal) return existing;
    if (signal.aborted) {
      throw signal.reason || new DOMException('Aborted', 'AbortError');
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort);
      existing.then(
        (val) => {
          signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  const params = new URLSearchParams({
    action: 'query',
    list: 'geosearch',
    gscoord: `${lat.toFixed(5)}|${lon.toFixed(5)}`,
    gsradius: String(clampedRadius),
    gslimit: String(clampedLimit),
    format: 'json',
    origin: '*',
  });

  const fetchPromise = (async () => {
    try {
      const response = await executeWikipediaFetch(
        `https://en.wikipedia.org/w/api.php?${params}`,
        {
          signal,
          headers: {
            Accept: 'application/json',
            'Api-User-Agent': WIKIPEDIA_USER_AGENT,
          },
        },
        fetchImpl,
      );

      if (!response.ok) {
        throw new Error(`Wikipedia geosearch unavailable (${response.status})`);
      }

      const payload = await response.json();
      const rawList = payload?.query?.geosearch;
      if (!Array.isArray(rawList)) {
        nearbyCache.set(cacheKey, { data: [], timestamp: Date.now() });
        return [];
      }

      const results = rawList.map((entry) => ({
        pageId: entry.pageid,
        title: String(entry.title || ''),
        latitude: entry.lat,
        longitude: entry.lon,
        distanceMeters: entry.dist,
        primary: entry.primary !== undefined,
      }));
      nearbyCache.set(cacheKey, { data: results, timestamp: Date.now() });
      return results;
    } finally {
      pendingNearby.delete(cacheKey);
    }
  })();

  pendingNearby.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * Fetch Wikipedia article summary (extract, thumbnail, description, URL).
 * @param {string} title - Page title
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.fetchImpl=fetch]
 * @returns {Promise<object|null>}
 */
export async function fetchWikipediaSummary(
  title,
  { signal, fetchImpl = fetch } = {},
) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return null;

  const cacheKey = cleanTitle.toLowerCase();
  const cached = summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  if (pendingSummaries.has(cacheKey)) {
    const existing = pendingSummaries.get(cacheKey);
    if (!signal) return existing;
    if (signal.aborted) {
      throw signal.reason || new DOMException('Aborted', 'AbortError');
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort);
      existing.then(
        (val) => {
          signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  const endpoint = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanTitle.replace(/ /g, '_'))}`;
  const fetchPromise = (async () => {
    try {
      const response = await executeWikipediaFetch(
        endpoint,
        {
          signal,
          headers: {
            Accept: 'application/json',
            'Api-User-Agent': WIKIPEDIA_USER_AGENT,
          },
        },
        fetchImpl,
      );

      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Wikipedia summary unavailable (${response.status})`);
      }

      const data = await response.json();
      const summary = {
        pageId: data.pageid ?? null,
        title: data.title || cleanTitle,
        displayTitle: data.displaytitle || cleanTitle,
        description: data.description || '',
        extract: data.extract || '',
        thumbnail: data.thumbnail?.source || null,
        pageUrl:
          data.content_urls?.desktop?.page ||
          `https://en.wikipedia.org/wiki/${encodeURIComponent(cleanTitle)}`,
        coordinates: data.coordinates
          ? { latitude: data.coordinates.lat, longitude: data.coordinates.lon }
          : null,
      };
      summaryCache.set(cacheKey, { data: summary, timestamp: Date.now() });
      return summary;
    } finally {
      pendingSummaries.delete(cacheKey);
    }
  })();

  pendingSummaries.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * Search Wikipedia for general queries, acronyms, or landmarks.
 * @param {string} query - Search term
 * @param {object} [options]
 * @param {number} [options.limit=5]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.fetchImpl=fetch]
 * @returns {Promise<Array<{pageId: number, title: string, snippet: string, wordCount: number}>>}
 */
export async function searchWikipedia(
  query,
  { limit = 5, signal, fetchImpl = fetch } = {},
) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const clampedLimit = Math.min(
    20,
    Math.max(1, Math.round(Number(limit) || 5)),
  );
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: cleanQuery,
    srlimit: String(clampedLimit),
    format: 'json',
    origin: '*',
  });

  const response = await executeWikipediaFetch(
    `https://en.wikipedia.org/w/api.php?${params}`,
    {
      signal,
      headers: {
        Accept: 'application/json',
        'Api-User-Agent': WIKIPEDIA_USER_AGENT,
      },
    },
    fetchImpl,
  );

  if (!response.ok) {
    throw new Error(`Wikipedia search unavailable (${response.status})`);
  }

  const payload = await response.json();
  const rawResults = payload?.query?.search;
  if (!Array.isArray(rawResults)) return [];

  return rawResults.map((r) => ({
    pageId: r.pageid,
    title: String(r.title || ''),
    snippet: String(r.snippet || '').replace(/<[^>]+>/g, ''),
    wordCount: r.wordcount || 0,
  }));
}

/**
 * Fetch a unified spatial/acronym intelligence brief from Wikipedia.
 * @param {object} options
 * @param {string} [options.query]
 * @param {number} [options.latitude]
 * @param {number} [options.longitude]
 * @param {number} [options.radius=10000]
 * @param {number} [options.limit=5]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.fetchImpl=fetch]
 * @returns {Promise<object>}
 */
export async function fetchWikipediaBrief({
  query = '',
  latitude = null,
  longitude = null,
  radius = 10000,
  limit = 5,
  signal,
  fetchImpl = fetch,
} = {}) {
  let article = null;
  let nearby = [];

  const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude);

  if (hasCoords) {
    try {
      nearby = await fetchWikipediaNearby({
        latitude,
        longitude,
        radius,
        limit,
        signal,
        fetchImpl,
      });
      if (nearby.length > 0 && !query) {
        article = await fetchWikipediaSummary(nearby[0].title, {
          signal,
          fetchImpl,
        });
      }
    } catch {
      // Coordinate fallback continues
    }
  }

  if (query) {
    try {
      article = await fetchWikipediaSummary(query, { signal, fetchImpl });
      if (!article) {
        const searchHits = await searchWikipedia(query, {
          limit: 1,
          signal,
          fetchImpl,
        });
        if (searchHits.length > 0) {
          article = await fetchWikipediaSummary(searchHits[0].title, {
            signal,
            fetchImpl,
          });
        }
      }
    } catch {
      // Text fallback continues
    }
  }

  return {
    query: String(query || '').trim(),
    latitude: hasCoords ? Number(latitude) : null,
    longitude: hasCoords ? Number(longitude) : null,
    article,
    nearby,
  };
}

export function createWikipediaService({
  fetchImpl = fetch,
  signal: lifetimeSignal,
} = {}) {
  const resolveSignal = (optionsSignal) => {
    if (optionsSignal && lifetimeSignal) {
      if (typeof AbortSignal?.any === 'function') {
        return AbortSignal.any([lifetimeSignal, optionsSignal]);
      }
      return optionsSignal;
    }
    return optionsSignal || lifetimeSignal;
  };

  return {
    fetchNearby: (options = {}) =>
      fetchWikipediaNearby({
        fetchImpl,
        ...options,
        signal: resolveSignal(options.signal),
      }),
    fetchSummary: (title, options = {}) =>
      fetchWikipediaSummary(title, {
        fetchImpl,
        ...options,
        signal: resolveSignal(options.signal),
      }),
    search: (query, options = {}) =>
      searchWikipedia(query, {
        fetchImpl,
        ...options,
        signal: resolveSignal(options.signal),
      }),
    fetchBrief: (options = {}) =>
      fetchWikipediaBrief({
        fetchImpl,
        ...options,
        signal: resolveSignal(options.signal),
      }),
  };
}
