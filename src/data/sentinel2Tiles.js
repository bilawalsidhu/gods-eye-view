/**
 * @file Pure request shaping for the "Sentinel-2 Latest" map source.
 *
 * Shared by the `/api/sentinel2` vite plugin (server-side: tile validation,
 * Process API and Catalog API request bodies, scene selection) and the
 * browser imagery factory (zoom limits). Zero dependencies, Cesium-free, so
 * both sides can unit-test against it with node:test.
 *
 * Upstream: Copernicus Data Space Ecosystem (CDSE) Sentinel Hub.
 *   Process API  https://sh.dataspace.copernicus.eu/process/v1
 *   Catalog API  https://sh.dataspace.copernicus.eu/catalog/v1/search
 *
 * Tiles are standard Web Mercator XYZ (y grows southward). Each tile is one
 * 256×256 Process API request over the tile's EPSG:3857 bbox: true colour
 * (B04, B03, B02), Sentinel-2 L2A, the trailing 30 UTC days, scenes at most
 * 20 % cloudy, least-cloudy scene on top (`mosaickingOrder: leastCC`).
 *
 * @module data/sentinel2Tiles
 */

/** @const {string} CDSE OAuth token endpoint (client-credentials grant). */
export const SENTINEL_HUB_TOKEN_URL =
  'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
/** @const {string} CDSE Process API endpoint. */
export const SENTINEL_HUB_PROCESS_URL =
  'https://sh.dataspace.copernicus.eu/process/v1';
/** @const {string} CDSE Catalog API (STAC) search endpoint. */
export const SENTINEL_HUB_CATALOG_URL =
  'https://sh.dataspace.copernicus.eu/catalog/v1/search';
/** @const {ReadonlySet<string>} The only origins the proxy ever contacts. */
export const SENTINEL_HUB_ORIGINS = Object.freeze(
  new Set([
    new URL(SENTINEL_HUB_TOKEN_URL).origin,
    new URL(SENTINEL_HUB_PROCESS_URL).origin,
  ]),
);

/**
 * Lowest tile zoom fetched. Below it a tile covers a whole region, which is
 * expensive to mosaic and adds nothing a global basemap does not already
 * show, so the Esri basemap underneath carries the far view.
 * @const {number}
 */
export const SENTINEL2_MIN_ZOOM = 8;
/**
 * Highest tile zoom fetched: z14 is ~9.6 m/px at the equator, the closest
 * Web Mercator level to Sentinel-2's 10 m native resolution. Anything deeper
 * would be upsampled 10 m pixels that cost quota and add no detail.
 * @const {number}
 */
export const SENTINEL2_MAX_ZOOM = 14;
/**
 * Cesium terrain levels the draped layer is shown at. Terrain level N is
 * textured by imagery around level N+1, so this window shows z8-z14 imagery
 * with at most one level of upscaling; outside it the Esri basemap
 * underneath shows instead of blurry stretched pixels.
 * @const {{min: number, max: number}}
 */
export const SENTINEL2_TERRAIN_LEVELS = Object.freeze({ min: 7, max: 14 });

/** @const {number} Trailing acquisition window, in UTC days. */
export const SENTINEL2_WINDOW_DAYS = 30;
/** @const {number} Per-scene cloud-cover ceiling, in percent. */
export const SENTINEL2_MAX_CLOUD = 20;
/** @const {number} Output tile edge, in pixels. */
export const SENTINEL2_TILE_SIZE = 256;

/**
 * CDSE's free "Copernicus General" quota is 10,000 requests and 10,000
 * processing units per month (300 of each per minute). One 256×256 3-band
 * PNG costs 0.25 PU, so the REQUEST count is the binding limit. 300 per UTC
 * day keeps a 31-day month at 9,300 requests (tiles + scene lookups), inside
 * the free allowance with headroom.
 * https://documentation.dataspace.copernicus.eu/Quotas.html
 * @const {number}
 */
export const SENTINEL2_DEFAULT_DAILY_BUDGET = 300;

const WEB_MERCATOR_HALF = 20037508.342789244;
const DAY_MS = 86_400_000;

/**
 * True-colour evalscript. `dataMask` becomes the PNG alpha so pixels with no
 * qualifying scene stay transparent and the basemap underneath shows through
 * instead of a black hole. The 2.5 gain is Sentinel Hub's standard true-colour
 * stretch for L2A reflectance.
 * @const {string}
 */
export const SENTINEL2_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B03", "B02", "dataMask"] }],
    output: { bands: 4, sampleType: "AUTO" }
  };
}
function evaluatePixel(s) {
  return [2.5 * s.B04, 2.5 * s.B03, 2.5 * s.B02, s.dataMask];
}`;

/**
 * Validate a z/x/y coordinate against the Sentinel-2 zoom window.
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function isValidSentinel2Tile(z, x, y) {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y))
    return false;
  if (z < SENTINEL2_MIN_ZOOM || z > SENTINEL2_MAX_ZOOM) return false;
  const n = 2 ** z;
  return x >= 0 && x < n && y >= 0 && y < n;
}

/**
 * EPSG:3857 bbox of a slippy tile, as [minX, minY, maxX, maxY] metres.
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {number[]}
 */
export function tileToMercatorBBox(z, x, y) {
  const size = (2 * WEB_MERCATOR_HALF) / 2 ** z;
  const minX = -WEB_MERCATOR_HALF + x * size;
  const maxY = WEB_MERCATOR_HALF - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

/**
 * The trailing acquisition window, aligned to whole UTC days so every
 * request made on one day asks for the same window (and caches the same).
 * @param {number} [nowMs]
 * @returns {{from: string, to: string}} ISO-8601 instants.
 */
export function sentinel2TimeRange(nowMs = Date.now()) {
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return {
    from: new Date(dayStart - SENTINEL2_WINDOW_DAYS * DAY_MS).toISOString(),
    to: new Date(dayStart + DAY_MS - 1000).toISOString(),
  };
}

/**
 * Process API request body for one tile.
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @param {number} [nowMs]
 * @returns {object}
 */
export function buildSentinel2ProcessRequest(z, x, y, nowMs = Date.now()) {
  return {
    input: {
      bounds: {
        bbox: tileToMercatorBBox(z, x, y),
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/3857' },
      },
      data: [
        {
          type: 'sentinel-2-l2a',
          dataFilter: {
            timeRange: sentinel2TimeRange(nowMs),
            maxCloudCoverage: SENTINEL2_MAX_CLOUD,
            mosaickingOrder: 'leastCC',
          },
        },
      ],
    },
    output: {
      width: SENTINEL2_TILE_SIZE,
      height: SENTINEL2_TILE_SIZE,
      responses: [{ identifier: 'default', format: { type: 'image/png' } }],
    },
    evalscript: SENTINEL2_EVALSCRIPT,
  };
}

/**
 * Snap a lon/lat to a 0.1° cell so nearby camera positions share one scene
 * lookup (and one cache entry). Returns null for out-of-range input.
 * @param {number} lon
 * @param {number} lat
 * @returns {{key: string, lon: number, lat: number} | null}
 */
export function quantizeScenePoint(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -85 || lat > 85) return null;
  const cellLon = Math.min(3599, Math.floor((lon + 180) * 10));
  const cellLat = Math.min(1699, Math.floor((lat + 85) * 10));
  return {
    key: `${cellLon}:${cellLat}`,
    lon: Number(((cellLon + 0.5) / 10 - 180).toFixed(2)),
    lat: Number(((cellLat + 0.5) / 10 - 85).toFixed(2)),
  };
}

/**
 * Catalog API search body: scenes over a small box at the point, inside the
 * same window and cloud ceiling the tiles use.
 * @param {number} lon
 * @param {number} lat
 * @param {number} [nowMs]
 * @returns {object}
 */
export function buildSentinel2CatalogSearch(lon, lat, nowMs = Date.now()) {
  const { from, to } = sentinel2TimeRange(nowMs);
  const d = 0.001;
  return {
    bbox: [lon - d, lat - d, lon + d, lat + d],
    datetime: `${from}/${to}`,
    collections: ['sentinel-2-l2a'],
    limit: 100,
    filter: `eo:cloud_cover <= ${SENTINEL2_MAX_CLOUD}`,
    'filter-lang': 'cql2-text',
  };
}

/**
 * Pick the scene `mosaickingOrder: leastCC` puts on top: lowest tile cloud
 * cover, newest first on a tie. Features with an unusable date or cloud value
 * are skipped.
 * @param {unknown} features Catalog API `features` array.
 * @returns {{date: string, datetime: string, cloudCover: number} | null}
 */
export function pickLeastCloudyScene(features) {
  let best = null;
  for (const feature of Array.isArray(features) ? features : []) {
    const datetime = feature?.properties?.datetime;
    const cloudCover = Number(feature?.properties?.['eo:cloud_cover']);
    const at = Date.parse(datetime);
    if (typeof datetime !== 'string' || !Number.isFinite(at)) continue;
    if (!Number.isFinite(cloudCover) || cloudCover > SENTINEL2_MAX_CLOUD)
      continue;
    if (
      !best ||
      cloudCover < best.cloudCover ||
      (cloudCover === best.cloudCover && at > best.at)
    ) {
      best = { at, datetime, cloudCover };
    }
  }
  if (!best) return null;
  return {
    date: new Date(best.at).toISOString().slice(0, 10),
    datetime: new Date(best.at).toISOString(),
    cloudCover: Math.round(best.cloudCover * 10) / 10,
  };
}

/**
 * Copernicus attribution for the imagery on screen. The Copernicus Sentinel
 * data legal notice asks for "Contains modified Copernicus Sentinel data
 * [Year]"; the 30-day window can straddle New Year, so both years are named
 * then.
 * @param {number} [nowMs]
 * @returns {string} Credit markup.
 */
export function sentinel2AttributionHtml(nowMs = Date.now()) {
  const { from, to } = sentinel2TimeRange(nowMs);
  const first = from.slice(0, 4);
  const last = to.slice(0, 4);
  const years = first === last ? last : `${first}–${last}`;
  return (
    `Contains modified Copernicus Sentinel data ${years}, processed by ` +
    '<a href="https://dataspace.copernicus.eu" target="_blank" rel="noopener">Copernicus Data Space Ecosystem</a> ' +
    'Sentinel Hub (ESA)'
  );
}
