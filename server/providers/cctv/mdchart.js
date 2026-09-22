import {
  MDCHART_CAMERAS_URL,
  MDCHART_STREAM_HOST_PATTERN,
  DEFAULT_MDCHART_MAX_SOURCES,
  MDCHART_ANCHORS,
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
} from './constants.js';
import {
  toFiniteNumber,
  fallbackHeadingFromId,
  prioritizeSources,
  isPlausibleLatLon,
} from './normalize.js';

/** Operational statuses treated as out of service for live feeds. */
export const MDCHART_EXCLUDED_OP_STATUS = new Set([
  'COMM_FAILURE',
  'HARDWARE_FAILURE',
]);

/** Communication modes that indicate the camera is not serving public video. */
export const MDCHART_EXCLUDED_COMM_MODE = new Set(['OFFLINE', 'MAINT_MODE']);

/**
 * Build the official CHART HLS playlist URL from feed fields.
 * Only strmr*.sha.maryland.gov hosts are accepted — never chart.maryland.gov
 * HTML player pages.
 *
 * @param {string} cctvIp
 * @param {string} cameraId
 * @returns {?string}
 */
export function mdchartHlsUrl(cctvIp, cameraId) {
  const host = String(cctvIp || '')
    .trim()
    .toLowerCase();
  const id = String(cameraId || '').trim();
  if (!id || !MDCHART_STREAM_HOST_PATTERN.test(host)) return null;
  return `https://${host}/rtplive/${encodeURIComponent(id)}/playlist.m3u8`;
}

/**
 * Rough Maryland bounding box sanity check (statewide catalog).
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isLikelyMarylandCoordinate(lat, lon) {
  return lat >= 37.7 && lat <= 39.9 && lon >= -79.7 && lon <= -74.8;
}

/**
 * Human-readable route prefix from CHART routePrefix token.
 *
 * @param {string} routePrefix
 * @param {number|string} routeNumber
 * @param {string} routeSuffix
 * @returns {string}
 */
export function mdchartRouteLabel(routePrefix, routeNumber, routeSuffix) {
  const prefix = String(routePrefix || '')
    .trim()
    .toUpperCase();
  const num = String(routeNumber ?? '').trim();
  const suffix = String(routeSuffix || '').trim();
  let head = '';
  if (prefix === 'IS') head = `I-${num}`;
  else if (prefix === 'US') head = `US ${num}`;
  else if (prefix === 'MD') head = `MD ${num}`;
  else if (num) head = `${prefix} ${num}`.trim();
  return suffix ? `${head} ${suffix}`.trim() : head;
}

/**
 * Display label for one CHART camera row.
 *
 * @param {object} row
 * @returns {string}
 */
export function mdchartCameraLabel(row) {
  const description = String(row?.description || '').trim();
  if (description) return description;
  const route = mdchartRouteLabel(
    row?.routePrefix,
    row?.routeNumber,
    row?.routeSuffix,
  );
  const name = String(row?.name || '').trim();
  if (route && name) return `${route} — ${name}`;
  return route || name || 'Maryland CHART camera';
}

/**
 * Region label from cameraCategories (first entry).
 *
 * @param {object} row
 * @returns {string}
 */
export function mdchartRegionLabel(row) {
  const categories = Array.isArray(row?.cameraCategories)
    ? row.cameraCategories
    : [];
  const first = String(categories[0] || '').trim();
  return first || 'Maryland';
}

/**
 * Stable catalog id for a CHART camera.
 *
 * @param {string} cameraId
 * @returns {?string}
 */
export function mdchartCatalogId(cameraId) {
  const id = String(cameraId || '').trim();
  if (!id) return null;
  return `mdchart:${id}`;
}

/**
 * Map one CHART JSON row to a normalized catalog source, or null when unusable.
 *
 * @param {object} row
 * @returns {object|null}
 */
export function mdchartRowToSource(row) {
  const cameraId = String(row?.id || '').trim();
  const catalogId = mdchartCatalogId(cameraId);
  if (!catalogId) return null;

  const opStatus = String(row?.opStatus || '')
    .trim()
    .toUpperCase();
  if (MDCHART_EXCLUDED_OP_STATUS.has(opStatus)) return null;

  const commMode = String(row?.commMode || '')
    .trim()
    .toUpperCase();
  if (MDCHART_EXCLUDED_COMM_MODE.has(commMode)) return null;

  const lat = toFiniteNumber(row?.lat);
  const lon = toFiniteNumber(row?.lon);
  if (!isPlausibleLatLon(lat, lon) || !isLikelyMarylandCoordinate(lat, lon)) {
    return null;
  }

  const streamUrl = mdchartHlsUrl(row?.cctvIp, cameraId);
  if (!streamUrl) return null;

  const region = mdchartRegionLabel(row);
  const label = mdchartCameraLabel(row);

  return {
    id: catalogId,
    name: label,
    city: region,
    cityId: region.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    provider: 'Maryland Department of Transportation / CHART',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(catalogId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    groundElevationM: 80,
    feedType: 'hls',
    url: streamUrl,
    sourceKind: 'mdchart-open-data',
    license:
      'Maryland CHART live traffic cameras — public data feed (chart.maryland.gov)',
    credit: 'Maryland Department of Transportation / CHART',
    code: cameraId.slice(0, 12),
  };
}

/**
 * Fetch the statewide Maryland CHART camera catalog.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadMdchartSourcesFromOpenData() {
  try {
    const resp = await fetch(MDCHART_CAMERAS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] Maryland CHART download failed:', resp.status);
      return [];
    }
    const payload = await resp.json();
    const rows = Array.isArray(payload) ? payload : [];
    const byId = new Map();
    for (const row of rows) {
      const source = mdchartRowToSource(row);
      if (!source) continue;
      byId.set(source.id, source);
    }
    const cameras = [...byId.values()];
    const maxRaw = Number(
      process.env.CCTV_MDCHART_MAX_SOURCES || DEFAULT_MDCHART_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(900, Math.floor(maxRaw)))
      : DEFAULT_MDCHART_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, MDCHART_ANCHORS);
    console.log(
      `[CCTV] Loaded Maryland CHART camera sources: ${cameras.length} live (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Maryland CHART download error:',
      error?.message || error,
    );
    return [];
  }
}
