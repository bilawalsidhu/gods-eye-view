/**
 * @file Satellite classes: which of six KSP-style classes an object in orbit
 * belongs to, who owns it and who operates it.
 *
 * Classes, in legend order:
 * - stations: crewed stations and the craft that visit them (ISS, Tiangong,
 *   Soyuz, Shenzhou, Dragon, Progress, Cygnus…), by name. The CubeSats
 *   CelesTrak's stations group also carries after their deployment from the
 *   ISS are classed like any other satellite. Retired stations and the
 *   shuttles have re-entered, so they have no orbit to show.
 * - imaging: Earth observation of every kind (optical, radar, multispectral,
 *   hyperspectral, weather, Earth science, surveillance).
 * - telecom: communications and navigation (GEO comsats, Iridium, OneWeb,
 *   GPS, GLONASS, Galileo, BeiDou…), Starlink excepted.
 * - starlink: the Starlink constellation.
 * - probes: other working payloads (space science, technology development and
 *   demonstration, education, unknown purpose).
 * - debris: rocket bodies, fragments, unknown objects and payloads that no
 *   longer work. Shown and tracked on request, never ridden in the Cockpit.
 *
 * The evidence, strongest first: CelesTrak SATCAT's object type and
 * operational status (current, so it overrules UCS on a satellite that has
 * died since), the UCS Satellite Database's purpose (May 2023), name patterns
 * for satellites launched after it, and the CelesTrak group the TLE came in.
 * Pure: no Cesium, no fetches, so the tables are unit-tested directly.
 *
 * @module satelliteClasses
 */

import { msg } from '../../i18n/index.js';

/** Class ids in legend order. */
export const SATELLITE_CLASS_IDS = Object.freeze([
  'stations',
  'imaging',
  'telecom',
  'starlink',
  'probes',
  'debris',
]);

/**
 * Which classes show when nobody has chosen: everything the layer showed
 * before classes existed. Starlink stays off, as the DENSE switch was.
 */
export const DEFAULT_SATELLITE_CLASSES = Object.freeze({
  stations: true,
  imaging: true,
  telecom: true,
  starlink: false,
  probes: true,
  debris: true,
});

/**
 * Point colour and the legend and chip text for each class. Colours reuse the
 * layer's established palette (src/data/satelliteClass.js); debris recedes.
 */
export const SATELLITE_CLASS_DISPLAY = Object.freeze({
  stations: Object.freeze({
    color: '#fff6e5',
    label: msg('STATIONS'),
    blurb: msg('Crewed stations and the craft that visit them'),
  }),
  imaging: Object.freeze({
    color: '#4fd8ff',
    label: msg('IMAGING'),
    blurb: msg('Earth observation: optical, radar, weather and science'),
  }),
  telecom: Object.freeze({
    color: '#c89bff',
    label: msg('TELECOM'),
    blurb: msg('Communications and navigation satellites, Starlink excepted'),
  }),
  starlink: Object.freeze({
    color: '#54697f',
    label: msg('STARLINK'),
    blurb: msg('The Starlink constellation (thousands of extra points)'),
  }),
  probes: Object.freeze({
    color: '#9fb3c4',
    label: msg('PROBES'),
    blurb: msg('Space science, technology demonstration and other payloads'),
  }),
  debris: Object.freeze({
    color: '#7d7468',
    label: msg('DEBRIS'),
    blurb: msg('Rocket bodies, fragments and dead satellites'),
  }),
});

/** The ISS, a station whatever else says. */
const ISS_NORAD = 25544;

/** SATCAT object types that are never a working payload. */
const DEBRIS_OBJECT_TYPES = new Set(['R/B', 'DEB', 'UNK']);
/** SATCAT operational status: nonoperational, decayed. */
const DEAD_STATUSES = new Set(['-', 'D']);
/** SATCAT operational status left blank or unknown. */
const UNKNOWN_STATUSES = new Set(['', '?']);
/**
 * A payload whose SATCAT record gives no status, with no UCS record and no
 * recognisable name, that launched this many years ago is presumed dead (old
 * weather and science satellites the "visual" group keeps for their
 * brightness). Without a SATCAT record (a failed read) nothing is presumed.
 */
export const PRESUMED_DEAD_AFTER_YEARS = 20;

const DEBRIS_NAME = /\bR\/B\b|\bDEB\b|\bAKM\b|ROCKET BODY/i;
const STATION_NAME =
  /^(ISS\b|TIANGONG|TIANHE|WENTIAN|MENGTIAN|CSS\b|SHENZHOU|TIANZHOU|SOYUZ|PROGRESS|CREW DRAGON|DRAGON|CYGNUS|STARLINER|HTV\b|AXIOM)/i;
const STARLINK_NAME = /^STARLINK/i;
const IMAGING_NAME =
  /^(SENTINEL|LANDSAT|WORLDVIEW|GEOEYE|PLEIADES|SPOT[ -]\d|ICEYE|CAPELLA|UMBRA|FLOCK|SKYSAT|PELICAN|SUPERDOVE|DOVE\b|NOAA[ -]?\d|GOES|METEOSAT|METOP|HIMAWARI|FENGYUN|FY-?\d|GAOFEN|JILIN|SUPERVIEW|KOMPSAT|RADARSAT|RCM-|TERRA\b|AQUA\b|SUOMI NPP|JPSS|CARTOSAT|RESOURCESAT|RISAT|EOS-\d|ALOS|COSMO-SKYMED|CSG-|TERRASAR|TANDEM-X|PAZ\b|SAOCOM|KANOPUS|RESURS|METEOR-M|ELEKTRO-L|ARKTIKA-M|YAOGAN|NUSAT|NEWSAT|BLACKSKY|GLOBAL-\d|GHGSAT|LEMUR|HAIYANG|HY-\d|ZIYUAN|ZY-\d|TIANHUI|SWOT|ICESAT|GRACE|CRYOSAT|SMAP|SMOS|PROBA-V|DEIMOS|THEOS|GOKTURK|EROS|OFEQ|OPTSAT|PRISMA|ENMAP|NISAR|BIOMASS|EARTHCARE|FORMOSAT|CBERS|AMAZONIA|SICH|DMSP|ELECTRO)/i;
const TELECOM_NAME =
  /^(ONEWEB|IRIDIUM|GLOBALSTAR|ORBCOMM|INTELSAT|IS-\d|SES[ -]?\d|ASTRA|EUTELSAT|INMARSAT|VIASAT|ECHOSTAR|DIRECTV|SIRIUS|XM-|TDRS|NAVSTAR|GPS\b|GLONASS|GSAT0|GALILEO|BEIDOU|QZS|IRNSS|NVS-|KUIPER|LYNK|BLUEBIRD|O3B|TELESAT|ANIK|NIMIQ|AMAZONAS|HISPASAT|ARABSAT|NILESAT|TURKSAT|YAMAL|EXPRESS-|CHINASAT|ZHONGXING|APSTAR|ASIASAT|THAICOM|MEASAT|JCSAT|SUPERBIRD|OPTUS|SKYNET|WGS|MUOS|AEHF|MILSTAR|QIANFAN|GUOWANG|SPACEMOBILE|GONETS|MERIDIAN|LUCH|RADUGA|SKYTERRA|TERRESTAR|SPACEWAY|HYLAS|ARSAT|AMOS|BADR|KA-SAT|YAHSAT|THURAYA)/i;

const IMAGING_PURPOSE =
  /earth observation|earth science|meteorolog|surveillance/i;
const TELECOM_PURPOSE = /communications|navigation|positioning/i;

/**
 * CelesTrak groups whose members are, by default, of one class. Not
 * stations: it also carries CubeSats deployed from the ISS.
 */
const GROUP_CLASS = Object.freeze({
  dense: 'starlink',
  starlink: 'starlink',
  resource: 'imaging',
  weather: 'imaging',
  planet: 'imaging',
  sar: 'imaging',
  'gps-ops': 'telecom',
  glonass: 'telecom',
  'glo-ops': 'telecom',
  galileo: 'telecom',
  geo: 'telecom',
  science: 'probes',
});

/** The year of a SATCAT launch date (`2024-03-15`), or null. */
function launchYearOf(launchDate) {
  const match = /^(\d{4})-/.exec(String(launchDate || ''));
  return match ? Number(match[1]) : null;
}

/**
 * The class a satellite belongs to.
 * @param {{noradId?: number, name?: string, group?: string|null,
 *   groups?: string[]|null,
 *   ucs?: {purpose?: string|null}|null,
 *   satcat?: {objectType?: string, opsStatus?: string,
 *     launchDate?: string|null}|null,
 *   launchYear?: number|null, nowYear?: number}} subject `groups` is every
 *   CelesTrak group the TLE came in (`group` is the one it is shown under):
 *   the first of them that names a class gives the last-resort class, so a
 *   satellite in both `visual` and `resource` is still imaging. `launchYear` is
 *   the TLE designator's; SATCAT's launch date wins where it has one (an
 *   object deployed from the ISS carries the station's 1998 designator).
 * @returns {'stations'|'imaging'|'telecom'|'starlink'|'probes'|'debris'}
 */
export function classifySatellite({
  noradId,
  name = '',
  group = null,
  ucs = null,
  satcat = null,
  groups = null,
  launchYear = null,
  nowYear = new Date().getUTCFullYear(),
} = {}) {
  if (noradId === ISS_NORAD) return 'stations';
  const label = String(name || '').trim();
  const objectType = satcat?.objectType || null;
  const status = satcat?.opsStatus ?? null;
  if (objectType && DEBRIS_OBJECT_TYPES.has(objectType)) return 'debris';
  if (!objectType && DEBRIS_NAME.test(label)) return 'debris';
  if (status !== null && DEAD_STATUSES.has(status)) return 'debris';

  // CelesTrak's stations group also carries the CubeSats deployed from the
  // ISS (they share its 1998-067 designator): only a station or a visiting
  // craft, by name, is a station.
  if (STATION_NAME.test(label)) return 'stations';
  if (group === 'dense' || STARLINK_NAME.test(label)) return 'starlink';

  const purpose = ucs?.purpose || '';
  if (IMAGING_PURPOSE.test(purpose)) return 'imaging';
  if (TELECOM_PURPOSE.test(purpose)) return 'telecom';
  if (purpose) return 'probes';

  if (IMAGING_NAME.test(label)) return 'imaging';
  if (TELECOM_NAME.test(label)) return 'telecom';

  // UCS lists working satellites only: a payload it never knew, whose SATCAT
  // record gives no status and whose launch is decades old, is presumed
  // dead. Without a SATCAT record (its read failed or has not landed) there
  // is no evidence either way, so nothing is presumed.
  const launched = launchYearOf(satcat?.launchDate) ?? launchYear;
  if (
    satcat &&
    UNKNOWN_STATUSES.has(status ?? '') &&
    Number.isFinite(launched) &&
    nowYear - launched >= PRESUMED_DEAD_AFTER_YEARS
  )
    return 'debris';

  const memberships = groups?.length ? groups : [group];
  for (const membership of memberships)
    if (GROUP_CLASS[membership]) return GROUP_CLASS[membership];
  return 'probes';
}

/**
 * Merge a partial class-visibility request into the current choice.
 * Unknown keys and non-boolean values are ignored.
 * @param {Record<string, unknown>|null|undefined} request
 * @param {Record<string, boolean>} [current]
 * @returns {Record<string, boolean>}
 */
export function mergeClassVisibility(
  request,
  current = DEFAULT_SATELLITE_CLASSES,
) {
  const next = {};
  for (const id of SATELLITE_CLASS_IDS) {
    const value = request?.[id];
    next[id] = typeof value === 'boolean' ? value : current[id] === true;
  }
  return next;
}

/** Split one RFC 4180 CSV line (quoted fields may hold commas). */
function csvFields(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * Parse CelesTrak SATCAT CSV into records keyed by NORAD number.
 * @param {string} text `records.php?…&FORMAT=CSV` body.
 * @returns {Map<number, {objectType: string, opsStatus: string,
 *   launchDate: string|null}>}
 */
export function parseSatcatCsv(text) {
  const records = new Map();
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!lines.length) return records;
  const header = csvFields(lines[0]).map((name) => name.trim());
  const at = (name) => header.indexOf(name);
  const col = {
    norad: at('NORAD_CAT_ID'),
    type: at('OBJECT_TYPE'),
    status: at('OPS_STATUS_CODE'),
    launch: at('LAUNCH_DATE'),
  };
  if (col.norad < 0 || col.type < 0) return records;
  for (const line of lines.slice(1)) {
    const fields = csvFields(line);
    const noradId = Number(fields[col.norad]);
    if (!Number.isInteger(noradId) || noradId <= 0) continue;
    const text = (index) => (index < 0 ? '' : (fields[index] ?? '').trim());
    records.set(noradId, {
      objectType: text(col.type).toUpperCase(),
      opsStatus: text(col.status),
      launchDate: text(col.launch) || null,
    });
  }
  return records;
}
