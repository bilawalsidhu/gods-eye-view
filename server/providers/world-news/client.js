import { readResponseJsonCapped } from '../common/http.js';
import { parseWorldNewsQuota } from '../../../src/data/worldNewsArticles.js';

/** Fixed upstream; the client never fetches a caller-supplied URL. */
export const WORLD_NEWS_API_ORIGIN = 'https://api.worldnewsapi.com';
export const WORLD_NEWS_SEARCH_PATH = '/search-news';
export const WORLD_NEWS_UPSTREAM_TIMEOUT_MS = 20_000;
/** Full article bodies ride along until the provider offers a compact form. */
export const WORLD_NEWS_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Query keys the proxy owns; WORLD_NEWS_EXTRA_QUERY may not override them. */
const RESERVED_QUERY_KEYS = new Set([
  'number',
  'offset',
  'sort',
  'sort-direction',
  'add-entities',
  'earliest-publish-date',
  'language',
  'api-key',
]);

const UPSTREAM_CODES = Object.freeze({
  401: 'bad_key',
  403: 'bad_key',
  402: 'quota',
  429: 'rate_limited',
});

/**
 * The provider's date format: "YYYY-MM-DD HH:MM:SS" in UTC.
 * @param {number} epochMs
 * @returns {string}
 */
export function formatWorldNewsDate(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parse WORLD_NEWS_EXTRA_QUERY ("a=b&c=d") into pairs, dropping keys the proxy
 * owns. Lets an operator adopt future provider parameters (a location-only
 * filter, a compact field list) without a code change.
 * @param {unknown} raw
 * @returns {Array<[string, string]>}
 */
export function parseExtraQuery(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const pairs = [];
  for (const [key, value] of new URLSearchParams(text)) {
    const name = key.trim();
    if (!name || RESERVED_QUERY_KEYS.has(name.toLowerCase())) continue;
    pairs.push([name, value]);
  }
  return pairs;
}

/**
 * Build one search-news request URL. Never carries the key (header auth).
 * @param {object} options
 * @param {number} options.number Results per page (1–100).
 * @param {number} options.offset Result offset.
 * @param {string} [options.language] ISO 639-1 code; empty means all.
 * @param {number} [options.sinceMs] Earliest publish time to include.
 * @param {string} [options.extraQuery] WORLD_NEWS_EXTRA_QUERY value.
 * @returns {string}
 */
export function buildSearchNewsUrl({
  number,
  offset = 0,
  language = '',
  sinceMs,
  extraQuery = '',
}) {
  const params = new URLSearchParams();
  params.set('number', String(number));
  params.set('offset', String(offset));
  params.set('sort', 'publish-time');
  params.set('sort-direction', 'DESC');
  params.set('add-entities', 'true');
  if (language) params.set('language', language);
  if (Number.isFinite(sinceMs))
    params.set('earliest-publish-date', formatWorldNewsDate(sinceMs));
  for (const [key, value] of parseExtraQuery(extraQuery))
    params.set(key, value);
  return `${WORLD_NEWS_API_ORIGIN}${WORLD_NEWS_SEARCH_PATH}?${params}`;
}

/** Upstream failure with a stable `code` the proxy maps to client states. */
export class WorldNewsUpstreamError extends Error {
  constructor(
    message,
    { code = 'upstream', status = null, quota = null } = {},
  ) {
    super(message);
    this.name = 'WorldNewsUpstreamError';
    this.code = code;
    this.status = status;
    this.quota = quota;
  }
}

/**
 * One search-news request. The key travels only in the x-api-key header, so
 * no URL or log line ever carries it. Resolves the raw article list plus the
 * provider's quota headers; throws WorldNewsUpstreamError otherwise.
 * @param {object} options
 * @param {string} options.key Provider API key.
 * @param {string} options.url From buildSearchNewsUrl.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @returns {Promise<{news: Array<object>, available: number|null,
 *   quota: {request: number|null, used: number|null, left: number|null}}>}
 */
export async function requestSearchNews({
  key,
  url,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = WORLD_NEWS_UPSTREAM_TIMEOUT_MS,
  maxBytes = WORLD_NEWS_MAX_RESPONSE_BYTES,
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'x-api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new WorldNewsUpstreamError(
      error?.name === 'TimeoutError'
        ? 'upstream timed out'
        : 'upstream unreachable',
    );
  }
  const quota = parseWorldNewsQuota(response.headers);
  if (!response.ok) {
    void response.body?.cancel?.().catch?.(() => {});
    throw new WorldNewsUpstreamError(`upstream HTTP ${response.status}`, {
      code: UPSTREAM_CODES[response.status] || 'upstream',
      status: response.status,
      quota,
    });
  }
  let body;
  try {
    body = await readResponseJsonCapped(response, maxBytes);
  } catch (error) {
    throw new WorldNewsUpstreamError(
      error?.code === 'RESPONSE_TOO_LARGE'
        ? 'upstream body too large'
        : 'upstream body unreadable',
      { status: response.status, quota },
    );
  }
  if (!Array.isArray(body?.news))
    throw new WorldNewsUpstreamError('malformed upstream body', {
      status: response.status,
      quota,
    });
  return {
    news: body.news,
    available: Number.isFinite(body.available) ? body.available : null,
    quota,
  };
}
