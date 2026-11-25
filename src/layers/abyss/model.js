/**
 * Domain constants, color scales, and formatting helpers for the ABYSS deep-sea layer.
 * Pure logic: no DOM or Cesium dependencies so it runs in tests and Node.
 */

export const ABYSS_LAYER_ID = 'abyss';
export const ABYSS_OVERLAY_SOURCE_ID = 'abyss-overlay';

export const FEATURE_KINDS = Object.freeze({
  VENT: 'vent',
  DIVE: 'dive',
  BATHYMETRY: 'bathymetry',
});

export const VENT_ACTIVITIES = Object.freeze({
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  UNCONFIRMED: 'unconfirmed',
});

export const BATHYMETRY_PRODUCTS = Object.freeze({
  COLOUR_SHADED: 'GEBCO_LATEST_2',
  SHADED_RELIEF: 'GEBCO_LATEST',
  TID_GRID: 'GEBCO_LATEST_TID',
});

/** Color tokens for deep-sea features (RGBA arrays / CSS hex) */
export const ABYSS_COLORS = Object.freeze({
  VENT_ACTIVE: '#ff6b35', // Volcanic thermal amber-orange
  VENT_INACTIVE: '#4ecdc4', // Relict mineralized slate-cyan
  VENT_UNCONFIRMED: '#f9c74f', // Inferred / unconfirmed yellow
  DIVE_MARKER: '#00d2ff', // Deep Discoverer electric cyan
  DIVE_TRACK: '#00ffff', // High-visibility subsea polyline
  SELECTION_HIGHLIGHT: '#ffffff', // Focused entity ring
});

/** Bathymetric depth color scale stops (depth in meters: 0 to -11,000m) */
export const BATHYMETRY_STOPS = Object.freeze([
  { depth: 0, color: '#0077b6', label: '0 m (Shelf)' }, // i18n-ignore: scientific depth label
  { depth: -200, color: '#0096c7', label: '-200 m (Sunlight)' }, // i18n-ignore: scientific depth label
  { depth: -1000, color: '#03045e', label: '-1,000 m (Twilight)' }, // i18n-ignore: scientific depth label
  { depth: -4000, color: '#023e8a', label: '-4,000 m (Abyss)' }, // i18n-ignore: scientific depth label
  { depth: -6000, color: '#001845', label: '-6,000 m (Abyssal Plain)' }, // i18n-ignore: scientific depth label
  { depth: -11000, color: '#000814', label: '-11,000 m (Hadal Trench)' }, // i18n-ignore: scientific depth label
]);

/**
 * Format depth in meters with optional feet conversion.
 * @param {number|null} depthM - Depth in meters (positive or negative number).
 * @param {{ includeFeet?: boolean }} [options]
 * @returns {string} Formatted depth string or 'Depth unavailable'.
 */
export function formatDepth(depthM, { includeFeet = true } = {}) {
  if (
    depthM === null ||
    depthM === undefined ||
    !Number.isFinite(Number(depthM))
  ) {
    return 'Depth unavailable';
  }
  const meters = Math.abs(Math.round(Number(depthM)));
  const metersStr = `${meters.toLocaleString('en-US')} m`;
  if (!includeFeet) return metersStr;
  const feet = Math.round(meters * 3.28084);
  return `${metersStr} (${feet.toLocaleString('en-US')} ft)`;
}

/**
 * Format geographic coordinates cleanly in hemisphere notation.
 * @param {number} lon
 * @param {number} lat
 * @returns {string} e.g. "19.9024°N, 156.7575°W"
 */
export function formatCoordinates(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return '--';
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
}

/**
 * Map vent activity classification to presentation label.
 * @param {string} activity
 * @returns {string}
 */
export function formatVentActivity(activity) {
  const norm = String(activity || '')
    .trim()
    .toLowerCase();
  switch (norm) {
    case 'active':
      return 'Active Hydrothermal Field';
    case 'inactive':
      return 'Inactive / Relict Field';
    case 'unconfirmed':
      return 'Inferred / Unconfirmed';
    default:
      return 'Classification Pending';
  }
}

/**
 * Get distinct color for a hydrothermal vent by activity status.
 * @param {string} activity
 * @returns {string} Hex color
 */
export function ventColor(activity) {
  const norm = String(activity || '')
    .trim()
    .toLowerCase();
  if (norm === 'active') return ABYSS_COLORS.VENT_ACTIVE;
  if (norm === 'inactive') return ABYSS_COLORS.VENT_INACTIVE;
  return ABYSS_COLORS.VENT_UNCONFIRMED;
}
