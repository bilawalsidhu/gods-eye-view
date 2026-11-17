import { getContextStore } from './contextStore.js';
import { msg } from '../i18n/marker.js';
import { AIRCRAFT_CLASS_LABELS } from './aircraftClass.js';
import { aircraftEmergency } from './aircraftEmergency.js';

/**
 * One way to read any thing on the map, whichever layer holds it.
 *
 * Layers already list their loaded items through `getAnalystRecords()` (the
 * records voice and the analyst answer from) and identify a clicked item
 * through `resolvePickedContext()`. This module joins the two: it finds the
 * record behind an identity, turns it into a card (title, kind, facts), lists
 * the nearest items of the same kind and of other layers, and searches every
 * enabled layer by name for the omnibar.
 *
 * It reads only; nothing here moves the camera or changes a layer.
 */

/**
 * How a layer's items are named and drawn, by layer id. `headline` names the
 * fields that lead a card as its big figures, in order; `name` is what an
 * item without a name of its own goes by. `kind` is also the English the card
 * shows, through t(), for what the item is.
 */
const AIRCRAFT = {
  kind: msg('aircraft'),
  icon: 'flight',
  moving: true,
  headline: ['altitudeM', 'speedMps', 'heading'],
};
const KINDS = Object.freeze({
  flights: AIRCRAFT,
  military: AIRCRAFT,
  'local-adsb': AIRCRAFT,
  'ais-live-vessels': {
    kind: msg('vessel'),
    icon: 'directions_boat',
    moving: true,
    headline: ['speedKts', 'courseDeg', 'navStatus'],
  },
  satellites: {
    kind: msg('satellite'),
    icon: 'satellite_alt',
    moving: true,
    headline: ['altitudeM', 'speedMps'],
  },
  'rocket-launches': { kind: msg('launch'), icon: 'rocket_launch' },
  'local-firms': {
    kind: msg('fire'),
    icon: 'local_fire_department',
    headline: ['frp', 'confidence'],
    name: msg('Fire detection'),
  },
  'fire-perimeters': {
    kind: msg('fire perimeter'),
    icon: 'local_fire_department',
    headline: ['acres', 'containedPct'],
  },
  earthquakes: {
    kind: msg('earthquake'),
    icon: 'earthquake',
    headline: ['magnitude', 'depthKm'],
  },
  'weather-cyclones': {
    kind: msg('storm'),
    icon: 'cyclone',
    headline: ['windKt', 'pressureHpa'],
  },
  'air-quality': {
    kind: msg('air quality station'),
    icon: 'air',
    headline: ['value', 'band'],
  },
  'military-installations': { kind: msg('installation'), icon: 'factory' },
  'local-dams': { kind: msg('dam'), icon: 'factory', headline: ['capacity'] },
  'local-datacenters': {
    kind: msg('data centre'),
    icon: 'factory',
    headline: ['capacity'],
  },
  'osm-places': { kind: msg('place'), icon: 'location_on' },
  transit: {
    kind: msg('vehicle'),
    icon: 'train',
    moving: true,
    headline: ['speedMps', 'courseDeg'],
  },
  bikeshare: {
    kind: msg('bike station'),
    icon: 'pedal_bike',
    headline: ['bikesAvailable', 'docksAvailable'],
  },
  'alpr-cameras': { kind: msg('plate reader'), icon: 'videocam' },
  cctv: { kind: msg('camera'), icon: 'videocam' },
  'drone-airspace': {
    kind: msg('airspace'),
    icon: 'pentagon',
    headline: ['lowerAltitude', 'upperAltitude'],
  },
  'wildlife-sightings': { kind: msg('sighting'), icon: 'pets' },
});

/** Fields a record may name itself by, best first. */
const TITLE_FIELDS = [
  'callsign',
  'name',
  'title',
  'label',
  'place',
  'registration',
];
/** Fields that identify an item, for matching a click or a search. */
// `key` is a layer's own key where it differs from the record's id (a
// transit vehicle is keyed by feed and vehicle, and named by its fleet number).
const KEY_FIELDS = ['icao24', 'mmsi', 'noradId', 'usgsId', 'id', 'key'];
/**
 * How many records to ask a layer for when all are wanted. Layers read a
 * missing or unbounded count as their own small default, so this is a number
 * above any layer's size.
 */
const ALL_RECORDS = 100_000;
/** Fields searched by the omnibar, besides the key fields. */
const SEARCH_FIELDS = [
  'callsign',
  'name',
  'registration',
  'place',
  'operator',
  'icao24',
  'mmsi',
];

/** Never shown as facts: positions and identities already on the card. */
const HIDDEN_FACTS = new Set([
  // Shown as the card's route line instead.
  'routeOrigin',
  'routeDestination',
  'routeFrom',
  'routeTo',
  'routeScheduled',
  // Shown as the card's warning instead.
  'emergency',
  'emergencyKind',
  'emergencySource',
  'emergencyBroadcast',
  'tsunami',
  'warning',
  'alert',
  'advisory',
  'id',
  'lat',
  'lon',
  'latitude',
  'longitude',
  'name',
  'title',
  'label',
  'properties',
  'tags',
  'emergency',
  'emergencySource',
  'emergencyKind',
  'military',
  // Repeats of what another fact already says, and feed bookkeeping.
  'vesselId',
  'typeCode',
  'group',
  'provider',
  'zone',
  'scale',
  'routeId',
  'building',
  'key',
]);

/** Facts that lead the list when a record has them, in this order. */
const FACT_ORDER = [
  'callsign',
  'registration',
  'operator',
  'aircraftClass',
  'routeOrigin',
  'routeDestination',
  'altitudeM',
  'speedMps',
  'speedKts',
  'heading',
  'courseDeg',
  'squawk',
  'emergencyBroadcast',
  'shipType',
  'destination',
  'magnitude',
  'depthKm',
  'place',
  'frp',
  'confidence',
  'acres',
  'containedPct',
  'windKt',
  'pressureHpa',
  'classification',
  'value',
  'band',
  'risk',
  'bikesAvailable',
  'docksAvailable',
  'lowerAltitude',
  'upperAltitude',
  'satellite',
  'sensor',
  'noradId',
  'satelliteClass',
  'mmsi',
  'icao24',
  'capacity',
  'output',
  'river',
  'class',
  'kind',
  'originCountry',
];

/** Plain labels for record fields. Unlisted fields are spelled out. */
const FACT_LABELS = Object.freeze({
  callsign: msg('Callsign'),
  registration: msg('Registration'),
  operator: msg('Operator'),
  aircraftClass: msg('Aircraft class'),
  routeOrigin: msg('From'),
  routeDestination: msg('To'),
  altitudeM: msg('Altitude'),
  speedMps: msg('Speed'),
  speedKts: msg('Speed'),
  heading: msg('Heading'),
  courseDeg: msg('Course'),
  verticalRateMps: msg('Vertical rate'),
  squawk: msg('Squawk'),
  emergencyBroadcast: msg('Emergency'),
  onGround: msg('On the ground'),
  originCountry: msg('Country'),
  lastContactAtMs: msg('Last contact'),
  shipType: msg('Ship type'),
  destination: msg('Destination'),
  navStatus: msg('Status'),
  magnitude: msg('Magnitude'),
  depthKm: msg('Depth'),
  timeMs: msg('Time'),
  place: msg('Place'),
  frp: msg('Fire power'),
  confidence: msg('Confidence'),
  satellite: msg('Satellite'),
  sensor: msg('Sensor'),
  acqTime: msg('Detected'),
  acres: msg('Area'),
  containedPct: msg('Contained'),
  discoveredTime: msg('Discovered'),
  category: msg('Type'),
  windKt: msg('Wind'),
  pressureHpa: msg('Pressure'),
  classification: msg('Class'),
  basin: msg('Basin'),
  value: msg('Index'),
  band: msg('Level'),
  risk: msg('Health risk'),
  bikesAvailable: msg('Bikes'),
  docksAvailable: msg('Docks'),
  lowerAltitude: msg('Floor'),
  upperAltitude: msg('Ceiling'),
  timesOfUse: msg('Active'),
  mode: msg('Mode'),
  noradId: msg('NORAD ID'),
  satelliteClass: msg('Class'),
  mmsi: msg('MMSI'),
  icao24: msg('ICAO24'),
  capacity: msg('Capacity'),
  output: msg('Output'),
  river: msg('River'),
  class: msg('Class'),
  kind: msg('Type'),
  'addr:city': msg('City'),
  'addr:state': msg('State'),
  'addr:country': msg('Country'),
  'addr:street': msg('Street'),
  start_date: msg('Opened'),
  height: msg('Height'),
  'plant:source': msg('Source'),
  'plant:output:electricity': msg('Output'),
  'generator:source': msg('Source'),
  'capacity:it_load': msg('IT load'),
  waterway: msg('Waterway'),
  military: msg('Military'),
  landuse: msg('Land use'),
  power: msg('Power'),
  telecom: msg('Telecom'),
});

/** OSM bookkeeping tags that say nothing about the place itself. */
const NOISE_TAG =
  /^(name:|alt_name|old_name|official_name|short_name|osm_|source|note|fixme|check_date|ref:|wikimedia|wikipedia|wikidata|website|url|image|layer$|area$|type$|id$|@)|:wikidata$|:wikipedia$/;

const MAX_FACTS = 8;
const EARTH_RADIUS_KM = 6371;

const text = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  const shown = String(value).trim();
  return shown === 'undefined' || shown === 'null' ? '' : shown;
};

const finite = (value) =>
  value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value))
      ? Number(value)
      : null;

/** What a layer's items are, and the glyph that stands for them. */
export function entityKind(layerId) {
  return KINDS[layerId] || { kind: msg('feature'), icon: 'location_on' };
}

/** Latitude and longitude of a record, whichever names it uses. */
export function recordPosition(record) {
  const lat = finite(record?.lat ?? record?.latitude);
  const lon = finite(record?.lon ?? record?.longitude);
  return lat === null || lon === null ? null : { lat, lon };
}

/** The name a person would use for a record. */
export function recordTitle(record) {
  for (const field of TITLE_FIELDS) {
    const value = text(record?.[field]);
    if (value) return value;
  }
  // An unnamed site goes by its operator before a bare database number.
  const id = text(record?.id);
  const operator = text(record?.operator);
  if (operator && (!id || /^\d+$/.test(id))) return operator;
  return id;
}

/** A key that stays the same for one item across feed refreshes. */
export function recordKey(layerId, record) {
  for (const field of KEY_FIELDS) {
    const value = text(record?.[field]);
    if (value) return `${layerId}:${value}`;
  }
  const at = recordPosition(record);
  return at ? `${layerId}:${at.lat.toFixed(4)},${at.lon.toFixed(4)}` : '';
}

/** Great-circle distance in kilometres. */
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Spell out a field name: `originCountry` → `Origin country`. */
function spellOut(field) {
  const words = String(field)
    .replace(/[_:]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

const isEpochMs = (value) =>
  Number.isFinite(value) && value > 1e11 && value < 1e13;

/**
 * A fact's value as shown, or '' to leave it out. Units follow the field
 * name's suffix, the convention the layers' records already use.
 * @param {string} field
 * @param {*} value
 * @param {object} [options]
 * @param {number} [options.nowMs]
 * @returns {{value: string, words?: object, age?: number}|null} `value` is
 *   the English; `words` (see words()) is what the UI shows through t().
 */
/** Codes the feeds use, in words. */
const CODE_WORDS = Object.freeze({
  motion: {
    moving: msg('Moving'),
    stopped: msg('Stopped'),
    waiting: msg('Waiting for update'),
    'no-fix': msg('No recent fix'),
  },
  // GTFS-RT vehicle states, as the operator last reported them.
  status: {
    IN_TRANSIT_TO: msg('Heading to next stop'),
    INCOMING_AT: msg('Arriving at a stop'),
    STOPPED_AT: msg('Stopped at a stop'),
  },
  occupancy: {
    EMPTY: msg('Empty'),
    MANY_SEATS_AVAILABLE: msg('Many seats free'),
    FEW_SEATS_AVAILABLE: msg('Few seats free'),
    STANDING_ROOM_ONLY: msg('Standing room only'),
    CRUSHED_STANDING_ROOM_ONLY: msg('Crowded'),
    FULL: msg('Full'),
    NOT_ACCEPTING_PASSENGERS: msg('Not taking passengers'),
  },
  classification: {
    TD: msg('Tropical depression'),
    TS: msg('Tropical storm'),
    HU: msg('Hurricane'),
    MH: msg('Major hurricane'),
    TY: msg('Typhoon'),
    STY: msg('Super typhoon'),
    TC: msg('Tropical cyclone'),
    SD: msg('Subtropical depression'),
    SS: msg('Subtropical storm'),
    PTC: msg('Post-tropical cyclone'),
  },
  category: { WF: msg('Wildfire'), RX: msg('Prescribed burn') },
  basin: {
    AL: msg('Atlantic'),
    EP: msg('Eastern Pacific'),
    CP: msg('Central Pacific'),
    WP: msg('Western Pacific'),
    IO: msg('Indian Ocean'),
    SH: msg('Southern Hemisphere'),
  },
  // Transit modes, as plainWord would spell the feed's codes.
  mode: {
    bus: msg('Bus'),
    trolleybus: msg('Trolleybus'),
    tram: msg('Tram'),
    cable_tram: msg('Cable tram'),
    subway: msg('Subway'),
    monorail: msg('Monorail'),
    rail: msg('Rail'),
    funicular: msg('Funicular'),
    aerial_lift: msg('Aerial lift'),
    ferry: msg('Ferry'),
    unknown: msg('Unknown'),
  },
  aircraftClass: AIRCRAFT_CLASS_LABELS,
});
/**
 * A feed code in English words (`classification` `HU` → `Hurricane`), for the
 * UI to show through t(); '' when the code has none.
 */
export function codeWord(field, code) {
  return CODE_WORDS[field]?.[text(code)] || '';
}
/** Code words whose English means something else elsewhere in the catalog. */
const CODE_CONTEXTS = Object.freeze({ 'motion:stopped': 'vehicle motion' });

/**
 * Words for the UI to show through t(): `{text, values?, context?, fixed?}`
 * is English with `{placeholders}` (numbers in `values` are formatted for the
 * language, with `fixed` decimals when given); `{date}` is a moment shown as
 * a date. Each fact, insight and warning that has them keeps its English in
 * `value` too, for search, matching and tests.
 */
function words(text, values, { context, fixed } = {}) {
  const out = { text };
  if (values) out.values = values;
  if (context) out.context = context;
  if (fixed !== undefined) out.fixed = fixed;
  return out;
}
const said = (value, text, values, options) => ({
  value,
  words: words(text, values, options),
});
/** A number rounded to at most `digits` decimals, as `round` shows it. */
const roundTo = (n, digits = 0) => Number(n.toFixed(digits));

/** A feed's bare lowercase word as people write it: `data_center` → `Data center`. */
function plainWord(shown) {
  if (!/^[a-z][a-z_]*$/.test(shown)) return shown;
  const words = shown.replace(/_/g, ' ');
  return words[0].toUpperCase() + words.slice(1);
}

/** An AIS ship type number as the kind of vessel it stands for. */
function shipTypeName(code) {
  const n = Number(code);
  if (!Number.isInteger(n) || n < 1 || n > 99) return '';
  if (n === 30) return msg('Fishing');
  if (n === 31 || n === 32 || n === 52) return msg('Tug');
  if (n === 35) return msg('Military');
  if (n === 36) return msg('Sailing');
  if (n === 37) return msg('Pleasure craft');
  if (n === 50) return msg('Pilot vessel');
  if (n === 51) return msg('Search and rescue');
  if (n === 55) return msg('Law enforcement');
  if (n >= 40 && n <= 49) return msg('High-speed craft');
  if (n >= 60 && n <= 69) return msg('Passenger');
  if (n >= 70 && n <= 79) return msg('Cargo');
  if (n >= 80 && n <= 89) return msg('Tanker');
  return msg('Other');
}

export function formatFact(
  field,
  value,
  { nowMs = Date.now(), kind = '' } = {},
) {
  if (field === 'shipType' && shipTypeName(value)) {
    const name = shipTypeName(value);
    return said(name, name);
  }
  if (value === true) return said('Yes', msg('Yes'));
  if (value === false || value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : null;
  if (number !== null && !Number.isFinite(number)) return null;
  const round = (n, digits = 0) =>
    n.toLocaleString('en-US', { maximumFractionDigits: digits });
  // A figure with its unit: English for the value, words for the UI.
  const figure = (n, digits, text, english) =>
    said(english.replace('{n}', round(n, digits)), text, {
      n: roundTo(n, digits),
    });
  if (number !== null) {
    if (
      /AtMs$|^timeMs$|^acqTime$|^observedMs$|^updatedTime$/.test(field) &&
      isEpochMs(number)
    )
      return { value: '', age: Math.max(0, nowMs - number) };
    // Any other moment reads as a date.
    if (/(Time|Ms|At)$/.test(field) && isEpochMs(number))
      return {
        value: new Date(number).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        }),
        words: { date: number },
      };
    // Aviation altitudes read in feet; orbits in kilometres.
    if (field === 'altitudeM')
      return number >= 100_000
        ? figure(number / 1000, 0, msg('{n} km'), '{n} km')
        : figure(number * 3.28084, 0, msg('{n} ft'), '{n} ft');
    // Orbital speeds read in km/s, road and rail in km/h, the rest in knots.
    if (field === 'speedMps' && number >= 2000)
      return figure(number / 1000, 2, msg('{n} km/s'), '{n} km/s');
    if (field === 'speedMps' && kind === 'vehicle')
      return figure(number * 3.6, 0, msg('{n} km/h'), '{n} km/h');
    if (field === 'speedMps')
      return figure(number * 1.94384, 0, msg('{n} kt'), '{n} kt');
    if (field === 'speedKts') return figure(number, 1, msg('{n} kt'), '{n} kt');
    if (field === 'verticalRateMps')
      return figure(number * 196.85, 0, msg('{n} ft/min'), '{n} ft/min');
    if (/^(heading|courseDeg)$/.test(field))
      return figure(number, 0, msg('{n}°'), '{n}°');
    if (field === 'depthKm') return figure(number, 1, msg('{n} km'), '{n} km');
    if (field === 'magnitude') return figure(number, 1, msg('M {n}'), 'M {n}');
    if (field === 'frp') return figure(number, 1, msg('{n} MW'), '{n} MW');
    if (field === 'confidence' && number <= 1)
      return figure(number * 100, 0, msg('{n}%'), '{n}%');
    if (/Pct$/.test(field)) return figure(number, 0, msg('{n}%'), '{n}%');
    if (/Kt$/.test(field)) return figure(number, 0, msg('{n} kt'), '{n} kt');
    if (/Hpa$/.test(field)) return figure(number, 0, msg('{n} hPa'), '{n} hPa');
    if (field === 'acres')
      return figure(number, 0, msg('{n} acres'), '{n} acres');
    if (/Km$/.test(field)) return figure(number, 1, msg('{n} km'), '{n} km');
    if (/M$/.test(field)) return figure(number, 0, msg('{n} m'), '{n} m');
    // A bare number: only its digits follow the language.
    return figure(number, 2, '{n}', '{n}');
  }
  const raw = text(value);
  if (!raw) return null;
  const coded = CODE_WORDS[field]?.[raw];
  if (coded)
    return said(coded, coded, null, {
      context: CODE_CONTEXTS[`${field}:${raw}`],
    });
  // Identifiers and names stay exactly as the feed gives them.
  const verbatim = KEY_FIELDS.includes(field) || TITLE_FIELDS.includes(field);
  const shown = verbatim ? raw : plainWord(raw);
  return { value: shown.length > 80 ? `${shown.slice(0, 77)}…` : shown };
}

/**
 * The facts a card lists for a record: known fields first, in a fixed order,
 * then whatever else the record carries, up to a handful.
 */
export function recordFacts(
  record,
  { nowMs = Date.now(), skip = [], kind = '' } = {},
) {
  const facts = [];
  let observedAgeMs = null;
  const seen = new Set(skip);
  const fields = [
    ...FACT_ORDER.filter((field) => field in (record || {})),
    ...Object.keys(record || {}).filter((field) => !FACT_ORDER.includes(field)),
  ];
  for (const field of fields) {
    if (HIDDEN_FACTS.has(field) || seen.has(field)) continue;
    seen.add(field);
    const formatted = formatFact(field, record[field], { nowMs, kind });
    if (!formatted) continue;
    if (formatted.age !== undefined) {
      observedAgeMs ??= formatted.age;
      continue;
    }
    if (facts.length < MAX_FACTS)
      facts.push({
        field,
        // An index goes by the scale it is on (AQHI, AQI).
        label:
          (field === 'value' && text(record.scale)) ||
          FACT_LABELS[field] ||
          spellOut(field),
        value: formatted.value,
        ...(formatted.words ? { words: formatted.words } : {}),
      });
  }
  return { facts, observedAgeMs };
}

/** Facts from a context-store record's properties (GeoJSON / OSM tags). */
function propertyFacts(properties) {
  const flat = {
    ...(properties || {}),
    ...(properties?.tags && typeof properties.tags === 'object'
      ? properties.tags
      : {}),
  };
  const keep = {};
  for (const [field, value] of Object.entries(flat)) {
    if (NOISE_TAG.test(field)) continue;
    if (text(value)) keep[field] = value;
  }
  return recordFacts(keep);
}

/** A reference link a record carries (Wikipedia, Wikidata or a website). */
function recordLinks(record, properties) {
  const flat = {
    ...(properties || {}),
    ...(properties?.tags && typeof properties.tags === 'object'
      ? properties.tags
      : {}),
    ...(record || {}),
  };
  const links = [];
  const wikipedia = text(flat.wikipedia);
  if (wikipedia) {
    const [lang, ...title] = wikipedia.includes(':')
      ? wikipedia.split(':')
      : ['en', wikipedia];
    // The language part becomes the link's host, so only a language code is
    // let through.
    if (/^[a-z]{2,3}(-[a-z0-9]+)*$/.test(lang))
      links.push({
        kind: 'wikipedia',
        label: msg('Wikipedia'),
        href: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.join(':').replace(/ /g, '_'))}`,
      });
  }
  const wikidata = text(flat.wikidata);
  if (/^Q\d+$/.test(wikidata))
    links.push({
      kind: 'wikidata',
      label: msg('Wikidata'),
      href: `https://www.wikidata.org/wiki/${wikidata}`,
    });
  const website = text(flat.website);
  if (/^https?:\/\//.test(website))
    links.push({ kind: 'website', label: msg('Website'), href: website });
  return links;
}

/** Enabled layers, as the data manager lists them. */
function enabledLayers(dataManager) {
  try {
    return (dataManager?.getAll?.() || []).filter((layer) => layer.enabled);
  } catch {
    return [];
  }
}

/**
 * The items a layer has loaded, with a usable position. Empty while the layer
 * is off or keeps no list.
 */
export function layerRecords(dataManager, layerId, maxCount = ALL_RECORDS) {
  if (dataManager?.isEnabled && !dataManager.isEnabled(layerId)) return [];
  let records = [];
  try {
    records =
      dataManager?.layers
        ?.get?.(layerId)
        ?.module?.getAnalystRecords?.(maxCount) || [];
  } catch {
    records = [];
  }
  return records.filter((record) => recordPosition(record));
}

function layerName(dataManager, layerId) {
  const layer = dataManager?.layers?.get?.(layerId);
  return text(layer?.name) || text(layer?.module?.name) || layerId;
}

const sameText = (a, b) =>
  Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();

/**
 * The layer record behind an identity from a click, a search or the store:
 * matched by key, then by name, then as the nearest item to its position.
 * @param {object} dataManager
 * @param {{layerId: string, id?: string, label?: string, lat?: number|null, lon?: number|null}} identity
 * @returns {object|null}
 */
export function findRecord(dataManager, identity) {
  const { layerId } = identity || {};
  if (!layerId) return null;
  const records = layerRecords(dataManager, layerId);
  if (!records.length) return null;
  const id = text(identity.id);
  const bare = id.startsWith(`${layerId}:`) ? id.slice(layerId.length + 1) : id;
  const at =
    finite(identity.lat) !== null && finite(identity.lon) !== null
      ? { lat: Number(identity.lat), lon: Number(identity.lon) }
      : null;
  const nearest = (pool) => {
    let best = null;
    let bestKm = Infinity;
    for (const record of pool) {
      const km = distanceKm(at, recordPosition(record));
      if (km < bestKm) {
        best = record;
        bestKm = km;
      }
    }
    return { best, bestKm };
  };
  const byKey = records.filter((record) =>
    KEY_FIELDS.some((field) => {
      const value = text(record[field]);
      return value && (sameText(value, id) || sameText(value, bare));
    }),
  );
  // Sites can share a key (many are keyed by a name such as an operator's):
  // of several, the one where the identity says it is.
  if (byKey.length === 1 || (byKey.length && !at)) return byKey[0];
  if (byKey.length) return nearest(byKey).best;
  const label = text(identity.label);
  const byName = records.filter((record) =>
    SEARCH_FIELDS.some((field) => sameText(text(record[field]), label)),
  );
  if (byName.length === 1 || (byName.length && !at)) return byName[0];
  if (!at) return null;
  // A moving item is matched by its key or name above; guessing the nearest
  // could name another craft.
  if (!byName.length && entityKind(layerId).moving) return null;
  const { best, bestKm } = nearest(byName.length ? byName : records);
  // A static item a click names sits where it was drawn.
  return bestKm <= 1 ? best : null;
}

/** The context-store record for an identity, when the layer keeps one. */
function storeRecord(identity) {
  try {
    const store = getContextStore();
    const direct = store.entities.get(String(identity.id));
    if (direct?.layerId === identity.layerId) return direct;
    // Of several stored sites with the same name, the one at the identity's
    // position; a name alone picks the first.
    const at = recordPosition(identity);
    let best = null;
    let bestKm = Infinity;
    for (const record of store.entities.values()) {
      if (record?.layerId !== identity.layerId) continue;
      if (sameText(text(record.properties?.mmsi), text(identity.id)))
        return record;
      if (!sameText(text(record.label), text(identity.label))) continue;
      const where = recordPosition(record);
      const km = at && where ? distanceKm(at, where) : best ? Infinity : 0;
      if (km < bestKm) {
        best = record;
        bestKm = km;
      }
    }
    if (best) return best;
  } catch {
    // No window in unit tests without a DOM.
  }
  return null;
}

/**
 * The card for one item.
 * @param {object} dataManager
 * @param {{layerId: string, id?: string, label?: string, lat?: number|null, lon?: number|null, record?: object}} identity
 * @param {object} [options]
 * @param {number} [options.nowMs]
 * @returns {object|null} `{key, layerId, layerName, kind, icon, moving, title, lat, lon, facts, observedAgeMs, links, source}`
 */
/** What a transponder code means when it is one of the emergency codes. */
const EMERGENCY_SQUAWKS = Object.freeze({
  7500: msg('Hijack (squawk 7500)'),
  7600: msg('Radio failure (squawk 7600)'),
  7700: msg('Emergency (squawk 7700)'),
});

/**
 * A record's warnings as `{value, words}`: the English and, for the ones this
 * module words, what the UI shows through t(). A layer's own alert text has
 * no words; it shows as the feed gives it.
 */
function warningEntries(record) {
  if (!record) return [];
  const found = [];
  const kind = text(record.emergencyKind);
  if (record.emergency === true || (kind && kind.toLowerCase() !== 'none')) {
    // A known ADS-B emergency goes by its name; another word as given.
    const named = kind ? aircraftEmergency({ emergency: kind })?.label : '';
    found.push(
      kind
        ? said(`Emergency: ${named || kind}`, msg('Emergency: {kind}'), {
            kind: named ? words(named) : kind,
          })
        : said('Emergency declared', msg('Emergency declared')),
    );
  }
  const squawk = EMERGENCY_SQUAWKS[Number(record.squawk)];
  if (squawk && !found.length) found.push(said(squawk, squawk));
  if (record.tsunami === true || Number(record.tsunami) === 1)
    found.push(said('Tsunami warning issued', msg('Tsunami warning issued')));
  // `alert` is left out: feeds use it for a level (an earthquake's PAGER
  // colour), not a warning to read out.
  for (const field of ['warning', 'advisory']) {
    const value = text(record[field]);
    if (value && !found.some((entry) => entry.value === value))
      found.push({ value, words: null });
  }
  return found;
}

/**
 * Warnings a record carries, most serious first: an aircraft emergency or
 * emergency squawk, a tsunami flag, or a layer's own alert text. These lead
 * the card, ahead of any facts.
 * @param {?object} record
 * @returns {string[]} In English; cards and alerts also carry their words.
 */
export function recordWarnings(record) {
  return warningEntries(record).map((entry) => entry.value);
}

/** What a routine transponder code says, for the codes with a meaning. */
const SQUAWK_MEANINGS = Object.freeze({
  1200: msg('VFR, no flight plan'),
  7000: msg('VFR conspicuity'),
  2000: msg('IFR, no code yet'),
  7500: msg('Hijack'),
  7600: msg('Radio failure'),
  7700: msg('Emergency'),
});

/** Speed of sound (m/s) at a height, from the standard atmosphere. */
function speedOfSound(heightM) {
  const kelvin = heightM < 11_000 ? 288.15 - 0.0065 * heightM : 216.65;
  return 20.05 * Math.sqrt(kelvin);
}

/**
 * What can be worked out about a flight beyond its raw fields: its phase of
 * flight, flight level, Mach number, what its squawk means and how fresh its
 * signal is. For the callouts on the aircraft card, which show these rather
 * than repeat the facts listed below them.
 * @param {?object} record
 * @param {{nowMs?: number}} [options]
 * @returns {Array<{label: string, labelValues?: object, value: string, words?: object}>}
 *   `label` is English for t(), with `labelValues` filling its placeholders;
 *   `value` is the English and `words` what the UI shows (see words()).
 */
export function aircraftInsights(record, { nowMs = Date.now() } = {}) {
  if (!record) return [];
  const out = [];
  const altitudeM = finite(record.altitudeM);
  const climbMps = finite(record.verticalRateMps);
  const speedMps = finite(
    record.speedMps ??
      (finite(record.speedKts) !== null ? record.speedKts * 0.514444 : null),
  );
  if (record.onGround === true)
    out.push({
      label: msg('Phase'),
      ...said('On the ground', msg('On the ground')),
    });
  else if (climbMps !== null) {
    const fpm = climbMps * 196.85;
    const rate = Math.round(Math.abs(fpm) / 100) * 100;
    out.push({
      label: msg('Phase'),
      ...(fpm > 300
        ? said(`Climbing ${rate} ft/min`, msg('Climbing {n} ft/min'), {
            n: rate,
          })
        : fpm < -300
          ? said(`Descending ${rate} ft/min`, msg('Descending {n} ft/min'), {
              n: rate,
            })
          : said('Cruising, level', msg('Cruising, level'))),
    });
  }
  if (altitudeM !== null && altitudeM > 900)
    out.push({
      label: msg('Flight level'),
      value: `FL${String(Math.round((altitudeM * 3.28084) / 1000) * 10).padStart(3, '0')}`,
    });
  if (speedMps !== null && altitudeM !== null && speedMps > 60)
    out.push({
      label: msg('Mach'),
      ...said(
        `M ${(speedMps / speedOfSound(altitudeM)).toFixed(2)}`,
        msg('M {n}'),
        { n: roundTo(speedMps / speedOfSound(altitudeM), 2) },
        { fixed: 2 },
      ),
    });
  const squawk = Number(record.squawk);
  if (SQUAWK_MEANINGS[squawk])
    out.push({
      label: msg('Squawk {code}'),
      labelValues: { code: String(record.squawk) },
      ...said(SQUAWK_MEANINGS[squawk], SQUAWK_MEANINGS[squawk]),
    });
  const seen = finite(record.lastContactAtMs ?? record.timeMs);
  if (seen !== null) {
    const seconds = Math.max(0, Math.round((nowMs - seen) / 1000));
    out.push({
      label: msg('Signal'),
      ...(seconds < 90
        ? said(`${seconds} s ago`, msg('{n} s ago'), { n: seconds })
        : said(`${Math.round(seconds / 60)} min ago`, msg('{n} min ago'), {
            n: Math.round(seconds / 60),
          })),
    });
  }
  return out;
}

/**
 * The item's photo, once its layer has looked one up: the tracked airliner's
 * Planespotters photo, or the selected vessel's Open Vessel Photos photo.
 * @returns {{src: string, link: string, photographer: string,
 *   licence: string}|null}
 */
function cardPhoto(dataManager, layerId, record) {
  let photo = null;
  try {
    const layer = dataManager?.layers?.get?.(layerId)?.module;
    if (layerId === 'ais-live-vessels')
      photo = layer?.getVesselPhoto?.(text(record?.vesselId));
    else if (layerId === 'flights') {
      // Looked up only for the plane the layer tracks.
      const tracked = layer?.getTrackedSubject?.();
      if (tracked && text(tracked.id) === text(record?.icao24))
        photo = tracked.photo;
    }
  } catch {
    photo = null;
  }
  if (!text(photo?.src)) return null;
  return {
    src: text(photo.src),
    link: text(photo.link),
    photographer: text(photo.photographer),
    licence: text(photo.licence),
  };
}

export function describeEntity(
  dataManager,
  identity,
  { nowMs = Date.now() } = {},
) {
  if (!identity?.layerId) return null;
  const { layerId } = identity;
  const kind = entityKind(layerId);
  const record = identity.record || findRecord(dataManager, identity);
  // Sites drawn from GeoJSON keep their full tags in the context store; the
  // layer's record holds only a summary of them.
  const stored =
    record && kind.moving
      ? null
      : storeRecord({
          ...identity,
          label: identity.label || recordTitle(record),
        });
  if (!record && !stored && !identity.label) return null;

  const at =
    recordPosition(record) ||
    recordPosition(stored) ||
    recordPosition(identity);
  const fromRecord = record
    ? recordFacts(record, { nowMs, kind: kind.kind })
    : null;
  const fromStore = stored ? propertyFacts(stored.properties) : null;
  const facts = [...(fromRecord?.facts || [])];
  for (const fact of fromStore?.facts || []) {
    if (facts.length >= MAX_FACTS) break;
    const same = facts.some(
      (known) =>
        known.label.toLowerCase() === fact.label.toLowerCase() ||
        known.value.toLowerCase() === fact.value.toLowerCase(),
    );
    if (!same) facts.push(fact);
  }
  // An item with only a database number goes by what it is.
  const ownTitle = recordTitle(record);
  const title =
    (kind.name && (!ownTitle || ownTitle === text(record?.id))
      ? kind.name
      : ownTitle) ||
    text(stored?.label) ||
    text(stored?.properties?.name) ||
    text(identity.label) ||
    layerName(dataManager, layerId);
  const key = record
    ? recordKey(layerId, record)
    : `${layerId}:${text(identity.id) || title}`;
  const warnings = warningEntries(record);
  const aircraftClass =
    kind.kind === 'aircraft' ? text(record?.aircraftClass) || null : null;
  return {
    key,
    layerId,
    layerName: text(stored?.layerName) || layerName(dataManager, layerId),
    kind: kind.kind,
    icon: kind.icon,
    moving: Boolean(kind.moving),
    // The fields that lead the card as its big figures.
    headline: kind.headline || [],
    title,
    // The kind's own name, when the item goes by it, for the UI to translate.
    titleWords: kind.name && title === kind.name ? words(kind.name) : null,
    lat: at?.lat ?? null,
    lon: at?.lon ?? null,
    altitudeM: finite(record?.altitudeM ?? identity.altitudeM),
    facts: facts.filter((fact) => fact.value !== title),
    warnings: warnings.map((entry) => entry.value),
    // The same warnings for the UI to show: words, or null to show as given.
    warningWords: warnings.map((entry) => entry.words),
    // For the aircraft card's model and route line.
    aircraftClass,
    // What picks the fleet model the globe draws this aircraft with.
    aircraftModel:
      kind.kind === 'aircraft' && record
        ? {
            typeCode: text(record.typeCode ?? record.type) || null,
            category: record.category ?? null,
            callsign: text(record.callsign) || null,
          }
        : null,
    photo: cardPhoto(dataManager, layerId, record),
    // Its class's English name, for the UI to translate; null when unknown.
    aircraftClassName: AIRCRAFT_CLASS_LABELS[aircraftClass] || null,
    insights:
      kind.kind === 'aircraft' ? aircraftInsights(record, { nowMs }) : [],
    operator: text(record?.operator) || null,
    heading: finite(record?.heading ?? record?.course),
    speedMps: finite(
      record?.speedMps ??
        (finite(record?.speedKts) !== null ? record.speedKts * 0.514444 : null),
    ),
    route:
      text(record?.routeOrigin) || text(record?.routeDestination)
        ? {
            from: text(record?.routeOrigin) || '—',
            to: text(record?.routeDestination) || '—',
            verified: true,
            // Airport positions, when known, for the route globe.
            fromAt: record?.routeFrom || null,
            toAt: record?.routeTo || null,
          }
        : record?.routeScheduled
          ? {
              // Scheduled for the flight number but not where the plane is:
              // shown as unverified, and never drawn on the globe.
              from: text(record.routeScheduled.from) || '—',
              to: text(record.routeScheduled.to) || '—',
              verified: false,
              fromAt: null,
              toAt: null,
            }
          : null,
    observedAgeMs: fromRecord?.observedAgeMs ?? null,
    links: recordLinks(record, stored?.properties),
    source: text(stored?.source) || null,
    // What the card was built from: the layer's own record, the store's
    // properties, or only the click's identity.
    basis: record ? 'record' : stored ? 'store' : 'identity',
    identity: {
      layerId,
      id: record
        ? recordKey(layerId, record).slice(layerId.length + 1)
        : text(identity.id),
      label: title,
      lat: at?.lat ?? null,
      lon: at?.lon ?? null,
    },
  };
}

/**
 * What is near an item: the closest items of its own layer, and the closest
 * item of each other enabled layer.
 * @param {object} dataManager
 * @param {{layerId: string, key: string, lat: number|null, lon: number|null}} card
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {number} [options.radiusKm]
 * @returns {{same: Array<object>, other: Array<object>}}
 */
export function nearbyEntities(
  dataManager,
  card,
  { limit = 5, radiusKm = 500 } = {},
) {
  const empty = { same: [], other: [] };
  if (!card || card.lat === null || card.lon === null) return empty;
  const here = { lat: card.lat, lon: card.lon };
  const row = (layerId, record, km) => ({
    key: recordKey(layerId, record),
    layerId,
    layerName: layerName(dataManager, layerId),
    icon: entityKind(layerId).icon,
    kind: entityKind(layerId).kind,
    title: recordTitle(record) || layerName(dataManager, layerId),
    distanceKm: km,
    identity: {
      layerId,
      id: recordKey(layerId, record).slice(layerId.length + 1),
      label: recordTitle(record),
      ...recordPosition(record),
      record,
    },
  });
  const nearest = (layerId, count) => {
    const found = [];
    for (const record of layerRecords(dataManager, layerId)) {
      const key = recordKey(layerId, record);
      if (key === card.key) continue;
      const km = distanceKm(here, recordPosition(record));
      if (km > radiusKm) continue;
      found.push({ record, km });
    }
    return found
      .sort((a, b) => a.km - b.km)
      .slice(0, count)
      .map(({ record, km }) => row(layerId, record, km));
  };
  const same = nearest(card.layerId, limit);
  const other = enabledLayers(dataManager)
    .filter((layer) => layer.id !== card.layerId)
    .map((layer) => nearest(layer.id, 1)[0])
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
  return { same, other };
}

/**
 * What the loaded layers have within a radius of a point, in the groups every
 * Context card lists: aircraft, vessels, and the closest item of each other
 * enabled layer. Each group is nearest first; `count` is how many are inside
 * the radius, of which `items` holds the first few.
 * @param {object} dataManager
 * @param {{lat: number, lon: number}} here
 * @param {object} [options]
 * @param {number} [options.radiusKm]
 * @param {number} [options.limit] Rows per group.
 * @param {string} [options.excludeKey] A record to leave out (the selected one).
 * @param {string[]} [options.excludeLayers] Layers already presented by another section.
 * @returns {{flights: {count: number, items: Array<object>}, vessels: {count: number, items: Array<object>}, other: Array<object>}}
 */
export function nearbyByKind(
  dataManager,
  here,
  {
    radiusKm = 250,
    limit = 4,
    excludeKey = '',
    excludeLayers = [],
    query = '',
  } = {},
) {
  const needle = text(query).toLowerCase();
  const groups = {
    flights: { count: 0, items: [] },
    vessels: { count: 0, items: [] },
    other: [],
  };
  if (!here || !Number.isFinite(here.lat) || !Number.isFinite(here.lon))
    return groups;
  const found = { aircraft: [], vessel: [] };
  const other = [];
  for (const layer of enabledLayers(dataManager)) {
    if (excludeLayers.includes(layer.id)) continue;
    const kind = entityKind(layer.id).kind;
    const group = found[kind];
    let closest = null;
    for (const record of layerRecords(dataManager, layer.id)) {
      if (excludeKey && recordKey(layer.id, record) === excludeKey) continue;
      const km = distanceKm(here, recordPosition(record));
      if (!(km <= radiusKm)) continue;
      if (needle && !recordMatches(record, needle, layer.name)) continue;
      if (group) group.push({ layerId: layer.id, record, km });
      // A search lists every match, not only each layer's closest item.
      else if (needle) other.push({ layerId: layer.id, record, km });
      else if (!closest || km < closest.km)
        closest = { layerId: layer.id, record, km };
    }
    if (closest) other.push(closest);
  }
  const row = ({ layerId, record, km }) => ({
    key: recordKey(layerId, record),
    layerId,
    layerName: layerName(dataManager, layerId),
    icon: entityKind(layerId).icon,
    title: recordTitle(record) || layerName(dataManager, layerId),
    distanceKm: km,
    identity: {
      layerId,
      id: recordKey(layerId, record).slice(layerId.length + 1),
      label: recordTitle(record),
      ...recordPosition(record),
      record,
    },
  });
  const nearest = (rows) => ({
    count: rows.length,
    items: rows
      .sort((a, b) => a.km - b.km)
      .slice(0, limit)
      .map(row),
  });
  groups.flights = nearest(found.aircraft);
  groups.vessels = nearest(found.vessel);
  groups.other = other
    .sort((a, b) => a.km - b.km)
    .slice(0, limit)
    .map(row);
  return groups;
}

/** Counts of records by a label, largest first, the tail folded into "Other". */
function tallyBy(records, labelOf, { keep = 4 } = {}) {
  const counts = new Map();
  for (const record of records) {
    const label = labelOf(record) || 'Unknown';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const parts = sorted
    .slice(0, keep)
    .map(([label, count]) => ({ label, count }));
  const rest = sorted.slice(keep).reduce((sum, [, count]) => sum + count, 0);
  if (rest) {
    // A label that is itself "Other" takes the tail, so the name shows once.
    const other = parts.find((part) => part.label === 'Other');
    if (other) other.count += rest;
    else parts.push({ label: msg('Other'), count: rest });
  }
  return parts.sort((a, b) => b.count - a.count);
}

const AIRCRAFT_CLASS_NAMES = {
  airliner: msg('Airliners'),
  widebody: msg('Widebodies'),
  bizjet: msg('Business jets'),
  light: msg('Light aircraft'),
  helicopter: msg('Helicopters'),
  turboprop: msg('Turboprops'),
  fastjet: msg('Fast jets'),
  quadjet: msg('Four-engine jets'),
  vehicle: msg('Airport vehicles'),
  station: msg('Ground stations / obstacles'),
};

/**
 * What a layer's items are made of, for Context: one or two ways of splitting
 * them, each a list of labelled counts that add up to `total`. Aircraft split
 * into civilian in the air, military in the air and on the ground, then by
 * type of aircraft; vessels by type of ship; satellites by class; earthquakes
 * by magnitude. Counts cover the records the layer hands out (it may cap
 * them), inside `rect` when one is given.
 * @param {object} dataManager
 * @param {string} layerId
 * @param {{rect?: ?{west: number, south: number, east: number, north: number}}} [options]
 * @returns {?{total: number, splits: Array<{title: string, parts: Array<{label: string, count: number}>}>}}
 *   null when the layer has nothing to split or no split is known for it.
 */
export function layerBreakdown(dataManager, layerId, { rect = null } = {}) {
  const kind = entityKind(layerId).kind;
  if (
    !['aircraft', 'vessel', 'satellite', 'earthquake', 'vehicle'].includes(kind)
  )
    return null;
  let records = layerRecords(dataManager, layerId);
  if (rect) {
    const wraps = rect.west > rect.east;
    records = records.filter((record) => {
      const at = recordPosition(record);
      return (
        at.lat >= rect.south &&
        at.lat <= rect.north &&
        (wraps
          ? at.lon >= rect.west || at.lon <= rect.east
          : at.lon >= rect.west && at.lon <= rect.east)
      );
    });
  }
  if (!records.length) return null;
  const splits = [];
  if (kind === 'aircraft') {
    const ground = records.filter((record) => record.onGround === true).length;
    const military = records.filter(
      (record) => record.onGround !== true && record.military === true,
    ).length;
    splits.push({
      title: msg('Status'),
      parts: [
        {
          label: msg('Civilian, in the air'),
          count: records.length - ground - military,
        },
        { label: msg('Military, in the air'), count: military },
        { label: msg('On the ground'), count: ground },
      ].filter((part) => part.count),
    });
    splits.push({
      title: msg('Type'),
      parts: tallyBy(
        records,
        (record) =>
          AIRCRAFT_CLASS_NAMES[record.aircraftClass] ||
          plainWord(text(record.aircraftClass)),
      ),
    });
  } else if (kind === 'vessel') {
    splits.push({
      title: msg('Type'),
      parts: tallyBy(records, (record) => shipTypeName(record.shipType)),
    });
  } else if (kind === 'vehicle') {
    // What the display shows each vehicle doing, then what kind it is, who
    // runs it, the operator's own report and crowding where the feed has it.
    // Feeds of vehicle positions carry no timetable, so early or late is not
    // something these records can say.
    const word = (field) => (record) => CODE_WORDS[field][record[field]] || '';
    splits.push({
      title: msg('Motion'),
      parts: tallyBy(records, word('motion')),
    });
    splits.push({
      title: msg('Mode'),
      parts: tallyBy(
        records,
        (record) =>
          CODE_WORDS.mode[record.mode] || plainWord(text(record.mode)),
      ),
    });
    const operators = tallyBy(records, (record) => text(record.operator));
    if (operators.length > 1)
      splits.push({ title: msg('Operator'), parts: operators });
    const reported = records.filter(
      (record) => CODE_WORDS.status[record.status],
    );
    if (reported.length)
      splits.push({
        title: msg('Last reported'),
        parts: tallyBy(reported, word('status')),
      });
    const crowded = records.filter(
      (record) => CODE_WORDS.occupancy[record.occupancy],
    );
    if (crowded.length)
      splits.push({
        title: msg('Crowding'),
        parts: tallyBy(crowded, word('occupancy')),
      });
  } else if (kind === 'satellite') {
    splits.push({
      title: msg('Class'),
      parts: tallyBy(records, (record) =>
        plainWord(text(record.satelliteClass || record.group)),
      ),
    });
  } else {
    const band = (record) => {
      const m = finite(record.magnitude);
      return m === null
        ? ''
        : m >= 6
          ? msg('M6 and above')
          : m >= 5
            ? msg('M5 to 6')
            : m >= 4
              ? msg('M4 to 5')
              : msg('Below M4');
    };
    splits.push({ title: msg('Magnitude'), parts: tallyBy(records, band) });
  }
  return {
    total: records.length,
    splits: splits.filter((split) => split.parts.length),
  };
}

/**
 * Whether a record holds the searched text in any of its text fields, or in
 * its layer's name.
 * @param {object} record
 * @param {string} needle Lower case; '' matches everything.
 * @param {string} [layerLabel]
 * @returns {boolean}
 */
export function recordMatches(record, needle, layerLabel = '') {
  if (!needle) return true;
  if (text(layerLabel).toLowerCase().includes(needle)) return true;
  for (const value of Object.values(record || {})) {
    if (typeof value === 'string' && value.toLowerCase().includes(needle))
      return true;
  }
  return false;
}

/**
 * Items in enabled layers whose name or id starts with the typed text, best
 * first. A whole-word match beats a match inside a word.
 * @param {object} dataManager
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {{lat: number, lon: number}|null} [options.near] Ties go to the closer item.
 * @returns {Array<object>}
 */
export function searchEntities(
  dataManager,
  query,
  { limit = 4, near = null } = {},
) {
  const needle = text(query).toLowerCase();
  if (needle.length < 2) return [];
  const inWord = new RegExp(
    `(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );
  const found = [];
  for (const layer of enabledLayers(dataManager)) {
    for (const record of layerRecords(dataManager, layer.id)) {
      let score = 0;
      for (const field of [...SEARCH_FIELDS, ...KEY_FIELDS]) {
        const value = text(record[field]).toLowerCase();
        if (!value) continue;
        const hit =
          value === needle
            ? 3
            : value.startsWith(needle)
              ? 2
              : needle.length >= 3 && inWord.test(value)
                ? 1
                : 0;
        score = Math.max(score, hit);
      }
      if (!score) continue;
      const at = recordPosition(record);
      found.push({
        score,
        km: near ? distanceKm(near, at) : 0,
        key: recordKey(layer.id, record),
        layerId: layer.id,
        layerName: layerName(dataManager, layer.id),
        icon: entityKind(layer.id).icon,
        title: recordTitle(record) || layer.id,
        identity: {
          layerId: layer.id,
          id: recordKey(layer.id, record).slice(layer.id.length + 1),
          label: recordTitle(record),
          ...at,
          record,
        },
      });
    }
  }
  const seen = new Set();
  return found
    .sort((a, b) => b.score - a.score || a.km - b.km)
    .filter((item) => !seen.has(item.key) && seen.add(item.key))
    .slice(0, limit);
}

/**
 * What the loaded layers have inside a view: for each enabled layer with
 * anything in the rectangle, how many and the few closest to the view's
 * centre, as rows the Context panel can open. Layers with the most in view
 * come first.
 * @param {object} dataManager
 * @param {{west: number, south: number, east: number, north: number}} rect Degrees.
 * @param {{lat: number, lon: number}} center
 * @param {object} [options]
 * @param {number} [options.perLayer] Closest items to list for each layer.
 * @returns {Array<{layerId: string, layerName: string, icon: string, count: number, items: Array<object>}>}
 */
export function viewSummary(
  dataManager,
  rect,
  center,
  { perLayer = 3, query = '' } = {},
) {
  if (!rect || !center) return [];
  const needle = text(query).toLowerCase();
  const wraps = rect.west > rect.east;
  const inside = (at) =>
    at &&
    at.lat >= rect.south &&
    at.lat <= rect.north &&
    (wraps
      ? at.lon >= rect.west || at.lon <= rect.east
      : at.lon >= rect.west && at.lon <= rect.east);
  const groups = [];
  for (const layer of enabledLayers(dataManager)) {
    const found = [];
    for (const record of layerRecords(dataManager, layer.id)) {
      const at = recordPosition(record);
      if (!inside(at)) continue;
      if (needle && !recordMatches(record, needle, layer.name)) continue;
      found.push({ record, km: distanceKm(center, at) });
    }
    if (!found.length) continue;
    found.sort((a, b) => a.km - b.km);
    groups.push({
      layerId: layer.id,
      layerName: layerName(dataManager, layer.id),
      icon: entityKind(layer.id).icon,
      count: found.length,
      items: found.slice(0, perLayer).map(({ record, km }) => ({
        key: recordKey(layer.id, record),
        title: recordTitle(record) || layerName(dataManager, layer.id),
        distanceKm: km,
        identity: {
          layerId: layer.id,
          id: recordKey(layer.id, record).slice(layer.id.length + 1),
          label: recordTitle(record),
          ...recordPosition(record),
          record,
        },
      })),
    });
  }
  return groups.sort((a, b) => b.count - a.count);
}

/**
 * A layer's items inside an area that pass a test, closest to the area's
 * middle first: how many, and the first few as rows the omnibox and Context
 * can open. The area is a rectangle in degrees, or a radius around a point.
 * @param {object} dataManager
 * @param {string} layerId
 * @param {object} area
 * @param {{lat: number, lon: number}} area.center
 * @param {?{west: number, south: number, east: number, north: number}} [area.rect]
 * @param {number} [area.radiusKm] Used when there is no rectangle.
 * @param {(record: object) => boolean} [area.test]
 * @param {number} [area.limit]
 * @returns {{count: number, items: Array<object>}}
 */
export function layerMatches(
  dataManager,
  layerId,
  { center, rect = null, radiusKm = 60, test = () => true, limit = 8 },
) {
  const found = [];
  const wraps = rect && rect.west > rect.east;
  for (const record of layerRecords(dataManager, layerId)) {
    const at = recordPosition(record);
    if (!at) continue;
    if (rect) {
      const inLon = wraps
        ? at.lon >= rect.west || at.lon <= rect.east
        : at.lon >= rect.west && at.lon <= rect.east;
      if (!inLon || at.lat < rect.south || at.lat > rect.north) continue;
    }
    const km = distanceKm(center, at);
    if (!rect && km > radiusKm) continue;
    if (!test(record)) continue;
    found.push({ record, km });
  }
  found.sort((a, b) => a.km - b.km);
  return {
    count: found.length,
    items: found.slice(0, limit).map(({ record, km }) => ({
      key: recordKey(layerId, record),
      title: recordTitle(record) || layerName(dataManager, layerId),
      icon: entityKind(layerId).icon,
      distanceKm: km,
      identity: {
        layerId,
        id: recordKey(layerId, record).slice(layerId.length + 1),
        label: recordTitle(record),
        ...recordPosition(record),
        record,
      },
    })),
  };
}

/**
 * Loaded records near a point that carry a warning (an aircraft squawking an
 * emergency, a quake with a tsunami flag, an advisory), nearest first. These
 * are what each feed broadcasts, not confirmed incidents.
 */
export function alertsNear(
  dataManager,
  here,
  { radiusKm = 400, limit = 4 } = {},
) {
  if (!here || !Number.isFinite(here.lat) || !Number.isFinite(here.lon))
    return [];
  const found = [];
  for (const layer of enabledLayers(dataManager)) {
    for (const record of layerRecords(dataManager, layer.id)) {
      const warnings = warningEntries(record);
      if (!warnings.length) continue;
      const km = distanceKm(here, recordPosition(record));
      if (!(km <= radiusKm)) continue;
      found.push({
        key: recordKey(layer.id, record),
        icon: entityKind(layer.id).icon,
        title: recordTitle(record) || layerName(dataManager, layer.id),
        text: warnings[0].value,
        // What the UI shows for it: words, or null to show `text` as given.
        words: warnings[0].words,
        distanceKm: km,
        identity: {
          layerId: layer.id,
          id: recordKey(layer.id, record).slice(layer.id.length + 1),
          label: recordTitle(record),
          ...recordPosition(record),
          record,
        },
      });
    }
  }
  return found.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, limit);
}
