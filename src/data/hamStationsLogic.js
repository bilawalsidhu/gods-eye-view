/**
 * Pure helpers for the Ham Stations layer (`hamStations.js`): callsign
 * validation, station row sanitising, the last-50 lookup history, marker
 * styling by position precision, fly-to altitudes, "my station" overlay
 * switches, worked-DXCC / worked-grid styling and the rotator beam wedge.
 *
 * Browser-safe and Cesium-free so the unit tests can run under node:test.
 */

import { destinationPoint, distanceKm } from './hamRadioShared.js';

export const STATION_COLOR = '#38bdf8';
export const DXCC_WORKED_COLOR = '#22c55e';
export const DXCC_NEEDED_COLOR = '#ef4444';
export const GRID_COLOR = '#facc15';
export const ROTATOR_COLOR = '#f472b6';
export const HISTORY_LIMIT = 50;
export const ROTATOR_HALF_WIDTH_DEG = 12;
export const ROTATOR_RANGE_KM = 4000;
export const ROTATOR_POLL_MS = 10_000;
export const PRECISIONS = Object.freeze(['exact', 'grid', 'area', 'entity']);
export const DEFAULT_MY_STATION_OVERLAYS = Object.freeze({ dxcc: true, grids: true, rotator: true });
export const MY_STATION_KEYS = Object.freeze(Object.keys(DEFAULT_MY_STATION_OVERLAYS));

const CALLSIGN_RE = /^[A-Z0-9/-]{3,15}$/;

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value, maxLength = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function textOrNull(value, maxLength = 200) {
  const text = cleanText(value, maxLength);
  return text ? text : null;
}

function validCoords(lat, lon) {
  const la = finiteOrNull(lat);
  const lo = finiteOrNull(lon);
  if (la === null || lo === null || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { lat: la, lon: lo };
}

// ---------------------------------------------------------------------------
// Callsigns + station rows
// ---------------------------------------------------------------------------

/** Upper-cased callsign that the proxy route accepts (`/^[A-Z0-9\/-]{3,15}$/`), else null. */
export function normalizeCallsign(input) {
  const text = cleanText(input, 40).toUpperCase().replace(/\s+/g, '');
  return CALLSIGN_RE.test(text) ? text : null;
}

/** Path for the station lookup route. */
export function stationLookupPath(callsign) {
  const call = normalizeCallsign(callsign);
  return call ? `/api/hamrig/station/${encodeURIComponent(call)}` : null;
}

/**
 * Re-validate one Station row from the proxy; returns a frozen copy with a
 * normalised precision, or null when it has no usable position.
 */
export function sanitizeStation(row, { nowMs = Date.now() } = {}) {
  if (!row || typeof row !== 'object') return null;
  const callsign = normalizeCallsign(row.callsign);
  if (!callsign) return null;
  const position = validCoords(row.lat, row.lon);
  if (!position) return null;
  const precision = PRECISIONS.includes(row.precision) ? row.precision : 'entity';
  const dxcc = row.dxcc && typeof row.dxcc === 'object' ? row.dxcc : {};
  const hamrigUser = row.hamrigUser && typeof row.hamrigUser === 'object'
    ? Object.freeze({
      username: textOrNull(row.hamrigUser.username, 40),
      verified: Boolean(row.hamrigUser.verified),
      avatarUrl: httpUrlOrNull(row.hamrigUser.avatarUrl),
    })
    : null;
  return Object.freeze({
    id: callsign,
    callsign,
    name: textOrNull(row.name, 120),
    country: textOrNull(row.country, 80),
    dxcc: Object.freeze({
      adif: finiteOrNull(dxcc.adif),
      name: textOrNull(dxcc.name, 80),
      prefix: textOrNull(dxcc.prefix, 12),
      continent: textOrNull(dxcc.continent, 4),
      cqZone: finiteOrNull(dxcc.cqZone),
      ituZone: finiteOrNull(dxcc.ituZone),
    }),
    lat: position.lat,
    lon: position.lon,
    precision,
    grid: textOrNull(row.grid, 10),
    city: textOrNull(row.city, 80),
    state: textOrNull(row.state, 80),
    imageUrl: httpUrlOrNull(row.imageUrl),
    licenseClass: textOrNull(row.licenseClass, 20),
    qslManager: textOrNull(row.qslManager, 80),
    lotw: row.lotw === true ? true : row.lotw === false ? false : null,
    eqsl: row.eqsl === true ? true : row.eqsl === false ? false : null,
    hamrigUser,
    sources: Object.freeze(Array.isArray(row.sources) ? row.sources.map((entry) => cleanText(entry, 40)).filter(Boolean) : []),
    lookedUpAt: new Date(finiteOrNull(nowMs) ?? Date.now()).toISOString(),
  });
}

function httpUrlOrNull(value) {
  const text = cleanText(value, 500);
  return /^https?:\/\//i.test(text) ? text : null;
}

/** Human label for a position precision. */
export function precisionLabel(precision) {
  switch (precision) {
    case 'exact': return 'exact position';
    case 'grid': return 'grid square';
    case 'area': return 'call area (approximate)';
    case 'entity': return 'entity centroid (approximate)';
    default: return 'unknown precision';
  }
}

/** One-line description for the panel/voice: `DH5DAX · Michael · Germany · JO32me (exact position)`. */
export function stationSummaryLine(station) {
  if (!station) return '';
  const parts = [station.callsign];
  if (station.name) parts.push(station.name);
  const place = [station.city, station.state].filter(Boolean).join(', ');
  if (place) parts.push(place);
  if (station.country) parts.push(station.country);
  const grid = station.grid ? `${station.grid} ` : '';
  parts.push(`${grid}(${precisionLabel(station.precision)})`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Newest-first history with one row per callsign, trimmed to `limit`. */
export function pushHistory(history, station, limit = HISTORY_LIMIT) {
  const rows = Array.isArray(history) ? history : [];
  if (!station?.callsign) return trimHistory(rows, limit);
  const rest = rows.filter((row) => row?.callsign !== station.callsign);
  return trimHistory([station, ...rest], limit);
}

/** Drop rows beyond `limit` (newest first). */
export function trimHistory(history, limit = HISTORY_LIMIT) {
  const rows = Array.isArray(history) ? history.filter((row) => row && row.callsign) : [];
  const max = Math.max(0, Math.round(finiteOrNull(limit) ?? HISTORY_LIMIT));
  return Object.freeze(rows.slice(0, max));
}

/** Find a station by id/callsign (case-insensitive) or by a name/country substring. */
export function findStation(history, query) {
  const rows = Array.isArray(history) ? history : [];
  const text = cleanText(query, 80);
  if (!text) return null;
  const call = text.toUpperCase().replace(/\s+/g, '');
  const exact = rows.find((row) => row.callsign === call || row.id === call);
  if (exact) return exact;
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.find((row) => {
    const haystack = `${row.callsign} ${row.name ?? ''} ${row.country ?? ''} ${row.city ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  }) || null;
}

// ---------------------------------------------------------------------------
// Marker styling + camera
// ---------------------------------------------------------------------------

/** Marker style for a lookup result: hollow ring unless the position is exact. */
export function stationMarkerStyle(station, { selected = false } = {}) {
  const hollow = station?.precision !== 'exact';
  return {
    hollow,
    css: STATION_COLOR,
    alpha: hollow ? 0 : 0.95,
    outlineCss: selected ? '#ffffff' : STATION_COLOR,
    outlineWidth: hollow ? (selected ? 3 : 2) : (selected ? 2 : 1),
    pixelSize: selected ? 18 : (hollow ? 14 : 11),
  };
}

/** Fly-to altitude (m) that matches how precisely the station is placed. */
export function stationFlyAltitudeM(precision) {
  switch (precision) {
    case 'exact': return 300_000;
    case 'grid': return 600_000;
    case 'area': return 2_500_000;
    case 'entity': return 3_000_000;
    default: return 1_500_000;
  }
}

/**
 * Radius (m) for a bounding sphere that frames several stations: half the
 * largest pairwise distance with padding, never below 60 km.
 */
export function frameRadiusM(points, { padding = 1.6, minimumM = 60_000 } = {}) {
  const rows = (Array.isArray(points) ? points : []).map((p) => validCoords(p?.lat, p?.lon)).filter(Boolean);
  if (!rows.length) return null;
  let largestKm = 0;
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      largestKm = Math.max(largestKm, distanceKm(rows[i], rows[j]));
    }
  }
  return Math.max(minimumM, (largestKm * 1000 * padding) / 2);
}

// ---------------------------------------------------------------------------
// My station
// ---------------------------------------------------------------------------

/** Merge a partial overlay switch update; unknown keys and non-booleans are ignored. */
export function normalizeMyStationOverlays(current = DEFAULT_MY_STATION_OVERLAYS, partial = {}) {
  const next = { ...DEFAULT_MY_STATION_OVERLAYS, ...(current && typeof current === 'object' ? current : {}) };
  if (partial && typeof partial === 'object') {
    for (const key of MY_STATION_KEYS) {
      if (typeof partial[key] === 'boolean') next[key] = partial[key];
    }
  }
  const out = {};
  for (const key of MY_STATION_KEYS) out[key] = Boolean(next[key]);
  return Object.freeze(out);
}

/** Pull an array out of a proxy payload: the first matching key, or the body itself when it is an array. */
export function extractRows(body, keys) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

/** Worked-DXCC rows with a position; `id` is the ADIF number or the name. */
export function sanitizeDxccEntities(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const position = validCoords(row?.lat, row?.lon);
    const name = textOrNull(row?.name, 80);
    if (!position || !name) continue;
    const adif = finiteOrNull(row.adif);
    out.push(Object.freeze({
      id: adif !== null ? String(adif) : name,
      adif,
      name,
      prefix: textOrNull(row.prefix, 12),
      continent: textOrNull(row.continent, 4),
      cq: finiteOrNull(row.cq),
      lat: position.lat,
      lon: position.lon,
      worked: row.worked === true,
      bands: Object.freeze(Array.isArray(row.bands) ? row.bands.map((band) => cleanText(band, 8)).filter(Boolean) : []),
    }));
  }
  return out;
}

/** Marker style for a DXCC entity: green when worked, red when still needed. */
export function dxccMarkerStyle(entity) {
  return entity?.worked
    ? { css: DXCC_WORKED_COLOR, alpha: 0.85, pixelSize: 6 }
    : { css: DXCC_NEEDED_COLOR, alpha: 0.75, pixelSize: 5 };
}

/** Worked-DXCC tally. */
export function dxccCounts(entities) {
  const rows = Array.isArray(entities) ? entities : [];
  const worked = rows.filter((row) => row.worked).length;
  return { worked, needed: rows.length - worked, total: rows.length };
}

/** Worked-grid rows with a position. */
export function sanitizeWorkedGrids(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const grid = cleanText(row?.grid, 10).toUpperCase();
    const position = validCoords(row?.lat, row?.lon);
    if (!grid || !position) continue;
    out.push(Object.freeze({ id: grid, grid, qsos: Math.max(0, Math.round(finiteOrNull(row.qsos) ?? 0)), lat: position.lat, lon: position.lon }));
  }
  return out;
}

/** Pixel size for a worked grid: 4 px for one QSO, growing with log₂(qsos), capped at 16 px. */
export function gridMarkerSize(qsos) {
  const count = Math.max(0, finiteOrNull(qsos) ?? 0);
  return Number(Math.min(16, 4 + Math.log2(count + 1) * 1.5).toFixed(2));
}

/** Rotators that can be drawn: a position and a finite azimuth. */
export function sanitizeRotators(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.id === null || row?.id === undefined) continue;
    const position = validCoords(row.lat, row.lon);
    const azimuth = finiteOrNull(row.azimuth);
    if (!position || azimuth === null) continue;
    out.push(Object.freeze({
      id: String(row.id),
      name: textOrNull(row.name, 60) ?? `Rotator ${row.id}`,
      model: textOrNull(row.model, 60),
      lat: position.lat,
      lon: position.lon,
      grid: textOrNull(row.grid, 10),
      azimuth: ((azimuth % 360) + 360) % 360,
      elevation: finiteOrNull(row.elevation),
      targetAzimuth: finiteOrNull(row.targetAzimuth),
      isMoving: row.isMoving === true,
      status: textOrNull(row.status, 20),
      online: row.online === true ? true : row.online === false ? false : null,
      lastSeenIso: typeof row.lastSeenIso === 'string' ? row.lastSeenIso : null,
      bands: Object.freeze(Array.isArray(row.bands) ? row.bands.map((band) => cleanText(band, 8)).filter(Boolean) : []),
    }));
  }
  return out;
}

/**
 * Beam wedge polygon for a rotator: the origin, then the arc from
 * `azimuth − halfWidth` to `azimuth + halfWidth` at `rangeKm`. The ring is not
 * closed (the consumer's polygon does that). Null when the input is unusable.
 */
export function rotatorWedge(origin, azimuthDeg, { halfWidthDeg = ROTATOR_HALF_WIDTH_DEG, rangeKm = ROTATOR_RANGE_KM, steps = 24 } = {}) {
  const position = validCoords(origin?.lat, origin?.lon);
  const azimuth = finiteOrNull(azimuthDeg);
  const half = finiteOrNull(halfWidthDeg);
  const range = finiteOrNull(rangeKm);
  if (!position || azimuth === null || half === null || half <= 0 || range === null || range <= 0) return null;
  const count = Math.max(2, Math.min(180, Math.round(finiteOrNull(steps) ?? 24)));
  const ring = [{ lat: position.lat, lon: position.lon }];
  for (let index = 0; index <= count; index += 1) {
    const bearing = azimuth - half + ((2 * half) * index) / count;
    const point = destinationPoint(position, bearing, range);
    if (point) ring.push(point);
  }
  return ring.length >= 3 ? ring : null;
}

/** Label for a rotator marker: `Tower rotor · 096° → 300° · moving`. */
export function rotatorLabel(rotator) {
  if (!rotator) return '';
  const heading = `${String(Math.round(rotator.azimuth)).padStart(3, '0')}°`;
  const parts = [rotator.name, heading];
  const target = finiteOrNull(rotator.targetAzimuth);
  if (target !== null && Math.abs(target - rotator.azimuth) >= 1) parts[1] = `${heading} → ${String(Math.round(target)).padStart(3, '0')}°`;
  if (rotator.isMoving) parts.push('moving');
  else if (rotator.online === false) parts.push('offline');
  return parts.join(' · ');
}
