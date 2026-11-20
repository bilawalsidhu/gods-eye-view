import {
  CCTV_SOURCE_FETCH_TIMEOUT_MS,
  DEFAULT_SINGAPORE_MAX_SOURCES,
  SINGAPORE_ANCHORS,
  SINGAPORE_FRAME_LINK_REFRESH_MS,
  SINGAPORE_FRAME_LINK_TIMEOUT_MS,
  SINGAPORE_IMAGE_ORIGIN,
  SINGAPORE_MAX_CATALOG_BYTES,
  SINGAPORE_TRAFFIC_IMAGES_URL,
} from './constants.js';
import {
  cameraDisplayCode,
  fallbackHeadingFromId,
  isLikelySingaporeCoordinate,
  pinnedCameraUrl,
  prioritizeSources,
  toFiniteNumber,
} from './normalize.js';
import { readResponseJsonCapped } from '../common/http.js';

/** The licence that the attribution notice must link to. */
export const SINGAPORE_OPEN_DATA_LICENCE_URL =
  'https://data.gov.sg/open-data-licence';

/** The `sourceKind` the frame proxy uses to resolve the current frame link. */
export const SINGAPORE_SOURCE_KIND = 'singapore-traffic-images';

/**
 * Camera names. The API gives an id and a point for each camera, but no name.
 *
 * Evidence: LTA's OneMotoring traffic camera page
 * (https://onemotoring.lta.gov.sg/content/onemotoring/home/driving/traffic_information/traffic-cameras.html,
 * read on 2026-11-11) shows one card for each camera. The card image is
 * `https://datamall.lta.gov.sg/trafficsmart/images/<camera id>_<...>.jpg`, and
 * the card heading and image alt text are "View from <place>". Each key below
 * is that file-name prefix, and each name is that caption without "View from".
 * The API puts 2701, 2702 and 2704 in Woodlands, 4703, 4712 and 4713 in Tuas,
 * and 4798 and 4799 at Sentosa Gateway, which agrees with the page's three
 * tabs. The direction text in a name is not a bearing.
 */
const SINGAPORE_CAMERA_NAMES = Object.freeze({
  2701: 'Woodlands Causeway (Towards Johor)',
  2702: 'Woodlands Checkpoint (Towards BKE)',
  2704: 'Woodlands Flyover (Towards Checkpoint)',
  4703: 'Second Link at Tuas',
  4712: 'After Tuas West Road',
  4713: 'Tuas Checkpoint',
  4798: 'Sentosa Gateway (Towards Telok Blangah)',
  4799: 'Sentosa Gateway (Towards Sentosa)',
});

/**
 * The attribution notice the Singapore Open Data Licence asks for, with the
 * date of access.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function singaporeTrafficImagesNotice(date = new Date()) {
  const day = Number.isFinite(date?.getTime?.())
    ? date.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return (
    `Contains information from Traffic Images accessed on ${day} from data.gov.sg ` +
    'which is made available under the terms of the Singapore Open Data Licence version 1.0 ' +
    `(${SINGAPORE_OPEN_DATA_LICENCE_URL})`
  );
}

/**
 * The camera number from `camera_id`, or null. The API sends digits as a
 * string ("2701"). Anything else is refused, so an id can never carry a path
 * or a separator.
 *
 * @param {unknown} raw
 * @returns {?string}
 */
export function singaporeCameraNumber(raw) {
  const text =
    typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  return /^[1-9]\d{0,7}$/.test(text) ? text : null;
}

/**
 * Pin a frame link to the data.gov.sg traffic image directory: HTTPS, the
 * exact host, no credentials, the default port, and a `.jpg` file under
 * `/api/traffic-images/`.
 *
 * @param {unknown} raw - `image` from the API.
 * @returns {?string} The pinned URL, or null when it is not a registered frame.
 */
export function normalizeSingaporeImageUrl(raw) {
  const pinned = pinnedCameraUrl(raw, SINGAPORE_IMAGE_ORIGIN);
  if (!pinned) return null;
  return /\.jpe?g$/i.test(new URL(pinned).pathname) ? pinned : null;
}

/**
 * Label for one camera: the OneMotoring name when the table has one, else a
 * plain name from the id. A place name is never guessed.
 *
 * @param {string} number - Validated camera number.
 * @returns {string}
 */
export function singaporeCameraName(number) {
  return SINGAPORE_CAMERA_NAMES[number] || `Singapore camera ${number}`;
}

/**
 * One API camera row to one catalog source, or null.
 *
 * The API publishes no bearing, so the heading is the shared id-hash fallback
 * at low confidence. The operator corrects it with the calibration gizmo.
 *
 * @param {object} row - One entry of `items[].cameras`.
 * @param {object} [options]
 * @param {string} [options.notice] - The attribution notice for this load.
 * @returns {?object}
 */
export function singaporeCameraToSource(
  row,
  { notice = singaporeTrafficImagesNotice() } = {},
) {
  if (!row || typeof row !== 'object') return null;
  const number = singaporeCameraNumber(row.camera_id);
  if (!number) return null;
  const lat = toFiniteNumber(row.location?.latitude);
  const lon = toFiniteNumber(row.location?.longitude);
  if (!isLikelySingaporeCoordinate(lat, lon)) return null;
  const imageUrl = normalizeSingaporeImageUrl(row.image);
  if (!imageUrl) return null;

  const id = `singapore-${number}`;
  const name = singaporeCameraName(number);
  return {
    id,
    name,
    city: 'Singapore',
    cityId: 'singapore',
    provider: 'Land Transport Authority',
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(id),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    // Low-lying island prior; the client's one-shot ground snap corrects it.
    groundElevationM: 15,
    feedType: 'image',
    // The catalog link. The frame proxy swaps in the current link at frame
    // time (createSingaporeFrameResolver) and falls back to this one.
    url: imageUrl,
    snapshotUrl: imageUrl,
    // A new snapshot arrives about every 1 to 2 minutes.
    frameRefreshMs: SINGAPORE_FRAME_LINK_REFRESH_MS,
    sourceKind: SINGAPORE_SOURCE_KIND,
    license: notice,
    code: cameraDisplayCode(name.toUpperCase()),
  };
}

/**
 * The camera rows of one API answer, or null when it is not the documented
 * `{ items: [{ cameras: [...] }] }` shape.
 *
 * @param {unknown} payload
 * @returns {?Array<object>}
 */
export function singaporeCameraRows(payload) {
  if (!Array.isArray(payload?.items)) return null;
  return payload.items.flatMap((item) =>
    Array.isArray(item?.cameras) ? item.cameras : [],
  );
}

/**
 * One request to the traffic-images API: keyless, with a deadline, a body
 * cap, and no redirects.
 *
 * @param {object} options
 * @param {typeof fetch} options.fetchImpl
 * @param {number} options.timeoutMs
 * @returns {Promise<Array<object>>} The camera rows.
 * @throws When the answer is a redirect, an HTTP error, too large, or not the
 *   documented shape.
 */
async function fetchSingaporeCameraRows({ fetchImpl, timeoutMs }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(SINGAPORE_TRAFFIC_IMAGES_URL, {
    headers: { Accept: 'application/json' },
    redirect: 'manual',
    signal,
  });
  if (!response.ok) {
    // A response that is not read still holds its connection until the body
    // is released.
    try {
      await response.body?.cancel();
    } catch {
      /* no-op */
    }
    throw new Error(
      response.status >= 300 && response.status < 400
        ? 'list redirected; redirects are not followed'
        : `list HTTP ${response.status}`,
    );
  }
  const payload = await readResponseJsonCapped(
    response,
    SINGAPORE_MAX_CATALOG_BYTES,
    signal,
  );
  const rows = singaporeCameraRows(payload);
  if (!rows) throw new Error('unexpected list payload');
  return rows;
}

/**
 * Load the Singapore traffic cameras from data.gov.sg. One keyless request
 * per catalog refresh.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {() => number} [options.now]
 * @returns {Promise<Array<object>>} Cameras nearest the city centre first, or
 *   [] on any upstream or payload failure.
 */
export async function loadSingaporeSourcesFromOpenData({
  fetchImpl = fetch,
  timeoutMs = CCTV_SOURCE_FETCH_TIMEOUT_MS,
  env = process.env,
  now = Date.now,
} = {}) {
  try {
    const rows = await fetchSingaporeCameraRows({ fetchImpl, timeoutMs });
    const notice = singaporeTrafficImagesNotice(new Date(now()));
    const cameras = [];
    const seen = new Set();
    for (const row of rows) {
      const camera = singaporeCameraToSource(row, { notice });
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
    const maxRaw = Number(
      env.CCTV_SINGAPORE_MAX_SOURCES || DEFAULT_SINGAPORE_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(200, Math.floor(maxRaw)))
      : DEFAULT_SINGAPORE_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, SINGAPORE_ANCHORS);
    console.log(
      `[CCTV] Loaded Singapore camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Singapore camera download error:',
      error?.message || error,
    );
    return [];
  }
}

/**
 * Resolve the current frame link for a Singapore camera at frame time.
 *
 * The frame link changes with every snapshot, but the catalog refreshes only
 * every 15 minutes. One API answer holds the current link of every camera, so
 * the resolver keeps one id-to-link map for all of them:
 * - a map younger than `refreshMs` answers at once;
 * - otherwise one lookup runs, and every caller waits on that same request
 *   (single flight);
 * - a failed lookup gives the catalog link, and the next lookup waits until
 *   `refreshMs` after the failed one started.
 * Every link is validated with the catalog rules, so a lookup cannot steer
 * the frame proxy off the pinned directory.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.refreshMs]
 * @param {number} [options.timeoutMs]
 * @param {() => number} [options.now]
 * @returns {(cameraId: string, catalogUrl: string) => Promise<string>} Gives
 *   the current pinned link, else the pinned catalog link, else ''.
 */
export function createSingaporeFrameResolver({
  fetchImpl = (...args) => fetch(...args),
  refreshMs = SINGAPORE_FRAME_LINK_REFRESH_MS,
  timeoutMs = SINGAPORE_FRAME_LINK_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string,string>|null} */
  let links = null;
  let linksAt = 0;
  let nextLookupAt = 0;
  /** @type {Promise<void>|null} */
  let inflight = null;

  const lookup = async () => {
    try {
      const rows = await fetchSingaporeCameraRows({ fetchImpl, timeoutMs });
      const next = new Map();
      for (const row of rows) {
        const camera = singaporeCameraToSource(row, { notice: '' });
        if (camera && !next.has(camera.id)) next.set(camera.id, camera.url);
      }
      links = next;
      linksAt = now();
    } catch {
      links = null;
      console.warn(
        '[CCTV] Singapore frame link lookup failed; using the catalog link',
      );
    }
  };

  return async function resolveSingaporeFrameUrl(cameraId, catalogUrl) {
    const fallback = normalizeSingaporeImageUrl(catalogUrl) || '';
    if (links && now() - linksAt < refreshMs)
      return links.get(cameraId) || fallback;
    if (!inflight && now() >= nextLookupAt) {
      nextLookupAt = now() + refreshMs;
      links = null;
      inflight = lookup().finally(() => {
        inflight = null;
      });
    }
    if (inflight) await inflight;
    return links?.get(cameraId) || fallback;
  };
}
