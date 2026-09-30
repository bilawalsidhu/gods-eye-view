import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import {
  readResponseBytesCapped,
  readResponseTextCapped,
} from './common/http.js';
import { readRequestBodyCapped } from './common/request.js';

const PROVIDER_IDS = Object.freeze([
  'gdelt',
  'acled',
  'ucdp',
  'ucdp-candidate',
  'hapi-conflict',
  'reliefweb',
]);
const PROVIDER_LIMIT = 100;
const HAPI_COUNTRY_LIMIT = 300;
const EVENT_LIMIT =
  PROVIDER_LIMIT * (PROVIDER_IDS.length - 1) + HAPI_COUNTRY_LIMIT;
const GDELT_SEARCH_LIMIT = 100;
const GDELT_FEED_EVENT_LIMIT = 20_000;
const AREA_SEARCH_RADIUS_KM = 3_000;
const MAX_VIEW_RADIUS_KM = 20_050;
const UCDP_SEARCH_REQUEST_LIMIT = 12;
const UCDP_SEARCH_PAGE_LIMIT = 12;
const UCDP_CANDIDATE_PAGE_LIMIT = 20;
const HAPI_PAGE_SIZE = 1_000;
const HAPI_PAGE_LIMIT = 10;
const BODY_LIMIT = 2 * 1024 * 1024;
const GDELT_CSV_LIMIT = 8 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const GDELT_INDEX_URL = 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';
const UCDP_URL = 'https://ucdpapi.pcr.uu.se/api/gedevents/26.1';
const UCDP_CANDIDATE_URL = 'https://ucdpapi.pcr.uu.se/api/gedevents';
const HAPI_CONFLICT_URL =
  'https://hapi.humdata.org/api/v2/coordination-context/conflict-events';
// GED 26.1 is the annual release covering data through 2025. UCDP's API page
// order is explicitly arbitrary, so select bounded date windows and sort them
// locally instead of treating the last page as the newest one.
const UCDP_DATA_END_DATE = '2025-12-31';
const ACLED_TOKEN_URL = 'https://acleddata.com/oauth/token';
const ACLED_EVENTS_URL = 'https://acleddata.com/api/acled/read';
const RELIEFWEB_URL = 'https://api.reliefweb.int/v2/reports';
const GDELT_SEARCH_CATEGORIES = Object.freeze({
  'all-categories': {
    roots: Array.from({ length: 20 }, (_, index) => index + 1),
  },
  'all-conflict': { roots: [13, 14, 15, 16, 17, 18, 19, 20] },
  'military-actions': {
    codes: [190, 191, 192, 193, 194, 195, 1951, 1952, 196],
  },
  'threats-coercion': { roots: [13, 17] },
  protests: { roots: [14] },
  'show-of-force': { roots: [15] },
  'diplomatic-actions': { roots: [16] },
  assaults: { roots: [18] },
  fights: { roots: [19] },
  'mass-violence': { roots: [20] },
});

function clean(value, max = 500) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f<>]/.test(text)
    ? text
    : null;
}

function date(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function reliefWebDateTime(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function hostname(value) {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function numericCoordinate(value, min, max) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && !value.trim())
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

function ucdpGeographyBoxes(latitude, longitude, radiusKm) {
  const toDegrees = (radians) => (radians * 180) / Math.PI;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const angularRadius = radiusKm / 6371;
  const latitudeRadians = toRadians(latitude);
  // GED's current Geography filter accepts integer coordinate values only;
  // round outward so the API box remains a safe superset of the requested circle.
  const south = Math.max(-90, Math.floor(latitude - toDegrees(angularRadius)));
  const north = Math.min(90, Math.ceil(latitude + toDegrees(angularRadius)));
  if (south <= -90 || north >= 90) return [[south, -180, north, 180]];

  const longitudeSpan = toDegrees(
    Math.asin(Math.min(1, Math.sin(angularRadius) / Math.cos(latitudeRadians))),
  );
  const west = Math.floor(longitude - longitudeSpan);
  const east = Math.ceil(longitude + longitudeSpan);
  if (west < -180)
    return [
      [south, west + 360, north, 180],
      [south, -180, north, east],
    ];
  if (east > 180)
    return [
      [south, west, north, 180],
      [south, -180, north, east - 360],
    ];
  return [[south, west, north, east]];
}

function category(text, provider) {
  const value = String(text || '').toLowerCase();
  if (/protest|demonstrat|riot|strike/.test(value)) return 'protest';
  if (/humanitarian|disaster|displacement|famine|flood|earthquake/.test(value))
    return 'humanitarian';
  if (/politic|election|government|sanction|diplomat|coup/.test(value))
    return 'political';
  if (
    /conflict|battle|violence|war|attack|armed|explosion|airstrike/.test(value)
  )
    return provider === 'acled' ? 'political-violence' : 'conflict';
  return 'news-signal';
}

function event({
  provider,
  id,
  title,
  summary,
  category: eventCategory,
  eventAt,
  reportedAt,
  latitude,
  longitude,
  location,
  country,
  locationPrecision,
  sourceUrl,
  sourceName,
  eventType,
  actors,
  fatalities,
  confidence,
  semantics,
  countryScopes = [],
}) {
  const safeId = clean(String(id || ''), 160);
  const safeTitle = clean(title, 240);
  const occurredAt = date(eventAt) || date(reportedAt);
  const safeUrl = clean(sourceUrl, 800);
  if (
    !safeId ||
    !safeTitle ||
    !occurredAt ||
    !/^https?:\/\//i.test(safeUrl || '')
  )
    return null;
  const lat = numericCoordinate(latitude, -90, 90);
  const lon = numericCoordinate(longitude, -180, 180);
  const mapped = lat !== null && lon !== null;
  return {
    id: `${provider}:${safeId}`,
    provider,
    title: safeTitle,
    summary: clean(summary, 1_000),
    category: eventCategory,
    eventAt: occurredAt,
    reportedAt: date(reportedAt),
    latitude: mapped ? lat : null,
    longitude: mapped ? lon : null,
    location: clean(location, 180),
    country: clean(country, 100),
    locationPrecision: mapped ? locationPrecision : 'not-mappable',
    sourceUrl: safeUrl,
    sourceName: clean(sourceName, 180),
    attribution: {
      gdelt: 'The GDELT Project',
      acled: 'ACLED',
      ucdp: 'Uppsala Conflict Data Program',
      'ucdp-candidate': 'Uppsala Conflict Data Program',
      'hapi-conflict': 'HDX HAPI / ACLED',
      reliefweb: 'ReliefWeb / OCHA',
    }[provider],
    eventType: clean(eventType, 120),
    actors: (Array.isArray(actors) ? actors : [])
      .map((x) => clean(x, 120))
      .filter(Boolean)
      .slice(0, 8),
    fatalities:
      fatalities !== null &&
      fatalities !== undefined &&
      Number.isSafeInteger(Number(fatalities)) &&
      Number(fatalities) >= 0
        ? Number(fatalities)
        : null,
    confidence: clean(confidence, 80),
    semantics: clean(semantics, 300),
    countryScopes: (Array.isArray(countryScopes) ? countryScopes : [])
      .slice(0, 20)
      .map((scope) => {
        const code = clean(String(scope?.code || '').toUpperCase(), 3);
        const name = clean(scope?.name, 120);
        const latitude = numericCoordinate(scope?.latitude, -90, 90);
        const longitude = numericCoordinate(scope?.longitude, -180, 180);
        if (!name || (code && !/^[A-Z]{3}$/.test(code))) return null;
        return {
          code: code || null,
          name,
          latitude,
          longitude,
        };
      })
      .filter(Boolean),
  };
}

const CAMEO_ROOT_LABELS = Object.freeze({
  1: 'Make statement',
  2: 'Appeal',
  3: 'Express intent to cooperate',
  4: 'Consult',
  5: 'Diplomatic cooperation',
  6: 'Material cooperation',
  7: 'Provide aid',
  8: 'Yield or retreat',
  9: 'Investigate',
  10: 'Demand',
  11: 'Disapprove',
  12: 'Reject proposal',
  13: 'Threaten',
  14: 'Protest',
  15: 'Exhibit force',
  16: 'Reduce relations',
  17: 'Coerce',
  18: 'Assault',
  19: 'Fight',
  20: 'Mass violence',
});

function gdeltEventDate(value) {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : null;
}

function gdeltAddedDate(value) {
  return /^\d{14}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`
    : null;
}

function cameoCategory(root, quadClass) {
  if (quadClass === 1 || quadClass === 2) return 'cooperation';
  if (root === 14) return 'protest';
  if (root === 15) return 'military';
  if (root >= 18 && root <= 20) return 'political-violence';
  if (root >= 8 && root <= 17) return 'geopolitical-conflict';
  return quadClass === 4 ? 'political-violence' : 'geopolitical-conflict';
}

function normalizeGdeltEvents(text, limit = PROVIDER_LIMIT) {
  const rows = text.split(/\r?\n/);
  const events = [];
  for (const line of rows) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length < 61) continue;
    const eventId = fields[0];
    const quadClass = Number(fields[29]);
    const eventCode = fields[26];
    const rootCode = Number(fields[28]);
    const eventDate = gdeltEventDate(fields[1]);
    const addedAt = gdeltAddedDate(fields[59]);
    const sourceUrl = clean(fields[60], 800);
    if (
      !/^\d+$/.test(eventId) ||
      !eventDate ||
      !addedAt ||
      !sourceUrl ||
      !/^https?:\/\//i.test(sourceUrl) ||
      ![1, 2, 3, 4].includes(quadClass)
    )
      continue;

    const eventLabel = CAMEO_ROOT_LABELS[rootCode] || 'Conflict-related event';
    const actor1 = clean(fields[6] || fields[5], 120);
    const actor2 = clean(fields[16] || fields[15], 120);
    // GDELT's current export includes an ADM2 geography field, so each
    // geography block has eight columns (type, name, country, ADM1, ADM2,
    // latitude, longitude, feature ID). The action block therefore starts at
    // column 51, not 49 as in older Event Database schemas.
    const actionLocation = clean(fields[52], 180);
    const locationType = Number(fields[51]);
    const precision =
      {
        1: 'country centroid',
        2: 'administrative region',
        3: 'US city or landmark',
        4: 'world city or landmark',
        5: 'administrative region',
      }[locationType] || 'unspecified';
    const articleCount = Number(fields[33]);
    const mentionCount = Number(fields[31]);
    const goldstein = Number(fields[30]);
    const details = [
      `CAMEO ${eventCode}`,
      Number.isSafeInteger(articleCount) && articleCount > 0
        ? `${articleCount} article${articleCount === 1 ? '' : 's'}`
        : null,
      Number.isSafeInteger(mentionCount) && mentionCount > 0
        ? `${mentionCount} report mention${mentionCount === 1 ? '' : 's'}`
        : null,
      Number.isFinite(goldstein) ? `Goldstein ${goldstein}` : null,
    ].filter(Boolean);
    const item = event({
      provider: 'gdelt',
      id: eventId,
      title: `${actor1 || 'Reported actor'}${actor2 ? ` → ${actor2}` : ''} · ${eventLabel}`,
      summary: `GDELT identified this event in news coverage. ${details.join(' · ')}. Verify the linked report and context.`,
      category: cameoCategory(rootCode, quadClass),
      eventAt: eventDate,
      reportedAt: addedAt,
      latitude: fields[56],
      longitude: fields[57],
      location: actionLocation,
      locationPrecision: `GDELT action location · ${precision}`,
      sourceUrl,
      sourceName: hostname(sourceUrl) || 'GDELT linked report',
      eventType: `CAMEO ${eventCode} · ${eventLabel}`,
      actors: [actor1, actor2],
      confidence: 'Automated event coding and geolocation; unverified',
      semantics:
        'GDELT event extracted from news coverage. Action coordinates are automated geographic references, not independently verified incident locations.',
    });
    if (item) events.push(item);
  }
  return events
    .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))
    .slice(0, limit);
}

function unzipGdeltCsv(bytes) {
  if (bytes.length < 22) throw safely('invalid_gdelt_archive', 502);
  const minEocd = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minEocd; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw safely('invalid_gdelt_archive', 502);
  const entries = bytes.readUInt16LE(eocd + 10);
  let central = bytes.readUInt32LE(eocd + 16);
  if (
    !entries ||
    entries > 16 ||
    central >= eocd ||
    central + 46 > bytes.length
  )
    throw safely('invalid_gdelt_archive', 502);
  for (let index = 0; index < entries; index++) {
    if (central + 46 > bytes.length) throw safely('invalid_gdelt_archive', 502);
    if (bytes.readUInt32LE(central) !== 0x02014b50)
      throw safely('invalid_gdelt_archive', 502);
    const flags = bytes.readUInt16LE(central + 8);
    const method = bytes.readUInt16LE(central + 10);
    const compressedSize = bytes.readUInt32LE(central + 20);
    const uncompressedSize = bytes.readUInt32LE(central + 24);
    const nameLength = bytes.readUInt16LE(central + 28);
    const extraLength = bytes.readUInt16LE(central + 30);
    const commentLength = bytes.readUInt16LE(central + 32);
    const localOffset = bytes.readUInt32LE(central + 42);
    const nextCentral = central + 46 + nameLength + extraLength + commentLength;
    if (nextCentral > bytes.length || nextCentral > eocd)
      throw safely('invalid_gdelt_archive', 502);
    const name = bytes.toString(
      'utf8',
      central + 46,
      central + 46 + nameLength,
    );
    central = nextCentral;
    if (!name.endsWith('.export.CSV')) continue;
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      uncompressedSize > GDELT_CSV_LIMIT ||
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw safely('invalid_gdelt_archive', 502);
    const dataOffset =
      localOffset +
      30 +
      bytes.readUInt16LE(localOffset + 26) +
      bytes.readUInt16LE(localOffset + 28);
    if (dataOffset + compressedSize > bytes.length)
      throw safely('invalid_gdelt_archive', 502);
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    try {
      const content =
        method === 0
          ? compressed
          : inflateRawSync(compressed, { maxOutputLength: GDELT_CSV_LIMIT });
      if (content.length !== uncompressedSize)
        throw safely('invalid_gdelt_archive', 502);
      return content.toString('utf8');
    } catch (error) {
      if (error?.code) throw error;
      throw safely('invalid_gdelt_archive', 502);
    }
  }
  throw safely('invalid_gdelt_archive', 502);
}

function normalizeAcled(payload, fetchedAt) {
  const rows = payload?.data;
  if (!Array.isArray(rows))
    throw Object.assign(new Error('invalid_acled_data'), {
      code: 'invalid_acled_data',
    });
  return rows
    .slice(0, PROVIDER_LIMIT)
    .map((row) =>
      event({
        provider: 'acled',
        id: row.event_id_cnty,
        title: `${row.event_type || 'Conflict event'}${row.location ? ` · ${row.location}` : ''}`,
        summary: row.notes,
        category: category(
          `${row.event_type || ''} ${row.sub_event_type || ''}`,
          'acled',
        ),
        eventAt: row.event_date,
        reportedAt: fetchedAt,
        latitude: row.latitude,
        longitude: row.longitude,
        location: [row.location, row.admin1, row.country]
          .filter(Boolean)
          .join(', '),
        country: row.country,
        locationPrecision: `ACLED geo precision ${row.geo_precision ?? 'unspecified'}`,
        sourceUrl: row.source_url || `https://acleddata.com/`,
        sourceName: row.source || 'ACLED event data',
        eventType: row.sub_event_type || row.event_type,
        actors: [row.actor1, row.actor2],
        fatalities: Number(row.fatalities),
        confidence: 'ACLED coded event; see source and geo-precision fields',
        semantics: `ACLED event record ${row.event_id_cnty || ''}; data may be revised by ACLED.`,
      }),
    )
    .filter(Boolean);
}

function normalizeUcdp(
  payload,
  fetchedAt,
  { provider = 'ucdp', version = null } = {},
) {
  const rows = payload?.Result;
  if (!Array.isArray(rows))
    throw Object.assign(new Error('invalid_ucdp_data'), {
      code: 'invalid_ucdp_data',
    });
  return rows
    .slice(0, PROVIDER_LIMIT)
    .map((row) => {
      const dateValue =
        row.date_end ||
        row.date_start ||
        (row.year ? `${row.year}-01-01` : fetchedAt);
      const sourceUrl = row.source_url || row.url || 'https://ucdp.uu.se/';
      const deaths = row.best ?? row.deaths_best ?? row.deaths_a;
      return event({
        provider,
        id: row.id ?? row.relid,
        title: `${row.type_of_violence_name || row.conflict_name || 'Armed conflict'}${row.where_coordinates ? ` · ${row.where_coordinates}` : ''}`,
        summary: row.source_article || row.conflict_name,
        category: 'conflict',
        eventAt: dateValue,
        reportedAt: fetchedAt,
        latitude: row.latitude,
        longitude: row.longitude,
        location: [row.where_coordinates, row.adm_1, row.country]
          .filter(Boolean)
          .join(', '),
        country: row.country,
        locationPrecision: `UCDP location precision ${row.where_prec ?? 'unspecified'}`,
        sourceUrl,
        sourceName:
          row.source_original ||
          (provider === 'ucdp-candidate'
            ? `UCDP Candidate Events ${version || ''}`.trim()
            : 'UCDP Georeferenced Event Dataset'),
        eventType: row.type_of_violence_name || row.type_of_violence,
        actors: [row.side_a, row.side_b],
        fatalities: Number(deaths),
        confidence:
          provider === 'ucdp-candidate'
            ? 'UCDP Candidate record; preliminary and subject to review'
            : 'UCDP GED record; see dataset version and codebook',
        semantics:
          provider === 'ucdp-candidate'
            ? `Monthly UCDP Candidate release ${version || ''}; events are provisional and may change or be excluded from the final annual GED. Not a breaking-news feed.`
            : 'Versioned georeferenced armed-conflict dataset; not a breaking-news feed.',
      });
    })
    .filter(Boolean);
}

function normalizeReliefWeb(payload, fetchedAt) {
  const rows = payload?.data;
  if (!Array.isArray(rows))
    throw Object.assign(new Error('invalid_reliefweb_data'), {
      code: 'invalid_reliefweb_data',
    });
  return rows
    .slice(0, PROVIDER_LIMIT)
    .map((row) => {
      const fields = row.fields || {};
      const countries = Array.isArray(fields.country) ? fields.country : [];
      const scopeCountries = countries.length
        ? countries
        : fields.primary_country
          ? [fields.primary_country]
          : [];
      const countriesText = countries
        .map((country) => country.name)
        .filter(Boolean)
        .join(', ');
      const dateValue =
        fields.date?.created || fields.date?.original || fetchedAt;
      const sourceUrl = fields.url || `https://reliefweb.int/node/${row.id}`;
      return event({
        provider: 'reliefweb',
        id: row.id,
        title: fields.title,
        summary: fields.headline || fields.body,
        category: 'humanitarian',
        eventAt: fields.date?.event || dateValue,
        reportedAt: dateValue,
        location: countriesText || fields.primary_country?.name,
        country: fields.primary_country?.name || countriesText,
        locationPrecision:
          'Country/report geography; not an incident coordinate',
        sourceUrl,
        sourceName:
          fields.source
            ?.map?.((source) => source.name)
            .filter(Boolean)
            .join(', ') || 'ReliefWeb report',
        eventType:
          fields.disaster
            ?.map?.((item) => item.name)
            .filter(Boolean)
            .join(', ') || 'Humanitarian report',
        confidence: 'Published humanitarian report; consult original source',
        semantics:
          'Humanitarian report geography may describe the report scope rather than an incident point.',
        countryScopes: scopeCountries.map((country) => ({
          code: country.iso3,
          name: country.name || country.shortname,
          latitude: country.location?.lat,
          longitude: country.location?.lon,
        })),
      });
    })
    .filter(Boolean);
}

function safely(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

/** Independent, bounded provider clients; provider failures are isolated. */
export function geopoliticalProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const pending = new Map();
  let acledToken = null;
  let gdeltFeedCache = null;
  let gdeltFeedPending = null;

  async function requestBody(
    url,
    {
      signal,
      headers = {},
      method = 'GET',
      body,
      timeoutMs = TIMEOUT_MS,
      maxBytes = BODY_LIMIT,
      responseType = 'text',
    } = {},
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(url, {
        method,
        ...(body === undefined ? {} : { body }),
        headers: {
          Accept:
            responseType === 'bytes'
              ? 'application/zip, application/octet-stream'
              : 'application/json, text/plain',
          ...headers,
        },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw safely(
          response.status === 429
            ? 'rate_limited'
            : response.status === 403
              ? 'access_denied'
              : 'upstream_unavailable',
          response.status,
        );
      }
      return responseType === 'bytes'
        ? await readResponseBytesCapped(response, maxBytes)
        : await readResponseTextCapped(response, maxBytes, controller.signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (error?.code) throw error;
      throw safely('upstream_unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function requestJson(url, options = {}) {
    const text = await requestBody(url, options);
    try {
      return JSON.parse(text);
    } catch {
      throw safely('invalid_provider_data', 502);
    }
  }

  async function fetchGdeltFeed(signal) {
    const index = await requestBody(GDELT_INDEX_URL, {
      signal,
      timeoutMs: 30_000,
      maxBytes: 16 * 1024,
    });
    const match = index.match(
      /^(\d+)\s+([a-f\d]{32})\s+(https?:\/\/[^\s]+\.export\.CSV\.zip)\s*$/im,
    );
    if (!match) throw safely('invalid_gdelt_index', 502);
    const expectedSize = Number(match[1]);
    if (!Number.isSafeInteger(expectedSize) || expectedSize > BODY_LIMIT)
      throw safely('invalid_gdelt_index', 502);
    const fileUrl = new URL(match[3].replace(/^http:/i, 'https:'));
    if (
      fileUrl.protocol !== 'https:' ||
      fileUrl.hostname !== 'data.gdeltproject.org' ||
      !fileUrl.pathname.startsWith('/gdeltv2/') ||
      !fileUrl.pathname.endsWith('.export.CSV.zip')
    )
      throw safely('invalid_gdelt_index', 502);
    const archive = Buffer.from(
      await requestBody(fileUrl, {
        signal,
        timeoutMs: 30_000,
        maxBytes: BODY_LIMIT,
        responseType: 'bytes',
      }),
    );
    if (
      archive.length !== expectedSize ||
      createHash('md5').update(archive).digest('hex') !== match[2].toLowerCase()
    )
      throw safely('invalid_gdelt_archive', 502);
    return normalizeGdeltEvents(unzipGdeltCsv(archive), GDELT_FEED_EVENT_LIMIT);
  }

  async function loadGdeltFeed(signal) {
    if (gdeltFeedCache && now() - gdeltFeedCache.at < 15 * 60_000)
      return gdeltFeedCache.events;
    if (gdeltFeedPending) return gdeltFeedPending;
    gdeltFeedPending = fetchGdeltFeed(signal).then((events) => {
      gdeltFeedCache = { at: now(), events };
      return events;
    });
    try {
      return await gdeltFeedPending;
    } finally {
      gdeltFeedPending = null;
    }
  }

  async function gdelt(signal) {
    return (await loadGdeltFeed(signal)).slice(0, PROVIDER_LIMIT);
  }

  function withinRadius(event, latitude, longitude, radiusKm) {
    if (!Number.isFinite(event.latitude) || !Number.isFinite(event.longitude))
      return false;
    const toRadians = (degrees) => (degrees * Math.PI) / 180;
    const lat1 = toRadians(latitude);
    const lat2 = toRadians(event.latitude);
    const deltaLat = lat2 - lat1;
    const deltaLon = toRadians(event.longitude - longitude);
    const a =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= radiusKm;
  }

  async function searchGdeltArea(input, signal) {
    const latitude = numericCoordinate(input?.latitude, -90, 90);
    const longitude = numericCoordinate(input?.longitude, -180, 180);
    const radiusKm = Number(input?.radiusKm);
    const category = input?.category;
    if (
      latitude === null ||
      longitude === null ||
      !Number.isFinite(radiusKm) ||
      radiusKm < 1 ||
      radiusKm > MAX_VIEW_RADIUS_KM
    )
      throw safely('invalid_area', 400);
    if (!Object.hasOwn(GDELT_SEARCH_CATEGORIES, category))
      throw safely('invalid_category', 400);

    const selection = GDELT_SEARCH_CATEGORIES[category];
    const globalSearch = radiusKm > AREA_SEARCH_RADIUS_KM;
    const feed = await loadGdeltFeed(signal);
    const matches = feed.filter((item) => {
      const code = Number(item.eventType?.match(/^CAMEO (\d+)/)?.[1]);
      const root = Number(item.eventType?.match(/^CAMEO (\d{2})/)?.[1]);
      return (
        (selection.codes?.includes(code) || selection.roots?.includes(root)) &&
        (globalSearch || withinRadius(item, latitude, longitude, radiusKm))
      );
    });
    const events = matches.slice(0, GDELT_SEARCH_LIMIT);
    return {
      provider: 'geopolitical',
      fetchedAt: new Date(now()).toISOString(),
      stale: false,
      providers: [],
      events,
      search: {
        provider: 'gdelt',
        category,
        latitude,
        longitude,
        radiusKm,
        mode: globalSearch ? 'global' : 'area',
        limit: GDELT_SEARCH_LIMIT,
        totalMatches: matches.length,
      },
    };
  }

  async function searchUcdpArea(input, signal) {
    const latitude = numericCoordinate(input?.latitude, -90, 90);
    const longitude = numericCoordinate(input?.longitude, -180, 180);
    const radiusKm = Number(input?.radiusKm);
    if (
      latitude === null ||
      longitude === null ||
      !Number.isFinite(radiusKm) ||
      radiusKm < 1 ||
      radiusKm > MAX_VIEW_RADIUS_KM
    )
      throw safely('invalid_area', 400);

    const token = String(process.env.UCDP_API_TOKEN || '').trim();
    if (!token) throw safely('missing_credentials', 401);
    const headers = { 'x-ucdp-access-token': token };
    const globalSearch = radiusKm > AREA_SEARCH_RADIUS_KM;
    const geographyBoxes = globalSearch
      ? [null]
      : ucdpGeographyBoxes(latitude, longitude, radiusKm);
    const end = new Date(`${UCDP_DATA_END_DATE}T00:00:00.000Z`);
    const rows = new Map();
    let requestCount = 0;
    let truncated = false;

    for (
      let week = 0;
      week < 26 &&
      rows.size < GDELT_SEARCH_LIMIT &&
      requestCount < UCDP_SEARCH_REQUEST_LIMIT;
      week++
    ) {
      const weekEnd = new Date(end.getTime() - week * 7 * 24 * 60 * 60_000);
      const weekStart = new Date(weekEnd.getTime() - 6 * 24 * 60 * 60_000);
      const startDate = weekStart.toISOString().slice(0, 10);
      const endDate = weekEnd.toISOString().slice(0, 10);

      for (const box of geographyBoxes) {
        if (rows.size >= GDELT_SEARCH_LIMIT) break;
        if (requestCount >= UCDP_SEARCH_REQUEST_LIMIT) {
          truncated = true;
          break;
        }
        const firstUrl = new URL(UCDP_URL);
        const params = new URLSearchParams({
          pagesize: String(PROVIDER_LIMIT),
          page: '1',
          StartDate: startDate,
          EndDate: endDate,
        });
        if (box)
          params.set('Geography', `${box[0]} ${box[1]},${box[2]} ${box[3]}`);
        firstUrl.search = params;
        const first = await requestJson(firstUrl, { signal, headers });
        requestCount++;
        if (!Array.isArray(first?.Result))
          throw Object.assign(new Error('invalid_ucdp_data'), {
            code: 'invalid_ucdp_data',
          });
        const totalPages = Math.max(1, Number(first.TotalPages) || 1);
        const pagesToFetch = Math.min(totalPages, UCDP_SEARCH_PAGE_LIMIT);
        if (totalPages > pagesToFetch) truncated = true;
        const addRows = (resultRows) => {
          for (const row of resultRows) {
            const id = String(row?.id ?? row?.relid ?? '');
            if (!id || rows.has(id)) continue;
            if (
              !globalSearch &&
              !withinRadius(
                {
                  latitude: Number(row.latitude),
                  longitude: Number(row.longitude),
                },
                latitude,
                longitude,
                radiusKm,
              )
            )
              continue;
            rows.set(id, row);
          }
        };
        addRows(first.Result);
        for (
          let page = 2;
          page <= pagesToFetch && requestCount < UCDP_SEARCH_REQUEST_LIMIT;
          page++
        ) {
          const url = new URL(UCDP_URL);
          params.set('page', String(page));
          url.search = params;
          const payload = await requestJson(url, { signal, headers });
          requestCount++;
          if (!Array.isArray(payload?.Result))
            throw Object.assign(new Error('invalid_ucdp_data'), {
              code: 'invalid_ucdp_data',
            });
          addRows(payload.Result);
        }
        if (
          requestCount >= UCDP_SEARCH_REQUEST_LIMIT &&
          rows.size < GDELT_SEARCH_LIMIT
        )
          truncated = true;
      }
    }

    const events = normalizeUcdp(
      {
        Result: [...rows.values()]
          .sort((a, b) =>
            String(b.date_end || b.date_start || '').localeCompare(
              String(a.date_end || a.date_start || ''),
            ),
          )
          .slice(0, GDELT_SEARCH_LIMIT),
      },
      new Date(now()).toISOString(),
    );
    return {
      provider: 'geopolitical',
      fetchedAt: new Date(now()).toISOString(),
      stale: false,
      providers: [],
      events,
      search: {
        provider: 'ucdp',
        latitude,
        longitude,
        radiusKm,
        mode: globalSearch ? 'global' : 'area',
        limit: GDELT_SEARCH_LIMIT,
        totalMatches: rows.size,
        partial: truncated,
        dateThrough: UCDP_DATA_END_DATE,
      },
    };
  }

  async function ucdp(signal) {
    const token = String(process.env.UCDP_API_TOKEN || '').trim();
    if (!token) throw safely('missing_credentials', 401);
    const headers = { 'x-ucdp-access-token': token };
    const fetchedAt = new Date(now()).toISOString();
    const end = new Date(`${UCDP_DATA_END_DATE}T00:00:00.000Z`);
    const rows = [];
    const lookbackWeeks = 26;

    for (
      let week = 0;
      week < lookbackWeeks && rows.length < PROVIDER_LIMIT;
      week++
    ) {
      const weekEnd = new Date(end.getTime() - week * 7 * 24 * 60 * 60_000);
      const weekStart = new Date(weekEnd.getTime() - 6 * 24 * 60 * 60_000);
      const startDate = weekStart.toISOString().slice(0, 10);
      const endDate = weekEnd.toISOString().slice(0, 10);
      const firstUrl = new URL(UCDP_URL);
      firstUrl.search = new URLSearchParams({
        pagesize: String(PROVIDER_LIMIT),
        page: '1',
        StartDate: startDate,
        EndDate: endDate,
      });
      const first = await requestJson(firstUrl, { signal, headers });
      const pageCount = Number(first?.TotalPages);
      if (!Array.isArray(first?.Result))
        throw Object.assign(new Error('invalid_ucdp_data'), {
          code: 'invalid_ucdp_data',
        });
      rows.push(...first.Result);

      const totalPages = Number.isSafeInteger(pageCount)
        ? Math.max(1, pageCount)
        : 1;
      for (let page = 2; page <= totalPages; page++) {
        const url = new URL(UCDP_URL);
        url.search = new URLSearchParams({
          pagesize: String(PROVIDER_LIMIT),
          page: String(page),
          StartDate: startDate,
          EndDate: endDate,
        });
        const payload = await requestJson(url, { signal, headers });
        if (!Array.isArray(payload?.Result))
          throw Object.assign(new Error('invalid_ucdp_data'), {
            code: 'invalid_ucdp_data',
          });
        rows.push(...payload.Result);
      }
    }

    rows.sort((a, b) =>
      String(b.date_end || b.date_start || '').localeCompare(
        String(a.date_end || a.date_start || ''),
      ),
    );
    return normalizeUcdp({ Result: rows.slice(0, PROVIDER_LIMIT) }, fetchedAt);
  }

  function candidateVersions() {
    const cursor = new Date(now());
    cursor.setUTCDate(1);
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    return Array.from({ length: 4 }, (_, index) => {
      const month = new Date(cursor);
      month.setUTCMonth(month.getUTCMonth() - index);
      return `${String(month.getUTCFullYear()).slice(-2)}.0.${month.getUTCMonth() + 1}`;
    });
  }

  async function ucdpCandidate(signal) {
    const token = String(process.env.UCDP_API_TOKEN || '').trim();
    if (!token) throw safely('missing_credentials', 401);
    const headers = { 'x-ucdp-access-token': token };
    let first = null;
    let version = null;
    for (const candidateVersion of candidateVersions()) {
      const url = new URL(`${UCDP_CANDIDATE_URL}/${candidateVersion}`);
      url.search = new URLSearchParams({ pagesize: '100', page: '1' });
      try {
        const payload = await requestJson(url, { signal, headers });
        if (!Array.isArray(payload?.Result))
          throw safely('invalid_ucdp_data', 502);
        first = payload;
        version = candidateVersion;
        break;
      } catch (error) {
        if (error?.status === 404 || error?.status === 400) continue;
        throw error;
      }
    }
    if (!first || !version) throw safely('ucdp_candidate_unavailable', 503);

    const rows = [...first.Result];
    const totalPages = Math.max(1, Number(first.TotalPages) || 1);
    const pagesToFetch = Math.min(totalPages, UCDP_CANDIDATE_PAGE_LIMIT);
    for (let page = 2; page <= pagesToFetch; page++) {
      const url = new URL(`${UCDP_CANDIDATE_URL}/${version}`);
      url.search = new URLSearchParams({ pagesize: '100', page: String(page) });
      const payload = await requestJson(url, { signal, headers });
      if (!Array.isArray(payload?.Result))
        throw safely('invalid_ucdp_data', 502);
      rows.push(...payload.Result);
    }
    rows.sort((a, b) =>
      String(b.date_end || b.date_start || '').localeCompare(
        String(a.date_end || a.date_start || ''),
      ),
    );
    return normalizeUcdp(
      { Result: rows.slice(0, PROVIDER_LIMIT) },
      new Date(now()).toISOString(),
      { provider: 'ucdp-candidate', version },
    );
  }

  function hapiApplicationIdentifier() {
    const appName = String(process.env.HAPI_APP_NAME || '').trim();
    const contactEmail = String(process.env.HAPI_CONTACT_EMAIL || '').trim();
    if (!appName || !contactEmail) throw safely('missing_hapi_identity', 401);
    // HAPI's app_identifier is the base64 encoding of "application name:email".
    // Construct it server-side so it never needs to be exposed to browser code.
    return Buffer.from(`${appName}:${contactEmail}`, 'utf8').toString('base64');
  }

  function hapiConflictMonths() {
    const cursor = new Date(now());
    cursor.setUTCDate(1);
    cursor.setUTCHours(0, 0, 0, 0);
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    return Array.from({ length: 3 }, (_, index) => {
      const month = new Date(cursor);
      month.setUTCMonth(month.getUTCMonth() - index);
      return {
        year: month.getUTCFullYear(),
        month: month.getUTCMonth() + 1,
        start: `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}-01`,
      };
    });
  }

  function normalizeHapiConflict(rows, fetchedAt) {
    if (!Array.isArray(rows)) throw safely('invalid_hapi_data', 502);
    const countryNameByCode = new Map();
    const categoryRows = new Map();
    for (const row of rows) {
      const code = clean(String(row?.location_code || '').toUpperCase(), 3);
      const name = clean(row?.location_name, 120);
      const periodMatch = String(row?.reference_period_start || '').match(
        /^(\d{4})-(\d{2})/,
      );
      const year = Number(periodMatch?.[1] || row?.year);
      const month = Number(periodMatch?.[2] || row?.month);
      const eventType = clean(row?.event_type, 100);
      const eventCount = Number(row?.events);
      const fatalities =
        row?.fatalities === null || row?.fatalities === undefined
          ? null
          : Number(row.fatalities);
      if (
        !code ||
        !/^[A-Z]{3}$/.test(code) ||
        !name ||
        !Number.isInteger(year) ||
        year < 2000 ||
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12 ||
        !eventType ||
        row?.events === null ||
        row?.events === undefined ||
        !Number.isFinite(eventCount) ||
        eventCount < 0
      )
        continue;
      const period = `${year}-${String(month).padStart(2, '0')}`;
      const adminLevel =
        row?.admin_level !== null &&
        row?.admin_level !== undefined &&
        Number.isInteger(Number(row.admin_level))
          ? Number(row.admin_level)
          : 99;
      const key = `${code}|${period}|${eventType}`;
      countryNameByCode.set(code, name);
      let aggregate = categoryRows.get(key);
      if (!aggregate || adminLevel < aggregate.adminLevel) {
        aggregate = {
          code,
          name,
          period,
          eventType,
          adminLevel,
          events: 0,
          fatalities: 0,
          hasFatalities: false,
        };
        categoryRows.set(key, aggregate);
      }
      if (adminLevel !== aggregate.adminLevel) continue;
      aggregate.events += Math.round(eventCount);
      if (Number.isFinite(fatalities) && fatalities >= 0) {
        aggregate.fatalities += Math.round(fatalities);
        aggregate.hasFatalities = true;
      }
    }

    const byCountry = new Map();
    for (const aggregate of categoryRows.values()) {
      const code = aggregate.code;
      let country = byCountry.get(code);
      if (!country) {
        country = {
          code,
          name: countryNameByCode.get(code) || aggregate.name,
          months: new Map(),
        };
        byCountry.set(code, country);
      }
      if (!country.months.has(aggregate.period))
        country.months.set(aggregate.period, []);
      country.months.get(aggregate.period).push({
        name: aggregate.eventType,
        events: aggregate.events,
        fatalities: aggregate.hasFatalities ? aggregate.fatalities : null,
      });
    }

    return [...byCountry.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, HAPI_COUNTRY_LIMIT)
      .map((country) => {
        const months = [...country.months]
          .map(([period, categories]) => ({
            period,
            categories: categories.sort((a, b) => a.name.localeCompare(b.name)),
          }))
          .sort((a, b) => b.period.localeCompare(a.period));
        const newestPeriod = months[0]?.period;
        return event({
          provider: 'hapi-conflict',
          id: country.code,
          title: `${country.name} · ACLED conflict-event aggregates`,
          summary: months
            .map(
              ({ period, categories }) =>
                `${period}: ${categories.map((item) => `${item.name} ${item.events} events${item.fatalities === null ? '' : ` / ${item.fatalities} fatalities`}`).join('; ')}`,
            )
            .join(' · '),
          category: 'political-violence',
          eventAt: `${newestPeriod}-01T00:00:00.000Z`,
          reportedAt: fetchedAt,
          location: country.name,
          country: country.name,
          locationPrecision:
            'Country reference point; monthly aggregate, not incident location',
          sourceUrl:
            'https://data.humdata.org/dataset/acled-conflict-events-data-series',
          sourceName: 'HDX HAPI / ACLED public aggregate',
          eventType: months.map(({ period }) => period).join(', '),
          confidence:
            'Monthly country/admin-region aggregates; categories are non-mutually-exclusive',
          semantics:
            'ACLED-derived public aggregates, refreshed weekly. Category totals can overlap. The map marker is a country reference point, not an incident location.',
          countryScopes: [{ code: country.code, name: country.name }],
        });
      })
      .filter(Boolean);
  }

  async function hapiConflict(signal) {
    const appIdentifier = hapiApplicationIdentifier();
    const months = hapiConflictMonths();
    const rows = [];
    for (const period of months) {
      let offset = 0;
      for (let page = 0; page < HAPI_PAGE_LIMIT; page++) {
        const url = new URL(HAPI_CONFLICT_URL);
        url.search = new URLSearchParams({
          app_identifier: appIdentifier,
          output_format: 'json',
          start_date: period.start,
          end_date: new Date(Date.UTC(period.year, period.month, 0))
            .toISOString()
            .slice(0, 10),
          limit: String(HAPI_PAGE_SIZE),
          offset: String(offset),
        });
        const payload = await requestJson(url, {
          signal,
          maxBytes: BODY_LIMIT,
        });
        if (!Array.isArray(payload?.data))
          throw safely('invalid_hapi_data', 502);
        rows.push(...payload.data);
        if (payload.data.length < HAPI_PAGE_SIZE) break;
        offset += HAPI_PAGE_SIZE;
      }
    }
    return normalizeHapiConflict(rows, new Date(now()).toISOString());
  }

  async function getAcledToken(signal) {
    const username = String(process.env.ACLED_USERNAME || '').trim();
    const password = String(process.env.ACLED_PASSWORD || '').trim();
    if (!username || !password) throw safely('missing_credentials', 401);
    if (acledToken && acledToken.expiresAt > now() + 60_000)
      return acledToken.value;
    const body = new URLSearchParams({
      username,
      password,
      grant_type: 'password',
      client_id: 'acled',
      scope: 'authenticated',
    });
    const payload = await requestJson(ACLED_TOKEN_URL, {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (
      typeof payload?.access_token !== 'string' ||
      !Number.isFinite(payload?.expires_in)
    )
      throw safely('invalid_provider_data', 502);
    acledToken = {
      value: payload.access_token,
      expiresAt: now() + payload.expires_in * 1000,
    };
    return acledToken.value;
  }

  async function acled(signal) {
    const token = await getAcledToken(signal);
    const url = new URL(ACLED_EVENTS_URL);
    const since = new Date(now() - 45 * 24 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);
    url.search = new URLSearchParams({
      event_date: `${since}|${new Date(now()).toISOString().slice(0, 10)}`,
      event_date_where: 'BETWEEN',
      limit: String(PROVIDER_LIMIT),
      order: 'event_date|DESC',
    });
    return normalizeAcled(
      await requestJson(url, {
        signal,
        headers: { Authorization: `Bearer ${token}` },
      }),
      new Date(now()).toISOString(),
    );
  }

  async function reliefweb(signal) {
    const appname = String(process.env.RELIEFWEB_APPNAME || '').trim();
    if (!appname) throw safely('awaiting_appname_approval', 424);
    const url = new URL(RELIEFWEB_URL);
    url.searchParams.set('appname', appname);
    const payload = await requestJson(url, {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: PROVIDER_LIMIT,
        sort: ['date.created:desc'],
        fields: {
          include: [
            'title',
            'headline',
            'url',
            'date',
            'country',
            'primary_country',
            'source',
            'disaster',
          ],
        },
        filter: {
          field: 'date.created',
          value: {
            from: reliefWebDateTime(now() - 7 * 24 * 60 * 60_000),
            to: reliefWebDateTime(now()),
          },
        },
      }),
    });
    return normalizeReliefWeb(payload, new Date(now()).toISOString());
  }

  async function providerSnapshot(id, fetcher, signal) {
    const ttl =
      id === 'gdelt'
        ? 15 * 60_000
        : id === 'reliefweb'
          ? 15 * 60_000
          : id === 'ucdp-candidate' || id === 'hapi-conflict'
            ? 24 * 60 * 60_000
            : id === 'acled'
              ? 60 * 60_000
              : 24 * 60 * 60_000;
    const cached = cache.get(id);
    if (cached && now() - cached.at < ttl)
      return {
        events: cached.events,
        status: 'updated',
        fetchedAt: cached.fetchedAt,
      };
    if (pending.has(id)) return pending.get(id);
    const operation = (async () => {
      try {
        const events = await fetcher(signal);
        const fetchedAt = new Date(now()).toISOString();
        cache.set(id, { at: now(), fetchedAt, events });
        return { events, status: 'updated', fetchedAt };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (cached && now() - cached.at < 7 * 24 * 60 * 60_000)
          return {
            events: cached.events,
            status: 'stale',
            fetchedAt: cached.fetchedAt,
            error: 'Upstream unavailable; showing cached records.',
          };
        const code = error?.code;
        return {
          events: [],
          status:
            code === 'missing_credentials'
              ? 'needs-credentials'
              : code === 'access_denied' && id === 'acled'
                ? 'needs-access'
                : code === 'awaiting_appname_approval'
                  ? 'awaiting-approval'
                  : code === 'missing_hapi_identity'
                    ? 'needs-credentials'
                    : 'unavailable',
          fetchedAt: null,
          error:
            code === 'missing_credentials'
              ? 'Configure this provider in Provider Settings.'
              : code === 'access_denied' && id === 'acled'
                ? 'ACLED accepted the login but denied event access. Ask ACLED to enable API access for this account and confirm any required consent or profile fields.'
                : code === 'awaiting_appname_approval'
                  ? 'Waiting for ReliefWeb app-name approval.'
                  : code === 'missing_hapi_identity'
                    ? 'Add HAPI application name and contact email in Provider Settings.'
                    : 'Provider temporarily unavailable.',
        };
      } finally {
        pending.delete(id);
      }
    })();
    pending.set(id, operation);
    return operation;
  }

  async function snapshot(signal) {
    const results = await Promise.all(
      PROVIDER_IDS.map(async (id) => {
        const fetcher = {
          gdelt,
          acled,
          ucdp,
          'ucdp-candidate': ucdpCandidate,
          'hapi-conflict': hapiConflict,
          reliefweb,
        }[id];
        const value = await providerSnapshot(id, fetcher, signal);
        return { id, ...value, count: value.events.length };
      }),
    );
    // Keep each provider's newest slice before applying the shared globe cap.
    // Without this, high-volume recent feeds could evict all UCDP records,
    // whose versioned dataset dates are older by design.
    const events = results.flatMap((result) =>
      result.events
        .slice()
        .sort((a, b) => b.eventAt.localeCompare(a.eventAt))
        .slice(
          0,
          result.id === 'hapi-conflict' ? HAPI_COUNTRY_LIMIT : PROVIDER_LIMIT,
        ),
    );
    events.sort((a, b) => b.eventAt.localeCompare(a.eventAt));
    events.splice(EVENT_LIMIT);
    return {
      provider: 'geopolitical',
      fetchedAt: new Date(now()).toISOString(),
      stale: results.some((item) => item.status === 'stale'),
      providers: results.map(({ id, status, fetchedAt, count, error }) => ({
        id,
        status,
        fetchedAt,
        count,
        error: error || null,
      })),
      events,
    };
  }

  function middleware(req, res) {
    const send = (status, body) => {
      const json = JSON.stringify(body);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', Buffer.byteLength(json));
      res.end(json);
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    if (req.url && req.url !== '/' && req.url !== '')
      return send(400, { error: 'invalid_query' });
    const controller = new AbortController();
    res.once?.('close', () => controller.abort());
    snapshot(controller.signal)
      .then((value) => send(200, value))
      .catch(() => {
        if (!controller.signal.aborted)
          send(503, { error: 'provider_unavailable' });
      });
  }

  async function searchMiddleware(req, res) {
    const send = (status, body) => {
      const json = JSON.stringify(body);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', Buffer.byteLength(json));
      res.end(json);
    };
    if (req.method !== 'POST')
      return send(405, { error: 'method_not_allowed' });
    if (req.url && req.url !== '/' && req.url !== '')
      return send(400, { error: 'invalid_query' });
    const controller = new AbortController();
    res.once?.('close', () => controller.abort());
    try {
      const bytes = await readRequestBodyCapped(req, 4 * 1024);
      let input;
      try {
        input = JSON.parse(bytes.toString('utf8'));
      } catch {
        return send(400, { error: 'invalid_request' });
      }
      const result =
        input?.provider === 'ucdp'
          ? await searchUcdpArea(input, controller.signal)
          : input?.provider === undefined || input.provider === 'gdelt'
            ? await searchGdeltArea(input, controller.signal)
            : (() => {
                throw safely('invalid_provider', 400);
              })();
      return send(200, result);
    } catch (error) {
      if (controller.signal.aborted) return;
      const status =
        error?.code === 'BODY_TOO_LARGE' ? 413 : error?.status || 503;
      return send(status, { error: error?.code || 'provider_unavailable' });
    }
  }

  function install(middlewares) {
    middlewares.use('/api/geopolitical/events', middleware);
    middlewares.use('/api/geopolitical/search', searchMiddleware);
  }

  return {
    name: 'geopolitical-providers',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
