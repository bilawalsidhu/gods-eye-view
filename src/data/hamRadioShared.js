/**
 * Shared amateur-radio helpers — browser-safe, pure and Cesium-free.
 *
 * Used by the ham layers (`dxSpots`, `hamActivations`, `dxpeditions`,
 * `hamBeacons`, `hamPropagation`, `hamRepeaters`, `hamStations`), the
 * ham-radio panel and the voice handlers. Nothing here touches the DOM,
 * Cesium or Node APIs, and nothing imports from `src/hamrig/` (the server
 * side duplicates the small band table on purpose so both halves stay
 * importable on their own).
 *
 * Geometry is spherical (R = 6371 km): good to a few hundred metres over the
 * distances the ham layers care about, and identical on server and client.
 */

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;
const KM_PER_DEG = EARTH_RADIUS_KM * DEG; // ≈ 111.19 km per degree of arc
const MS_PER_DAY = 86_400_000;

/** Colour per amateur band (spot markers, panel chips, activation lists). */
export const HAM_BAND_COLORS = Object.freeze({
  '160m': '#b46cff',
  '80m': '#7c8cff',
  '60m': '#5fb0ff',
  '40m': '#4fd8e8',
  '30m': '#5ee0a0',
  '20m': '#8be04a',
  '17m': '#d9d84a',
  '15m': '#ffb14a',
  '12m': '#ff8a4a',
  '10m': '#ff5f5f',
  '6m': '#ff5fb4',
  '4m': '#ff8ad9',
  '2m': '#ff7ad9',
  '70cm': '#e0a0ff',
  other: '#9aa4b2',
});

/** Colour per activation program. */
export const PROGRAM_COLORS = Object.freeze({
  POTA: '#4ade80',
  SOTA: '#f97316',
  WWFF: '#22c55e',
  BOTA: '#2dd4bf',
});

/**
 * Amateur allocations (ITU-wide envelope, Hz). Same table as
 * `src/hamrig/normalize.js` — duplicated by design, keep both in sync.
 */
export const HAM_BANDS = Object.freeze([
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

function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? null : String(value).trim().replace(',', '.');
  if (text === '') return null;
  const number = typeof value === 'number' ? value : Number(text);
  return Number.isFinite(number) ? number : null;
}

function normalizeLon(lon) {
  if (lon >= -180 && lon <= 180) return lon;
  let value = ((lon + 180) % 360 + 360) % 360 - 180;
  if (value === -180 && lon > 0) value = 180;
  return value;
}

function latLonOf(point) {
  if (!point || typeof point !== 'object') return null;
  const lat = finiteOrNull(point.lat);
  const lon = finiteOrNull(point.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90) return null;
  return { lat, lon: normalizeLon(lon) };
}

/** Amateur band name ('20m') for a frequency in Hz, or null outside the allocations. */
export function bandForHz(hz) {
  const value = finiteOrNull(hz);
  if (value === null) return null;
  const hit = HAM_BANDS.find((row) => value >= row.lowHz && value <= row.highHz);
  return hit ? hit.band : null;
}

/** Colour for a band name (unknown or null → the neutral "other" colour). */
export function bandColor(band) {
  const key = String(band ?? '').trim().toLowerCase();
  return HAM_BAND_COLORS[key] || HAM_BAND_COLORS.other;
}

/**
 * Human frequency: kHz with one decimal below 30 MHz ("14025.0 kHz"),
 * MHz with three decimals from 30 MHz up ("145.500 MHz").
 * `{ unit: false }` drops the unit suffix for compact map labels ("14025.0").
 */
export function formatHz(hz, { unit = true } = {}) {
  const value = finiteOrNull(hz);
  if (value === null || value <= 0) return '';
  if (value < 30_000_000) {
    const text = (value / 1_000).toFixed(1);
    return unit ? `${text} kHz` : text;
  }
  const text = (value / 1_000_000).toFixed(3);
  return unit ? `${text} MHz` : text;
}

/** Compact age: '20 s', '3 min', '2 h', '4 d'. Empty string when the time is unreadable. */
export function formatAge(timeIso, nowMs = Date.now()) {
  const time = typeof timeIso === 'number' ? timeIso : Date.parse(String(timeIso ?? ''));
  const now = finiteOrNull(nowMs);
  if (!Number.isFinite(time) || now === null) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** Great-circle distance in km between two `{ lat, lon }` objects (NaN when either is unreadable). */
export function distanceKm(a, b) {
  const p = latLonOf(a);
  const q = latLonOf(b);
  if (!p || !q) return NaN;
  const dLat = (q.lat - p.lat) * DEG;
  const dLon = (q.lon - p.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.lat * DEG) * Math.cos(q.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from `a` towards `b`, degrees clockwise from true north (0..360). */
export function initialBearingDeg(a, b) {
  const p = latLonOf(a);
  const q = latLonOf(b);
  if (!p || !q) return NaN;
  const φ1 = p.lat * DEG;
  const φ2 = q.lat * DEG;
  const Δλ = (q.lon - p.lon) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Point reached after travelling `distanceKm` along `bearingDeg` from `origin` (spherical). */
export function destinationPoint(origin, bearingDeg, distanceKm) {
  const p = latLonOf(origin);
  const bearing = finiteOrNull(bearingDeg);
  const distance = finiteOrNull(distanceKm);
  if (!p || bearing === null || distance === null) return null;
  const δ = distance / EARTH_RADIUS_KM;
  const θ = bearing * DEG;
  const φ1 = p.lat * DEG;
  const λ1 = p.lon * DEG;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.max(-1, Math.min(1, sinφ2)));
  const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return { lat: φ2 / DEG, lon: normalizeLon(λ2 / DEG) };
}

/**
 * Split a polyline where it crosses the antimeridian. Each crossing ends the
 * current segment at ±180 and starts the next one at ∓180 (latitude linearly
 * interpolated), so Cesium never draws a line the long way round the globe.
 */
export function splitAtDateline(points) {
  const segments = [];
  let current = [];
  const rows = Array.isArray(points) ? points.map(latLonOf).filter(Boolean) : [];
  for (let index = 0; index < rows.length; index += 1) {
    const point = rows[index];
    if (current.length) {
      const previous = current[current.length - 1];
      const delta = point.lon - previous.lon;
      if (Math.abs(delta) > 180) {
        const unwrapped = delta > 0 ? point.lon - 360 : point.lon + 360;
        const edge = previous.lon >= 0 ? 180 : -180;
        const span = unwrapped - previous.lon;
        const t = span === 0 ? 0 : (edge - previous.lon) / span;
        const lat = previous.lat + (point.lat - previous.lat) * Math.max(0, Math.min(1, t));
        current.push({ lat, lon: edge });
        segments.push(current);
        current = [{ lat, lon: -edge }];
      }
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

function toVector({ lat, lon }) {
  const φ = lat * DEG;
  const λ = lon * DEG;
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}

function fromVector([x, y, z]) {
  return { lat: Math.atan2(z, Math.hypot(x, y)) / DEG, lon: normalizeLon(Math.atan2(y, x) / DEG) };
}

/**
 * Great-circle path from `a` to `b` by spherical linear interpolation.
 * Returns an ARRAY OF SEGMENTS (`[[{lat,lon}, …], …]`): one segment normally,
 * two when the path crosses the antimeridian. Empty array on bad input.
 */
export function greatCirclePoints(a, b, segments = 64) {
  const p = latLonOf(a);
  const q = latLonOf(b);
  if (!p || !q) return [];
  const steps = Math.max(1, Math.min(2048, Math.round(finiteOrNull(segments) ?? 64)));
  const u = toVector(p);
  let v = toVector(q);
  let dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  let ω = Math.acos(dot);
  if (ω < 1e-9) return splitAtDateline([p, q]);
  if (Math.PI - ω < 1e-6) {
    // Antipodal: every great circle works — route over the pole nearest `a`.
    const detour = destinationPoint(p, 0, EARTH_RADIUS_KM * Math.PI / 2);
    v = toVector(detour);
    dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
    ω = Math.acos(dot);
    const first = greatCirclePoints(p, detour, Math.ceil(steps / 2)).flat();
    const second = greatCirclePoints(detour, q, Math.ceil(steps / 2)).flat();
    return splitAtDateline([...first, ...second.slice(1)]);
  }
  const sinω = Math.sin(ω);
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const s1 = Math.sin((1 - t) * ω) / sinω;
    const s2 = Math.sin(t * ω) / sinω;
    points.push(fromVector([u[0] * s1 + v[0] * s2, u[1] * s1 + v[1] * s2, u[2] * s1 + v[2] * s2]));
  }
  points[0] = p;
  points[points.length - 1] = q;
  return splitAtDateline(points);
}

/**
 * Sub-solar point (where the sun is at the zenith) for an instant.
 * NOAA / Meeus low-precision solar position: mean anomaly, true ecliptic
 * longitude, obliquity of the ecliptic → declination; the equation of time
 * (minutes) shifts the longitude off the plain UTC-hour-angle value.
 * Accuracy is better than 0.1° for the current century.
 */
export function subsolarPoint(dateMs = Date.now()) {
  const ms = finiteOrNull(dateMs);
  if (ms === null) return null;
  const jd = ms / MS_PER_DAY + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const meanLongitude = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
  const meanAnomaly = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const eccentricity = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const M = meanAnomaly * DEG;
  const centre = Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * M) * 0.000289;
  const trueLongitude = meanLongitude + centre;
  const omega = (125.04 - 1934.136 * T) * DEG;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega);
  const meanObliquity = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude * DEG)) / DEG;
  const y = Math.tan(obliquity / 2) ** 2;
  const L0 = meanLongitude * DEG;
  const equationOfTime = 4 * (
    y * Math.sin(2 * L0)
    - 2 * eccentricity * Math.sin(M)
    + 4 * eccentricity * y * Math.sin(M) * Math.cos(2 * L0)
    - 0.5 * y * y * Math.sin(4 * L0)
    - 1.25 * eccentricity * eccentricity * Math.sin(2 * M)
  ) / DEG;
  const utcHours = (((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / 3_600_000;
  const lon = normalizeLon(-15 * (utcHours + equationOfTime / 60 - 12));
  return { lat: declination, lon, equationOfTimeMin: equationOfTime };
}

/**
 * Ring of constant angular distance from the sub-solar point, walked with
 * `destinationPoint` over bearings 0..360, split at the antimeridian.
 * 90° = the sunrise/sunset terminator; 102° = end of nautical twilight;
 * 96° civil, 108° astronomical. Returns an array of segments.
 */
export function terminatorRing(dateMs = Date.now(), angularDistanceDeg = 90, samples = 180) {
  const sun = subsolarPoint(dateMs);
  const angle = finiteOrNull(angularDistanceDeg);
  if (!sun || angle === null) return [];
  const count = Math.max(8, Math.min(2000, Math.round(finiteOrNull(samples) ?? 180)));
  const radiusKm = angle * KM_PER_DEG;
  const points = [];
  for (let index = 0; index <= count; index += 1) {
    const bearing = (360 * index) / count;
    const point = destinationPoint(sun, bearing, radiusKm);
    if (point) points.push(point);
  }
  return splitAtDateline(points);
}

const DIGITAL_MODES = new Set(['FT8', 'FT4', 'RTTY', 'PSK', 'PSK31', 'PSK63', 'JS8', 'WSPR', 'MSK144', 'Q65', 'JT65', 'JT9', 'DIGI', 'SSTV', 'OLIVIA', 'HELL', 'MFSK']);

/**
 * Demodulator a web receiver should use for a spot.
 * digital/RTTY/PSK → usb; CW/BEACON → cw; AM → am; FM → nfm;
 * SSB (or unknown) → usb at or above 10 MHz and on 60 m (5.25–5.45 MHz, USB-only
 * by regulation), lsb below. `spot` carries `mode` and `freqHz` (or `hz`).
 */
export function receiverModeForSpot(spot) {
  const mode = String(spot?.mode ?? '').trim().toUpperCase();
  const hz = finiteOrNull(spot?.freqHz ?? spot?.hz);
  if (mode === 'CW' || mode === 'BEACON') return 'cw';
  if (mode === 'AM') return 'am';
  if (mode === 'FM' || mode === 'NFM') return 'nfm';
  if (DIGITAL_MODES.has(mode)) return 'usb';
  if (mode === 'USB') return 'usb';
  if (mode === 'LSB') return 'lsb';
  if (hz === null) return 'usb';
  if (hz >= 10_000_000) return 'usb';
  if (hz >= 5_250_000 && hz <= 5_450_000) return 'usb';
  return 'lsb';
}
