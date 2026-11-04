import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { isUnavailableCapability } from '../../sources/capability.js';
import {
  normalizeFeedPayload,
  normalizeHotspotsPayload,
  normalizeOutlinePayload,
} from './records.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the layer shows them translated.
const msg = (text) => text;

const MAX_BYTES = 4 * 1024 * 1024;
const BASE_PATH = '/api/news';
// The outline geometry version the client draws (disputed areas included).
const OUTLINE_VERSION = '4';

/** The three read routes the news layer calls, for a host's path allowlist. */
export const NEWS_API_PATHS = Object.freeze([
  `${BASE_PATH}/hotspots`,
  `${BASE_PATH}/feed`,
  `${BASE_PATH}/outline`,
]);

const FEED_KEYS = Object.freeze([
  'hotspot',
  'before',
  'since',
  'limit',
  'category',
  'relevance',
]);
const FLAG_KEYS = Object.freeze(['geo', 'today', 'events']);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const LIST = /^[a-z][a-z,-]{0,127}$/;
const FEED_VALUE = {
  hotspot: (v) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(v),
  before: (v) => ISO.test(v),
  since: (v) => ISO.test(v),
  limit: (v) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 500,
  category: (v) => LIST.test(v),
  relevance: (v) => LIST.test(v),
};

/** Feed query string from a plain object; unknown keys and empty values are dropped. */
export function newsFeedQuery(query = {}) {
  const params = new URLSearchParams();
  for (const key of FEED_KEYS) {
    const value = query[key];
    if (value !== undefined && value !== null && value !== '')
      params.set(key, String(value));
  }
  for (const key of FLAG_KEYS) if (query[key]) params.set(key, '1');
  return params.toString();
}

/**
 * Whether a request URL is one this client sends: a known route, known keys
 * only, each value in its form. A host proxying the routes can admit exactly
 * these and refuse the rest.
 * @param {URL} url
 */
export function newsQueryAllowed(url) {
  const params = [...url.searchParams];
  if (new Set(params.map(([key]) => key)).size !== params.length) return false;
  if (url.pathname === `${BASE_PATH}/hotspots`)
    return (
      params.length === 0 ||
      (params.length === 1 &&
        params[0][0] === 'hours' &&
        /^\d{1,2}$/.test(params[0][1]) &&
        Number(params[0][1]) >= 1 &&
        Number(params[0][1]) <= 24)
    );
  if (url.pathname === `${BASE_PATH}/outline`) {
    const keys = params.map(([key]) => key).sort();
    const value = url.searchParams;
    return (
      params.length === 2 &&
      keys[1] === 'v' &&
      value.get('v') === OUTLINE_VERSION &&
      ((keys[0] === 'hotspot' && FEED_VALUE.hotspot(value.get('hotspot'))) ||
        (keys[0] === 'country' &&
          /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(value.get('country'))))
    );
  }
  if (url.pathname !== `${BASE_PATH}/feed`) return false;
  return params.every(([key, value]) =>
    FLAG_KEYS.includes(key)
      ? value === '1'
      : Object.hasOwn(FEED_VALUE, key) && FEED_VALUE[key](value),
  );
}

/** A failed read: a server without the news routes is a permanent miss. */
async function responseError(response) {
  let body = null;
  try {
    body = await readResponseJsonCapped(response, 16 * 1024);
  } catch {
    await response.body?.cancel?.().catch?.(() => {});
  }
  const unavailable =
    response.status === 404 ||
    (response.status === 503 && isUnavailableCapability(body));
  return Object.assign(
    new Error(
      unavailable
        ? msg('News feed not configured on this server')
        : msg('News feed unavailable'),
    ),
    {
      status: response.status,
      code: unavailable ? 'unavailable' : 'http',
      unavailable,
      retryable: !unavailable,
    },
  );
}

/** Read hotspots, reports and outlines from the server's /api/news routes. */
export function createNewsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  async function get(path, { signal } = {}) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const request = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(`${BASE_PATH}${path}`, {
      signal: request,
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) throw await responseError(response);
    return readResponseJsonCapped(response, MAX_BYTES, request);
  }
  return {
    // `hours` asks for counts over a shorter window than the server's own.
    async getHotspots({ signal, hours } = {}) {
      const payload = normalizeHotspotsPayload(
        await get(hours ? `/hotspots?hours=${hours}` : '/hotspots', {
          signal,
        }),
      );
      if (!payload) throw new Error(msg('Malformed news hotspots response'));
      return payload;
    },
    async getOutline(hotspotId, { signal } = {}) {
      return normalizeOutlinePayload(
        await get(
          `/outline?hotspot=${encodeURIComponent(hotspotId)}&v=${OUTLINE_VERSION}`,
          { signal },
        ),
      );
    },
    async getCountryOutline(country, { signal } = {}) {
      return normalizeOutlinePayload(
        await get(
          `/outline?country=${encodeURIComponent(country)}&v=${OUTLINE_VERSION}`,
          { signal },
        ),
      );
    },
    async getFeed(query = {}, { signal } = {}) {
      const payload = normalizeFeedPayload(
        await get(`/feed?${newsFeedQuery(query)}`, { signal }),
      );
      if (!payload) throw new Error(msg('Malformed news feed response'));
      return payload;
    },
  };
}
