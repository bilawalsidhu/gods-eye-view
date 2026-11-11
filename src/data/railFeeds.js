import { greatCircleKm } from '../geoDistance.js';

/**
 * @module railFeeds
 * @description Registry of the live train feeds the Rail layer shows (GPS
 * positions, or Irish Rail's station reports, with trip updates where the
 * operator publishes them), with the licence or other basis each is used on,
 * and the rules that sort each feed's vehicles into service categories.
 *
 * Every entry is a URL the SERVER fetches: the browser only ever asks
 * `/api/rail/trains/<id>` for a registered id (SECURITY.md: proxies never fetch
 * client-supplied URLs). Adding a feed means adding a row here, a
 * DATA_SOURCES.md row with its licence, and a credit in dataCredits.js.
 *
 * `defaultEnabled` is true when the operator's published terms were read and
 * cover this use, or, where the operator publishes no licence or terms at
 * all, on the basis the entry records: a project owner decision to use the
 * data without a published licence, which is never presented as a licence
 * (DATA_SOURCES.md, "Rail"). A feed also needs real coordinates: no train is
 * placed or moved from a timetable. `terms` records the passage the decision
 * rests on; an empty `quote` means there is no published text to quote, and
 * its `note` says why. A registered feed that is switched off is never polled
 * and never offered to the browser.
 *
 * Every feed is keyless: its realtime feed and its static timetable are
 * published for anyone to fetch. Values are shown as the source gives them:
 * positions where the operator reports them, and, once a host has built a
 * feed's optional pack (scripts/build-rail-paths.mjs), route lines from the
 * operator's own shapes.
 *
 * Many operators publish trains in the same feed as their buses. A feed's
 * `classify` decides, per vehicle, whether it is a train at all and which
 * category it belongs to; anything it returns null for is dropped before the
 * snapshot leaves the server, so the browser never sees a bus.
 *
 * Pure data + pure helpers: imported by the browser layer, the Vite proxy, and
 * node:test. No Cesium, no Node built-ins.
 */

/**
 * Service categories, narrowest first. `transit` is rail inside the urban
 * fabric (metro, light rail, tram); `local` is suburban and commuter rail and
 * short branch lines; `regional` stays inside one state or province;
 * `national` crosses one; `international` crosses a national border.
 */
export const RAIL_CATEGORIES = Object.freeze([
  'transit',
  'local',
  'regional',
  'national',
  'international',
]);

/**
 * What runs on the track, for the icon: `rail` (main-line trains), `metro`
 * (grade-separated urban rail), `tram` (light rail and streetcars).
 */
export const RAIL_MODES = Object.freeze(['rail', 'metro', 'tram']);

/**
 * Where a feed's positions come from, which the layer states to the user:
 * `gps` (the train reports where it is) or `event` (the train was last seen
 * at a station or timing point by the signalling system, not tracked between
 * them).
 */
export const RAIL_POSITION_SOURCES = Object.freeze(['gps', 'event']);

/** One classified train: the category the layer filters on and the icon mode. */
function train(category, mode) {
  return Object.freeze({ category, mode });
}
const LOCAL_RAIL = train('local', 'rail');
const REGIONAL_RAIL = train('regional', 'rail');
const NATIONAL_RAIL = train('national', 'rail');
const INTERNATIONAL_RAIL = train('international', 'rail');
const TRANSIT_METRO = train('transit', 'metro');
const TRANSIT_TRAM = train('transit', 'tram');

/** Every vehicle in a rail-only feed is the same kind of train. */
function always(kind) {
  return () => kind;
}

/**
 * Irish Rail province of each terminus an InterCity train can start or end
 * at. Northern Ireland stations are `NI`: a train with one end there and the
 * other in the Republic (the Enterprise) is international.
 */
const IRISH_RAIL_PROVINCE = new Map(
  [
    [
      'Leinster',
      [
        'Dublin Heuston',
        'Dublin Connolly',
        'Dublin Pearse',
        'Grand Canal Dock',
        'Drogheda',
        'Dundalk',
        'Maynooth',
        'Kildare',
        'Newbridge',
        'Hazelhatch',
        'Portlaoise',
        'Portarlington',
        'Ballybrophy',
        'Athy',
        'Carlow',
        'Kilkenny',
        'Wexford',
        'Rosslare Europort',
        'Rosslare Strand',
        'Gorey',
        'Arklow',
        'Wicklow',
        'Greystones',
        'Bray',
        'Athlone',
        'Mullingar',
        'Longford',
        'Tullamore',
      ],
    ],
    [
      'Munster',
      [
        'Cork',
        'Cobh',
        'Midleton',
        'Mallow',
        'Tralee',
        'Killarney',
        'Limerick',
        'Limerick Junction',
        'Ennis',
        'Waterford',
        'Thurles',
        'Nenagh',
        'Roscrea',
        'Clonmel',
        'Charleville',
      ],
    ],
    [
      'Connacht',
      [
        'Galway',
        'Athenry',
        'Westport',
        'Ballina',
        'Manulla Junction',
        'Sligo',
        'Carrick on Shannon',
        'Roscommon',
        'Claremorris',
      ],
    ],
    [
      'NI',
      [
        'Belfast',
        'Belfast Grand Central',
        'Belfast Lanyon Place',
        'Lisburn',
        'Portadown',
        'Newry',
      ],
    ],
  ].flatMap(([province, stations]) =>
    stations.map((station) => [station.toLowerCase(), province]),
  ),
);

/**
 * Irish Rail trains, from the train code and the route the adapter builds
 * from the public message (`<origin> - <destination>`). Code prefixes, as
 * published by the Irish Rail realtime API: `E` DART and `D`/`P` Commuter
 * (both local), `A`/`B` InterCity. An InterCity train is national when its
 * two ends are in different provinces, regional when both are in the same
 * province (Mallow–Tralee, Limerick–Limerick Junction), and international
 * when one end is in Northern Ireland (the Enterprise, Dublin–Belfast). An
 * InterCity train whose ends are not both known stays national, the
 * operator's own grouping. Any other prefix is an Irish Rail passenger train
 * of an unknown kind and is shown as local.
 */
function irishRailTrain(routeId, context) {
  // A train matched to its pack run: the pack route id carries the code
  // letter and the scope (irishRailTripRename).
  const scoped = scopedRoute(routeId);
  if (scoped) return irishRailPackTrain(scoped);
  const code = String(context?.tripId ?? '');
  if (!/^[A-Z]\d{1,4}$/.test(code)) return null;
  const prefix = code[0];
  if (prefix !== 'A' && prefix !== 'B') return LOCAL_RAIL;
  const [from, to] = String(routeId ?? '')
    .split(' - ')
    .map((name) => IRISH_RAIL_PROVINCE.get(name.trim().toLowerCase()));
  if ((from === 'NI') !== (to === 'NI')) return INTERNATIONAL_RAIL;
  if (from && to && from === to) return REGIONAL_RAIL;
  return NATIONAL_RAIL;
}

/** Route ids mapped to a kind; any other route (a bus) is dropped. */
function byRoute(table) {
  const routes = new Map(Object.entries(table));
  return (routeId) => routes.get(String(routeId ?? '')) ?? null;
}

/**
 * MBTA route ids are mode-typed: commuter rail is `CR-*`, heavy rapid transit
 * is Red/Orange/Blue, the Green Line branches and the Mattapan trolley are
 * light rail. Buses, ferries and shuttles are dropped.
 */
function mbtaTrain(routeId) {
  const id = String(routeId ?? '');
  if (/^CR-/.test(id)) return LOCAL_RAIL;
  if (/^(Red|Orange|Blue)$/.test(id)) return TRANSIT_METRO;
  if (/^(Green-[BCDE]|Mattapan)$/.test(id)) return TRANSIT_TRAM;
  return null;
}

/**
 * RTD Denver: commuter rail is the A Line plus the 113 and 117 corridors
 * (`113B`, `113G`, `117N`); light rail is the 101, 103 and 107 corridors with a
 * line letter (`101E`, `103W`, `107R`). Everything else in the feed is a bus.
 */
function rtdTrain(routeId) {
  const id = String(routeId ?? '');
  if (id === 'A' || /^11[37][A-Z]$/.test(id)) return LOCAL_RAIL;
  if (/^10[137][A-Z]$/.test(id)) return TRANSIT_TRAM;
  return null;
}

/**
 * TransLink SEQ route ids end in the GTFS route_type family: `-5` is
 * Queensland Rail Citytrain (`BRCA-5`). The rail-only URL is used, so the
 * suffix is a guard rather than the only filter.
 */
function translinkRailTrain(routeId) {
  return /-5$/.test(String(routeId ?? '')) ? LOCAL_RAIL : null;
}

/**
 * Finland (Digitraffic GTFS-RT, the same ids as its passenger GTFS): route
 * ids are `<origin>_<destination>_<train or line>_<type>_<n>`, station codes
 * as the operator writes them (2026-11-06). Types: `HL` commuter (local);
 * `H`/`HDM` the operator's regional trains (regional); `IC`, `S`
 * (Pendolino), `P` and `PYO` (night train) long-distance (national). Any
 * train with an end at `HPA` (Haaparanta, in Sweden) is international.
 * Unknown types are dropped.
 */
const FINLAND_ABROAD = new Set(['HPA']);
function finlandTrain(routeId) {
  const match = /^([^_]+)_([^_]+)_[^_]+_([A-Z]+)_\d+$/.exec(
    String(routeId ?? ''),
  );
  if (!match) return null;
  const [, from, to, type] = match;
  let kind = null;
  if (type === 'HL') kind = LOCAL_RAIL;
  else if (type === 'H' || type === 'HDM') kind = REGIONAL_RAIL;
  else if (['IC', 'S', 'P', 'PYO'].includes(type)) kind = NATIONAL_RAIL;
  if (!kind) return null;
  return FINLAND_ABROAD.has(from) || FINLAND_ABROAD.has(to)
    ? INTERNATIONAL_RAIL
    : kind;
}

/**
 * Pack route ids that carry what the classifier reads. The path build
 * (scripts/build-rail-paths.mjs, `staticRouteRename` / `staticTripRename`)
 * writes `<product>~<scope>~<operator route id>`, scope being where the
 * run's two ends lie: `S` in one state, `X` in two states of one country,
 * `B` across a national border. The proxy reads the same ids back from the
 * schedule pack for realtime trips that carry no route (`routesFrom`).
 */
function scopedRoute(routeId) {
  const match = /^([^~]+)~([SXB])~/.exec(String(routeId ?? ''));
  return match ? { product: match[1], scope: match[2] } : null;
}

/**
 * Renfe Alta Velocidad / Larga y Media Distancia. Product is the static
 * GTFS `route_short_name`; the scope is computed from the two stations the
 * route id names (`<origin 5 digits><destination 5 digits>...`), Spain's
 * states being its 17 autonomous communities (and Ceuta and Melilla):
 *  - international: `AVE INT`, `TRENCELTA` (Vigo–Porto), or any end abroad.
 *  - national: `AVE`, `AVLO`, `ALVIA`, `EUROMED` (it crosses communities),
 *    `Intercity`.
 *  - Media Distancia and the other regional products (`MD`, `REGIONAL`,
 *    `REG.EXP.`, `PROXIMDAD`, `AVANT`, `AVANT EXP`): regional when both ends
 *    are in one community, national when they are not.
 */
const RENFE_NATIONAL = new Set([
  'AVE',
  'AVLO',
  'ALVIA',
  'EUROMED',
  'Intercity',
]);
const RENFE_COMMUNITY_RULE = new Set([
  'MD',
  'REGIONAL',
  'REG.EXP.',
  'PROXIMDAD',
  'AVANT',
  'AVANT EXP',
]);
const RENFE_INTERNATIONAL = new Set(['AVE INT', 'TRENCELTA']);
function renfeLongDistanceTrain(routeId) {
  const route = scopedRoute(routeId);
  if (!route) return null;
  if (RENFE_INTERNATIONAL.has(route.product) || route.scope === 'B')
    return INTERNATIONAL_RAIL;
  if (RENFE_NATIONAL.has(route.product)) return NATIONAL_RAIL;
  if (RENFE_COMMUNITY_RULE.has(route.product))
    return route.scope === 'S' ? REGIONAL_RAIL : NATIONAL_RAIL;
  return null;
}

/**
 * Renfe route-id rewrite for the packs: product from `route_short_name`,
 * scope from the community (`stateAt`) of the two stations the id names.
 * A station the GTFS does not place leaves the route unscoped (`X`).
 */
function renfeRouteRename(route, { stop, stateAt }) {
  const product = String(route.route_short_name ?? '').trim();
  const id = String(route.route_id ?? '');
  if (!product || !/^\d{10}/.test(id)) return null;
  const ends = [id.slice(0, 5), id.slice(5, 10)].map((code) => {
    const at = stop(code);
    return at ? stateAt(at.lat, at.lon) : null;
  });
  let scope = 'X';
  if (ends.every(Boolean)) {
    if (ends.some((end) => end.country !== 'ES')) scope = 'B';
    else if (ends[0].state === ends[1].state) scope = 'S';
  }
  return `${product}~${scope}~${id}`;
}

/**
 * Norway (Entur), by line, with the counties (fylker, as of 2024) at each
 * end of the line, read from each codespace's GTFS `route_long_name`
 * (2026-11-06):
 *  - local: the `L` lines (L1, L2, L2x, L4 Bergen–Arna, L5 Jærbanen) and the
 *    Flytoget airport expresses (FLY1, FLY2).
 *  - international, to Sweden: F1 Oslo–Karlstad, RE20/RX20 Oslo–Göteborg,
 *    R71 Meråkerbanen (Trondheim–Storlien).
 *  - national, crossing a county line: the long-distance F4 Bergensbanen,
 *    F5 Sørlandsbanen, F6 Dovrebanen, F7 Nordlandsbanen; and the regional
 *    lines whose ends are in different counties (R12 Buskerud–Akershus, R13,
 *    R14, R21, R22, R23, R31, RE10, RE11/RX11, RE30, R40 Vestland–Buskerud,
 *    R60 Rørosbanen, R65 Raumabanen).
 *  - regional, inside one county: R55 (Telemark), R50 Sørtoget lokal
 *    (Agder), R70 Trønderbanen (Trøndelag), R75 Saltenpendelen (Nordland),
 *    and R45 Flåmsbana (Vestland, a tourist line).
 * Vy runs replacement buses under the train line ids; their journeys are
 * `ServiceJourney:BUS-*` and are dropped.
 */
const NORWAY_TOURIST_REGIONAL = Object.freeze({
  ...REGIONAL_RAIL,
  tourist: true,
});
const NORWAY_LINES = new Map(
  [
    [LOCAL_RAIL, ['VYG:Line:L1', 'VYG:Line:L2', 'VYG:Line:L2x', 'VYG:Line:L4']],
    [LOCAL_RAIL, ['GOA:Line:59', 'FLT:Line:FLY1', 'FLT:Line:FLY2']],
    [
      INTERNATIONAL_RAIL,
      ['VYG:Line:F1', 'VYG:Line:RE20', 'VYG:Line:RX20', 'SJN:Line:72'],
    ],
    [
      NATIONAL_RAIL,
      [
        'VYG:Line:F4',
        'GOA:Line:50',
        'SJN:Line:21',
        'SJN:Line:71',
        'VYG:Line:R12',
        'VYG:Line:R13',
        'VYG:Line:R13x',
        'VYG:Line:R14',
        'VYG:Line:R21',
        'VYG:Line:R22',
        'VYG:Line:R23',
        'VYG:Line:R23x',
        'VYG:Line:R31',
        'VYG:Line:RE10',
        'VYG:Line:RE11',
        'VYG:Line:RX11',
        'VYG:Line:RE30',
        'VYG:Line:R40',
        'SJN:Line:25',
        'SJN:Line:22',
      ],
    ],
    [
      REGIONAL_RAIL,
      ['VYG:Line:R55', 'GOA:Line:53', 'SJN:Line:26', 'SJN:Line:79'],
    ],
    [NORWAY_TOURIST_REGIONAL, ['VYG:Line:R45']],
  ].flatMap(([kind, ids]) => ids.map((id) => [id, kind])),
);

function norwayTrain(routeId, context) {
  if (/:ServiceJourney:BUS-/.test(String(context?.tripId ?? ''))) return null;
  return NORWAY_LINES.get(String(routeId ?? '')) ?? null;
}

const CC_BY_4_URL = 'https://creativecommons.org/licenses/by/4.0/';

/**
 * Entur (Norway). `ET-Client-Name` is mandatory (`<company>-<application>`);
 * unidentified clients may be blocked. The feeds refresh every 15 s.
 */
const ENTUR_HEADERS = Object.freeze({ 'ET-Client-Name': 'godseyeview-rail' });
const ENTUR_LIMITS = Object.freeze({
  quote: 'This dataset is updated every 15 seconds.',
  note: 'No realtime rate limit is published; each codespace is polled at most every 15 s, filtered with ?datasource= so only that operator is fetched.',
});
const NLOD_URL = 'https://data.norge.no/nlod/en/2.0';
const ENTUR_ATTRIBUTION =
  'Inneholder data under Norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Entur AS';
const ENTUR_TERMS = Object.freeze({
  quote:
    "Entur's open data is published under the Norwegian Licence for Open Government Data (NLOD). NLOD permits free reuse for any purpose, including commercial use, subject to attribution requirements",
});

const TFI_GTFS_URL =
  'https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip';

// ------------------------------------------- United States
// Helpers for the United States entries (Tri-Rail). They sit before the
// registry, which uses them.

/**
 * Tri-Rail (SFRTA). The static GTFS (gtfs.tri-rail.com, read 2026-11-10)
 * has two train routes, `1` Mainline (Mangonia Park–Miami Airport) and `2`
 * Downtown Miami Link (to MiamiCentral): commuter rail through Palm Beach,
 * Broward and Miami-Dade counties, the Miami metropolitan area, so local.
 * The realtime vehicles carry no route, only the trip id, which is the train
 * number (`P617`; Downtown Miami Link trips are `P601X`) and the static
 * trip's id. Route `4` is the Fort Lauderdale airport shuttle bus
 * (route_type 3), which never reaches the packs.
 */
function triRailTrain(routeId, context) {
  const route = String(routeId ?? '');
  if (route === '1' || route === '2') return LOCAL_RAIL;
  if (route) return null;
  return /^P\d{3}X?$/.test(String(context?.tripId ?? '')) ? LOCAL_RAIL : null;
}

// ------------------------------------------ United States
// Helpers for the feeds that publish no terms and are used without a
// published licence by project owner decision of 2026-11-10 (Charlotte
// LYNX). They sit before the registry, which uses them.

/**
 * The basis each of those feeds records, before its own facts. It records a
 * decision to use the data, not a licence: none was granted.
 */
const OWNER_AUTHORIZED_NO_TERMS =
  'Publishes no terms; used without a published licence (project owner decision, 2026-11-10).';

/**
 * Registry of feeds. Order is presentation order in the stats/credit text.
 * `loadRadiusKm` is the distance from `center` inside which the feed is polled.
 *
 * `format` picks the decoder: `gtfs-rt` (VehiclePositions protobuf),
 * `irish-rail-xml` (src/data/irishRail.js) or `siri-vm` (SIRI Vehicle
 * Monitoring, src/data/railSiriVm.js); `url` is the positions feed.
 * `positions` says where positions come from (RAIL_POSITION_SOURCES, default
 * `gps`). `headers` are sent with every realtime request, `maxBodyBytes`
 * sets the feed's own response cap in place of the proxy's 8 MiB (never above
 * 64 MiB: railMaxBodyBytes; the feeds that set one publish small documents
 * and set a lower cap), and `headerClock: 'untrusted'` marks a feed whose
 * header time is wrong and whose vehicles carry none: every train is then
 * stamped with the fetch time. `speedUnit: 'km/h'` marks a feed that
 * publishes km/h where the spec requires m/s; the proxy converts it, as for
 * Transit (src/data/transitFeeds.js).
 * `tripUpdatesUrl` is the operator's GTFS-RT TripUpdates feed, served as
 * `/api/rail/updates/<id>`.
 *
 * `pollIntervalMs` and `tripUpdatesIntervalMs` are how long a snapshot is
 * served from cache before the operator is asked again: never faster than
 * the operator asks. `limits` records the published figures the settings
 * rest on.
 *
 * The `static*` fields are read only by the opt-in pack build
 * (scripts/build-rail-paths.mjs), never by the proxy, and never sent to the
 * browser. `staticGtfsUrl` is the operator's static GTFS; when the GTFS is a
 * zip inside that zip, `staticGtfsEntry` names it, and `staticHeaders` are
 * the headers its download needs. `staticRouteTypes` narrows the static
 * routes kept when the realtime classifier accepts every route of a
 * mode-specific feed. `staticSimplifyM` coarsens shape simplification for a
 * feed whose shapes would not fit the pack cap at the default 1 m.
 * `staticRouteRename(route, helpers)` and `staticTripRename(trip, routeId,
 * {ends})` rewrite pack route ids into ids the classifier reads (with
 * `staticTripEnds`, each trip's first and last stop are passed as `ends`).
 *
 * `routesFrom: 'schedule'` marks a feed whose realtime vehicles carry a trip
 * id but no route: the route is read from the feed's pack, and a GTFS-RT feed
 * of this kind is offered only once that pack is built
 * (railFeedNeedsSchedulePack). `positionsByTrainNumber` (Irish Rail) matches
 * each reported train to its pack run by train code instead of trip id.
 * @type {ReadonlyArray<Readonly<{
 *   id: string, name: string, operator: string, region: string,
 *   center: {lat: number, lon: number}, loadRadiusKm: number,
 *   format: 'gtfs-rt'|'irish-rail-xml'|'siri-vm',
 *   url: string,
 *   positions?: 'gps'|'event',
 *   headers?: Record<string, string>, headerClock?: 'untrusted',
 *   speedUnit?: 'km/h',
 *   pollIntervalMs?: number, tripUpdatesUrl?: string,
 *   tripUpdatesIntervalMs?: number, maxBodyBytes?: number,
 *   limits?: {quote: string, note?: string},
 *   routesFrom?: 'schedule', positionsByTrainNumber?: boolean,
 *   staticGtfsUrl?: string, staticGtfsEntry?: string,
 *   staticHeaders?: Record<string, string>,
 *   staticRouteTypes?: ReadonlyArray<number>,
 *   staticTripEnds?: boolean, staticSimplifyM?: number,
 *   staticRouteRename?: (route: object, helpers: object) => string|null,
 *   staticTripRename?: (trip: object, routeId: string,
 *     context?: {ends: object|null}) => string|null,
 *   license: string, licenseUrl: string, attribution: string,
 *   defaultEnabled: boolean, terms: {quote: string, note?: string},
 *   classify: (routeId: string|null, context?: {tripId?: string|null})
 *     => ({category: string, mode: string, tourist?: boolean}|null),
 * }>>}
 */
export const RAIL_FEED_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'mta-metro-north',
    name: 'Metro-North',
    operator: 'Metro-North Railroad (MTA)',
    region: 'New York, NY',
    center: Object.freeze({ lat: 41.2, lon: -73.6 }),
    loadRadiusKm: 180,
    format: 'gtfs-rt',
    url: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr',
    // One combined feed: the same file carries trip updates.
    tripUpdatesUrl:
      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/mnr%2Fgtfs-mnr',
    staticGtfsUrl: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip',
    license: 'MTA Data Feed Terms and Conditions',
    licenseUrl: 'https://www.mta.info/developers/terms-and-conditions',
    attribution: 'MTA',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Developers must download and store the MTA data feed on a non-MTA server and redistribute the data to users from that server.',
      note: 'This proxy is that server: browsers never contact MTA. The feed stamps every vehicle with the header time, so a fix is aged from the snapshot, not from the train.',
    }),
    classify: always(LOCAL_RAIL),
  }),
  Object.freeze({
    id: 'mta-lirr',
    name: 'LIRR',
    operator: 'Long Island Rail Road (MTA)',
    region: 'New York, NY',
    center: Object.freeze({ lat: 40.75, lon: -73.3 }),
    loadRadiusKm: 160,
    format: 'gtfs-rt',
    url: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr',
    tripUpdatesUrl:
      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/lirr%2Fgtfs-lirr',
    staticGtfsUrl: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip',
    license: 'MTA Data Feed Terms and Conditions',
    licenseUrl: 'https://www.mta.info/developers/terms-and-conditions',
    attribution: 'MTA',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Developers must download and store the MTA data feed on a non-MTA server and redistribute the data to users from that server.',
      note: 'The feed was seen frozen for two days on 2026-11-06; the layer ages trains by their own report time, so a frozen feed empties instead of showing old trains as live.',
    }),
    classify: always(LOCAL_RAIL),
  }),
  Object.freeze({
    id: 'mbta-rail',
    name: 'MBTA',
    operator: 'Massachusetts Bay Transportation Authority',
    region: 'Boston, MA',
    center: Object.freeze({ lat: 42.3601, lon: -71.0589 }),
    loadRadiusKm: 110,
    format: 'gtfs-rt',
    url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
    // All modes, about 1 MB: the rail filter keeps a fraction of it.
    tripUpdatesUrl: 'https://cdn.mbta.com/realtime/TripUpdates.pb',
    staticGtfsUrl: 'https://cdn.mbta.com/MBTA_GTFS.zip',
    license: 'MassDOT Developers License Agreement',
    licenseUrl:
      'https://cdn.mbta.com/sites/default/files/2023-08/mbta-massdot-develop-license-agreement.pdf',
    attribution: 'MBTA / MassDOT',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'MassDOT ... hereby grants You (Licensee) non-exclusive, limited, and revocable rights to use, reproduce, and redistribute the Data. ... Clearly acknowledge MassDOT as the provider of the Data.',
      note: 'The same feed the Transit layer polls; this layer keeps only Commuter Rail, rapid transit and light rail.',
    }),
    classify: mbtaTrain,
  }),
  Object.freeze({
    id: 'septa-regional-rail',
    name: 'SEPTA Regional Rail',
    operator: 'Southeastern Pennsylvania Transportation Authority',
    region: 'Philadelphia, PA',
    center: Object.freeze({ lat: 40.05, lon: -75.25 }),
    loadRadiusKm: 110,
    format: 'gtfs-rt',
    url: 'https://www3.septa.org/gtfsrt/septarail-pa-us/Vehicle/rtVehiclePosition.pb',
    tripUpdatesUrl:
      'https://www3.septa.org/gtfsrt/septarail-pa-us/Trip/rtTripUpdates.pb',
    staticGtfsUrl:
      'https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip',
    staticGtfsEntry: 'google_rail.zip',
    license: 'SEPTA Trip Planning Data Agreement',
    licenseUrl: 'https://www3.septa.org/developer/',
    attribution: 'SEPTA',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'non-exclusive, limited and revocable right to use, reproduce and redistribute the Trip Planning Data',
      note: 'The agreement names the static data; SEPTA publishes the realtime feeds on the same developer page with no separate terms. Credit is text only: SEPTA trademarks may not be used.',
    }),
    classify: always(LOCAL_RAIL),
  }),
  Object.freeze({
    id: 'septa-trolley',
    name: 'SEPTA trolleys',
    operator: 'Southeastern Pennsylvania Transportation Authority',
    region: 'Philadelphia, PA',
    center: Object.freeze({ lat: 39.98, lon: -75.2 }),
    loadRadiusKm: 60,
    format: 'gtfs-rt',
    url: 'https://www3.septa.org/gtfsrt/septa-pa-us/Vehicle/rtVehiclePosition.pb',
    // The bus feed's trip updates (about 1 MB), filtered like its vehicles.
    tripUpdatesUrl:
      'https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb',
    staticGtfsUrl:
      'https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip',
    staticGtfsEntry: 'google_bus.zip',
    license: 'SEPTA Trip Planning Data Agreement',
    licenseUrl: 'https://www3.septa.org/developer/',
    attribution: 'SEPTA',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'non-exclusive, limited and revocable right to use, reproduce and redistribute the Trip Planning Data',
      note: 'The bus feed, filtered to the trolley routes and the Norristown High Speed Line. The Market-Frankford and Broad Street lines are in no SEPTA feed.',
    }),
    classify: byRoute({
      T1: TRANSIT_TRAM,
      T2: TRANSIT_TRAM,
      T3: TRANSIT_TRAM,
      T4: TRANSIT_TRAM,
      T5: TRANSIT_TRAM,
      G1: TRANSIT_TRAM,
      D1: TRANSIT_TRAM,
      D2: TRANSIT_TRAM,
      M1: TRANSIT_METRO,
    }),
  }),
  Object.freeze({
    id: 'marc',
    name: 'MARC',
    operator: 'Maryland Transit Administration',
    region: 'Baltimore–Washington',
    center: Object.freeze({ lat: 39.1, lon: -77.0 }),
    loadRadiusKm: 140,
    format: 'gtfs-rt',
    url: 'https://mdotmta-gtfs-rt.s3.amazonaws.com/MARC+RT/marc-vp.pb',
    tripUpdatesUrl:
      'https://mdotmta-gtfs-rt.s3.amazonaws.com/MARC+RT/marc-tu.pb',
    staticGtfsUrl: 'https://feeds.mta.maryland.gov/gtfs/marc',
    license: 'MDOT MTA developer feeds (no endorsement implied)',
    licenseUrl: 'https://www.mta.maryland.gov/developer-resources',
    attribution: 'Maryland Transit Administration',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'MTA does not guarantee the accuracy of the data nor does it warrant or endorse any application that uses this data.',
      note: 'Published for open fetch with this disclaimer and no licence; the site terms cover only the website and apps. Shown with attribution and the no-endorsement wording, and switched off if MDOT MTA publishes restrictive terms.',
    }),
    classify: always(LOCAL_RAIL),
  }),
  // ------------------------------------------- United States
  // Added 2026-11-10; licences read at the source that day unless the note
  // says otherwise. Helpers are above the registry.
  Object.freeze({
    id: 'tri-rail',
    name: 'Tri-Rail',
    operator: 'South Florida Regional Transportation Authority',
    region: 'South Florida',
    center: Object.freeze({ lat: 26.27, lon: -80.15 }),
    loadRadiusKm: 90,
    format: 'gtfs-rt',
    url: 'https://gtfsr.tri-rail.com/download.aspx?file=position_updates.pb',
    tripUpdatesUrl:
      'https://gtfsr.tri-rail.com/download.aspx?file=trip_updates.pb',
    // Vehicles report every 20 to 40 s (seen 2026-11-10); the positions are
    // asked every 30 s, the trip updates every minute.
    pollIntervalMs: 30_000,
    tripUpdatesIntervalMs: 60_000,
    staticGtfsUrl: 'https://gtfs.tri-rail.com/gtfs.zip',
    license: 'No licence stated (open feed pages)',
    licenseUrl: 'https://gtfsr.tri-rail.com/',
    attribution: 'South Florida Regional Transportation Authority (Tri-Rail)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: 'Download Realtime Feeds Below:',
      note: 'Used without a published licence (project owner decision, 2026-11-10). gtfsr.tri-rail.com (the page quoted above, read 2026-11-10) links the GTFS-RT trip updates, alerts and position updates with no terms, and the static GTFS (gtfs.tri-rail.com/gtfs.zip, publisher ETA Transit Systems) states none either; no SFRTA data terms were found. The realtime vehicles carry the train number as their trip id and no route.',
    }),
    classify: triRailTrain,
  }),
  Object.freeze({
    id: 'rtd-denver-rail',
    name: 'RTD',
    operator: 'Regional Transportation District',
    region: 'Denver, CO',
    center: Object.freeze({ lat: 39.74, lon: -104.99 }),
    loadRadiusKm: 70,
    format: 'gtfs-rt',
    // The www URL redirects twice and lands on this host; the proxy refuses a
    // redirect that leaves the registered origin, so the final URL is the one
    // registered.
    url: 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb',
    tripUpdatesUrl:
      'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/TripUpdate.pb',
    staticGtfsUrl: 'https://www.rtd-denver.com/files/gtfs/google_transit.zip',
    license: 'RTD GTFS-Realtime License Agreement',
    licenseUrl:
      'https://www.rtd-denver.com/business-center/open-spatial-data/gtfs-realtime-license-agreement',
    attribution: 'RTD',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'non-exclusive, limited and revocable rights to use, reproduce, and redistribute the Data',
      note: 'RTD marks may not be used with the data, so the credit is text only.',
    }),
    classify: rtdTrain,
  }),
  Object.freeze({
    id: 'capmetro-rail',
    name: 'CapMetro MetroRail',
    operator: 'Capital Metropolitan Transportation Authority',
    region: 'Austin, TX',
    center: Object.freeze({ lat: 30.4, lon: -97.75 }),
    loadRadiusKm: 70,
    format: 'gtfs-rt',
    url: 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream',
    staticGtfsUrl:
      'https://data.texas.gov/download/r4v4-vz24/application%2Fzip',
    license: 'CapMetro Open Data Terms',
    licenseUrl: 'https://www.capmetro.org/metrolabs/',
    attribution: 'CapMetro',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'non-exclusive, limited and revocable rights to use, reproduce, and redistribute CMTA Data',
      note: 'The bus feed the Transit layer polls; MetroRail is route 550.',
    }),
    classify: byRoute({ 550: LOCAL_RAIL }),
  }),
  Object.freeze({
    id: 'metrotransit-rail',
    name: 'METRO light rail',
    operator: 'Metro Transit (Metropolitan Council)',
    region: 'Minneapolis–St Paul, MN',
    center: Object.freeze({ lat: 44.95, lon: -93.2 }),
    loadRadiusKm: 50,
    format: 'gtfs-rt',
    url: 'https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb',
    staticGtfsUrl: 'https://svc.metrotransit.org/mtgtfs/gtfs.zip',
    license: 'No licence published',
    licenseUrl: 'https://svc.metrotransit.org/',
    attribution: 'Metro Transit / Metropolitan Council',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: '',
      note: 'Publishes no licence or terms: the data feeds page linked above (read 2026-11-10) lists the GTFS and GTFS-realtime files and shows only "© 2020 Metro Transit", so there is nothing to quote. Used without a published licence, on the same basis as the Transit layer\'s Metro Transit feed, which polls the same file (DATA_SOURCES.md). Blue Line 901 and Green Line 902 only; Northstar ended on 2026-01-04 and route 888 is now a bus.',
    }),
    classify: byRoute({ 901: TRANSIT_TRAM, 902: TRANSIT_TRAM }),
  }),
  Object.freeze({
    id: 'charlotte-lynx',
    name: 'LYNX',
    operator: 'Charlotte Area Transit System',
    region: 'Charlotte, NC',
    center: Object.freeze({ lat: 35.22, lon: -80.84 }),
    loadRadiusKm: 40,
    format: 'gtfs-rt',
    url: 'https://gtfsrealtime.ridetransit.org/GTFSRealTime/Vehicle/VehiclePositions.pb',
    // The URLs the Transitland and Mobility Database catalogues list for
    // CATS. The trip updates carry every bus too; only the two lines' are
    // kept.
    tripUpdatesUrl:
      'https://gtfsrealtime.ridetransit.org/GTFSRealTime/TripUpdate/Tripupdates.pb',
    staticGtfsUrl:
      'https://gtfsrealtime.ridetransit.org/GTFSStatic/api/GTFSDownload/GTFS.zip',
    license: 'No licence published',
    licenseUrl: 'https://www.charlottenc.gov/cats',
    attribution: 'Charlotte Area Transit System',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: '',
      note: `${OWNER_AUTHORIZED_NO_TERMS} The feed host (gtfsrealtime.ridetransit.org) serves the files with no page and no terms, so there is nothing to quote (2026-11-10: 126 vehicles, 13 of them trains; 205 trip updates, 11 on the two lines; every realtime trip id is a static trip id). No CATS page with terms for them was found: charlottenc.gov answered 403 to automated requests, and the CATS Terms and Conditions found there by search govern the CATS mobile app. Routes 501 LYNX Blue Line (light rail) and 510 CityLYNX Gold Line (streetcar), both route_type 0: transit, tram.`,
    }),
    classify: byRoute({ 501: TRANSIT_TRAM, 510: TRANSIT_TRAM }),
  }),
  Object.freeze({
    id: 'grt-ion',
    name: 'ION',
    operator: 'Grand River Transit (Region of Waterloo)',
    region: 'Waterloo Region, ON',
    center: Object.freeze({ lat: 43.45, lon: -80.5 }),
    loadRadiusKm: 40,
    format: 'gtfs-rt',
    // The suffix-less URL catalogued in Transitland serves a file frozen in
    // February 2026; `/2` is the light-rail feed the status page publishes.
    url: 'https://webapps.regionofwaterloo.ca/api/grt-routes/api/vehiclepositions/2',
    staticGtfsUrl:
      'https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/2',
    license: 'Region of Waterloo Open Data Licence v2.0',
    licenseUrl:
      'https://www.regionofwaterloo.ca/government-and-council/transparency-and-accountability/open-data/',
    attribution:
      'Contains information licensed under the Open Data Licence – Region of Waterloo',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'You are free to: Copy, publish, distribute and transmit the Information ... Use the Information commercially',
    }),
    classify: byRoute({ 301: TRANSIT_TRAM }),
  }),
  Object.freeze({
    id: 'translink-seq-rail',
    name: 'Queensland Rail Citytrain',
    operator: 'Translink (Queensland Government)',
    region: 'South East Queensland, Australia',
    center: Object.freeze({ lat: -27.47, lon: 153.02 }),
    loadRadiusKm: 160,
    format: 'gtfs-rt',
    url: 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Rail',
    tripUpdatesUrl:
      'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Rail',
    staticGtfsUrl: 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip',
    license: 'CC BY 4.0',
    licenseUrl: 'https://translink.com.au/about-translink/open-data',
    attribution: 'Translink / Queensland Government',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Our data is licensed under a Creative Commons Attribution 4.0 International License.',
      note: 'The terms add: "You must not represent that the State in any way endorses your Application."',
    }),
    classify: translinkRailTrain,
  }),
  Object.freeze({
    id: 'translink-seq-tram',
    name: 'G:link',
    operator: 'Translink (Queensland Government)',
    region: 'Gold Coast, Australia',
    center: Object.freeze({ lat: -27.98, lon: 153.4 }),
    loadRadiusKm: 50,
    format: 'gtfs-rt',
    url: 'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Tram',
    tripUpdatesUrl:
      'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Tram',
    staticGtfsUrl: 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip',
    // The static GTFS is all of SEQ; only its tram routes are G:link.
    staticRouteTypes: Object.freeze([0]),
    license: 'CC BY 4.0',
    licenseUrl: 'https://translink.com.au/about-translink/open-data',
    attribution: 'Translink / Queensland Government',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Our data is licensed under a Creative Commons Attribution 4.0 International License.',
    }),
    classify: always(TRANSIT_TRAM),
  }),
  Object.freeze({
    id: 'adelaide-metro',
    name: 'Adelaide Metro',
    operator: 'Adelaide Metro (Rail Commissioner)',
    region: 'Adelaide, Australia',
    center: Object.freeze({ lat: -34.93, lon: 138.6 }),
    loadRadiusKm: 70,
    format: 'gtfs-rt',
    url: 'https://gtfs.adelaidemetro.com.au/v1/realtime/vehicle_positions',
    tripUpdatesUrl:
      'https://gtfs.adelaidemetro.com.au/v1/realtime/trip_updates',
    // "stop predictions are refreshed every 60 seconds" (Swagger).
    tripUpdatesIntervalMs: 60_000,
    // The gateway negotiates on Accept: anything but its own protobuf type
    // (including the proxy's default `application/x-protobuf`) is answered
    // with base64 text labelled application/json, which no decoder reads.
    headers: Object.freeze({ Accept: 'application/x-google-protobuf' }),
    staticGtfsUrl:
      'https://gtfs.adelaidemetro.com.au/v1/static/latest/google_transit.zip',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://data.sa.gov.au/data/dataset/https-gtfs-adelaidemetro-com-au',
    attribution: 'Adelaide Metro / Government of South Australia',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: 'Creative Commons Attribution 4.0',
      note: 'Licence as catalogued on data.sa.gov.au; the operator developer page sits behind a bot check. The feed is labelled beta.',
    }),
    classify: byRoute({
      BEL: LOCAL_RAIL,
      FLNDRS: LOCAL_RAIL,
      GAW: LOCAL_RAIL,
      GAWC: LOCAL_RAIL,
      GRNG: LOCAL_RAIL,
      NOAR: LOCAL_RAIL,
      OSBORN: LOCAL_RAIL,
      OUTHA: LOCAL_RAIL,
      PTDOCK: LOCAL_RAIL,
      SALIS: LOCAL_RAIL,
      SEAFRD: LOCAL_RAIL,
      GLNELG: TRANSIT_TRAM,
      BTANIC: TRANSIT_TRAM,
      FESTVL: TRANSIT_TRAM,
    }),
  }),
  Object.freeze({
    id: 'irish-rail',
    name: 'Irish Rail',
    operator: 'Iarnród Éireann / Irish Rail',
    region: 'Ireland',
    center: Object.freeze({ lat: 53.3, lon: -7.7 }),
    loadRadiusKm: 260,
    format: 'irish-rail-xml',
    positions: 'event',
    // The API documentation shows http; the same path answers over https,
    // which is the only scheme this proxy fetches.
    url: 'https://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML',
    headers: Object.freeze({ Accept: 'text/xml, application/xml;q=0.9' }),
    pollIntervalMs: 30_000,
    maxBodyBytes: 1024 * 1024,
    limits: Object.freeze({
      quote:
        'Irish Rail provides this information as is and do not offer any support',
      note: 'No rate limit is published. Polled every 30 s; one file is about 35 KB.',
    }),
    // The TFI static GTFS. Its trip_short_name is the train code the XML
    // names: each reported train takes the run that code is on now, so it
    // is drawn on its line with its stops.
    positionsByTrainNumber: true,
    routesFrom: 'schedule',
    staticGtfsUrl: TFI_GTFS_URL,
    staticRouteTypes: Object.freeze([2]),
    staticTripEnds: true,
    staticTripRename: irishRailTripRename,
    license: 'No licence published (positions); CC BY 4.0 (NTA timetable)',
    // The NTA's policy page: it names the CC BY 4.0 licence of the NTA's
    // GTFS data (the timetable) and is the NTA link its section 7 asks
    // public use to carry. The positions' API page publishes no licence.
    licenseUrl: 'https://developer.nationaltransport.ie/usagepolicy',
    attribution:
      'Iarnród Éireann / Irish Rail; timetable: National Transport Authority, provided as is',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: '',
      note: 'The train positions publish no licence or terms: the Irish Rail realtime API page (api.irishrail.ie/realtime/, read 2026-11-10) documents the calls and says only that "Irish Rail provides this information as is" (quoted under `limits`), so there is nothing to quote. They are used without a published licence, credited "Iarnród Éireann / Irish Rail". The NTA\'s CC BY 4.0 covers only the NTA\'s GTFS data (the timetable), not these positions. Positions are the station or timing point the signalling system last reported, not GPS.',
    }),
    classify: irishRailTrain,
  }),
  Object.freeze({
    id: 'fintraffic-vr',
    name: 'VR (Finland)',
    operator: 'VR, via Fintraffic Digitraffic',
    region: 'Finland',
    center: Object.freeze({ lat: 63.5, lon: 25.5 }),
    loadRadiusKm: 600,
    format: 'gtfs-rt',
    // Digitraffic's GTFS-RT locations: passenger trains only, with the
    // passenger GTFS's route and trip ids (the route id names the train
    // type). The REST pair (train-locations + live-trains) would need the
    // 6.5 MB live-trains list on every poll to learn each train's type.
    url: 'https://rata.digitraffic.fi/api/v1/trains/gtfs-rt-locations',
    tripUpdatesUrl: 'https://rata.digitraffic.fi/api/v1/trains/gtfs-rt-updates',
    headers: Object.freeze({ 'Digitraffic-User': 'GodsEyeView/RailLayer' }),
    staticHeaders: Object.freeze({
      'Digitraffic-User': 'GodsEyeView/RailLayer',
    }),
    limits: Object.freeze({
      quote: 'Real time feed is updated every 10 seconds',
      note: 'Requests without a Digitraffic-User header are limited to 60 a minute per IP; compression is mandatory (the proxy asks for gzip). Positions every 15 s, trip updates every 30 s.',
    }),
    staticGtfsUrl:
      'https://rata.digitraffic.fi/api/v1/trains/gtfs-passenger-stops.zip',
    license: 'CC BY 4.0',
    licenseUrl: 'https://www.digitraffic.fi/en/terms-of-service/',
    attribution: 'Source: Fintraffic / digitraffic.fi, license CC 4.0 BY',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        "Fintraffic's open data is licensed under the Creative Commons 4.0 By license. It gives the right to distribute, remix, tweak, and build upon our data, even commercially, as long as you credit the source for the original creation.",
      note: 'The Digitraffic-User header names the application, never a person.',
    }),
    classify: finlandTrain,
  }),
  Object.freeze({
    id: 'renfe-larga-distancia',
    name: 'Renfe long and medium distance',
    operator: 'Renfe (AVE, Avlo, Alvia, Euromed, Intercity, Media Distancia)',
    region: 'Spain',
    center: Object.freeze({ lat: 40.2, lon: -3.7 }),
    loadRadiusKm: 700,
    format: 'gtfs-rt',
    url: 'https://gtfsrt.renfe.com/vehicle_positions_LD.pb',
    tripUpdatesUrl: 'https://gtfsrt.renfe.com/trip_updates_LD.pb',
    // The header clock runs an hour behind (local time written as UTC) and
    // vehicles carry no time: every train is stamped with the fetch time.
    headerClock: 'untrusted',
    // Vehicles carry a trip id but no route: the route (with its product)
    // is read from the schedule pack.
    routesFrom: 'schedule',
    staticGtfsUrl:
      'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
    staticRouteRename: renfeRouteRename,
    license: 'CC BY 4.0',
    licenseUrl: CC_BY_4_URL,
    attribution: 'Renfe',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: 'CC-BY-4.0',
      note: 'Licence field of the data.renfe.com datasets (posicion-vehiculos-av-ld-md and the static GTFS). "Esta información se actualiza cada 15 segundos". Iryo and OUIGO España are not in Renfe’s feeds.',
    }),
    classify: renfeLongDistanceTrain,
  }),
  Object.freeze({
    id: 'renfe-cercanias',
    name: 'Renfe Cercanías',
    operator: 'Renfe Cercanías and Rodalies',
    region: 'Spain',
    center: Object.freeze({ lat: 40.2, lon: -3.7 }),
    loadRadiusKm: 700,
    format: 'gtfs-rt',
    url: 'https://gtfsrt.renfe.com/vehicle_positions.pb',
    tripUpdatesUrl: 'https://gtfsrt.renfe.com/trip_updates.pb',
    staticGtfsUrl:
      'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
    license: 'CC BY 4.0',
    licenseUrl: CC_BY_4_URL,
    attribution: 'Renfe',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: 'CC-BY-4.0',
      note: 'Licence field of the data.renfe.com Cercanías datasets. Every vehicle in this feed is a Cercanías or Rodalies train.',
    }),
    classify: always(LOCAL_RAIL),
  }),
  ...[
    ['VYG', 'entur-vy', 'Vy', 'Vy (Norway)', 61.0, 9.5, 450],
    ['GOA', 'entur-go-ahead', 'Go-Ahead', 'Go-Ahead Norge', 58.8, 7.5, 280],
    ['FLT', 'entur-flytoget', 'Flytoget', 'Flytoget', 59.9, 10.9, 80],
  ].map(([codespace, id, name, operator, lat, lon, radius]) =>
    Object.freeze({
      id,
      name,
      operator: `${operator}, via Entur`,
      region: 'Norway',
      center: Object.freeze({ lat, lon }),
      loadRadiusKm: radius,
      format: 'gtfs-rt',
      url: `https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions?datasource=${codespace}`,
      // Vy's shapes are dense enough (1.2 million points at 1 m) to break
      // the pack cap (16 MiB when measured, 24 MiB now); 5 m keeps them on
      // the track at map scale.
      ...(codespace === 'VYG' ? { staticSimplifyM: 5 } : {}),
      ...(codespace === 'VYG'
        ? {}
        : {
            tripUpdatesUrl: `https://api.entur.io/realtime/v1/gtfs-rt/trip-updates?datasource=${codespace}`,
          }),
      headers: ENTUR_HEADERS,
      staticHeaders: ENTUR_HEADERS,
      limits: ENTUR_LIMITS,
      staticGtfsUrl: `https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_${codespace.toLowerCase()}-aggregated-gtfs.zip`,
      license: 'NLOD 2.0',
      licenseUrl: NLOD_URL,
      attribution: ENTUR_ATTRIBUTION,
      defaultEnabled: true,
      terms: ENTUR_TERMS,
      classify: norwayTrain,
    }),
  ),
  Object.freeze({
    id: 'entur-sj-nord',
    name: 'SJ Nord',
    operator: 'SJ Nord, via Entur',
    region: 'Norway',
    center: Object.freeze({ lat: 65.0, lon: 12.5 }),
    loadRadiusKm: 600,
    // SJ Nord is missing from Entur's GTFS-RT positions; its trains report
    // in SIRI VM (SIRI Lite, about 7 KB for the codespace), read by
    // src/data/railSiriVm.js. The static GTFS still gives the stops.
    format: 'siri-vm',
    url: 'https://api.entur.io/realtime/v1/rest/vm?datasetId=SJN',
    headers: Object.freeze({ ...ENTUR_HEADERS, Accept: 'application/xml' }),
    maxBodyBytes: 2 * 1024 * 1024,
    limits: ENTUR_LIMITS,
    staticHeaders: ENTUR_HEADERS,
    staticSimplifyM: 5,
    staticGtfsUrl:
      'https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_sjn-aggregated-gtfs.zip',
    license: 'NLOD 2.0',
    licenseUrl: NLOD_URL,
    attribution: ENTUR_ATTRIBUTION,
    defaultEnabled: true,
    terms: Object.freeze({
      ...ENTUR_TERMS,
      note: 'SJ Nord trains are missing from Entur’s GTFS-RT vehicle positions (0 vehicles on 2026-11-06); they are read from SIRI VM instead (13 trains on 2026-11-09). Its journey refs are DatedServiceJourneys, not the GTFS trip ids, so a train is matched to its run by line and position.',
    }),
    classify: norwayTrain,
  }),
  // National sources. Licences were read at the source on 2026-11-09; their
  // classifier helpers follow the registry.
  Object.freeze({
    id: 'ktmb',
    name: 'KTMB',
    operator:
      'Keretapi Tanah Melayu (ETS, Intercity, KTM Komuter, Shuttle Tebrau)',
    region: 'Peninsular Malaysia',
    center: Object.freeze({ lat: 4.0, lon: 101.8 }),
    loadRadiusKm: 450,
    format: 'gtfs-rt',
    // The documented URL (no trailing slash) answers 301 to this one.
    url: 'https://api.data.gov.my/gtfs-realtime/vehicle-position/ktmb/',
    pollIntervalMs: 30_000,
    limits: Object.freeze({
      quote: 'GTFS Realtime 4 requests per minute',
      note: 'developer.data.gov.my/rate-limit (a 429 past it). "All Vehicle Position feeds are updated every 30 seconds": polled every 30 s, 2 a minute. Trip updates are "in our pipeline for 2026".',
    }),
    // Vehicles carry a trip id but no route: the scoped route is read from
    // the schedule pack.
    routesFrom: 'schedule',
    staticGtfsUrl: 'https://api.data.gov.my/gtfs-static/ktmb',
    staticTripEnds: true,
    staticTripRename: ktmbTripRename,
    license: 'CC BY 4.0',
    licenseUrl: 'https://developer.data.gov.my/realtime-api/gtfs-realtime',
    attribution: 'KTMB, via data.gov.my (Government of Malaysia)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: 'All GTFS Realtime feeds are licensed under CC BY 4.0',
      note: 'developer.data.gov.my, read 2026-11-09; its GTFS Static page says the same of "All GTFS Static feeds". The static GTFS has no shapes.',
    }),
    classify: ktmbTrain,
  }),
  // ------------------------------------------ United States
  // The BTS National Transit Map's rail agencies (snapshot of 2025-09-02)
  // that no feed covered yet: each agency's current files and terms, read
  // on 2026-11-10 unless the note says otherwise. Helpers are above the
  // registry.
  Object.freeze({
    id: 'seattle-streetcar',
    name: 'Seattle Streetcar',
    operator:
      'City of Seattle (South Lake Union and First Hill lines), via King County Metro',
    region: 'Seattle, WA',
    center: Object.freeze({ lat: 47.61, lon: -122.33 }),
    loadRadiusKm: 10,
    format: 'gtfs-rt',
    // King County Metro's whole-fleet files (about 500 vehicles in 50 KB; the
    // trip updates about 1.1 MB): only the two streetcar routes are kept.
    url: 'https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb',
    tripUpdatesUrl:
      'https://s3.amazonaws.com/kcm-alerts-realtime-prod/tripupdates.pb',
    staticGtfsUrl: 'https://metro.kingcounty.gov/GTFS/google_transit.zip',
    license: 'King County Transit Data Terms of Use',
    licenseUrl:
      'https://kingcounty.gov/en/dept/metro/rider-tools/mobile-and-web-apps',
    attribution:
      'Transit scheduling, geographic, and real-time data provided by permission of King County',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'King County grants you a limited, revocable license to use, reproduce, and redistribute the Data in accordance with these Terms.',
      note: 'Transit Data Terms of Use on the page linked above (undated; read 2026-11-10), which links the GTFS and GTFS-RT used here and covers "schedule, geographic, real-time, or any other data posted by King County". King County also permits users "to copy, distribute, store (electronically or otherwise), create derivative works based on and perform and display (publicly or otherwise) such Data, and make such Data available to end users", and asks for the legend the credit carries; no King County service marks beyond it. Commercial use is not mentioned. The feed bundles King County Metro, Sound Transit and City of Seattle routes; only the City of Seattle streetcars (agency 23) are kept, `100340` South Lake Union and `102638` First Hill (transit, tram). Link light rail is not in this GTFS.',
    }),
    classify: byRoute({ 100340: TRANSIT_TRAM, 102638: TRANSIT_TRAM }),
  }),
  Object.freeze({
    id: 'cincinnati-connector',
    name: 'Connector streetcar',
    operator: 'Southwest Ohio Regional Transit Authority (SORTA/Metro)',
    region: 'Cincinnati, OH',
    center: Object.freeze({ lat: 39.11, lon: -84.51 }),
    loadRadiusKm: 8,
    format: 'gtfs-rt',
    // Metro's whole-fleet files (about 150 vehicles in 12 KB; trip updates
    // about 300 KB): only the streetcar is kept.
    url: 'https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService/vehicle/vehiclepositions.pb',
    tripUpdatesUrl:
      'https://tmgtfsprd.sorttrpcloud.com/TMGTFSRealTimeWebService/tripupdate/tripupdates.pb',
    // The developer page's "Metro GTFS data" link, replaced in place.
    staticGtfsUrl:
      'https://www.go-metro.com/wp-content/uploads/2024/12/google_transit-1.zip',
    license: 'SORTA/Metro developer data Terms',
    licenseUrl: 'https://www.go-metro.com/about/developer-data/',
    attribution: 'Southwest Ohio Regional Transit Authority (SORTA/Metro)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Southwest Ohio Regional Transit Authority (SORTA/Metro) hereby grants you (Licensee) non-exclusive, limited and revocable rights to use, reproduce, and redistribute SORTA/Metro’s transit route schedules, pricing, and other associated data (“Data”) subject to the following Terms:',
      note: 'The developer data page linked above (read 2026-11-10), which links the GTFS and these GTFS-RT files. SORTA/Metro trademarks "may not be used in association with Data unless approved in writing by SORTA/Metro", so the credit is text only; "Any modification, alteration, combination or arrangement of the Data is solely at your own risk." Commercial use is not mentioned. Seen 2026-11-10: 2 streetcars among 147 vehicles, 6 streetcar trips among 265 updates, trip ids those of the static file. The file of 2026-10-01 ends on 2026-12-05. One rail route, `100` Streetcar - OTR - Banks (route_type 0): transit, tram.',
    }),
    classify: byRoute({ 100: TRANSIT_TRAM }),
  }),
  Object.freeze({
    id: 'jp-manyosen',
    name: 'Manyōsen',
    operator: '万葉線 Manyōsen (Takaoka–Kōshinokata tram)',
    region: 'Toyama, Japan',
    center: Object.freeze({ lat: 36.77, lon: 137.06 }),
    loadRadiusKm: 25,
    format: 'gtfs-rt',
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/manyo_line/VehiclePositions.pb',
    pollIntervalMs: 30_000,
    tripUpdatesUrl:
      'https://gtfs-rt-files.buscatch.jp/toyama/manyo_line/TripUpdates.pb',
    staticGtfsUrl:
      'https://api.gtfs-data.jp/v2/organizations/manyosen/feeds/manyosen/files/feed.zip?rid=current',
    license: 'CC0 1.0',
    licenseUrl:
      'https://api.gtfs-data.jp/v2/organizations/manyosen/feeds/manyosen',
    attribution: '万葉線株式会社, via the GTFS Data Repository (gtfs-data.jp)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: '"feed_license": "CC0 1.0"',
      note: 'GTFS Data Repository record of the feed "万葉線", read 2026-11-10: the record lists the GTFS-RT VehiclePositions and TripUpdates (buscatch.jp, keyless) with the CC0 feed. Tram: transit.',
    }),
    classify: always(TRANSIT_TRAM),
  }),
  Object.freeze({
    id: 'jp-toyama-tram',
    name: 'Toyama tram',
    operator:
      '富山地方鉄道 Toyama Chihō Railway city tram (city lines, Toyamakō Line, loop line)',
    region: 'Toyama, Japan',
    center: Object.freeze({ lat: 36.72, lon: 137.21 }),
    loadRadiusKm: 25,
    format: 'gtfs-rt',
    url: 'https://gtfs-rt-files.buscatch.jp/toyama/chitetsu_tram/VehiclePositions.pb',
    pollIntervalMs: 30_000,
    // No staticGtfsUrl: the tram's static GTFS codes every route as a bus
    // (route_type 3), so the path build would keep none of it. Its
    // TripUpdates are not used either: there are no stops to show delays at.
    license: 'CC0 1.0',
    licenseUrl:
      'https://api.gtfs-data.jp/v2/organizations/chitetsu/feeds/chitetsushinaidensha',
    attribution:
      '富山地方鉄道株式会社, via the GTFS Data Repository (gtfs-data.jp)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: '"feed_license": "CC0 1.0"',
      note: 'GTFS Data Repository record of the feed "富山地方鉄道市内電車", read 2026-11-10: the record lists the GTFS-RT VehiclePositions and TripUpdates (buscatch.jp, keyless) with the CC0 feed. The tram-only feed (the company\'s buses are a separate feed). Tram: transit.',
    }),
    classify: always(TRANSIT_TRAM),
  }),
  Object.freeze({
    id: 'tbm-bordeaux',
    name: 'Bordeaux tram',
    operator: 'TBM (Bordeaux Métropole): trams A to F',
    region: 'Bordeaux, France',
    center: Object.freeze({ lat: 44.85, lon: -0.58 }),
    loadRadiusKm: 25,
    format: 'gtfs-rt',
    // Every TBM vehicle (about 80 KB); the tram routes are kept. The
    // `apiKey` in these links is a fixed public value the publisher prints
    // on the dataset page for everyone: the same for every user, not a
    // credential of the deployer's, and nothing is signed up for to get it.
    url: 'https://bdx.mecatran.com/utw/ws/gtfsfeed/vehicles/bordeaux?apiKey=opendata-bordeaux-metropole-flux-gtfs-rt',
    tripUpdatesUrl:
      'https://bdx.mecatran.com/utw/ws/gtfsfeed/realtime/bordeaux?apiKey=opendata-bordeaux-metropole-flux-gtfs-rt',
    tripUpdatesIntervalMs: 60_000,
    staticGtfsUrl:
      'https://bdx.mecatran.com/utw/ws/gtfsfeed/static/bordeaux?apiKey=opendata-bordeaux-metropole-flux-gtfs-rt',
    license: 'Licence Ouverte / Open Licence 1.0',
    licenseUrl:
      'https://transport.data.gouv.fr/datasets/offres-de-services-bus-tram-et-scolaire-au-format-gtfs-netex-gtfs-rt-siri-lite',
    attribution: 'Bordeaux Métropole (TBM)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: 'fr-lo',
      note: 'Licence field of the transport.data.gouv.fr dataset "Réseau urbain et scolaire TBM" (publisher Bordeaux Métropole; read through its API on 2026-11-10), covering its GTFS and its GTFS-RT VehiclePositions and TripUpdates; Licence Ouverte 1.0 (Etalab) allows reuse, commercial included, with attribution. Tram: transit, tram.',
    }),
    classify: byRoute({
      59: TRANSIT_TRAM, // A
      60: TRANSIT_TRAM, // B
      61: TRANSIT_TRAM, // C
      62: TRANSIT_TRAM, // D
      163: TRANSIT_TRAM, // E
      164: TRANSIT_TRAM, // F
    }),
  }),
  Object.freeze({
    id: 'tam-montpellier',
    name: 'Montpellier tram',
    operator: 'TaM (Montpellier Méditerranée Métropole): trams 1 to 5',
    region: 'Montpellier, France',
    center: Object.freeze({ lat: 43.61, lon: 3.88 }),
    loadRadiusKm: 25,
    format: 'gtfs-rt',
    // Every TaM vehicle (about 15 KB); the tram routes are kept.
    url: 'https://gtfsproxy.e-tam.fr/COMMON/VehiclePosition.pb',
    // Speeds are km/h where the spec asks m/s (the Transit layer's entry for
    // this feed measured readings at 3.3 times the movement); the proxy
    // converts them.
    speedUnit: 'km/h',
    tripUpdatesUrl: 'https://gtfsproxy.e-tam.fr/COMMON/TripUpdate.pb',
    tripUpdatesIntervalMs: 60_000,
    staticGtfsUrl: 'https://gtfsproxy.e-tam.fr/COMMON/GTFS.zip',
    license: 'ODbL 1.0',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution: 'TaM / Montpellier Méditerranée Métropole',
    defaultEnabled: true,
    terms: Object.freeze({
      quote: 'odc-odbl',
      note: `Licence field of the transport.data.gouv.fr dataset "Réseau urbain TaM" (publisher Montpellier Méditerranée Métropole; read through its API on 2026-11-10), covering its GTFS and its GTFS-RT VehiclePositions and TripUpdates. ${panOdblNote()} Tram: transit, tram.`,
    }),
    classify: byRoute(
      Object.fromEntries(
        ['1', '2', '3', '4', '5'].map((line) => [line, TRANSIT_TRAM]),
      ),
    ),
  }),
]);

/**
 * What ODbL means for a transport.data.gouv.fr dataset: the access point
 * applies its "Conditions Particulières d'Utilisation" to every ODbL
 * dataset it lists (doc.transport.data.gouv.fr, "Licence ODbL", read
 * 2026-11-10).
 */
function panOdblNote() {
  return 'ODbL is share-alike, with the access point\'s special conditions (doc.transport.data.gouv.fr "Licence ODbL", read 2026-11-10): the share-alike clause covers information "de même nature, de même granularité, de mêmes conditions temporelles et de même emprise géographique", and "Les bases de données ainsi repartagées doivent être publiées sur le Point d\'accès national transport.data.gouv.fr, dans le format d\'origine." The path and schedule packs built from this GTFS are such a database once shared: offered under ODbL with the attribution kept.';
}

/**
 * Where a run goes, from its two ends as the path build reads them
 * (`staticTripEnds`, scripts/build-rail-paths.mjs `readTripEnds`): `B` when
 * its ends are in two countries or (unless `endsOnly`) it stops in two, `S`
 * when both ends are in one state, `X` otherwise, also when an end could not
 * be placed. `fix(end)` corrects an end the simplified state polygons
 * misplace, which happens to stations on a border.
 */
function tripScope(ends, { fix = null, endsOnly = false } = {}) {
  const place = (end) => (end && fix ? fix(end) : end);
  const from = place(ends?.from);
  const to = place(ends?.to);
  if (!from?.country || !to?.country) return 'X';
  if (from.country !== to.country) return 'B';
  if (!endsOnly && (ends.countries?.length ?? 0) > 1) return 'B';
  return from.state && from.state === to.state ? 'S' : 'X';
}

/**
 * `<product>~<scope>~<route id>` (see `scopedRoute`) from a pack route id
 * that is `<product>~<route id>`, or a bare route id that is its own
 * product.
 */
function withScope(routeId, scope) {
  const id = String(routeId ?? '');
  const at = id.indexOf('~');
  return at > 0
    ? `${id.slice(0, at)}~${scope}~${id.slice(at + 1)}`
    : `${id}~${scope}~${id}`;
}

/** Regional inside one state, national across states, international abroad. */
function kindForScope(scope) {
  if (scope === 'B') return INTERNATIONAL_RAIL;
  return scope === 'S' ? REGIONAL_RAIL : NATIONAL_RAIL;
}

/**
 * KTMB (data.gov.my GTFS of 2026-11-09). Route ids name the service:
 *  - local: KTM Komuter, the Klang Valley lines (`KA15_KD19` Tanjung
 *    Malim–Pelabuhan Klang, `KC05_KB18` Batu Caves–Pulau Sebang), Komuter
 *    Utara (`100_47300` Butterworth–Padang Besar, `100_9000` Butterworth–
 *    Ipoh) and the Shuttle Selatan (`SS`, coded as a tram in the GTFS).
 *  - international: Shuttle Tebrau (`ST`, JB Sentral–Woodlands, Singapore).
 *  - ETS, Ekspres Rakyat Timuran (`ERT`) and the Intercity shuttle (`SH`)
 *    by where each run ends, the states being Malaysia's 13 states and its
 *    federal territories: regional inside one (Tumpat–Gua Musang), national
 *    across them, international to Hat Yai (Thailand) or Woodlands.
 * Padang Besar station lies inside the simplified Thai polygon; it is in
 * Perlis, so the scope reads the run's ends only, with that one corrected.
 */
const KTMB_KOMUTER = /^(KA15_KD19|KC05_KB18|SS|\d+_\d+)$/;
const KTMB_INTERCITY = new Set(['ETS', 'ERT', 'SH']);
function ktmbPlace(end) {
  return /^padang besar$/i.test(String(end.name ?? '').trim())
    ? { ...end, country: 'MY', state: 'MY-09' }
    : end;
}
function ktmbTripRename(trip, routeId, { ends = null } = {}) {
  return withScope(
    routeId,
    tripScope(ends, { fix: ktmbPlace, endsOnly: true }),
  );
}
function ktmbTrain(routeId) {
  const route = scopedRoute(routeId);
  if (!route) return null;
  if (route.product === 'ST') return INTERNATIONAL_RAIL;
  if (KTMB_KOMUTER.test(route.product)) return LOCAL_RAIL;
  return KTMB_INTERCITY.has(route.product) ? kindForScope(route.scope) : null;
}

/**
 * Irish Rail in the TFI static GTFS (`GTFS_Realtime.zip`, the one the NTA
 * GTFS-R feed matches): `trip_short_name` is the train code the realtime
 * XML names (`E206` DART, `P600` and `D` Commuter, `A101` InterCity). The
 * pack route id is `<code letter>~<scope>~<route id>`, the scope by the
 * provinces of the run's two ends (IRISH_RAIL_PROVINCE, parenthesised
 * station names such as `Cork (Kent)` read as `Cork`): `B` when one end is
 * in Northern Ireland or abroad, `S` in one province, `X` otherwise or
 * when an end is not a listed terminus. A trip with no train code is left
 * out.
 */
function irishRailProvince(end) {
  const name = String(end?.name ?? '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase();
  return IRISH_RAIL_PROVINCE.get(name) ?? null;
}
function irishRailTripRename(trip, routeId, { ends = null } = {}) {
  const letter = /^([A-Z])\d{1,4}$/.exec(
    String(trip.trip_short_name ?? '').trim(),
  )?.[1];
  if (!letter) return null;
  const from = irishRailProvince(ends?.from);
  const to = irishRailProvince(ends?.to);
  let scope = 'X';
  if (
    (from && to && (from === 'NI') !== (to === 'NI')) ||
    (ends?.from?.country &&
      ends?.to?.country &&
      ends.from.country !== ends.to.country)
  )
    scope = 'B';
  else if (from && to && from === to) scope = 'S';
  return `${letter}~${scope}~${routeId}`;
}
/** The same rule as the realtime codes, read from a pack route id. */
function irishRailPackTrain(route) {
  if (route.product !== 'A' && route.product !== 'B') return LOCAL_RAIL;
  if (route.scope === 'B') return INTERNATIONAL_RAIL;
  return route.scope === 'S' ? REGIONAL_RAIL : NATIONAL_RAIL;
}

/**
 * The feeds this build polls: every registered feed that is switched on. A
 * registered feed that is switched off is inert everywhere: it resolves to no
 * route and is never offered to the browser.
 */
export const RAIL_ENABLED_FEEDS = Object.freeze(
  RAIL_FEED_REGISTRY.filter((feed) => feed.defaultEnabled === true),
);

const ANY_FEED_BY_ID = new Map(
  RAIL_FEED_REGISTRY.map((feed) => [feed.id, feed]),
);

/** Feed ids are path segments: lowercase letters, digits, hyphens only. */
export const RAIL_FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Whether a feed serves trip updates: it registers a `tripUpdatesUrl`.
 * @param {object} feed Registry entry.
 * @returns {boolean}
 */
export function railFeedHasTripUpdates(feed) {
  return typeof feed?.tripUpdatesUrl === 'string';
}

/**
 * Whether a registered feed may be polled: switched on.
 * @param {object} feed
 * @returns {boolean}
 */
export function isRailFeedPollable(feed) {
  return feed?.defaultEnabled === true;
}

/**
 * Every pollable feed.
 * @returns {object[]}
 */
export function railEnabledFeeds() {
  return [...RAIL_ENABLED_FEEDS];
}

/**
 * Look up a POLLABLE feed by id. Unknown ids, malformed ids and feeds that
 * are registered but switched off return null: this is the only door from a
 * request path to an upstream URL.
 * @param {string} id
 * @returns {object|null}
 */
export function getRailFeed(id) {
  if (typeof id !== 'string' || !RAIL_FEED_ID_PATTERN.test(id)) return null;
  const feed = ANY_FEED_BY_ID.get(id);
  return feed && isRailFeedPollable(feed) ? feed : null;
}

/**
 * Look up any registered feed, enabled or not. For credits and documentation
 * only, never for resolving a request into an upstream fetch.
 * @param {string} id
 * @returns {object|null}
 */
export function getRegisteredRailFeed(id) {
  if (typeof id !== 'string' || !RAIL_FEED_ID_PATTERN.test(id)) return null;
  return ANY_FEED_BY_ID.get(id) || null;
}

/**
 * Where a feed's positions come from (RAIL_POSITION_SOURCES).
 * @param {object} feed
 * @returns {'gps'|'event'}
 */
export function railFeedPositions(feed) {
  return RAIL_POSITION_SOURCES.includes(feed?.positions)
    ? feed.positions
    : 'gps';
}

/**
 * Whether a feed shows trains only once its pack has been built
 * (scripts/build-rail-paths.mjs): a GTFS-Realtime feed whose vehicles carry
 * no route (`routesFrom: 'schedule'`), so nothing classifies them without
 * the pack. Irish Rail's XML names each train by its code, which classifies
 * it without one.
 * @param {object} feed
 * @returns {boolean}
 */
export function railFeedNeedsSchedulePack(feed) {
  return feed?.routesFrom === 'schedule' && feed?.format === 'gtfs-rt';
}

/**
 * Enabled feeds whose coverage circle contains the point, nearest first.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [slackKm=0] Extra radius so a feed at the edge of coverage
 *   does not flap on small camera moves.
 * @param {ReadonlyArray<{center: {lat: number, lon: number},
 *   loadRadiusKm: number}>} [feeds=RAIL_ENABLED_FEEDS] The feeds to choose
 *   from; the browser passes the server's catalog, which leaves out a feed
 *   whose vehicles name no route until its pack is built.
 * @returns {object[]}
 */
export function railFeedsInRange(
  lat,
  lon,
  slackKm = 0,
  feeds = RAIL_ENABLED_FEEDS,
) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return (Array.isArray(feeds) ? feeds : [])
    .filter(
      (feed) =>
        Number.isFinite(feed?.center?.lat) &&
        Number.isFinite(feed?.center?.lon) &&
        Number.isFinite(feed?.loadRadiusKm),
    )
    .map((feed) => ({
      feed,
      km: greatCircleKm({ lat, lon }, feed.center),
    }))
    .filter(({ feed, km }) => km <= feed.loadRadiusKm + Math.max(0, slackKm))
    .sort((a, b) => a.km - b.km)
    .map(({ feed }) => feed);
}

/**
 * The category and mode of one vehicle, or null when it is not a train the
 * layer shows. A classifier that returns anything outside the known category
 * and mode lists counts as null, so a registry typo drops vehicles instead of
 * inventing a category.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId GTFS route_id from the vehicle's trip.
 * @param {{tripId?: string|null}} [context] More of the record, for feeds
 *   whose route id alone does not say what the train is (Irish Rail).
 * @returns {{category: string, mode: string}|null}
 */
export function classifyTrain(feed, routeId, context = null) {
  const kind =
    typeof feed?.classify === 'function'
      ? feed.classify(routeId, context || {})
      : null;
  if (!kind) return null;
  if (!RAIL_CATEGORIES.includes(kind.category)) return null;
  if (!RAIL_MODES.includes(kind.mode)) return null;
  return kind;
}

/**
 * Public catalog shape served by `/api/rail/feeds`: everything the browser
 * needs to gate polling, label positions and credit the source, and nothing
 * it could misuse. With `schedulePackBuilt`, a feed that needs its pack
 * (`railFeedNeedsSchedulePack`) appears only once the host has that pack:
 * packs are opt-in build output, so a feed nobody has built is absent rather
 * than shown as unavailable.
 * @param {{schedulePackBuilt?: ((feedId: string) => boolean)|null}}
 *   [options]
 * @returns {object[]}
 */
export function publicRailCatalog({ schedulePackBuilt = null } = {}) {
  const listed = (feed) =>
    typeof schedulePackBuilt !== 'function' ||
    !railFeedNeedsSchedulePack(feed) ||
    schedulePackBuilt(feed.id) === true;
  return railEnabledFeeds()
    .filter(listed)
    .map((feed) => ({
      id: feed.id,
      name: feed.name,
      operator: feed.operator,
      region: feed.region,
      center: { ...feed.center },
      loadRadiusKm: feed.loadRadiusKm,
      positions: railFeedPositions(feed),
      tripUpdates: railFeedHasTripUpdates(feed),
      license: feed.license,
      licenseUrl: feed.licenseUrl,
      attribution: feed.attribution,
    }));
}
