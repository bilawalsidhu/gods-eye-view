import { greatCircleKm } from '../geoDistance.js';
import { RIO_ROUTE_NAMES } from './rioRouteNames.js';
import { CATALOGUE_TRANSIT_FEED_ROWS } from './transitFeedsCatalogue.js';
import { FRANCE_TRANSIT_FEED_ROWS } from './transitFeedsFrance.js';
import { JAPAN_TRANSIT_FEED_ROWS } from './transitFeedsJapan.js';
import { FRANCE_ROUTE_NAMES } from './transitRouteNamesFrance.js';

/**
 * @module transitFeeds
 * @description Registry of keyless, openly licensed GTFS-Realtime
 * VehiclePositions feeds the Transit layer can show.
 *
 * Every entry here is a URL the SERVER fetches — the browser only ever asks
 * `/api/transit/vehicles/<id>` for a registered id (see SECURITY.md: proxies
 * never fetch client-supplied URLs). Adding a feed means adding a row here,
 * a DATA_SOURCES.md row with its license, and a credit in dataCredits.js.
 * The French networks listed on transport.data.gouv.fr are rows of the same
 * shape in `transitFeedsFrance.js`, and feeds added from the open catalogues
 * are in `transitFeedsCatalogue.js` and `transitFeedsJapan.js`; all are appended
 * to the registry below.
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
 * The fleet number settles TTC's mode before the route does: buses replace
 * streetcars on 5xx routes during track work, and streetcars running out of
 * service report no route at all. Flexity streetcars are numbered 4400–4699;
 * every other TTC number is a bus.
 * @param {string|null} vehicleId GTFS-RT vehicle id (the fleet number).
 * @returns {string}
 */
function ttcVehicleMode(vehicleId) {
  if (!/^\d{4}$/.test(String(vehicleId ?? ''))) return 'unknown';
  const fleet = Number(vehicleId);
  return fleet >= 4400 && fleet < 4700 ? 'tram' : 'bus';
}

/**
 * Guelph Transit's realtime feed publishes the internal database key of a
 * route (`2991`), not the number on the front of the bus (`1`). Without this
 * table the detection label reads "Route 2991", which is not what anyone at
 * the stop calls it. Route ids and short names are from the City of Guelph's
 * own published GTFS `routes.txt` (see DATA_SOURCES.md); an id missing here
 * falls through unchanged, so a route added later degrades to its raw id
 * rather than disappearing.
 */
const GUELPH_ROUTE_NAMES = Object.freeze({
  2991: '1',
  2992: '10',
  2993: '11',
  2994: '12',
  2995: '13',
  2996: '14',
  2997: '15',
  2998: '16',
  2999: '17',
  3000: '18',
  3001: '19',
  3002: '2',
  3003: '20',
  3004: '3',
  3005: '4',
  3006: '5',
  3007: '50 U',
  3008: '52 U',
  3009: '56 U',
  3010: '58 U',
  3011: '6',
  3012: '7',
  3013: '8',
  3014: '9',
  3015: '98',
  3016: '99',
  3017: '99Lite',
  3018: 'BREW',
  3019: 'EdiCol',
  3023: 'IroHarv',
  3030: 'Sun LN',
  3032: 'WHanSco',
  3039: 'ZehCha',
});

/**
 * Guelph route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function guelphRouteLabel(routeId) {
  return GUELPH_ROUTE_NAMES[routeId] || routeId;
}

/**
 * Hamilton publishes an internal key for every route: not one of HSR's 80 route
 * ids equals the number on the bus, so an untranslated feed reads as
 * "Route 5783" city-wide. Two generations of id are live at once — `5688` and
 * `5780` are both the 2 BARTON — and both are listed, because both arrive.
 *
 * Numbers are unpadded to match the rest of the registry (`routes.txt` says
 * `02`; a rider says 2). The seasonal and event shuttles publish a name rather
 * than a number — `TC230`, `PEACH`, `ROCKTON` — and those are already what a
 * rider would say, so they survive as published. Ids and names are from the
 * City's own published GTFS `routes.txt`, under the same terms as the feed.
 */
const HAMILTON_ROUTE_NAMES = Object.freeze({
  5687: '1',
  5688: '2',
  5689: '3',
  5690: '4',
  5691: '5',
  5692: '6',
  5693: '7',
  5694: '8',
  5695: '9',
  5696: '10',
  5697: '11',
  5698: '12',
  5699: '16',
  5700: '18',
  5701: '20',
  5702: '21',
  5703: '22',
  5704: '23',
  5705: '24',
  5706: '25',
  5707: '26',
  5708: '27',
  5709: '33',
  5710: '34',
  5711: '35',
  5712: '41',
  5713: '42',
  5714: '43',
  5715: '44',
  5716: '51',
  5717: '52',
  5718: '55',
  5719: '56',
  5720: '99',
  5731: 'X-IND',
  5780: '2',
  5781: '3',
  5782: '4',
  5783: '5',
  5784: '6',
  5785: '7',
  5786: '8',
  5787: '9',
  5789: '11',
  5790: '12',
  5791: '16',
  5792: '18',
  5793: '20',
  5794: '21',
  5795: '22',
  5796: '23',
  5797: '24',
  5798: '25',
  5799: '26',
  5800: '27',
  5801: '33',
  5802: '34',
  5803: '35',
  5805: '42',
  5806: '43',
  5807: '44',
  5808: '51',
  5809: '52',
  5811: '56',
  5812: '99',
  5820: 'TC230',
  5823: 'X IND',
  5824: 'TC-700',
  5825: 'TC-300',
  5826: 'CAN',
  5827: 'PEACH',
  5828: '1',
  5829: '10',
  5830: '41',
  5831: '55',
  5832: 'TC300',
  5833: 'TC700',
  5834: 'TC730',
  5835: 'ANCFAIR',
  5836: 'ROCKTON',
});

/**
 * Hamilton route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function hamiltonRouteLabel(routeId) {
  return HAMILTON_ROUTE_NAMES[routeId] || routeId;
}

/**
 * YRT publishes Viva bus rapid transit by route id (`601`), while every rider,
 * station sign and map calls it "Viva Blue". Plain local routes are already the
 * number on the bus and are left alone, unpadded: `105` reads better than the
 * `005` of `routes.txt`.
 *
 * Branches are the exception. YRT suffixes a two-digit branch onto the base
 * route — the scheme Viva's own `60102` follows — so a branch id reaches a
 * rider as "8301" unless it is translated. Names and colours are from York
 * Region's own published GTFS `routes.txt`; Viva Green (604) and Pink (606)
 * are not in current service and so are absent here too.
 *
 * Only branches observed live AND published in `routes.txt` are listed. `9101`
 * runs but is unpublished, so it is deliberately missing: the pattern suggests
 * "91A", and suggesting is not knowing.
 */
const YRT_ROUTE_NAMES = Object.freeze({
  601: 'Viva Blue',
  60102: 'Viva Blue B',
  603: 'Viva Purple',
  60301: 'Viva Purple A',
  605: 'Viva Orange',
  607: 'Viva Yellow',
  8301: '83A',
  9002: '90B',
  10702: '107B',
});

/**
 * YRT route id to the name a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function yrtRouteLabel(routeId) {
  return YRT_ROUTE_NAMES[routeId] || routeId;
}

/**
 * Burlington publishes the internal key of a route, and the keys are a trap:
 * `351` is route 1 while `3510` is route 10, so trimming a `35` prefix gets
 * the wrong answer on half the network. The join is the only correct route.
 * Ids and numbers are from the City's own published GTFS `routes.txt`, which
 * sits in the same directory as the realtime feed under the same terms.
 */
const BURLINGTON_ROUTE_NAMES = Object.freeze({
  351: '1',
  352: '2',
  353: '3',
  354: '4',
  356: '6',
  3510: '10',
  3511: '11',
  3512: '12',
  3525: '25',
  3548: '48',
  3550: '50',
  3551: '51',
  3552: '52',
  3580: '80',
  3581: '81',
  3587: '87',
});

/**
 * Burlington route id to the number a rider would say.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function burlingtonRouteLabel(routeId) {
  return BURLINGTON_ROUTE_NAMES[routeId] || routeId;
}

/**
 * Rio route key to the line a rider would say. One SMTR `routes.txt` covers
 * both feeds (see rioRouteNames.js).
 * @param {string|null} routeId
 * @returns {string|null}
 */
function rioRouteLabel(routeId) {
  return Object.hasOwn(RIO_ROUTE_NAMES, routeId)
    ? RIO_ROUTE_NAMES[routeId]
    : routeId;
}

/**
 * Carris Metropolitana realtime route ids wrap the GTFS route id in an
 * operator-area prefix and keep its pattern suffix: `[LA77N]1708_0` is GTFS
 * route `1708_0`, whose `short_name` (the number on the bus) is `1708`, per
 * the operator's own `/v2/routes` API. Anything else passes through.
 * @param {string|null} routeId
 * @returns {string|null}
 */
function carrisMetropolitanaRouteLabel(routeId) {
  const match = /^\[[A-Z0-9]+\](\d{4})_\d+$/.exec(routeId ?? '');
  return match ? match[1] : routeId;
}

/**
 * Route ids that wrap the rider-facing line in a fixed prefix, suffix or
 * zero-padding. The returned function yields the captured line, or the id
 * unchanged when it does not match the operator's pattern.
 * @param {RegExp} pattern One capture group: the line a rider would say.
 * @returns {(routeId: string|null) => string|null}
 */
function routeIdPattern(pattern) {
  return (routeId) => {
    const match = pattern.exec(routeId ?? '');
    return match ? match[1] : routeId;
  };
}

/** Zero-padded numbers (Edmonton `005`, Toulon `0002`, Bordeaux `01`). */
const unpaddedRouteLabel = routeIdPattern(/^0+(\d+\w*)$/);
/** Turin GTT appends `U` (urban) to the line: `10NU` is night line 10N. */
const gttRouteLabel = routeIdPattern(/^(\w+?)U$/);
/** Venice ACTV appends the network: `5.1_UN` is waterbus line 5.1, `53E_ES` bus 53E. */
const actvRouteLabel = routeIdPattern(/^(.+)_[A-Z]{2}$/);
/** BC Transit appends the system: `95-VIC` is Victoria route 95. */
const bcTransitRouteLabel = routeIdPattern(/^(.+)-VIC$/);
/** Carris (Lisbon city) appends a variant: `172_1` is route 172. */
const carrisRouteLabel = routeIdPattern(/^(\w+)_\d+$/);
/** Astuce prefixes the network: `TCAR:93` is Rouen line 93. */
const astuceNetworkLabel = routeIdPattern(/^[A-Z]+:(.+)$/);
/** BAS.MY Johor appends a fixed operator code: `J33CWLMYJB` is route J33. */
const mybasJohorRouteLabel = routeIdPattern(/^(.+?)CWLMYJB$/);

/** LiA prefixes its network: `8-C3` is Le Havre line C3, `8-09` line 9. */
const liaRouteLabel = routeIdPattern(/^8-0*(\w.*)$/);

/**
 * Le Havre LiA runs its two tram lines as A and B and the funicular as
 * `FUNI`; every other line is a bus.
 * @param {string|null} routeId
 * @returns {string}
 */
function liaRouteMode(routeId) {
  if (!routeId) return 'unknown';
  const line = liaRouteLabel(routeId);
  if (line === 'FUNI') return 'rail';
  return /^[AB]$/.test(line) ? 'tram' : 'bus';
}

/**
 * Rouen Astuce lines that are not buses, by route id, from the TCAR
 * routes.txt (checked 2026-11-09): line 90 is the Métro (GTFS type 1, a light
 * rail that runs mostly on the street) and 99 the Calypso river boat.
 */
const ASTUCE_ROUTES = Object.freeze({
  // i18n-ignore: line name, as on the vehicle
  'TCAR:90': Object.freeze({ mode: 'tram', label: 'Métro' }),
  // i18n-ignore: line name, as on the vehicle
  'TCAR:99': Object.freeze({ mode: 'ferry', label: 'Calypso' }),
});

/** @param {string|null} routeId @returns {string} */
function astuceRouteMode(routeId) {
  if (!routeId) return 'unknown';
  return ASTUCE_ROUTES[routeId]?.mode ?? 'bus';
}

/** `TCAR:93` is Rouen line 93; the Métro and Calypso keep their names. */
function astuceRouteLabel(routeId) {
  return ASTUCE_ROUTES[routeId ?? '']?.label ?? astuceNetworkLabel(routeId);
}

/**
 * Prague PID route ids are `L` plus a number whose range says what runs it,
 * per PID's GTFS routes.txt (data.pid.cz, checked 2026-11-09): 1–99 trams
 * (50–59 trolleybuses, 49 the Petřín funicular `LD`), 100–990 buses (the
 * 800s are the X replacement lines, `L803` is X3), 991–993 metro A–C,
 * 1000s and 1100s the S and R trains (`L1004` is S4, `L1109` R9), the rest
 * of 1200–1399 other trains, 1700s town buses, 1800s the P ferries, and from
 * 2000 more buses (`L2841` is 841). A label the range cannot give stays the
 * route id.
 * @param {string|null} routeId
 * @returns {{mode: string, label: string|null}}
 */
function pidRoute(routeId) {
  const match = /^L(\d+)$/.exec(routeId ?? '');
  if (!match) return { mode: 'unknown', label: routeId };
  const n = Number(match[1]);
  // i18n-ignore: line code, as signed
  if (n === 49) return { mode: 'rail', label: 'LD' };
  if (n >= 50 && n <= 59) return { mode: 'bus', label: String(n) };
  if (n < 100) return { mode: 'tram', label: String(n) };
  if (n >= 800 && n < 900) return { mode: 'bus', label: `X${n - 800}` };
  if (n < 991) return { mode: 'bus', label: String(n) };
  // i18n-ignore: metro line letters, as signed
  if (n <= 993) return { mode: 'subway', label: 'ABC'[n - 991] };
  if (n >= 1000 && n < 1100) return { mode: 'rail', label: `S${n - 1000}` };
  if (n >= 1100 && n < 1200) return { mode: 'rail', label: `R${n - 1100}` };
  if (n >= 1200 && n < 1400) return { mode: 'rail', label: routeId };
  if (n >= 1800 && n < 1900) return { mode: 'ferry', label: `P${n - 1800}` };
  if (n >= 2800 && n < 2900) return { mode: 'bus', label: String(n - 2000) };
  return { mode: n >= 1700 ? 'bus' : 'unknown', label: routeId };
}

/** @param {string|null} routeId @returns {string} */
function pidRouteMode(routeId) {
  return pidRoute(routeId).mode;
}

/** @param {string|null} routeId @returns {string|null} */
function pidRouteLabel(routeId) {
  return pidRoute(routeId).label;
}

/**
 * Bordeaux TBM tram and boat lines by route id, from TBM's static GTFS
 * routes.txt (checked 2026-11-09): the trams are numbered ids, not letters.
 */
const TBM_TRAM_LINES = Object.freeze({
  59: 'A',
  60: 'B',
  61: 'C',
  62: 'D',
  163: 'E',
  164: 'F',
});
const TBM_BOAT_LINES = new Set(['951', '952', '953']);

/**
 * Bordeaux TBM: trams A–F and the BAT³ river shuttles; every other line is a
 * bus.
 * @param {string|null} routeId
 * @returns {string}
 */
function tbmRouteMode(routeId) {
  if (!routeId) return 'unknown';
  if (Object.hasOwn(TBM_TRAM_LINES, routeId)) return 'tram';
  return TBM_BOAT_LINES.has(routeId) ? 'ferry' : 'bus';
}

/** `59` is tram A; zero-padded bus ids lose their padding (`01` is 1). */
function tbmRouteLabel(routeId) {
  return Object.hasOwn(TBM_TRAM_LINES, routeId ?? '')
    ? TBM_TRAM_LINES[routeId]
    : unpaddedRouteLabel(routeId);
}

/**
 * A registry entry, frozen with its centre and terms, and switched on.
 * @param {object} fields
 * @returns {Readonly<object>}
 */
function transitFeed(fields) {
  return Object.freeze({
    defaultEnabled: true,
    ...fields,
    center: Object.freeze({ ...fields.center }),
    terms: Object.freeze({ ...fields.terms }),
    ...(fields.headers
      ? { headers: Object.freeze({ ...fields.headers }) }
      : {}),
  });
}

/**
 * A French network row (`transitFeedsFrance.js`) as a registry entry. Every
 * one is a bus network unless its row says otherwise: `routeModes` names the
 * route ids that are trams or boats, and a route id it does not name stays a
 * default, never a resolved "bus". The licence name, record link and terms
 * note are built from the row's `licence`, `record`, `vehicles` and `note`.
 * A feed with a table in
 * `transitRouteNamesFrance.js` reads its line names from it; an id missing
 * from the table renders unchanged.
 * @param {object} row
 * @returns {Readonly<object>}
 */
function franceTransitFeed(row) {
  const { routeModes, licence, record, vehicles, note, ...fields } = row;
  const odbl = licence === 'odc-odbl';
  const names = Object.hasOwn(FRANCE_ROUTE_NAMES, row.id)
    ? FRANCE_ROUTE_NAMES[row.id]
    : null;
  return transitFeed({
    defaultMode: 'bus',
    ...fields,
    license: odbl ? 'ODbL' : 'Licence Ouverte 2.0',
    licenseUrl: `https://transport.data.gouv.fr/datasets/${record}`,
    terms: {
      quote: `licence: ${licence}`,
      note: [
        `Dataset record’s licence field quoted; this is the record’s own GTFS-RT vehicle feed (${vehicles} vehicles on 2026-11-13).`,
        odbl
          ? 'ODbL asks for credit and share-alike on a derived database; the layer draws positions and redistributes no database.'
          : '',
        note ?? '',
      ]
        .filter(Boolean)
        .join(' '),
    },
    ...(routeModes
      ? {
          routeMode: (routeId) =>
            routeId && Object.hasOwn(routeModes, routeId)
              ? routeModes[routeId]
              : 'unknown',
        }
      : {}),
    ...(names
      ? {
          routeLabel: (routeId) =>
            routeId && Object.hasOwn(names, routeId) ? names[routeId] : routeId,
        }
      : {}),
  });
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
 *   speedUnit?: 'km/h', refreshMs?: number, sourceUrl?: string,
 *   creditDated?: boolean,
 * }>>}
 * `speedUnit` marks a feed that publishes km/h where the spec requires m/s;
 * the proxy converts it before the snapshot leaves the server. `refreshMs`
 * stretches the proxy's cache for an upstream that rate-limits below one
 * request per 15 s TTL. `sourceUrl` and `creditDated` add a link and a date
 * to the credit for licences that ask for them (`transitFeedCredit`).
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
    vehicleMode: ttcVehicleMode,
  }),
  Object.freeze({
    id: 'miway-mississauga',
    name: 'MiWay',
    operator: 'MiWay (City of Mississauga)',
    region: 'Mississauga, ON',
    center: Object.freeze({ lat: 43.589, lon: -79.6441 }),
    loadRadiusKm: 30,
    url: 'https://www.miapp.ca/GTFS_RT/Vehicle/VehiclePositions.pb',
    license: 'City of Mississauga Open Data Terms of Use',
    licenseUrl:
      'http://www5.mississauga.ca/research_catalogue/CityofMississauga_TermsofUse.pdf',
    attribution: 'MiWay \u2014 City of Mississauga Open Data',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The City of Mississauga (the City) now grants you a world-wide, royalty-free, non-exclusive, revocable licence to use, modify, and distribute the Datasets in all current and future media and formats for any lawful purpose.',
      note: 'Two conditions shape how this ships. The licence is REVOCABLE, and it asks that anyone who provides access to the data pass on the Terms of Use URL \u2014 so `licenseUrl` points at the terms themselves rather than at a catalogue page, and the attribution popover carries the link. Credit is optional here ("you are not required to credit the City"), and is given anyway as a courtesy, the way the other municipal feeds are.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'hsr-hamilton',
    name: 'Hamilton HSR',
    operator: 'Hamilton Street Railway (City of Hamilton)',
    region: 'Hamilton, ON',
    center: Object.freeze({ lat: 43.2557, lon: -79.8711 }),
    loadRadiusKm: 30,
    url: 'https://opendata.hamilton.ca/GTFS-RT/GTFS_VehiclePositions.pb',
    license: 'City of Hamilton Open Data Licence',
    licenseUrl:
      'https://www.hamilton.ca/city-initiatives/strategies-actions/open-data-licence-terms-and-conditions',
    attribution:
      'Contains public sector Data made available under the City of Hamilton\u2019s Open Data Licence',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The City of Hamilton grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Data, including for commercial purposes ... you must acknowledge the source of the Data by including the following attribution statement: \u201cContains public sector Data made available under the City of Hamilton\u2019s Open Data Licence\u201d.',
      note: 'The attribution wording is prescribed by the licence, so it is used verbatim as the credit rather than paraphrased to an operator name. Names, crests, logos and marks are excluded from the grant, so the credit stays text.',
    }),
    defaultMode: 'bus',
    routeLabel: hamiltonRouteLabel,
  }),
  Object.freeze({
    id: 'durham-region',
    name: 'Durham Region Transit',
    operator: 'Durham Region Transit (Regional Municipality of Durham)',
    region: 'Durham Region, ON',
    center: Object.freeze({ lat: 43.9496, lon: -78.9365 }),
    loadRadiusKm: 45,
    url: 'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions',
    license: 'Region of Durham Open Data Licence v.1.0',
    licenseUrl: 'https://www.durham.ca/en/regional-government/open-data.aspx',
    attribution:
      "Contains public sector information made available under The Regional Municipality of Durham's Open Data Licence",
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Durham Region grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the information ... You are free to: Copy, publish, distribute and transmit the information ... Use the information commercially.',
      note: 'The licence link the open-data catalogue publishes for this feed (OpenDataLicenceAgreement.pdf) is dead after a site relaunch; `licenseUrl` points at the live Open Data page carrying the same licence v.1.0 text, which is where the quote above was read. Credit is optional and the suggested statement is used verbatim.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'guelph-transit',
    name: 'Guelph Transit',
    operator: 'Guelph Transit (City of Guelph)',
    region: 'Guelph, ON',
    center: Object.freeze({ lat: 43.5325, lon: -80.2482 }),
    loadRadiusKm: 15,
    url: 'https://glphprdtmgtfs.glphtrpcloud.com/tmgtfsrealtimewebservice/vehicle/vehiclepositions.pb',
    license: 'Open Government Licence \u2013 City of Guelph (v2.0)',
    licenseUrl: 'https://explore.guelph.ca/pages/open-data-license',
    attribution:
      'Contains information licensed under the Open Government Licence \u2013 City of Guelph',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Information Provider grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Information including for commercial purposes subject to the terms below. ... Acknowledge the source of the Information by including any attribution statement specified by the Information Provider(s) and, where possible, provide a link to this licence.',
      note: 'The endpoint sits on a vendor host, so provenance matters: the City publishes this exact URL on its own open-data developer page, https://explore.guelph.ca/pages/transit-gtfs-data, under an open-data initiative heading (that page is JavaScript-rendered; its readable source is the ArcGIS item JSON behind it). The licence is a verbatim OGL-Canada 2.0 derivative and the attribution wording above is its prescribed fallback, so it is used as written. The transit datasets carry a BLANK licence field in the portal catalogue; the Terms of Use supply it by default ("Except where otherwise noted this is the Open Government Licence"), the same shape of gap the TTC entry records. The Terms also publish a traffic limit \u2014 no concurrent requests, at most 5 per second \u2014 which one poll every 15 s satisfies many times over. Crests and logos are excluded from the grant, so the credit stays text.',
    }),
    defaultMode: 'bus',
    routeLabel: guelphRouteLabel,
  }),
  Object.freeze({
    id: 'kingston-transit',
    name: 'Kingston Transit',
    operator: 'Kingston Transit (The Corporation of the City of Kingston)',
    region: 'Kingston, ON',
    center: Object.freeze({ lat: 44.24, lon: -76.57 }),
    loadRadiusKm: 20,
    url: 'https://api.cityofkingston.ca/gtfs-realtime/vehicleupdates.pb',
    license: 'City of Kingston Open Data Licence 1.0',
    licenseUrl:
      'https://www.cityofkingston.ca/media/wtpgpkb0/gis_license_opendata.pdf',
    attribution:
      'Contains information licensed under the Open Data Licence \u2013 City of Kingston',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Information Provider, the City of Kingston, grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the information provided for any purpose, including for commercial purposes, subject to the terms below. ... Acknowledge the source of the information by including any attribution statement specified by the City of Kingston and, where possible, provide a link to this licence.',
      note: 'The City catalogues this exact URL as an open-data dataset, so provenance is direct rather than inferred. `licenseUrl` is the canonical location of the licence PDF; the address the catalogue prints is a legacy path that currently redirects there, and pinning the redirect target is what survives the next site relaunch \u2014 the Durham entry records what happens when it does not. Names, crests and logos are excluded from the grant, so the credit stays text. Roughly one entity in ten carries no usable position (the position field absent, occasionally a momentary 0,0 GPS dropout); both are discarded before rendering.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'barrie-transit',
    name: 'Barrie Transit',
    operator: 'Barrie Transit (City of Barrie)',
    region: 'Barrie, ON',
    center: Object.freeze({ lat: 44.371, lon: -79.6733 }),
    loadRadiusKm: 10,
    url: 'https://www.myridebarrie.ca/gtfs/GTFS_VehiclePositions.pb',
    license: 'Barrie Transit Data licence',
    licenseUrl:
      'https://www.barrie.ca/services-payments/transportation-parking/barrie-transit/barrie-gtfs',
    attribution:
      'Realtime vehicle data \u00a9 City of Barrie, used under the Barrie Transit Data licence',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'Barrie Transit hereby grants you a non-exclusive, limited and revocable rights to use, reproduce, and redistribute Barrie Transit Data (scheduled and real-time data) subject to the following terms: Barrie Transit trademarks and copyrighted materials, including any confusingly similar variants, may not be used in association with Data. ... Barrie Transit maintains title, ownership, rights and interest in and to Data.',
      note: 'The City offers this licence for acceptance behind a click-through checkbox, and the licence body also makes use itself acceptance: \u201cBy using Barrie Transit Data, you agree to be bound by these terms.\u201d This deployment\u2019s owner took that clause as sufficient on 2026-09-16 and switched the feed on; nothing gates the endpoint, which needs no key, token or cookie. Two oddities worth knowing: the licence requires NO attribution at all (the credit above is a courtesy), and its trademark clause is broad enough that the credit names the City rather than Barrie Transit. The grant is expressly REVOCABLE and unversioned, so the quote above is the text as read on 2026-09-16.',
    }),
    defaultMode: 'bus',
  }),
  Object.freeze({
    id: 'yrt-york',
    name: 'YRT/Viva',
    operator:
      'York Region Transit (YRT/Viva), The Regional Municipality of York',
    region: 'York Region, ON',
    center: Object.freeze({ lat: 44.025, lon: -79.436 }),
    loadRadiusKm: 38,
    url: 'https://rtu.york.ca/gtfsrealtime/VehiclePositions',
    license: 'YRT Open Data Licence v2.0 (UK OGL-derived)',
    licenseUrl:
      'https://www.yrt.ca/en/about-us/open-data-licence-agreement.aspx',
    attribution:
      "Contains public transit Information made available under YRT's Open Data Licence",
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'YRT grants You a worldwide, royalty-free, perpetual, non-exclusive licence to Use the Information subject to the conditions below ... Use the Information commercially ... Provide credit to YRT when using Information under this licence but are not required to. ... Please note: You must agree with and accept the above stated License Agreement in order to download YRT GTFS or real-time GTFS data.',
      note: 'The operator asks that its licence be accepted through a form (forms.yrt.ca/YRT-GTFS-Data, which collects a name, company, phone and email and issues no credential), while the licence body says acceptance is by use: \u201cYour Use of Information indicates Your acceptance of the terms and conditions below.\u201d This deployment\u2019s owner took that clause as sufficient on 2026-09-16 and switched the feed on. Nothing gates the endpoint. The credit above is the licence\u2019s own wording and must be reproduced as given; attribution is optional here, and given anyway. Logos, trademarks and crests are carved out, so the credit stays text. Two data notes: no vehicle carries a bearing, so heading comes from observed movement; and one stuck unit reported a position ten hours old, which the layer shows as a stale report rather than hides.',
    }),
    defaultMode: 'bus',
    routeLabel: yrtRouteLabel,
  }),
  Object.freeze({
    id: 'burlington-transit',
    name: 'Burlington Transit',
    operator: 'Burlington Transit (City of Burlington)',
    region: 'Burlington, ON',
    center: Object.freeze({ lat: 43.3342, lon: -79.8089 }),
    loadRadiusKm: 12,
    url: 'https://opendata.burlington.ca/gtfs-rt/GTFS_VehiclePositions.pb',
    license: 'City of Burlington Open Data Terms of Use',
    licenseUrl:
      'https://opendata.burlington.ca/opendata-terms-of-use/City%20of%20Burlington%20-%20Open%20Data%20Terms%20of%20Use.pdf',
    attribution:
      'Transit data \u00a9 City of Burlington (Burlington Transit), used under the City of Burlington Open Data Terms of Use',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'The Corporation of the City of Burlington (the City) now grants you a worldwide, royalty-free, non-exclusive, revocable licence to use, reproduce, modify, and distribute the datasets in all current and future media and formats for any lawful purpose. ... If you distribute or provide access to these datasets to any other person ... you agree to include a copy of, or this Uniform Resource Locator (URL) for, these Terms of Use.',
      note: 'Same 2011-era municipal template as Mississauga, and the same two consequences: the grant is REVOCABLE, and the terms have to travel with the data, so `licenseUrl` is the Terms document itself rather than a catalogue page and the attribution popover carries the link. Credit is optional here and given anyway. Crests, logos and marks are excluded and the terms forbid implying any association, so the credit stays plain text. The catalogue record for this data leads with a licence link that 404s; the URL above is the live one. Plain http:// has no listener at all \u2014 not a redirect, a hang \u2014 so the https:// URL is mandatory rather than preferred. The feed updates once a minute and answers conditional requests with an ETag.',
    }),
    defaultMode: 'bus',
    routeLabel: burlingtonRouteLabel,
  }),
  Object.freeze({
    id: 'smtr-rio-onibus',
    name: 'Rio buses (SPPO)',
    operator: 'Secretaria Municipal de Transportes (SMTR), Rio de Janeiro',
    region: 'Rio de Janeiro, RJ',
    // Every vehicle in a 2026-10-29 snapshot, from Santa Cruz in the west to
    // the Zona Sul, sat within 31 km of this point.
    center: Object.freeze({ lat: -22.92, lon: -43.42 }),
    loadRadiusKm: 45,
    url: 'https://dados.mobilidade.rio/gtfs/realtime/onibus/vehicle-positions',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://www.data.rio/documents/997bc16cc4344a5cb0e48ab06cbdfd1f',
    attribution: 'SMTR / Prefeitura da Cidade do Rio de Janeiro — buses (SPPO)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'This work is licensed under a Creative Commons Attribution 4.0 International License',
      note: 'The data.rio catalog page labels the feed [beta] and states a gateway limit of 5 requests a second and 60 a minute behind a 10-second cache, which the 15-second proxy TTL stays inside. SMTR relays the concessionaires’ ITS data and repairs trips with its own matching; the page places accuracy with the suppliers. Speeds are m/s, as the spec requires: checked against vehicle movement on 2026-11-05, though a 2026-10-29 snapshot read as km/h. Line names come from SMTR’s GTFS `routes.txt`, under the same CC BY 4.0 terms.',
    }),
    defaultMode: 'bus',
    routeLabel: rioRouteLabel,
  }),
  Object.freeze({
    id: 'smtr-rio-brt',
    name: 'Mobi-Rio BRT',
    operator:
      'Secretaria Municipal de Transportes (SMTR), Rio de Janeiro, for the Mobi-Rio BRT fleet',
    region: 'Rio de Janeiro, RJ',
    center: Object.freeze({ lat: -22.92, lon: -43.42 }),
    loadRadiusKm: 45,
    url: 'https://dados.mobilidade.rio/gtfs/realtime/brt/vehicle-positions',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://www.data.rio/documents/8bb196cc02174d25b77437bb2f6443d4',
    attribution:
      'SMTR / Prefeitura da Cidade do Rio de Janeiro — BRT (Mobi-Rio)',
    defaultEnabled: true,
    terms: Object.freeze({
      quote:
        'This work is licensed under a Creative Commons Attribution 4.0 International License',
      note: 'Same catalog terms, [beta] label and gateway limits as the bus feed. The fleet is operated by Mobi-Rio and tracked by SONDA, whose data SMTR relays. Speeds are m/s too. Line names come from the same `routes.txt`.',
    }),
    defaultMode: 'bus',
    routeLabel: rioRouteLabel,
  }),
  transitFeed({
    id: 'zditm-szczecin',
    name: 'Szczecin buses and trams',
    operator:
      'Zarząd Dróg i Transportu Miejskiego w Szczecinie (ZDiTM), Szczecin',
    region: 'Szczecin, Poland',
    // Every vehicle in a 2026-11-05 snapshot sat between 53.34–53.55 N and
    // 14.44–14.77 E, inside 20 km of this point.
    center: { lat: 53.44, lon: 14.56 },
    loadRadiusKm: 25,
    url: 'https://www.zditm.szczecin.pl/storage/gtfs/gtfs-rt-vehicles.pb',
    license: 'CC0 1.0',
    licenseUrl: 'https://www.zditm.szczecin.pl/en/zditm/for-developers',
    attribution:
      'Zarząd Dróg i Transportu Miejskiego w Szczecinie (ZDiTM Szczecin)',
    terms: {
      quote:
        'The data are provided free of charge under the CC0 1.0 licence, for use in any context, with no prior notification required.',
      note: 'CC0 needs no credit; it is given anyway as a courtesy. ZDiTM gives no guarantee of accuracy or completeness. The developer page says the feed updates every minute; measured on 2026-11-05 the file changed about every 20 seconds, with vehicle timestamps up to 50 seconds old. Speeds are m/s: checked against vehicle movement between two snapshots. The feed carries no route id at all, so every vehicle takes the feed default mode even though the city also runs trams.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'carris-metropolitana-lisboa',
    name: 'Carris Metropolitana',
    operator: 'Carris Metropolitana (TML), Lisbon Metropolitan Area',
    region: 'Lisbon Metropolitan Area, Portugal',
    // Every vehicle in a 2026-11-07 snapshot, from Mafra to Setúbal, sat
    // between 38.47–39.00 N and 9.47–8.79 W, inside 40 km of this point.
    center: { lat: 38.73, lon: -9.13 },
    loadRadiusKm: 45,
    url: 'https://api.carrismetropolitana.pt/v2/vehicles.pb',
    license: 'No separate licence for the realtime feed',
    licenseUrl: 'https://github.com/carrismetropolitana/api',
    attribution: 'Carris Metropolitana',
    terms: {
      quote:
        'GET /vehicles.pb — Returns vehicle locations in Protobuf format, following the GTFS-RT Vehicle Locations standard.',
      note: 'The operator publishes this feed keyless and documented for developers in its public API repository, but states no licence for the realtime endpoint; its static GTFS (github.com/carrismetropolitana/gtfs) is CC BY 4.0. Credited as a courtesy, on the same basis as the Metro Transit and OVapi feeds; switch it off if Carris objects. The quote above is the API README, not a licence. `/vehicles.pb` answers with a 307 to `/v2/vehicles.pb`, so the registry points at the target. Speeds are km/h, not the m/s the spec requires: 2026-11-07 readings of 31–33 matched 6–9 m/s of measured movement, so the proxy converts them. Vehicle reports arrive every 30–50 seconds. Route ids are the GTFS route id inside an area prefix and are read as the line number.',
    },
    defaultMode: 'bus',
    routeLabel: carrisMetropolitanaRouteLabel,
    speedUnit: 'km/h',
  }),
  transitFeed({
    id: 'pid-praha',
    name: 'Prague PID',
    operator: 'Pražská integrovaná doprava (PID), via Golemio',
    region: 'Prague and Central Bohemia, Czechia',
    // PID reaches across Central Bohemia: on 2026-11-08, 95% of 923 vehicles
    // sat within 58 km of Prague, the farthest at 98 km.
    center: { lat: 50.08, lon: 14.45 },
    loadRadiusKm: 60,
    url: 'https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb',
    license: 'CC BY',
    licenseUrl: 'https://pid.cz/o-systemu/opendata/',
    attribution: 'Pražská integrovaná doprava (PID) / Golemio',
    terms: {
      quote:
        'Data, která lze stáhnout přímo zde z webu, jsou stejně jako celý obsah webu opatřena licencí CC-BY',
      note: 'The PID open-data page lists this realtime feed and licenses the data it publishes under CC BY, crediting the author and any changes. The same page says data served from other sources follows that source’s licence; the feed is served by Golemio, the city’s data platform, which states none of its own. Keyless since the catalogue moved it off the X-Access-Token endpoint. Speeds are m/s, checked against movement on 2026-11-07. Route ids are `L` plus a number whose range gives the mode and the line (metro `L991` is A, train `L1004` is S4, ferry `L1801` is P1); `pidRoute` holds the table, read from PID’s GTFS routes.txt on 2026-11-09.',
    },
    defaultMode: 'bus',
    routeLabel: pidRouteLabel,
    routeMode: pidRouteMode,
  }),
  transitFeed({
    id: 'ztm-warszawa',
    name: 'Warsaw buses and trams',
    operator: 'Miasto Stołeczne Warszawa, relayed by mkuran.pl',
    region: 'Warsaw, Poland',
    center: { lat: 52.25, lon: 21.02 },
    loadRadiusKm: 30,
    url: 'https://mkuran.pl/gtfs/warsaw/vehicles.pb',
    license: 'Warsaw Open Data Project Usage Terms',
    licenseUrl: 'https://mkuran.pl/gtfs/',
    attribution: 'Miasto Stołeczne Warszawa (api.um.warszawa.pl)',
    sourceUrl: 'http://api.um.warszawa.pl',
    creditDated: true,
    terms: {
      quote:
        'The City Hall requires a credit by providing the name Miasto Stołeczne Warszawa, data download date (use the timestamp from the FeedHeader) and link to http://api.um.warszawa.pl.',
      note: 'Positions come from the Warsaw City Hall API, repackaged as GTFS-RT by Mikołaj Kuranowski’s unofficial feed. The credit names the city, links its API (`sourceUrl`) and carries the date of the feed timestamp (`creditDated`), the three things the terms ask for. Vehicle timestamps ran about two minutes old on 2026-11-07, which the delayed playback absorbs.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'tbm-bordeaux',
    name: 'Bordeaux TBM',
    operator: 'Transports Bordeaux Métropole (TBM), Bordeaux Métropole',
    region: 'Bordeaux, France',
    center: { lat: 44.85, lon: -0.65 },
    loadRadiusKm: 20,
    url: 'https://bdx.mecatran.com/utw/ws/gtfsfeed/vehicles/bordeaux?apiKey=opendata-bordeaux-metropole-flux-gtfs-rt',
    license: 'Licence Ouverte / Etalab 2.0',
    licenseUrl:
      'https://transport.data.gouv.fr/datasets/offres-de-services-bus-tram-et-scolaire-au-format-gtfs-netex-gtfs-rt-siri-lite',
    attribution: 'Bordeaux Métropole (TBM)',
    terms: {
      quote: 'licence: fr-lo',
      note: 'The quote is the licence field of the national access point’s dataset record (fr-lo is the Licence Ouverte), which asks only for credit. The `apiKey` in the URL is not a credential: it is the same fixed string printed in the open-data listing for everyone. Speeds are m/s. The trams (A–F) and BAT³ boats ride numbered route ids (tram A is `59`), so `tbmRouteMode` and `tbmRouteLabel` map them from TBM’s static GTFS; other numbered lines are buses.',
    },
    defaultMode: 'bus',
    routeLabel: tbmRouteLabel,
    routeMode: tbmRouteMode,
  }),
  transitFeed({
    id: 'sendai-city-bus',
    name: 'Sendai City Bus',
    operator: 'Sendai City Transportation Bureau (仙台市交通局), via ODPT',
    region: 'Sendai, Japan',
    center: { lat: 38.27, lon: 140.82 },
    loadRadiusKm: 22,
    url: 'https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_SendaiMunicipal_bus_realtime_information_vehicle',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: '仙台市交通局 (Sendai City Transportation Bureau) / ODPT',
    terms: {
      quote: 'https://creativecommons.org/licenses/by/4.0/',
      note: 'Served by the Open Data Challenge for Public Transportation (ODPT) public API, which needs no key for this feed; the catalogue records CC BY 4.0 as its licence. Vehicle timestamps ran about two minutes old on 2026-11-07. Speeds are m/s.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'ztm-poznan',
    name: 'Poznań buses and trams',
    operator: 'Zarząd Transportu Miejskiego w Poznaniu (ZTM Poznań)',
    region: 'Poznań, Poland',
    center: { lat: 52.39, lon: 16.92 },
    loadRadiusKm: 20,
    url: 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGtfsRtFile/?file=vehicle_positions.pb',
    license: 'ZTM Poznań open-data terms',
    licenseUrl: 'https://www.ztm.poznan.pl/otwarte-dane/dla-deweloperow/',
    attribution: 'Zarząd Transportu Miejskiego w Poznaniu (processed)',
    creditDated: true,
    terms: {
      quote:
        'Treści udostępniane są bezwnioskowo i bezpłatnie, na zasadach powszechnego dostępu i stanowią źródło informacji.',
      note: 'Reuse is free on three conditions: name the source, give the date of the last update, and say the data were processed. The credit names ZTM, says processed, and carries the date of the feed timestamp (`creditDated`) as the update date. The feed carries no bearing, so heading comes from movement between fixes.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'ztm-gdansk',
    name: 'Gdańsk buses and trams',
    operator: 'Zarząd Transportu Miejskiego w Gdańsku (ZTM Gdańsk)',
    region: 'Gdańsk, Poland',
    center: { lat: 54.35, lon: 18.6 },
    loadRadiusKm: 20,
    url: 'https://ckan2.multimediagdansk.pl/gtfs-rt?feed=vehiclePositions',
    license: 'CC BY 4.0',
    licenseUrl:
      'https://dane.gov.pl/pl/dataset/38599,rozklady-jazdy-i-lokalizacja-przystankow-gtfs-rt',
    attribution: 'Zarząd Transportu Miejskiego w Gdańsku',
    terms: {
      note: 'The national catalogue (dane.gov.pl) lists this dataset under CC BY 4.0. No bearing; heading comes from movement. Speeds are m/s.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'ets-edmonton',
    name: 'Edmonton Transit Service',
    operator: 'City of Edmonton (Edmonton Transit Service)',
    region: 'Edmonton, AB',
    center: { lat: 53.53, lon: -113.52 },
    loadRadiusKm: 25,
    url: 'https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb',
    license: 'City of Edmonton Open Data Agreement',
    licenseUrl:
      'https://www.edmonton.ca/transportation/Web-version2.1-OpenDataAgreement.pdf',
    attribution:
      'Contains information licensed under the Open Data Agreement – City of Edmonton',
    terms: {
      note: 'The agreement is the same municipal template as Mississauga and Burlington: a licence to use, modify and distribute for any lawful purpose, in any medium. It was read from search excerpts; the PDF itself would not extract here. Route ids are zero-padded. Speeds are m/s.',
    },
    defaultMode: 'bus',
    routeLabel: unpaddedRouteLabel,
  }),
  transitFeed({
    id: 'halifax-transit',
    name: 'Halifax Transit',
    operator: 'Halifax Regional Municipality (Halifax Transit)',
    region: 'Halifax, NS',
    center: { lat: 44.7, lon: -63.6 },
    loadRadiusKm: 22,
    url: 'https://gtfs.halifax.ca/realtime/Vehicle/VehiclePositions.pb',
    license: 'Open Government Licence – Halifax',
    licenseUrl: 'https://www.halifax.ca/home/open-data/open-data-license',
    attribution:
      'Contains information licenced under the Open Government Licence – Halifax',
    terms: {
      quote:
        'The information provider grants you a worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes, subject to the terms below.',
      note: 'Version 1.0, modelled on the Open Government Licence – Canada 2.0. The attribution is the licence’s own standard statement, with a link to the licence where possible. Logos and crests are excluded and no endorsement may be implied, so the credit stays plain text. The page refuses automated requests (403); its text was read in a browser on 2026-11-08. Speeds are m/s.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'bc-transit-victoria',
    name: 'Victoria Regional Transit',
    operator: 'BC Transit (Victoria Regional Transit System)',
    region: 'Victoria, BC',
    center: { lat: 48.53, lon: -123.43 },
    loadRadiusKm: 28,
    url: 'https://bct.tmix.se/gtfs-realtime/vehicleupdates.pb?operatorIds=48',
    license: 'BC Transit Open Data Terms of Use',
    licenseUrl: 'https://www.bctransit.com/open-data/terms-of-use',
    attribution: 'BC Transit',
    terms: {
      quote:
        'BC Transit grants you a limited, revocable and non-exclusive license to use, reproduce, and redistribute the Data in accordance with these Terms.',
      note: 'The grant is revocable, like the Ontario municipal templates. Route ids carry a `-VIC` system suffix. Speeds are m/s.',
    },
    defaultMode: 'bus',
    routeLabel: bcTransitRouteLabel,
  }),
  transitFeed({
    id: 'tam-montpellier',
    name: 'Montpellier TaM',
    operator: 'Montpellier Méditerranée Métropole (TaM)',
    region: 'Montpellier, France',
    center: { lat: 43.61, lon: 3.87 },
    loadRadiusKm: 20,
    url: 'https://gtfsproxy.e-tam.fr/COMMON/VehiclePosition.pb',
    license: 'ODbL',
    licenseUrl:
      'https://transport.data.gouv.fr/datasets/offre-de-transport-tam-en-temps-reel-gtfs-rt-urbain-et-suburbain',
    attribution: 'Montpellier Méditerranée Métropole (TaM)',
    terms: {
      quote: 'licence: odc-odbl',
      note: 'The quote is the dataset record’s licence field. ODbL asks for credit and share-alike on a derived database; the layer redistributes no database, it draws the positions. Speeds are km/h: readings ran 3.3 times the measured movement on 2026-11-07, so the proxy converts them.',
    },
    defaultMode: 'bus',
    speedUnit: 'km/h',
  }),
  transitFeed({
    id: 'ztp-krakow-bus',
    name: 'Kraków buses',
    operator: 'Zarząd Transportu Publicznego w Krakowie (ZTP Kraków)',
    region: 'Kraków, Poland',
    center: { lat: 50.06, lon: 19.94 },
    loadRadiusKm: 22,
    url: 'https://gtfs.ztp.krakow.pl/VehiclePositions_A.pb',
    license: 'No licence stated',
    licenseUrl: 'https://gtfs.ztp.krakow.pl/',
    attribution: 'Zarząd Transportu Publicznego w Krakowie',
    terms: {
      note: 'ZTP publishes this feed keyless on its own GTFS server and lists it in the Mobility Database, but states no licence there or on dane.gov.pl. Shipped on the same basis as Metro Transit and OVapi; switch it off if ZTP objects.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'ztp-krakow-tram',
    name: 'Kraków trams',
    operator: 'Zarząd Transportu Publicznego w Krakowie (ZTP Kraków)',
    region: 'Kraków, Poland',
    center: { lat: 50.06, lon: 19.94 },
    loadRadiusKm: 22,
    url: 'https://gtfs.ztp.krakow.pl/VehiclePositions_T.pb',
    license: 'No licence stated',
    licenseUrl: 'https://gtfs.ztp.krakow.pl/',
    attribution: 'Zarząd Transportu Publicznego w Krakowie',
    terms: { note: 'Same server and basis as the bus feed.' },
    defaultMode: 'tram',
  }),
  transitFeed({
    id: 'vilnius-transport',
    name: 'Vilnius public transport',
    operator: 'SĮ Susisiekimo paslaugos, Vilnius',
    region: 'Vilnius, Lithuania',
    center: { lat: 54.69, lon: 25.28 },
    loadRadiusKm: 20,
    url: 'https://www.stops.lt/vilnius/vehicle_positions.pb',
    license: 'No licence stated',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2383',
    attribution: 'SĮ Susisiekimo paslaugos (stops.lt)',
    terms: {
      note: 'Published keyless by the city transport agency on stops.lt; no licence found. Shipped on the same basis as Metro Transit and OVapi. Answered 522 once on 2026-11-07 and normally since.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'tpbi-bucuresti',
    name: 'Bucharest public transport',
    operator: 'Asociația de Dezvoltare Intercomunitară TPBI, Bucharest–Ilfov',
    region: 'Bucharest, Romania',
    center: { lat: 44.43, lon: 26.1 },
    loadRadiusKm: 25,
    url: 'https://gtfs.tpbi.ro/api/gtfs-rt/vehiclePositions',
    license: 'No licence stated',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2104',
    attribution: 'TPBI (Transport Public București–Ilfov)',
    terms: {
      note: 'Keyless public endpoint from the metropolitan transport authority; no licence found. Same basis as Metro Transit and OVapi.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'roma-mobilita',
    name: 'Rome public transport',
    operator: 'Roma Servizi per la Mobilità',
    region: 'Rome, Italy',
    center: { lat: 41.89, lon: 12.5 },
    loadRadiusKm: 35,
    url: 'https://romamobilita.it/wp-content/uploads/shared/rome_rtgtfs_vehicle_positions_feed.pb',
    license: 'No licence stated',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-1776',
    attribution: 'Roma Servizi per la Mobilità',
    terms: {
      note: 'Keyless file on the agency’s own site; the catalogue’s older `/sites/default/files/` path now 404s. No licence found; same basis as Metro Transit and OVapi. Fewer than one vehicle in five carries a bearing, so most headings come from movement.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'gtt-torino',
    name: 'Turin GTT',
    operator: 'Gruppo Torinese Trasporti (GTT)',
    region: 'Turin, Italy',
    center: { lat: 45.07, lon: 7.68 },
    loadRadiusKm: 20,
    url: 'https://percorsieorari.gtt.to.it/das_gtfsrt/vehicle_position.aspx',
    license: 'No licence stated',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2696',
    attribution: 'Gruppo Torinese Trasporti (GTT)',
    terms: {
      note: 'Official keyless endpoint; no licence found. Same basis as Metro Transit and OVapi. Route ids append `U` for urban lines.',
    },
    defaultMode: 'bus',
    routeLabel: gttRouteLabel,
  }),
  transitFeed({
    id: 'actv-venezia-bus',
    name: 'Venice ACTV buses',
    operator: 'Azienda del Consorzio Trasporti Veneziano (ACTV)',
    region: 'Venice, Italy',
    center: { lat: 45.4, lon: 12.2 },
    loadRadiusKm: 38,
    url: 'https://tpl.actv.it/aut/GTFSRT/vehiclePositions',
    license: 'ACTV open-data catalogue',
    licenseUrl:
      'https://actv.avmspa.it/it/content/catalogo-dei-dati-metadati-e-banche-dati-actv',
    attribution: 'ACTV S.p.A.',
    terms: {
      note: 'ACTV lists this feed in its own open-data catalogue; that page would not render for a script, so its licence is not quoted. Same basis as Metro Transit and OVapi. Route ids append a two-letter network code (`_UM`, `_ES`, `_UN`).',
    },
    defaultMode: 'bus',
    routeLabel: actvRouteLabel,
  }),
  transitFeed({
    id: 'actv-venezia-waterbus',
    name: 'Venice ACTV waterbuses',
    operator: 'Azienda del Consorzio Trasporti Veneziano (ACTV) Navigazione',
    region: 'Venice, Italy',
    center: { lat: 45.43, lon: 12.33 },
    loadRadiusKm: 15,
    url: 'https://tpl.actv.it/nav/GTFSRT/vehiclePositions',
    license: 'ACTV open-data catalogue',
    licenseUrl:
      'https://actv.avmspa.it/it/content/catalogo-dei-dati-metadati-e-banche-dati-actv',
    attribution: 'ACTV S.p.A.',
    terms: { note: 'Same catalogue and basis as the ACTV bus feed.' },
    defaultMode: 'ferry',
    routeLabel: actvRouteLabel,
  }),
  transitFeed({
    id: 'adelaide-metro',
    name: 'Adelaide Metro',
    operator: 'Adelaide Metro (Government of South Australia)',
    region: 'Adelaide, SA',
    center: { lat: -34.93, lon: 138.6 },
    loadRadiusKm: 35,
    url: 'https://gtfs.adelaidemetro.com.au/v1/realtime/vehicle_positions',
    // Any Accept naming a protobuf type gets base64 text labelled JSON; only
    // */* returns the binary feed (checked 2026-11-08).
    headers: { Accept: '*/*' },
    license: 'No licence stated for the realtime feed',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-1772',
    attribution: 'Adelaide Metro',
    terms: {
      note: 'Official keyless endpoint; the state catalogue page refused automated reads, so no licence is quoted. Same basis as Metro Transit and OVapi. Speeds are m/s. The server picks its encoding from Accept, hence the override.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'marta-atlanta',
    name: 'MARTA buses',
    operator: 'Metropolitan Atlanta Rapid Transit Authority (MARTA)',
    region: 'Atlanta, GA',
    center: { lat: 33.78, lon: -84.39 },
    loadRadiusKm: 35,
    url: 'https://gtfs-rt.itsmarta.com/TMGTFSRealTimeWebService/vehicle/vehiclepositions.pb',
    license: 'No licence stated',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-1601',
    attribution: 'MARTA',
    terms: {
      note: 'Official keyless endpoint; no licence found. Same basis as Metro Transit and OVapi. Speeds are m/s.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'rtd-denver',
    name: 'Denver RTD',
    operator: 'Regional Transportation District (RTD), Denver',
    region: 'Denver, CO',
    center: { lat: 39.75, lon: -104.99 },
    loadRadiusKm: 55,
    url: 'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb',
    license: 'RTD GTFS-realtime licence agreement',
    licenseUrl:
      'https://www.rtd-denver.com/business-center/open-spatial-data/gtfs-realtime-license-agreement',
    attribution: 'Regional Transportation District (RTD)',
    terms: {
      quote:
        'RTD hereby grants you non-exclusive, limited and revocable rights to use, reproduce, and redistribute the Data',
      note: 'Read 2026-11-09. The agreement is a click-through (“By clicking to download the Data files, you confirm that you have read and agree”) that RTD may change without notice; it permits redistribution, asks for no credit wording, and bars RTD trademarks from being used with the data, so the credit stays plain text. The feed itself is keyless. Speeds are m/s.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'ctp-cluj',
    name: 'Cluj-Napoca CTP',
    operator: 'Compania de Transport Public Cluj-Napoca',
    region: 'Cluj-Napoca, Romania',
    center: { lat: 46.77, lon: 23.59 },
    loadRadiusKm: 15,
    url: 'https://cluj-rt-feed.gtfs.ro/vehiclePositions',
    license: 'No licence stated',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2614',
    attribution: 'Compania de Transport Public Cluj-Napoca',
    terms: {
      note: 'Keyless; no licence found. Same basis as Metro Transit and OVapi.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'ctp-iasi',
    name: 'Iași CTP',
    operator: 'Compania de Transport Public Iași',
    region: 'Iași, Romania',
    center: { lat: 47.16, lon: 27.59 },
    loadRadiusKm: 15,
    url: 'https://iasi-rt-feed.gtfs.ro/vehiclePositions',
    license: 'No licence stated',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2118',
    attribution: 'Compania de Transport Public Iași',
    terms: {
      note: 'Keyless; no licence found. Same basis as Metro Transit and OVapi.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'mpk-rzeszow',
    name: 'Rzeszów city transport',
    operator: 'Rzeszowski Transport Miejski (MPK Rzeszów)',
    region: 'Rzeszów, Poland',
    center: { lat: 50.04, lon: 22.0 },
    loadRadiusKm: 15,
    url: 'https://www.mpkrzeszow.pl/gtfs/rt/gtfsrt.pb',
    license: 'MPK Rzeszów open data',
    licenseUrl: 'https://www.mpkrzeszow.pl/otwartedane/',
    attribution: 'MPK Rzeszów',
    terms: {
      note: 'Listed on the operator’s open-data page, which names no licence. No bearing; heading comes from movement.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'emt-malaga',
    name: 'Málaga EMT',
    operator: 'Empresa Malagueña de Transportes (EMT)',
    region: 'Málaga, Spain',
    center: { lat: 36.72, lon: -4.42 },
    loadRadiusKm: 15,
    url: 'https://gtfs.emtmalaga.es/GTFSRTapi/api/vehicleposition',
    license: 'No licence stated',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2213',
    attribution: 'EMT Málaga',
    terms: {
      note: 'Keyless; no licence found. Same basis as Metro Transit and OVapi. No bearing; heading comes from movement.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'carris-lisboa',
    name: 'Carris (Lisbon city)',
    operator: 'Carris – Companhia Carris de Ferro de Lisboa',
    region: 'Lisbon, Portugal',
    center: { lat: 38.74, lon: -9.15 },
    loadRadiusKm: 15,
    url: 'https://gateway.carris.pt/gateway/gtfs/api/v2.11/GTFS/realtime/vehiclepositions',
    license: 'No licence stated',
    licenseUrl: 'https://mobilitydatabase.org/feeds/gtfs_rt/mdb-2930',
    attribution: 'Carris',
    terms: {
      note: 'Keyless official gateway; no licence found. Same basis as Metro Transit and OVapi. Carries neither bearing nor speed, and vehicle reports run about a minute old. Route ids append a variant.',
    },
    defaultMode: 'bus',
    routeLabel: carrisRouteLabel,
  }),
  transitFeed({
    id: 'mybas-johor',
    name: 'BAS.MY Johor Bahru',
    operator: 'BAS.MY, via data.gov.my',
    region: 'Johor Bahru, Malaysia',
    center: { lat: 1.51, lon: 103.75 },
    loadRadiusKm: 35,
    url: 'https://api.data.gov.my/gtfs-realtime/vehicle-position/mybas-johor/',
    license: 'CC BY 4.0',
    licenseUrl: 'https://developer.data.gov.my/realtime-api/gtfs-realtime',
    attribution: 'BAS.MY / data.gov.my',
    // data.gov.my allows 4 GTFS-Realtime requests a minute and refreshes
    // vehicle positions every 30 seconds, so the proxy asks half as often as
    // the default 15 s TTL would.
    refreshMs: 30_000,
    terms: {
      quote: 'All GTFS Realtime feeds are licensed under CC BY 4.0.',
      note: 'Served keyless by Malaysia’s national open-data API (developer.data.gov.my, read 2026-11-09). Its rate-limit page caps GTFS Realtime at 4 requests a minute and answers 429 above that; the feed updates every 30 seconds, hence `refreshMs`. Without the trailing slash the API redirects. Route ids append an operator code.',
    },
    defaultMode: 'bus',
    routeLabel: mybasJohorRouteLabel,
  }),
  transitFeed({
    id: 'mybas-kota-bharu',
    name: 'BAS.MY Kota Bharu',
    operator: 'BAS.MY, via data.gov.my',
    region: 'Kota Bharu, Malaysia',
    // Routes run south into Kelantan: 95% of vehicles within 58 km on 2026-11-08.
    center: { lat: 6.06, lon: 102.22 },
    loadRadiusKm: 60,
    url: 'https://api.data.gov.my/gtfs-realtime/vehicle-position/mybas-kota-bharu/',
    license: 'CC BY 4.0',
    licenseUrl: 'https://developer.data.gov.my/realtime-api/gtfs-realtime',
    attribution: 'BAS.MY / data.gov.my',
    refreshMs: 30_000,
    terms: {
      quote: 'All GTFS Realtime feeds are licensed under CC BY 4.0.',
      note: 'Same API, licence and rate limit as Johor Bahru.',
    },
    defaultMode: 'bus',
  }),
  transitFeed({
    id: 'astuce-rouen',
    name: 'Rouen Astuce',
    operator: 'Métropole Rouen Normandie (Astuce), réseau TCAR',
    region: 'Rouen, France',
    center: { lat: 49.44, lon: 1.1 },
    loadRadiusKm: 20,
    url: 'https://api.mrn.cityway.fr/dataflow/vehicle-tc-tr/download?provider=TCAR&dataFormat=gtfs-rt',
    license: 'Licence Ouverte 2.0',
    licenseUrl:
      'https://transport.data.gouv.fr/datasets/donnees-statiques-et-temps-reel-du-reseau-astuce-metropole-rouen-normandie',
    attribution: 'Métropole Rouen Normandie (Astuce)',
    terms: {
      quote: 'licence: lov2',
      note: 'The metropolis publishes its realtime data under the Licence Ouverte (dataset record quoted), and this is its own TCAR vehicle feed from that record (178 vehicles on 2026-11-09). The suburban TAE and TNI networks are separate feeds in the same record and are not read here. Route ids carry the network prefix (`TCAR:`); `TCAR:90` is the Métro (a street-running light rail, drawn as a tram) and `TCAR:99` the Calypso boat.',
    },
    defaultMode: 'bus',
    routeLabel: astuceRouteLabel,
    routeMode: astuceRouteMode,
  }),
  transitFeed({
    id: 'mpm-toulon',
    name: 'Toulon Mistral',
    operator: 'Métropole Toulon Provence Méditerranée (réseau Mistral)',
    region: 'Toulon, France',
    center: { lat: 43.12, lon: 5.94 },
    loadRadiusKm: 18,
    url: 'https://feed-rdtpm-toulon.ratpdev.com/VehiclePosition/GTFS-RT',
    license: 'Licence Ouverte 2.0',
    licenseUrl:
      'https://transport.data.gouv.fr/datasets/reseau-de-transport-urbain-de-la-metropole-toulon-provence-mediterranee',
    attribution: 'Métropole Toulon Provence Méditerranée (Mistral)',
    terms: {
      quote: 'licence: lov2',
      note: 'Dataset record’s licence field quoted. Speeds are km/h: readings ran 3.5 times the measured movement on 2026-11-07, so the proxy converts them. Route ids are zero-padded.',
    },
    defaultMode: 'bus',
    routeLabel: unpaddedRouteLabel,
    speedUnit: 'km/h',
  }),
  transitFeed({
    id: 'lia-le-havre',
    name: 'Le Havre LiA',
    operator: 'Le Havre Seine Métropole (LiA)',
    region: 'Le Havre, France',
    center: { lat: 49.49, lon: 0.11 },
    loadRadiusKm: 18,
    url: 'https://opendata.transports-lia.fr/gtfs-rt/VehiclePosition.pb',
    license: 'ODbL',
    licenseUrl:
      'https://transport.data.gouv.fr/datasets/reseau-de-transport-en-commun-lia-gtfs-siri',
    attribution: 'Le Havre Seine Métropole (LiA)',
    terms: {
      quote: 'licence: odc-odbl',
      note: 'The network publishes under ODbL (dataset record quoted), and this is its own GTFS-RT vehicle feed from that record (105 vehicles on 2026-11-09). The layer draws positions and redistributes no database. Route ids carry the network prefix `8-`; lines A and B are the tramway.',
    },
    defaultMode: 'bus',
    routeLabel: liaRouteLabel,
    routeMode: liaRouteMode,
  }),
  transitFeed({
    id: 'filbleu-tours',
    name: 'Tours Fil Bleu',
    operator: 'Syndicat des Mobilités de Touraine (Fil Bleu)',
    region: 'Tours, France',
    center: { lat: 47.39, lon: 0.69 },
    loadRadiusKm: 18,
    url: 'https://data.filbleu.fr/ws-tr/gtfs-rt/opendata/vehicle-positions',
    license: 'Licence Ouverte 2.0',
    licenseUrl:
      'https://transport.data.gouv.fr/datasets/fil-bleu-syndicat-des-mobilites-gtfs-gtfs-rt',
    attribution: 'Fil Bleu – Syndicat des Mobilités de Touraine',
    terms: {
      quote: 'licence: lov2',
      note: 'Dataset record’s licence field quoted.',
    },
    defaultMode: 'bus',
  }),
  ...FRANCE_TRANSIT_FEED_ROWS.map(franceTransitFeed),
  ...[...CATALOGUE_TRANSIT_FEED_ROWS, ...JAPAN_TRANSIT_FEED_ROWS].map((row) =>
    transitFeed({ defaultMode: 'bus', ...row }),
  ),
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
 * Great-circle distance in km. Retained for compatibility with existing
 * transit consumers; new shared spatial code should use `greatCircleKm`.
 * @param {number} aLat
 * @param {number} aLon
 * @param {number} bLat
 * @param {number} bLon
 * @returns {number}
 */
export function haversineKm(aLat, aLon, bLat, bLon) {
  return greatCircleKm({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon });
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
 * The feed's own hint for a vehicle: its fleet number when the feed maps
 * those (`vehicleMode`), else its route (`routeMode`). Null when neither knows.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId
 * @param {string|null} vehicleId
 * @returns {string|null}
 */
function hintedMode(feed, routeId, vehicleId) {
  const byVehicle =
    typeof feed?.vehicleMode === 'function'
      ? feed.vehicleMode(vehicleId)
      : null;
  if (byVehicle && byVehicle !== 'unknown') return byVehicle;
  return typeof feed?.routeMode === 'function' ? feed.routeMode(routeId) : null;
}

/**
 * Mode for a vehicle: the feed's fleet or route hint when it has one, else
 * its default.
 * @param {object} feed Registry entry.
 * @param {string|null} routeId GTFS route_id from the vehicle's trip.
 * @param {string|null} [vehicleId] GTFS-RT vehicle id.
 * @returns {string} One of TRANSIT_MODES.
 */
export function transitModeFor(feed, routeId, vehicleId = null) {
  const hinted = hintedMode(feed, routeId, vehicleId);
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
 * @param {string|null} [vehicleId]
 * @returns {boolean}
 */
export function transitModeResolved(feed, routeId, vehicleId = null) {
  const hinted = hintedMode(feed, routeId, vehicleId);
  return (
    Boolean(hinted) && hinted !== 'unknown' && TRANSIT_MODES.includes(hinted)
  );
}

/**
 * The route as a rider would say it. Most feeds publish that already, so this
 * is identity for them; a feed that publishes internal keys supplies its own
 * `routeLabel`. Never invents a label: an id the feed does not know survives
 * unchanged, because a raw id a person can compare against the bus is more
 * use than a blank.
 * @param {object|null} feed Registry entry.
 * @param {string|null} routeId
 * @returns {string|null}
 */
export function transitRouteLabel(feed, routeId) {
  if (!routeId || typeof feed?.routeLabel !== 'function') return routeId;
  const named = feed.routeLabel(routeId);
  return typeof named === 'string' && named ? named : routeId;
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
