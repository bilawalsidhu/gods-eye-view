/**
 * HamRig / ham-radio feed normalizers (contract §1.3).
 *
 * Pure functions that turn the raw upstream payloads (HamRig REST + live
 * spot WebSocket, POTA, SOTA, WWFF, BOTA, NG3K, NOAA SWPC via HamRig,
 * KC2G ionosondes, repeater databases, PSKReporter / wspr.live, the
 * callsign database and the login-only "my station" feeds) into the
 * JSON shapes the GEV client consumes. Node-only module, but it imports
 * nothing but the browser-safe Maidenhead helpers from src/data.
 *
 * Every function is defensive: malformed rows produce `null` (or are
 * dropped from arrays), never a throw. Clocks are injected as `nowMs`.
 */

import { gridBounds, gridToLatLon, isValidGrid } from '../data/maidenhead.js';

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/** Amateur bands with their edges in Hz (IARU-wide envelopes). */
export const BANDS = Object.freeze([
  { band: '2200m', lowHz: 135_700, highHz: 137_800 },
  { band: '630m', lowHz: 472_000, highHz: 479_000 },
  { band: '160m', lowHz: 1_800_000, highHz: 2_000_000 },
  { band: '80m', lowHz: 3_500_000, highHz: 4_000_000 },
  { band: '60m', lowHz: 5_250_000, highHz: 5_450_000 },
  { band: '40m', lowHz: 7_000_000, highHz: 7_300_000 },
  { band: '30m', lowHz: 10_100_000, highHz: 10_150_000 },
  { band: '20m', lowHz: 14_000_000, highHz: 14_350_000 },
  { band: '17m', lowHz: 18_068_000, highHz: 18_168_000 },
  { band: '15m', lowHz: 21_000_000, highHz: 21_450_000 },
  { band: '12m', lowHz: 24_890_000, highHz: 24_990_000 },
  { band: '10m', lowHz: 28_000_000, highHz: 29_700_000 },
  { band: '6m', lowHz: 50_000_000, highHz: 54_000_000 },
  { band: '4m', lowHz: 70_000_000, highHz: 70_500_000 },
  { band: '2m', lowHz: 144_000_000, highHz: 148_000_000 },
  { band: '1.25m', lowHz: 222_000_000, highHz: 225_000_000 },
  { band: '70cm', lowHz: 420_000_000, highHz: 450_000_000 },
  { band: '33cm', lowHz: 902_000_000, highHz: 928_000_000 },
  { band: '23cm', lowHz: 1_240_000_000, highHz: 1_300_000_000 },
].map((row) => Object.freeze(row)));

const BAND_NAMES = new Set(BANDS.map((row) => row.band));

/** Band name for a frequency in Hz, or null when outside every ham band. */
export function bandForHz(hz) {
  const value = num(hz);
  if (value === null || value <= 0) return null;
  for (const row of BANDS) {
    if (value >= row.lowHz && value <= row.highHz) return row.band;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Finite number from a number or numeric string, else null. */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = value.trim().replace(/,/g, '');
    if (!text || text === 'NOT_FOUND') return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Trimmed non-empty string, else null. `NOT_FOUND` sentinels become null. */
function str(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text === 'NOT_FOUND') return null;
  return text;
}

function upper(value) {
  const text = str(value);
  return text ? text.toUpperCase() : null;
}

function bool(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(text)) return true;
    if (['0', 'false', 'no', 'n', ''].includes(text)) return false;
  }
  return null;
}

const TZ_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/** Millisecond timestamp from ISO text (tz-less = UTC), unix seconds, ms or Date. */
function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e11 ? value * 1000 : value; // unix seconds vs milliseconds
  }
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return toMs(Number(text));
  // MySQL-style "2026-01-04 00:39:25" → ISO; trim sub-millisecond fractions.
  text = text.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  if (!TZ_SUFFIX_RE.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value) {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** Valid geographic coordinate pair (not null island), else null. */
function coords(lat, lon) {
  const la = num(lat);
  const lo = num(lon);
  if (la === null || lo === null) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  if (la === 0 && lo === 0) return null;
  return { lat: la, lon: lo };
}

/** Locator → cell centre when the locator is valid and at least 4 chars. */
function gridCentre(locator, minChars = 4) {
  const text = str(locator);
  if (!text || text.length < minChars || !isValidGrid(text)) return null;
  return gridToLatLon(text);
}

// ---------------------------------------------------------------------------
// Frequencies
// ---------------------------------------------------------------------------

const MAX_HZ = 300e9;

function acceptHz(hz) {
  if (!Number.isFinite(hz) || hz <= 0 || hz > MAX_HZ) return null;
  return Math.round(hz);
}

/**
 * Parse a spot frequency into Hz.
 *  - `unitHint` ∈ 'mhz' | 'khz' | 'hz' | 'auto'.
 *  - thousands separators are stripped ("14,074" → 14074).
 *  - 'khz' guard: values ≥ 1e6 are really Hz.
 *  - POTA sanity: a kHz value ≥ 100 000 written without a decimal point had
 *    its point dropped — a two-decimal drop ('1403650' = 14036.50 kHz,
 *    '703200' = 7032.00 kHz) → /100, or a one-decimal drop ('140625' =
 *    14062.5 kHz) → /10 — but only when the value as written lands in no
 *    ham band and the repaired one does. The /100 repair is tried first.
 */
export function parseSpotFrequency(value, unitHint = 'auto') {
  const text = typeof value === 'string' ? value.trim().replace(/,/g, '') : value;
  const f = num(text);
  if (f === null || f <= 0) return null;
  const hasPoint = typeof text === 'string' && text.includes('.');
  const hint = String(unitHint ?? 'auto').toLowerCase();

  const fromKhz = (k) => {
    const raw = k >= 1e6 ? k : k * 1e3; // 'khz' guard: ≥ 1e6 is really Hz
    if (!hasPoint && k >= 100_000 && !bandForHz(raw)) {
      // Dropped-point repairs, compared against the interpretation the value
      // would otherwise get (raw), so 30 m ('1013600', k in [1e6, 1.3e6)) and
      // the sub-1e6 bands ('703200', '357300', '184000') are covered too.
      const twoDecimals = k * 10; // (k / 100) kHz → Hz: '1403650' = 14036.50 kHz
      if (bandForHz(twoDecimals)) return acceptHz(twoDecimals);
      const oneDecimal = k * 100; // (k / 10) kHz → Hz: '140625' = 14062.5 kHz
      if (bandForHz(oneDecimal)) return acceptHz(oneDecimal);
    }
    return acceptHz(raw);
  };

  if (hint === 'mhz') return acceptHz(f * 1e6);
  if (hint === 'khz') return fromKhz(f);
  if (hint === 'hz') return acceptHz(f);

  // auto: prefer the interpretation that lands in a ham band; otherwise magnitude.
  const candidates = [acceptHz(f * 1e6), fromKhz(f), acceptHz(f)];
  for (const hz of candidates) {
    if (hz !== null && bandForHz(hz)) return hz;
  }
  if (f < 1300) return acceptHz(f * 1e6);
  if (f < 1e6) return fromKhz(f);
  return acceptHz(f);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

const EXPLICIT_MODES = {
  CW: 'CW', SSB: 'SSB', USB: 'SSB', LSB: 'SSB', PHONE: 'SSB',
  FT8: 'FT8', FT4: 'FT4', RTTY: 'RTTY',
  PSK: 'PSK', PSK31: 'PSK', PSK63: 'PSK', PSK125: 'PSK', BPSK31: 'PSK', BPSK63: 'PSK', QPSK31: 'PSK',
  JS8: 'JS8', JS8CALL: 'JS8', WSPR: 'WSPR', MSK144: 'MSK144',
  DIGI: 'DIGI', DIGITAL: 'DIGI', DATA: 'DIGI', Q65: 'DIGI', JT65: 'DIGI', JT9: 'DIGI', JT4: 'DIGI', FST4: 'DIGI', FST4W: 'DIGI', OLIVIA: 'DIGI', HELL: 'DIGI',
  AM: 'AM', FM: 'FM', SSTV: 'SSTV', BEACON: 'BEACON', BCN: 'BEACON',
};

// [regex, mode]; matched by earliest position in the comment, list order breaks ties.
const COMMENT_KEYWORDS = [
  [/\bFT8\b/i, 'FT8'],
  [/\bFT4\b/i, 'FT4'],
  [/\bJS8(?:CALL)?\b/i, 'JS8'],
  [/\bWSPR\b/i, 'WSPR'],
  [/\bMSK144\b/i, 'MSK144'],
  [/\b(?:Q65|JT65|JT9)\b/i, 'DIGI'],
  [/\b[BQ]?PSK(?:31|63|125)?\b/i, 'PSK'],
  [/\bRTTY\b/i, 'RTTY'],
  [/\bSSTV\b/i, 'SSTV'],
  [/\bCW\b/i, 'CW'],
  [/\b(?:SSB|USB|LSB)\b/i, 'SSB'],
  // AM / FM are common English/ham words in lower case ("fm" = from), so
  // only the upper-case tokens count.
  [/\bAM\b/, 'AM'],
  [/\bFM\b/, 'FM'],
  [/\b(?:BEACON|BCN)\b/i, 'BEACON'],
];

// Dial frequencies in kHz; a signal within dial..dial+3 kHz gets the mode.
const DIAL_TABLE = [
  ['FT8', [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313, 50323, 70154, 144174]],
  ['FT4', [3575, 7047.5, 10140, 14080, 18104, 21140, 24919, 28180, 50318]],
  ['WSPR', [1836.6, 3568.6, 7038.6, 10138.7, 14095.6, 18104.6, 21094.6, 24924.6, 28124.6, 50293]],
  ['JS8', [1842, 3578, 7078, 10130, 14078, 18104, 21078, 24922, 28078]],
];
const DIAL_WINDOW_KHZ = 3;
const IBP_KHZ = [14100, 18110, 21150, 24930, 28200];
const IBP_TOLERANCE_KHZ = 0.5;

// IARU R1 / ARRL band plan segments in kHz: [bandLowKhz, cwBelow, digiFrom, digiTo, ssbAbove]
const SEGMENTS = [
  { low: 1800, high: 2000, cwFrom: 1810, cwBelow: 1838, ssbAbove: 1843 },
  { low: 3500, high: 4000, cwBelow: 3570, digiFrom: 3570, digiTo: 3600, ssbAbove: 3600 },
  { low: 7000, high: 7300, cwBelow: 7040, digiFrom: 7040, digiTo: 7050, ssbAbove: 7050 },
  { low: 10100, high: 10150, cwBelow: 10130, digiFrom: 10130, digiTo: 10150 },
  { low: 14000, high: 14350, cwBelow: 14070, digiFrom: 14070, digiTo: 14099, ssbAbove: 14101 },
  { low: 18068, high: 18168, cwBelow: 18095, ssbAbove: 18111 },
  { low: 21000, high: 21450, cwBelow: 21070, digiFrom: 21070, digiTo: 21110, ssbAbove: 21151 },
  { low: 24890, high: 24990, cwBelow: 24915, ssbAbove: 24931 },
  { low: 28000, high: 29700, cwBelow: 28070, digiFrom: 28070, digiTo: 28120, ssbAbove: 28225 },
];

function explicitMode(value) {
  const text = upper(value);
  if (!text) return null;
  return EXPLICIT_MODES[text.replace(/[\s_-]+/g, '')] ?? null;
}

function modeFromComment(comment, hz = null) {
  const text = str(comment);
  if (!text) return null;
  const value = num(hz);
  const khz = value !== null && value > 0 ? value / 1000 : null;
  let best = null;
  for (const [re, mode] of COMMENT_KEYWORDS) {
    // Upper-case "FM" is "from" in caps-typed cluster comments ("TNX FM JAPAN",
    // "QSL FM EU"); FM is only a mode from the 10 m FM segment (29 MHz) up, so
    // below that the remaining keywords and the band-plan tables decide.
    if (mode === 'FM' && khz !== null && khz < 29_000) continue;
    const match = re.exec(text);
    if (match && (best === null || match.index < best.index)) best = { index: match.index, mode };
  }
  if (best) return best.mode;
  // RBN skimmer patterns: "15 dB 20 WPM" → CW, "12 dB 45 BPS" → RTTY.
  if (/\b\d+\s*WPM\b/i.test(text)) return 'CW';
  if (/\b\d+\s*BPS\b/i.test(text)) return 'RTTY';
  return null;
}

function modeFromFrequency(hz) {
  const value = num(hz);
  if (value === null || value <= 0) return null;
  const khz = value / 1000;
  // Windows overlap (FT8 3573 vs FT4 3575): the nearest dial at or below the
  // signal wins; table order only breaks exact ties.
  let best = null;
  for (const [mode, dials] of DIAL_TABLE) {
    for (const dial of dials) {
      if (khz >= dial && khz <= dial + DIAL_WINDOW_KHZ && (best === null || dial > best.dial)) best = { dial, mode };
    }
  }
  if (best) return best.mode;
  for (const dial of IBP_KHZ) {
    if (Math.abs(khz - dial) <= IBP_TOLERANCE_KHZ) return 'BEACON';
  }
  for (const seg of SEGMENTS) {
    if (khz < seg.low || khz > seg.high) continue;
    if (seg.cwFrom !== undefined ? khz >= seg.cwFrom && khz <= seg.cwBelow : khz < seg.cwBelow) return 'CW';
    if (seg.digiFrom !== undefined && khz >= seg.digiFrom && khz <= seg.digiTo) return 'DIGI';
    if (seg.ssbAbove !== undefined && khz > seg.ssbAbove) return 'SSB';
    return null;
  }
  return null; // VHF/UHF outside the dial table: do not guess
}

/**
 * Best-effort mode: explicit real mode word > comment keyword > dial table >
 * band-plan segment > null.
 */
export function inferMode(comment, hz, explicit = null) {
  return explicitMode(explicit) ?? modeFromComment(comment, hz) ?? modeFromFrequency(hz);
}

// ---------------------------------------------------------------------------
// Spots
// ---------------------------------------------------------------------------

const FUTURE_SLACK_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'HHMMZ' cluster time → ISO for today (UTC); > 5 min in the future → yesterday. */
export function spotTimeToIso(hhmmZ, nowMs) {
  const text = str(hhmmZ);
  if (!text) return null;
  const match = /^(\d{2}):?(\d{2})(?::?(\d{2}))?\s*Z?$/i.exec(text);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = match[3] ? Number(match[3]) : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const now = num(nowMs) ?? Date.now();
  const base = new Date(now);
  let ms = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hh, mm, ss);
  if (ms > now + FUTURE_SLACK_MS) ms -= DAY_MS;
  return new Date(ms).toISOString();
}

/** Display string plus a lookup-safe callsign (skimmer suffixes stripped). */
export function cleanSpotter(raw) {
  const spotter = str(raw) ?? '';
  let call = spotter.replace(/:$/, '').toUpperCase();
  let previous = null;
  while (previous !== call) {
    previous = call;
    call = call.replace(/-#$|-\d+$/, '');
  }
  return { spotter, spotterCall: call };
}

function buildSpot({ dx, spotterRaw, freqHz, comment, timeIso, bandHint, source }) {
  const dxCall = upper(dx);
  if (!dxCall || freqHz === null) return null;
  const { spotter, spotterCall } = cleanSpotter(spotterRaw);
  const bandFromHz = bandForHz(freqHz);
  const hint = str(bandHint);
  const band = bandFromHz ?? (hint && BAND_NAMES.has(hint) ? hint : null);
  const text = str(comment) ?? '';
  const spot = {
    id: '',
    dx: dxCall,
    spotter,
    spotterCall,
    freqHz,
    band,
    mode: inferMode(text, freqHz),
    comment: text,
    timeIso,
    dxLoc: null,
    spotterLoc: null,
    source,
  };
  spot.id = spotKey(spot);
  return spot;
}

/** HamRig `GET /api/spots` row → Spot. `raw.mode` is a server default and ignored. */
export function normalizeRestSpot(raw, { nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const freqHz = parseSpotFrequency(raw.frequency, 'mhz');
  const timeIso = toIso(raw.timestamp) ?? spotTimeToIso(raw.time, nowMs) ?? new Date(nowMs).toISOString();
  return buildSpot({
    dx: raw.dx_callsign ?? raw.dx ?? raw.spotted,
    spotterRaw: raw.spotter,
    freqHz,
    comment: raw.comment ?? raw.comments,
    timeIso,
    bandHint: raw.band,
    source: 'rest',
  });
}

/**
 * Live WebSocket message → Spot. Bare spot objects carry no `type`;
 * `historical_spot` wrappers are unwrapped; every other typed message → null.
 */
export function normalizeWsSpot(raw, { nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  let row = raw;
  if (typeof raw.type === 'string') {
    if (raw.type !== 'historical_spot') return null;
    row = raw.spot;
    if (!row || typeof row !== 'object') return null;
  }
  const freqHz = parseSpotFrequency(row.frequency, 'khz');
  const timeIso = toIso(row.timestamp) ?? spotTimeToIso(row.time, nowMs) ?? new Date(nowMs).toISOString();
  return buildSpot({
    dx: row.spotted ?? row.dx_callsign ?? row.dx,
    spotterRaw: row.spotter,
    freqHz,
    comment: row.comment ?? row.comments,
    timeIso,
    bandHint: row.band,
    source: 'ws',
  });
}

/** Dedupe key: spotter | dx | 100 Hz bin | minute. */
export function spotKey(spot) {
  const ms = toMs(spot?.timeIso);
  const minuteIso = ms === null ? '' : new Date(ms).toISOString().slice(0, 16);
  const freqHz = num(spot?.freqHz) ?? 0;
  return `${spot?.spotterCall ?? ''}|${spot?.dx ?? ''}|${Math.round(freqHz / 100)}|${minuteIso}`;
}

// ---------------------------------------------------------------------------
// Activations
// ---------------------------------------------------------------------------

function buildActivation(fields) {
  const callsign = upper(fields.callsign);
  const reference = str(fields.reference);
  if (!callsign || !reference || fields.freqHz === null) return null;
  const position = fields.position;
  if (!position) return null;
  return {
    id: fields.id,
    program: fields.program,
    callsign,
    reference,
    name: str(fields.name),
    freqHz: fields.freqHz,
    band: bandForHz(fields.freqHz),
    mode: inferMode(fields.comments, fields.freqHz, fields.mode),
    timeIso: fields.timeIso,
    spotter: str(fields.spotter),
    comments: str(fields.comments) ?? '',
    lat: position.lat,
    lon: position.lon,
    precision: position.precision,
    locator: str(fields.locator),
    country: str(fields.country),
    altitudeM: num(fields.altitudeM),
    points: num(fields.points),
    url: fields.url ?? null,
  };
}

function positionFrom(lat, lon, locator) {
  const exact = coords(lat, lon);
  if (exact) return { ...exact, precision: 'exact' };
  const grid = gridCentre(locator);
  if (grid) return { ...grid, precision: 'grid' };
  return null;
}

/** POTA `spot/activator` row → Activation. */
export function normalizePotaSpot(raw, { nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const reference = str(raw.reference);
  const locator = str(raw.grid6) ?? str(raw.grid4);
  const locationDesc = str(raw.locationDesc);
  return buildActivation({
    id: `pota:${str(raw.spotId) ?? `${upper(raw.activator)}:${reference}`}`,
    program: 'POTA',
    callsign: raw.activator,
    reference,
    name: str(raw.parkName) ?? str(raw.name),
    freqHz: parseSpotFrequency(raw.frequency, 'khz'),
    mode: raw.mode,
    comments: raw.comments,
    timeIso: toIso(raw.spotTime) ?? new Date(nowMs).toISOString(),
    spotter: cleanSpotter(raw.spotter).spotter,
    position: positionFrom(raw.latitude, raw.longitude, locator),
    locator,
    country: locationDesc ? locationDesc.split('-')[0] : null,
    altitudeM: null,
    points: null,
    url: reference ? `https://pota.app/#/park/${encodeURIComponent(reference)}` : null,
  });
}

/** SOTA spot row (+ optional summit record) → Activation. */
export function normalizeSotaSpot(raw, summit, { nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const summitCode = str(raw.summitCode) ?? str(summit?.summitCode);
  const rowPosition = coords(raw.latitude, raw.longitude);
  const summitPosition = summit ? coords(summit.latitude, summit.longitude) : null;
  const position = rowPosition ?? summitPosition;
  return buildActivation({
    id: `sota:${str(raw.id) ?? `${upper(raw.activatorCallsign)}:${summitCode}`}`,
    program: 'SOTA',
    callsign: raw.activatorCallsign,
    reference: summitCode,
    name: str(raw.summitName) ?? str(summit?.name),
    freqHz: parseSpotFrequency(raw.frequency, 'mhz'),
    mode: raw.mode,
    comments: raw.comments,
    timeIso: toIso(raw.timeStamp) ?? new Date(nowMs).toISOString(),
    spotter: raw.callsign,
    position: position ? { ...position, precision: 'exact' } : null,
    locator: summit?.locator ?? null,
    country: str(summit?.associationName) ?? (summitCode ? summitCode.split('/')[0] : null),
    altitudeM: num(raw.AltM) ?? num(summit?.altM),
    points: num(raw.points) ?? num(summit?.points),
    url: summitCode ? `https://sotl.as/summits/${summitCode}` : null,
  });
}

/** WWFF spot via HamRig → Activation (row lat/lon, else ≥ 4-char locator). */
export function normalizeWwffSpot(raw, { nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const reference = str(raw.reference);
  const freqHz = num(raw.frequencyKhz) !== null
    ? parseSpotFrequency(raw.frequencyKhz, 'khz')
    : parseSpotFrequency(raw.frequency, 'mhz');
  return buildActivation({
    id: `wwff:${str(raw.id) ?? `${upper(raw.callsign)}:${reference}`}`,
    program: 'WWFF',
    callsign: raw.callsign,
    reference,
    name: str(raw.name),
    freqHz,
    mode: raw.mode,
    comments: raw.comments,
    timeIso: toIso(raw.time) ?? new Date(nowMs).toISOString(),
    spotter: raw.spotter,
    position: positionFrom(raw.latitude, raw.longitude, raw.locator),
    locator: raw.locator,
    country: str(raw.country),
    altitudeM: null,
    points: null,
    url: reference ? `https://wwff.co/directory/?showRef=${encodeURIComponent(reference)}` : null,
  });
}

/** WWBOTA spot via HamRig → Activation (`lat`/`lon` keys). */
export function normalizeBotaSpot(raw, { nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const reference = str(raw.reference);
  const timeIso = toIso(raw.time) ?? new Date(nowMs).toISOString();
  return buildActivation({
    id: `bota:${str(raw.id) ?? `${upper(raw.callsign)}:${reference}:${timeIso.slice(0, 16)}`}`,
    program: 'BOTA',
    callsign: raw.callsign,
    reference,
    name: str(raw.name),
    freqHz: parseSpotFrequency(raw.frequency, 'mhz'),
    mode: raw.mode,
    comments: raw.comments,
    timeIso,
    spotter: raw.spotter,
    position: positionFrom(raw.lat ?? raw.latitude, raw.lon ?? raw.longitude, raw.locator),
    locator: raw.locator,
    country: null,
    altitudeM: null,
    points: null,
    url: 'https://www.wwbota.net/',
  });
}

// ---------------------------------------------------------------------------
// DXpeditions
// ---------------------------------------------------------------------------

const DXPED_STATUS = { active: 'active', upcoming: 'upcoming', past: 'ended', ended: 'ended' };

function cleanQslVia(value) {
  let text = str(value);
  if (!text) return null;
  const open = (text.match(/\(/g) ?? []).length;
  const close = (text.match(/\)/g) ?? []).length;
  if (open !== close) text = text.replace(/^[\s(]+|[\s)]+$/g, '').replace(/[()]/g, '').trim();
  return text || null;
}

function lookupByCall(map, callsign) {
  if (!map || !callsign) return null;
  if (map instanceof Map) return map.get(callsign) ?? map.get(callsign.toLowerCase()) ?? null;
  if (typeof map === 'object') return map[callsign] ?? null;
  return null;
}

/**
 * NG3K operation (+ most-wanted row, + `locate(callOrPrefix) → Loc|null`)
 * → Dxpedition. Callsigns are often bare prefixes ('TF', 'J3').
 */
export function normalizeDxpedition(op, mostWantedByCall = null, locate = null) {
  if (!op || typeof op !== 'object') return null;
  const callsign = upper(op.callsign);
  if (!callsign) return null;
  const wanted = lookupByCall(mostWantedByCall, callsign);
  let loc = null;
  if (typeof locate === 'function') {
    try { loc = locate(callsign) ?? null; } catch { loc = null; }
  }
  const position = loc ? coords(loc.lat, loc.lon) : null;
  const statusText = str(op.status)?.toLowerCase();
  const status = DXPED_STATUS[statusText] ?? (bool(op.is_active) ? 'active' : 'upcoming');
  const startIso = toIso(op.start_timestamp);
  return {
    id: `dxped:${callsign}:${num(op.start_timestamp) ?? str(op.start_date) ?? ''}`,
    callsign,
    entity: str(op.entity) ?? str(wanted?.entity) ?? str(loc?.entity),
    adif: num(loc?.adif) ?? num(wanted?.dxcc),
    continent: str(loc?.continent) ?? str(wanted?.continent),
    lat: position?.lat ?? null,
    lon: position?.lon ?? null,
    precision: 'entity',
    startIso,
    endIso: toIso(op.end_timestamp),
    status,
    daysUntil: num(op.days_until),
    qslVia: cleanQslVia(op.qsl_via) ?? cleanQslVia(wanted?.qsl_via),
    info: str(op.info) ?? str(wanted?.info),
    url: str(op.operation_url),
    iota: str(op.iota),
    mostWantedRank: num(wanted?.rank),
    bands: Array.isArray(op.bands) ? op.bands.map(str).filter(Boolean) : [],
    modes: Array.isArray(op.modes) ? op.modes.map(str).filter(Boolean) : [],
  };
}

// ---------------------------------------------------------------------------
// Space weather / propagation overlays
// ---------------------------------------------------------------------------

/**
 * NOAA OVATION aurora overlay via HamRig → { points, current, level, ... }.
 * OVATION reports longitudes 0..359, so they are wrapped to −180..180 rather
 * than rejected (coords() would drop the whole western hemisphere).
 */
export function normalizeAurora(payload) {
  const rows = Array.isArray(payload?.points) ? payload.points : [];
  const points = [];
  for (const row of rows) {
    const lat = num(row?.lat);
    const lon = num(row?.lon);
    const value = num(row?.value);
    if (lat === null || lon === null || value === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 360) continue;
    points.push({ lat, lon: wrapLon(lon), value });
  }
  return {
    points,
    current: num(payload?.current),
    level: str(payload?.level),
    observationIso: toIso(payload?.observation_time),
    forecastIso: toIso(payload?.forecast_time),
    unit: str(payload?.unit) ?? '%',
  };
}

/** VOACAP reliability grid via HamRig. */
export function normalizeVoacap(payload) {
  const rows = Array.isArray(payload?.points) ? payload.points : [];
  const points = [];
  for (const row of rows) {
    const lat = num(row?.lat);
    const lon = num(row?.lon);
    const reliability = num(row?.value);
    if (lat === null || lon === null || reliability === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    points.push({ lat, lon, reliability, snr: num(row?.snr) });
  }
  return {
    txLat: num(payload?.tx_lat),
    txLon: num(payload?.tx_lon),
    frequencyMhz: num(payload?.frequency),
    utcHour: num(payload?.utc_hour),
    ssn: num(payload?.ssn_used),
    points,
  };
}

const IONO_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const IONO_STALE_MIN = 60;

/** Highest ham band whose lower edge is at or below `mufdMhz`. */
function highestBandForMuf(mufdMhz) {
  const muf = num(mufdMhz);
  if (muf === null || muf <= 0) return null;
  const hz = muf * 1e6;
  let best = null;
  for (const row of BANDS) {
    if (row.lowHz <= hz) best = row.band;
  }
  return best;
}

function wrapLon(lon) {
  let value = lon;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

/** KC2G ionosonde rows → IonoStation[] (age > 24 h dropped, > 60 min stale). */
export function normalizeIonosondes(rows, { nowMs = Date.now() } = {}) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const station = row?.station;
    if (!station || typeof station !== 'object') continue;
    const code = str(station.code);
    const lat = num(station.latitude);
    const lonRaw = num(station.longitude);
    if (!code || lat === null || lonRaw === null || Math.abs(lat) > 90) continue;
    const ms = toMs(row.time);
    if (ms === null) continue;
    const ageMs = nowMs - ms;
    if (ageMs > IONO_MAX_AGE_MS) continue;
    const ageMin = Math.max(0, Math.round(ageMs / 60000));
    const mufd = num(row.mufd);
    out.push({
      code,
      name: str(station.name) ?? code,
      lat,
      lon: wrapLon(lonRaw),
      mufd,
      fof2: num(row.fof2),
      hmf2: num(row.hmf2),
      tec: num(row.tec),
      timeIso: new Date(ms).toISOString(),
      ageMin,
      stale: ageMin > IONO_STALE_MIN,
      highestBand: highestBandForMuf(mufd),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Repeaters
// ---------------------------------------------------------------------------

function mhzToHz(value) {
  const mhz = num(value);
  return mhz === null ? null : Math.round(mhz * 1e6);
}

function normalizeFmRepeater(row) {
  if (!row || typeof row !== 'object') return null;
  const position = coords(row.latitude, row.longitude);
  const outputHz = mhzToHz(row.frequency);
  const callsign = upper(row.callsign);
  if (!position || outputHz === null || !callsign) return null;
  return {
    id: `fm:${str(row.id) ?? `${callsign}:${outputHz}`}`,
    kind: 'FM',
    callsign,
    outputHz,
    inputHz: mhzToHz(row.input_frequency),
    ctcss: num(row.pl_tone) ?? num(row.tsq_tone),
    city: str(row.city),
    region: str(row.state),
    country: str(row.country),
    lat: position.lat,
    lon: position.lon,
    distanceKm: num(row.distance_km),
    status: str(row.operational_status),
    echolink: str(row.echolink_node),
    allstar: str(row.allstar_node),
    module: null,
  };
}

function normalizeDstarRepeater(row) {
  if (!row || typeof row !== 'object') return [];
  const position = coords(row.latitude, row.longitude);
  const callsign = upper(row.callsign);
  if (!position || !callsign) return [];
  const [country, ...regionParts] = String(row.country_state ?? '').split(',');
  const modules = Array.isArray(row.modules) ? row.modules : [];
  const out = [];
  for (const module of modules) {
    const outputHz = mhzToHz(module?.frequency);
    if (outputHz === null) continue;
    const offsetHz = mhzToHz(module?.freq_offset) ?? 0;
    const letter = upper(module?.module_letter);
    out.push({
      id: `dstar:${str(row.id) ?? callsign}:${letter ?? outputHz}`,
      kind: 'D-STAR',
      callsign,
      outputHz,
      inputHz: outputHz + offsetHz,
      ctcss: null,
      city: str(row.city),
      region: str(regionParts.join(',')),
      country: str(country) ?? str(row.region_name),
      lat: position.lat,
      lon: position.lon,
      distanceKm: num(row.distance_km),
      status: str(row.gateway_status),
      echolink: null,
      allstar: null,
      module: letter,
    });
  }
  return out;
}

/** FM + D-STAR nearby payloads → Repeater[] (one row per D-STAR module), nearest first. */
export function normalizeRepeaters(fmPayload, dstarPayload) {
  const out = [];
  const fmRows = Array.isArray(fmPayload?.data) ? fmPayload.data : Array.isArray(fmPayload) ? fmPayload : [];
  for (const row of fmRows) {
    const repeater = normalizeFmRepeater(row);
    if (repeater) out.push(repeater);
  }
  const dstarRows = Array.isArray(dstarPayload?.data) ? dstarPayload.data : Array.isArray(dstarPayload) ? dstarPayload : [];
  for (const row of dstarRows) out.push(...normalizeDstarRepeater(row));
  return out.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
}

// ---------------------------------------------------------------------------
// Reception (PSKReporter + WSPR)
// ---------------------------------------------------------------------------

function normalizePskReporter(pskr) {
  if (!pskr || typeof pskr !== 'object' || pskr.success === false) return null;
  const bands = pskr.bands && typeof pskr.bands === 'object' && !Array.isArray(pskr.bands) ? { ...pskr.bands } : {};
  const rows = Array.isArray(pskr.reports) ? pskr.reports : [];
  const reports = [];
  for (const row of rows) {
    const rxCall = upper(row?.rx_call);
    if (!rxCall) continue;
    const rxGrid = str(row.rx_grid);
    const centre = gridCentre(rxGrid, 2);
    reports.push({
      rxCall,
      rxGrid,
      lat: centre?.lat ?? null,
      lon: centre?.lon ?? null,
      band: str(row.band),
      mode: upper(row.mode),
      snr: num(row.snr),
      freqHz: num(row.freq) === null ? null : Math.round(num(row.freq)),
      timeIso: toIso(row.t),
      azimuth: num(row.my_azimuth),
    });
  }
  return {
    call: upper(pskr.call),
    count: num(pskr.count) ?? reports.length,
    warmingUp: bool(pskr.warming_up) ?? false,
    bands,
    reports,
  };
}

function normalizeWspr(wspr) {
  if (!wspr || typeof wspr !== 'object' || wspr.success === false) return null;
  const field = upper(wspr.field);
  const bounds = field && isValidGrid(field) ? gridBounds(field) : null;
  const rows = Array.isArray(wspr.bands) ? wspr.bands : [];
  const bands = [];
  for (const row of rows) {
    const band = str(row?.band);
    if (!band) continue;
    const dxGrid = str(row.dx_grid);
    const dx = gridCentre(dxGrid, 2);
    bands.push({
      band,
      spots: num(row.spots) ?? 0,
      maxKm: num(row.max_km),
      avgSnr: num(row.avg_snr),
      dxGrid,
      dxLat: dx?.lat ?? null,
      dxLon: dx?.lon ?? null,
      dxAzimuth: num(row.dx_azimuth),
    });
  }
  return { field, bounds, bands };
}

/** PSKReporter + wspr.live payloads → Reception. Either side may be missing. */
export function normalizeReception(pskr, wspr) {
  return { psk: normalizePskReporter(pskr), wspr: normalizeWspr(wspr) };
}

// ---------------------------------------------------------------------------
// Stations (callsign database)
// ---------------------------------------------------------------------------

/** Keys that must never reach the client. */
export const PII_KEYS = Object.freeze([
  'email', 'email_address', 'addr1', 'addr2', 'address', 'zip', 'zip_code', 'county', 'bio', 'data_sources', 'trustee',
]);

const DEFAULT_BASE_URL = 'https://hamrig.com';

function absoluteUrl(value, baseUrl) {
  const text = str(value);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('//')) return `https:${text}`;
  const base = (str(baseUrl) ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}${text.startsWith('/') ? '' : '/'}${text}`;
}

function stationName(row) {
  const first = str(row.first_name);
  const last = str(row.last_name);
  const name = str(row.name);
  if (first && last) return `${first} ${last}`;
  if (first && name) {
    return name.toUpperCase().includes(first.toUpperCase()) ? name : `${first} ${name}`;
  }
  if (name) return name;
  return first ?? last ?? null;
}

/**
 * HamRig callsign-db payload (+ optional cty result) → Station|null.
 * 'NOT_FOUND' sentinels become nulls; a row with neither a name nor any
 * position (exact, grid, or cty entity) is a miss → null. PII is never copied.
 */
export function normalizeStation(callsignDb, ctyResult = null, { baseUrl = DEFAULT_BASE_URL, callsign: requestedCallsign = null } = {}) {
  if (!callsignDb || typeof callsignDb !== 'object') return null;
  if (callsignDb.error && !callsignDb.callsign) return null;
  const row = callsignDb.callsign && typeof callsignDb.callsign === 'object' ? callsignDb.callsign : callsignDb;
  const hamrigUser = callsignDb.hamrig_user && typeof callsignDb.hamrig_user === 'object' ? callsignDb.hamrig_user : null;
  // `options.callsign` is the requested call — the fallback when the row's own
  // callsign field is a NOT_FOUND sentinel (HamDB cold miss) but cty still matches.
  const callsign = upper(row.callsign)
    ?? (typeof callsignDb.callsign === 'string' ? upper(callsignDb.callsign) : null)
    ?? upper(requestedCallsign);
  if (!callsign) return null;

  const name = stationName(row);
  const grid = str(row.grid_square) ?? str(row.grid) ?? str(row.locator);
  let position = coords(row.latitude, row.longitude);
  let precision = null;
  if (position) {
    precision = 'exact';
  } else {
    const centre = gridCentre(grid);
    if (centre) {
      position = centre;
      precision = 'grid';
    } else if (ctyResult && coords(ctyResult.lat, ctyResult.lon)) {
      position = coords(ctyResult.lat, ctyResult.lon);
      precision = ctyResult.precision === 'area' ? 'area' : 'entity';
    }
  }
  if (!name && !position) return null;

  const country = str(row.country) ?? str(ctyResult?.entity);
  const sources = [];
  if (str(callsignDb.source)) sources.push(str(callsignDb.source));
  if (ctyResult) sources.push('cty.dat');

  return {
    callsign,
    name,
    country,
    dxcc: {
      adif: num(row.dxcc_code) ?? num(row.dxcc) ?? null,
      name: country,
      prefix: str(ctyResult?.primaryPrefix),
      continent: upper(row.continent) ?? str(ctyResult?.continent),
      cqZone: num(row.cq_zone) ?? num(ctyResult?.cq),
      ituZone: num(row.itu_zone) ?? num(ctyResult?.itu),
    },
    lat: position?.lat ?? null,
    lon: position?.lon ?? null,
    precision,
    grid: grid && isValidGrid(grid) ? grid : null,
    city: str(row.city),
    state: str(row.state),
    imageUrl: absoluteUrl(row.profile_image_url ?? row.image_url, baseUrl),
    licenseClass: str(row.license_class),
    qslManager: str(row.qsl_manager),
    lotw: bool(row.lotw),
    eqsl: bool(row.eqsl),
    hamrigUser: hamrigUser && bool(hamrigUser.is_hamrig_user)
      ? {
        username: str(hamrigUser.username),
        verified: bool(hamrigUser.verified) ?? false,
        avatarUrl: absoluteUrl(hamrigUser.avatar_url, baseUrl),
      }
      : null,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Propagation summary
// ---------------------------------------------------------------------------

/** conditions + solar-extended + iono payloads (each optional) → PropagationSummary. */
export function normalizePropagation({ conditions = null, solarExtended = null, iono = null } = {}) {
  const solarData = conditions?.solarData ?? {};
  const ext = solarExtended?.data ?? {};
  const xray = ext.xray ?? null;
  const xrayClass = xray && str(xray.class)
    ? `${str(xray.class)}${str(xray.magnitude) ?? ''}`
    : null;
  const station = iono?.station && typeof iono.station === 'object' ? iono.station : null;
  const stationPosition = station ? coords(station.lat, station.lon) : null;
  const essn = iono?.essn && typeof iono.essn === 'object' ? iono.essn : null;

  const sources = [];
  if (conditions) sources.push('hamrig:propagation-conditions');
  if (solarExtended) sources.push(str(solarExtended.source) ?? 'hamrig:solar-extended');
  if (iono) sources.push(str(iono.source) ?? 'hamrig:iono');

  const updatedIso = toIso(conditions?.updated) ?? toIso(solarExtended?.timestamp) ?? toIso(iono?.updated);

  return {
    solar: {
      sfi: num(solarData.sfi) ?? num(ext.solarflux?.flux) ?? num(essn?.sfi),
      kIndex: num(solarData.kIndex) ?? num(ext.kindex?.kp),
      aIndex: num(solarData.aIndex),
      ssn: num(essn?.ssn),
      xrayClass,
      solarWindKms: num(ext.solarwind?.speed),
      bz: num(ext.bz?.bz),
      auroraKpRequired: num(ext.aurora?.kp_required),
      geomagneticStatus: str(ext.kindex?.status),
    },
    bands: conditions?.conditions && typeof conditions.conditions === 'object' ? { ...conditions.conditions } : {},
    dayNight: conditions?.dayNight && typeof conditions.dayNight === 'object' ? { ...conditions.dayNight } : {},
    ionosonde: {
      nearest: station
        ? {
          name: str(station.name),
          lat: stationPosition?.lat ?? null,
          lon: stationPosition?.lon ?? null,
          mufd: num(station.mufd),
          fof2: num(station.fof2),
          ageMin: num(station.age_min),
          distanceKm: num(station.distance_km),
          highestBand: highestBandForMuf(station.mufd),
        }
        : null,
      essn: essn ? { ssn: num(essn.ssn), sfi: num(essn.sfi), source: str(essn.source) } : null,
    },
    updatedIso,
    sources,
  };
}

// ---------------------------------------------------------------------------
// VHF beacons, DXCC status, worked grids, rotators (login-only feeds)
// ---------------------------------------------------------------------------

/** HamRig `/api/beacons/vhf` payload → VhfBeacon[]. */
export function normalizeVhfBeacons(payload) {
  const rows = Array.isArray(payload?.beacons) ? payload.beacons : Array.isArray(payload) ? payload : [];
  const out = [];
  for (const row of rows) {
    const call = upper(row?.call ?? row?.callsign);
    if (!call) continue;
    const locator = str(row.locator);
    const position = coords(row.lat, row.lon) ?? gridCentre(locator);
    if (!position) continue;
    const freqKhz = num(row.freq_khz);
    const freqHz = freqKhz === null ? parseSpotFrequency(row.frequency, 'auto') : Math.round(freqKhz * 1e3);
    if (freqHz === null) continue;
    const heard = row.last_heard && typeof row.last_heard === 'object' ? row.last_heard : null;
    out.push({
      call,
      freqHz,
      band: str(row.band) ?? bandForHz(freqHz),
      locator,
      lat: position.lat,
      lon: position.lon,
      location: str(row.location),
      lastHeard: heard
        ? { atIso: toIso(heard.at), spotter: str(heard.spotter), snr: num(heard.snr) }
        : null,
    });
  }
  return out;
}

/** HamRig `/api/map/data/dxcc-status` → DxccEntityStatus[]. */
export function normalizeDxccStatus(payload) {
  const rows = Array.isArray(payload?.entities) ? payload.entities : Array.isArray(payload) ? payload : [];
  const out = [];
  for (const row of rows) {
    const name = str(row?.name);
    const position = coords(row?.lat, row?.lon);
    if (!name || !position) continue;
    out.push({
      adif: num(row.adif),
      name,
      prefix: str(row.prefix),
      continent: upper(row.cont ?? row.continent),
      cq: num(row.cqz ?? row.cq),
      lat: position.lat,
      lon: position.lon,
      worked: bool(row.worked) ?? false,
      bands: Array.isArray(row.bands) ? row.bands.map(str).filter(Boolean) : [],
    });
  }
  return out;
}

/** HamRig `/api/map/data/worked-grids` → WorkedGrid[]. */
export function normalizeWorkedGrids(payload) {
  const rows = Array.isArray(payload?.grids) ? payload.grids : Array.isArray(payload) ? payload : [];
  const out = [];
  for (const row of rows) {
    const grid = upper(row?.grid);
    if (!grid) continue;
    const position = coords(row.lat, row.lon) ?? gridCentre(grid);
    if (!position) continue;
    out.push({ grid, qsos: num(row.qsos) ?? 0, lat: position.lat, lon: position.lon });
  }
  return out;
}

function statusFor(statusesById, id) {
  if (!statusesById || id === null || id === undefined) return null;
  if (statusesById instanceof Map) return statusesById.get(id) ?? statusesById.get(String(id)) ?? statusesById.get(Number(id)) ?? null;
  if (typeof statusesById === 'object') return statusesById[id] ?? statusesById[String(id)] ?? null;
  return null;
}

/**
 * HamRig `/api/rotators` list (+ per-id `/status` payloads) → Rotator[].
 * The `gateway_key` secret is never copied.
 */
export function normalizeRotators(list, statusesById = null) {
  const rows = Array.isArray(list) ? list : Array.isArray(list?.rotators) ? list.rotators : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = row.id ?? null;
    if (id === null) continue;
    const live = statusFor(statusesById, id);
    const pick = (key) => (live && live[key] !== undefined && live[key] !== null ? live[key] : row[key]);
    const position = coords(row.location_lat ?? row.lat, row.location_lng ?? row.location_lon ?? row.lon);
    const grid = str(row.location_grid);
    const fallback = position ? null : gridCentre(grid);
    const status = str(pick('status'));
    const online = bool(pick('is_online')) ?? (status ? status === 'online' : null);
    out.push({
      id: typeof id === 'number' ? id : str(id),
      name: str(row.nickname) ?? str(row.name) ?? `Rotator ${id}`,
      model: str(row.model),
      lat: position?.lat ?? fallback?.lat ?? null,
      lon: position?.lon ?? fallback?.lon ?? null,
      grid,
      azimuth: num(pick('current_azimuth')),
      elevation: num(pick('current_elevation')),
      targetAzimuth: num(pick('target_azimuth')),
      isMoving: bool(pick('is_moving')) ?? false,
      status,
      online,
      lastSeenIso: toIso(pick('last_seen_at')),
      bands: Array.isArray(row.bands)
        ? row.bands.map((b) => (b && typeof b === 'object' ? str(b.band) : str(b))).filter(Boolean)
        : [],
    });
  }
  return out;
}
