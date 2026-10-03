/**
 * Pure domain model for the Recent Imagery layer: products, the selection box,
 * per-day candidates, ranking and the keyless URL builders. No DOM, no Cesium,
 * no network.
 */

/** How far back the catalog looks, in UTC days. */
export const CATALOG_DAYS = 30;

const MAX_BOX_SIDE_KM = 1000;
/** ZOOM IN lands where the top-down view is this wide, well inside the cap. */
const FIT_VIEW_KM = 400;
const FIT_HEIGHT_KM = Object.freeze({ min: 5, max: 400 });
/** GIBS EPSG:3857 tiles do not exist beyond the Web-Mercator limit. */
const MERCATOR_LAT_LIMIT = 85.0511;
const MAX_CLOUD_FOR_CLEAR = 20;
const PIN_BOX_SIDE_KM = 10;
const WVS_ENDPOINT = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';
const KM_PER_DEG_LAT = 111.32;
const QUANTUM = 100000;
const DAY_MS = 86_400_000;
const PRODUCT_ORDER = ['S30', 'L30', 'VIIRS'];
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/**
 * Keyless, browser-direct imagery products. HLS products are searched via
 * CMR; the VIIRS overview is a daily global mosaic with no granule catalog.
 * `source` is the on/off group the row chips toggle.
 */
export const PRODUCTS = Object.freeze({
  S30: Object.freeze({
    label: 'HLS S30',
    name: 'Sentinel-2',
    source: 'hls',
    sensor: 'Sentinel-2 via HLS',
    resolutionM: 30,
    gibsLayer: 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance',
    maxLevel: 12,
    format: 'png',
    cmrCollection: 'C2021957295-LPCLOUD',
    overview: false,
  }),
  L30: Object.freeze({
    label: 'HLS L30',
    name: 'Landsat 8/9',
    source: 'hls',
    sensor: 'Landsat 8/9 via HLS',
    resolutionM: 30,
    gibsLayer: 'HLS_L30_Nadir_BRDF_Adjusted_Reflectance',
    maxLevel: 12,
    format: 'png',
    cmrCollection: 'C2021957657-LPCLOUD',
    overview: false,
  }),
  VIIRS: Object.freeze({
    label: 'VIIRS',
    name: 'Daily overview',
    source: 'viirs',
    sensor: 'VIIRS NOAA-21',
    resolutionM: 250,
    gibsLayer: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
    maxLevel: 9,
    format: 'jpg',
    cmrCollection: null,
    overview: true,
  }),
});

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const toRadians = (degrees) => (degrees * Math.PI) / 180;
const pad2 = (value) => String(value).padStart(2, '0');

/**
 * Coerce a box to `{ west, south, east, north }` with south ≤ north. West and
 * east are not swapped: west > east crosses the dateline and `validateBox`
 * rejects it. Null when any edge is nonfinite.
 */
function normalizeBox(box) {
  if (!box || typeof box !== 'object') return null;
  const [west, south, east, north] = [
    box.west,
    box.south,
    box.east,
    box.north,
  ].map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return {
    west,
    south: Math.min(south, north),
    east,
    north: Math.max(south, north),
  };
}

/**
 * Side lengths of a box in km: the box's own longitude span (never the
 * shorter way round the globe) at its mid-latitude, and its latitude span.
 * @param {object} box Degrees box.
 * @returns {{ width: number, height: number }}
 */
export function boxSideKm(box) {
  const normalized = normalizeBox(box);
  if (!normalized) return { width: NaN, height: NaN };
  const midLat = (normalized.south + normalized.north) / 2;
  return {
    width:
      (normalized.east - normalized.west) *
      KM_PER_DEG_LAT *
      Math.cos(toRadians(midLat)),
    height: (normalized.north - normalized.south) * KM_PER_DEG_LAT,
  };
}

const refuse = (reason, message) => ({ ok: false, reason, message });

/**
 * Validate a selection box for the catalog and the tile providers.
 * @param {object} box Degrees box.
 * @returns {{ ok: true, box: object } | { ok: false, reason: 'dateline' | 'polar' | 'degenerate' | 'too-large' | 'invalid', message: string }}
 */
export function validateBox(box) {
  const normalized = normalizeBox(box);
  if (!normalized) return refuse('invalid', 'Box edges must be finite');
  const { west, south, east, north } = normalized;
  if (Math.abs(west) > 180 || Math.abs(east) > 180)
    return refuse('invalid', 'Longitudes must be within ±180°');
  if (west > east) return refuse('dateline', 'Select one side of the dateline');
  if (
    Math.abs(south) > MERCATOR_LAT_LIMIT ||
    Math.abs(north) > MERCATOR_LAT_LIMIT
  )
    return refuse(
      'polar',
      `Imagery stops at ±${MERCATOR_LAT_LIMIT.toFixed(2)}° latitude`,
    );
  if (east === west || north === south)
    return refuse('degenerate', 'Box must enclose an area');
  const { width, height } = boxSideKm(normalized);
  if (width > MAX_BOX_SIDE_KM || height > MAX_BOX_SIDE_KM)
    return refuse('too-large', tooLargeMessage(Math.max(width, height)));
  return { ok: true, box: normalized };
}

const formatKm = (km) => Math.round(Number(km) || 0).toLocaleString('en-US');

// One short line each: the panel's hint says what to do about it.
function tooLargeMessage(sideKm) {
  return `Box is ${formatKm(sideKm)} km wide · limit ${formatKm(MAX_BOX_SIDE_KM)} km`;
}

/** The refusal for USE VIEW when the camera sees more than the cap allows. */
export function viewTooLargeMessage(sideKm) {
  return `View is ${formatKm(sideKm)} km wide · limit ${formatKm(MAX_BOX_SIDE_KM)} km`;
}

/**
 * The camera height, in metres, at which a top-down view is `FIT_VIEW_KM`
 * wide: the horizontal half-angle is atan(tan(fovy / 2) · width / height).
 * Clamped to 5–400 km; without a canvas or FOV, a square 60° view.
 * @param {{ width?: number, height?: number, fovy?: number }} view Canvas size in px, vertical FOV in radians.
 * @returns {number}
 */
export function fitViewHeightM({ width, height, fovy } = {}) {
  const aspect = Number(width) / Number(height);
  const valid =
    Number.isFinite(aspect) && aspect > 0 && fovy > 0 && fovy < Math.PI;
  const halfWidth = valid ? Math.tan(fovy / 2) * aspect : Math.tan(Math.PI / 6);
  const km = FIT_VIEW_KM / (2 * halfWidth);
  return Math.min(FIT_HEIGHT_KM.max, Math.max(FIT_HEIGHT_KM.min, km)) * 1000;
}

/**
 * The centre of a box that does not cross the dateline, in degrees.
 * @param {object} box Degrees box.
 * @returns {{ lon: number, lat: number } | null}
 */
export function boxCentre(box) {
  const normalized = normalizeBox(box);
  if (!normalized) return null;
  return {
    lon: (normalized.west + normalized.east) / 2,
    lat: (normalized.south + normalized.north) / 2,
  };
}

/**
 * A square box centred on a pin, `sideKm` on the ground (the east–west extent
 * widens by 1/cos(lat)); null when the result would not validate.
 * @param {number} lon Degrees.
 * @param {number} lat Degrees.
 * @param {number} [sideKm]
 * @returns {object | null}
 */
export function boxFromPin(lon, lat, sideKm = PIN_BOX_SIDE_KM) {
  if (!finite(lon) || !finite(lat) || !finite(sideKm) || sideKm <= 0)
    return null;
  const cosLat = Math.cos(toRadians(lat));
  if (cosLat <= 0) return null;
  const halfLat = sideKm / 2 / KM_PER_DEG_LAT;
  const halfLon = sideKm / 2 / (KM_PER_DEG_LAT * cosLat);
  const clampLat = (value) =>
    Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, value));
  const result = validateBox({
    west: lon - halfLon,
    south: clampLat(lat - halfLat),
    east: lon + halfLon,
    north: clampLat(lat + halfLat),
  });
  return result.ok ? result.box : null;
}

function mapBox(box, fn) {
  if (!box || typeof box !== 'object') return null;
  return normalizeBox({
    west: fn(box.west),
    south: fn(box.south),
    east: fn(box.east),
    north: fn(box.north),
  });
}

/** Degrees box from a radians rectangle (Cesium `Rectangle` shape). */
export function boxFromRectangle(rectangle) {
  return mapBox(rectangle, (radians) => (Number(radians) * 180) / Math.PI);
}

/** Degrees box → signed integers at degrees × 100000 (the share-link form). */
export function quantizeBox(box) {
  return mapBox(normalizeBox(box), (value) => Math.round(value * QUANTUM));
}

/** Inverse of `quantizeBox`. */
export function dequantizeBox(ints) {
  return mapBox(ints, (value) => Number(value) / QUANTUM);
}

function isValidDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!match) return false;
  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day
  );
}

/**
 * UTC calendar day (`YYYY-MM-DD`) of an ISO timestamp, Date or day string;
 * null when unparseable or not a real day.
 * @param {string | number | Date} value
 * @returns {string | null}
 */
export function utcDay(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return isValidDay(value) ? value : null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toISOString().slice(0, 10)
    : null;
}

/** `Sep 18` for a `YYYY-MM-DD` day; '' otherwise. */
export function shortDay(day) {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return match ? `${MONTHS[Number(match[1]) - 1]} ${Number(match[2])}` : '';
}

/** `17:12` (UTC) for an ISO timestamp; '' when unparseable. */
export function hhmm(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

/** Candidate key: `PRODUCT:YYYY-MM-DD`. */
export function candidateKey(product, day) {
  return `${product}:${day}`;
}

/** Split a candidate key; null when the product is unknown or the day invalid. */
export function parseCandidateKey(key) {
  const match = /^(S30|L30|VIIRS):(\d{4}-\d{2}-\d{2})$/.exec(String(key));
  if (!match || !isValidDay(match[2])) return null;
  return { product: match[1], day: match[2] };
}

const cloudOf = (granule) => (finite(granule?.cloud) ? granule.cloud : null);

function buildCandidate(product, day, granules) {
  const clouds = granules.map(cloudOf).filter((value) => value !== null);
  const starts = granules
    .map((granule) => Date.parse(granule.timeStart))
    .filter(Number.isFinite);
  const ends = granules
    .map((granule) => Date.parse(granule.timeEnd ?? granule.timeStart))
    .filter(Number.isFinite);
  return {
    key: candidateKey(product, day),
    product,
    day,
    granules,
    cloud: clouds.length
      ? { min: Math.min(...clouds), max: Math.max(...clouds) }
      : null,
    timeRange:
      starts.length && ends.length
        ? {
            start: new Date(Math.min(...starts)).toISOString(),
            end: new Date(Math.max(...ends)).toISOString(),
          }
        : null,
    availability: granules.length ? 'present' : 'empty',
    coverage: 'unknown',
  };
}

/**
 * Group granules into one candidate per product and UTC day of `timeStart`,
 * newest first. Granules without a known product or start time are dropped.
 * @param {Array<object>} granules
 * @returns {Array<object>}
 */
export function groupGranulesByDay(granules) {
  const buckets = new Map();
  for (const granule of Array.isArray(granules) ? granules : []) {
    const day = utcDay(granule?.timeStart);
    if (!PRODUCTS[granule?.product] || !day) continue;
    const key = candidateKey(granule.product, day);
    if (!buckets.has(key))
      buckets.set(key, { product: granule.product, day, granules: [] });
    buckets.get(key).granules.push(granule);
  }
  return mergeCandidates([
    [...buckets.values()].map(({ product, day, granules: list }) =>
      buildCandidate(product, day, list),
    ),
  ]);
}

/**
 * One VIIRS overview candidate per UTC day for the last `days` days, today
 * first. Availability stays unknown until the thumbnail probe answers;
 * coverage is full because the overview is a global mosaic.
 * @param {string | Date} todayIso
 * @param {number} [days]
 * @returns {Array<object>}
 */
export function viirsCandidates(todayIso, days = CATALOG_DAYS) {
  const today = utcDay(todayIso);
  if (!today) return [];
  const start = Date.parse(`${today}T00:00:00Z`);
  const out = [];
  for (let i = 0; i < Math.max(0, Math.trunc(days)); i += 1) {
    const day = new Date(start - i * DAY_MS).toISOString().slice(0, 10);
    out.push({
      key: candidateKey('VIIRS', day),
      product: 'VIIRS',
      day,
      granules: [],
      cloud: null,
      timeRange: null,
      availability: 'unknown',
      coverage: 'full',
    });
  }
  return out;
}

/**
 * Merge candidate lists newest day first, then S30, L30, VIIRS; the first
 * occurrence of a key wins.
 * @param {Array<Array<object>>} lists
 * @returns {Array<object>}
 */
export function mergeCandidates(lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const candidate of list || []) {
      if (candidate?.key && !byKey.has(candidate.key))
        byKey.set(candidate.key, candidate);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.day !== b.day
      ? a.day < b.day
        ? 1
        : -1
      : PRODUCT_ORDER.indexOf(a.product) - PRODUCT_ORDER.indexOf(b.product),
  );
}

function pointInPolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * How much of the box a candidate's granule footprints cover, sampled at the
 * four corners and the centre: `full`, `partial`, or `unknown` without
 * footprints.
 * @param {object} candidate
 * @param {object} box Degrees box.
 * @returns {'full' | 'partial' | 'unknown'}
 */
export function coverageFor(candidate, box) {
  const normalized = normalizeBox(box);
  const footprints = (candidate?.granules || [])
    .map((granule) => granule?.footprint)
    .filter((ring) => Array.isArray(ring) && ring.length >= 3);
  if (!normalized || !footprints.length) return 'unknown';
  const { west, south, east, north } = normalized;
  const samples = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [(west + east) / 2, (south + north) / 2],
  ];
  return samples.every(([lon, lat]) =>
    footprints.some((ring) => pointInPolygon(lon, lat, ring)),
  )
    ? 'full'
    : 'partial';
}

/**
 * Pick the START HERE day. Coverage first: a present HLS day that covers the
 * whole box (`full`, or `unknown` without footprints) beats a newer sliver at
 * the box edge, which changes none of the frame when draped. Within a tier
 * the newest day whose granules ALL have known cloud ≤ `maxCloud` wins
 * (`clear`), else the newest (`cloudy`); only slivers left → `partial`; else
 * the newest non-empty VIIRS day (`overview`). `certain` is false when the
 * catalog was truncated.
 * @param {Array<object>} candidates
 * @param {{ maxCloud?: number, truncated?: boolean }} [options]
 * @returns {{ candidate: object | null, reason: 'clear' | 'cloudy' | 'partial' | 'overview' | null, certain: boolean }}
 */
export function rankLatest(
  candidates,
  { maxCloud = MAX_CLOUD_FOR_CLEAR, truncated = false } = {},
) {
  const sorted = mergeCandidates([candidates]);
  const certain = !truncated;
  const present = (c) => c.availability !== 'empty';
  const hlsDay = (c) =>
    PRODUCTS[c.product] &&
    !PRODUCTS[c.product].overview &&
    present(c) &&
    c.granules.length > 0;
  const coversBox = (c) => c.coverage !== 'partial';
  const clearSky = (c) =>
    c.granules.every((granule) => {
      const cloud = cloudOf(granule);
      return cloud !== null && cloud <= maxCloud;
    });
  const tiers = [
    [(c) => hlsDay(c) && coversBox(c) && clearSky(c), 'clear'],
    [(c) => hlsDay(c) && coversBox(c), 'cloudy'],
    [(c) => hlsDay(c) && clearSky(c), 'partial'],
    [hlsDay, 'partial'],
    [(c) => c.product === 'VIIRS' && present(c), 'overview'],
  ];
  for (const [matches, reason] of tiers) {
    const candidate = sorted.find(matches);
    if (candidate) return { candidate, reason, certain };
  }
  return { candidate: null, reason: null, certain };
}

function daysAgoLabel(day, now) {
  const today = utcDay(now);
  if (!today) return null;
  const delta = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) /
      DAY_MS,
  );
  if (delta <= 0) return 'today';
  return delta === 1 ? 'yesterday' : `${delta} days ago`;
}

function cloudLabel(cloud) {
  if (!cloud) return 'cloud unknown';
  const min = Math.round(cloud.min);
  const max = Math.round(cloud.max);
  return min === max ? `${min}% scene cloud` : `${min}–${max}% scene cloud`;
}

/**
 * One-line UTC readout, e.g.
 * `Sep 18, 2026 17:12Z · 3 days ago · Sentinel-2 via HLS · 30 m · 12% scene cloud`.
 * @param {object} candidate
 * @param {string | number | Date} [now]
 * @returns {string}
 */
export function formatCandidateReadout(candidate, now = new Date()) {
  const product = PRODUCTS[candidate?.product];
  if (!product || !candidate?.day) return '';
  const [y, m, d] = candidate.day.split('-').map(Number);
  let when = `${MONTHS[m - 1]} ${d}, ${y}`;
  if (candidate.timeRange?.start) {
    const start = hhmm(candidate.timeRange.start);
    const end = candidate.timeRange.end ? hhmm(candidate.timeRange.end) : start;
    when +=
      (candidate.granules?.length || 0) > 1 && end !== start
        ? ` ${start}–${end}Z`
        : ` ${start}Z`;
  }
  const parts = [when];
  const ago = daysAgoLabel(candidate.day, now);
  if (ago) parts.push(ago);
  parts.push(product.sensor, `${product.resolutionM} m`);
  if (product.overview) parts.push('overview');
  parts.push(cloudLabel(candidate.cloud));
  return parts.join(' · ');
}

/**
 * GIBS WMTS REST template with `{s}`, `{z}`, `{y}`, `{x}` placeholders (y
 * precedes x in the GIBS path).
 * @param {string} product
 * @param {string} day `YYYY-MM-DD`
 * @returns {string}
 */
export function gibsTemplate(product, day) {
  const spec = PRODUCTS[product];
  if (!spec) throw new TypeError(`Unknown imagery product: ${product}`);
  return `https://gibs-{s}.earthdata.nasa.gov/wmts/epsg3857/best/${spec.gibsLayer}/default/${day}/GoogleMapsCompatible_Level${spec.maxLevel}/{z}/{y}/{x}.${spec.format}`;
}

/**
 * Worldview Snapshots URL for a thumbnail or export. EPSG:4326 BBOX order is
 * lat,lon: `south,west,north,east`.
 * @param {{ product: string, day: string, box: object, width: number, height: number, format?: string }} request
 * @returns {string}
 */
export function wvsSnapshotUrl({
  product,
  day,
  box,
  width,
  height,
  format = 'image/png',
}) {
  const spec = PRODUCTS[product];
  const normalized = normalizeBox(box);
  if (!spec) throw new TypeError(`Unknown imagery product: ${product}`);
  if (!normalized) throw new TypeError('A finite box is required');
  const bbox = [
    normalized.south,
    normalized.west,
    normalized.north,
    normalized.east,
  ]
    .map((value) => String(Number(value.toFixed(6))))
    .join(',');
  return (
    `${WVS_ENDPOINT}?REQUEST=GetSnapshot&LAYERS=${spec.gibsLayer}` +
    `&CRS=EPSG:4326&TIME=${day}&BBOX=${bbox}` +
    `&WIDTH=${Math.round(width)}&HEIGHT=${Math.round(height)}&FORMAT=${format}`
  );
}

/**
 * Thumbnail load order: the focused card (clamped into the visible range),
 * the visible cards outward from it, then `extra` cards beyond each edge.
 * @param {number} focusIndex
 * @param {number} firstVisible
 * @param {number} lastVisible
 * @param {number} total
 * @param {number} [extra]
 * @returns {number[]}
 */
export function thumbnailOrder(
  focusIndex,
  firstVisible,
  lastVisible,
  total,
  extra = 2,
) {
  const count = Math.max(0, Math.trunc(total));
  if (!count) return [];
  const clamp = (value) => Math.max(0, Math.min(count - 1, Math.trunc(value)));
  const first = clamp(Math.min(firstVisible, lastVisible));
  const last = clamp(Math.max(firstVisible, lastVisible));
  const focus = Math.max(first, Math.min(last, clamp(focusIndex)));
  const order = [];
  const push = (index) => {
    if (index >= 0 && index < count && !order.includes(index))
      order.push(index);
  };
  push(focus);
  for (let step = 1; step <= last - first; step += 1) {
    if (focus + step <= last) push(focus + step);
    if (focus - step >= first) push(focus - step);
  }
  for (let step = 1; step <= Math.max(0, Math.trunc(extra)); step += 1) {
    push(last + step);
    push(first - step);
  }
  return order;
}
