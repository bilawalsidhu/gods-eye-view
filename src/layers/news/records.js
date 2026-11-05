// Validate /api/news payloads before they reach the scene or the DOM. Every
// string is bounded, every URL is http(s), every position is finite; a record
// that fails is dropped, a payload that fails is rejected whole. A portable
// export (layers/news/source): no i18n here.

const CATEGORY = /^[a-z][a-z-]{1,31}$/;
const CODE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const EVENT_STATUSES = Object.freeze([
  'both-sides',
  'independent',
  'claimed',
  'reported',
  'side',
  'single',
]);

const text = (value, max) =>
  typeof value === 'string' && value.trim()
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : null;
const finite = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max ? value : null;
const iso = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const code = (value) =>
  typeof value === 'string' && CODE.test(value) ? value : null;
const severity = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;

/** An http(s) URL without credentials, as its normalised href, or null. */
export function httpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [west, south, east, north] = bbox;
  if (
    finite(west, -180, 180) === null ||
    finite(east, -180, 180) === null ||
    finite(south, -90, 90) === null ||
    finite(north, -90, 90) === null ||
    west >= east ||
    south >= north
  )
    return null;
  return [west, south, east, north];
}

/** Beacon position: the curated focus point, else the bbox centre. */
function normalizeFocus(focus, [west, south, east, north]) {
  const lat = finite(focus?.lat, south, north);
  const lon = finite(focus?.lon, west, east);
  return lat !== null && lon !== null
    ? { lat, lon }
    : { lat: (south + north) / 2, lon: (west + east) / 2 };
}

function normalizeDeveloping(items) {
  const out = [];
  for (const raw of Array.isArray(items) ? items.slice(0, 16) : []) {
    const lat = finite(raw?.focus?.lat, -90, 90);
    const lon = finite(raw?.focus?.lon, -180, 180);
    const country =
      typeof raw?.country === 'string' && /^[A-Z]{2}$/.test(raw.country)
        ? raw.country
        : null;
    if (lat === null || lon === null || !country) continue;
    // A state where the catch-all flags states ("US-FL"), else the country.
    const area =
      typeof raw.area === 'string' && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(raw.area)
        ? raw.area
        : null;
    out.push({
      country,
      key: area || country,
      name: text(raw.name, 80) || country,
      events: Math.max(0, Math.floor(Number(raw.events) || 0)),
      reports: Math.max(0, Math.floor(Number(raw.reports) || 0)),
      focus: { lat, lon },
    });
  }
  return out;
}

const hoursOrNull = (hours) =>
  Number.isInteger(hours) && hours >= 1 && hours <= 24 ? hours : null;

/**
 * `/api/news/hotspots` → `{hotspots, categories, lastRunAt, windowHours,
 * maxWindowHours}`, or null when the payload has no hotspot list.
 * `windowHours` is the window the counts cover and `maxWindowHours` the
 * longest the server serves this reader; each is null when the server names
 * none.
 */
export function normalizeHotspotsPayload(payload) {
  if (!Array.isArray(payload?.hotspots)) return null;
  const hotspots = [];
  for (const raw of payload.hotspots.slice(0, 64)) {
    const id = typeof raw?.id === 'string' && ID.test(raw.id) ? raw.id : null;
    const name = text(raw?.name, 80);
    const bbox = normalizeBbox(raw?.bbox);
    if (!id || !name || !bbox) continue;
    const counts = raw.counts || {};
    hotspots.push({
      id,
      name,
      kind: text(raw.kind, 16) || 'conflict',
      catchAll: raw.catchAll === true,
      developing: normalizeDeveloping(raw.developing),
      bbox,
      parties: Array.isArray(raw.parties)
        ? raw.parties.filter((p) => code(p))
        : [],
      last24h: Math.max(0, Math.floor(Number(counts.last24h) || 0)),
      mapped24h: Math.max(0, Math.floor(Number(counts.mapped24h) || 0)),
      prev24h: Number.isFinite(counts.prev24h)
        ? Math.max(0, Math.floor(counts.prev24h))
        : null,
      focus: normalizeFocus(raw.focus, bbox),
      latestAt: iso(raw.latestAt),
    });
  }
  return {
    hotspots,
    categories: Array.isArray(payload.categories)
      ? payload.categories.filter(
          (c) => typeof c === 'string' && CATEGORY.test(c),
        )
      : [],
    lastRunAt: iso(payload.ingest?.lastRunAt),
    windowHours: hoursOrNull(payload.windowHours),
    maxWindowHours: hoursOrNull(payload.maxWindowHours),
  };
}

function normalizeGeo(geo) {
  if (!geo || typeof geo !== 'object') return null;
  const lat = finite(geo.lat, -90, 90);
  const lon = finite(geo.lon, -180, 180);
  if (lat === null || lon === null) return null;
  return {
    lat,
    lon,
    place: text(geo.place, 80),
    precision: text(geo.precision, 16) || 'city',
    confidence: finite(geo.confidence, 0, 1) ?? 0,
    mappable: geo.mappable === true,
    byModel: geo.method === 'llm',
  };
}

/**
 * The event's picture: an HTTPS URL on the publisher's site, and whose it is;
 * with the post's own clip when it has one a browser plays itself (an HTTPS
 * MP4 or WebM file), the picture then its poster.
 */
function eventImage(image) {
  const url = httpUrl(image?.url);
  if (!url?.startsWith('https://')) return null;
  const video = httpUrl(image.video);
  const playable =
    video?.startsWith('https://') &&
    /\.(?:mp4|m4v|webm)$/i.test(new URL(video).pathname);
  return {
    url,
    publisher: text(image.publisher, 80) || '',
    ...(playable ? { video } : {}),
  };
}

/** An event summary from `/feed?events=1`: size and one report per side. */
function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const count = (value) => Math.max(1, Math.floor(Number(value) || 1));
  const sides = [];
  for (const side of Array.isArray(event.sides)
    ? event.sides.slice(0, 8)
    : []) {
    const url = httpUrl(side?.url);
    const title = text(side?.title, 300);
    if (!url || !title) continue;
    sides.push({
      side: code(side.side) || 'unknown',
      title,
      url,
      publisher: text(side.publisher, 80) || '',
      publishedAt: iso(side.publishedAt),
    });
  }
  return {
    id: typeof event.id === 'string' && ID.test(event.id) ? event.id : null,
    status: EVENT_STATUSES.includes(event.status) ? event.status : null,
    claimedBy: text(event.claimedBy, 80),
    reportedSide: code(event.reportedSide),
    size: count(event.size),
    reports: count(event.reports),
    severity: severity(event.severity),
    firstAt: iso(event.firstAt),
    lastAt: iso(event.lastAt),
    sides,
    image: eventImage(event.image),
  };
}

function normalizeReport(raw) {
  const id = typeof raw?.id === 'string' && ID.test(raw.id) ? raw.id : null;
  const title = text(raw?.title, 300);
  const url = httpUrl(raw?.url);
  const publishedAt = iso(raw?.publishedAt);
  if (!id || !title || !url || !publishedAt) return null;
  const source = raw.source || {};
  const geo = normalizeGeo(raw.geo);
  // Map positions: the report's own place plus any other hotspot its title
  // names (a roundup is pinned in each).
  const pins = [];
  for (const place of [
    geo,
    ...(Array.isArray(raw.locations)
      ? raw.locations.slice(0, 8).map(normalizeGeo)
      : []),
  ])
    if (
      place?.mappable &&
      !pins.some((p) => p.lat === place.lat && p.lon === place.lon)
    )
      pins.push(place);
  const hotspotId = typeof raw.hotspotId === 'string' ? raw.hotspotId : null;
  return {
    id,
    hotspotId,
    hotspotIds: Array.isArray(raw.hotspotIds)
      ? raw.hotspotIds.filter((h) => typeof h === 'string').slice(0, 8)
      : [hotspotId].filter(Boolean),
    title,
    url,
    snippet: text(raw.snippet, 400),
    publisher: text(raw.publisher, 80) || text(source.name, 80) || '',
    sourceName: text(source.name, 80) || text(raw.publisher, 80) || '',
    kind: text(raw.kind, 16) || 'rss',
    side: code(raw.side) || 'unknown',
    affiliation: text(raw.affiliation, 32),
    attribution: text(source.attribution, 120),
    category:
      typeof raw.category === 'string' && CATEGORY.test(raw.category)
        ? raw.category
        : 'other',
    publishedAt,
    geo,
    pins,
    event: normalizeEvent(raw.event),
    titleEn: text(raw.titleEn, 200),
    relevance: ['core', 'related', 'minor'].includes(raw.relevance)
      ? raw.relevance
      : 'related',
    severity: severity(raw.severity),
    severityBy: ['model', 'label'].includes(raw.severityBy)
      ? raw.severityBy
      : 'rules',
    claim:
      raw.claim && typeof raw.claim === 'object'
        ? { by: text(raw.claim.by, 80) }
        : null,
    media: Array.isArray(raw.media)
      ? [...new Set(raw.media.filter((m) => m === 'video' || m === 'photo'))]
      : [],
  };
}

function normalizeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const points = [];
  for (const point of ring.slice(0, 20_000)) {
    const lon = finite(point?.[0], -180, 180);
    const lat = finite(point?.[1], -90, 90);
    if (lon !== null && lat !== null) points.push([lon, lat]);
  }
  return points.length >= 3 ? points : null;
}

/**
 * `/api/news/outline` → `{polygons, borders, disputed, area}`: the dissolved
 * extent (`{outer, holes}`), the national borders inside it (rings), its
 * disputed areas and, answering a point, the area named there (else null),
 * invalid parts dropped.
 */
export function normalizeOutlinePayload(payload) {
  const polygons = [];
  // Above every country's island count (Indonesia's is 208): an outline cut
  // short leaves islands outside the area, read again on each settle there.
  for (const raw of Array.isArray(payload?.polygons)
    ? payload.polygons.slice(0, 300)
    : []) {
    const outer = normalizeRing(raw?.outer);
    if (!outer) continue;
    const holes = (Array.isArray(raw.holes) ? raw.holes.slice(0, 200) : [])
      .map(normalizeRing)
      .filter(Boolean);
    polygons.push({ outer, holes });
  }
  const borders = (
    Array.isArray(payload?.borders) ? payload.borders.slice(0, 50) : []
  )
    .map(normalizeRing)
    .filter(Boolean);
  const KINDS = ['held', 'self', 'un', 'unclaimed'];
  const country = (value) =>
    typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : null;
  const disputed = [];
  for (const raw of Array.isArray(payload?.disputed)
    ? payload.disputed.slice(0, 30)
    : []) {
    const rings = (Array.isArray(raw?.rings) ? raw.rings.slice(0, 20) : [])
      .map(normalizeRing)
      .filter(Boolean);
    const name = text(raw?.name, 60);
    if (!rings.length || !name) continue;
    disputed.push({
      name,
      kind: KINDS.includes(raw.kind) ? raw.kind : 'held',
      heldBy: country(raw.heldBy),
      claimedBy: country(raw.claimedBy),
      rings,
    });
  }
  return { polygons, borders, disputed, area: outlineArea(payload?.area) };
}

const AREA_KINDS = ['country', 'region', 'disputed'];
function outlineArea(raw) {
  const key = text(raw?.key, 80);
  const name = text(raw?.name, 80);
  if (!key || !name) return null;
  return {
    key,
    name,
    kind: AREA_KINDS.includes(raw.kind) ? raw.kind : 'country',
    country:
      typeof raw.country === 'string' && /^[A-Z]{2}$/.test(raw.country)
        ? raw.country
        : null,
  };
}

/** `/api/news/feed` → `{reports, nextBefore}`, or null without a report list. */
export function normalizeFeedPayload(payload) {
  if (!Array.isArray(payload?.reports)) return null;
  const reports = [];
  for (const raw of payload.reports.slice(0, 500)) {
    const report = normalizeReport(raw);
    if (report) reports.push(report);
  }
  return { reports, nextBefore: iso(payload.nextBefore) };
}
