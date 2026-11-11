// The keyed news APIs Core reads itself when no news server is configured:
// Liveuamap's worldwide feed (`a=mpts`) beside GDELT's events in the
// Conflicts section (gdeltEvents.js), World News API's search by source
// country for Local. Each key stays on the server: Liveuamap's rides in the query, so
// neither a URL nor an error body is ever logged or relayed.

import { readResponseTextCapped } from '../common/http.js';

const LIVEUAMAP_URL = 'https://a.liveuamap.com/api';
const WORLD_NEWS_URL = 'https://api.worldnewsapi.com/search-news';
// 100 Liveuamap items run to about 500 KB.
const LIVEUAMAP_COUNT = 500;
const LIVEUAMAP_MAX_BYTES = 16 * 1024 * 1024;
// One search per country: a point, and a hundredth of one per article, so
// about 1.5 points a read (the free plan has 50 points a day).
const WORLD_NEWS_ARTICLES = 50;
const WORLD_NEWS_MAX_BYTES = 8 * 1024 * 1024;
// World News API's categories that are not the news of the day. Its
// `categories` filter is not asked for: it classifies few articles outside
// English, so it would drop most of a country's own outlets; an article it
// left unclassified is kept.
export const WORLD_NEWS_LEFT_OUT = Object.freeze(
  new Set(['sports', 'entertainment', 'lifestyle', 'travel']),
);
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 20_000;

const ENTITIES = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

/** Text with HTML entities decoded and whitespace collapsed, or ''. */
export function unescapeHtml(value) {
  return String(value ?? '')
    .replace(
      /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi,
      (all, dec, hex, name) => {
        if (name) return ENTITIES[name.toLowerCase()] ?? all;
        const code = dec ? Number(dec) : parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** An https URL without credentials, or null. */
export function webLink(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** A clip a browser plays itself (an https MP4 or WebM file), or null. */
export function playableVideo(value) {
  const url = webLink(value);
  return url && /\.(?:mp4|m4v|webm)$/i.test(new URL(url).pathname) ? url : null;
}

const finiteNumber = (value) => {
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};

/** Why an upstream could not be read; never carries its URL or body. */
export class UpstreamError extends Error {
  constructor(
    message,
    {
      status = null,
      rejected = false,
      quota = false,
      unreadable = false,
      unreached = false,
    } = {},
  ) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    // The key was refused (401 or 403): the operator's to fix.
    this.rejected = rejected;
    // The key's allowance is spent (402, or the day's reads): it answers
    // again later. A 429 is a per-second limit, not this.
    this.quota = quota;
    // The answer itself cannot be read (corrupt, or over a size cap): asking
    // again gets the same.
    this.unreadable = unreadable;
    // The request got no answer at all (offline, timed out).
    this.unreached = unreached;
  }
}

async function getText(
  fetchImpl,
  url,
  { headers = {}, maxBytes, signal, what },
) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', ...headers },
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    // A request that timed out may have been read; one refused was not.
    const timedOut = cause?.name === 'TimeoutError';
    throw new UpstreamError(
      timedOut ? `${what} timed out` : `${what} unreachable`,
      { unreached: !timedOut },
    );
  }
  if (!response.ok) {
    await response.body?.cancel?.().catch?.(() => {});
    throw new UpstreamError(`${what} answered ${response.status}`, {
      status: response.status,
      rejected: response.status === 401 || response.status === 403,
      quota: response.status === 402,
    });
  }
  try {
    return await readResponseTextCapped(response, maxBytes, signal);
  } catch {
    throw new UpstreamError(`${what} answer unreadable`);
  }
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    // Not the parser's message: an error answer may echo the request.
    throw new UpstreamError(`${what} answer unreadable`);
  }
}

/**
 * Liveuamap's items with a headline, a point and a page:
 * `{id, title, lat, lon, place, publishedAt, url, image, video}`.
 */
export function parseLiveuamap(payload) {
  if (!Array.isArray(payload?.venues))
    throw new UpstreamError('Liveuamap answer unreadable');
  const items = [];
  for (const venue of payload.venues) {
    const id = finiteNumber(venue?.id);
    const title = unescapeHtml(venue?.name);
    const lat = finiteNumber(venue?.lat);
    const lon = finiteNumber(venue?.lng);
    const seconds = finiteNumber(venue?.timestamp);
    const url = webLink(venue?.link);
    if (
      id === null ||
      !title ||
      lat === null ||
      lon === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      (lat === 0 && lon === 0) ||
      seconds === null ||
      !url
    )
      continue;
    items.push({
      id: Math.trunc(id),
      title,
      lat,
      lon,
      place: unescapeHtml(venue.location) || null,
      publishedAt: new Date(seconds * 1000).toISOString(),
      url,
      image: webLink(venue.img_share),
      video: playableVideo(venue.video),
    });
  }
  return items;
}

/** The worldwide feed of the last day, as of `now`. */
export async function fetchLiveuamap({ key, fetchImpl, now, signal }) {
  const url = new URL(LIVEUAMAP_URL);
  url.search = new URLSearchParams({
    a: 'mpts',
    resid: '1',
    time: String(Math.floor((now - DAY_MS) / 1000)),
    count: String(LIVEUAMAP_COUNT),
    key,
  }).toString();
  const text = await getText(fetchImpl, url, {
    maxBytes: LIVEUAMAP_MAX_BYTES,
    signal,
    what: 'Liveuamap',
  });
  return parseLiveuamap(parseJson(text, 'Liveuamap'));
}

// World News API writes times as "2026-10-30 01:31:00", in UTC.
const worldNewsTime = (ms) =>
  new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
function worldNewsDate(value) {
  const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)$/.exec(
    String(value ?? ''),
  );
  const ms = match ? Date.parse(`${match[1]}T${match[2]}Z`) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A search's articles with a title, a link and a time, one per title (the
 * same story from several outlets is one), sport and entertainment left
 * out, newest first:
 * `{id, title, url, publisher, language, category, publishedAt, image, video}`.
 */
export function parseWorldNews(payload) {
  if (!Array.isArray(payload?.news))
    throw new UpstreamError('World News API answer unreadable');
  const seen = new Set();
  const articles = [];
  for (const article of payload.news) {
    const id = finiteNumber(article?.id);
    const title = unescapeHtml(article?.title);
    const url = webLink(article?.url);
    const publishedAt = worldNewsDate(article?.publish_date);
    const category =
      typeof article?.category === 'string'
        ? article.category.toLowerCase()
        : null;
    if (id === null || !title || !url || !publishedAt) continue;
    if (WORLD_NEWS_LEFT_OUT.has(category)) continue;
    const same = title.toLowerCase();
    if (seen.has(same)) continue;
    seen.add(same);
    articles.push({
      id: Math.trunc(id),
      title,
      url,
      publisher: new URL(url).hostname.replace(/^www\./, ''),
      language:
        typeof article.language === 'string' &&
        /^[a-z]{2}$/i.test(article.language)
          ? article.language.toLowerCase()
          : null,
      category,
      publishedAt,
      image: webLink(article.image),
      video: playableVideo(article.video),
    });
  }
  return articles.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/** A country's everyday news of the last day, as of `now`. */
export async function fetchWorldNews({ key, country, fetchImpl, now, signal }) {
  const url = new URL(WORLD_NEWS_URL);
  url.search = new URLSearchParams({
    'source-country': country.toLowerCase(),
    // Both ends: sorted by time with neither, a search is cut to 31 days.
    'earliest-publish-date': worldNewsTime(now - DAY_MS),
    'latest-publish-date': worldNewsTime(now),
    sort: 'publish-time',
    'sort-direction': 'DESC',
    number: String(WORLD_NEWS_ARTICLES),
  }).toString();
  const text = await getText(fetchImpl, url, {
    headers: { 'x-api-key': key },
    maxBytes: WORLD_NEWS_MAX_BYTES,
    signal,
    what: 'World News API',
  });
  return parseWorldNews(parseJson(text, 'World News API'));
}
