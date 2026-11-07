import { fetchRegionalText, fetchRegionalJson } from './http.js';
import {
  REGIONAL_NEWS_WINDOW_HOURS,
  googleNewsWindowOperator,
  normalizeRegionalArticles,
  recentRegionalArticles,
} from '../../../src/data/regionalModel.js';

function decodeRssText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rssTag(block, tag) {
  return decodeRssText(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(
      block,
    )?.[1] || '',
  );
}

// Feed items read before the window filter; Google returns about 100.
const RSS_ITEM_CAP = 100;

function normalizeRssArticles(xml, limit = RSS_ITEM_CAP) {
  const seen = new Set();
  const articles = [];
  for (const match of String(xml || '').matchAll(
    /<item>([\s\S]*?)<\/item>/gi,
  )) {
    const item = match[1];
    const title = rssTag(item, 'title').slice(0, 180);
    const url = rssTag(item, 'link');
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
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
      publishedAt: Number.isNaN(Date.parse(rawDate))
        ? null
        : new Date(rawDate).toISOString(),
      sourceCountry: null,
    });
    if (articles.length >= limit) break;
  }
  return articles;
}

/**
 * Headlines for a place from the last REGIONAL_NEWS_WINDOW_HOURS, newest
 * first: Google News RSS, then GDELT when RSS fails or has nothing recent.
 * `empty` means a source answered with nothing in the window; `unavailable`
 * means there was no place or no source answered.
 * @param {{locality?: string, region?: string, country?: string}|null} place
 * @param {{now?: () => number}} [options]
 */
async function fetchRegionalNews(place, { now = Date.now } = {}) {
  const query = place?.locality || place?.region || place?.country;
  if (!query)
    return { status: 'unavailable', query: null, articles: [], source: null };
  const recent = (articles) =>
    recentRegionalArticles(articles, {
      now: now(),
      windowHours: REGIONAL_NEWS_WINDOW_HOURS,
      limit: 5,
    });
  let answered = false;
  const rssParams = new URLSearchParams({
    q: `${String(query).replace(/["\\]/g, ' ').trim()} ${googleNewsWindowOperator()}`,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  try {
    const xml = await fetchRegionalText(
      `https://news.google.com/rss/search?${rssParams}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    answered = true;
    const articles = recent(normalizeRssArticles(xml));
    if (articles.length)
      return { status: 'ready', query, articles, source: 'Google News RSS' };
  } catch {
    /* fall through to the existing free index */
  }
  const params = new URLSearchParams({
    query: `"${String(query).replace(/["\\]/g, ' ').trim()}"`,
    mode: 'artlist',
    format: 'json',
    maxrecords: '5',
    sort: 'datedesc',
    timespan: `${REGIONAL_NEWS_WINDOW_HOURS}h`,
  });
  try {
    const payload = await fetchRegionalJson(
      `https://api.gdeltproject.org/api/v2/doc/doc?${params}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    const articles = recent(normalizeRegionalArticles(payload, 5));
    return {
      status: articles.length ? 'ready' : 'empty',
      query,
      articles,
      source: 'GDELT fallback',
    };
  } catch {
    // An RSS answer with nothing recent is still a true empty result.
    return answered
      ? { status: 'empty', query, articles: [], source: 'Google News RSS' }
      : { status: 'unavailable', query, articles: [], source: null };
  }
}

export { fetchRegionalNews };
