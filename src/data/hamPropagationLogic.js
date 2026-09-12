/**
 * Pure helpers for the Propagation layer (`hamPropagation.js`): overlay state,
 * the VOACAP frequency table and request builder, colour ramps for the aurora
 * and VOACAP overlays, VOACAP grid-cell geometry, the night-hemisphere polygon
 * decomposition for the grayline and small ionosonde styling rules.
 *
 * Browser-safe and Cesium-free so the unit tests can run under node:test.
 */

import { destinationPoint, subsolarPoint } from './hamRadioShared.js';
import { gridToLatLon, isValidGrid, latLonToGrid } from './maidenhead.js';

/** Default overlay switches (`voacap` is opt-in: it costs an upstream run). */
export const DEFAULT_OVERLAYS = Object.freeze({ grayline: true, aurora: true, ionosondes: true, voacap: false });
export const OVERLAY_KEYS = Object.freeze(Object.keys(DEFAULT_OVERLAYS));

/** VOACAP test frequencies (MHz) with the band each one represents. */
export const VOACAP_FREQUENCIES = Object.freeze([
  Object.freeze({ mhz: 1.85, band: '160m', label: '160 m · 1.85 MHz' }),
  Object.freeze({ mhz: 3.6, band: '80m', label: '80 m · 3.6 MHz' }),
  Object.freeze({ mhz: 5.35, band: '60m', label: '60 m · 5.35 MHz' }),
  Object.freeze({ mhz: 7.1, band: '40m', label: '40 m · 7.1 MHz' }),
  Object.freeze({ mhz: 10.1, band: '30m', label: '30 m · 10.1 MHz' }),
  Object.freeze({ mhz: 14.1, band: '20m', label: '20 m · 14.1 MHz' }),
  Object.freeze({ mhz: 18.1, band: '17m', label: '17 m · 18.1 MHz' }),
  Object.freeze({ mhz: 21.1, band: '15m', label: '15 m · 21.1 MHz' }),
  Object.freeze({ mhz: 24.9, band: '12m', label: '12 m · 24.9 MHz' }),
  Object.freeze({ mhz: 28.2, band: '10m', label: '10 m · 28.2 MHz' }),
]);

/** Grid resolutions the proxy accepts (degrees). */
export const VOACAP_RESOLUTIONS = Object.freeze([5, 10, 15, 20]);
export const VOACAP_DEFAULT_RESOLUTION = 10;
export const VOACAP_MIN_RELIABILITY = 20;
export const AURORA_MIN_PROBABILITY = 10;
export const IONOSONDE_STALE_MIN = 60;

const DEG = Math.PI / 180;
const KM_PER_DEG = 111.19492664455873;

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function normalizeLon(lon) {
  let value = lon;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

// ---------------------------------------------------------------------------
// Overlay state
// ---------------------------------------------------------------------------

/** Merge a partial overlay switch update; unknown keys and non-booleans are ignored. */
export function normalizeOverlays(current = DEFAULT_OVERLAYS, partial = {}) {
  const next = { ...DEFAULT_OVERLAYS, ...(current && typeof current === 'object' ? current : {}) };
  if (partial && typeof partial === 'object') {
    for (const key of OVERLAY_KEYS) {
      if (typeof partial[key] === 'boolean') next[key] = partial[key];
    }
  }
  const out = {};
  for (const key of OVERLAY_KEYS) out[key] = Boolean(next[key]);
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// VOACAP request/state
// ---------------------------------------------------------------------------

/**
 * Pick a VOACAP frequency from a band name ('20m'), a number (MHz, nearest
 * table row) or a numeric string. Returns null when nothing matches.
 */
export function resolveVoacapFrequency(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'object') {
    if (finiteOrNull(input.mhz) !== null) return resolveVoacapFrequency(input.mhz);
    if (typeof input.band === 'string') return resolveVoacapFrequency(input.band);
    return null;
  }
  const text = String(input).trim().toLowerCase().replace(/\s+/g, '');
  const byBand = VOACAP_FREQUENCIES.find((row) => row.band === text || row.band === `${text}m`);
  if (byBand) return byBand;
  const mhz = finiteOrNull(text.replace(/mhz$/, ''));
  if (mhz === null || mhz < 1.8 || mhz > 30) return null;
  let best = null;
  for (const row of VOACAP_FREQUENCIES) {
    if (!best || Math.abs(row.mhz - mhz) < Math.abs(best.mhz - mhz)) best = row;
  }
  return best;
}

/** Whitelisted resolution; anything else falls back to the default. */
export function normalizeVoacapResolution(value) {
  const number = finiteOrNull(value);
  return number !== null && VOACAP_RESOLUTIONS.includes(number) ? number : VOACAP_DEFAULT_RESOLUTION;
}

/** UTC hour 0–23 or null (= "now" on the server). */
export function normalizeVoacapHour(value) {
  if (value === null || value === undefined || value === '' || value === 'now') return null;
  const number = finiteOrNull(value);
  if (number === null) return null;
  return ((Math.round(number) % 24) + 24) % 24;
}

/** Upper-case 4-char Maidenhead square, or null when the input is not a valid grid. */
export function normalizeTxGrid(value) {
  const text = String(value ?? '').trim();
  if (!text || !isValidGrid(text)) return null;
  const upper = text.toUpperCase();
  if (upper.length < 4) return null;
  return upper.slice(0, 4);
}

/**
 * Choose the VOACAP transmitter grid: the configured home grid when valid,
 * else the 4-character square under the view centre, else null.
 */
export function defaultTxGrid({ homeGrid = null, viewCentre = null } = {}) {
  const home = normalizeTxGrid(homeGrid);
  if (home) return home;
  const lat = finiteOrNull(viewCentre?.lat);
  const lon = finiteOrNull(viewCentre?.lon);
  if (lat === null || lon === null) return null;
  return latLonToGrid(lat, lon, 4);
}

/**
 * Merge a `setVoacap({ grid, frequencyMhz, hour, resolution })` request into
 * the current VOACAP state. Invalid fields keep their previous value.
 */
export function normalizeVoacapState(current = {}, patch = {}) {
  const base = {
    txGrid: normalizeTxGrid(current?.txGrid),
    frequencyMhz: resolveVoacapFrequency(current?.frequencyMhz)?.mhz ?? 14.1,
    hour: normalizeVoacapHour(current?.hour),
    resolution: normalizeVoacapResolution(current?.resolution),
  };
  const next = { ...base };
  if (patch && typeof patch === 'object') {
    const gridInput = patch.grid ?? patch.txGrid;
    if (gridInput !== undefined) {
      const grid = normalizeTxGrid(gridInput);
      if (grid) next.txGrid = grid;
    }
    const frequencyInput = patch.frequencyMhz ?? patch.band;
    if (frequencyInput !== undefined) {
      const row = resolveVoacapFrequency(frequencyInput);
      if (row) next.frequencyMhz = row.mhz;
    }
    if (patch.hour !== undefined) next.hour = normalizeVoacapHour(patch.hour);
    if (patch.resolution !== undefined) next.resolution = normalizeVoacapResolution(patch.resolution);
  }
  return Object.freeze(next);
}

/**
 * Query parameters for `/api/hamrig/voacap` from a VOACAP state. Returns null
 * when the transmitter grid is unusable. `hour` is only sent when set.
 */
export function buildVoacapQuery(state = {}) {
  const grid = normalizeTxGrid(state?.txGrid);
  if (!grid) return null;
  const centre = gridToLatLon(grid);
  if (!centre) return null;
  const frequency = resolveVoacapFrequency(state?.frequencyMhz)?.mhz ?? 14.1;
  const query = {
    lat: Number(centre.lat.toFixed(3)),
    lon: Number(centre.lon.toFixed(3)),
    frequencyMhz: frequency,
    resolution: normalizeVoacapResolution(state?.resolution),
  };
  const hour = normalizeVoacapHour(state?.hour);
  if (hour !== null) query.hour = hour;
  return query;
}

/** `?lat=..&lon=..` string for a query object (stable key order → stable cache key). */
export function voacapQueryString(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const key of ['lat', 'lon', 'frequencyMhz', 'hour', 'resolution']) {
    if (query[key] !== undefined && query[key] !== null) params.set(key, String(query[key]));
  }
  return params.toString();
}

// ---------------------------------------------------------------------------
// VOACAP colour ramp + cell geometry
// ---------------------------------------------------------------------------

/** 10-step reliability ramp, VOACAP style: blue (poor) → cyan → green → yellow → red (excellent). */
export const VOACAP_RAMP = Object.freeze([
  '#1e3a8a', '#1d4ed8', '#0284c7', '#06b6d4', '#10b981',
  '#84cc16', '#facc15', '#f97316', '#ef4444', '#b91c1c',
]);

/** Ramp step 0–9 for a reliability percentage. */
export function voacapStep(reliability) {
  const value = finiteOrNull(reliability);
  if (value === null) return null;
  return clamp(Math.floor(value / 10), 0, 9);
}

/**
 * Colour for one VOACAP cell: `{ step, css, alpha }`, or null below the
 * drawing threshold. Alpha grows with reliability so strong paths stand out.
 */
export function voacapRampColor(reliability, { minReliability = VOACAP_MIN_RELIABILITY } = {}) {
  const value = finiteOrNull(reliability);
  if (value === null || value < minReliability) return null;
  const step = voacapStep(value);
  const alpha = Number((0.22 + 0.4 * clamp((value - minReliability) / (100 - minReliability), 0, 1)).toFixed(3));
  return { step, css: VOACAP_RAMP[step], alpha };
}

/** Infer the grid spacing (degrees) from the point set; falls back to `fallback`. */
export function inferVoacapResolution(points, fallback = VOACAP_DEFAULT_RESOLUTION) {
  if (!Array.isArray(points) || points.length < 2) return fallback;
  const lons = [...new Set(points.map((p) => finiteOrNull(p?.lon)).filter((v) => v !== null))].sort((a, b) => a - b);
  let best = Infinity;
  for (let index = 1; index < lons.length; index += 1) {
    const delta = lons[index] - lons[index - 1];
    if (delta > 0 && delta < best) best = delta;
  }
  if (!Number.isFinite(best)) return fallback;
  const snapped = VOACAP_RESOLUTIONS.find((res) => Math.abs(res - best) < 1e-6);
  return snapped ?? fallback;
}

/**
 * Turn VOACAP points into drawable rectangles: one `resolution`-degree cell
 * centred on each point, clamped to the globe, coloured by the ramp. Points
 * below the reliability threshold are dropped.
 */
export function voacapCells(points, { resolution = null, minReliability = VOACAP_MIN_RELIABILITY } = {}) {
  const rows = Array.isArray(points) ? points : [];
  const size = normalizeVoacapResolution(resolution ?? inferVoacapResolution(rows));
  const half = size / 2;
  const cells = [];
  for (const point of rows) {
    const lat = finiteOrNull(point?.lat);
    const lon = finiteOrNull(point?.lon);
    const reliability = finiteOrNull(point?.reliability ?? point?.value);
    if (lat === null || lon === null || reliability === null) continue;
    const color = voacapRampColor(reliability, { minReliability });
    if (!color) continue;
    cells.push({
      id: `${lat}:${lon}`,
      lat,
      lon,
      west: clamp(lon - half, -180, 180),
      east: clamp(lon + half, -180, 180),
      south: clamp(lat - half, -90, 90),
      north: clamp(lat + half, -90, 90),
      reliability,
      snr: finiteOrNull(point?.snr),
      step: color.step,
      css: color.css,
      alpha: color.alpha,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Aurora
// ---------------------------------------------------------------------------

/**
 * SWPC OVATION probability → `{ r, g, b, a }` (0..1): faint green from 10 %,
 * yellow around 30 %, orange at 40 %, red at ≥ 50 %. Null below the threshold.
 */
export function auroraColor(value, { minProbability = AURORA_MIN_PROBABILITY } = {}) {
  const probability = finiteOrNull(value);
  if (probability === null || probability <= minProbability) return null;
  const stops = [
    { at: 10, rgb: [0.2, 0.9, 0.35] },
    { at: 30, rgb: [0.95, 0.9, 0.2] },
    { at: 40, rgb: [1.0, 0.55, 0.1] },
    { at: 50, rgb: [1.0, 0.15, 0.15] },
  ];
  const p = clamp(probability, stops[0].at, stops[stops.length - 1].at);
  let rgb = stops[stops.length - 1].rgb;
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    if (p <= next.at) {
      const t = (p - previous.at) / (next.at - previous.at);
      rgb = previous.rgb.map((c, i) => c + (next.rgb[i] - c) * t);
      break;
    }
  }
  const alpha = Number(clamp(0.18 + 0.72 * ((probability - minProbability) / (100 - minProbability)), 0.18, 0.9).toFixed(3));
  return { r: Number(rgb[0].toFixed(3)), g: Number(rgb[1].toFixed(3)), b: Number(rgb[2].toFixed(3)), a: alpha };
}

/** Keep aurora points above the probability threshold with valid coordinates. */
export function filterAuroraPoints(points, { minProbability = AURORA_MIN_PROBABILITY } = {}) {
  const rows = Array.isArray(points) ? points : [];
  const out = [];
  for (const row of rows) {
    const lat = finiteOrNull(row?.lat);
    const lon = finiteOrNull(row?.lon);
    const value = finiteOrNull(row?.value);
    if (lat === null || lon === null || value === null) continue;
    if (Math.abs(lat) > 90) continue;
    if (value <= minProbability) continue;
    out.push({ lat, lon: normalizeLon(lon), value });
  }
  return out;
}

/** Pixel size for an aurora point: 4 px faint → 9 px at ≥ 50 %. */
export function auroraPointSize(value) {
  const probability = finiteOrNull(value) ?? 0;
  return Number((4 + 5 * clamp((probability - 10) / 40, 0, 1)).toFixed(1));
}

// ---------------------------------------------------------------------------
// Ionosondes
// ---------------------------------------------------------------------------

/** Label text for an ionosonde marker. */
export function ionosondeLabel(station) {
  const mufd = finiteOrNull(station?.mufd);
  const text = mufd === null ? 'MUF(3000) —' : `MUF(3000) ${mufd.toFixed(1)}`;
  return station?.stale ? `${text} · stale` : text;
}

/** Re-derive `stale`/`ageMin` for a station at `nowMs` (rows arrive pre-flagged; we age them locally). */
export function ionosondeFreshness(station, nowMs = Date.now(), { staleMinutes = IONOSONDE_STALE_MIN } = {}) {
  const time = Date.parse(String(station?.timeIso ?? ''));
  const now = finiteOrNull(nowMs);
  if (!Number.isFinite(time) || now === null) {
    const ageMin = finiteOrNull(station?.ageMin);
    return { ageMin, stale: Boolean(station?.stale) || (ageMin !== null && ageMin > staleMinutes) };
  }
  const ageMin = Math.max(0, Math.round((now - time) / 60000));
  return { ageMin, stale: ageMin > staleMinutes };
}

/** Marker colour for an ionosonde: band colour by MUF when fresh, grey when stale. */
export function ionosondeColor(station, bandColorFn = null) {
  if (!station || station.stale) return '#8b95a3';
  if (typeof bandColorFn === 'function' && station.highestBand) {
    const css = bandColorFn(station.highestBand);
    if (typeof css === 'string' && css) return css;
  }
  return '#38bdf8';
}

/** Drop rows without coordinates, dedupe by code and sort by name for stable rendering. */
export function sanitizeIonosondes(stations) {
  const rows = Array.isArray(stations) ? stations : [];
  const byCode = new Map();
  for (const row of rows) {
    const code = String(row?.code ?? '').trim().toUpperCase();
    const lat = finiteOrNull(row?.lat);
    const lon = finiteOrNull(row?.lon);
    if (!code || lat === null || lon === null || Math.abs(lat) > 90) continue;
    byCode.set(code, { ...row, code, lat, lon: normalizeLon(lon) });
  }
  return [...byCode.values()].sort((a, b) => String(a.name ?? a.code).localeCompare(String(b.name ?? b.code)));
}

// ---------------------------------------------------------------------------
// Grayline geometry
// ---------------------------------------------------------------------------

/** Antipode of the subsolar point: the centre of the night hemisphere. */
export function antisolarPoint(dateMs = Date.now()) {
  const sun = subsolarPoint(dateMs);
  if (!sun) return null;
  return { lat: -sun.lat, lon: normalizeLon(sun.lon + 180) };
}

/**
 * The night hemisphere as a fan of polygon wedges around the antisolar point.
 * Cesium cannot triangulate a single polygon covering half the globe, so the
 * cap is split into `wedges` sectors whose outer edge is the 90° terminator
 * ring (`samplesPerWedge` points each). Every wedge is a closed ring starting
 * and ending at the antisolar point.
 */
export function nightHemisphereWedges(dateMs = Date.now(), { wedges = 12, samplesPerWedge = 12 } = {}) {
  const centre = antisolarPoint(dateMs);
  if (!centre) return [];
  const count = clamp(Math.round(finiteOrNull(wedges) ?? 12), 4, 72);
  const samples = clamp(Math.round(finiteOrNull(samplesPerWedge) ?? 12), 2, 90);
  const radiusKm = 90 * KM_PER_DEG;
  const out = [];
  for (let wedge = 0; wedge < count; wedge += 1) {
    const start = (360 * wedge) / count;
    const end = (360 * (wedge + 1)) / count;
    const ring = [{ lat: centre.lat, lon: centre.lon }];
    for (let index = 0; index <= samples; index += 1) {
      const bearing = start + ((end - start) * index) / samples;
      const point = destinationPoint(centre, bearing, radiusKm);
      if (point) ring.push(point);
    }
    out.push(ring);
  }
  return out;
}

/** Everything the grayline overlay draws for one instant. */
export function graylineGeometry(dateMs = Date.now(), { terminatorRingFn = null } = {}) {
  const sun = subsolarPoint(dateMs);
  if (!sun) return null;
  const rings = typeof terminatorRingFn === 'function'
    ? { day: terminatorRingFn(dateMs, 90), twilight: terminatorRingFn(dateMs, 102) }
    : { day: [], twilight: [] };
  return {
    computedAt: new Date(dateMs).toISOString(),
    sun,
    antisolar: antisolarPoint(dateMs),
    terminator: rings.day,
    twilight: rings.twilight,
    night: nightHemisphereWedges(dateMs),
  };
}

// ---------------------------------------------------------------------------
// Summary + camera
// ---------------------------------------------------------------------------

/** Short readout for the panel/voice: `SFI 110 · K 2 · A 8 · SSN 44`. */
export function summaryReadout(summary) {
  const solar = summary?.solar ?? {};
  const parts = [];
  if (finiteOrNull(solar.sfi) !== null) parts.push(`SFI ${Math.round(solar.sfi)}`);
  if (finiteOrNull(solar.kIndex) !== null) parts.push(`K ${solar.kIndex}`);
  if (finiteOrNull(solar.aIndex) !== null) parts.push(`A ${Math.round(solar.aIndex)}`);
  if (finiteOrNull(solar.ssn) !== null) parts.push(`SSN ${Math.round(solar.ssn)}`);
  if (solar.xrayClass) parts.push(`X-ray ${solar.xrayClass}`);
  return parts.join(' · ');
}

/** Bands ordered by wavelength with their condition word; unknown bands last. */
export function bandConditionRows(summary) {
  const order = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
  const bands = summary?.bands && typeof summary.bands === 'object' ? summary.bands : {};
  const known = order.filter((band) => band in bands).map((band) => ({ band, condition: String(bands[band]) }));
  const rest = Object.keys(bands).filter((band) => !order.includes(band)).sort().map((band) => ({ band, condition: String(bands[band]) }));
  return [...known, ...rest];
}

/** Camera height (m) for framing a VOACAP map from a transmitter grid: whole-globe view. */
export function voacapCameraHeightM() {
  return 18_000_000;
}

/** Camera height (m) that shows the aurora oval for one hemisphere. */
export function auroraCameraHeightM() {
  return 12_000_000;
}
