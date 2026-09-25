import countryAnchorPack from './countryAnchors.json' with { type: 'json' };

const COUNTRY_ANCHORS = countryAnchorPack.anchors;
const ATTRIBUTION = 'IODA · Georgia Tech Internet Intelligence Lab';
const MAX_EVENTS = 250;
const MAX_EVENT_DURATION_SECONDS = 366 * 24 * 60 * 60;

function safeText(value, max = 120) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f<>]/.test(text)
    ? text
    : null;
}

function isoDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeEvent(value) {
  const normalizedCode = safeText(value?.countryCode, 2);
  const location =
    safeText(value?.location, 80) ||
    (normalizedCode ? `country/${normalizedCode}` : null);
  const match = location?.match(/^country\/([A-Z]{2})$/);
  const countryCode = match?.[1] || null;
  const countryName = safeText(value?.location_name ?? value?.countryName, 120);
  const datasource = safeText(value?.datasource, 40);
  const method = safeText(value?.method, 40);
  const start = Number(value?.start ?? Date.parse(value?.startedAt) / 1000);
  const durationSeconds = Number(value?.duration ?? value?.durationSeconds);
  const startedAt =
    Number.isSafeInteger(start) && start >= 946684800 && start <= 4102444800
      ? new Date(start * 1000).toISOString()
      : null;
  if (
    !countryCode ||
    !countryName ||
    !datasource ||
    !/^[a-z][a-z0-9-]{0,39}$/i.test(datasource) ||
    !method ||
    !/^[a-z][a-z0-9-]{0,39}$/i.test(method) ||
    !startedAt ||
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 0 ||
    durationSeconds > MAX_EVENT_DURATION_SECONDS
  )
    return null;
  return Object.freeze({
    id: `ioda:event:${countryCode}:${datasource}:${method}:${start}`,
    countryCode,
    countryName,
    datasource,
    method,
    startedAt,
    durationSeconds,
    overlapsWindow:
      value?.overlaps_window === true || value?.overlapsWindow === true,
  });
}

/** Normalize a bounded country-level IODA event snapshot for Cyber rendering. */
export function normalizeIodaSnapshot(value) {
  const fetchedAt = isoDate(value?.fetchedAt);
  if (
    !value ||
    value.provider !== 'ioda' ||
    !fetchedAt ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_EVENTS
  )
    throw new Error('Malformed IODA response');

  const events = value.events.map(normalizeEvent).filter(Boolean);
  const grouped = new Map();
  for (const event of events) {
    const group = grouped.get(event.countryCode) || [];
    group.push(event);
    grouped.set(event.countryCode, group);
  }
  const countries = [];
  for (const [countryCode, rows] of grouped) {
    const anchor = COUNTRY_ANCHORS[countryCode];
    if (!anchor) continue;
    rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    countries.push(
      Object.freeze({
        id: `ioda:country:${countryCode}`,
        countryCode,
        countryName: rows[0].countryName,
        eventCount: rows.length,
        latestEventAt: rows[0].startedAt,
        datasources: Object.freeze(
          [...new Set(rows.map((row) => row.datasource))].sort(),
        ),
        latitude: anchor.latitude,
        longitude: anchor.longitude,
        geographicPrecision: 'country-reference',
        geographicMethod: 'Natural Earth country label point',
        geographicProvenance: `${anchor.name} country reference; outage scope supplied at country level by IODA.`,
      }),
    );
  }
  countries.sort((a, b) => a.countryName.localeCompare(b.countryName));
  events.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return Object.freeze({
    provider: 'ioda',
    fetchedAt,
    stale: value.stale === true,
    attribution: ATTRIBUTION,
    windowHours: 24,
    events: Object.freeze(events),
    countries: Object.freeze(countries),
  });
}
