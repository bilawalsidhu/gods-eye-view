/**
 * Pure World News clustering — no Cesium, safe to import from vite.config.js.
 *
 * Pins are the **outlet country** of matching GDELT DOC coverage, not a
 * verified incident location.
 */

export const WORLD_NEWS_ARTICLE_CAP = 75;
export const WORLD_NEWS_POINT_CAP = 80;
export const WORLD_NEWS_HEADLINES_PER_POINT = 5;
export const WORLD_NEWS_QUERY = '(theme:NATURAL_DISASTER OR theme:TERROR OR theme:PROTEST OR theme:ELECTION OR theme:UNREST OR theme:ARMEDCONFLICT)';
export const WORLD_NEWS_DISCLAIMER = 'Coverage mentions clustered by outlet country — not verified incidents, risk rankings, or evidence a place is safe. Linked articles keep their publisher terms.';

/** Approximate country centroids for GDELT `sourcecountry` labels. */
const COUNTRY_CENTROIDS = Object.freeze({
  afghanistan: [67.71, 33.94], algeria: [1.66, 28.03], argentina: [-63.62, -38.42],
  armenia: [45.04, 40.07], australia: [133.78, -25.27], austria: [14.55, 47.52],
  azerbaijan: [47.58, 40.14], bangladesh: [90.36, 23.68], belarus: [27.95, 53.71],
  belgium: [4.47, 50.50], brazil: [-51.93, -14.24], bulgaria: [25.49, 42.73],
  canada: [-106.35, 56.13], chile: [-71.54, -35.68], china: [104.20, 35.86],
  colombia: [-74.30, 4.57], croatia: [15.20, 45.10], cuba: [-77.78, 21.52],
  czechia: [15.47, 49.82], 'czech republic': [15.47, 49.82], denmark: [9.50, 56.26],
  egypt: [30.80, 26.82], estonia: [25.01, 58.60], ethiopia: [40.49, 9.15],
  finland: [25.75, 61.92], france: [2.21, 46.23], georgia: [43.36, 42.32],
  germany: [10.45, 51.17], ghana: [-1.02, 7.95], greece: [21.82, 39.07],
  hungary: [19.50, 47.16], india: [78.96, 20.59], indonesia: [113.92, -0.79],
  iran: [53.69, 32.43], iraq: [43.68, 33.22], ireland: [-8.24, 53.14],
  israel: [34.85, 31.05], italy: [12.57, 41.87], japan: [138.25, 36.20],
  jordan: [36.24, 30.59], kazakhstan: [66.92, 48.02], kenya: [37.91, -0.02],
  kuwait: [47.48, 29.31], latvia: [24.60, 56.88], lebanon: [35.86, 33.85],
  libya: [17.23, 26.34], lithuania: [23.88, 55.17], malaysia: [101.98, 4.21],
  mexico: [-102.55, 23.63], moldova: [28.37, 47.41], morocco: [-7.09, 31.79],
  myanmar: [95.96, 21.91], netherlands: [5.29, 52.13], 'new zealand': [174.89, -40.90],
  nigeria: [8.68, 9.08], 'north korea': [127.51, 40.34], norway: [8.47, 60.47],
  pakistan: [69.35, 30.38], palestine: [35.23, 31.95], peru: [-75.02, -9.19],
  philippines: [121.77, 12.88], poland: [19.15, 51.92], portugal: [-8.22, 39.40],
  qatar: [51.18, 25.35], romania: [24.97, 45.94], russia: [105.32, 61.52],
  'saudi arabia': [45.08, 23.89], serbia: [21.01, 44.02], singapore: [103.82, 1.35],
  slovakia: [19.70, 48.67], somalia: [46.20, 5.15], 'south africa': [22.94, -30.56],
  'south korea': [127.77, 35.91], spain: [-3.75, 40.46], sudan: [30.22, 12.86],
  sweden: [18.64, 60.13], switzerland: [8.23, 46.82], syria: [38.00, 34.80],
  taiwan: [120.96, 23.70], thailand: [100.99, 15.87], turkey: [35.24, 38.96],
  ukraine: [31.17, 48.38], 'united arab emirates': [53.85, 23.42],
  'united kingdom': [-3.44, 55.38], 'united states': [-95.71, 37.09],
  venezuela: [-66.59, 6.42], vietnam: [108.28, 14.06], yemen: [48.52, 15.55],
  us: [-95.71, 37.09], usa: [-95.71, 37.09], uk: [-3.44, 55.38],
  uae: [53.85, 23.42],
});

function cleanText(value, maxLength = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function countryKey(value) {
  return cleanText(value, 80).toLowerCase();
}

/** Return lon/lat for a GDELT source-country label, or null. */
export function countryCentroid(value) {
  const pair = COUNTRY_CENTROIDS[countryKey(value)];
  return pair ? { lon: pair[0], lat: pair[1] } : null;
}

function parseSeenDate(rawDate) {
  const compactDate = /^(\d{8})T(\d{6})Z$/.exec(cleanText(rawDate, 32));
  if (compactDate) {
    return `${compactDate[1].slice(0, 4)}-${compactDate[1].slice(4, 6)}-${compactDate[1].slice(6, 8)}T${compactDate[2].slice(0, 2)}:${compactDate[2].slice(2, 4)}:${compactDate[2].slice(4, 6)}Z`;
  }
  return Number.isNaN(Date.parse(rawDate)) ? null : new Date(rawDate).toISOString();
}

/**
 * Normalize GDELT ArticleList output without trusting article HTML.
 * @param {object} payload
 * @param {number} [limit=WORLD_NEWS_ARTICLE_CAP]
 */
export function normalizeWorldNewsArticles(payload, limit = WORLD_NEWS_ARTICLE_CAP) {
  const cap = Math.max(1, Math.min(WORLD_NEWS_ARTICLE_CAP, Math.floor(Number(limit) || 0)));
  const rows = Array.isArray(payload?.articles) ? payload.articles : [];
  const seen = new Set();
  const articles = [];
  for (const row of rows) {
    const url = safeHttpUrl(row?.url || row?.url_mobile);
    const title = cleanText(row?.title, 180);
    if (!url || !title) continue;
    const domain = cleanText(row?.domain || new URL(url).hostname.replace(/^www\./, ''), 80);
    const signature = `${title.toLowerCase()}|${domain}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    articles.push({
      title,
      url,
      domain,
      publishedAt: parseSeenDate(row?.seendate),
      sourceCountry: cleanText(row?.sourcecountry, 60) || null,
    });
    if (articles.length >= cap) break;
  }
  return articles;
}

/**
 * Cluster normalized articles onto outlet-country centroids.
 * @param {Array<object>} articles
 * @param {number} [limit=WORLD_NEWS_POINT_CAP]
 */
export function clusterWorldNewsPoints(articles, limit = WORLD_NEWS_POINT_CAP) {
  const cap = Math.max(1, Math.min(WORLD_NEWS_POINT_CAP, Math.floor(Number(limit) || 0)));
  const groups = new Map();
  for (const article of Array.isArray(articles) ? articles : []) {
    const place = article?.sourceCountry;
    const centroid = countryCentroid(place);
    if (!centroid || !place) continue;
    const id = countryKey(place);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        place,
        lat: centroid.lat,
        lon: centroid.lon,
        count: 0,
        articles: [],
      };
      groups.set(id, group);
    }
    group.count += 1;
    if (group.articles.length < WORLD_NEWS_HEADLINES_PER_POINT) {
      group.articles.push(article);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.place.localeCompare(b.place))
    .slice(0, cap);
}

/** Validate a proxy snapshot before replacing the last good layer state. */
export function normalizeWorldNewsSnapshot(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Array.isArray(payload.points)) return null;
  const points = [];
  const ids = new Set();
  for (const raw of payload.points) {
    const lat = Number(raw?.lat);
    const lon = Number(raw?.lon);
    const place = cleanText(raw?.place, 80);
    const id = cleanText(raw?.id, 80) || countryKey(place);
    const count = Number(raw?.count);
    if (!id || !place || ids.has(id)) return null;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    if (!Number.isFinite(count) || count < 1) return null;
    const articles = Array.isArray(raw.articles) ? raw.articles : [];
    const headlines = [];
    for (const article of articles.slice(0, WORLD_NEWS_HEADLINES_PER_POINT)) {
      const url = safeHttpUrl(article?.url);
      const title = cleanText(article?.title, 180);
      if (!url || !title) continue;
      headlines.push({
        title,
        url,
        domain: cleanText(article?.domain, 80),
        publishedAt: article?.publishedAt || null,
        sourceCountry: cleanText(article?.sourceCountry, 60) || place,
      });
    }
    ids.add(id);
    points.push({ id, place, lat, lon, count: Math.round(count), articles: headlines });
  }
  return {
    status: points.length ? 'ready' : 'empty',
    source: cleanText(payload.source, 80) || 'GDELT DOC 2.0',
    geometry: payload.geometry === 'story-location' ? 'story-location' : 'outlet-country',
    disclaimer: cleanText(payload.disclaimer, 280) || WORLD_NEWS_DISCLAIMER,
    retrievedAt: cleanText(payload.retrievedAt, 40) || null,
    points,
  };
}

export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const headline = raw?.articles?.[0];
  return {
    id: text(raw?.id) || `NEWS-${String(index).padStart(4, '0')}`,
    place: text(raw?.place),
    count: num(raw?.count),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    title: text(headline?.title) || text(raw?.title),
    domain: text(headline?.domain) || text(raw?.domain),
    url: text(headline?.url) || text(raw?.url),
  };
}
