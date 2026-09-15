import {
  HEADLINE_LABEL_CHARS,
  MAX_PLACE_PIXEL_SIZE,
  PLACE_KEY_DECIMALS,
  POINT_PIXEL_SIZE,
  TONE_NEGATIVE_MAX,
  TONE_POSITIVE_MIN,
} from './policy.js';

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Optional provider text: a trimmed string, or null for anything else. */
function optionalText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * Validate a complete proxy payload before it can replace the last good
 * snapshot. A single malformed article rejects the whole batch (earthquakes
 * precedent): a partial map is a lie about coverage, not a smaller truth.
 * @param {object} payload Proxy JSON (see the world-news contract).
 * @returns {Array<object>|null} Rows newest-first, or null when malformed.
 */
export function normalizeWorldNewsSnapshot(payload) {
  if (!Array.isArray(payload?.articles)) return null;
  const rows = [];
  const ids = new Set();
  for (const article of payload.articles) {
    if (!article || typeof article !== 'object' || Array.isArray(article))
      return null;
    const { id, title, url, lat, lon, sentiment, publishedAt } = article;
    if (typeof id !== 'string' || !id.trim()) return null;
    if (typeof title !== 'string' || !title.trim()) return null;
    if (!isHttpUrl(url)) return null;
    if (
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180
    )
      return null;
    if (
      sentiment != null &&
      (!Number.isFinite(sentiment) || Math.abs(sentiment) > 1)
    )
      return null;
    let publishedMs = null;
    if (publishedAt != null) {
      if (typeof publishedAt !== 'string') return null;
      publishedMs = Date.parse(publishedAt);
      if (!Number.isFinite(publishedMs)) return null;
    }
    if (ids.has(id)) return null;
    ids.add(id);
    rows.push({
      id,
      title: title.trim(),
      url,
      domain: optionalText(article.domain) || hostnameOf(url),
      publishedAt: publishedMs == null ? null : publishedAt,
      publishedMs,
      sentiment: sentiment ?? null,
      category: optionalText(article.category),
      language: optionalText(article.language),
      sourceCountry: optionalText(article.sourceCountry),
      lat,
      lon,
      place: optionalText(article.place),
      placeFoundIn: optionalText(article.placeFoundIn),
      placeMentions:
        Number.isInteger(article.placeMentions) && article.placeMentions >= 0
          ? article.placeMentions
          : 0,
    });
  }
  return rows;
}

/**
 * Bucket a provider sentiment score.
 * @param {number|null|undefined} sentiment Score in [-1, 1], or null.
 * @returns {'negative'|'neutral'|'positive'|'unknown'}
 */
export function toneBand(sentiment) {
  if (!Number.isFinite(sentiment)) return 'unknown';
  if (sentiment <= TONE_NEGATIVE_MAX) return 'negative';
  if (sentiment >= TONE_POSITIVE_MIN) return 'positive';
  return 'neutral';
}

/** Round without a signed zero, so -0.0001 and 0.0001 share one pin. */
function fixedDegrees(value) {
  return Number(value.toFixed(PLACE_KEY_DECIMALS)).toFixed(PLACE_KEY_DECIMALS);
}

/**
 * Stable id for every headline about (roughly) the same coordinate.
 * @param {number} lat @param {number} lon Degrees.
 * @returns {string}
 */
export function placeKey(lat, lon) {
  return `wn-place:${fixedDegrees(lat)}:${fixedDegrees(lon)}`;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Newest first; undated rows last; stable by id after that. */
function compareNewest(a, b) {
  const aMs = a.newestMs ?? a.publishedMs ?? null;
  const bMs = b.newestMs ?? b.publishedMs ?? null;
  if (aMs !== bMs) {
    if (aMs == null) return 1;
    if (bMs == null) return -1;
    return bMs - aMs;
  }
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Collapse headline rows into one pin per place. Pure — no Cesium types.
 * @param {Array<object>} rows Output of normalizeWorldNewsSnapshot.
 * @returns {Array<{id: string, lat: number, lon: number, place: string,
 *   count: number, meanSentiment: number|null, band: string,
 *   newestMs: number|null, articles: Array<object>}>} Newest place first.
 */
export function aggregatePlaces(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = placeKey(row.lat, row.lon);
    let group = groups.get(id);
    if (!group) {
      group = { id, members: [], names: new Map() };
      groups.set(id, group);
    }
    group.members.push(row);
    if (row.place)
      group.names.set(row.place, (group.names.get(row.place) || 0) + 1);
  }
  const result = [];
  for (const { id, members, names } of groups.values()) {
    const lat = mean(members.map((row) => row.lat));
    const lon = mean(members.map((row) => row.lon));
    const meanSentiment = mean(
      members.map((row) => row.sentiment).filter(Number.isFinite),
    );
    const dated = members.map((row) => row.publishedMs).filter(Number.isFinite);
    let place = null;
    let best = 0;
    for (const [name, votes] of names) {
      if (votes > best) {
        place = name;
        best = votes;
      }
    }
    result.push({
      id,
      lat,
      lon,
      place: place || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
      count: members.length,
      meanSentiment,
      band: toneBand(meanSentiment),
      newestMs: dated.length ? Math.max(...dated) : null,
      articles: members.slice().sort(compareNewest),
    });
  }
  return result.sort(compareNewest);
}

/**
 * Pin size grows with the square root of the story count and caps out.
 * @param {number} count Stories at the place.
 * @returns {number} Whole pixels.
 */
export function placePixelSize(count) {
  const stories = Math.max(1, Math.floor(Number(count) || 1));
  return Math.min(
    MAX_PLACE_PIXEL_SIZE,
    Math.round(POINT_PIXEL_SIZE + 2 * Math.sqrt(stories)),
  );
}

/**
 * Map one headline row to a JSON-safe analyst record (analyst query engine
 * seam). Missing/unknown fields are null, never NaN/undefined.
 * @param {object|null|undefined} row Normalized headline row.
 * @param {number} [index=0] Position in the snapshot (fallback id only).
 * @returns {{id: string, title: string|null, domain: string|null,
 *   url: string|null, publishedAt: string|null, sentiment: number|null,
 *   category: string|null, place: string|null, sourceCountry: string|null,
 *   lat: number|null, lon: number|null}}
 */
export function mapAnalystRecord(row, index = 0) {
  const num = (value) => (Number.isFinite(value) ? value : null);
  const text = (value) => {
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
  };
  return {
    id: text(row?.id) || `NEWS-${String(index).padStart(4, '0')}`,
    title: text(row?.title),
    domain: text(row?.domain),
    url: text(row?.url),
    publishedAt: text(row?.publishedAt),
    sentiment: num(row?.sentiment),
    category: text(row?.category),
    place: text(row?.place),
    sourceCountry: text(row?.sourceCountry),
    lat: num(row?.lat),
    lon: num(row?.lon),
  };
}

/** Millisecond delta → "<1h" / "Xh" / "Xd", or '' for invalid input. */
export function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return '';
  const hours = deltaMs / 3600000;
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Millisecond delta → "<1m ago" / "Xm ago" / "Xh ago" (fresh-feed readout). */
export function formatAgoMinutes(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return '<1m ago';
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * Shorten a headline for a label, ending on an ellipsis when cut.
 * @param {string} title Headline text.
 * @param {number} [max=HEADLINE_LABEL_CHARS] Maximum characters, ellipsis included.
 * @returns {string}
 */
export function truncateHeadline(title, max = HEADLINE_LABEL_CHARS) {
  const text = String(title ?? '').trim();
  const limit = Math.max(2, Math.floor(Number(max) || HEADLINE_LABEL_CHARS));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}
