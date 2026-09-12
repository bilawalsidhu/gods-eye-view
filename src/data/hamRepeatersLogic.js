/**
 * Repeaters layer — pure helpers (browser-safe, Cesium-free, no DOM).
 *
 * Everything the `ham-repeaters` layer needs to decide WHEN to fetch (camera
 * height gate, debounce plan, radius from the visible span), WHAT to fetch
 * (the same-origin `/api/hamrig/repeaters` URL) and HOW to show a row (kind
 * colours, labels, filter, nearest-N, list trimming). The layer module
 * (`hamRepeaters.js`) owns the Cesium entities and the camera listener and
 * imports from here; the unit tests import only this file.
 *
 * Rows are the `Repeater` shape produced by the HamRig proxy
 * (`src/hamrig/normalize.js` → `normalizeRepeaters`):
 * `{ id, kind:'FM'|'D-STAR', callsign, outputHz, inputHz, ctcss, city, region,
 *    country, lat, lon, distanceKm, status, echolink, allstar, module }`.
 */

import { bandForHz, destinationPoint, distanceKm, formatHz, initialBearingDeg } from './hamRadioShared.js';

export const REPEATER_KINDS = Object.freeze(['FM', 'D-STAR']);

/** Marker colour per repeater kind (contract §2.2 row 6). */
export const REPEATER_COLORS = Object.freeze({
  FM: '#f59e0b',
  'D-STAR': '#a855f7',
  other: '#9aa4b2',
});

/** Bands the HamRig repeater DB understands (upstream `band=` filter). */
export const REPEATER_BANDS = Object.freeze(['6m', '2m', '1.25m', '70cm']);

export const REPEATER_KIND_FILTERS = Object.freeze([
  { id: 'all', label: 'All repeaters' },
  { id: 'FM', label: 'FM' },
  { id: 'D-STAR', label: 'D-STAR' },
].map((row) => Object.freeze(row)));

export const REPEATER_BAND_FILTERS = Object.freeze([
  { id: 'all', label: 'All bands' },
  { id: '6m', label: '6 m' },
  { id: '2m', label: '2 m' },
  { id: '1.25m', label: '1.25 m' },
  { id: '70cm', label: '70 cm' },
].map((row) => Object.freeze(row)));

/** Camera height (m) above which the layer stops loading around the view. */
export const HEIGHT_GATE_M = 1_500_000;
/** Search radius bounds (km); the upstream cap is 500 km, we stay well below. */
export const MAX_RADIUS_KM = 300;
export const MIN_RADIUS_KM = 15;
export const DEFAULT_RADIUS_KM = 100;
/** Camera `moveEnd` debounce before a view-driven load. */
export const MOVE_END_DEBOUNCE_MS = 1500;
/** Upstream row cap per request and the UI list cap. */
export const DEFAULT_LIMIT = 200;
export const LIST_LIMIT = 200;
/** A failed view-driven load is retried no sooner than this. */
export const FAILED_LOAD_RETRY_MS = 30_000;

export const REPEATERS_ENDPOINT = '/api/hamrig/repeaters';

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function cleanText(value, maxLength = 120) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function textOrNull(value, maxLength = 120) {
  const text = cleanText(value, maxLength);
  return text ? text : null;
}

/** Marker colour for a repeater kind (unknown → neutral grey). */
export function repeaterColor(kind) {
  return REPEATER_COLORS[String(kind ?? '').trim().toUpperCase()] || REPEATER_COLORS.other;
}

/** Amateur band of the output frequency ('70cm', '2m', …) or null. */
export function repeaterBand(outputHz) {
  return bandForHz(outputHz);
}

/** Re-validate one proxy row; the browser never trusts the wire blindly. */
export function isValidRepeater(row) {
  if (!row || typeof row !== 'object') return false;
  if (!cleanText(row.id, 80)) return false;
  if (!REPEATER_KINDS.includes(row.kind)) return false;
  if (!cleanText(row.callsign, 20)) return false;
  const outputHz = finiteOrNull(row.outputHz);
  if (outputHz === null || outputHz <= 0) return false;
  const lat = finiteOrNull(row.lat);
  const lon = finiteOrNull(row.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

/** Freeze a validated row into the shape the layer, panel and voice tools use. */
export function freezeRepeater(row) {
  const outputHz = Math.round(Number(row.outputHz));
  const inputHz = finiteOrNull(row.inputHz);
  const distance = finiteOrNull(row.distanceKm);
  return Object.freeze({
    id: cleanText(row.id, 80),
    kind: row.kind,
    callsign: cleanText(row.callsign, 20).toUpperCase(),
    outputHz,
    inputHz: inputHz === null ? null : Math.round(inputHz),
    band: repeaterBand(outputHz),
    ctcss: finiteOrNull(row.ctcss),
    city: textOrNull(row.city, 80),
    region: textOrNull(row.region, 80),
    country: textOrNull(row.country, 80),
    lat: Number(row.lat),
    lon: Number(row.lon),
    distanceKm: distance === null ? null : Math.round(distance * 10) / 10,
    status: textOrNull(row.status, 40),
    echolink: textOrNull(row.echolink, 20),
    allstar: textOrNull(row.allstar, 20),
    module: textOrNull(row.module, 2),
  });
}

/** `{ repeaters, updatedAt }` from a proxy payload — invalid rows dropped, nearest first. */
export function parseRepeatersResponse(body) {
  const rows = Array.isArray(body?.repeaters) ? body.repeaters : (Array.isArray(body) ? body : []);
  const seen = new Set();
  const repeaters = [];
  for (const row of rows) {
    if (!isValidRepeater(row)) continue;
    const frozen = freezeRepeater(row);
    if (seen.has(frozen.id)) continue;
    seen.add(frozen.id);
    repeaters.push(frozen);
  }
  return {
    repeaters: Object.freeze(sortByDistance(repeaters)),
    updatedAt: typeof body?.generatedAt === 'string' ? body.generatedAt : (typeof body?.updatedAt === 'string' ? body.updatedAt : null),
  };
}

/** Nearest first; rows without a distance go last, ties by callsign. */
export function sortByDistance(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => {
    const da = finiteOrNull(a?.distanceKm);
    const db = finiteOrNull(b?.distanceKm);
    if (da === null && db === null) return String(a?.callsign ?? '').localeCompare(String(b?.callsign ?? ''));
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db || String(a?.callsign ?? '').localeCompare(String(b?.callsign ?? ''));
  });
}

/** Copy of the rows with `distanceKm` recomputed from `origin` `{ lat, lon }`. */
export function withDistanceFrom(list, origin) {
  const rows = Array.isArray(list) ? list : [];
  if (finiteOrNull(origin?.lat) === null || finiteOrNull(origin?.lon) === null) return rows;
  return rows.map((row) => {
    const km = distanceKm(origin, row);
    return Object.freeze({ ...row, distanceKm: Number.isFinite(km) ? Math.round(km * 10) / 10 : null });
  });
}

/** Panel filter, validated against the known kinds and bands (bad values keep the current one). */
export function normalizeRepeaterFilter(next = {}, current = { kind: 'all', band: 'all' }) {
  const kindInput = String(next?.kind ?? '').trim().toUpperCase();
  const kind = kindInput === 'ALL' ? 'all'
    : (kindInput === 'DSTAR' ? 'D-STAR' : (REPEATER_KINDS.includes(kindInput) ? kindInput : (current?.kind || 'all')));
  const bandInput = String(next?.band ?? '').trim().toLowerCase();
  const band = bandInput === 'all' ? 'all' : (REPEATER_BANDS.includes(bandInput) ? bandInput : (current?.band || 'all'));
  return Object.freeze({ kind, band });
}

/** Whether a repeater passes the `{ kind, band }` filter. */
export function repeaterMatchesFilter(repeater, filter = {}) {
  if (!repeater) return false;
  const kind = filter.kind || 'all';
  const band = filter.band || 'all';
  if (kind !== 'all' && repeater.kind !== kind) return false;
  if (band !== 'all' && (repeater.band || repeaterBand(repeater.outputHz)) !== band) return false;
  return true;
}

/** Upstream `kind=` value for a filter kind. */
export function kindQueryValue(kind) {
  const text = String(kind ?? 'all').trim().toUpperCase();
  if (text === 'FM') return 'fm';
  if (text === 'D-STAR' || text === 'DSTAR') return 'dstar';
  return 'all';
}

/** Hover / selection label: callsign (+ D-STAR module) and the output frequency. */
export function repeaterLabel(repeater) {
  if (!repeater) return '';
  const module = repeater.module ? ` ${repeater.module}` : '';
  return `${repeater.callsign}${module} ${formatHz(repeater.outputHz)}`.trim();
}

/** Second label line: kind, place, tone, input and linking. */
export function repeaterDetails(repeater) {
  if (!repeater) return '';
  const parts = [repeater.kind];
  const place = [repeater.city, repeater.country].filter(Boolean).join(', ');
  if (place) parts.push(place);
  if (repeater.ctcss !== null && repeater.ctcss !== undefined) parts.push(`CTCSS ${repeater.ctcss}`);
  if (repeater.inputHz && repeater.inputHz !== repeater.outputHz) parts.push(`in ${formatHz(repeater.inputHz)}`);
  if (repeater.echolink) parts.push(`EchoLink ${repeater.echolink}`);
  if (repeater.allstar) parts.push(`AllStar ${repeater.allstar}`);
  return parts.join(' · ');
}

/** Cap a list for the UI snapshot (never mutates). */
export function trimList(list, max = LIST_LIMIT) {
  const rows = Array.isArray(list) ? list : [];
  const limit = Math.max(0, Math.floor(finiteOrNull(max) ?? LIST_LIMIT));
  return rows.length > limit ? rows.slice(0, limit) : rows.slice();
}

/** The `n` nearest repeaters to a point (filter applied), distance recomputed. */
export function nearestRepeaters(repeaters, lat, lon, n = 5, filter = { kind: 'all', band: 'all' }) {
  const origin = { lat: finiteOrNull(lat), lon: finiteOrNull(lon) };
  if (origin.lat === null || origin.lon === null) return [];
  const count = Math.max(1, Math.min(LIST_LIMIT, Math.floor(finiteOrNull(n) ?? 5)));
  const rows = (Array.isArray(repeaters) ? repeaters : []).filter((row) => repeaterMatchesFilter(row, filter));
  return sortByDistance(withDistanceFrom(rows, origin)).slice(0, count);
}

/** Resolve an id (`fm:1886`, `dstar:561:B`) or a callsign (case-insensitive; nearest wins). */
export function resolveRepeaterQuery(query, repeaters) {
  const text = cleanText(query, 80);
  if (!text) return null;
  const rows = Array.isArray(repeaters) ? repeaters : [];
  const lower = text.toLowerCase();
  const byId = rows.find((row) => String(row.id).toLowerCase() === lower);
  if (byId) return byId;
  const upper = text.toUpperCase();
  const call = upper.replace(/\s+/g, '');
  const matches = rows.filter((row) => row.callsign === call
    || (row.module && `${row.callsign}${row.module}` === call)
    || (row.module && `${row.callsign}/${row.module}` === call)
    || (row.module && `${row.callsign}-${row.module}` === call));
  if (matches.length) return sortByDistance(matches)[0];
  const loose = rows.filter((row) => row.callsign.includes(call) || (row.city && row.city.toUpperCase() === upper));
  return loose.length ? sortByDistance(loose)[0] : null;
}

/** Width/height/span (km) of a view rectangle in degrees; handles the dateline. */
export function viewSpanKm(bounds) {
  const south = finiteOrNull(bounds?.south);
  const north = finiteOrNull(bounds?.north);
  const west = finiteOrNull(bounds?.west);
  let east = finiteOrNull(bounds?.east);
  if (south === null || north === null || west === null || east === null) return null;
  if (east < west) east += 360;
  const midLat = (south + north) / 2;
  const heightKm = distanceKm({ lat: south, lon: west }, { lat: north, lon: west });
  const lonSpan = Math.min(360, east - west);
  const widthKm = distanceKm({ lat: midLat, lon: 0 }, { lat: midLat, lon: Math.min(180, lonSpan) })
    + (lonSpan > 180 ? distanceKm({ lat: midLat, lon: 0 }, { lat: midLat, lon: lonSpan - 180 }) : 0);
  return { widthKm, heightKm, spanKm: Math.max(widthKm, heightKm) };
}

/** Search radius for a visible span: min(300, span/2), clamped, default 100 on bad input. */
export function radiusForSpanKm(spanKm) {
  const span = finiteOrNull(spanKm);
  if (span === null || span <= 0) return DEFAULT_RADIUS_KM;
  return Math.round(Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, span / 2)));
}

/** Clamp a user-supplied radius (km) to the allowed window (bad → default). */
export function clampRadiusKm(radiusKm) {
  const value = finiteOrNull(radiusKm);
  if (value === null || value <= 0) return DEFAULT_RADIUS_KM;
  return Math.round(Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, value)));
}

/**
 * Where the user is looking: the ellipsoid hit under the canvas centre when
 * it is within a height-scaled pull distance of the camera nadir, otherwise
 * (horizon gaze) a point pulled back towards the nadir. No hit → nadir.
 */
export function deriveViewCentre({ nadir, hit = null, heightM = null } = {}) {
  const base = { lat: finiteOrNull(nadir?.lat), lon: finiteOrNull(nadir?.lon) };
  if (base.lat === null || base.lon === null) return null;
  const target = { lat: finiteOrNull(hit?.lat), lon: finiteOrNull(hit?.lon) };
  if (target.lat === null || target.lon === null) return { lat: base.lat, lon: base.lon, source: 'nadir' };
  const heightKm = Math.max(0, (finiteOrNull(heightM) ?? 0) / 1000);
  const maxPullKm = Math.max(25, Math.min(1500, heightKm * 1.5));
  const km = distanceKm(base, target);
  if (!Number.isFinite(km) || km <= maxPullKm) return { lat: target.lat, lon: target.lon, source: 'look-at' };
  const pulled = destinationPoint(base, initialBearingDeg(base, target), maxPullKm);
  return pulled ? { lat: pulled.lat, lon: pulled.lon, source: 'pulled' } : { lat: base.lat, lon: base.lon, source: 'nadir' };
}

/**
 * Decide whether a camera settle should trigger a load.
 * `last` is the previous load area `{ lat, lon, radiusKm, at, failed }`.
 */
export function cameraFetchPlan({ heightM, centre, spanKm, last = null, nowMs = Date.now(), force = false } = {}) {
  const height = finiteOrNull(heightM);
  const withinGate = height !== null && height < HEIGHT_GATE_M;
  const radiusKm = radiusForSpanKm(spanKm);
  const lat = finiteOrNull(centre?.lat);
  const lon = finiteOrNull(centre?.lon);
  if (lat === null || lon === null) return { fetch: false, reason: 'no-centre', withinGate, radiusKm };
  if (!withinGate && !force) return { fetch: false, reason: 'above-gate', withinGate, radiusKm };
  if (!last || force) return { fetch: true, reason: force ? 'forced' : 'initial', withinGate, radiusKm, lat, lon };
  const lastRadius = finiteOrNull(last.radiusKm) ?? DEFAULT_RADIUS_KM;
  if (last.failed) {
    const age = nowMs - (finiteOrNull(last.at) ?? 0);
    if (age >= FAILED_LOAD_RETRY_MS) return { fetch: true, reason: 'retry', withinGate, radiusKm, lat, lon };
    return { fetch: false, reason: 'retry-wait', withinGate, radiusKm };
  }
  const moved = distanceKm({ lat, lon }, last);
  if (Number.isFinite(moved) && moved > Math.max(5, lastRadius * 0.25)) {
    return { fetch: true, reason: 'moved', withinGate, radiusKm, lat, lon, movedKm: moved };
  }
  if (Math.abs(radiusKm - lastRadius) / lastRadius > 0.35) {
    return { fetch: true, reason: 'zoomed', withinGate, radiusKm, lat, lon };
  }
  return { fetch: false, reason: 'unchanged', withinGate, radiusKm };
}

/** Same-origin proxy URL for a search (numbers rounded, filter mapped to upstream names). */
export function buildRepeatersUrl({ lat, lon, radiusKm = DEFAULT_RADIUS_KM, limit = DEFAULT_LIMIT, band = 'all', kind = 'all' } = {}) {
  const latitude = finiteOrNull(lat);
  const longitude = finiteOrNull(lon);
  if (latitude === null || longitude === null) return null;
  const params = new URLSearchParams();
  params.set('lat', String(Math.round(latitude * 1e4) / 1e4));
  params.set('lon', String(Math.round(longitude * 1e4) / 1e4));
  params.set('radiusKm', String(clampRadiusKm(radiusKm)));
  params.set('limit', String(Math.max(1, Math.min(DEFAULT_LIMIT, Math.round(finiteOrNull(limit) ?? DEFAULT_LIMIT)))));
  const bandValue = String(band ?? 'all').trim().toLowerCase();
  if (REPEATER_BANDS.includes(bandValue)) params.set('band', bandValue);
  params.set('kind', kindQueryValue(kind));
  return `${REPEATERS_ENDPOINT}?${params.toString()}`;
}

/** '100 km around 48.14, 11.58' for status lines and voice results. */
export function describeArea(area) {
  const lat = finiteOrNull(area?.lat);
  const lon = finiteOrNull(area?.lon);
  const radius = finiteOrNull(area?.radiusKm);
  if (lat === null || lon === null) return '';
  return `${radius === null ? '' : `${Math.round(radius)} km around `}${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}
