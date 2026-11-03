import {
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
  DEFAULT_OTTAWA_MAX_SOURCES,
  OTTAWA_ANCHORS,
  OTTAWA_CAMERAS_URL,
  OTTAWA_IMAGE_URL,
} from './constants.js';
import {
  fallbackHeadingFromId,
  prioritizeSources,
  toFiniteNumber,
} from './normalize.js';

/**
 * City of Ottawa envelope: Kanata to Orléans, Barrhaven to the river, with
 * slack for the MTO cameras on the 416/417 that the city feed also carries.
 */
const OTTAWA_BOUNDS = Object.freeze({
  minLat: 45.1,
  maxLat: 45.65,
  minLon: -76.2,
  maxLon: -75.1,
});

/** Whether a point is inside the city feed's service area. */
function isOttawaCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= OTTAWA_BOUNDS.minLat &&
    lat <= OTTAWA_BOUNDS.maxLat &&
    lon >= OTTAWA_BOUNDS.minLon &&
    lon <= OTTAWA_BOUNDS.maxLon
  );
}

/**
 * Load the City of Ottawa's public traffic camera list.
 *
 * The keyless `camera_list` JSON publishes an id, coordinates, an English and
 * French description, and a `type`; frames are JPEG stills built from the id
 * on the city's own image path. The feed carries no bearing, no elevation and
 * no status field, so headings use the same deterministic low-confidence
 * fallback as the other heading-less packs and the client's ground snap
 * refines the elevation prior.
 *
 * @returns {Promise<Array<object>>} Cameras nearest downtown first, or [] on
 *   any upstream or payload failure.
 */
export async function loadOttawaSourcesFromOpenData() {
  try {
    const resp = await fetch(OTTAWA_CAMERAS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] Ottawa camera download failed:', resp.status);
      return [];
    }
    const rows = await resp.json();
    if (!Array.isArray(rows)) return [];

    const cameras = [];
    for (const row of rows) {
      const id = toFiniteNumber(row?.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const lat = toFiniteNumber(row?.latitude);
      const lon = toFiniteNumber(row?.longitude);
      if (!isOttawaCoordinate(lat, lon)) continue;

      const cameraId = `ottawa-${id}`;
      const imageUrl = OTTAWA_IMAGE_URL(id);
      const type = String(row?.type || '').trim();
      cameras.push({
        id: cameraId,
        name: String(row?.description || '').trim() || `Ottawa camera ${id}`,
        city: 'Ottawa',
        cityId: 'ottawa',
        provider: 'City of Ottawa',
        lat,
        lon,
        headingDeg: fallbackHeadingFromId(cameraId),
        headingConfidence: 'low',
        pitchDeg: -18,
        fovDeg: 44,
        rangeM: 145,
        mountHeightM: 8,
        groundElevationM: 0,
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'ottawa-traffic',
        license: 'City of Ottawa public traffic camera feed',
        credit:
          type === 'MTO'
            ? 'Ministry of Transportation of Ontario (MTO) camera'
            : '',
      });
    }

    const maxRaw = Number(
      process.env.CCTV_OTTAWA_MAX_SOURCES || DEFAULT_OTTAWA_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(500, Math.floor(maxRaw)))
      : DEFAULT_OTTAWA_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, OTTAWA_ANCHORS);
    console.log(
      `[CCTV] Loaded Ottawa camera sources: ${cameras.length} published (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Ottawa camera download error:',
      error?.message || error,
    );
    return [];
  }
}
