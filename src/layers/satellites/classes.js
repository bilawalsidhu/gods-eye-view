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
const DEBRIS_OBJECT_TYPES = new Set(['R/B', 'DEB']);
/**
 * SATCAT files a new launch's objects as UNK until it identifies them, so an
 * unknown object launched within this many calendar years (2: this year or
 * last) is not presumed debris. Years, not dates: the TLE designator, the
 * fallback when SATCAT has no launch date, carries only the year.
 */
export const UNIDENTIFIED_GRACE_YEARS = 2;
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
  /earth observation|earth\/space observation|earth science|meteorolog|surveillance/i;
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

/** CelesTrak groups named for an orbit, not a mission: the last resort. */
const ORBIT_GROUPS = new Set(['geo']);

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
  const launched = launchYearOf(satcat?.launchDate) ?? launchYear;
  const recent =
    Number.isFinite(launched) && nowYear - launched < UNIDENTIFIED_GRACE_YEARS;
  if (objectType && DEBRIS_OBJECT_TYPES.has(objectType)) return 'debris';
  if (objectType === 'UNK' && !recent) return 'debris';
  if (!objectType && DEBRIS_NAME.test(label)) return 'debris';
  if (status !== null && DEAD_STATUSES.has(status)) return 'debris';

  // CelesTrak's stations group also carries the CubeSats deployed from the
  // ISS (they share its 1998-067 designator): only a station or a visiting
  // craft, by name, is a station.
  if (STATION_NAME.test(label)) return 'stations';
  if (group === 'dense' || STARLINK_NAME.test(label)) return 'starlink';

  // UCS writes "Unknown" for a purpose it does not know: no evidence.
  const purpose = /^unknown$/i.test(ucs?.purpose || '')
    ? ''
    : ucs?.purpose || '';
  if (IMAGING_PURPOSE.test(purpose)) return 'imaging';
  if (TELECOM_PURPOSE.test(purpose)) return 'telecom';
  if (purpose) return 'probes';

  if (IMAGING_NAME.test(label)) return 'imaging';
  if (TELECOM_NAME.test(label)) return 'telecom';

  // UCS lists working satellites only: a payload it never knew, whose SATCAT
  // record gives no status and whose launch is decades old, is presumed
  // dead. Without a SATCAT record (its read failed or has not landed) there
  // is no evidence either way, so nothing is presumed.
  if (
    satcat &&
    UNKNOWN_STATUSES.has(status ?? '') &&
    Number.isFinite(launched) &&
    nowYear - launched >= PRESUMED_DEAD_AFTER_YEARS
  )
    return 'debris';

  // A mission group (weather, resource, science…) says more than an orbit
  // group: a weather satellite in geostationary orbit is in both.
  const memberships = groups?.length ? groups : [group];
  for (const membership of [
    ...memberships.filter((m) => !ORBIT_GROUPS.has(m)),
    ...memberships.filter((m) => ORBIT_GROUPS.has(m)),
  ])
    if (GROUP_CLASS[membership]) return GROUP_CLASS[membership];
  return 'probes';
}

/** Whether a class may be ridden in the Cockpit's orbital view. */
export function satelliteClassEnterable(satelliteClass) {
  return (
    SATELLITE_CLASS_IDS.includes(satelliteClass) && satelliteClass !== 'debris'
  );
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

// ISO 3166-1 alpha-2 code → short English name, for every owner below.
const COUNTRY_NAMES = Object.freeze({
  AE: 'United Arab Emirates',
  AM: 'Armenia',
  AO: 'Angola',
  AR: 'Argentina',
  AT: 'Austria',
  AU: 'Australia',
  AZ: 'Azerbaijan',
  BD: 'Bangladesh',
  BE: 'Belgium',
  BG: 'Bulgaria',
  BH: 'Bahrain',
  BM: 'Bermuda',
  BO: 'Bolivia',
  BR: 'Brazil',
  BT: 'Bhutan',
  BW: 'Botswana',
  BY: 'Belarus',
  CA: 'Canada',
  CH: 'Switzerland',
  CL: 'Chile',
  CN: 'China',
  CO: 'Colombia',
  CR: 'Costa Rica',
  CZ: 'Czechia',
  DE: 'Germany',
  DJ: 'Djibouti',
  DK: 'Denmark',
  DZ: 'Algeria',
  EC: 'Ecuador',
  EE: 'Estonia',
  EG: 'Egypt',
  ES: 'Spain',
  ET: 'Ethiopia',
  FI: 'Finland',
  FR: 'France',
  GB: 'United Kingdom',
  GH: 'Ghana',
  GR: 'Greece',
  GT: 'Guatemala',
  HR: 'Croatia',
  HU: 'Hungary',
  ID: 'Indonesia',
  IE: 'Ireland',
  IL: 'Israel',
  IN: 'India',
  IQ: 'Iraq',
  IR: 'Iran',
  IT: 'Italy',
  JO: 'Jordan',
  JP: 'Japan',
  KE: 'Kenya',
  KP: 'North Korea',
  KR: 'South Korea',
  KW: 'Kuwait',
  KZ: 'Kazakhstan',
  LA: 'Laos',
  LK: 'Sri Lanka',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  MA: 'Morocco',
  MC: 'Monaco',
  MD: 'Moldova',
  ME: 'Montenegro',
  MM: 'Myanmar',
  MN: 'Mongolia',
  MU: 'Mauritius',
  MX: 'Mexico',
  MY: 'Malaysia',
  NG: 'Nigeria',
  NL: 'Netherlands',
  NO: 'Norway',
  NP: 'Nepal',
  NZ: 'New Zealand',
  PE: 'Peru',
  PH: 'Philippines',
  PK: 'Pakistan',
  PL: 'Poland',
  PT: 'Portugal',
  PY: 'Paraguay',
  QA: 'Qatar',
  RO: 'Romania',
  RU: 'Russia',
  RW: 'Rwanda',
  SA: 'Saudi Arabia',
  SB: 'Solomon Islands',
  SD: 'Sudan',
  SE: 'Sweden',
  SG: 'Singapore',
  SI: 'Slovenia',
  SN: 'Senegal',
  TH: 'Thailand',
  TM: 'Turkmenistan',
  TN: 'Tunisia',
  TR: 'Türkiye',
  TW: 'Taiwan',
  UA: 'Ukraine',
  US: 'United States',
  UY: 'Uruguay',
  VA: 'Vatican City',
  VE: 'Venezuela',
  VN: 'Vietnam',
  ZA: 'South Africa',
  ZW: 'Zimbabwe',
});

/**
 * Every owner country a satellite can be marked with, sorted: the flags
 * `scripts/build-owner-flags.mjs` draws into the owner flag sheet.
 */
export const OWNER_COUNTRY_CODES = Object.freeze(
  Object.keys(COUNTRY_NAMES).sort(),
);

// UCS "Country of Operator/Owner" → ISO code. Joint owners ("USA/Japan") and
// organisations are not countries and resolve through ORGANISATIONS or as a
// joint label.
const UCS_COUNTRIES = Object.freeze({
  Algeria: 'DZ',
  Angola: 'AO',
  Argentina: 'AR',
  Australia: 'AU',
  Austria: 'AT',
  Azerbaijan: 'AZ',
  Bangladesh: 'BD',
  Belarus: 'BY',
  Belgium: 'BE',
  Bolivia: 'BO',
  Brazil: 'BR',
  Bulgaria: 'BG',
  Canada: 'CA',
  Chile: 'CL',
  China: 'CN',
  Colombia: 'CO',
  'Czech Republic': 'CZ',
  Denmark: 'DK',
  Ecuador: 'EC',
  Egypt: 'EG',
  Estonia: 'EE',
  Ethiopia: 'ET',
  Finland: 'FI',
  France: 'FR',
  Germany: 'DE',
  Greece: 'GR',
  Hungary: 'HU',
  India: 'IN',
  Indonesia: 'ID',
  Iran: 'IR',
  Iraq: 'IQ',
  Israel: 'IL',
  Italy: 'IT',
  Japan: 'JP',
  Jordan: 'JO',
  Kazakhstan: 'KZ',
  Kenya: 'KE',
  Kuwait: 'KW',
  Laos: 'LA',
  Lithuania: 'LT',
  Luxembourg: 'LU',
  Malaysia: 'MY',
  Mexico: 'MX',
  Monaco: 'MC',
  Morocco: 'MA',
  Nepal: 'NP',
  Netherlands: 'NL',
  'New Zealand': 'NZ',
  Nigeria: 'NG',
  Norway: 'NO',
  Pakistan: 'PK',
  Peru: 'PE',
  Poland: 'PL',
  Russia: 'RU',
  'Saudi Arabia': 'SA',
  Sinapore: 'SG',
  Singapore: 'SG',
  Slovenia: 'SI',
  'South Africa': 'ZA',
  'South Korea': 'KR',
  Spain: 'ES',
  Sudan: 'SD',
  Sweden: 'SE',
  Switzerland: 'CH',
  Taiwan: 'TW',
  Thailand: 'TH',
  Tunisia: 'TN',
  Turkey: 'TR',
  UK: 'GB',
  USA: 'US',
  Ukraine: 'UA',
  'United Arab Emirates': 'AE',
  'United Kingdom': 'GB',
  Venezuela: 'VE',
  Vietnam: 'VN',
});

// CelesTrak SATCAT OWNER code → ISO code (https://celestrak.org/satcat/sources.php).
// CIS (former USSR) is filed under Russia, its continuing state.
const SATCAT_COUNTRIES = Object.freeze({
  ALG: 'DZ',
  ANG: 'AO',
  ARGN: 'AR',
  ARM: 'AM',
  ASRA: 'AT',
  AUS: 'AU',
  AZER: 'AZ',
  BEL: 'BE',
  BELA: 'BY',
  BERM: 'BM',
  BGD: 'BD',
  BHR: 'BH',
  BHUT: 'BT',
  BOL: 'BO',
  BRAZ: 'BR',
  BUL: 'BG',
  BWA: 'BW',
  CA: 'CA',
  CHLE: 'CL',
  CIS: 'RU',
  COL: 'CO',
  CRI: 'CR',
  CZCH: 'CZ',
  DEN: 'DK',
  DJI: 'DJ',
  ECU: 'EC',
  EGYP: 'EG',
  EST: 'EE',
  ETH: 'ET',
  FIN: 'FI',
  FR: 'FR',
  GER: 'DE',
  GHA: 'GH',
  GREC: 'GR',
  GUAT: 'GT',
  HRV: 'HR',
  HUN: 'HU',
  IND: 'IN',
  INDO: 'ID',
  IRAN: 'IR',
  IRAQ: 'IQ',
  IRL: 'IE',
  ISRA: 'IL',
  ISRO: 'IN',
  IT: 'IT',
  JPN: 'JP',
  KAZ: 'KZ',
  KEN: 'KE',
  LAOS: 'LA',
  LKA: 'LK',
  LTU: 'LT',
  LUXE: 'LU',
  MA: 'MA',
  MALA: 'MY',
  MCO: 'MC',
  MDA: 'MD',
  MEX: 'MX',
  MMR: 'MM',
  MNE: 'ME',
  MNG: 'MN',
  MUS: 'MU',
  NETH: 'NL',
  NIG: 'NG',
  NKOR: 'KP',
  NOR: 'NO',
  NPL: 'NP',
  NZ: 'NZ',
  PAKI: 'PK',
  PERU: 'PE',
  POL: 'PL',
  POR: 'PT',
  PRC: 'CN',
  PRY: 'PY',
  QAT: 'QA',
  ROC: 'TW',
  ROM: 'RO',
  RP: 'PH',
  RWA: 'RW',
  SAFR: 'ZA',
  SAUD: 'SA',
  SDN: 'SD',
  SEN: 'SN',
  SING: 'SG',
  SKOR: 'KR',
  SLB: 'SB',
  SPN: 'ES',
  SVN: 'SI',
  SWED: 'SE',
  SWTZ: 'CH',
  THAI: 'TH',
  TUN: 'TN',
  TURK: 'TR',
  UAE: 'AE',
  UK: 'GB',
  UKR: 'UA',
  URY: 'UY',
  US: 'US',
  VAT: 'VA',
  VENZ: 'VE',
  VTNM: 'VN',
  ZWE: 'ZW',
});

// Organisations, by SATCAT code and by UCS name: no flag, a short label.
const ORGANISATIONS = Object.freeze({
  AB: 'Arabsat',
  ABS: 'ABS',
  AC: 'AsiaSat',
  ESA: 'ESA',
  ESRO: 'ESRO',
  EUME: 'EUMETSAT',
  EUTE: 'Eutelsat',
  GLOB: 'Globalstar',
  IM: 'Inmarsat',
  IRID: 'Iridium',
  ISS: 'ISS partners',
  ITSO: 'Intelsat',
  NATO: 'NATO',
  NICO: 'New ICO',
  O3B: 'O3b',
  ORB: 'ORBCOMM',
  RASC: 'RascomStar-QAF',
  SEAL: 'Sea Launch',
  SES: 'SES',
  Multinational: 'Multinational',
});

// SATCAT codes for joint ownership, as their parts.
const SATCAT_JOINT = Object.freeze({
  CHBZ: ['CN', 'BR'],
  CHTU: ['CN', 'TR'],
  FGER: ['FR', 'DE'],
  FRIT: ['FR', 'IT'],
  GRSA: ['GR', 'SA'],
  PRES: ['CN', 'ESA'],
  SGJP: ['SG', 'JP'],
  STCT: ['SG', 'TW'],
  TMMC: ['TM', 'MC'],
  USBZ: ['US', 'BR'],
});

function country(code) {
  return COUNTRY_NAMES[code]
    ? { countryCode: code, label: COUNTRY_NAMES[code] }
    : null;
}

function joint(parts) {
  const labels = parts.map(
    (part) => COUNTRY_NAMES[part] || ORGANISATIONS[part] || part,
  );
  return { countryCode: null, label: labels.join(' / ') };
}

/**
 * Normalise a UCS owner country ("USA", "China/France", "ESA",
 * "Multinational") to `{ countryCode, label }`.
 * @param {string|null|undefined} text
 * @returns {{countryCode: string|null, label: string}|null}
 */
export function ownerFromUcs(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (UCS_COUNTRIES[value]) return country(UCS_COUNTRIES[value]);
  if (ORGANISATIONS[value])
    return { countryCode: null, label: ORGANISATIONS[value] };
  if (value.includes('/'))
    return joint(
      value
        .split('/')
        .map((part) => part.trim())
        .map((part) => UCS_COUNTRIES[part] || part),
    );
  return { countryCode: null, label: value };
}

/**
 * Normalise a CelesTrak SATCAT OWNER code ("US", "PRC", "CIS", "ITSO") to
 * `{ countryCode, label }`; null for TBD, UNK and blanks.
 * @param {string|null|undefined} code
 * @returns {{countryCode: string|null, label: string}|null}
 */
export function ownerFromSatcat(code) {
  const value = String(code || '')
    .trim()
    .toUpperCase();
  if (!value || value === 'TBD' || value === 'UNK') return null;
  if (SATCAT_COUNTRIES[value]) return country(SATCAT_COUNTRIES[value]);
  if (ORGANISATIONS[value])
    return { countryCode: null, label: ORGANISATIONS[value] };
  if (SATCAT_JOINT[value]) return joint(SATCAT_JOINT[value]);
  return null;
}

/**
 * Who owns a satellite: UCS names the operator's country, SATCAT the
 * registering owner; UCS wins where both exist. Starlink without either is
 * SpaceX's, so United States.
 * @returns {{countryCode: string|null, label: string}|null}
 */
export function satelliteOwner({
  ucs = null,
  satcat = null,
  satelliteClass,
} = {}) {
  return (
    ownerFromUcs(ucs?.operatorCountry) ||
    ownerFromSatcat(satcat?.owner) ||
    (satelliteClass === 'starlink' ? country('US') : null)
  );
}

/** Who operates a satellite: UCS's operator, or SpaceX for Starlink. */
export function satelliteOperator({ ucs = null, satelliteClass } = {}) {
  if (ucs?.operator) return ucs.operator;
  return satelliteClass === 'starlink' ? 'SpaceX' : null;
}

/**
 * The international designator (COSPAR id) from TLE line 1, columns 10–17:
 * `98067A` → `1998-067A`. Two-digit years below 57 are 20xx.
 * @param {string|null|undefined} line1
 * @returns {string|null}
 */
export function cosparIdFromTleLine1(line1) {
  const field = String(line1 || '')
    .slice(9, 17)
    .trim();
  const match = /^(\d{2})(\d{3})([A-Z]{1,3})$/.exec(field);
  if (!match) return null;
  const yy = Number(match[1]);
  return `${yy < 57 ? 2000 + yy : 1900 + yy}-${match[2]}${match[3]}`;
}

/**
 * The TLE's epoch as epoch milliseconds, from satellite.js's Julian date.
 * @param {{jdsatepoch?: number, jdsatepochF?: number}|null|undefined} satrec
 * @returns {number|null}
 */
export function tleEpochMs(satrec) {
  const jd = Number(satrec?.jdsatepoch) + (Number(satrec?.jdsatepochF) || 0);
  return Number.isFinite(jd) && jd > 0
    ? Math.round((jd - 2440587.5) * 86_400_000)
    : null;
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
 *   owner: string, cosparId: string|null, launchDate: string|null}>}
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
    owner: at('OWNER'),
    id: at('OBJECT_ID'),
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
      owner: text(col.owner),
      cosparId: text(col.id) || null,
      launchDate: text(col.launch) || null,
    });
  }
  return records;
}
