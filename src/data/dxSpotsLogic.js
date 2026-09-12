/**
 * DX Spots layer — pure, Cesium-free logic (browser-safe, unit-tested).
 *
 * Everything the `dx-spots` layer needs to decide, but not draw: validating
 * wire rows from `/api/hamrig/spots`, the panel filter, age-based marker
 * styling, deterministic spiral offsets for piles of spots that share one
 * entity-centroid position, which spots get a DX↔spotter arc and how it is
 * drawn, labels, merging precise locations from `POST /api/hamrig/locate`,
 * camera framing, list trimming and the reception re-poll plan.
 *
 * All time-dependent helpers take `nowMs` so tests inject a clock.
 */

import { HAM_BANDS, bandColor, bandForHz, distanceKm, formatHz, greatCirclePoints } from './hamRadioShared.js';

export const DX_SPOTS_ENDPOINT = '/api/hamrig/spots';
export const DX_LOCATE_ENDPOINT = '/api/hamrig/locate';
export const DX_RECEPTION_ENDPOINT = '/api/hamrig/reception';

export const DEFAULT_FILTER = Object.freeze({ band: 'all', mode: 'all', minutes: 60, arcs: true, continent: 'all' });
export const MINUTES_OPTIONS = Object.freeze([5, 15, 30, 60]);
export const MODE_OPTIONS = Object.freeze(['all', 'CW', 'SSB', 'FT8', 'FT4', 'RTTY', 'DIGI']);
export const CONTINENT_OPTIONS = Object.freeze(['all', 'EU', 'NA', 'SA', 'AS', 'AF', 'OC', 'AN']);
/** Bands offered by the panel: the HF/VHF/UHF set that has a colour, in frequency order. */
export const BAND_OPTIONS = Object.freeze(['all', ...HAM_BANDS.map((row) => row.band).filter((band) => !['2200m', '630m', '1.25m', '33cm', '23cm'].includes(band))]);
export const PRECISIONS = Object.freeze(['exact', 'grid', 'area', 'entity']);
export const SPOT_SOURCES = Object.freeze(['ws', 'rest']);

export const ARC_LIMIT = 25;
export const ITEM_LIMIT = 200;
export const PILE_MAX_OFFSET_KM = 60;
export const PILE_PRECISE_OFFSET_KM = 8;
export const MAX_AGE_MIN = 60;

const DIGITAL_MODES = new Set(['FT8', 'FT4', 'RTTY', 'PSK', 'JS8', 'WSPR', 'MSK144', 'DIGI', 'Q65', 'JT65', 'JT9', 'SSTV']);
const PRECISION_RANK = Object.freeze({ exact: 3, grid: 2, area: 1, entity: 0 });

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(number) ? number : null;
}

/** Strip control characters and collapse whitespace; the browser never trusts the wire blindly. */
export function cleanText(value, maxLength = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function upperCall(value, maxLength = 20) {
  return cleanText(value, maxLength).toUpperCase();
}

/** Validate one `Loc` (contract §1.3); anything unreadable becomes null. */
export function freezeLoc(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const lat = finiteOrNull(loc.lat);
  const lon = finiteOrNull(loc.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const precision = PRECISIONS.includes(loc.precision) ? loc.precision : 'entity';
  return Object.freeze({
    lat,
    lon,
    precision,
    entity: cleanText(loc.entity, 80) || null,
    continent: upperCall(loc.continent, 2) || null,
    adif: finiteOrNull(loc.adif),
    cq: finiteOrNull(loc.cq),
  });
}

/** True when a wire row can become a spot marker (id, DX call, frequency, time). */
export function isValidSpot(row) {
  if (!row || typeof row !== 'object') return false;
  if (!cleanText(row.id, 120)) return false;
  if (!upperCall(row.dx)) return false;
  const hz = finiteOrNull(row.freqHz);
  if (hz === null || hz <= 0) return false;
  return Number.isFinite(Date.parse(String(row.timeIso ?? '')));
}

/** Freeze a validated row into the `Spot` shape (contract §1.3) the layer, panel and voice tools use. */
export function freezeSpot(row) {
  const freqHz = Number(row.freqHz);
  const spotter = cleanText(row.spotter, 20);
  const spotterCall = upperCall(row.spotterCall) || spotter.replace(/-#$|-\d+$/, '').toUpperCase();
  return Object.freeze({
    id: cleanText(row.id, 120),
    dx: upperCall(row.dx),
    spotter,
    spotterCall,
    freqHz,
    band: cleanText(row.band, 8).toLowerCase() || bandForHz(freqHz) || null,
    mode: upperCall(row.mode, 10) || null,
    comment: cleanText(row.comment, 160),
    timeIso: new Date(Date.parse(String(row.timeIso))).toISOString(),
    dxLoc: freezeLoc(row.dxLoc),
    spotterLoc: freezeLoc(row.spotterLoc),
    source: SPOT_SOURCES.includes(row.source) ? row.source : 'rest',
  });
}

/** Wire payload → frozen, validated, newest-first spots (deduplicated by id). */
export function spotsFromPayload(body) {
  const rows = Array.isArray(body?.spots) ? body.spots : [];
  const seen = new Set();
  const spots = [];
  for (const row of rows) {
    if (!isValidSpot(row)) continue;
    const spot = freezeSpot(row);
    if (seen.has(spot.id)) continue;
    seen.add(spot.id);
    spots.push(spot);
  }
  return sortNewestFirst(spots);
}

/** Newest first (stable for equal times). */
export function sortNewestFirst(spots) {
  return [...spots].sort((a, b) => Date.parse(b.timeIso) - Date.parse(a.timeIso));
}

/** Age in minutes (never negative). */
export function spotAgeMinutes(spot, nowMs = Date.now()) {
  const time = Date.parse(String(spot?.timeIso ?? ''));
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - time) / 60_000);
}

/** Validate a partial filter against the current one; unknown values keep the current setting. */
export function normalizeFilter(next = {}, current = DEFAULT_FILTER) {
  const base = { ...DEFAULT_FILTER, ...current };
  const out = { ...base };
  if (next.band !== undefined) {
    const band = String(next.band ?? '').trim().toLowerCase();
    if (BAND_OPTIONS.includes(band)) out.band = band;
  }
  if (next.mode !== undefined) {
    const mode = String(next.mode ?? '').trim();
    const match = MODE_OPTIONS.find((option) => option.toLowerCase() === mode.toLowerCase());
    if (match) out.mode = match;
  }
  if (next.minutes !== undefined) {
    const minutes = finiteOrNull(next.minutes);
    if (minutes !== null) out.minutes = MINUTES_OPTIONS.reduce((best, option) => (Math.abs(option - minutes) < Math.abs(best - minutes) ? option : best), MINUTES_OPTIONS[0]);
  }
  if (next.arcs !== undefined) out.arcs = Boolean(next.arcs);
  if (next.continent !== undefined) {
    const continent = String(next.continent ?? '').trim();
    const match = CONTINENT_OPTIONS.find((option) => option.toLowerCase() === continent.toLowerCase());
    if (match) out.continent = match;
  }
  return Object.freeze(out);
}

/** True when the spot's mode satisfies the filter mode ('DIGI' means any digital mode). */
export function modeMatches(spotMode, filterMode) {
  if (!filterMode || filterMode === 'all') return true;
  const mode = String(spotMode ?? '').toUpperCase();
  if (filterMode === 'DIGI') return DIGITAL_MODES.has(mode);
  return mode === filterMode.toUpperCase();
}

/** Does one spot pass the panel filter? Continent filters on the SPOTTER ("what is Europe hearing"). */
export function spotMatchesFilter(spot, filter = DEFAULT_FILTER, nowMs = Date.now()) {
  if (!spot) return false;
  if (filter.band && filter.band !== 'all' && spot.band !== filter.band) return false;
  if (!modeMatches(spot.mode, filter.mode)) return false;
  if (filter.minutes && spotAgeMinutes(spot, nowMs) > filter.minutes) return false;
  if (filter.continent && filter.continent !== 'all' && (spot.spotterLoc?.continent || null) !== filter.continent) return false;
  return true;
}

/** Filter + newest-first. */
export function filterSpots(spots, filter = DEFAULT_FILTER, nowMs = Date.now()) {
  return sortNewestFirst((spots || []).filter((spot) => spotMatchesFilter(spot, filter, nowMs)));
}

/** Drop spots older than `maxAgeMin` (housekeeping between fetches). */
export function pruneOld(spots, nowMs = Date.now(), maxAgeMin = MAX_AGE_MIN) {
  return (spots || []).filter((spot) => spotAgeMinutes(spot, nowMs) <= maxAgeMin);
}

/** Keep the first `limit` rows for the UI snapshot. */
export function trimList(spots, limit = ITEM_LIMIT) {
  return (spots || []).slice(0, Math.max(0, limit));
}

/** Marker size 9 → 5 px and alpha 1 → 0.35 as the age goes 0 → 60 min (clamped). */
export function ageStyle(ageMin) {
  const t = Math.max(0, Math.min(1, (finiteOrNull(ageMin) ?? MAX_AGE_MIN) / MAX_AGE_MIN));
  return { pixelSize: Math.round((9 - 4 * t) * 10) / 10, alpha: Math.round((1 - 0.65 * t) * 1000) / 1000 };
}

/** entity/area positions are guesses and draw as hollow rings. */
export function isApproximatePrecision(precision) {
  return precision === 'entity' || precision === 'area';
}

/** Marker recipe for one spot: colour by band, size/alpha by age, hollow for approximate positions. */
export function markerStyle(spot, nowMs = Date.now()) {
  const { pixelSize, alpha } = ageStyle(spotAgeMinutes(spot, nowMs));
  return {
    color: bandColor(spot?.band),
    pixelSize,
    alpha,
    hollow: isApproximatePrecision(spot?.dxLoc?.precision),
  };
}

/** FNV-1a 32-bit hash of a string (deterministic across sessions). */
export function hashString(text) {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Offset for slot `slot` of `count` on a sunflower (golden angle) spiral,
 * radius ≤ `maxKm`. Distinct slots always map to distinct positions.
 */
export function slotOffset(slot, count, maxKm = PILE_MAX_OFFSET_KM) {
  const total = Math.max(1, Math.round(count));
  const index = Math.max(0, Math.floor(Number(slot) || 0)) % total;
  const distance = maxKm * Math.sqrt((index + 1) / total);
  const bearingDeg = (index * 137.50776405) % 360;
  return { slot: index, bearingDeg, distanceKm: Math.round(distance * 1000) / 1000 };
}

/**
 * Deterministic spiral offset for a spot id: a hashed slot on the spiral.
 * Same id → same offset on every render. Kept for callers that need an
 * id-only offset; `pileOffsets` assigns slots by rank within the pile so
 * hash collisions can never stack two spots on one point.
 */
export function spiralOffset(id, { maxKm = PILE_MAX_OFFSET_KM, slots = 48 } = {}) {
  const count = Math.max(1, Math.round(slots));
  return slotOffset(hashString(id) % count, count, maxKm);
}

function positionKey(loc) {
  return `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
}

function offsetLatLon(loc, bearingDeg, distanceKm) {
  const R = 6371;
  const rad = Math.PI / 180;
  const δ = distanceKm / R;
  const θ = bearingDeg * rad;
  const φ1 = loc.lat * rad;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.max(-1, Math.min(1, sinφ2)));
  const λ2 = loc.lon * rad + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * sinφ2);
  let lon = λ2 / rad;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return { lat: φ2 / rad, lon };
}

/**
 * Render positions for every located spot. Spots sharing one DX position
 * (rounded to 0.01°) are spread on a deterministic spiral so each stays
 * pickable: ≤ 60 km for entity/area centroids, ≤ 8 km for exact/grid piles.
 * Returns Map<spotId, { lat, lon, offsetKm, piled }>.
 */
export function pileOffsets(spots, { maxKm = PILE_MAX_OFFSET_KM, preciseKm = PILE_PRECISE_OFFSET_KM } = {}) {
  const groups = new Map();
  for (const spot of spots || []) {
    if (!spot?.dxLoc) continue;
    const key = positionKey(spot.dxLoc);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(spot);
  }
  const out = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) {
      const [spot] = group;
      out.set(spot.id, { lat: spot.dxLoc.lat, lon: spot.dxLoc.lon, offsetKm: 0, piled: false });
      continue;
    }
    // Slots by rank within the pile (sorted by id) rather than by hash: a
    // hashed slot collides for ~30% of spots in a 40-spot pile and stacks them
    // on one point. Rank keeps an id's offset stable across refreshes while
    // pile membership is unchanged, and guarantees distinct positions.
    const ordered = [...group].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    ordered.forEach((spot, index) => {
      const limit = isApproximatePrecision(spot.dxLoc.precision) ? maxKm : preciseKm;
      const { bearingDeg, distanceKm: offsetKm } = slotOffset(index, ordered.length, limit);
      const moved = offsetLatLon(spot.dxLoc, bearingDeg, offsetKm);
      out.set(spot.id, { lat: moved.lat, lon: moved.lon, offsetKm, piled: true });
    });
  }
  return out;
}

/** Map label: `14025.0 DL1ABC` (kHz below 30 MHz, MHz above). */
export function spotLabel(spot) {
  const frequency = formatHz(spot?.freqHz, { unit: false });
  return `${frequency} ${spot?.dx ?? ''}`.trim();
}

/** Longer label for the selected spot: frequency, DX, mode/band, spotter, age is added by the caller. */
export function spotDetailLabel(spot, nowMs = Date.now()) {
  const parts = [spot.mode, spot.band ? spot.band : null].filter(Boolean).join(' ');
  const age = Math.round(spotAgeMinutes(spot, nowMs));
  const ageText = Number.isFinite(age) ? `${age} min` : '';
  return `${spotLabel(spot)}\n${[parts, `de ${spot.spotterCall || spot.spotter}`, ageText].filter(Boolean).join(' · ')}`;
}

/** Can an arc be drawn (both ends located and not the same point)? */
export function spotHasArc(spot) {
  if (!spot?.dxLoc || !spot?.spotterLoc) return false;
  return distanceKm(spot.dxLoc, spot.spotterLoc) > 1;
}

/**
 * Which spots get a DX↔spotter arc: the selected spot plus the newest
 * `limit` visible spots that have both ends located. Empty when arcs are off.
 */
export function arcSpots(visibleSpots, selectedId = null, { limit = ARC_LIMIT, arcs = true } = {}) {
  if (!arcs) return [];
  const out = [];
  const seen = new Set();
  const push = (spot) => {
    if (!spot || seen.has(spot.id) || !spotHasArc(spot)) return;
    seen.add(spot.id);
    out.push(spot);
  };
  if (selectedId) push((visibleSpots || []).find((spot) => spot.id === selectedId));
  const extra = out.length;
  for (const spot of sortNewestFirst(visibleSpots || [])) {
    if (out.length >= limit + extra) break;
    push(spot);
  }
  return out;
}

/** Arc recipe: dashed when either end is an entity/area guess, solid when both ends are exact/grid. */
export function arcStyle(spot) {
  const dashed = isApproximatePrecision(spot?.dxLoc?.precision) || isApproximatePrecision(spot?.spotterLoc?.precision);
  return { dashed, color: bandColor(spot?.band), width: dashed ? 1.5 : 2 };
}

/** Great-circle segments (dateline-split) for the arc; [] when an end is missing. */
export function arcSegments(spot, segments = 48) {
  if (!spotHasArc(spot)) return [];
  return greatCirclePoints(spot.dxLoc, spot.spotterLoc, segments);
}

/** Numeric rank of a precision (higher is better); unknown → −1. */
export function precisionRank(precision) {
  return PRECISION_RANK[precision] ?? -1;
}

/** The better of two locations (higher precision wins; ties keep the current one). */
export function betterLoc(current, candidate) {
  const next = freezeLoc(candidate);
  if (!next) return current || null;
  if (!current) return next;
  return precisionRank(next.precision) > precisionRank(current.precision) ? next : current;
}

/**
 * Merge `located` (`{ CALL: Loc|null }` from POST /api/hamrig/locate) into the
 * spots. Returns `{ spots, changedIds }`; untouched spots keep their identity.
 */
export function mergeLocations(spots, located) {
  const table = new Map();
  for (const [call, loc] of Object.entries(located && typeof located === 'object' ? located : {})) {
    const frozen = freezeLoc(loc);
    if (frozen) table.set(String(call).toUpperCase(), frozen);
  }
  const changedIds = [];
  if (!table.size) return { spots: spots || [], changedIds };
  const out = (spots || []).map((spot) => {
    const dxLoc = table.has(spot.dx) ? betterLoc(spot.dxLoc, table.get(spot.dx)) : spot.dxLoc;
    const spotterLoc = table.has(spot.spotterCall) ? betterLoc(spot.spotterLoc, table.get(spot.spotterCall)) : spot.spotterLoc;
    if (dxLoc === spot.dxLoc && spotterLoc === spot.spotterLoc) return spot;
    changedIds.push(spot.id);
    return Object.freeze({ ...spot, dxLoc, spotterLoc });
  });
  return { spots: out, changedIds };
}

/** Calls to send to the locator for one spot (DX + cleaned spotter, deduplicated). */
export function callsToLocate(spot) {
  return [...new Set([spot?.dx, spot?.spotterCall].map((call) => upperCall(call)).filter(Boolean))];
}

/** Body for POST /api/hamrig/locate. */
export function locateRequestBody(spot) {
  return { calls: callsToLocate(spot), precise: true };
}

/**
 * Resolve a query to a spot: by id (case-insensitive), then by exact DX
 * callsign, then a DX/spotter prefix, then a substring — newest first.
 */
export function resolveSpotQuery(spots, query) {
  const text = cleanText(query, 120);
  if (!text) return null;
  const lower = text.toLowerCase();
  const upper = text.toUpperCase();
  const rows = sortNewestFirst(spots || []);
  return rows.find((spot) => spot.id.toLowerCase() === lower)
    || rows.find((spot) => spot.dx === upper)
    || rows.find((spot) => spot.dx.startsWith(upper) || spot.spotterCall === upper)
    || rows.find((spot) => spot.dx.includes(upper) || spot.comment.toUpperCase().includes(upper))
    || null;
}

/** Bounding box of `{ lat, lon }` points, or null when empty. */
export function boundsOf(points) {
  const rows = (points || []).filter((point) => finiteOrNull(point?.lat) !== null && finiteOrNull(point?.lon) !== null);
  if (!rows.length) return null;
  const bounds = { south: 90, west: 180, north: -90, east: -180 };
  for (const point of rows) {
    bounds.south = Math.min(bounds.south, point.lat);
    bounds.north = Math.max(bounds.north, point.lat);
    bounds.west = Math.min(bounds.west, point.lon);
    bounds.east = Math.max(bounds.east, point.lon);
  }
  return bounds;
}

/** Centroid of the points (simple mean; good enough for framing). */
export function centroidOf(points) {
  const rows = (points || []).filter((point) => finiteOrNull(point?.lat) !== null && finiteOrNull(point?.lon) !== null);
  if (!rows.length) return null;
  const lat = rows.reduce((sum, point) => sum + point.lat, 0) / rows.length;
  const lon = rows.reduce((sum, point) => sum + point.lon, 0) / rows.length;
  return { lat, lon };
}

/**
 * Camera framing for a set of points: the centre and a padded radius (km,
 * ≥ `minKm`) that encloses every point — the layer feeds this to
 * `flyToBoundingSphere`. Null when there is nothing to frame.
 */
export function frameRadiusKm(points, { padding = 1.4, minKm = 300, maxKm = 9000 } = {}) {
  const center = centroidOf(points);
  if (!center) return null;
  let radius = 0;
  for (const point of points) {
    if (finiteOrNull(point?.lat) === null || finiteOrNull(point?.lon) === null) continue;
    radius = Math.max(radius, distanceKm(center, point));
  }
  return { center, radiusKm: Math.min(maxKm, Math.max(minKm, radius * padding)) };
}

/** True when PSKReporter has only just registered interest and reports will follow. */
export function receptionWarmingUp(reception) {
  const psk = reception?.psk;
  if (!psk) return false;
  return Boolean(psk.warmingUp) && !(Array.isArray(psk.reports) && psk.reports.length);
}

/** Single fetch by default; when the user explicitly waits, re-poll up to 3× over 30 s. */
export function receptionPollPlan(waitForReception = false) {
  return waitForReception ? { attempts: 3, intervalMs: 10_000 } : { attempts: 1, intervalMs: 0 };
}

/** Query string for the reception endpoint. */
export function receptionQuery(call, minutes = 30) {
  const params = new URLSearchParams({ call: upperCall(call), minutes: String(Math.max(1, Math.min(60, Math.round(minutes)))) });
  return `${DX_RECEPTION_ENDPOINT}?${params.toString()}`;
}

/** Query string for the spots endpoint (always the full hour; the panel filter narrows locally). */
export function spotsQuery({ minutes = MAX_AGE_MIN, limit = 500 } = {}) {
  const params = new URLSearchParams({ minutes: String(Math.max(1, Math.min(60, Math.round(minutes)))), limit: String(Math.max(1, Math.min(1000, Math.round(limit)))) });
  return `${DX_SPOTS_ENDPOINT}?${params.toString()}`;
}

/** Compact summary of a spot for voice/tune results. */
export function summarizeSpot(spot, nowMs = Date.now()) {
  if (!spot) return null;
  return {
    id: spot.id,
    dx: spot.dx,
    spotter: spot.spotterCall || spot.spotter,
    freqHz: spot.freqHz,
    frequencyLabel: formatHz(spot.freqHz),
    band: spot.band,
    mode: spot.mode,
    comment: spot.comment,
    timeIso: spot.timeIso,
    ageMin: Math.round(spotAgeMinutes(spot, nowMs)),
    dxPrecision: spot.dxLoc?.precision ?? null,
    dxEntity: spot.dxLoc?.entity ?? null,
    spotterPrecision: spot.spotterLoc?.precision ?? null,
    spotterEntity: spot.spotterLoc?.entity ?? null,
    spotterContinent: spot.spotterLoc?.continent ?? null,
  };
}
