/**
 * Amateur-radio repeater rules — pure and portable.
 *
 * Shared by the directory proxy (normalising HamRig's FM and D-STAR payloads
 * into one provider-neutral row), the Repeaters layer (validation, filtering,
 * labels, camera fetch plan) and the voice tool. Nothing here touches the
 * DOM, Cesium or Node APIs.
 *
 * A repeater row is directory data, not radio coverage: `distanceKm` is the
 * ground distance from a search centre, `status` is whatever the directory
 * last recorded, and `confidence`/`recordUpdatedAt` say how far the row can be
 * trusted. Every adapter (HamRig today; RepeaterBook or OpenStreetMap as
 * operator additions) produces the same `REPEATER_ROW_KEYS`.
 */

const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

/** Amateur allocations, inclusive Hz ranges, ascending. */
export const HAM_BANDS = Object.freeze(
  [
    ['2200m', 135_700, 137_800],
    ['630m', 472_000, 479_000],
    ['160m', 1_800_000, 2_000_000],
    ['80m', 3_500_000, 4_000_000],
    ['60m', 5_250_000, 5_450_000],
    ['40m', 7_000_000, 7_300_000],
    ['30m', 10_100_000, 10_150_000],
    ['20m', 14_000_000, 14_350_000],
    ['17m', 18_068_000, 18_168_000],
    ['15m', 21_000_000, 21_450_000],
    ['12m', 24_890_000, 24_990_000],
    ['10m', 28_000_000, 29_700_000],
    ['6m', 50_000_000, 54_000_000],
    ['4m', 70_000_000, 70_500_000],
    ['2m', 144_000_000, 148_000_000],
    ['1.25m', 222_000_000, 225_000_000],
    ['70cm', 420_000_000, 450_000_000],
    ['33cm', 902_000_000, 928_000_000],
    ['23cm', 1_240_000_000, 1_300_000_000],
  ].map(([band, lowHz, highHz]) => Object.freeze({ band, lowHz, highHz })),
);

export const REPEATER_KINDS = Object.freeze(['FM', 'D-STAR']);

export const REPEATER_COLORS = Object.freeze({
  FM: '#f59e0b',
  'D-STAR': '#a855f7',
  other: '#9aa4b2',
});

/** Bands the panel and voice filter by; `23cm` rows exist in the directory. */
export const REPEATER_BANDS = Object.freeze([
  '6m',
  '2m',
  '1.25m',
  '70cm',
  '23cm',
]);

/** The subset HamRig's FM route can filter upstream; the rest is filtered here. */
export const UPSTREAM_FM_BANDS = Object.freeze(['6m', '2m', '1.25m', '70cm']);

export const REPEATER_KIND_FILTERS = Object.freeze(
  [
    { id: 'all', label: 'All repeaters' },
    { id: 'FM', label: 'FM' },
    { id: 'D-STAR', label: 'D-STAR' },
  ].map((row) => Object.freeze(row)),
);

export const REPEATER_BAND_FILTERS = Object.freeze(
  [
    { id: 'all', label: 'All bands' },
    { id: '6m', label: '6 m' },
    { id: '2m', label: '2 m' },
    { id: '1.25m', label: '1.25 m' },
    { id: '70cm', label: '70 cm' },
    { id: '23cm', label: '23 cm' },
  ].map((row) => Object.freeze(row)),
);

/** How far a row can be trusted; shown on every marker and card. */
export const REPEATER_CONFIDENCES = Object.freeze([
  'verified',
  'reported',
  'unverified',
]);

/** The provider-neutral row every adapter produces, in this key order. */
export const REPEATER_ROW_KEYS = Object.freeze([
  'id',
  'kind',
  'callsign',
  'outputHz',
  'inputHz',
  'offsetHz',
  'band',
  'toneHz',
  'toneBurstHz',
  'module',
  'city',
  'region',
  'country',
  'lat',
  'lon',
  'positionPrecise',
  'distanceKm',
  'status',
  'statusKnown',
  'echolink',
  'allstar',
  'irlp',
  'wires',
  'source',
  'sourceLabel',
  'sourceUrl',
  'confidence',
  'recordUpdatedAt',
]);

/** Camera height above which the layer does not load around the view. */
export const HEIGHT_GATE_M = 1_500_000;
export const MAX_RADIUS_KM = 300;
export const MIN_RADIUS_KM = 15;
export const DEFAULT_RADIUS_KM = 100;
export const MOVE_END_DEBOUNCE_MS = 1500;
/** Upstream row cap per request. */
export const DEFAULT_LIMIT = 200;
/** Panel list cap. */
export const LIST_LIMIT = 200;
export const FAILED_LOAD_RETRY_MS = 30_000;
export const REPEATERS_ENDPOINT = '/api/ham-repeaters/nearby';

/** CTCSS tones live below this; a larger "tone" is the European tone-burst. */
const MAX_CTCSS_HZ = 300;

const HAMRIG_FM_SOURCE = Object.freeze({
  source: 'hamrig-fm',
  sourceLabel:
    'HamRig FM table (historic import, cross-checked against hearham.com)',
  confidence: 'unverified',
});
const HAMRIG_DSTAR_SOURCE = Object.freeze({
  source: 'hamrig-dstar',
  sourceLabel: 'dstarinfo.com / ircddb.net via HamRig',
  confidence: 'reported',
});

// ── text and number helpers ──────────────────────────────────────────────

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const number = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

/** Collapse control characters and whitespace; bound the length. */
export function cleanText(value, maxLength = 120) {
  return String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function textOrNull(value, maxLength = 120) {
  const text = cleanText(value, maxLength);
  return text ? text : null;
}

/** Upstream text: null for empty and the directory's `NOT_FOUND` marker. */
function str(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || text === 'NOT_FOUND' ? null : text;
}

function upper(value) {
  const text = str(value);
  return text ? text.toUpperCase() : null;
}

/** Upstream number: strings may carry thousands separators. */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/,/g, '');
  if (text === '' || text === 'NOT_FOUND') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function coords(lat, lon) {
  const latitude = num(lat);
  const longitude = num(lon);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { lat: latitude, lon: longitude };
}

function mhzToHz(value) {
  const mhz = num(value);
  return mhz === null ? null : Math.round(mhz * 1e6);
}

/** `YYYY-MM-DD` (or a full ISO stamp) from a directory date, else null. */
function isoDateOrNull(value) {
  const text = str(value);
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizeLon(lon) {
  let value = lon;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

function latLonOf(point) {
  const lat = finiteOrNull(point?.lat);
  const lon = finiteOrNull(point?.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90) return null;
  return { lat, lon: normalizeLon(lon) };
}

// ── bands, frequencies, ages, geometry ───────────────────────────────────

/** Band name for a frequency in Hz (inclusive edges), or null off-band. */
export function bandForHz(hz) {
  const value = finiteOrNull(hz);
  if (value === null || value <= 0) return null;
  const row = HAM_BANDS.find(
    (band) => value >= band.lowHz && value <= band.highHz,
  );
  return row ? row.band : null;
}

/** kHz with one decimal below 30 MHz, MHz with three above. */
export function formatHz(hz, { unit = true } = {}) {
  const value = finiteOrNull(hz);
  if (value === null || value <= 0) return '';
  if (value < 30_000_000)
    return `${(value / 1_000).toFixed(1)}${unit ? ' kHz' : ''}`;
  return `${(value / 1_000_000).toFixed(3)}${unit ? ' MHz' : ''}`;
}

/** "20 s", "3 min", "2 h", "3 d" — empty for an unreadable time. */
export function formatAge(timeIso, nowMs = Date.now()) {
  const time =
    typeof timeIso === 'number' ? timeIso : Date.parse(String(timeIso));
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((nowMs - time) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance between two `{ lat, lon }` points; NaN when unreadable. */
export function distanceKm(a, b) {
  const from = latLonOf(a);
  const to = latLonOf(b);
  if (!from || !to) return NaN;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) *
      Math.cos(toRad(to.lat)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north; NaN when unreadable. */
export function initialBearingDeg(a, b) {
  const from = latLonOf(a);
  const to = latLonOf(b);
  if (!from || !to) return NaN;
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point `distanceKm` along `bearingDeg` from `origin`, or null when unreadable. */
export function destinationPoint(origin, bearingDeg, distance) {
  const from = latLonOf(origin);
  const bearing = finiteOrNull(bearingDeg);
  const km = finiteOrNull(distance);
  if (!from || bearing === null || km === null) return null;
  const angular = km / EARTH_RADIUS_KM;
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);
  const brng = toRad(bearing);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(brng),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: toDeg(lat2), lon: normalizeLon(toDeg(lon2)) };
}

// ── adapter normalisers (HamRig) ─────────────────────────────────────────

function splitTone(value) {
  const tone = num(value);
  if (tone === null || tone <= 0) return { toneHz: null, toneBurstHz: null };
  return tone <= MAX_CTCSS_HZ
    ? { toneHz: tone, toneBurstHz: null }
    : { toneHz: null, toneBurstHz: tone };
}

function httpsUrlOrNull(value) {
  const text = str(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * One HamRig `fm_repeaters` row → a repeater row, or null when it lacks a
 * position, an output frequency or a callsign. Fields are taken by name;
 * nothing else from the raw row is copied (no county, no former upstream ids).
 */
export function normalizeHamrigFmRow(row) {
  if (!row || typeof row !== 'object') return null;
  const position = coords(row.latitude, row.longitude);
  const outputHz = mhzToHz(row.frequency);
  const callsign = upper(row.callsign);
  if (!position || outputHz === null || !callsign) return null;
  const inputHz = mhzToHz(row.input_frequency);
  const primaryTone = splitTone(row.pl_tone);
  const tone =
    primaryTone.toneHz === null && primaryTone.toneBurstHz === null
      ? splitTone(row.tsq_tone)
      : primaryTone;
  const status = str(row.operational_status);
  const precise = num(row.precise);
  return {
    id: `hamrig-fm:${str(row.id) ?? `${callsign}:${outputHz}`}`,
    kind: 'FM',
    callsign,
    outputHz,
    inputHz,
    offsetHz: inputHz === null ? null : inputHz - outputHz,
    band: bandForHz(outputHz),
    toneHz: tone.toneHz,
    toneBurstHz: tone.toneBurstHz,
    module: null,
    city: str(row.city),
    region: str(row.state),
    country: str(row.country),
    lat: position.lat,
    lon: position.lon,
    positionPrecise: precise === null ? null : precise !== 0,
    distanceKm: num(row.distance_km),
    status,
    statusKnown: Boolean(status) && status.toUpperCase() !== 'UNKNOWN',
    echolink: str(row.echolink_node),
    allstar: str(row.allstar_node),
    irlp: str(row.irlp_node),
    wires: str(row.wires_node),
    ...HAMRIG_FM_SOURCE,
    sourceUrl: null,
    recordUpdatedAt:
      isoDateOrNull(row.repeaterbook_updated) ?? isoDateOrNull(row.updated_at),
  };
}

/**
 * One HamRig D-STAR row → one repeater row per module. The sponsor's e-mail
 * and other contact fields are never read.
 */
export function normalizeHamrigDstarRow(row) {
  if (!row || typeof row !== 'object') return [];
  const position = coords(row.latitude, row.longitude);
  const callsign = upper(row.callsign);
  if (!position || !callsign) return [];
  const [countryPart, ...regionParts] = String(row.country_state ?? '').split(
    ',',
  );
  const modules = Array.isArray(row.modules) ? row.modules : [];
  const status = str(row.gateway_status);
  const out = [];
  for (const module of modules) {
    const outputHz = mhzToHz(module?.frequency);
    if (outputHz === null) continue;
    const offsetHz = mhzToHz(module?.freq_offset) ?? 0;
    const letter = upper(module?.module_letter);
    out.push({
      id: `hamrig-dstar:${str(row.id) ?? callsign}:${letter ?? outputHz}`,
      kind: 'D-STAR',
      callsign,
      outputHz,
      inputHz: outputHz + offsetHz,
      offsetHz,
      band: bandForHz(outputHz),
      toneHz: null,
      toneBurstHz: null,
      module: letter,
      city: str(row.city),
      region: str(regionParts.join(',')),
      country: str(countryPart) ?? str(row.region_name),
      lat: position.lat,
      lon: position.lon,
      positionPrecise: null,
      distanceKm: num(row.distance_km),
      status,
      statusKnown: Boolean(status) && status.toUpperCase() !== 'UNKNOWN',
      echolink: null,
      allstar: null,
      irlp: null,
      wires: null,
      ...HAMRIG_DSTAR_SOURCE,
      sourceUrl: httpsUrlOrNull(row.information_url),
      recordUpdatedAt:
        isoDateOrNull(row.dstarinfo_last_update) ??
        isoDateOrNull(row.updated_at),
    });
  }
  return out;
}

/** Both HamRig payloads → rows nearest first (unknown distances last). */
export function normalizeHamrigRepeaters(fmPayload, dstarPayload) {
  const fmRows = Array.isArray(fmPayload?.data)
    ? fmPayload.data
    : Array.isArray(fmPayload)
      ? fmPayload
      : [];
  const dstarRows = Array.isArray(dstarPayload?.data)
    ? dstarPayload.data
    : Array.isArray(dstarPayload)
      ? dstarPayload
      : [];
  const out = [];
  for (const row of fmRows) {
    const repeater = normalizeHamrigFmRow(row);
    if (repeater) out.push(repeater);
  }
  for (const row of dstarRows) out.push(...normalizeHamrigDstarRow(row));
  return sortByDistance(out);
}

// ── browser-side validation and freezing ─────────────────────────────────

export function repeaterColor(kind) {
  return (
    REPEATER_COLORS[
      String(kind ?? '')
        .trim()
        .toUpperCase()
    ] || REPEATER_COLORS.other
  );
}

export function repeaterBand(outputHz) {
  return bandForHz(outputHz);
}

/** Re-validate one broker row; the browser never trusts the wire blindly. */
export function isValidRepeater(row) {
  if (!row || typeof row !== 'object') return false;
  if (!cleanText(row.id, 80)) return false;
  if (!REPEATER_KINDS.includes(row.kind)) return false;
  if (!cleanText(row.callsign, 20)) return false;
  const outputHz = finiteOrNull(row.outputHz);
  if (outputHz === null || outputHz <= 0) return false;
  const lat = finiteOrNull(row.lat);
  const lon = finiteOrNull(row.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

function roundTenth(value) {
  const number = finiteOrNull(value);
  return number === null ? null : Math.round(number * 10) / 10;
}

/** Freeze a validated row into the shape the layer, panel and voice use. */
export function freezeRepeater(row) {
  const outputHz = Math.round(Number(row.outputHz));
  const input = finiteOrNull(row.inputHz);
  const inputHz = input === null ? null : Math.round(input);
  const offset = finiteOrNull(row.offsetHz);
  const confidence = REPEATER_CONFIDENCES.includes(row.confidence)
    ? row.confidence
    : 'unverified';
  const status = textOrNull(row.status, 40);
  return Object.freeze({
    id: cleanText(row.id, 80),
    kind: row.kind,
    callsign: cleanText(row.callsign, 20).toUpperCase(),
    outputHz,
    inputHz,
    offsetHz:
      offset === null
        ? inputHz === null
          ? null
          : inputHz - outputHz
        : Math.round(offset),
    band: repeaterBand(outputHz),
    toneHz: finiteOrNull(row.toneHz),
    toneBurstHz: finiteOrNull(row.toneBurstHz),
    module: textOrNull(row.module, 2),
    city: textOrNull(row.city, 80),
    region: textOrNull(row.region, 80),
    country: textOrNull(row.country, 80),
    lat: Number(row.lat),
    lon: Number(row.lon),
    positionPrecise:
      typeof row.positionPrecise === 'boolean' ? row.positionPrecise : null,
    distanceKm: roundTenth(row.distanceKm),
    status,
    statusKnown:
      typeof row.statusKnown === 'boolean'
        ? row.statusKnown
        : Boolean(status) && status.toUpperCase() !== 'UNKNOWN',
    echolink: textOrNull(row.echolink, 20),
    allstar: textOrNull(row.allstar, 20),
    irlp: textOrNull(row.irlp, 20),
    wires: textOrNull(row.wires, 20),
    source: cleanText(row.source, 40) || 'unknown',
    sourceLabel: cleanText(row.sourceLabel, 120) || 'unknown source',
    sourceUrl: httpsUrlOrNull(row.sourceUrl),
    confidence,
    recordUpdatedAt: isoDateOrNull(row.recordUpdatedAt),
  });
}

/** Accept a broker body: valid rows become frozen repeaters, nearest first. */
export function parseRepeatersResponse(body) {
  const rows = Array.isArray(body?.repeaters)
    ? body.repeaters
    : Array.isArray(body)
      ? body
      : [];
  const seen = new Set();
  const list = [];
  for (const row of rows) {
    if (!isValidRepeater(row)) continue;
    const repeater = freezeRepeater(row);
    if (seen.has(repeater.id)) continue;
    seen.add(repeater.id);
    list.push(repeater);
  }
  return {
    repeaters: Object.freeze(sortByDistance(list)),
    updatedAt:
      typeof body?.generatedAt === 'string'
        ? body.generatedAt
        : typeof body?.updatedAt === 'string'
          ? body.updatedAt
          : null,
    partial: body?.partial === true,
    errors:
      body?.errors && typeof body.errors === 'object' ? { ...body.errors } : {},
    sources: Array.isArray(body?.sources)
      ? body.sources.map((entry) => cleanText(entry, 40)).filter(Boolean)
      : [],
  };
}

/** A sorted copy: nearest first, unknown distances last, then by callsign. */
export function sortByDistance(list) {
  const rows = Array.isArray(list) ? [...list] : [];
  return rows.sort((a, b) => {
    const da = finiteOrNull(a?.distanceKm);
    const db = finiteOrNull(b?.distanceKm);
    if (da === null && db === null)
      return String(a?.callsign ?? '').localeCompare(String(b?.callsign ?? ''));
    if (da === null) return 1;
    if (db === null) return -1;
    return (
      da - db ||
      String(a?.callsign ?? '').localeCompare(String(b?.callsign ?? ''))
    );
  });
}

/** Recompute distances from `origin`; the same array when the origin is unreadable. */
export function withDistanceFrom(list, origin) {
  const rows = Array.isArray(list) ? list : [];
  const lat = finiteOrNull(origin?.lat);
  const lon = finiteOrNull(origin?.lon);
  if (lat === null || lon === null) return rows;
  return rows.map((row) => {
    const km = distanceKm({ lat, lon }, row);
    return Object.freeze({
      ...row,
      distanceKm: Number.isFinite(km) ? Math.round(km * 10) / 10 : null,
    });
  });
}

/** Normalise a filter request against the current filter; unknown values keep the current one. */
export function normalizeRepeaterFilter(
  next = {},
  current = { kind: 'all', band: 'all' },
) {
  const kindInput = String(next?.kind ?? '')
    .trim()
    .toUpperCase();
  let kind;
  if (kindInput === 'ALL') kind = 'all';
  else if (kindInput === 'DSTAR') kind = 'D-STAR';
  else if (REPEATER_KINDS.includes(kindInput)) kind = kindInput;
  else kind = current?.kind || 'all';
  const bandInput = String(next?.band ?? '')
    .trim()
    .toLowerCase();
  let band;
  if (bandInput === 'all') band = 'all';
  else if (REPEATER_BANDS.includes(bandInput)) band = bandInput;
  else band = current?.band || 'all';
  return Object.freeze({ kind, band });
}

export function repeaterMatchesFilter(repeater, filter = {}) {
  if (!repeater) return false;
  const kind = filter.kind || 'all';
  const band = filter.band || 'all';
  if (kind !== 'all' && repeater.kind !== kind) return false;
  if (
    band !== 'all' &&
    (repeater.band || repeaterBand(repeater.outputHz)) !== band
  )
    return false;
  return true;
}

/** Upstream `kind` query value for a filter kind. */
export function kindQueryValue(kind) {
  const value = String(kind ?? '')
    .trim()
    .toUpperCase();
  if (value === 'FM') return 'fm';
  if (value === 'D-STAR' || value === 'DSTAR') return 'dstar';
  return 'all';
}

/** "PI2NON 430.275 MHz", "DB0RTV B 438.513 MHz". */
export function repeaterLabel(repeater) {
  if (!repeater) return '';
  return `${repeater.callsign}${repeater.module ? ` ${repeater.module}` : ''} ${formatHz(repeater.outputHz)}`.trim();
}

/** "FM · Enschede, Netherlands · CTCSS 123 · in 431.875 MHz · EchoLink 6053". */
export function repeaterDetails(repeater) {
  if (!repeater) return '';
  const parts = [repeater.kind];
  const place = [repeater.city, repeater.country].filter(Boolean).join(', ');
  if (place) parts.push(place);
  if (repeater.toneHz !== null && repeater.toneHz !== undefined)
    parts.push(`CTCSS ${repeater.toneHz}`);
  if (repeater.toneBurstHz)
    parts.push(`${Math.round(repeater.toneBurstHz)} Hz tone-burst`);
  if (repeater.inputHz && repeater.inputHz !== repeater.outputHz)
    parts.push(`in ${formatHz(repeater.inputHz)}`);
  if (repeater.echolink) parts.push(`EchoLink ${repeater.echolink}`);
  if (repeater.allstar) parts.push(`AllStar ${repeater.allstar}`);
  if (repeater.irlp) parts.push(`IRLP ${repeater.irlp}`);
  if (repeater.wires) parts.push(`WIRES-X ${repeater.wires}`);
  return parts.join(' · ');
}

/** "HamRig FM table (…) · unverified · record 2025-05-06 · status On-air (as listed)". */
export function repeaterProvenance(repeater) {
  if (!repeater) return '';
  const parts = [repeater.sourceLabel || repeater.source || 'unknown source'];
  parts.push(repeater.confidence || 'unverified');
  if (repeater.recordUpdatedAt)
    parts.push(`record ${repeater.recordUpdatedAt}`);
  if (repeater.status)
    parts.push(
      `status ${repeater.status}${repeater.statusKnown ? ' (as listed)' : ' (not verified)'}`,
    );
  if (repeater.positionPrecise === false) parts.push('approximate position');
  return parts.join(' · ');
}

export function trimList(list, max = LIST_LIMIT) {
  const rows = Array.isArray(list) ? list : [];
  const limit = Math.max(0, Math.floor(finiteOrNull(max) ?? LIST_LIMIT));
  return rows.length > limit ? rows.slice(0, limit) : rows.slice();
}

/** Nearest N matching repeaters to a point (at least one, at most LIST_LIMIT). */
export function nearestRepeaters(
  repeaters,
  lat,
  lon,
  n = 5,
  filter = { kind: 'all', band: 'all' },
) {
  const latitude = finiteOrNull(lat);
  const longitude = finiteOrNull(lon);
  if (latitude === null || longitude === null) return [];
  const count = Math.max(
    1,
    Math.min(LIST_LIMIT, Math.floor(finiteOrNull(n) ?? 5)),
  );
  const rows = (Array.isArray(repeaters) ? repeaters : []).filter((row) =>
    repeaterMatchesFilter(row, filter),
  );
  return sortByDistance(
    withDistanceFrom(rows, { lat: latitude, lon: longitude }),
  ).slice(0, count);
}

/** A row by id, exact callsign (with module), or a loose callsign/city match. */
export function resolveRepeaterQuery(query, repeaters) {
  const text = cleanText(query, 80);
  if (!text) return null;
  const rows = Array.isArray(repeaters) ? repeaters : [];
  const lower = text.toLowerCase();
  const byId = rows.find((row) => String(row.id).toLowerCase() === lower);
  if (byId) return byId;
  const call = text.toUpperCase().replace(/\s+/g, '');
  const exact = rows.filter(
    (row) =>
      row.callsign === call ||
      (row.module &&
        [
          `${row.callsign}${row.module}`,
          `${row.callsign}/${row.module}`,
          `${row.callsign}-${row.module}`,
        ].includes(call)),
  );
  if (exact.length) return sortByDistance(exact)[0];
  const loose = rows.filter(
    (row) =>
      row.callsign.includes(call) ||
      (row.city && row.city.toUpperCase() === text.toUpperCase()),
  );
  return loose.length ? sortByDistance(loose)[0] : null;
}

// ── view geometry and the camera fetch plan ──────────────────────────────

/** Width, height and the larger span of a lat/lon rectangle, in km. */
export function viewSpanKm(bounds) {
  const south = finiteOrNull(bounds?.south);
  const north = finiteOrNull(bounds?.north);
  const west = finiteOrNull(bounds?.west);
  let east = finiteOrNull(bounds?.east);
  if (south === null || north === null || west === null || east === null)
    return null;
  if (east < west) east += 360;
  const midLat = (south + north) / 2;
  const heightKm = distanceKm(
    { lat: south, lon: west },
    { lat: north, lon: west },
  );
  const lonSpan = Math.min(360, east - west);
  const widthKm =
    distanceKm(
      { lat: midLat, lon: 0 },
      { lat: midLat, lon: Math.min(180, lonSpan) },
    ) +
    (lonSpan > 180
      ? distanceKm({ lat: midLat, lon: 0 }, { lat: midLat, lon: lonSpan - 180 })
      : 0);
  return { widthKm, heightKm, spanKm: Math.max(widthKm, heightKm) };
}

export function radiusForSpanKm(spanKm) {
  const span = finiteOrNull(spanKm);
  if (span === null || span <= 0) return DEFAULT_RADIUS_KM;
  return Math.round(Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, span / 2)));
}

export function clampRadiusKm(radiusKm) {
  const value = finiteOrNull(radiusKm);
  if (value === null || value <= 0) return DEFAULT_RADIUS_KM;
  return Math.round(Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, value)));
}

/**
 * Where "around the view" is: the look-at point when the camera looks at the
 * ground nearby, pulled back towards the nadir when it gazes at the horizon.
 */
export function deriveViewCentre({ nadir, hit = null, heightM = null } = {}) {
  const base = latLonOf(nadir);
  if (!base) return null;
  const target = latLonOf(hit);
  if (!target) return { ...base, source: 'nadir' };
  const heightKm = Math.max(0, (finiteOrNull(heightM) ?? 0) / 1000);
  const maxPullKm = Math.max(25, Math.min(1500, heightKm * 1.5));
  const km = distanceKm(base, target);
  if (!Number.isFinite(km) || km <= maxPullKm)
    return { lat: target.lat, lon: target.lon, source: 'look-at' };
  const pulled = destinationPoint(
    base,
    initialBearingDeg(base, target),
    maxPullKm,
  );
  return pulled
    ? { ...pulled, source: 'pulled' }
    : { ...base, source: 'nadir' };
}

/** Decide whether a settled camera should trigger a load, and where. */
export function cameraFetchPlan({
  heightM,
  centre,
  spanKm,
  last = null,
  nowMs = Date.now(),
  force = false,
} = {}) {
  const height = finiteOrNull(heightM);
  const withinGate = height !== null && height < HEIGHT_GATE_M;
  const radiusKm = radiusForSpanKm(spanKm);
  const lat = finiteOrNull(centre?.lat);
  const lon = finiteOrNull(centre?.lon);
  if (lat === null || lon === null)
    return { fetch: false, reason: 'no-centre', withinGate, radiusKm };
  if (!withinGate && !force)
    return { fetch: false, reason: 'above-gate', withinGate, radiusKm };
  if (!last || force)
    return {
      fetch: true,
      reason: force ? 'forced' : 'initial',
      withinGate,
      radiusKm,
      lat,
      lon,
    };
  const lastRadius = finiteOrNull(last.radiusKm) ?? DEFAULT_RADIUS_KM;
  if (last.failed) {
    const age = nowMs - (finiteOrNull(last.at) ?? 0);
    return age >= FAILED_LOAD_RETRY_MS
      ? { fetch: true, reason: 'retry', withinGate, radiusKm, lat, lon }
      : { fetch: false, reason: 'retry-wait', withinGate, radiusKm };
  }
  const moved = distanceKm({ lat, lon }, last);
  if (Number.isFinite(moved) && moved > Math.max(5, lastRadius * 0.25))
    return {
      fetch: true,
      reason: 'moved',
      withinGate,
      radiusKm,
      lat,
      lon,
      movedKm: moved,
    };
  if (Math.abs(radiusKm - lastRadius) / lastRadius > 0.35)
    return { fetch: true, reason: 'zoomed', withinGate, radiusKm, lat, lon };
  return { fetch: false, reason: 'unchanged', withinGate, radiusKm };
}

/** Same-origin broker URL; bands outside the filter set are omitted. */
export function buildRepeatersUrl({
  lat,
  lon,
  radiusKm = DEFAULT_RADIUS_KM,
  limit = DEFAULT_LIMIT,
  band = 'all',
  kind = 'all',
} = {}) {
  const latitude = finiteOrNull(lat);
  const longitude = finiteOrNull(lon);
  if (latitude === null || longitude === null) return null;
  const params = new URLSearchParams();
  params.set('lat', String(Math.round(latitude * 1e4) / 1e4));
  params.set('lon', String(Math.round(longitude * 1e4) / 1e4));
  params.set('radiusKm', String(clampRadiusKm(radiusKm)));
  params.set(
    'limit',
    String(
      Math.max(
        1,
        Math.min(
          DEFAULT_LIMIT,
          Math.round(finiteOrNull(limit) ?? DEFAULT_LIMIT),
        ),
      ),
    ),
  );
  const bandValue = String(band ?? 'all')
    .trim()
    .toLowerCase();
  if (REPEATER_BANDS.includes(bandValue)) params.set('band', bandValue);
  params.set('kind', kindQueryValue(kind));
  return `${REPEATERS_ENDPOINT}?${params.toString()}`;
}

/** "60 km around 48.14, 11.58". */
export function describeArea(area) {
  const lat = finiteOrNull(area?.lat);
  const lon = finiteOrNull(area?.lon);
  if (lat === null || lon === null) return '';
  const radius = finiteOrNull(area?.radiusKm);
  return `${radius === null ? '' : `${Math.round(radius)} km around `}${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}
