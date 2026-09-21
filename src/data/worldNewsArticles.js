/**
 * World News API article normalization for the /api/world-news proxy.
 *
 * Pure and Node-safe (no Cesium, no I/O) so the proxy and its tests share one
 * definition — the role src/data/firmsCsv.js plays for FIRMS. The provider
 * returns whole articles (body text, images, bylines) and, with
 * `add-entities=true`, an `entities[]` list whose location entries carry
 * geocoded coordinates. Only the compact, place-bearing record built here
 * ever leaves the server: no article text, no author names and no person or
 * organization entities. The publisher's image URL is opt-in
 * (`{thumbnails: true}`, wired to WORLD_NEWS_THUMBNAILS) and https-only; it
 * is a link for the browser to resolve, never an image this server fetches.
 */

/** Entity types the provider uses for places; matched case-insensitively. */
const LOCATION_TYPES = new Set(['LOC', 'LOCATION', 'GPE', 'PLACE']);

export const WORLD_NEWS_TITLE_MAX_CHARS = 200;
export const WORLD_NEWS_PLACE_MAX_CHARS = 120;
/** Documented request cost and per-result share (worldnewsapi.com/docs). */
export const WORLD_NEWS_REQUEST_POINTS = 1;
export const WORLD_NEWS_POINTS_PER_RESULT = 0.01;
/**
 * Extra per-result share charged for `add-entities=true`, measured against the
 * live provider on 2026-09-20 (X-API-Quota-Request, 1000-point plan):
 *
 *   number=100, entities off -> 2.0 points   (1 + 0.01 * 100)
 *   number=100, entities on  -> 12.0 points  (1 + 0.11 * 100)
 *   number=2,   entities on  -> 1.22 points  (1 + 0.11 * 2)
 *
 * Every search this proxy makes asks for entities, because the location
 * entities ARE the place tags — without them a headline cannot be pinned. So
 * the surcharge is unavoidable and belongs in the estimate: charging the
 * entity-free rate understated a full page by 6x, which let the daily budget
 * guard authorize six times the points it thought it was spending.
 */
export const WORLD_NEWS_ENTITY_POINTS_PER_RESULT = 0.1;

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function httpUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * https-only URL. A thumbnail is loaded by the browser on a page that is often
 * served over https, so an http image would be blocked as mixed content anyway
 * — rejecting it here keeps a dead URL out of the record entirely.
 */
function httpsUrl(value) {
  const url = httpUrl(value);
  return url && url.protocol === 'https:' ? url : null;
}

function finiteInRange(value, limit) {
  return Number.isFinite(value) && Math.abs(value) <= limit;
}

/**
 * Normalize the provider's publish date. The documented form is
 * "YYYY-MM-DD HH:MM:SS" in UTC; an explicit ISO offset is honored when present.
 * @param {unknown} raw Provider `publish_date`.
 * @returns {string|null} ISO-8601 UTC string, or null when unparseable.
 */
export function worldNewsPublishedIso(raw) {
  if (typeof raw !== 'string') return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      raw.trim(),
    );
  if (!match) return null;
  const zone = match[3]
    ? match[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
    : 'Z';
  const ms = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function mentionedInTitle(entity) {
  return String(entity.found_in || '')
    .toLowerCase()
    .split(/[\s,;|]+/)
    .includes('title');
}

/**
 * The place a headline names: a location entity mentioned in the title with
 * usable coordinates, most-mentioned first and the name as a deterministic
 * tie-break. Body-only mentions are ignored on purpose — a passing reference
 * must not pin a story to a city it is not about.
 * @param {unknown} entities Provider `entities[]` for one article.
 * @returns {object|null} The chosen entity, or null when none qualifies.
 */
export function topLocationEntity(entities) {
  if (!Array.isArray(entities)) return null;
  const usable = entities.filter(
    (entity) =>
      entity &&
      typeof entity === 'object' &&
      LOCATION_TYPES.has(String(entity.type || '').toUpperCase()) &&
      mentionedInTitle(entity) &&
      finiteInRange(entity.latitude, 90) &&
      finiteInRange(entity.longitude, 180),
  );
  usable.sort(
    (a, b) =>
      (Number(b.mentions) || 0) - (Number(a.mentions) || 0) ||
      String(a.name || '').localeCompare(String(b.name || '')),
  );
  return usable[0] || null;
}

/**
 * One provider article → one compact record, or null when the article has no
 * usable id, title, link or title-mentioned place.
 * @param {unknown} article Raw provider article.
 * @returns {object|null}
 */
export function normalizeWorldNewsArticle(
  article,
  { thumbnails = false } = {},
) {
  if (!article || typeof article !== 'object') return null;
  const rawId = article.id;
  const validId =
    (Number.isSafeInteger(rawId) && rawId >= 0) ||
    (typeof rawId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(rawId));
  const title = cleanText(article.title, WORLD_NEWS_TITLE_MAX_CHARS);
  const url = httpUrl(article.url);
  if (!validId || !title || !url) return null;
  const location = topLocationEntity(article.entities);
  if (!location) return null;
  const place = cleanText(location.name, WORLD_NEWS_PLACE_MAX_CHARS);
  if (!place) return null;
  const sentiment = Number(article.sentiment);
  return {
    id: `wn-${rawId}`,
    title,
    url: url.href,
    domain: url.hostname.replace(/^www\./, ''),
    publishedAt: worldNewsPublishedIso(article.publish_date),
    sentiment:
      article.sentiment != null && Number.isFinite(sentiment)
        ? Math.max(-1, Math.min(1, sentiment))
        : null,
    category: cleanText(article.category, 40),
    language: cleanText(article.language, 8),
    sourceCountry: cleanText(article.source_country, 8),
    lat: location.latitude,
    lon: location.longitude,
    place,
    placeFoundIn: 'title',
    placeMentions: Math.max(0, Math.floor(Number(location.mentions) || 0)),
    // Opt-in (WORLD_NEWS_THUMBNAILS) and https-only: the URL is a LINK the
    // browser resolves against the publisher, never an image this server
    // fetches, stores or re-serves. Absent unless asked for, so the default
    // record is byte-identical to the contract shipped without thumbnails.
    ...(thumbnails && httpsUrl(article.image)
      ? { image: httpsUrl(article.image).href }
      : {}),
  };
}

function newestFirst(a, b) {
  return (
    String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/**
 * Raw provider articles → compact, place-bearing records, newest first and
 * de-duplicated by provider id. Articles without a title-mentioned place are
 * dropped (the caller reports them as "unplaced").
 * @param {unknown} news Provider `news[]`.
 * @returns {Array<object>}
 */
export function normalizeWorldNewsArticles(news, options) {
  if (!Array.isArray(news)) return [];
  const seen = new Set();
  const records = [];
  for (const article of news) {
    const record = normalizeWorldNewsArticle(article, options);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  return records.sort(newestFirst);
}

/**
 * Read the provider's quota headers. Missing or non-numeric values are null.
 * @param {Headers|Record<string, unknown>|null|undefined} headers
 * @returns {{request: number|null, used: number|null, left: number|null}}
 */
export function parseWorldNewsQuota(headers) {
  const read = (name) => {
    let raw = null;
    if (headers && typeof headers.get === 'function') raw = headers.get(name);
    else if (headers && typeof headers === 'object')
      raw = headers[name] ?? headers[name.toLowerCase()] ?? null;
    if (raw == null || String(raw).trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return {
    request: read('X-API-Quota-Request'),
    used: read('X-API-Quota-Used'),
    left: read('X-API-Quota-Left'),
  };
}

/**
 * Documented cost of one search-news request when the provider sends no
 * X-API-Quota-Request header.
 *
 * Defaults to the entity-bearing rate because every search this proxy makes
 * sets `add-entities=true`; an estimate that flattered the caller would be
 * worse than none, since the budget guard spends against it.
 *
 * @param {number} resultCount Results returned by the request.
 * @param {boolean} [withEntities=true] Whether the request asked for entities.
 * @returns {number} Points.
 */
export function estimateWorldNewsPoints(resultCount, withEntities = true) {
  const results = Math.max(0, Math.floor(Number(resultCount) || 0));
  const perResult =
    WORLD_NEWS_POINTS_PER_RESULT +
    (withEntities ? WORLD_NEWS_ENTITY_POINTS_PER_RESULT : 0);
  // Two decimals, as the provider itself reports points: binary floating point
  // turns 1 + 0.11 * 12 into 2.3200000000000003, and this value is shown to
  // the operator as well as spent against the budget.
  return (
    Math.round((WORLD_NEWS_REQUEST_POINTS + perResult * results) * 100) / 100
  );
}

/**
 * Keep only batches fetched within the retention window. The provider's terms
 * cap caching at one hour, so anything older is deleted rather than served.
 * @param {Array<{at: number}>} batches
 * @param {number} nowMs
 * @param {number} retentionMs
 * @returns {Array<object>}
 */
export function retainWithinWindow(batches, nowMs, retentionMs) {
  if (!Array.isArray(batches)) return [];
  return batches.filter(
    (batch) =>
      Number.isFinite(batch?.at) &&
      Array.isArray(batch.articles) &&
      nowMs - batch.at >= 0 &&
      nowMs - batch.at < retentionMs,
  );
}

/**
 * Merge retained batches into one newest-first article list; the most recent
 * fetch wins when the same article appears twice.
 * @param {Array<{at: number, articles: Array<object>}>} batches
 * @returns {Array<object>}
 */
export function mergeBatchArticles(batches) {
  const byId = new Map();
  const ordered = [...(batches || [])].sort((a, b) => a.at - b.at);
  for (const batch of ordered) {
    for (const article of batch.articles || []) {
      if (article?.id) byId.set(article.id, article);
    }
  }
  return [...byId.values()].sort(newestFirst);
}
