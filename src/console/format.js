/**
 * Readout formatting for the operations console.
 *
 * Every function here is total: telemetry arrives from a live scene that can
 * report `undefined`, `NaN` or an out-of-range angle during a camera flight,
 * and a readout that throws would take the whole chrome down with it. Each one
 * answers with the placeholder instead.
 */

const PLACEHOLDER = '--';

/** Whether a value can be rendered as a number at all. */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Fold an angle into [0, 360). */
export function normalizeBearing(degrees) {
  if (!finite(degrees)) return null;
  return ((degrees % 360) + 360) % 360;
}

/** Signed decimal degrees as a hemisphere-suffixed readout. */
export function formatLatitude(degrees, fractionDigits = 4) {
  if (!finite(degrees) || Math.abs(degrees) > 90) return PLACEHOLDER;
  const hemisphere = degrees >= 0 ? 'N' : 'S';
  return `${Math.abs(degrees).toFixed(fractionDigits)}°${hemisphere}`;
}

/** Signed decimal degrees as a hemisphere-suffixed readout. */
export function formatLongitude(degrees, fractionDigits = 4) {
  if (!finite(degrees) || Math.abs(degrees) > 180) return PLACEHOLDER;
  const hemisphere = degrees >= 0 ? 'E' : 'W';
  return `${Math.abs(degrees).toFixed(fractionDigits)}°${hemisphere}`;
}

/**
 * Camera height, scaled to the unit an operator reads at that altitude.
 * Sub-kilometre heights stay in metres; orbital ones collapse to megametres
 * so the field never outgrows its column.
 */
export function formatElevation(metres) {
  if (!finite(metres)) return PLACEHOLDER;
  const magnitude = Math.abs(metres);
  if (magnitude < 1000) return `${Math.round(metres)} m`;
  if (magnitude < 1_000_000) return `${(metres / 1000).toFixed(1)} km`;
  return `${(metres / 1_000_000).toFixed(2)} Mm`;
}

/** Compass bearing, zero-padded so the column never reflows. */
export function formatBearing(degrees) {
  const bearing = normalizeBearing(degrees);
  if (bearing === null) return PLACEHOLDER;
  return `${String(Math.round(bearing) % 360).padStart(3, '0')}°`;
}

/** Camera pitch, signed, where negative reads as looking down. */
export function formatPitch(degrees) {
  if (!finite(degrees)) return PLACEHOLDER;
  const rounded = Math.round(degrees);
  return `${rounded > 0 ? '+' : ''}${rounded}°`;
}

/** The eight-point compass rose letter for a bearing. */
export function compassPoint(degrees) {
  const bearing = normalizeBearing(degrees);
  if (bearing === null) return PLACEHOLDER;
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(bearing / 45) % 8];
}

/**
 * Military Grid Reference for a position, at 10 m precision.
 *
 * The projection is injected rather than imported: `mgrs` ships a CommonJS
 * entry with an ESM build beside it, and the two disagree about which exports
 * exist, so a direct import would bind these formatters to one runtime.
 * `src/console/grid.js` supplies the real projector; the guards and the
 * spacing live here, where they are testable.
 *
 * The projection is undefined beyond the UTM latitude bands, and the library
 * throws there, so the poles read as the placeholder rather than an error.
 *
 * @param {number} latitude Degrees north.
 * @param {number} longitude Degrees east.
 * @param {(longitude:number, latitude:number) => string} project Projector.
 * @returns {string} A spaced grid reference, or the placeholder.
 */
export function formatGridReference(latitude, longitude, project) {
  if (!finite(latitude) || !finite(longitude)) return PLACEHOLDER;
  if (Math.abs(latitude) > 84) return PLACEHOLDER;
  if (typeof project !== 'function') return PLACEHOLDER;
  let raw;
  try {
    raw = project(longitude, latitude);
  } catch {
    return PLACEHOLDER;
  }
  const match = /^(\d{1,2}[A-Z])\s*([A-Z]{2})\s*(\d+)$/.exec(raw || '');
  if (!match) return raw || PLACEHOLDER;
  const [, zone, square, digits] = match;
  const half = digits.length / 2;
  return `${zone} ${square} ${digits.slice(0, half)} ${digits.slice(half)}`;
}

/** Record counts, abbreviated so a busy feed stays one column wide. */
export function formatCount(value) {
  if (!finite(value)) return PLACEHOLDER;
  const count = Math.round(value);
  if (Math.abs(count) < 1000) return String(count);
  if (Math.abs(count) < 1_000_000)
    return `${(count / 1000).toFixed(count % 1000 === 0 ? 0 : 1)}K`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Elapsed milliseconds as a single coarse unit. */
export function formatAge(milliseconds) {
  if (!finite(milliseconds) || milliseconds < 0) return PLACEHOLDER;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** Zero-padded UTC wall clock. */
export function formatUtcTime(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()))
    return '--:--:--';
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** ISO calendar date, marked with the zone the clock above it runs on. */
export function formatUtcDate(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'UTC';
  return `${date.toISOString().slice(0, 10)} UTC`;
}

/** Title-case a layer identifier when the catalog offers no display name. */
export function titleizeIdentifier(value) {
  return String(value || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export { PLACEHOLDER };
