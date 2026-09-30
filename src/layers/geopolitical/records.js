const PROVIDERS = new Set([
  'gdelt',
  'acled',
  'ucdp',
  'ucdp-candidate',
  'hapi-conflict',
  'reliefweb',
]);
const CATEGORIES = new Set([
  'cooperation',
  'conflict',
  'political-violence',
  'protest',
  'humanitarian',
  'political',
  'news-signal',
]);

function cleanText(value, max = 500) {
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

function validCoordinate(value, minimum, maximum) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function normalizeCountryScope(value) {
  if (!value || typeof value !== 'object') return null;
  const code = cleanText(String(value.code || '').toUpperCase(), 3);
  const name = cleanText(value.name, 120);
  if (!name || (code && !/^[A-Z]{3}$/.test(code))) return null;
  const latitude = validCoordinate(value.latitude, -90, 90)
    ? value.latitude
    : null;
  const longitude = validCoordinate(value.longitude, -180, 180)
    ? value.longitude
    : null;
  return Object.freeze({
    code,
    name,
    latitude,
    longitude,
  });
}

function normalizeEvent(value) {
  if (!value || !PROVIDERS.has(value.provider)) return null;
  const id = cleanText(value.id, 180);
  const title = cleanText(value.title, 240);
  const eventAt = isoDate(value.eventAt);
  const reportedAt = isoDate(value.reportedAt);
  const category = CATEGORIES.has(value.category) ? value.category : null;
  const latitude = value.latitude;
  const longitude = value.longitude;
  const hasCoordinates =
    validCoordinate(latitude, -90, 90) && validCoordinate(longitude, -180, 180);
  const sourceUrl = cleanText(value.sourceUrl, 800);
  const attribution = cleanText(value.attribution, 160);
  if (
    !id ||
    !title ||
    !eventAt ||
    !category ||
    !sourceUrl ||
    !/^https:\/\//i.test(sourceUrl) ||
    !attribution
  )
    return null;
  return Object.freeze({
    id,
    provider: value.provider,
    title,
    summary: cleanText(value.summary, 1_000),
    category,
    eventAt,
    reportedAt,
    latitude: hasCoordinates ? latitude : null,
    longitude: hasCoordinates ? longitude : null,
    location: cleanText(value.location, 180),
    country: cleanText(value.country, 100),
    locationPrecision: hasCoordinates
      ? cleanText(value.locationPrecision, 80) || 'source-provided'
      : 'not-mappable',
    sourceUrl,
    sourceName: cleanText(value.sourceName, 180),
    attribution,
    eventType: cleanText(value.eventType, 120),
    actors: Object.freeze(
      (Array.isArray(value.actors) ? value.actors : [])
        .slice(0, 8)
        .map((actor) => cleanText(actor, 120))
        .filter(Boolean),
    ),
    fatalities:
      Number.isSafeInteger(value.fatalities) && value.fatalities >= 0
        ? value.fatalities
        : null,
    confidence: cleanText(value.confidence, 80),
    semantics: cleanText(value.semantics, 300),
    countryScopes: Object.freeze(
      (Array.isArray(value.countryScopes) ? value.countryScopes : [])
        .slice(0, 20)
        .map(normalizeCountryScope)
        .filter(Boolean),
    ),
  });
}

export function normalizeGeopoliticalSnapshot(value) {
  const fetchedAt = isoDate(value?.fetchedAt);
  if (
    !value ||
    value.provider !== 'geopolitical' ||
    !fetchedAt ||
    !Array.isArray(value.events) ||
    value.events.length > 2_000 ||
    !Array.isArray(value.providers)
  )
    throw new Error('Malformed Geo-Political response');
  const events = value.events.map(normalizeEvent).filter(Boolean);
  const seen = new Set();
  const unique = events.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  unique.sort((a, b) => b.eventAt.localeCompare(a.eventAt));
  return Object.freeze({
    provider: 'geopolitical',
    fetchedAt,
    stale: value.stale === true,
    events: Object.freeze(unique),
    providers: Object.freeze(
      value.providers
        .filter((provider) =>
          [
            'gdelt',
            'acled',
            'ucdp',
            'ucdp-candidate',
            'hapi-conflict',
            'reliefweb',
          ].includes(provider?.id),
        )
        .map((provider) =>
          Object.freeze({
            id: provider.id,
            status: cleanText(provider.status, 80) || 'unavailable',
            fetchedAt: isoDate(provider.fetchedAt),
            count: Number.isSafeInteger(provider.count)
              ? Math.max(0, provider.count)
              : 0,
            error: cleanText(provider.error, 160),
          }),
        ),
    ),
  });
}
