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
 * `defaultEnabled` is separate from being registered. A feed ships switched ON
 * only when its operator's own published terms were READ and plainly cover this
 * use. A registered feed with `defaultEnabled: false` is never polled and never
 * offered to the browser; it is here so the decision is visible and reversible
 * in one line. `terms` records the passage that decision rests on, so the next
 * reader does not have to take the licence string on faith.
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
 * TTC BusTime is the SURFACE feed: buses and streetcars, never the subway.
 * Streetcar routes are the 500-series, plus the four Blue Night routes that
 * run on streetcar trackage (301 Queen, 304 King, 306 Carlton, 310 Spadina);
 * the rest of the 300-series is night buses.
 * @param {string|null} routeId
 * @returns {string}
 */
function ttcRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (/^5\d\d$/.test(routeId)) return 'tram';
  if (/^(301|304|306|310)$/.test(routeId)) return 'tram';
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
    historyRetention: true,
    name: 'MBTA',
    operator: 'Massachusetts Bay Transportation Authority',
    region: 'Boston, MA',
    center: Object.freeze({ lat: 42.3601, lon: -71.0589 }),
    loadRadiusKm: 70,
    url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    license: 'MassDOT Developers License Agreement',
    licenseUrl:
      'https://cdn.mbta.com/sites/default/files/2023-08/mbta-massdot-develop-license-agreement.pdf',
    attribution: 'MBTA / MassDOT',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'MassDOT ... hereby grants You (Licensee) non-exclusive, limited, and revocable rights to use, reproduce, and redistribute the Data. ... Clearly acknowledge MassDOT as the provider of the Data.',
      note: 'Credit is text only: the agreement forbids using MBTA/MassDOT logos or trademarks with the data.',
    }),
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
    license: 'CapMetro Developer Tools license',
    licenseUrl: 'https://www.capmetro.org/developertools',
    attribution:
      'Capital Metropolitan Transportation Authority — data.texas.gov',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Capital Metropolitan Transportation Authority (CMTA) hereby grants you (Licensee) non-exclusive, limited and revocable rights to use, reproduce, and redistribute CMTA Data.',
      note: 'CMTA trademarks may not be used in association with the data, so the credit is the operator name as text.',
    }),
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
    license: 'Public Metro Transit vehicle position data',
    licenseUrl: 'https://svc.metrotransit.org/',
    attribution: 'Metro Transit — Metropolitan Council',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        "Metro Transit's GTFS-realtime feeds are refreshed every 5 seconds.",
      note: 'The realtime feed is published from a developer page carrying operational guidance and no licence text of its own. The public-domain statement below belongs to the Metropolitan Council metadata for the COMPANION SCHEDULE dataset, not to this feed: "None. This dataset is public domain under the Minnesota Government Data Practices Act". Credited as a courtesy, the way the other public agency feeds are.',
    }),
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
    defaultEnabled: true,
    terms: Object.freeze({
      quote: null,
      note: 'The open-data page refuses automated readers (HTTP 403, bot protection), so this entry rests on the owner opening it and accepting it rather than on a passage quoted here. HSL publishes its open data under CC BY 4.0 and asks to be credited as the source; the feed needs no key.',
    }),
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
    license: 'Free to use per the OVapi README (best effort, no SLA)',
    licenseUrl: 'https://gtfs.ovapi.nl/README',
    attribution:
      'OVapi / Stichting OpenGeo — Dutch integrated real-time transit data',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'You are free to use this data, but there is no service level agreement (best-effort) nor are you allowed to say you represent or impersonate any of the transit agencies listed here.',
      note: 'The README asks consumers to identify themselves in the User-Agent, to send If-Modified-Since / If-None-Match when polling faster than once a minute, and to accept gzip. The proxy does all three.',
    }),
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
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'This API is open under NLOD licence, however, it is required that all consumers identify themselves by using the header ET-Client-Name.',
      note: 'The header is mandatory — unidentified consumers may be rate-limited or blocked — and the proxy sends it on every request.',
    }),
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
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Our data is licensed under a Creative Commons Attribution 4.0 International License. ... You must not represent that the State in any way endorses your Application.',
      note: 'No key, no stated rate limit, no caching rule. Logos and network imagery need separate approval, so the credit is text only.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'ttc-toronto',
    name: 'TTC',
    operator: 'Toronto Transit Commission',
    region: 'Toronto, ON',
    center: Object.freeze({ lat: 43.6532, lon: -79.3832 }),
    loadRadiusKm: 45,
    url: 'https://bustime.ttc.ca/gtfsrt/vehicles',
    license: 'Open Government Licence \u2013 Toronto',
    licenseUrl: 'https://open.toronto.ca/open-data-licence/',
    attribution:
      'Toronto Transit Commission \u2014 City of Toronto Open Data (Open Government Licence \u2013 Toronto)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Information Provider grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes ... Acknowledge the source of the Information by including any attribution statement specified by the Information Provider.',
      note: 'The City publishes this endpoint from the TTC BusTime NVAS catalogue entry, whose own licence field reads \"License not specified\"; the quote above is the portal-wide Open Government Licence \u2013 Toronto the City applies to its open data, so the credit carries the licence name the way the Metro Transit entry carries its public-domain note. BusTime is the surface system: buses and streetcars report real positions, the subway reports none, so Lines 1/2/4 are simply absent rather than inferred. The endpoint sends no ETag or Last-Modified, so conditional requests fall through to the proxy snapshot TTL.',
    }),
    defaultMode: 'bus',
    // Toronto rides streetcars. The vehicles are the shared `tram` mode and
    // share its silhouette and speed limits; only the word a reader sees
    // changes, because "tram" is not what anyone at Queen and Spadina says.
    modeWords: Object.freeze({
      tram: Object.freeze({ word: 'Streetcar', abbr: 'STREETCAR' }),
    }),
    routeMode: ttcRouteMode,
  }),
]);

/**
 * The feeds this build actually polls. A registered feed that is not here is
 * inert everywhere: it resolves to no route, is never offered to the browser,
 * and never appears in a coverage check.
 */
export const TRANSIT_ENABLED_FEEDS = Object.freeze(
  TRANSIT_FEED_REGISTRY.filter((feed) => feed.defaultEnabled === true),
);

const FEED_BY_ID = new Map(
  TRANSIT_ENABLED_FEEDS.map((feed) => [feed.id, feed]),
);
const ANY_FEED_BY_ID = new Map(
  TRANSIT_FEED_REGISTRY.map((feed) => [feed.id, feed]),
);

/** Feed ids are path segments: lowercase letters, digits, hyphens only. */
export const TRANSIT_FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Look up a POLLABLE feed by id. Unknown ids, malformed ids, and feeds that are
 * registered but switched off all return null — this is the only door from a
 * request path to an upstream URL, so a feed the owner has not cleared must not
 * be reachable through it.
 * @param {string} id
 * @returns {object|null}
 */
export function getTransitFeed(id) {
  if (typeof id !== 'string' || !TRANSIT_FEED_ID_PATTERN.test(id)) return null;
  return FEED_BY_ID.get(id) || null;
}

/**
 * Look up any registered feed, enabled or not. For credits and documentation
 * only — never for resolving a request into an upstream fetch.
 * @param {string} id
 * @returns {object|null}
 */
export function getRegisteredTransitFeed(id) {
  if (typeof id !== 'string' || !TRANSIT_FEED_ID_PATTERN.test(id)) return null;
  return ANY_FEED_BY_ID.get(id) || null;
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
  return TRANSIT_ENABLED_FEEDS.map((feed) => ({
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
 * Whether the mode came from the route id rather than the feed's default. A
 * default is a guess about a fleet — TransLink's is "bus" while it publishes
 * rail in the same feed — so a consumer judging physical plausibility must
 * not hold a defaulted vehicle to a bus's limits.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId
 * @returns {boolean}
 */
export function transitModeResolved(feed, routeId) {
  const hinted =
    typeof feed?.routeMode === 'function' ? feed.routeMode(routeId) : null;
  return (
    Boolean(hinted) && hinted !== 'unknown' && TRANSIT_MODES.includes(hinted)
  );
}

/**
 * Public catalog shape served by `/api/transit/feeds` — everything the browser
 * needs to gate polling and credit the source, and nothing it could misuse.
 * @returns {object[]}
 */
export function publicTransitCatalog() {
  return TRANSIT_ENABLED_FEEDS.map((feed) => ({
    id: feed.id,
    name: feed.name,
    operator: feed.operator,
    region: feed.region,
    center: { ...feed.center },
    loadRadiusKm: feed.loadRadiusKm,
    license: feed.license,
    licenseUrl: feed.licenseUrl,
    attribution: feed.attribution,
    historyRetention: feed.historyRetention === true,
  }));
}
