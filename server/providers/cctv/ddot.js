import {
  DDOT_CCTV_FEATURE_QUERY_URL,
  DEFAULT_DDOT_MAX_SOURCES,
  DC_CENTER,
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
} from './constants.js';
import {
  toFiniteNumber,
  fallbackHeadingFromId,
  prioritizeSources,
  isPlausibleLatLon,
} from './normalize.js';

/**
 * Rough DC / immediate metro bounding box for GIS sanity checks.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isLikelyDcCoordinate(lat, lon) {
  return lat >= 38.79 && lat <= 39.0 && lon >= -77.15 && lon <= -76.9;
}

/**
 * Stable catalog id for a DDOT GIS camera record.
 *
 * @param {number|string} cameraId
 * @returns {?string}
 */
export function ddotCatalogId(cameraId) {
  const id = String(cameraId ?? '').trim();
  if (!id) return null;
  return `ddot:${id}`;
}

/**
 * Map one DDOT TrafficOperations FeatureServer row to a location-only source.
 * DC GIS publishes coordinates and metadata only — no official public live
 * media URL is registered here.
 *
 * @param {object} feature
 * @returns {object|null}
 */
export function ddotFeatureToSource(feature) {
  const attrs = feature?.attributes || feature?.properties || feature || {};
  const cameraId = attrs.CameraID ?? attrs.CAMERAID ?? attrs.cameraId;
  const catalogId = ddotCatalogId(cameraId);
  if (!catalogId) return null;

  const status = Number(attrs.Operation_Status ?? attrs.operation_status);
  if (Number.isFinite(status) && status !== 1) return null;

  let lat = toFiniteNumber(attrs.Latitude ?? attrs.latitude);
  let lon = toFiniteNumber(attrs.Longitude ?? attrs.longitude);
  const geom = feature?.geometry;
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && geom) {
    lat = toFiniteNumber(geom.y ?? geom.latitude);
    lon = toFiniteNumber(geom.x ?? geom.longitude);
  }
  if (!isPlausibleLatLon(lat, lon) || !isLikelyDcCoordinate(lat, lon)) {
    return null;
  }

  const location = String(attrs.Location || attrs.location || '').trim();
  const description = String(
    attrs.Description || attrs.description || '',
  ).trim();
  const label = location || description || `DDOT Camera ${cameraId}`;

  return {
    id: catalogId,
    name: label,
    city: 'Washington, DC',
    cityId: 'washington-dc',
    provider: 'District Department of Transportation / DC GIS',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(catalogId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    groundElevationM: 20,
    feedType: 'image',
    url: '',
    sourceKind: 'ddot-gis-location-only',
    license:
      'DDOT TrafficOperations CCTV locations — DC GIS (locations only; no public live media URL)',
    credit: 'District Department of Transportation / DC GIS',
    code: String(cameraId),
  };
}

/**
 * Fetch DDOT CCTV locations from the official DC GIS FeatureServer layer.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadDdotSourcesFromGis() {
  try {
    const resp = await fetch(DDOT_CCTV_FEATURE_QUERY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] DDOT GIS download failed:', resp.status);
      return [];
    }
    const payload = await resp.json();
    const features = Array.isArray(payload?.features) ? payload.features : [];
    const byId = new Map();
    for (const feature of features) {
      const source = ddotFeatureToSource(feature);
      if (!source) continue;
      byId.set(source.id, source);
    }
    const cameras = [...byId.values()];
    const maxRaw = Number(
      process.env.CCTV_DDOT_MAX_SOURCES || DEFAULT_DDOT_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(400, Math.floor(maxRaw)))
      : DEFAULT_DDOT_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, [DC_CENTER]);
    console.log(
      `[CCTV] Loaded DDOT GIS camera locations: ${cameras.length} active (using nearest ${prioritized.length}, location-only)`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] DDOT GIS download error:', error?.message || error);
    return [];
  }
}
