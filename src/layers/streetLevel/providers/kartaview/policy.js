import { COLORS as SHARED_COLORS, PROVIDER_COLORS } from '../../policy.js';

export { NEAREST_RADIUS_M } from '../../policy.js';

/** Identity and tuning for the KartaView street-level provider (keyless). */
export const KARTAVIEW_PROVIDER_ID = 'kartaview';
export const KARTAVIEW_NAME = 'KartaView';
export const KARTAVIEW_LABEL = 'KARTAVIEW';

/**
 * The public API. Its documented twin, api.openstreetcam.org, still answers
 * but serves empty coverage tiles.
 */
export const KARTAVIEW_API_HOST = 'https://api.kartaview.org';
/** KartaView's image proxy: resizes a photo given its base64url address. */
export const KARTAVIEW_CDN_HOST = 'https://cdn.kartaview.org';

/** Stable id prefixes for picked primitives; every one starts with `kv:`. */
export const PICK_PREFIX = Object.freeze({
  root: 'kv:',
  line: 'kv:line:',
  image: 'kv:img:',
});

export const COLORS = Object.freeze({
  coverage: PROVIDER_COLORS.kartaview,
  selected: SHARED_COLORS.selected,
});

/**
 * Coverage lines are OSM ways with photos, from z13–14 JSON tiles. Lower
 * zooms take seconds per tile (z10 does not answer), so higher up the panel
 * asks the user to zoom in.
 */
export const COVERAGE_STREET_ZOOM_BELOW_M = 2_500;
export const COVERAGE_MAX_HEIGHT_M = 6_000;
export const COVERAGE_TUNING = Object.freeze({
  maxTiles: 9,
  overviewMaxTiles: 0,
  // Chained ways are short: a dense downtown z13 tile holds ~1,500, so each
  // tile may draw 1,600 (a frame stays at 16.7 ms with 4,400 drawn).
  maxSequences: 14_400,
  lineWidthPx: 2.5,
  overviewPointPx: 2.5,
  moveDebounceMs: 320,
  viewRangeMinM: 2_500,
  viewRangePerHeight: 10,
  viewNearM: 1_000,
});
export const TOO_HIGH_HINT = 'zoom in to see KartaView coverage';
export const NO_COVERAGE_HINT = 'no KartaView photos in view';
export const RATE_LIMITED_MESSAGE =
  'KartaView is rate-limiting requests — they resume on their own';

/**
 * The photo API answers 429 to more than about three requests at once, so
 * at most two are in flight; a 429 is retried after a short wait.
 */
export const PHOTO_API_CONCURRENCY = 2;
export const PHOTO_API_RETRIES = 3;
export const PHOTO_API_RETRY_BASE_MS = 800;
/** A Retry-After longer than this is not waited out. */
export const PHOTO_API_RETRY_MAX_MS = 10_000;
/** The API is HTTP/1.1 (six connections): tiles 3, lookups 2, pages 1. */
export const TILE_CONCURRENCY = 3;
export const PAGE_CONCURRENCY = 1;
export const TILE_TIMEOUT_MS = 20_000;
export const PHOTO_API_TIMEOUT_MS = 15_000;
/**
 * The first try of a lookup: KartaView sometimes sits on a lookup for 11 s
 * and more, then answers the same one again in 3 s.
 */
export const PHOTO_API_FIRST_TIMEOUT_MS = 8_000;
/** A sequence page is about 650 kB of JSON. */
export const PAGE_TIMEOUT_MS = 30_000;
/** Real tiles are under 1 MB; refuse anything absurd before parsing it. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** A photo download (tens of kilobytes to a few megabytes). */
export const IMAGE_TIMEOUT_MS = 15_000;
/** Whether a photo file is there (not archived): headers only. */
export const IMAGE_PROBE_TIMEOUT_MS = 8_000;
/** Nearest photos probed (at once) before giving up on archived ones; ‹ › skip this many. */
export const NEAREST_PROBES = 6;
export const ARCHIVED_MESSAGE =
  'KartaView’s photos here are archived and cannot be shown';

/** Photos asked for around a point; the API returns them nearest first. */
export const NEAREST_LIMIT = 10;
/** The photo API's search zoom: 18 searches the few tens of metres around the point. */
export const NEAREST_SEARCH_ZOOM = 18;

/**
 * Photos of a sequence fetched at once, around the open one. Records are
 * ~2.6 kB each, so a page is ~650 kB; the cones and ‹ › use it. Pages are in
 * photo-id order, which only roughly follows the sequence index.
 */
export const SEQUENCE_PAGE_SIZE = 250;
/** Within this many photos of a page's edge, its neighbour page joins it. */
export const SEQUENCE_PAGE_EDGE = 12;

/** Equirectangular panorama sizes: a quick preview, then the sharp one. */
export const PANO_PREVIEW_SIZE = Object.freeze([1024, 512]);
/** Enough for a docked viewer; an expanded one gets the full size. */
export const PANO_MID_SIZE = Object.freeze([2048, 1024]);
export const PANO_FULL_SIZE = Object.freeze([4096, 2048]);
/** A flat photo's first version, then its sharp one. */
export const FLAT_VIEW_SIZE = Object.freeze([1280, 1280]);
export const FLAT_FULL_SIZE = Object.freeze([2560, 2560]);

/** On-globe credit: KartaView imagery is CC BY-SA 4.0 and needs attribution. */
export const KARTAVIEW_CREDIT_HTML =
  'Street Level: imagery © <a href="https://kartaview.org" target="_blank" rel="noopener">KartaView</a> contributors, CC BY-SA 4.0';

/**
 * The imagery filter (360° or flat, SINCE). KartaView filters coverage on
 * its server only in its PNG tiles: its JSON tiles come back empty once a
 * filter is asked for. So a filtered PNG tile is a mask, and a JSON line is
 * kept where it lies on the mask's drawn pixels.
 *
 * KartaView's date filter is the upload date, and SINCE goes by it
 * throughout (lines, the photo a click opens, the cones), as KartaView's own
 * map does; the panel says so under the slider.
 */
export const MASK_TIMEOUT_MS = 20_000;
/**
 * A filtered PNG tile is drawn on demand and a dense one can outlast
 * KartaView's own 60 s (504); it keeps drawing, and has the tile a few
 * seconds later. A timeout or a 5xx is asked again this many times in all.
 */
export const MASK_ATTEMPTS = 4;
export const MASK_RETRY_WAIT_MS = 4_000;
/** Real masks are tens of kilobytes. */
export const MASK_MAX_BYTES = 2 * 1024 * 1024;
/** A segment is kept when this share of the points along it lies on the mask. */
export const MASK_KEEP_SHARE = 0.5;
/** Points along a segment are tested this many mask pixels apart. */
export const MASK_SAMPLE_PX = 2;
export const MASK_SLOW_MESSAGE =
  'KartaView did not filter this area in time — move the map to ask again';
export const FILTERED_OUT_MESSAGE =
  'None of KartaView’s photos here pass the imagery filter';
/** Under the SINCE slider while KartaView is lit. */
export const SINCE_NOTE = 'KartaView: by upload date';

/** The UTC calendar day of `ms`, as KartaView's startDate reads it. */
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const filtersSince = (filter) =>
  Number.isFinite(filter?.sinceMs) && filter.sinceMs > 0;

const DAY_MS = 86_400_000;

/**
 * Whether a photo passes the resolved imagery filter by its projection and
 * upload date, the cut-off taken as its UTC day, as KartaView's startDate.
 * @param {{isPano: boolean, uploadedAt: number|null}} photo
 * @param {{pano: string, sinceMs: number|null}|null} filter
 */
export function passesKartaViewFilter(photo, filter) {
  if (!filter) return true;
  if (filter.pano === 'pano' && !photo.isPano) return false;
  if (filter.pano === 'flat' && photo.isPano) return false;
  if (!filtersSince(filter)) return true;
  const day = Math.floor(filter.sinceMs / DAY_MS) * DAY_MS;
  return (photo.uploadedAt ?? 0) >= day;
}

/**
 * The query of a filtered PNG coverage tile, or '' when nothing is
 * filtered. The day, not the instant, so it is stable for a day (and keys
 * the mask cache).
 * @param {{pano: string, sinceMs: number|null}|null} filter  resolved
 */
export function tileFilterQuery(filter) {
  const params = new URLSearchParams();
  if (filter?.pano === 'pano') params.set('fieldOfView', '360');
  else if (filter?.pano === 'flat') params.set('fieldOfView', 'plane');
  if (filtersSince(filter)) params.set('startDate', utcDay(filter.sinceMs));
  return params.toString();
}

/**
 * The photo search's own filter: projection and upload date (its
 * `fieldOfView` is ignored).
 * @param {{pano: string, sinceMs: number|null}|null} filter  resolved
 * @returns {Record<string, string>}
 */
export function photoFilterParams(filter) {
  const params = {};
  if (filter?.pano === 'pano') params.projection = 'SPHERE';
  else if (filter?.pano === 'flat') params.projection = 'PLANE';
  if (filtersSince(filter)) params.startDate = utcDay(filter.sinceMs);
  return params;
}

/** The cone and coverage noun: a line is a street with photos, not a sequence. */
export const COVERAGE_NOUN = 'streets';
export const LINE_CLICK_HINT = 'click a line for its nearest photo';

/** Base64url of a string, as the image proxy reads addresses. */
function base64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A photo resized by KartaView's image proxy to fit `width`×`height`. */
export function resizedImageUrl(url, [width, height]) {
  if (!url) return null;
  return `${KARTAVIEW_CDN_HOST}/pr:sharp/rs:fit:${width}:${height}/${base64Url(url)}`;
}

/** Epoch ms for a KartaView timestamp ('2016-02-19 15:28:18.000', UTC), or null. */
export function kartaViewTimeMs(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
      String(value ?? ''),
    );
  if (!match) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
  if (Number(y) < 1990) return null;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return Number.isFinite(ms) ? ms : null;
}

/** Initial great-circle bearing from `a` to `b`, degrees clockwise from north. */
export function bearingBetween(a, b) {
  const rad = Math.PI / 180;
  const dLon = (b.lon - a.lon) * rad;
  const y = Math.sin(dLon) * Math.cos(b.lat * rad);
  const x =
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Photos closer than this say nothing about the direction of travel. */
const COURSE_MIN_STEP_M = 2;
/** How many photos along to look for one far enough away. */
const COURSE_SEARCH = 5;

/**
 * Give each photo of a drive (in index order) its `course`: the direction
 * of travel from it to the next photo a few metres on (from the previous one
 * at the end). KartaView is dashcam imagery, so this is where the camera
 * looks; its `heading` is the device compass, which reads 0 without one and
 * can sit 110° off inside a car.
 * @param {Array<{lon: number, lat: number, course?: number|null}>} photos
 * @param {(a: object, b: object) => number} metres
 */
export function assignCourses(photos, metres) {
  photos.forEach((photo, i) => {
    let course = null;
    for (let j = i + 1; j <= i + COURSE_SEARCH && j < photos.length; j++)
      if (metres(photo, photos[j]) >= COURSE_MIN_STEP_M) {
        course = bearingBetween(photo, photos[j]);
        break;
      }
    for (
      let k = i - 1;
      course === null && k >= i - COURSE_SEARCH && k >= 0;
      k--
    )
      if (metres(photos[k], photo) >= COURSE_MIN_STEP_M)
        course = bearingBetween(photos[k], photo);
    photo.course = course;
  });
  return photos;
}

/** Where the camera looked: the direction of travel, else the compass, else unknown. */
export function cameraBearing(photo) {
  return photo?.course ?? photo?.heading ?? null;
}

/** A coordinate pair as numbers; the road-matched one when KartaView has it. */
function positionOf(record) {
  const matchLat = Number(record.matchLat);
  const matchLon = Number(record.matchLng);
  if (
    Number.isFinite(matchLat) &&
    Number.isFinite(matchLon) &&
    (matchLat !== 0 || matchLon !== 0)
  )
    return { lat: matchLat, lon: matchLon };
  return { lat: Number(record.lat), lon: Number(record.lng) };
}

const STORAGE_HOST = /^storage\d+$/;

/** A KartaView photo-storage address, or null for anything else. */
function storageUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' &&
      /^storage\d+\.openstreetcam\.org$/.test(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * A photo file's address. The API's `fileurl*` fields always name storage1,
 * but a photo whose `storage` is another host (storage2…) is only there, so
 * the address is built from `storage` and the relative `filepath*`. A
 * `fileurl*` fallback must itself be on KartaView's storage.
 */
function fileUrl(record, pathKey, urlKey) {
  const path = record[pathKey];
  if (STORAGE_HOST.test(record.storage || '') && path)
    return storageUrl(
      `https://${record.storage}.openstreetcam.org/files/photo/${path}`,
    );
  return storageUrl(record[urlKey]);
}

/** A storage URL with its `{{sizeprefix}}` placeholder filled. */
function sized(record, prefix) {
  const fill = (value) =>
    typeof value === 'string' && value.includes('{{sizeprefix}}')
      ? value.replace('{{sizeprefix}}', prefix)
      : null;
  const path = fill(record.filepath);
  return fileUrl(
    { ...record, filepath: path, fileurl: fill(record.fileurl) },
    'filepath',
    'fileurl',
  );
}

/**
 * A photo API record in the shape the provider uses, or null without an id
 * or a position.
 * @returns {{id: string, sequenceId: string|null, sequenceIndex: number|null, lon: number, lat: number, heading: number|null, isPano: boolean, capturedAt: number|null, urls: {view: string|null, full: string|null, pano: string|null}}|null}
 */
export function normalizePhoto(record) {
  if (!record || record.id == null) return null;
  const { lat, lon } = positionOf(record);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // 0,0 is a missing fix, not a photo in the Gulf of Guinea.
  if (lat === 0 && lon === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // An exact 0 is a device without a compass (whole drives read 0), not north.
  const heading =
    record.heading === '' || record.heading == null
      ? NaN
      : Number(record.heading) || NaN;
  const isPano =
    record.projection === 'SPHERE' || Number(record.fieldOfView) >= 360;
  const full =
    fileUrl(record, 'filepathProc', 'fileurlProc') || sized(record, 'proc');
  const index = Number(record.sequenceIndex);
  return {
    id: String(record.id),
    sequenceId: record.sequenceId != null ? String(record.sequenceId) : null,
    sequenceIndex: Number.isFinite(index) ? index : null,
    lon,
    lat,
    heading: Number.isFinite(heading) ? heading : null,
    isPano,
    capturedAt:
      kartaViewTimeMs(record.shotDate) ?? kartaViewTimeMs(record.dateAdded),
    // KartaView's SINCE goes by this (its server filters by upload date).
    uploadedAt: kartaViewTimeMs(record.dateAdded),
    urls: {
      // A 1280 px rendition; for a 360° photo it is the front view only.
      view:
        fileUrl(record, 'filepathLTh', 'fileurlLTh') ||
        sized(record, 'lth') ||
        full,
      full,
      // A 360° photo's equirectangular image ('wrapped_proc').
      pano: isPano && /wrapped/.test(full || '') ? full : null,
    },
  };
}

/**
 * Where the image link goes. KartaView's photo pages fail for signed-out
 * visitors ("Sequence cannot be loaded"), so it is the full-size photo
 * through KartaView's image proxy, which also serves photos whose storage
 * host answers 502 directly.
 */
export function kartaViewPhotoUrl(photo) {
  const url = photo?.urls?.full || photo?.urls?.view;
  return url
    ? `${KARTAVIEW_CDN_HOST}/pr:sharp/${base64Url(url)}`
    : 'https://kartaview.org';
}
