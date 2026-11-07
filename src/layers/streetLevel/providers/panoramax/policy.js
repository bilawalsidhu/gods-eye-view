import { COLORS as SHARED_COLORS, PROVIDER_COLORS } from '../../policy.js';
import { msg } from '../../../../i18n/index.js';

export { NEAREST_RADIUS_M } from '../../policy.js';

/** Identity and tuning for the Panoramax street-level provider (keyless). */
export const PANORAMAX_PROVIDER_ID = 'panoramax';
export const PANORAMAX_NAME = 'Panoramax';
export const PANORAMAX_LABEL = 'PANORAMAX';

/**
 * The Panoramax meta-catalogue: one keyless, CORS-enabled STAC API over
 * every federated instance (OpenStreetMap France, IGN, MapComplete…). Its
 * pictures are served by the instance that holds them.
 */
export const PANORAMAX_API = 'https://api.panoramax.xyz/api';
/** The meta-catalogue's web viewer, where the caption link goes. */
const PANORAMAX_VIEWER = 'https://api.panoramax.xyz/';

/** Stable id prefixes for picked primitives; every one starts with `pnx:`. */
export const PICK_PREFIX = Object.freeze({
  root: 'pnx:',
  sequence: 'pnx:seq:',
  image: 'pnx:img:',
});

export const COLORS = Object.freeze({
  coverage: PROVIDER_COLORS.panoramax,
  selected: SHARED_COLORS.selected,
});

/**
 * Sequence lines come from z7–15 tiles; z10–14 are drawn below 60 km, as
 * Mapillary's are (a dense tile over Paris: z10 ~2.1 MB and 8,600
 * sequences, z11 ~1.4 MB, z12 ~800 kB). Higher up nothing is drawn.
 */
export const COVERAGE_Z14_BELOW_M = 1_800;
export const COVERAGE_Z13_BELOW_M = 5_000;
export const COVERAGE_Z12_BELOW_M = 12_000;
export const COVERAGE_Z11_BELOW_M = 30_000;
export const COVERAGE_LINES_BELOW_M = 60_000;
export const COVERAGE_TUNING = Object.freeze({
  maxTiles: 9,
  // Each tile draws at most 1,600 lines, its longest first (as decoded,
  // `keepOrder`): a dense z11
  // tile over Paris holds 3,800, and a lower cap left the city centre
  // looking emptier than its suburbs. (KartaView draws as many.)
  maxSequences: 14_400,
  keepOrder: true,
  // Points drawn at most, over every tile, a ninth of it a tile (each
  // becomes ~8 ground-line vertices, ~1.4 kB of geometry): the simplified
  // Paris z10 tile alone holds 57,000, unsimplified 750,000, which hung
  // the tab.
  maxPoints: 90_000,
  lineWidthPx: 2.5,
  moveDebounceMs: 320,
  viewRangeMinM: 2_500,
  viewRangePerHeight: 10,
});
/**
 * Lines are simplified (Douglas–Peucker) to this many tile units of a
 * 4,096 extent: about a pixel where each zoom is drawn (1.6 m at z14,
 * within GPS noise), and 6–10% of the points GPS tracks carry.
 */
export const SIMPLIFY_TOLERANCE_UNITS = 4;

/**
 * Coverage tiles decode in slices of this many ms, the page getting a turn
 * between them (decode.js `decodeCoverageTileSliced`): under a frame.
 */
export const DECODE_SLICE_MS = 8;

export const RATE_LIMITED_MESSAGE = msg(
  'Panoramax is busy — coverage resumes on its own',
);
export const NO_COVERAGE_HINT = msg('no Panoramax photos in view');
/** Lines in view, all hidden by the imagery filter. */
export const FILTERED_HINT = msg('no Panoramax photos here match the filters');
export const UNREADABLE_TILE_MESSAGE = msg(
  'Panoramax sent a map tile that could not be read',
);
export const GONE_MESSAGE = msg('This Panoramax photo is no longer available');
/** Above the line ceiling nothing is drawn. */
export const ZOOM_IN_HINT = msg('zoom in to see Panoramax coverage');

/** Cones come from z15 tiles' `pictures` layer (~110 bytes a picture). */
export const PICTURE_TILE_ZOOM = 15;
/** Within this of a z15 tile's edge, the neighbouring tile's pictures join. */
export const PICTURE_TILE_EDGE_M = 150;

export const TILE_TIMEOUT_MS = 20_000;
/**
 * Once an answer has started, it may take as long as it keeps coming: a
 * 2 MB tile on a slow link outlasts any whole-request timeout, so only a
 * stream silent this long is given up.
 */
export const STREAM_IDLE_TIMEOUT_MS = 15_000;
/** Busy (429/503) without a Retry-After the browser can read: back off from this. */
export const BUSY_BACKOFF_BASE_SEC = 5;
export const API_TIMEOUT_MS = 12_000;
/** Real tiles are under 6 MB (z6 over France); refuse anything absurd. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/**
 * The meta-catalogue speaks HTTP/1.1 only, so the browser opens six
 * connections to it: coverage tiles take three, searches two and the
 * cones' tiles one, so a click's lookup never queues behind megabyte tiles
 * (it timed out doing so).
 */
export const API_CONCURRENCY = 2;
export const TILE_CONCURRENCY = 3;
/** The selected sequence's z15 tiles (cones) take the sixth. */
export const PICTURE_TILE_CONCURRENCY = 1;

/** Pictures asked for around a point; the API returns them nearest first. */
export const NEAREST_LIMIT = 10;
/**
 * The widest the API allows: the point may be beside a picture, but a
 * picture looking away from it is still left out (the bounding-box search
 * beside it has those).
 */
export const NEAREST_FOV_TOLERANCE_DEG = 180;
/**
 * Pictures in the bounding box around a click, at most. The API returns
 * them roughly nearest first (the first ten of 100 are the first ten of
 * 10), and the browser ranks them exactly: 20 is ~60 kB, 100 ~600 kB.
 */
export const NEAREST_BOX_LIMIT = 20;
/**
 * A line clicked from high up may be tens of metres off the click: its
 * sequence is searched within the camera height / 100 (50–400 m).
 */
export const LINE_CLICK_RADIUS_PER_HEIGHT = 0.01;
export const LINE_CLICK_RADIUS_MAX_M = 400;

/** A full-resolution panorama is only fetched up to this width (memory). */
export const PANO_HD_MAX_WIDTH = 8_192;
/** An HD panorama can be several megabytes. */
export const HD_TIMEOUT_MS = 30_000;
/** Panoramax's SD derivative is 2,048 px wide, its thumbnail 500 px. */
export const SD_WIDTH = 2_048;

/** On-globe credit: licences are per picture, named in the caption. */
export const PANORAMAX_CREDIT_HTML =
  'Street Level: imagery © <a href="https://panoramax.fr" target="_blank" rel="noopener">Panoramax</a> contributors, licence per picture';

export const LINE_CLICK_HINT = 'click a line for its nearest photo';

/** Licence ids Panoramax uses, as the caption names them. */
const LICENSE_LABELS = Object.freeze({
  'CC-BY-SA-4.0': 'CC BY-SA 4.0',
  'CC-BY-4.0': 'CC BY 4.0',
  'CC0-1.0': 'CC0',
  'etalab-2.0': 'Licence Ouverte 2.0',
});

/** The caption's licence name for a STAC licence id, or null. */
export function licenseLabel(license) {
  if (typeof license !== 'string' || !license.trim()) return null;
  const id = license.trim();
  if (id === 'proprietary' || id === 'other') return null;
  return LICENSE_LABELS[id] || id.slice(0, 40);
}

/** Deep link to a picture in the Panoramax web viewer. */
export function panoramaxPictureUrl(pictureId) {
  const id = String(pictureId ?? '').trim();
  if (!id) return PANORAMAX_VIEWER;
  return `${PANORAMAX_VIEWER}#${new URLSearchParams({ pic: id, focus: 'pic' })}`;
}

/** Epoch ms for a capture time ('2023-12-12T07:54:47+00:00', '2023-12-12 07:56:37+00'), or null. */
export function panoramaxTimeMs(value) {
  if (typeof value !== 'string' || !value) return null;
  // Tile timestamps are Postgres text: a space and an hour-only offset.
  const iso = /\d[T ]\d/.test(value)
    ? value
        .replace(' ', 'T')
        .replace(/([+-]\d{2})$/, '$1:00')
        .replace(/\.(\d{3})\d+/, '.$1')
    : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > Date.UTC(1990, 0, 1) ? ms : null;
}

/** An https address, or null (asset links come from federated instances). */
function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Last path segment of an item's `rel` link: the linked picture's id. */
function linkedId(item, rel) {
  const href = item?.links?.find?.((link) => link?.rel === rel)?.href;
  if (typeof href !== 'string') return null;
  const id = href.split(/[?#]/)[0].split('/').filter(Boolean).pop();
  if (!id) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    // A malformed escape is no link, not a failed lookup.
    return null;
  }
}

/**
 * An email address anywhere in a name, at any of its '@'s. Linear: names
 * come from any instance, and each run between '@'s is scanned once.
 */
function looksLikeEmail(name) {
  return /[^\s@]@[^\s@]+\.[^\s@]/.test(name);
}

/**
 * Who took the picture. Producers are account names, and some accounts
 * are named by an email address: those are not repeated in the caption.
 */
function creatorOf(item) {
  const props = item.properties || {};
  const names = [
    props['geovisio:producer'],
    ...(Array.isArray(item.providers)
      ? item.providers
          .filter((p) => p?.roles?.includes?.('producer'))
          .map((p) => p.name)
      : []),
  ];
  // Every producer is credited (an uploading app and its photographer),
  // each name once, none that is an email address.
  const credited = [];
  const seen = new Set();
  for (const value of names) {
    if (typeof value !== 'string') continue;
    const name = value.trim().slice(0, 80);
    if (!name || looksLikeEmail(value)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    credited.push(name);
  }
  return credited.length ? credited.join(', ').slice(0, 120) : null;
}

/** The federated instance holding a picture (its `via` link's host), or null. */
function instanceOf(item) {
  const href = item?.links?.find?.((link) => link?.rel === 'via')?.href;
  try {
    const url = new URL(String(href));
    return url.protocol === 'https:' ? url.hostname.slice(0, 80) : null;
  } catch {
    return null;
  }
}

/** A 360° picture: a full-sphere field of view or an equirectangular projection. */
export function isEquirectangular(item) {
  const props = item?.properties || {};
  const orientation = props['pers:interior_orientation'];
  if (Number(orientation?.field_of_view) >= 360) return true;
  return props['pers:projection'] === 'equirectangular';
}

/**
 * A STAC item (from search or a collection) in the shape the provider and
 * viewer use, or null without an id or a position.
 * @returns {{id: string, sequenceId: string|null, lon: number, lat: number, heading: number|null, isPano: boolean, capturedAt: number|null, creator: string|null, license: string|null, width: number|null, prevId: string|null, nextId: string|null, urls: {thumb: string|null, sd: string|null, hd: string|null}}|null}
 */
export function normalizeItem(item) {
  if (!item || item.id == null) return null;
  // Only numbers: Number(null) and Number('') would put a picture at 0,0.
  const [lon, lat] = Array.isArray(item.geometry?.coordinates)
    ? item.geometry.coordinates.map((value) =>
        typeof value === 'number' ? value : NaN,
      )
    : [NaN, NaN];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const props = item.properties || {};
  const assets = item.assets || {};
  const azimuth =
    props['view:azimuth'] === '' || props['view:azimuth'] == null
      ? NaN
      : Number(props['view:azimuth']);
  const width = Number(
    props['pers:interior_orientation']?.sensor_array_dimensions?.[0],
  );
  return {
    id: String(item.id),
    sequenceId: item.collection != null ? String(item.collection) : null,
    lon,
    lat,
    heading: Number.isFinite(azimuth) ? ((azimuth % 360) + 360) % 360 : null,
    isPano: isEquirectangular(item),
    capturedAt: panoramaxTimeMs(props.datetime),
    creator: creatorOf(item),
    // Licences ask for the source to be named: where no author can be
    // named, the caption names the instance holding the picture.
    via: instanceOf(item),
    license: licenseLabel(props.license),
    width: Number.isFinite(width) && width > 0 ? width : null,
    prevId: linkedId(item, 'prev'),
    nextId: linkedId(item, 'next'),
    urls: {
      thumb: httpsUrl(assets.thumb?.href),
      sd: httpsUrl(assets.sd?.href),
      hd: httpsUrl(assets.hd?.href),
    },
  };
}
