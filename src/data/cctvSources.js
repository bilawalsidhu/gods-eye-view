// src/data/cctvSources.js
/**
 * CCTV source catalog + frame serving — the single source of truth for the
 * traffic-camera subsystem, shared by callers that cannot share anything else:
 *
 *   1. the dev-server CCTV middleware (`vite/proxies/cctv.js`, `/api/cctv/*`)
 *   2. the Cloudflare Pages Function of the same routes
 *      (`functions/api/cctv/[[path]].js`)
 *   3. unit tests, which pin the frame-fetch timeout and the fallback chain
 *
 * Pure-ish module: no DOM, no Node APIs (`fs`, `path`, `Buffer`, `process`)
 * and no client-supplied URLs. The same constraint `voice/realtimeSession.js`
 * runs under, and for the same reason — the dev proxy runs in Node, the Pages
 * Functions run in workerd, and both must serve the same camera catalog and
 * the same upstream → Street View → synthetic fallback chain.
 *
 * Everything that used to be read off `process.env` is now an explicit
 * parameter: `getCctvSources({ configuredSources, env })` and
 * `streetViewFallback({ ..., apiKey })`. `env` is a plain record of environment
 * variables — Node's `process.env` in dev, the Workers `env` binding in
 * production — and this module never touches `process` itself. File-backed
 * sources (which need `fs`) stay in the dev config and are injected through
 * `configuredSources`; `parseConfiguredSourcesFromEnv` is shared so both
 * runtimes decode `CCTV_SOURCES_JSON` identically.
 *
 * Module-level cache/health state is per-process in dev and per-isolate in
 * production — a backstop, not a global quota (same honesty as
 * `functions/_lib.js`).
 *
 * SSRF: every upstream URL this module fetches comes from a server-registered
 * catalog entry (open-data pack, config file, or `CCTV_SOURCES_JSON`). Nothing
 * here ever fetches a URL the client asked for.
 *
 * @module data/cctvSources
 */

import { directionToHeading } from './directionText.js';
import { api } from '../config/apiEndpoints.js';
import { resolveGoogleApiKey } from './googlePlacesPolicy.js';
import { isSafeExternalHttpUrl } from './externalUrlPolicy.js';

/** Path to the optional static CCTV source list (JSON array). */
export const DEFAULT_CCTV_SOURCE_FILE = 'config/cctv_sources.austin.json';
/** Austin Open Data portal endpoint for traffic camera records. */
export const DEFAULT_AUSTIN_ROWS_URL = 'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD';
/** Default cap on Austin cameras after distance-based prioritization. */
export const DEFAULT_AUSTIN_MAX_SOURCES = 250;
/** Global cap on total CCTV sources served by the proxy. */
export const DEFAULT_CCTV_MAX_SOURCES = 900;
/** Reference point for Austin camera prioritization (Congress & 6th). */
export const AUSTIN_DOWNTOWN = { lat: 30.2672, lon: -97.7431 };
/**
 * Caltrans CCTV: one JSON feed per district, identical schema statewide.
 * @param {number|string} district - Caltrans district number (3, 4, 7, 11...).
 * @returns {string} District status-feed URL, zero-padded to two digits.
 */
export const CALTRANS_CCTV_URL = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
/** Districts fetched by default: SF Bay (4), LA (7), San Diego (11), Sacramento (3). */
export const DEFAULT_CALTRANS_DISTRICTS = '4,7,11,3';
export const DEFAULT_CALTRANS_MAX_SOURCES = 300;
/** Prioritization anchors: downtown cores of the four default metros. */
export const CALTRANS_ANCHORS = [
  { lat: 37.7793, lon: -122.4193 }, // San Francisco
  { lat: 34.0537, lon: -118.2428 }, // Los Angeles
  { lat: 32.7157, lon: -117.1611 }, // San Diego
  { lat: 38.5816, lon: -121.4944 }, // Sacramento
];
/** TfL JamCams: one keyless list endpoint; frames live on a public S3 bucket. */
export const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
export const TFL_IMAGE_ORIGIN = 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';
export const DEFAULT_TFL_MAX_SOURCES = 250;
export const LONDON_CENTER = { lat: 51.5074, lon: -0.1278 };
/** Camera CATALOGS change rarely; 15 min keeps multi-megabyte upstream list refetches (Austin rows.json + 4 Caltrans districts + TfL) infrequent. Frames are fetched per-request and are unaffected. */
export const CCTV_SOURCE_CACHE_MS = 15 * 60 * 1000;
/** Per-provider catalog-fetch timeout. Bounds the worst-case refresh so one
 * stalled upstream can't leave getCctvSources (and thus every CCTV route)
 * pending forever — a hung fetch aborts, the loader returns [], and
 * serve-stale/other packs take over. */
export const CCTV_SOURCE_FETCH_TIMEOUT_MS = 15 * 1000;
/** Individual CCTV image fetches must settle before the active 10-second
 * client refresh cadence. A bounded miss can fall through to Street View or
 * the synthetic frame instead of leaving the browser preview pending. */
export const CCTV_FRAME_FETCH_TIMEOUT_MS = 8 * 1000;

/** @type {Array<object>} Cached merged + normalized CCTV source list. */
let _cctvSourceCache = [];
/** @type {number} Epoch-ms when the source cache was last refreshed. */
let _cctvSourceCacheAt = 0;
/** @type {Promise<Array<object>>|null} In-flight refresh, shared by concurrent
 * callers so a post-TTL burst launches ONE refetch, not one per request. */
let _cctvSourceInflight = null;

/**
 * FNV-1a 32-bit hash of a string, used to derive deterministic pseudo-random
 * values (e.g. hue for synthetic SVG billboards, fallback heading angles).
 *
 * @param {string} text - Input string (null/undefined coerces to '').
 * @returns {number} Unsigned 32-bit hash.
 */
export function hashSeed(text) {
  let h = 2166136261 >>> 0; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.codePointAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  return h >>> 0;
}

/**
 * Escape special XML/HTML characters for safe embedding in SVG text nodes.
 *
 * @param {string} text - Raw text (null/undefined coerces to '').
 * @returns {string} Escaped text safe for XML/SVG text content and attributes.
 */
export function escapeXml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;');
}

/**
 * Canonicalize a CCTV feed type string to one of:
 * 'image', 'mjpeg', 'mp4', 'webm', 'hls', or pass-through.
 *
 * @param {string} value - Raw feed type (e.g. 'jpeg', 'mjpg', 'video', 'stream').
 * @returns {string} Normalized feed type.
 */
export function normalizeFeedType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'image';
  if (raw === 'jpeg' || raw === 'jpg' || raw === 'png') return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  return raw;
}

/**
 * Check whether a normalized feed type represents streaming video.
 *
 * @param {string} feedType - Normalized feed type (see normalizeFeedType).
 * @returns {boolean} True for mp4/webm/hls (streamed, not snapshot).
 */
export function isVideoFeedType(feedType) {
  return feedType === 'mp4' || feedType === 'webm' || feedType === 'hls';
}

/**
 * Coerce a value to a finite number, returning fallback if NaN/Infinity.
 *
 * @param {*} value - Value to coerce (strings/numbers/numeric-ish).
 * @param {number} [fallback=NaN] - Value returned when coercion is not finite.
 * @returns {number} Finite number, or the fallback.
 */
export function toFiniteNumber(value, fallback = Number.NaN) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Normalize a column/field name to a lowercase snake_case key.
 *
 * @param {string} text - Raw column/field name (any casing, spaces, dashes).
 * @returns {string} Lowercase snake_case key ('' for empty input).
 */
function normalizeKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

/**
 * Parse a WKT POINT string (e.g. "POINT(-97.74 30.27)") into lat/lon.
 *
 * WKT uses (lon lat) order; returned object uses {lat, lon}.
 *
 * @param {string} value - WKT POINT string.
 * @returns {{lat:number, lon:number}} Degrees; NaN/NaN when unparseable.
 */
export function parsePointString(value) {
  const match = String(value || '').match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!match) return { lat: Number.NaN, lon: Number.NaN };
  return {
    lon: toFiniteNumber(match[1]),
    lat: toFiniteNumber(match[2]),
  };
}

/**
 * Extract lat/lon from a variety of coordinate representations.
 *
 * Handles WKT POINT strings, and objects with latitude/lat/y or
 * longitude/lon/lng/x properties (various casing).
 *
 * @param {string|object|null} value - WKT string or coordinate-bearing object.
 * @returns {{lat:number, lon:number}} Degrees; NaN/NaN when nothing resolves.
 */
export function coerceLatLon(value) {
  if (!value) return { lat: Number.NaN, lon: Number.NaN };

  if (typeof value === 'string') {
    return parsePointString(value);
  }

  if (typeof value !== 'object') {
    return { lat: Number.NaN, lon: Number.NaN };
  }

  const lat = toFiniteNumber(
    value.latitude ?? value.lat ?? value.y ?? value.Latitude ?? value.Lat,
    Number.NaN
  );
  const lon = toFiniteNumber(
    value.longitude ?? value.lon ?? value.lng ?? value.x ?? value.Longitude ?? value.Lon,
    Number.NaN
  );
  return { lat, lon };
}

/**
 * Extract geographic coordinates from an Austin Open Data camera record.
 *
 * Tries several candidate fields (location, coordinates, the_geom,
 * point, geocoded_column) via coerceLatLon, then falls back to
 * explicit latitude/longitude scalar fields.
 *
 * @param {object} record - Flattened camera record.
 * @returns {{lat:number, lon:number}} Degrees; NaN/NaN when no field resolves.
 */
function extractAustinCoords(record) {
  const candidates = [
    record.location,
    record.coordinates,
    record.the_geom,
    record.point,
    record.geocoded_column,
  ];
  for (const candidate of candidates) {
    const parsed = coerceLatLon(candidate);
    if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon)) return parsed;
  }

  const lat = toFiniteNumber(
    record.latitude ?? record.lat ?? record.camera_latitude ?? record.location_latitude,
    Number.NaN
  );
  const lon = toFiniteNumber(
    record.longitude ?? record.lon ?? record.lng ?? record.camera_longitude ?? record.location_longitude,
    Number.NaN
  );
  return { lat, lon };
}

/**
 * Extract a numeric camera ID from an Austin Open Data record.
 *
 * Tries well-known field names first, then scans any field whose key
 * contains "camera"/"cam"/"device" + "id".
 *
 * @param {object} record - Flattened camera record.
 * @returns {string} Numeric ID string, or '' if none found.
 */
function extractAustinCameraId(record) {
  const preferredKeys = [
    'camera_id',
    'cameraid',
    'cam_id',
    'device_id',
    'intersection_id',
    'id',
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (value == null) continue;
    const asText = String(value).trim();
    if (!asText) continue;
    if (/^\d+$/.test(asText)) return asText;
  }

  for (const [key, value] of Object.entries(record)) {
    if (!/camera|cam|device/.test(key)) continue;
    if (!/id/.test(key)) continue;
    const asText = String(value || '').trim();
    if (!asText) continue;
    if (/^\d+$/.test(asText)) return asText;
  }

  return '';
}

/**
 * Extract a human-readable camera name from an Austin record.
 *
 * @param {object} record - Flattened camera record.
 * @param {string} cameraId - Fallback identifier if no name field found.
 * @returns {string} Camera display name ('Austin Camera <id>' when unnamed).
 */
function extractAustinName(record, cameraId) {
  const preferredKeys = [
    'camera_name',
    'location_name',
    'intersection_name',
    'location',
    'cross_street',
    'description',
    'name',
  ];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return `Austin Camera ${cameraId}`;
}

/**
 * Extract camera heading (compass bearing) from an Austin record.
 *
 * Tries explicit numeric heading fields first, then direction-keyword
 * fields, then infers from the camera name/description text.
 *
 * @param {object} record - Flattened camera record.
 * @returns {number} Heading in degrees [0..360), or NaN if unknown.
 */
function extractAustinHeading(record) {
  const direct = toFiniteNumber(record.heading_deg ?? record.heading ?? record.bearing, Number.NaN);
  if (Number.isFinite(direct)) return ((direct % 360) + 360) % 360;

  // Dedicated direction fields: bare cardinal words ("West") are real facings.
  const directionKeys = ['direction', 'travel_direction', 'facing', 'facing_direction'];
  for (const key of directionKeys) {
    const heading = directionToHeading(record[key], true);
    if (Number.isFinite(heading)) return heading;
  }

  // Free-form name/intersection text: only explicit travel forms ("WESTBOUND"/
  // "WB") count — a bare "West" here is a street name ("5TH ST / WEST AVE"), not
  // a facing, and must not promote the camera to a false high-confidence heading.
  const nameProbe = [
    record.camera_name,
    record.location_name,
    record.intersection_name,
    record.location,
    record.cross_street,
    record.description,
    record.name,
  ].filter(Boolean).join(' ');
  const inferred = directionToHeading(nameProbe);
  if (Number.isFinite(inferred)) return inferred;

  return Number.NaN;
}

/**
 * Bounding-box sanity check: is this coordinate plausibly in the Austin metro area?
 *
 * @param {number} lat - Latitude in degrees.
 * @param {number} lon - Longitude in degrees.
 * @returns {boolean} True when the point sits inside the Austin metro bbox.
 */
function isLikelyAustinCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= 30.02 && lat <= 30.58 && lon >= -98.12 && lon <= -97.40;
}

/**
 * Derive a deterministic fallback heading from a camera ID hash.
 *
 * Produces one of 16 evenly-spaced compass directions (0, 22.5, 45, ...).
 *
 * @param {string} cameraId - Camera id (the hash seed; stable across refreshes).
 * @returns {number} Heading in degrees [0..360).
 */
function fallbackHeadingFromId(cameraId) {
  return (hashSeed(String(cameraId)) % 16) * 22.5;
}

/**
 * Convert a Socrata rows.json array row into a keyed object using column metadata.
 *
 * @param {Array} row - Array of cell values from the Socrata payload.
 * @param {Array<{fieldName?:string, name?:string}>} columns - Column descriptors.
 * @returns {object} Keyed record with normalized snake_case keys.
 */
function rowArrayToObject(row, columns) {
  const record = {};
  for (let idx = 0; idx < columns.length; idx++) {
    const col = columns[idx];
    const key = normalizeKey(col.fieldName || col.name || `col_${idx}`);
    if (!key) continue;
    record[key] = row[idx];
  }
  return record;
}

/**
 * Haversine great-circle distance between two WGS-84 points.
 *
 * @param {number} lat1 - Latitude of point A (degrees).
 * @param {number} lon1 - Longitude of point A (degrees).
 * @param {number} lat2 - Latitude of point B (degrees).
 * @param {number} lon2 - Longitude of point B (degrees).
 * @returns {number} Distance in kilometers.
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Distance-prioritizes cameras to a cap: keeps the maxCount cameras closest
 * to ANY of the given anchor points (min distance over anchors), tie-broken
 * by original array order. Used by every live source pack (Austin: one
 * downtown anchor; Caltrans: one anchor per major CA metro; TfL: central
 * London) so a cap always keeps the densest, most interesting cores.
 *
 * @param {Array<object>} cameras - Normalized camera source objects.
 * @param {number} maxCount - Cap (<=0 or >= length disables).
 * @param {Array<{lat:number,lon:number}>} anchors - At least one anchor.
 * @returns {Array<object>} Capped, priority-ordered camera list.
 */
function prioritizeSources(cameras, maxCount, anchors) {
  const list = Array.isArray(cameras) ? cameras : [];
  const anchorList = (Array.isArray(anchors) ? anchors : []).filter(
    (a) => Number.isFinite(a?.lat) && Number.isFinite(a?.lon)
  );
  if (!Number.isFinite(maxCount) || maxCount <= 0 || list.length <= maxCount || !anchorList.length) {
    return list;
  }

  const scored = list.map((camera, idx) => {
    const lat = Number(camera?.lat);
    const lon = Number(camera?.lon);
    const distKm = Number.isFinite(lat) && Number.isFinite(lon)
      ? Math.min(...anchorList.map((a) => haversineKm(lat, lon, a.lat, a.lon)))
      : Number.POSITIVE_INFINITY;
    return { camera, idx, distKm };
  });

  scored.sort((a, b) => {
    if (a.distKm !== b.distKm) return a.distKm - b.distKm;
    return a.idx - b.idx;
  });

  return scored.slice(0, maxCount).map((entry) => entry.camera);
}

/**
 * Fetch and parse Austin traffic camera records from the city Open Data portal.
 *
 * Downloads the Socrata rows.json payload, converts each row to a keyed
 * record, extracts camera ID / coords / heading / name, validates against
 * the Austin bounding box, deduplicates by ID, then distance-prioritizes
 * to stay within CCTV_AUSTIN_MAX_SOURCES.
 *
 * @param {object} [env] - Environment variables (see module docblock).
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
async function loadAustinSourcesFromOpenData(env = {}) {
  const endpoint = env.CCTV_AUSTIN_ROWS_URL || DEFAULT_AUSTIN_ROWS_URL;
  try {
    const resp = await fetch(endpoint, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS) });
    if (!resp.ok) {
      console.warn('[CCTV] Austin source download failed:', resp.status);
      return [];
    }
    const payload = await resp.json();
    const columns = Array.isArray(payload?.meta?.view?.columns) ? payload.meta.view.columns : [];
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (!columns.length || !rows.length) return [];

    const cameras = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const record = rowArrayToObject(row, columns);
      const cameraId = extractAustinCameraId(record);
      if (!cameraId) continue;

      // Only live cameras: the dataset carries DESIRED (planned, not built),
      // REMOVED and VOID rows whose frame URLs never resolve — those cameras
      // would render as permanent Street View / synthetic fallbacks. Tolerate
      // a missing column (keep the row) so a schema change fails open.
      const status = String(record.camera_status || '').trim().toUpperCase();
      if (status && status !== 'TURNED_ON') continue;

      const { lat, lon } = extractAustinCoords(record);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!isLikelyAustinCoordinate(lat, lon)) continue;

      const extractedHeading = extractAustinHeading(record);
      const hasHeading = Number.isFinite(extractedHeading);
      const headingDeg = hasHeading ? extractedHeading : fallbackHeadingFromId(cameraId);
      cameras.push({
        id: cameraId,
        name: extractAustinName(record, cameraId),
        city: 'Austin',
        cityId: 'austin',
        provider: 'Austin Transportation & Public Works',
        lat,
        lon,
        headingDeg,
        headingConfidence: hasHeading ? 'high' : 'low',
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        groundElevationM: 150,
        feedType: 'image',
        url: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        snapshotUrl: `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`,
        sourceKind: 'austin-open-data',
        license: 'Public city traffic camera frame',
      });
    }

    const unique = Array.from(new Map(cameras.map((camera) => [camera.id, camera])).values());
    const maxRaw = Number(env.CCTV_AUSTIN_MAX_SOURCES || DEFAULT_AUSTIN_MAX_SOURCES);
    const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(300, Math.floor(maxRaw))) : DEFAULT_AUSTIN_MAX_SOURCES;
    const prioritized = prioritizeSources(unique, maxCount, [AUSTIN_DOWNTOWN]);
    if (prioritized.length < unique.length) {
      console.log(`[CCTV] Loaded Austin camera sources: ${unique.length} (using nearest ${prioritized.length})`);
    } else {
      console.log('[CCTV] Loaded Austin camera sources:', prioritized.length);
    }
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] Austin source download error:', error?.message || error);
    return [];
  }
}

/**
 * Fetch Caltrans CCTV cameras for the configured districts (CCTV_CALTRANS_DISTRICTS,
 * comma-separated 1..12; empty string disables the pack). One official JSON feed per
 * district, identical schema statewide; keyless. Only inService cameras with finite
 * coords and a cwwp2.dot.ca.gov https image URL are kept (the image-URL origin check
 * is defense-in-depth: the proxy only ever fetches catalog URLs, and this pins the
 * catalog to the official host). Districts fetch in parallel and fail independently
 * (Promise.allSettled) — one district outage never darkens the others.
 *
 * @param {object} [env] - Environment variables (see module docblock).
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
async function loadCaltransSourcesFromOpenData(env = {}) {
  const districtsRaw = env.CCTV_CALTRANS_DISTRICTS ?? DEFAULT_CALTRANS_DISTRICTS;
  const districts = String(districtsRaw)
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  if (!districts.length) return [];

  const settled = await Promise.allSettled(
    districts.map(async (district) => {
      const resp = await fetch(CALTRANS_CCTV_URL(district), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`D${district} HTTP ${resp.status}`);
      const payload = await resp.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      return { district, rows };
    })
  );

  const cameras = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      console.warn('[CCTV] Caltrans district fetch failed:', result.reason?.message || result.reason);
      continue;
    }
    const { district, rows } = result.value;
    for (const row of rows) {
      const cctv = row?.cctv;
      if (!cctv || String(cctv.inService).toLowerCase() !== 'true') continue;
      const loc = cctv.location || {};
      const lat = toFiniteNumber(loc.latitude);
      const lon = toFiniteNumber(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const imageUrl = String(cctv.imageData?.static?.currentImageURL || '');
      // Official-host pin (see JSDoc). Also drops records with no still image.
      if (!imageUrl.startsWith('https://cwwp2.dot.ca.gov/')) continue;

      const locationName = String(loc.locationName || '').trim();
      // Leading token of locationName is the stable camera code ("TV102 -- I-580 : …").
      const codeMatch = /^([A-Za-z0-9_-]+)\s*--/.exec(locationName);
      const code = (codeMatch ? codeMatch[1] : `x${cameras.length}`).toLowerCase();
      const cameraId = `ca-d${district}-${code}`;

      // loc.direction is a dedicated field ("West", "South") → allow bare words.
      const heading = directionToHeading(loc.direction, true);
      const hasHeading = Number.isFinite(heading);
      const label = locationName.replace(/^([A-Za-z0-9_-]+)\s*--\s*/, '') || `Caltrans D${district} ${code}`;
      cameras.push({
        id: cameraId,
        name: loc.nearbyPlace ? `${label} (${loc.nearbyPlace})` : label,
        city: String(loc.nearbyPlace || `Caltrans D${district}`),
        cityId: `ca-d${district}`,
        provider: 'Caltrans',
        lat,
        lon,
        headingDeg: hasHeading ? heading : fallbackHeadingFromId(cameraId),
        headingConfidence: hasHeading ? 'high' : 'low',
        // Same two fabricated pose personalities as Austin (design §1a): these are
        // RAW PRIOR starting points; the client's one-shot ground snap + manual
        // calibration own the truth.
        pitchDeg: hasHeading ? -24 : -18,
        fovDeg: hasHeading ? 56 : 44,
        rangeM: hasHeading ? 210 : 145,
        mountHeightM: hasHeading ? 10 : 8,
        // loc.elevation is reported in FEET (verified: D3 maxes at 7427 ft ≈
        // 2264 m for the Sierra passes — as metres that would top Mt Whitney).
        // Convert to metres and clamp to a sane CA-roads range so an occasional
        // garbage upstream value can't fling a camera kilometres up. Prior only:
        // the client one-shot snap corrects it on 3D-tile stacks — but on a
        // no-tileset stack (keyless OSM) the snap misses and this height freezes,
        // so it must be right-ish on its own.
        groundElevationM: (() => {
          const ft = toFiniteNumber(loc.elevation, Number.NaN);
          return Number.isFinite(ft) ? Math.max(-100, Math.min(4000, ft * 0.3048)) : 150;
        })(),
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'caltrans-open-data',
        license: 'Public Caltrans highway camera frame',
      });
    }
  }

  const maxRaw = Number(env.CCTV_CALTRANS_MAX_SOURCES || DEFAULT_CALTRANS_MAX_SOURCES);
  const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(600, Math.floor(maxRaw))) : DEFAULT_CALTRANS_MAX_SOURCES;
  const prioritized = prioritizeSources(cameras, maxCount, CALTRANS_ANCHORS);
  console.log(`[CCTV] Loaded Caltrans camera sources: ${cameras.length} inService (using nearest ${prioritized.length})`);
  return prioritized;
}

/**
 * Fetch TfL JamCams (London). Keyless: the optional TFL_APP_KEY only raises the
 * list-endpoint rate limit (frames come from TfL's public S3 bucket, which is not
 * rate-limited); the 15-min source cache keeps list hits far below anonymous
 * limits anyway. Only `available === "true"` cameras with finite coords and an
 * image URL on the official bucket are kept. Attribution: "Powered by TfL Open
 * Data" (registered in src/data/dataCredits.js).
 *
 * @param {object} [env] - Environment variables (see module docblock).
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
async function loadTflSourcesFromOpenData(env = {}) {
  try {
    const appKey = String(env.TFL_APP_KEY || '').trim();
    const url = appKey ? `${TFL_JAMCAM_URL}?app_key=${encodeURIComponent(appKey)}` : TFL_JAMCAM_URL;
    const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS) });
    if (!resp.ok) {
      console.warn('[CCTV] TfL JamCam download failed:', resp.status);
      return [];
    }
    const places = await resp.json();
    if (!Array.isArray(places)) return [];

    const cameras = [];
    for (const place of places) {
      const props = {};
      for (const p of place?.additionalProperties || []) {
        if (p?.key) props[p.key] = p.value;
      }
      if (String(props.available).toLowerCase() !== 'true') continue;
      const lat = toFiniteNumber(place?.lat);
      const lon = toFiniteNumber(place?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const imageUrl = String(props.imageUrl || '');
      if (!imageUrl.startsWith(TFL_IMAGE_ORIGIN)) continue; // official-bucket pin

      // "JamCams_00002.00865" → "tfl-00002.00865" (provider-stable id).
      const rawId = String(place?.id || '').replace(/^JamCams_/, '');
      if (!rawId) continue;
      const cameraId = `tfl-${rawId}`;

      cameras.push({
        id: cameraId,
        name: String(place?.commonName || `JamCam ${rawId}`),
        city: 'London',
        cityId: 'london',
        provider: 'Transport for London',
        lat,
        lon,
        // No heading signal at all in JamCam data → id-hash fallback, low
        // confidence personality (same as headingless Austin cameras).
        headingDeg: fallbackHeadingFromId(cameraId),
        headingConfidence: 'low',
        pitchDeg: -18,
        fovDeg: 44,
        rangeM: 145,
        mountHeightM: 8,
        groundElevationM: 15, // Thames-basin prior; one-shot snap corrects.
        feedType: 'image', // stills-first (product rule); props.videoUrl deliberately unused
        url: imageUrl,
        snapshotUrl: imageUrl,
        sourceKind: 'tfl-open-data',
        license: 'Powered by TfL Open Data',
      });
    }

    const maxRaw = Number(env.CCTV_TFL_MAX_SOURCES || DEFAULT_TFL_MAX_SOURCES);
    const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(600, Math.floor(maxRaw))) : DEFAULT_TFL_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, [LONDON_CENTER]);
    console.log(`[CCTV] Loaded TfL JamCam sources: ${cameras.length} available (using nearest ${prioritized.length})`);
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] TfL JamCam download error:', error?.message || error);
    return [];
  }
}

/**
 * Load-time URL validation (PR #185, issue #29): a catalog entry's media URLs
 * are fetched BY THE SERVER, so an entry must never aim that fetch at
 * loopback, private/link-local ranges, or a credential-embedded URL. Unsafe
 * values become '' — the camera still lists and renders its synthetic
 * placeholder; it simply has no live frame. The live open-data packs
 * (Austin/Caltrans/TfL) all build https URLs on fixed public origins and
 * pass unchanged.
 * @param {unknown} value Raw url/snapshotUrl field.
 * @returns {string} The URL, or '' when it fails the external-URL policy.
 */
function safeMediaUrl(value) {
  return isSafeExternalHttpUrl(value) ? value : '';
}

/**
 * Normalize a raw CCTV source item into the canonical served shape with safe
 * defaults, so downstream code never sees a missing field. Media URLs pass
 * through {@link safeMediaUrl} (load-time SSRF gate); numeric pose/geometry
 * fields coerce to NaN rather than 0 when absent — NaN is "unknown", 0 would
 * be a wrong-but-plausible camera pose.
 *
 * @param {object} item - Raw source from file, env, or Austin Open Data.
 * @returns {object} Normalized source with every expected field populated.
 */
export function normalizeSourceItem(item) {
  return {
    id: String(item.id || '').trim(),
    name: String(item.name || item.id || '').trim(),
    city: String(item.city || ''),
    cityId: String(item.cityId || ''),
    provider: String(item.provider || 'Configured CCTV Source'),
    lat: toFiniteNumber(item.lat),
    lon: toFiniteNumber(item.lon),
    headingDeg: toFiniteNumber(item.headingDeg),
    headingConfidence: String(item.headingConfidence || item.headingSource || '').toLowerCase(),
    pitchDeg: toFiniteNumber(item.pitchDeg),
    fovDeg: toFiniteNumber(item.fovDeg),
    rangeM: toFiniteNumber(item.rangeM),
    mountHeightM: toFiniteNumber(item.mountHeightM),
    groundElevationM: toFiniteNumber(item.groundElevationM),
    feedType: normalizeFeedType(item.feedType || item.type || ''),
    url: safeMediaUrl(typeof item.url === 'string' ? item.url : ''),
    snapshotUrl: safeMediaUrl(typeof item.snapshotUrl === 'string' ? item.snapshotUrl : ''),
    license: String(item.license || item.licenseNote || ''),
    sourceKind: String(item.sourceKind || item.kind || 'configured'),
    // Optional CAL badge input (cctv-v2 design §3b/§9.2, additive-only per the
    // global constraints — nothing else in this file changes): hand-authored
    // file/env catalog entries may declare poseSource:'curated' so the panel
    // badge can distinguish them from raw automated priors (e.g. Austin Open
    // Data, which never sets this field). Passed through as-is to the client.
    poseSource: item.poseSource === 'curated' ? 'curated' : undefined,
  };
}

/**
 * Parse the `CCTV_SOURCES_JSON` env variable (inline JSON array) into raw
 * source objects. Shared by the dev middleware (which merges in file-backed
 * sources too) and the Pages Function (which has no filesystem), so both
 * runtimes accept exactly the same inline catalog.
 *
 * @param {string|undefined} rawValue - Raw env value, or undefined when unset.
 * @returns {Array<object>} Array of raw source objects, or [] if unset/invalid.
 */
export function parseConfiguredSourcesFromEnv(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Assemble and cache the merged CCTV source list.
 *
 * Merges sources from the injected catalog (config file + env in dev, env
 * only in production) with the three live open-data packs, deduplicates by
 * ID, applies the global max cap, and caches for CCTV_SOURCE_CACHE_MS.
 *
 * @param {object} [options] - Refresh inputs (constant per process/isolate).
 * @param {Array<object>} [options.configuredSources=[]] - Raw source objects
 *   from server-side configuration (dev: config file + CCTV_SOURCES_JSON;
 *   production: CCTV_SOURCES_JSON). Injected because reading a file needs `fs`.
 * @param {object} [options.env={}] - Environment variables (see module
 *   docblock): CCTV_FORCE_AUSTIN, CCTV_PREFER_AUSTIN, CCTV_TFL_ENABLED,
 *   CCTV_MAX_SOURCES and the per-provider caps/URLs.
 * @returns {Promise<Array<object>>} Deduplicated, capped source list.
 */
export async function getCctvSources({ configuredSources = [], env = {} } = {}) {
  const now = Date.now();
  if (_cctvSourceCache.length && now - _cctvSourceCacheAt <= CCTV_SOURCE_CACHE_MS) {
    return _cctvSourceCache;
  }
  // Single-flight: a burst of requests arriving past the TTL shares ONE refresh
  // instead of each launching the full multi-provider refetch. The `.finally`
  // clears the ref so the next post-TTL cycle starts fresh. Options therefore
  // bind on the request that wins the refresh, which is fine in practice: both
  // runtimes pass a constant catalog per process/isolate.
  if (_cctvSourceInflight) return _cctvSourceInflight;
  _cctvSourceInflight = refreshCctvSources({ configuredSources, env }).finally(() => { _cctvSourceInflight = null; });
  return _cctvSourceInflight;
}

/**
 * Assemble and cache the merged CCTV source list from the injected catalog +
 * live packs. Always resolves (loaders self-catch to []); on a fully-empty
 * refresh with a good prior catalog it serves stale rather than blanking the
 * CCTV layer.
 *
 * @param {object} [options] - Refresh inputs.
 * @param {Array<object>} [options.configuredSources=[]] - File/env-backed raw
 *   sources, merged after (and thus overriding) the live packs on id clash.
 * @param {object} [options.env={}] - Provider gate/cap environment variables.
 * @returns {Promise<Array<object>>} Deduplicated, capped source list.
 */
async function refreshCctvSources({ configuredSources = [], env = {} } = {}) {
  const fromConfig = Array.isArray(configuredSources) ? configuredSources : [];

  const forceAustin = String(env.CCTV_FORCE_AUSTIN || '').trim() === '1';
  const preferAustin = String(env.CCTV_PREFER_AUSTIN || '1').trim() !== '0';
  // Live open-data packs (Austin + Caltrans + TfL) load unless a file/env pack
  // is configured and live packs aren't forced — same gate that governed the
  // Austin-only fetch, now governing all three. Each pack fails independently.
  const needsLiveSources = forceAustin || (fromConfig.length === 0 && preferAustin);
  const tflEnabled = String(env.CCTV_TFL_ENABLED || '1').trim() !== '0';

  let fromAustin = [];
  let fromCaltrans = [];
  let fromTfl = [];
  if (needsLiveSources) {
    const [austinResult, caltransResult, tflResult] = await Promise.allSettled([
      loadAustinSourcesFromOpenData(env),
      loadCaltransSourcesFromOpenData(env),
      tflEnabled ? loadTflSourcesFromOpenData(env) : Promise.resolve([]),
    ]);
    fromAustin = austinResult.status === 'fulfilled' ? austinResult.value : [];
    fromCaltrans = caltransResult.status === 'fulfilled' ? caltransResult.value : [];
    fromTfl = tflResult.status === 'fulfilled' ? tflResult.value : [];
  }
  // Live sources first so configured sources override on duplicate IDs (Map last-write).
  const merged = [...fromAustin, ...fromCaltrans, ...fromTfl, ...fromConfig];

  // Deduplicate by camera ID (last-write wins because of Map.set)
  const byId = new Map();
  for (const item of merged) {
    if (!item || typeof item !== 'object') continue;
    const normalized = normalizeSourceItem(item);
    if (!normalized.id) continue;
    byId.set(normalized.id, normalized);
  }

  const mergedSources = Array.from(byId.values());
  const maxRaw = Number(env.CCTV_MAX_SOURCES || DEFAULT_CCTV_MAX_SOURCES);
  const maxCount = Number.isFinite(maxRaw) ? Math.max(8, Math.min(1200, Math.floor(maxRaw))) : DEFAULT_CCTV_MAX_SOURCES;
  if (mergedSources.length > maxCount) {
    console.warn(`[CCTV] source catalog ${mergedSources.length} exceeds cap ${maxCount}; keeping the first ${maxCount} (raise CCTV_MAX_SOURCES or lower a per-pack cap to change which).`);
  }
  const capped = mergedSources.length > maxCount ? mergedSources.slice(0, maxCount) : mergedSources;
  if (capped.length > 0 || _cctvSourceCache.length === 0) {
    _cctvSourceCache = capped;
  } else {
    // Every source came back empty (all live packs timed out / upstream outage)
    // but a good catalog is already cached — serve it stale rather than blanking
    // every CCTV route. Advancing the timestamp waits one TTL before retrying,
    // which (with single-flight) bounds load on a persistently-down upstream.
    console.warn(`[CCTV] source refresh returned empty; serving ${_cctvSourceCache.length} stale cameras`);
  }
  _cctvSourceCacheAt = Date.now();
  return _cctvSourceCache;
}

/**
 * Generate a synthetic SVG billboard image for a CCTV camera placeholder.
 *
 * Produces a 960x540 SVG with a deterministic gradient (hue derived from
 * camera ID hash), scanline overlay, HUD-style grid, and text labels
 * showing camera name, city, ID, status, and current timestamp. Used
 * when no upstream image or Street View fallback is available.
 *
 * @param {object} opts - Placeholder inputs.
 * @param {string} opts.cameraId - Camera id (drives the deterministic hue).
 * @param {string} opts.label - Camera name shown on the billboard.
 * @param {string} [opts.city] - City/region line ('GLOBAL GRID' when absent).
 * @param {string} [opts.status] - Status line ('SYNTHETIC' when absent).
 * @returns {string} SVG markup string.
 */
export function buildSyntheticCctvSvg({ cameraId, label, city, status }) {
  const seed = hashSeed(`${cameraId}:${label}:${city}`);
  const hue = seed % 360;
  const hue2 = (hue + 46) % 360;
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').replace('Z', 'Z').slice(0, 20);
  const safeLabel = escapeXml(label);
  const safeCity = escapeXml(city || 'GLOBAL GRID');
  const safeId = escapeXml(cameraId);
  const safeStatus = escapeXml(status || 'SYNTHETIC');

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 35%, 10%)" />
      <stop offset="60%" stop-color="hsl(${hue2}, 42%, 6%)" />
      <stop offset="100%" stop-color="#020509" />
    </linearGradient>
    <radialGradient id="flare" cx="0.22" cy="0.24" r="0.78">
      <stop offset="0%" stop-color="hsla(${hue2}, 100%, 65%, 0.35)" />
      <stop offset="100%" stop-color="hsla(${hue2}, 100%, 40%, 0)" />
    </radialGradient>
    <pattern id="scan" width="8" height="8" patternUnits="userSpaceOnUse">
      <rect width="8" height="8" fill="transparent" />
      <rect y="0" width="8" height="1" fill="rgba(255,255,255,0.08)" />
      <rect y="4" width="8" height="1" fill="rgba(255,255,255,0.05)" />
    </pattern>
  </defs>
  <rect width="960" height="540" fill="url(#bg)" />
  <rect width="960" height="540" fill="url(#flare)" />
  <rect width="960" height="540" fill="url(#scan)" />
  <g stroke="rgba(123,233,255,0.25)" stroke-width="1" fill="none">
    <path d="M60 460 Q300 300 520 420 T900 320" />
    <path d="M100 160 Q340 40 620 130 T920 90" />
    <path d="M20 280 Q220 230 390 270 T760 250" />
  </g>
  <g fill="none" stroke="rgba(180,248,255,0.2)" stroke-width="1">
    <rect x="70" y="80" width="820" height="380" rx="8" />
    <line x1="70" y1="270" x2="890" y2="270" />
    <line x1="480" y1="80" x2="480" y2="460" />
  </g>
  <g fill="#9cefff" font-family="JetBrains Mono, monospace" text-transform="uppercase">
    <text x="74" y="54" font-size="16" letter-spacing="2">CCTV FEED PLACEHOLDER</text>
    <text x="74" y="512" font-size="14" letter-spacing="1.5">${safeLabel} · ${safeCity}</text>
    <text x="646" y="512" font-size="13" letter-spacing="1.2">${safeId}</text>
    <text x="704" y="54" font-size="15" letter-spacing="2">${escapeXml(ts)}</text>
    <text x="74" y="486" font-size="13" letter-spacing="1.3">${safeStatus}</text>
  </g>
</svg>`.trim();
}

/** Hard ceiling on an upstream that DECLARES a fixed body size. Live
 * MJPEG/HLS streams are unbounded by design and send no content-length, so
 * they pass through normally. */
export const MEDIA_DECLARED_CAP_BYTES = 64 * 1024 * 1024;

/** Hard ceiling for ONE buffered camera snapshot (issue #28). Real snapshots
 *  are 100–500 KB; a hostile or misbehaving upstream that omits
 *  content-length cannot stream gigabytes into isolate memory before the
 *  content-type check ever sees a byte. */
export const CCTV_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** How long the media proxy will WAIT FOR RESPONSE HEADERS from an upstream
 *  stream before aborting (issue #25). Disarmed once headers arrive — a
 *  healthy MJPEG/HLS stream is unbounded by design and must not be killed by
 *  the timer, but a slow/dark upstream must not hold the request forever. */
export const CCTV_STREAM_HEADER_TIMEOUT_MS = 15 * 1000;

/**
 * Read a response body as bytes, refusing bodies larger than `maxBytes` —
 * the byte-level sibling of `readTextCapped` (functions/_upstream.js).
 * Honors a declared content-length for a cheap early exit and otherwise
 * enforces the cap while streaming, cancelling the body past the limit.
 * Worker-safe (ReadableStream reader only — no Node APIs).
 * @param {Response} response - Upstream response to drain.
 * @param {number} maxBytes - Hard ceiling on accepted body size.
 * @returns {Promise<{ok:true,bytes:Uint8Array}|{ok:false}>} Concatenated bytes,
 *   or `{ok:false}` when the body was missing or exceeded the cap.
 */
export async function readBytesCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch { /* no-op */ }
    return { ok: false };
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > maxBytes ? { ok: false } : { ok: true, bytes: new Uint8Array(buffer) };
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      return { ok: false };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

/**
 * Fetch an upstream MEDIA stream URL with a bounded wait for response
 * headers (issue #25 — the stream proxy previously fetched with no timeout
 * at all, so a dark upstream held the client request indefinitely). The
 * abort arms on fetch and MUST be disarmed by the caller once it decides to
 * take the body: `disarm()` stops the timer so a healthy unbounded stream
 * (MJPEG/HLS) is never killed mid-flight. A timeout resolves as
 * `{ ok:false }` exactly like any other upstream miss.
 * @param {string} url Validated upstream media URL.
 * @param {object} [options] - Request shaping + injection points.
 * @param {Record<string,string>} [options.headers] Request headers (Range etc.).
 * @param {number} [options.timeoutMs=CCTV_STREAM_HEADER_TIMEOUT_MS] Header wait budget.
 * @param {typeof fetch} [options.fetchImpl=fetch] Injectable for tests.
 * @returns {Promise<{ok:true, upstream:Response, disarm:()=>void}|{ok:false}>}
 *   Open upstream plus the disarm handle, or `{ok:false}` on timeout/error.
 */
export async function fetchMediaHeadersBounded(url, {
  headers = {},
  timeoutMs = CCTV_STREAM_HEADER_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('CCTV upstream media headers timed out', 'TimeoutError'));
  }, timeoutMs);
  try {
    const upstream = await fetchImpl(url, { headers, signal: controller.signal });
    return { ok: true, upstream, disarm: () => clearTimeout(timer) };
  } catch {
    clearTimeout(timer);
    return { ok: false };
  }
}

/**
 * Build the passthrough status + headers for proxied CCTV media.
 *
 * Forwards Content-Type, Content-Length, Content-Range, Accept-Ranges, and
 * Cache-Control from the upstream, stamps X-CCTV-Source, and rejects an
 * upstream that DECLARES an oversized fixed body.
 *
 * Runtime-neutral by design: the dev middleware pipes to a Node `res` from
 * this result, the Pages Function constructs a web `Response`. The body is
 * deliberately left untouched — callers stream `upstream.body` themselves.
 *
 * @param {Response} upstream - fetch() Response object.
 * @param {object} [opts] - Passthrough options.
 * @param {string} [opts.sourceHeader='upstream'] - Value for X-CCTV-Source header.
 * @returns {{ok:true, status:number, headers:object}
 *   |{ok:false, status:502, error:string}} Passthrough status/headers, or a
 *   502 rejection when the upstream declares an oversized fixed body.
 */
export function buildMediaPassthrough(upstream, { sourceHeader = 'upstream' } = {}) {
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const cacheControl = upstream.headers.get('cache-control') || 'no-store';
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  const acceptRanges = upstream.headers.get('accept-ranges');
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'X-CCTV-Source': sourceHeader,
  };
  if (contentLength) headers['Content-Length'] = contentLength;
  if (contentRange) headers['Content-Range'] = contentRange;
  if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;

  // Cheap defense: reject an upstream that DECLARES an oversized fixed body.
  // Live MJPEG/HLS streams are unbounded by design and send no content-length,
  // so they pass through normally (streamed to the client, never buffered).
  if (Number.isFinite(Number(contentLength)) && Number(contentLength) > MEDIA_DECLARED_CAP_BYTES) {
    return { ok: false, status: 502, error: 'Upstream media exceeds size cap' };
  }

  return { ok: true, status: upstream.status, headers };
}

/**
 * Fetch one upstream CCTV image within the frame-refresh budget.
 *
 * A timeout is treated like every other upstream miss so the caller can
 * continue through the Street View and synthetic fallback chain. `fetchImpl`
 * and `timeoutMs` are injectable only to keep the timeout contract unit-testable.
 *
 * @param {string} url - Server-registered upstream image URL.
 * @param {object} [options] - Injection points for the timeout contract.
 * @param {typeof fetch} [options.fetchImpl=fetch] - Fetch implementation.
 * @param {number} [options.timeoutMs=CCTV_FRAME_FETCH_TIMEOUT_MS] - Abort timeout.
 * @returns {Promise<{ok:true,body:Uint8Array,contentType:string}|null>} Image
 *   bytes + type, or null on any miss (non-image, oversized, error, timeout).
 */
export async function fetchCctvImageFromUpstream(url, {
  fetchImpl = fetch,
  timeoutMs = CCTV_FRAME_FETCH_TIMEOUT_MS,
} = {}) {
  // Last-line defense behind the load-time validation in normalizeSourceItem:
  // a full SSRF gate, not just a scheme check (issue #29).
  if (!isSafeExternalHttpUrl(url)) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('CCTV upstream frame fetch timed out', 'TimeoutError'));
  }, timeoutMs);
  try {
    const upstream = await fetchImpl(url, {
      headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
      signal: controller.signal,
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) return null;
    // Byte cap (issue #28): a lying upstream that omits content-length can
    // no longer buffer unbounded data into the isolate.
    const read = await readBytesCapped(upstream, CCTV_IMAGE_MAX_BYTES);
    if (!read.ok) return null;
    return {
      ok: true,
      body: read.bytes,
      contentType,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch a Google Street View static image as a fallback frame.
 *
 * Requires a server-side key — passed explicitly (this module never reads
 * `process.env`), so a deployment without GOOGLE_MAPS_API_KEY silently skips
 * straight to the synthetic frame instead of failing the request.
 *
 * @param {object} opts - Camera pose + credential.
 * @param {number} opts.lat - Camera latitude in degrees.
 * @param {number} opts.lon - Camera longitude in degrees.
 * @param {number} [opts.heading] - Compass bearing in degrees (default 0).
 * @param {number} [opts.fov] - Horizontal field of view in degrees (20..120).
 * @param {number} [opts.pitch] - Camera pitch in degrees (-40..20).
 * @param {string|undefined} opts.apiKey - GOOGLE_MAPS_API_KEY value.
 * @returns {Promise<{ok:true,body:Uint8Array,contentType:string}|null>} Image
 *   bytes, or null when keyless/out-of-range/timed out.
 */
export async function streetViewFallback({ lat, lon, heading, fov, pitch, apiKey }) {
  // resolveGoogleApiKey: the scaffolded .env placeholder counts as absent, so
  // a placeholder-configured deployment falls through to the synthetic frame
  // instead of requesting frames Google will only 400.
  const streetViewKey = resolveGoogleApiKey(apiKey);
  // Coordinates must be finite AND on the planet — out-of-range requests just
  // earn a Google 400 and a wasted quota call (bbox-clamp sweep, PLAN Phase 7).
  if (!streetViewKey) return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  try {
    const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
    sv.searchParams.set('size', '960x540');
    sv.searchParams.set('location', `${lat},${lon}`);
    sv.searchParams.set('heading', String(Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : 0));
    sv.searchParams.set('fov', String(Number.isFinite(fov) ? Math.max(20, Math.min(120, fov)) : 80));
    sv.searchParams.set('pitch', String(Number.isFinite(pitch) ? Math.max(-40, Math.min(20, pitch)) : 0));
    sv.searchParams.set('source', 'outdoor');
    sv.searchParams.set('return_error_code', 'true');
    sv.searchParams.set('key', streetViewKey);

    const svResp = await fetch(sv.toString(), {
      headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
      signal: AbortSignal.timeout(CCTV_FRAME_FETCH_TIMEOUT_MS),
    });
    const svType = svResp.headers.get('content-type') || '';
    if (!svResp.ok || !svType.startsWith('image/')) return null;

    // Same byte cap as the camera-image path — the caller is trusted
    // (fixed Google origin) but the cap is free and symmetric.
    const read = await readBytesCapped(svResp, CCTV_IMAGE_MAX_BYTES);
    if (!read.ok) return null;

    return {
      ok: true,
      body: read.bytes,
      contentType: svType,
    };
  } catch {
    return null;
  }
}

/**
 * Per-camera health tracker — the same Map the dev middleware kept inside the
 * plugin closure. Created once per process (dev) / isolate (production) so
 * entries survive across requests.
 *
 * @returns {{setHealth:(cameraId:string, patch:object)=>void,
 *            listHealth:()=>Array<object>}} Tracker with a bounded write path
 *   and a snapshot read.
 */
export function createCctvHealthTracker() {
  /** @type {Map<string,{id:string,status:string,sourceKind:string,label:string,message:string,updatedAt:number}>} */
  const health = new Map();
  /** Cap on health map entries to prevent unbounded growth. Sized to cover the
   * full served catalog (CCTV_MAX_SOURCES hard-bounds at 1200) so health/status
   * observability isn't silently evicted for a default 800-camera catalog. */
  const HEALTH_MAX_ENTRIES = 1200;

  /**
   * Update the health entry for a camera, evicting the oldest entry if at
   * capacity.
   * @param {string} cameraId - Camera id keying the health map.
   * @param {object} patch - Partial fields (status/sourceKind/label/message).
   */
  const setHealth = (cameraId, patch) => {
    // Evict oldest entries if the health map grows beyond the cap
    if (!health.has(cameraId) && health.size >= HEALTH_MAX_ENTRIES) {
      const oldest = health.keys().next().value;
      health.delete(oldest);
    }
    const prev = health.get(cameraId) || {};
    health.set(cameraId, {
      id: cameraId,
      status: patch.status || prev.status || 'unknown',
      sourceKind: patch.sourceKind || prev.sourceKind || 'unknown',
      label: patch.label || prev.label || '',
      message: patch.message || prev.message || '',
      updatedAt: Date.now(),
    });
  };

  /**
   * Snapshot all camera health entries as an array.
   * @returns {Array<object>} Health records in insertion order.
   */
  const listHealth = () => Array.from(health.values());

  return { setHealth, listHealth };
}

/**
 * Build a JSON payload describing stream info (feedType, URLs) for a camera.
 *
 * @param {object|undefined} source - Registered source, or undefined when unknown.
 * @param {string} cameraId - Camera id echoed into the payload.
 * @returns {object} Stream info (feedType, media/frame URLs, provider, sourceKind).
 */
export function buildStreamPayload(source, cameraId) {
  const feedType = normalizeFeedType(source?.feedType || 'image');
  return {
    id: cameraId,
    feedType,
    mediaUrl: isVideoFeedType(feedType) ? api.cctvMedia(cameraId) : null,
    frameUrl: api.cctvFrame(cameraId),
    provider: source?.provider || '',
    sourceKind: source?.sourceKind || (source?.url ? 'configured' : 'fallback'),
  };
}
