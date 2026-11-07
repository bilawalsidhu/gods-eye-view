// The server imports this module. Keep the projection independent of Cesium,
// DOM and the translation catalog, and never copy an upstream record wholesale.
import { msg } from '../../i18n/marker.js';
import { acartiaSpeciesGroup, inAcartiaCoverage } from './acartiaTaxa.js';

const OPEN_PHOTO_LICENCES = Object.freeze([
  'cc0',
  'cc-by',
  'cc-by-sa',
  'cc-by-nc',
  'cc-by-nc-sa',
]);

const DAY_MS = 86_400_000;
const ACARTIA_MAX_AGE_MS = 8 * DAY_MS;
const OBSERVATION_FUTURE_TOLERANCE_MS = 10 * 60_000;
// A JavaScript $ can match before a final newline; require the true end too.
const INAT_PHOTO =
  /^https:\/\/inaturalist-open-data\.s3\.amazonaws\.com\/photos\/\d+\/square\.(jpe?g|png)$(?![\s\S])/i;
const INAT_OBSERVATION =
  /^https:\/\/www\.inaturalist\.org\/observations\/\d+$(?![\s\S])/;

/** Accept only canonical iNaturalist observation pages, without URL suffixes. */
function inatObservationUri(value) {
  return typeof value === 'string' && INAT_OBSERVATION.test(value)
    ? value
    : null;
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function numberOrNull(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validPosition(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    Number.isFinite(lon) &&
    Math.abs(lon) <= 180
  );
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
    ? value
    : null;
}

/** Date-only records cannot prove a time within a partly expired cutoff day.
 * Use its start conservatively, including for privacy-preserving cached cells. */
function withinObservationWindow(observedAt, observedOn, nowMs, windowMs) {
  const time = Number.isFinite(observedAt)
    ? observedAt
    : dateOnly(observedOn)
      ? Date.parse(`${observedOn}T00:00:00Z`)
      : NaN;
  return (
    Number.isFinite(time) &&
    Number.isFinite(nowMs) &&
    Number.isFinite(windowMs) &&
    windowMs >= 0 &&
    time >= nowMs - windowMs &&
    time <= nowMs + OBSERVATION_FUTURE_TOLERANCE_MS
  );
}

/** Apply the displayed observation window to projected and retained LRU rows. */
export function isRecentWildlifeSighting(row, nowMs, taxa = 'all') {
  return withinObservationWindow(
    row?.observedAt,
    row?.observedOn,
    nowMs,
    (taxa === 'whales' ? 7 : 2) * DAY_MS,
  );
}

/** Strictly parse the two documented Acartia forms. A timezone-free SQL-style
 * value is UTC; ISO timestamps must carry a timezone rather than using the host's. */
export function parseAcartiaTime(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const sql = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text);
  const iso =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      text,
    );
  if (!sql && !iso) return null;
  const day = dateOnly(text.slice(0, 10));
  if (!day) return null;
  const [hour, minute, second] = text.slice(11, 19).split(':').map(Number);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const time = Date.parse(sql ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isFinite(time) ? time : null;
}

function coarsen(value, precision = 2) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

/** Public iNaturalist obscuration is a 0.2-degree cell aligned to zero. The
 * rounding removes floating-point noise, including at negative longitudes. */
export function obscuredCell(lat, lon) {
  if (!validPosition(lat, lon)) return null;
  const south = Math.min(89.8, Math.floor(lat * 5) / 5);
  const west = Math.min(179.8, Math.floor(lon * 5) / 5);
  return {
    south: coarsen(south, 1),
    north: coarsen(south + 0.2, 1),
    west: coarsen(west, 1),
    east: coarsen(west + 0.2, 1),
  };
}

/** Only the documented open-data square URL can be transformed to a display size. */
export function inatPhotoUrl(url, size = 'square') {
  if (typeof url !== 'string' || !INAT_PHOTO.test(url)) return null;
  if (size !== 'square' && size !== 'medium') return null;
  return size === 'square' ? url : url.replace(/\/square\./i, `/${size}.`);
}

/** Accept either the first upstream photo or the explicitly projected photo. */
export function isOpenPhoto(photo) {
  if (!photo || typeof photo !== 'object') return false;
  const licence = photo.license_code ?? photo.licence;
  return (
    OPEN_PHOTO_LICENCES.includes(licence) &&
    inatPhotoUrl(photo.url ?? photo.square) !== null &&
    cleanText(photo.attribution, 160) !== null
  );
}

/** Licence codes remain provider data; the all-rights-reserved fallback is
 * marked for translation when cards display it. */
export function inatLicenceLabel(code) {
  switch (code) {
    case 'cc0':
      return 'CC0';
    case 'cc-by':
      return 'CC BY';
    case 'cc-by-sa':
      return 'CC BY-SA';
    case 'cc-by-nc':
      return 'CC BY-NC';
    case 'cc-by-nc-sa':
      return 'CC BY-NC-SA';
    case 'cc-by-nd':
      return 'CC BY-ND';
    case 'cc-by-nc-nd':
      return 'CC BY-NC-ND';
    default:
      return msg('All rights reserved');
  }
}

/**
 * Project API-v1 observation results (the results ARRAY, not the response
 * envelope). Malformed rows are skipped; only a non-array rejects a snapshot.
 */
export function normalizeInatObservations(
  payload,
  { nowMs, windowMs = 2 * DAY_MS } = {},
) {
  if (!Array.isArray(payload)) return null;
  const rows = [];
  const ids = new Set();
  for (const raw of payload) {
    if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= 0) continue;
    if (raw.geoprivacy === 'private' || raw.taxon_geoprivacy === 'private')
      continue;
    if (raw.quality_grade !== 'research' && raw.quality_grade !== 'needs_id')
      continue;
    const stableId = `inat:${raw.id}`;
    if (ids.has(stableId)) continue;
    let lon = raw.geojson?.coordinates?.[0];
    let lat = raw.geojson?.coordinates?.[1];
    if (!validPosition(lat, lon) && typeof raw.location === 'string') {
      const parts = raw.location.split(',');
      if (parts.length === 2) [lat, lon] = parts.map(numberOrNull);
    }
    if (!validPosition(lat, lon)) continue;
    const obscured =
      raw.obscured === true ||
      raw.geoprivacy === 'obscured' ||
      raw.taxon_geoprivacy === 'obscured';
    const cell = obscured ? obscuredCell(lat, lon) : null;
    const time = parseAcartiaTime(raw.time_observed_at);
    const observedOn =
      dateOnly(raw.observed_on) ||
      (time !== null ? new Date(time).toISOString().slice(0, 10) : null);
    // The v1 d1 parameter is a DATE filter, so its first day over-fetches the
    // exact rolling window. Filter before hiding an obscured record's time.
    if (
      Number.isFinite(nowMs) &&
      !withinObservationWindow(time, observedOn, nowMs, windowMs)
    )
      continue;
    const photo = Array.isArray(raw.photos) ? raw.photos[0] : null;
    const taxon = raw.taxon;
    const faves = numberOrNull(raw.faves_count);
    const agreements = numberOrNull(raw.num_identification_agreements);
    ids.add(stableId);
    rows.push({
      stableId,
      origin: 'inaturalist',
      lat: cell ? coarsen((cell.south + cell.north) / 2, 1) : lat,
      lon: cell ? coarsen((cell.west + cell.east) / 2, 1) : lon,
      obscured,
      cell,
      observedAt: obscured ? null : time,
      observedOn,
      quality: raw.quality_grade,
      commonName: cleanText(taxon?.preferred_common_name, 100),
      scientificName: cleanText(taxon?.name, 100),
      iconic: cleanText(taxon?.iconic_taxon_name, 40) || 'Unknown',
      threatened: taxon?.threatened === true,
      provider: null,
      link:
        inatObservationUri(raw.uri) ||
        `https://www.inaturalist.org/observations/${raw.id}`,
      photo: isOpenPhoto(photo)
        ? {
            square: inatPhotoUrl(photo.url),
            licence: photo.license_code,
            attribution: cleanText(photo.attribution, 160),
          }
        : null,
      // These public aggregate counters are used only for ambient photo rank.
      favesCount: faves !== null && faves >= 0 ? Math.floor(faves) : 0,
      identificationAgreements:
        agreements !== null && agreements >= 0 ? Math.floor(agreements) : 0,
    });
  }
  return rows;
}

// Acartia has no documented per-sighting page, and photo_url is supplied by the
// contributor. The source link is therefore always the Acartia site itself.
export const ACARTIA_SITE = 'https://acartia.io/';

/** Acartia documents flat rows only. Name and entity are text fields; unknown
 * shapes are skipped rather than guessing nested provider data. */
export function normalizeAcartiaSightings(payload, nowMs) {
  if (!Array.isArray(payload)) return null;
  const rows = [];
  const ids = new Set();
  for (const raw of payload) {
    const id =
      typeof raw?.entry_id === 'string'
        ? cleanText(raw.entry_id, 120)
        : Number.isFinite(raw?.entry_id)
          ? String(raw.entry_id)
          : null;
    if (!id) continue;
    const stableId = `acartia:${id}`;
    if (ids.has(stableId)) continue;
    const lat = numberOrNull(raw.latitude);
    const lon = numberOrNull(raw.longitude);
    const observedAt = parseAcartiaTime(raw.created);
    const name = cleanText(raw.data_source_name, 60);
    const species = cleanText(raw.type, 100);
    // Validate the original field: truncating a long, ambiguous name could
    // otherwise turn a prefix such as "Orca ... or seal" into a valid species.
    const speciesGroup = acartiaSpeciesGroup(raw.type);
    if (
      !validPosition(lat, lon) ||
      !inAcartiaCoverage(lat, lon) ||
      !name ||
      !speciesGroup ||
      observedAt === null ||
      !Number.isFinite(nowMs) ||
      nowMs - observedAt > ACARTIA_MAX_AGE_MS ||
      observedAt - nowMs > OBSERVATION_FUTURE_TOLERANCE_MS
    )
      continue;
    ids.add(stableId);
    rows.push({
      stableId,
      origin: 'acartia',
      lat: coarsen(lat),
      lon: coarsen(lon),
      obscured: false,
      cell: null,
      observedAt,
      observedOn: new Date(observedAt).toISOString().slice(0, 10),
      quality:
        raw.trusted === true || raw.trusted === 1 || raw.trusted === 'true'
          ? 'research'
          : 'needs_id',
      commonName: species,
      scientificName: null,
      iconic: 'Mammalia',
      cetacean: speciesGroup === 'cetacean',
      threatened: false,
      provider: { name, entity: cleanText(raw.data_source_entity, 60) },
      link: ACARTIA_SITE,
      photo: null,
      favesCount: 0,
      identificationAgreements: 0,
    });
  }
  return rows;
}

/** Recheck observation age on projected snapshots, including stale cache rows. */
export function mergeSightings(
  inatRows,
  acartiaRows,
  { nowMs, taxa = 'all', confirmed = false } = {},
) {
  const byId = new Map();
  for (const row of Array.isArray(inatRows) ? inatRows : []) {
    if (isRecentWildlifeSighting(row, nowMs, taxa)) byId.set(row.stableId, row);
  }
  for (const row of Array.isArray(acartiaRows) ? acartiaRows : []) {
    if (
      !inAcartiaCoverage(row.lat, row.lon) ||
      !isRecentWildlifeSighting(row, nowMs, taxa)
    )
      continue;
    if (confirmed && row.quality !== 'research') continue;
    if (/inaturalist/i.test(row.provider?.name || '')) continue;
    if (!['all', 'Mammalia', 'whales'].includes(taxa)) continue;
    if (taxa === 'whales' && row.cetacean !== true) continue;
    byId.set(row.stableId, row);
  }
  return [...byId.values()];
}
