/**
 * @module transitFeeds
 * @description Registry of keyless, openly licensed GTFS-Realtime
 * VehiclePositions feeds the Transit layer can show.
 *
 * Every entry here is a URL the SERVER fetches — the browser only ever asks
 * `/api/transit/vehicles/<id>` for a registered id (see SECURITY.md: proxies
 * never fetch client-supplied URLs). Adding a feed means adding a row here,
 * a DATA_SOURCES.md row with its license, and a credit in dataCredits.js.
 *
 * Admission rules for a feed:
 *  - No key, token, or registration required (identify-yourself headers are
 *    fine — Entur asks for `ET-Client-Name`, OVapi for a User-Agent).
 *  - An open license that permits display with attribution.
 *  - Real coordinates in VehiclePosition.position — NYCT subway, for example,
 *    publishes stop-relative positions only and is deliberately absent.
 *
 * Pure data + pure helpers: imported by the browser layer, the Vite proxy, and
 * node:test. No Cesium, no Node built-ins.
 */

/** Transit modes the layer colors. `routeMode` hints refine a feed's default. */
export const TRANSIT_MODES = Object.freeze([
  'bus',
  'tram',
  'subway',
  'rail',
  'ferry',
  'unknown',
]);

/** Per-mode icon used in labels and the selection card. */
export const TRANSIT_MODE_ICON = Object.freeze({
  bus: '🚌',
  tram: '🚊',
  subway: '🚇',
  rail: '🚆',
  ferry: '⛴️',
  unknown: '🚏',
});

/**
 * MBTA route ids are human-readable and mode-typed: rapid-transit lines carry
 * colour names, commuter rail is prefixed `CR-`, ferries `Boat-`, buses are
 * numeric (or `SL`/`CT` express families).
 * @param {string|null} routeId
 * @returns {string}
 */
function mbtaRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (/^(Red|Orange|Blue)\b/.test(routeId)) return 'subway';
  if (/^(Green|Mattapan)/.test(routeId)) return 'tram';
  if (/^CR-/.test(routeId)) return 'rail';
  if (/^Boat-/.test(routeId)) return 'ferry';
  if (/^Shuttle/i.test(routeId)) return 'bus';
  return 'bus';
}

/**
 * Entur (Norway) route ids are `<codespace>:Line:<local-id>`; the codespace
 * tells the operator, not the mode, but a few are single-mode operators.
 * @param {string|null} routeId
 * @returns {string}
 */
function enturRouteMode(routeId) {
  if (!routeId) return 'unknown';
  const codespace = routeId.split(':')[0];
  if (
    codespace === 'VYG' ||
    codespace === 'GJB' ||
    codespace === 'SJN' ||
    codespace === 'FLT' ||
    codespace === 'GOA' ||
    codespace === 'NSB' ||
    codespace === 'VYT'
  )
    return 'rail';
  if (codespace === 'FLB') return 'rail';
  return 'bus';
}

/**
 * HSL route ids start with a four-digit code whose first digit is the mode
 * family in HSL's numbering: 1xxx/2xxx… are trams (1001–1010) for 4-digit ids
 * beginning with `10`, metro routes are `31M…`, ferries `1019`.
 * @param {string|null} routeId
 * @returns {string}
 */
function hslRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (/^31M/.test(routeId)) return 'subway';
  if (/^10(0[1-9]|10|15)/.test(routeId)) return 'tram';
  if (/^1019/.test(routeId)) return 'ferry';
  if (/^300[0-9A-Z]/.test(routeId)) return 'rail';
  return 'bus';
}

/**
 * Metro Transit (Minneapolis–St Paul): light rail is the Blue/Green line
 * (route ids 901/902), Northstar commuter rail is 888.
 * @param {string|null} routeId
 * @returns {string}
 */
function metroTransitRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (routeId === '901' || routeId === '902') return 'tram';
  if (routeId === '888') return 'rail';
  return 'bus';
}

/**
 * Registry of feeds. Order is presentation order in the stats/credit text.
 * `loadRadiusKm` is the distance from `center` inside which the feed is polled.
 * @type {ReadonlyArray<Readonly<{
 *   id: string, name: string, operator: string, region: string,
 *   center: {lat: number, lon: number}, loadRadiusKm: number,
 *   url: string, headers?: Record<string, string>,
 *   license: string, licenseUrl: string, attribution: string,
 *   defaultMode: string, routeMode?: (routeId: string|null) => string,
 * }>>}
 */
export const TRANSIT_FEED_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'mbta',
    name: 'MBTA',
    operator: 'Massachusetts Bay Transportation Authority',
    region: 'Boston, MA',
    center: Object.freeze({ lat: 42.3601, lon: -71.0589 }),
    loadRadiusKm: 70,
    url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    license: 'MassDOT Developers License Agreement',
    licenseUrl: 'https://www.mbta.com/developers/gtfs-realtime',
    attribution: 'MBTA / MassDOT',
    defaultMode: 'bus',
    routeMode: mbtaRouteMode,
  }),
  Object.freeze({
    id: 'capmetro-austin',
    name: 'CapMetro',
    operator: 'Capital Metropolitan Transportation Authority',
    region: 'Austin, TX',
    center: Object.freeze({ lat: 30.2672, lon: -97.7431 }),
    loadRadiusKm: 60,
    url: 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream',
    license: 'Texas Open Data Portal terms of use',
    licenseUrl:
      'https://data.texas.gov/Transportation/CapMetro-Vehicle-Positions-PB-File/eiei-9rpf',
    attribution:
      'Capital Metropolitan Transportation Authority — data.texas.gov',
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'metrotransit-msp',
    name: 'Metro Transit',
    operator: 'Metro Transit (Metropolitan Council)',
    region: 'Minneapolis–St Paul, MN',
    center: Object.freeze({ lat: 44.9778, lon: -93.265 }),
    loadRadiusKm: 70,
    url: 'https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb',
    license: 'Public domain (Minnesota Government Data Practices Act)',
    licenseUrl: 'https://svc.metrotransit.org/',
    attribution: 'Metro Transit — Metropolitan Council',
    defaultMode: 'bus',
    routeMode: metroTransitRouteMode,
  }),
  Object.freeze({
    id: 'hsl-helsinki',
    name: 'HSL',
    operator: 'Helsinki Region Transport (HSL)',
    region: 'Helsinki, Finland',
    center: Object.freeze({ lat: 60.1699, lon: 24.9384 }),
    loadRadiusKm: 70,
    url: 'https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl',
    license: 'CC BY 4.0',
    licenseUrl: 'https://www.hsl.fi/en/hsl/open-data',
    attribution: 'HSL (Helsinki Region Transport)',
    defaultMode: 'bus',
    routeMode: hslRouteMode,
  }),
  Object.freeze({
    id: 'ovapi-nl',
    name: 'OVapi',
    operator: 'Stichting OpenGeo (NDOV data)',
    region: 'Netherlands',
    center: Object.freeze({ lat: 52.2, lon: 5.3 }),
    loadRadiusKm: 220,
    url: 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb',
    license: 'CC0 (OVapi README: free to use, best effort)',
    licenseUrl: 'https://gtfs.ovapi.nl/README',
    attribution:
      'OVapi / Stichting OpenGeo — Dutch integrated real-time transit data',
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'entur-norway',
    name: 'Entur',
    operator: 'Entur AS (Norwegian national transit data)',
    region: 'Norway',
    // Circle chosen to hold Oslo, Bergen, Bodø and Tromsø while leaving
    // Helsinki (≈820 km) out — a national feed must not poll from next door.
    center: Object.freeze({ lat: 64.0, lon: 11.5 }),
    loadRadiusKm: 720,
    url: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions',
    headers: Object.freeze({ 'ET-Client-Name': 'gods-eye-view-transit' }),
    license: 'Norwegian Licence for Open Government Data (NLOD)',
    licenseUrl: 'https://developer.entur.org/pages-intro-authentication',
    attribution: 'Entur — data under NLOD',
    defaultMode: 'bus',
    routeMode: enturRouteMode,
  }),
  Object.freeze({
    id: 'translink-seq',
    name: 'TransLink',
    operator: 'TransLink (Queensland Government)',
    region: 'South East Queensland, Australia',
    center: Object.freeze({ lat: -27.4698, lon: 153.0251 }),
    loadRadiusKm: 150,
    url: 'https://gtfsrt.api.translink.com.au/api/realtime/seq/VehiclePositions',
    license: 'CC BY 4.0',
    licenseUrl: 'https://translink.com.au/about-translink/open-data',
    attribution: 'TransLink — Queensland Government (CC BY 4.0)',
    defaultMode: 'bus',
  }),
]);

const FEED_BY_ID = new Map(
  TRANSIT_FEED_REGISTRY.map((feed) => [feed.id, feed]),
);

/** Feed ids are path segments: lowercase letters, digits, hyphens only. */
export const TRANSIT_FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Look up a registered feed by id. Unknown or malformed ids return null —
 * this is the only door from a request path to an upstream URL.
 * @param {string} id
 * @returns {object|null}
 */
export function getTransitFeed(id) {
  if (typeof id !== 'string' || !TRANSIT_FEED_ID_PATTERN.test(id)) return null;
  return FEED_BY_ID.get(id) || null;
}

/**
 * Great-circle distance in km.
 * @param {number} aLat
 * @param {number} aLon
 * @param {number} bLat
 * @param {number} bLon
 * @returns {number}
 */
export function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Feeds whose coverage circle contains the point, nearest first.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [slackKm=0] Extra radius (hysteresis) so a feed at the edge
 *   of coverage does not flap on small camera moves.
 * @returns {object[]}
 */
export function transitFeedsInRange(lat, lon, slackKm = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return TRANSIT_FEED_REGISTRY.map((feed) => ({
    feed,
    km: haversineKm(lat, lon, feed.center.lat, feed.center.lon),
  }))
    .filter(({ feed, km }) => km <= feed.loadRadiusKm + Math.max(0, slackKm))
    .sort((a, b) => a.km - b.km)
    .map(({ feed }) => feed);
}

/**
 * Mode for a vehicle: the feed's route hint when it has one, else its default.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId GTFS route_id from the vehicle's trip.
 * @returns {string} One of TRANSIT_MODES.
 */
export function transitModeFor(feed, routeId) {
  const hinted =
    typeof feed?.routeMode === 'function' ? feed.routeMode(routeId) : null;
  const mode =
    hinted && hinted !== 'unknown' ? hinted : feed?.defaultMode || 'unknown';
  return TRANSIT_MODES.includes(mode) ? mode : 'unknown';
}

/**
 * Public catalog shape served by `/api/transit/feeds` — everything the browser
 * needs to gate polling and credit the source, and nothing it could misuse.
 * @returns {object[]}
 */
export function publicTransitCatalog() {
  return TRANSIT_FEED_REGISTRY.map((feed) => ({
    id: feed.id,
    name: feed.name,
    operator: feed.operator,
    region: feed.region,
    center: { ...feed.center },
    loadRadiusKm: feed.loadRadiusKm,
    license: feed.license,
    licenseUrl: feed.licenseUrl,
    attribution: feed.attribution,
  }));
}
