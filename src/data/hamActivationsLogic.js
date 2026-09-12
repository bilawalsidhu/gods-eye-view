/**
 * Pure helpers for the Activations layer (POTA / SOTA / WWFF / BOTA).
 *
 * Everything here is Cesium-free and DOM-free so it can be unit-tested with
 * plain `node --test`. `src/data/hamActivations.js` imports these and only
 * adds the Cesium plumbing (entities, picking, camera).
 *
 * Rows arrive from the same-origin broker `/api/hamrig/activations` already
 * normalized (see the HamRig contract, shape `Activation`); the browser still
 * re-validates every row before trusting it.
 */

import { PROGRAM_COLORS, bandForHz, distanceKm, formatAge, formatHz } from './hamRadioShared.js';

/** Program ids in canonical order (also the chip order in the panel). */
export const ACTIVATION_PROGRAMS = Object.freeze(['POTA', 'SOTA', 'WWFF', 'BOTA']);

/** Long names for tooltips and voice read-back. */
export const ACTIVATION_PROGRAM_LABELS = Object.freeze({
  POTA: 'Parks on the Air',
  SOTA: 'Summits on the Air',
  WWFF: 'World Wide Flora & Fauna',
  BOTA: 'Bunkers on the Air',
});

/** Band ids the panel band select offers (plus 'all'). */
export const ACTIVATION_BANDS = Object.freeze([
  '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm',
]);

/** Band filter rows in the `{ id, label }` shape the web-receivers panel uses. */
export const ACTIVATION_BAND_FILTERS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All bands' }),
  ...ACTIVATION_BANDS.map((band) => Object.freeze({ id: band, label: band })),
]);

/** Activations older than this are dropped client-side even if the broker still lists them. */
export const ACTIVATION_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** Marker size/alpha fade fully over this many minutes. */
export const ACTIVATION_FADE_MINUTES = 60;

/** Default panel filter: every program, every band. */
export const DEFAULT_ACTIVATION_FILTER = Object.freeze({
  programs: Object.freeze(new Set(ACTIVATION_PROGRAMS)),
  band: 'all',
});

const KM_PER_DEG = 111.19;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const CALLSIGN_RE = /^[A-Z0-9/-]{3,15}$/i;
const DESIGNATOR_RE = /\/(P|M|MM|AM|QRP|A|LH|J|R|B|E|T|\d)$/i;

function cleanText(value, maxLength = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseTimeMs(timeIso) {
  if (typeof timeIso === 'number') return Number.isFinite(timeIso) ? timeIso : null;
  let text = String(timeIso ?? '').trim();
  // Date-time strings without a zone designator are UTC on the wire (POTA-style).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function validCoordinates(lat, lon) {
  return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

/** Upper-cased program id when `value` names one of the four programs, else null. */
export function normalizeProgram(value) {
  const text = cleanText(value, 10).toUpperCase();
  return ACTIVATION_PROGRAMS.includes(text) ? text : null;
}

/** Marker colour for a program (unknown → neutral grey). */
export function programColor(program) {
  return PROGRAM_COLORS[normalizeProgram(program)] || '#9aa4b2';
}

/** Re-validate one broker row; the browser never trusts the wire blindly. */
export function isValidActivation(row) {
  if (!row || typeof row !== 'object') return false;
  if (!cleanText(row.id, 120)) return false;
  if (!normalizeProgram(row.program)) return false;
  if (!CALLSIGN_RE.test(cleanText(row.callsign, 20))) return false;
  if (!cleanText(row.reference, 40)) return false;
  const freqHz = finiteNumber(row.freqHz);
  if (freqHz === null || freqHz <= 0) return false;
  return validCoordinates(finiteNumber(row.lat), finiteNumber(row.lon));
}

/** Freeze a validated row into the shape the layer, panel and voice tools use. */
export function freezeActivation(row) {
  const freqHz = Number(row.freqHz);
  const timeMs = parseTimeMs(row.timeIso);
  const url = cleanText(row.url, 300);
  return Object.freeze({
    id: cleanText(row.id, 120),
    program: normalizeProgram(row.program),
    callsign: cleanText(row.callsign, 20).toUpperCase(),
    reference: cleanText(row.reference, 40).toUpperCase(),
    name: cleanText(row.name, 160),
    freqHz,
    band: cleanText(row.band, 8) || bandForHz(freqHz),
    mode: cleanText(row.mode, 10).toUpperCase() || null,
    timeIso: timeMs === null ? null : new Date(timeMs).toISOString(),
    spotter: cleanText(row.spotter, 20),
    comments: cleanText(row.comments, 300),
    lat: Number(row.lat),
    lon: Number(row.lon),
    precision: row.precision === 'grid' ? 'grid' : 'exact',
    locator: cleanText(row.locator, 10).toUpperCase() || null,
    country: cleanText(row.country, 60) || null,
    altitudeM: finiteNumber(row.altitudeM),
    points: finiteNumber(row.points),
    url: /^https?:\/\//i.test(url) ? url : null,
  });
}

/** True when the activation was spotted within `maxAgeMs` of `nowMs` (undated rows count as fresh). */
export function isFreshActivation(activation, nowMs, maxAgeMs = ACTIVATION_MAX_AGE_MS) {
  const timeMs = parseTimeMs(activation?.timeIso);
  if (timeMs === null) return true;
  return nowMs - timeMs <= maxAgeMs;
}

/** Newest spot first; undated rows sink to the end; ties break on id for determinism. */
export function sortActivationsNewestFirst(list) {
  return [...list].sort((a, b) => {
    const ta = parseTimeMs(a.timeIso) ?? -Infinity;
    const tb = parseTimeMs(b.timeIso) ?? -Infinity;
    if (ta !== tb) return tb - ta;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Keep the newest spot per activator + reference (the feeds repeat an
 * activation every time a new spotter reports it). Input order is not
 * assumed; output is newest first.
 */
export function dedupeActivations(list) {
  const byKey = new Map();
  for (const activation of sortActivationsNewestFirst(list)) {
    const key = `${activation.program}|${activation.callsign}|${activation.reference}`;
    if (!byKey.has(key)) byKey.set(key, activation);
  }
  return [...byKey.values()];
}

/**
 * Normalize a partial filter update against the current one.
 * `programs` accepts a Set, an array, a comma-separated string or 'all';
 * `program` (singular) selects exactly one program. Unknown program names
 * are ignored; when nothing recognisable was given the current set stays.
 * An explicit empty array/Set is honoured (hide every program).
 */
export function normalizeActivationFilter(next = {}, current = DEFAULT_ACTIVATION_FILTER) {
  const base = current && current.programs instanceof Set ? current : DEFAULT_ACTIVATION_FILTER;
  let programs = new Set(base.programs);
  const source = next && typeof next === 'object' ? next : {};
  const raw = source.programs !== undefined ? source.programs : (source.program !== undefined ? source.program : undefined);
  if (raw !== undefined && raw !== null) {
    let names = [];
    let explicitEmpty = false;
    if (raw instanceof Set || Array.isArray(raw)) {
      names = [...raw];
      explicitEmpty = names.length === 0;
    } else {
      names = String(raw).split(/[,\s]+/);
    }
    const lowered = names.map((name) => cleanText(name, 10).toLowerCase()).filter(Boolean);
    if (lowered.includes('all')) {
      programs = new Set(ACTIVATION_PROGRAMS);
    } else {
      const parsed = lowered.map((name) => normalizeProgram(name)).filter(Boolean);
      if (parsed.length || explicitEmpty) programs = new Set(ACTIVATION_PROGRAMS.filter((program) => parsed.includes(program)));
    }
  }
  let band = base.band;
  if (source.band !== undefined && source.band !== null) {
    const text = cleanText(source.band, 8).toLowerCase();
    if (text === 'all' || text === '') band = 'all';
    else if (ACTIVATION_BANDS.includes(text)) band = text;
  }
  return { programs, band };
}

/** True when the activation passes the program + band filter. */
export function activationMatchesFilter(activation, filter = DEFAULT_ACTIVATION_FILTER) {
  if (!activation) return false;
  const programs = filter?.programs instanceof Set ? filter.programs : DEFAULT_ACTIVATION_FILTER.programs;
  if (!programs.has(activation.program)) return false;
  const band = filter?.band || 'all';
  return band === 'all' || activation.band === band;
}

/** Filtered copy of the list (order preserved). */
export function filterActivations(list, filter = DEFAULT_ACTIVATION_FILTER) {
  return list.filter((activation) => activationMatchesFilter(activation, filter));
}

/**
 * Marker size and alpha as the spot ages: full size/opacity when fresh,
 * shrinking and fading linearly until `fadeMinutes`, then constant.
 * Undated rows render at the faded end.
 */
export function activationAgeStyle(timeIso, nowMs, {
  fadeMinutes = ACTIVATION_FADE_MINUTES,
  maxSize = 11,
  minSize = 7,
  maxAlpha = 1,
  minAlpha = 0.45,
} = {}) {
  const timeMs = parseTimeMs(timeIso);
  if (timeMs === null) return { pixelSize: minSize, alpha: minAlpha, ageMin: null };
  const ageMin = Math.max(0, (nowMs - timeMs) / 60_000);
  const fraction = fadeMinutes > 0 ? Math.min(1, ageMin / fadeMinutes) : 1;
  return {
    pixelSize: Math.round((maxSize - (maxSize - minSize) * fraction) * 10) / 10,
    alpha: Math.round((maxAlpha - (maxAlpha - minAlpha) * fraction) * 1000) / 1000,
    ageMin: Math.round(ageMin * 10) / 10,
  };
}

/**
 * Deterministic spiral offset (km east/north) for the n-th marker of a pile.
 * Index 0 sits on the true position; later ones walk a sunflower spiral so
 * every marker stays pickable. Radius is capped at `maxKm`.
 */
export function spiralOffsetKm(index, { stepKm = 0.35, maxKm = 3 } = {}) {
  const n = Math.max(0, Math.floor(Number(index) || 0));
  if (n === 0) return { eastKm: 0, northKm: 0 };
  const radius = Math.min(maxKm, stepKm * Math.sqrt(n));
  const angle = n * GOLDEN_ANGLE;
  return { eastKm: radius * Math.cos(angle), northKm: radius * Math.sin(angle) };
}

/**
 * Display positions for items sharing a position (rounded to `keyDecimals`).
 * Items in a pile are ordered by id so the offset assigned to an id never
 * changes between refreshes. Returns Map<id, { lat, lon, offset }>.
 */
export function spreadCoincidentPositions(items, { keyDecimals = 3, stepKm = 0.35, maxKm = 3 } = {}) {
  const piles = new Map();
  for (const item of items) {
    const lat = finiteNumber(item?.lat);
    const lon = finiteNumber(item?.lon);
    if (!validCoordinates(lat, lon)) continue;
    const key = `${lat.toFixed(keyDecimals)}|${lon.toFixed(keyDecimals)}`;
    if (!piles.has(key)) piles.set(key, []);
    piles.get(key).push(item);
  }
  const positions = new Map();
  for (const pile of piles.values()) {
    pile.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    pile.forEach((item, index) => {
      const lat = Number(item.lat);
      const lon = Number(item.lon);
      if (index === 0 || pile.length === 1) {
        positions.set(item.id, { lat, lon, offset: false });
        return;
      }
      const { eastKm, northKm } = spiralOffsetKm(index, { stepKm, maxKm });
      const cosLat = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
      const offsetLat = Math.max(-90, Math.min(90, lat + northKm / KM_PER_DEG));
      let offsetLon = lon + eastKm / (KM_PER_DEG * cosLat);
      if (offsetLon > 180) offsetLon -= 360;
      if (offsetLon < -180) offsetLon += 360;
      positions.set(item.id, { lat: offsetLat, lon: offsetLon, offset: true });
    });
  }
  return positions;
}

/** First label line: `<call> <ref>`. */
export function activationLabel(activation) {
  if (!activation) return '';
  return `${activation.callsign} ${activation.reference}`.trim();
}

/** Second label line: `POTA · Pike National Forest · 14047.5 kHz CW · 3 min`. */
export function activationDetail(activation, nowMs = Date.now()) {
  if (!activation) return '';
  const parts = [activation.program];
  if (activation.name) parts.push(activation.name);
  const freq = [formatHz(activation.freqHz), activation.mode].filter(Boolean).join(' ');
  if (freq) parts.push(freq);
  const age = activation.timeIso ? formatAge(activation.timeIso, nowMs) : '';
  if (age) parts.push(age);
  return parts.join(' · ');
}

function baseCallsign(callsign) {
  let text = String(callsign || '').toUpperCase();
  let previous;
  do {
    previous = text;
    text = text.replace(DESIGNATOR_RE, '');
  } while (text !== previous);
  return text;
}

/**
 * Find one activation by id, callsign (with or without /P style suffixes),
 * reference, or a word search over callsign/reference/name/program.
 * Case-insensitive; the newest match wins. Never mutates state.
 */
export function resolveActivation(list, query) {
  const text = cleanText(query, 120);
  if (!text) return null;
  const lower = text.toLowerCase();
  const upper = text.toUpperCase();
  const ordered = sortActivationsNewestFirst(list);
  const byId = ordered.find((activation) => String(activation.id).toLowerCase() === lower);
  if (byId) return byId;
  const byCall = ordered.find((activation) => activation.callsign === upper);
  if (byCall) return byCall;
  const base = baseCallsign(upper);
  if (base) {
    const byBase = ordered.find((activation) => baseCallsign(activation.callsign) === base);
    if (byBase) return byBase;
  }
  const byRef = ordered.find((activation) => activation.reference === upper);
  if (byRef) return byRef;
  const words = lower.split(/\s+/).filter((word) => /[a-z0-9]/.test(word));
  if (!words.length) return null;
  return ordered.find((activation) => {
    const haystack = `${activation.callsign} ${activation.reference} ${activation.name} ${activation.program} ${activation.country || ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  }) || null;
}

/** The `n` activations closest to a point, with their distance in km (ascending). */
export function nearestActivations(list, lat, lon, n = 5) {
  const origin = { lat: finiteNumber(lat), lon: finiteNumber(lon) };
  if (origin.lat === null || origin.lon === null || Math.abs(origin.lat) > 90 || Math.abs(origin.lon) > 180) return [];
  const requested = Number(n);
  const limit = Math.max(1, Math.floor(Number.isFinite(requested) ? requested : 5));
  return list
    .map((activation) => ({ activation, distanceKm: distanceKm(origin, activation) }))
    .filter((entry) => Number.isFinite(entry.distanceKm))
    .sort((a, b) => a.distanceKm - b.distanceKm || String(a.activation.id).localeCompare(String(b.activation.id)))
    .slice(0, limit)
    .map((entry) => ({ activation: entry.activation, distanceKm: Math.round(entry.distanceKm * 10) / 10 }));
}

/** Newest-first list capped for the UI snapshot (voice tools and the panel never need more). */
export function trimActivationItems(list, limit = 200) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  return sortActivationsNewestFirst(list).slice(0, max);
}

/** Counts per program and band for the panel chips. */
export function summarizeActivations(list) {
  const byProgram = Object.fromEntries(ACTIVATION_PROGRAMS.map((program) => [program, 0]));
  const byBand = {};
  for (const activation of list) {
    if (activation.program in byProgram) byProgram[activation.program] += 1;
    const band = activation.band || 'other';
    byBand[band] = (byBand[band] || 0) + 1;
  }
  return { total: list.length, byProgram, byBand };
}

/** Camera bounding-sphere radius (m) after padding, never tighter than `minM`. */
export function frameRadiusM(radiusM, { padding = 1.6, minM = 60_000 } = {}) {
  const radius = finiteNumber(radiusM) ?? 0;
  return Math.max(radius * padding, minM);
}
