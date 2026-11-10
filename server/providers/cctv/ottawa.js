import {
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
  DEFAULT_OTTAWA_MAX_SOURCES,
  OTTAWA_ANCHORS,
  OTTAWA_API_USER_ID,
  OTTAWA_CAMERAS_URL,
  OTTAWA_FRAME_REFRESH_MS,
  OTTAWA_IMAGE_ORIGIN,
  OTTAWA_IMAGE_URL,
} from './constants.js';
import {
  fallbackHeadingFromId,
  pinnedCameraUrl,
  prioritizeSources,
  toFiniteNumber,
} from './normalize.js';

let ottawaCertificateMissingLogged = false;

/** Test hook: let the next missing-certificate skip log again. */
export function _resetOttawaCertificateWarningForTest() {
  ottawaCertificateMissingLogged = false;
}

/** The operator's Traffic Camera Images API certificate, trimmed. */
function ottawaCertificate(env = process.env) {
  return String(env.OTTAWA_CAMERA_CERTIFICATE ?? '').trim();
}

/**
 * Add the operator's certificate to a registered keyless Ottawa frame URL.
 * Only a URL inside the pinned `/opendata/` directory with a numeric camera
 * number is signed, so the certificate never goes to any other path or host.
 *
 * @param {string} url - Canonical frame URL from the catalog.
 * @param {Record<string,string|undefined>} [env]
 * @returns {string} The signed URL, or '' when there is no certificate or the
 *   URL is not a registered Ottawa frame.
 */
export function ottawaAuthorizedFrameUrl(url, env = process.env) {
  const certificate = ottawaCertificate(env);
  const pinned = pinnedCameraUrl(url, OTTAWA_IMAGE_ORIGIN);
  if (!certificate || !pinned) return '';
  const parsed = new URL(pinned);
  const cameraNumber = parsed.searchParams.get('c') || '';
  if (parsed.pathname !== '/opendata/camera' || !/^\d+$/.test(cameraNumber))
    return '';
  const signed = new URL(OTTAWA_IMAGE_URL(cameraNumber));
  signed.searchParams.set('certificate', certificate);
  signed.searchParams.set('id', OTTAWA_API_USER_ID);
  return signed.href;
}

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
 * Load the City of Ottawa's traffic cameras.
 *
 * Camera images come from the city's Traffic Camera Images API, which needs a
 * certificate from the city's registration form (OTTAWA_CAMERA_CERTIFICATE)
 * and allows one fetch per camera per minute for a certificate and user id.
 * Without a certificate the pack is skipped, with no request and one log line.
 * The camera list is the documented `map/service/camera` JSON: a camera
 * number, English and French names, coordinates and the owner (CITY or MTO).
 * The feed carries no bearing, no elevation and no status field, so headings
 * use the same deterministic low-confidence fallback as the other
 * heading-less packs and the client's ground snap refines the elevation
 * prior.
 *
 * @param {object} [_options]
 * @param {Record<string,string|undefined>} [env]
 * @returns {Promise<Array<object>>} Cameras nearest downtown first, or [] on
 *   a missing certificate or any upstream or payload failure.
 */
export async function loadOttawaSourcesFromOpenData(
  _options = {},
  env = process.env,
) {
  if (!ottawaCertificate(env)) {
    if (!ottawaCertificateMissingLogged) {
      ottawaCertificateMissingLogged = true;
      console.warn(
        '[CCTV] Ottawa cameras skipped: the city camera image API needs a certificate (set OTTAWA_CAMERA_CERTIFICATE)',
      );
    }
    return [];
  }
  try {
    const resp = await fetch(OTTAWA_CAMERAS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] Ottawa camera download failed:', resp.status);
      return [];
    }
    const payload = await resp.json();
    const rows = Array.isArray(payload?.cameras) ? payload.cameras : null;
    if (!rows) return [];

    const cameras = [];
    const seen = new Set();
    for (const row of rows) {
      const number = toFiniteNumber(row?.camera_number);
      if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number))
        continue;
      const lat = toFiniteNumber(row?.latitude);
      const lon = toFiniteNumber(row?.longitude);
      if (!isOttawaCoordinate(lat, lon)) continue;
      seen.add(number);

      const cameraId = `ottawa-${number}`;
      const imageUrl = OTTAWA_IMAGE_URL(number);
      // The docs name the field camera_owner; the live feed sends cameraOwner.
      const owner = String(row?.camera_owner || row?.cameraOwner || '')
        .trim()
        .toUpperCase();
      cameras.push({
        id: cameraId,
        name: String(row?.name || '').trim() || `Ottawa camera ${number}`,
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
        frameRefreshMs: OTTAWA_FRAME_REFRESH_MS,
        sourceKind: 'ottawa-traffic',
        license: 'City of Ottawa Traffic Camera Images API (registered access)',
        credit:
          owner === 'MTO'
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
