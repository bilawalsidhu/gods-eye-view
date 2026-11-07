import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  cameraDisplayCode,
  fallbackHeadingFromId,
  isPlausibleLatLon,
  prioritizeSources,
} from './normalize.js';
import { readResponseJsonCapped } from '../common/http.js';
import { directionToHeading } from '../../../src/data/directionText.js';

/** MnDOT's public camera list from its IRIS traffic management system,
 * published keyless (~1,800 cameras statewide, ~425 KB). */
export const MNDOT_CAMERA_LIST_URL =
  'https://data.dot.state.mn.us/iris/camera_pub';
/** Several times today's list. */
export const MNDOT_MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const DEFAULT_MNDOT_MAX_SOURCES = 1000;

// The IRIS video servlet answers /video/{stream|image}/<district>/<camera>.
// The `metro` district serves the still of every streamable camera, outstate
// ones included. The servlet refuses a still request without `size`, then
// returns its native 720x480 frame whichever size is asked for.
const MNDOT_STILL_ORIGIN = 'https://video.dot.state.mn.us';
const CAMERA_NAME_RE = /^[A-Za-z0-9-]{1,40}$/;
const NAME_MAX_CHARS = 160;

/** Prioritization anchors: the two downtowns only, so a cap (or the shared
 * round-robin, which trims from the end) keeps the Twin Cities metro first
 * and outstate cameras after it, nearest first. */
const ANCHORS = [
  { lat: 44.9778, lon: -93.265 }, // Minneapolis
  { lat: 44.9537, lon: -93.09 }, // St Paul
];

/** Minnesota with slack for the border corridors. */
function isLikelyMinnesotaCoordinate(lat, lon) {
  return (
    isPlausibleLatLon(lat, lon) &&
    lat >= 43.4 &&
    lat <= 49.5 &&
    lon >= -97.3 &&
    lon <= -89.4
  );
}

/**
 * Camera name -> its still on MnDOT's video server, or null. The URL is built
 * on a fixed origin from a validated name; the list itself carries no URL.
 *
 * @param {unknown} name - IRIS camera name, e.g. "C001" or "D6-C002".
 * @returns {?string}
 */
export function mndotStillUrl(name) {
  if (typeof name !== 'string' || !CAMERA_NAME_RE.test(name)) return null;
  return `${MNDOT_STILL_ORIGIN}/video/image/metro/${name}?size=l`;
}

/**
 * One IRIS `camera_pub` record -> one catalog source, or null.
 *
 * @param {object} record
 * @returns {?object}
 */
export function mndotCameraToSource(record) {
  if (!record || typeof record !== 'object') return null;
  // MnDOT's own publication flags. Anything but a literal true keeps the
  // camera out, so a renamed or malformed flag fails closed. A camera that
  // does not stream has no still to serve.
  if (record.publish !== true || record.streamable !== true) return null;
  const { lat, lon } = record;
  if (!isLikelyMinnesotaCoordinate(lat, lon)) return null;
  const camera = record.name;
  const imageUrl = mndotStillUrl(camera);
  if (!imageUrl) return null;

  const cameraId = `mndot-${camera.toLowerCase()}`;
  const location = String(record.location ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // road_dir is the carriageway the camera serves, not where it points:
  // MnDOT's cameras pan, and the compass letter burned into sampled frames
  // disagreed with it about half the time. It seeds the bearing only.
  const travelHeading = directionToHeading(record.road_dir, false);

  return {
    id: cameraId,
    name: (location || camera).slice(0, NAME_MAX_CHARS),
    // One statewide category in the camera picker, like Taiwan and Norway.
    city: 'Minnesota',
    cityId: 'minnesota',
    provider: 'MnDOT',
    lat,
    lon,
    headingDeg: Number.isFinite(travelHeading)
      ? travelHeading
      : fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 10,
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'mndot-iris',
    license: 'Public MnDOT traffic camera data (IRIS public camera list)',
    code: cameraDisplayCode(camera),
  };
}

function mndotSourceCap() {
  const rawCap = Number(
    process.env.CCTV_MNDOT_MAX_SOURCES || DEFAULT_MNDOT_MAX_SOURCES,
  );
  return Number.isFinite(rawCap)
    ? Math.max(1, Math.min(2000, Math.floor(rawCap)))
    : DEFAULT_MNDOT_MAX_SOURCES;
}

/**
 * Fetch MnDOT cameras from the keyless IRIS camera list. One bounded request
 * per shared catalog refresh; a failure contributes an empty pack until the
 * next refresh, like the Toronto and NYC packs.
 *
 * @returns {Promise<Array<object>>}
 */
export async function loadMndotSources() {
  try {
    const signal = AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS);
    const response = await fetch(
      process.env.CCTV_MNDOT_URL || MNDOT_CAMERA_LIST_URL,
      {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        response.status >= 300 && response.status < 400
          ? 'camera list redirected; redirects are not followed'
          : `HTTP ${response.status}`,
      );
    }
    const records = await readResponseJsonCapped(
      response,
      MNDOT_MAX_CATALOG_BYTES,
      signal,
    );
    if (!Array.isArray(records)) throw new Error('camera list is not an array');
    const cameras = new Map();
    for (const record of records) {
      const camera = mndotCameraToSource(record);
      if (camera && !cameras.has(camera.id)) cameras.set(camera.id, camera);
    }
    if (!cameras.size) throw new Error('no usable cameras in the list');
    const sources = prioritizeSources(
      [...cameras.values()],
      mndotSourceCap(),
      ANCHORS,
    );
    console.log(
      `[CCTV] Loaded MnDOT camera sources: ${cameras.size} (using ${sources.length})`,
    );
    return sources;
  } catch (error) {
    console.warn(
      `[CCTV] MnDOT camera download failed (${error?.message || error}); no Minnesota cameras until the next refresh`,
    );
    return [];
  }
}
