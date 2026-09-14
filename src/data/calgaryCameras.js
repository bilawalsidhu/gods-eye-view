/**
 * @module calgaryCameras
 *
 * Pure converters for the City of Calgary traffic-camera catalog (Open Calgary
 * Socrata dataset `k7p9-kppz`, ~214 cameras). Imported by the CCTV source
 * loader in `vite.config.js` the way `firmsCsv.js` and `directionText.js` are,
 * so the parsing stays unit-testable outside the dev server.
 *
 * Keyless: the catalog and the frames are both public.
 *
 * TWO THINGS THIS FILE EXISTS TO GET RIGHT.
 *
 * 1. NO HEADING MAY BE INFERRED FROM THE RECORD. Every Calgary camera carries a
 *    `quadrant` field ("NE", "NW", "SE", "SW") and a `camera_location` that ends
 *    in the same token ("9 Avenue / 3 Street SE"). Neither is a camera facing —
 *    it is Calgary's address quadrant, the half of the postal grid the
 *    intersection sits in. Feeding either to `directionToHeading()` returns a
 *    confident compass bearing for all ~214 cameras, and all ~214 would be
 *    wrong: "9 Avenue / 3 Street SE" would aim southeast purely because the
 *    intersection is in the city's southeast. This is the same trap
 *    `directionText.js` documents for street names containing cardinal words
 *    (59 of ~1000 Austin cameras hit it in the maintainer's 2026-07-04 review),
 *    and Calgary hits it on every single row. So headings come from the shared
 *    id-hash fallback with `headingConfidence: 'low'`, exactly as TfL JamCams
 *    do, and the operator corrects them with the calibration gizmo.
 *
 * 2. THE FRAME URL MUST BE UPGRADED AND PINNED. The dataset publishes
 *    `http://trafficcam.calgary.ca/loc86.jpg`. That host serves HTTPS correctly
 *    and 301-redirects HTTP to it, so the scheme is upgraded before the URL is
 *    registered. Only URLs on that exact origin are accepted — same
 *    official-bucket pin the TfL pack applies — so a future catalog edit cannot
 *    steer the frame proxy at an arbitrary host.
 */

/** The only origin Calgary camera frames may come from. */
export const CALGARY_IMAGE_ORIGIN = 'https://trafficcam.calgary.ca/';

/** Downtown Calgary (Centre Street / 7 Avenue) — the prioritization anchor. */
export const CALGARY_DOWNTOWN = Object.freeze({ lat: 51.0461, lon: -114.0626 });

/**
 * Calgary's municipal extent with slack. A record outside this is a source
 * fault, not a camera — the same bounding-box guard the Austin loader applies.
 */
const CALGARY_BOUNDS = Object.freeze({
  minLat: 50.8,
  maxLat: 51.25,
  minLon: -114.4,
  maxLon: -113.8,
});

/**
 * Is this coordinate plausibly a Calgary traffic camera?
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isLikelyCalgaryCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= CALGARY_BOUNDS.minLat &&
    lat <= CALGARY_BOUNDS.maxLat &&
    lon >= CALGARY_BOUNDS.minLon &&
    lon <= CALGARY_BOUNDS.maxLon
  );
}

/**
 * Upgrade a catalog frame URL to HTTPS and pin it to the official origin.
 *
 * The dataset ships `http://`; the host answers HTTPS and redirects HTTP there,
 * so upgrading avoids a pointless redirect on every frame fetch. Anything not on
 * the official origin is refused outright rather than proxied.
 *
 * @param {string|null|undefined} raw - `camera_url.url` from the dataset.
 * @returns {string|null} Pinned HTTPS URL, or null when unusable.
 */
export function normalizeCalgaryImageUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.protocol = 'https:';
  const upgraded = parsed.toString();
  return upgraded.startsWith(CALGARY_IMAGE_ORIGIN) ? upgraded : null;
}

/**
 * Derive a stable camera id from its frame URL.
 *
 * The dataset has no id column; the frame filename ("loc86.jpg") is the only
 * stable per-camera token, and it is what the city itself keys on. Falls back
 * to a slug of the whole path so a filename-scheme change degrades to a
 * still-stable id rather than dropping the camera.
 *
 * @param {string} imageUrl - A normalized Calgary frame URL.
 * @returns {string|null} Provider-stable id, or null when underivable.
 */
export function calgaryCameraId(imageUrl) {
  const text = String(imageUrl ?? '').trim();
  if (!text) return null;
  let path;
  try {
    path = new URL(text).pathname;
  } catch {
    return null;
  }
  const numbered = path.match(/loc(\d+)\.jpg$/i);
  if (numbered) return `calgary-${numbered[1]}`;
  const slug = path
    .replace(/^\/+|\.[a-z0-9]+$/gi, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
  return slug ? `calgary-${slug}` : null;
}

/**
 * Human-readable camera name.
 *
 * `camera_location` is the intersection ("Bow Trail / 37 Street SW") and is what
 * an operator recognises, so it is used verbatim — including its quadrant
 * suffix, which is part of the street address and belongs in the NAME. It must
 * never be parsed for a facing direction; see the module header.
 *
 * @param {object} record - Raw Socrata row.
 * @param {string} cameraId - Derived stable id.
 * @returns {string}
 */
export function calgaryCameraName(record, cameraId) {
  const location = String(record?.camera_location ?? '').trim();
  if (location) return location;
  const described = String(record?.camera_url?.description ?? '').trim();
  if (described) return described;
  return `Calgary Camera ${String(cameraId).replace(/^calgary-/, '')}`;
}

/**
 * Convert Socrata rows into normalized CCTV source records.
 *
 * Rows that cannot yield coordinates, a pinned frame URL, or a stable id are
 * skipped — one unusable row is not evidence the catalog is broken. Duplicate
 * ids collapse to the first occurrence.
 *
 * @param {Array<object>} rows - Parsed `k7p9-kppz` JSON rows.
 * @param {object} options
 * @param {(id: string) => number} options.fallbackHeading - Id-hash heading source.
 * @returns {Array<object>} Normalized CCTV source records.
 */
export function toCalgaryCameraSources(rows, { fallbackHeading }) {
  if (!Array.isArray(rows)) return [];
  if (typeof fallbackHeading !== 'function') {
    throw new TypeError(
      'toCalgaryCameraSources requires a fallbackHeading function',
    );
  }
  const cameras = [];
  const seen = new Set();
  for (const record of rows) {
    if (!record || typeof record !== 'object') continue;
    const coordinates = record?.point?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const lon = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!isLikelyCalgaryCoordinate(lat, lon)) continue;

    const imageUrl = normalizeCalgaryImageUrl(record?.camera_url?.url);
    if (!imageUrl) continue;
    const cameraId = calgaryCameraId(imageUrl);
    if (!cameraId || seen.has(cameraId)) continue;
    seen.add(cameraId);

    cameras.push({
      id: cameraId,
      name: calgaryCameraName(record, cameraId),
      city: 'Calgary',
      cityId: 'calgary',
      provider: 'The City of Calgary',
      lat,
      lon,
      // No facing signal exists in this dataset. `quadrant` and the name's
      // quadrant suffix are Calgary's address grid, not a camera bearing —
      // see the module header before "improving" this.
      headingDeg: fallbackHeading(cameraId),
      headingConfidence: 'low',
      pitchDeg: -16,
      fovDeg: 48,
      rangeM: 160,
      mountHeightM: 8,
      // Calgary sits high on the prairie; the one-shot ground snap corrects it.
      groundElevationM: 1045,
      feedType: 'image',
      url: imageUrl,
      snapshotUrl: imageUrl,
      sourceKind: 'calgary-open-data',
      license:
        'Contains information licensed under the Open Government Licence – City of Calgary',
    });
  }
  return cameras;
}
