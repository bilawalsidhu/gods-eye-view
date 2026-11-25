/**
 * @module vesselTypes
 * @description AIS ship-type codes (ITU-R M.1371) to family names, with no
 * browser or i18n dependencies so the server-side query tools can use it.
 */

const NUMERIC_TYPE_SPECIALS = {
  30: 'FISHING',
  31: 'TOWING',
  32: 'TOWING',
  33: 'DREDGER',
  34: 'DIVE OPS',
  35: 'MILITARY',
  36: 'SAILING',
  37: 'PLEASURE',
  50: 'PILOT',
  51: 'SAR',
  52: 'TUG',
  53: 'PORT TENDER',
  54: 'ANTI-POLLUTION',
  55: 'LAW ENFORCE',
  58: 'MEDICAL',
};
const NUMERIC_TYPE_FAMILIES = {
  4: 'HIGH-SPEED',
  6: 'PASSENGER',
  7: 'CARGO',
  8: 'TANKER',
  9: 'OTHER',
};

/**
 * Resolve an AIS type to display text: bare numeric ship-type codes map to
 * family names ("71" → "CARGO"); text types pass through unchanged. Code 0
 * ("not available") and the reserved codes 100 to 255 name no type and
 * resolve to "".
 * @param {string} type Raw AIS type.
 * @returns {string}
 */
export function normalizeVesselType(type) {
  const text = String(type || '').trim();
  if (!text || !/^\d+$/.test(text)) return text;
  const code = Number(text);
  if (code <= 0 || code >= 100) return '';
  if (NUMERIC_TYPE_SPECIALS[code]) return NUMERIC_TYPE_SPECIALS[code];
  return NUMERIC_TYPE_FAMILIES[Math.floor(code / 10)] || 'OTHER';
}

/**
 * The vessel kinds a ship is drawn as, each with its own hull sprite and
 * colour (`vesselSprites.js`), by the type family its AIS type resolves to
 * ({@link normalizeVesselType}), in order: the first that matches.
 */
const VESSEL_KIND_RULES = [
  ['tanker', /tanker|\blng\b|\blpg\b|gas carrier/i],
  ['highspeed', /high[- ]?speed|\bhsc\b/i],
  ['passenger', /passenger|ferry|cruise/i],
  ['cargo', /cargo|container|bulk|carrier|freighter|ro-?ro/i],
  ['fishing', /fishing|trawler/i],
  [
    'military',
    /military|naval|navy|warship|law enforce|police|patrol|coast ?guard|\bsar\b|search and rescue/i,
  ],
  ['tug', /tug|tow|pilot|tender|supply|service|anti-pollution/i],
  ['sailing', /sail/i],
  ['pleasure', /pleasure|yacht/i],
];

/** Every vessel kind {@link vesselKind} names, `other` last. */
export const VESSEL_KINDS = Object.freeze([
  ...VESSEL_KIND_RULES.map(([kind]) => kind),
  'other',
]);

/**
 * Each vessel kind's colour on the map and on its card, as CSS and as the
 * card's "r, g, b" accent. Every one reads on dark water and differs from
 * the rest; cargo and other share the default cyan.
 */
export const VESSEL_KIND_STYLES = Object.freeze({
  cargo: Object.freeze({ css: '#39d5ff', accent: '57, 213, 255' }),
  tanker: Object.freeze({ css: '#ffb347', accent: '255, 179, 71' }),
  passenger: Object.freeze({ css: '#ff7adf', accent: '255, 122, 223' }),
  highspeed: Object.freeze({ css: '#c6ff3d', accent: '198, 255, 61' }),
  fishing: Object.freeze({ css: '#7cff9b', accent: '124, 255, 155' }),
  tug: Object.freeze({ css: '#f7f0a3', accent: '247, 240, 163' }),
  sailing: Object.freeze({ css: '#b49cff', accent: '180, 156, 255' }),
  pleasure: Object.freeze({ css: '#ff6f61', accent: '255, 111, 97' }),
  military: Object.freeze({ css: '#a9bccb', accent: '169, 188, 203' }),
  other: Object.freeze({ css: '#39d5ff', accent: '57, 213, 255' }),
});

/** Kind by type text: a feed uses few distinct type texts. */
const KIND_MEMO = new Map();
const KIND_MEMO_MAX = 1024;

/**
 * The kind of vessel an AIS type names, a numeric ship-type code (ITU-R
 * M.1371) or a text type: `cargo` (70 to 79), `tanker` (80 to 89),
 * `passenger` (60 to 69), `highspeed` (40 to 49), `fishing` (30), `tug`
 * (tugs, towing, pilots, tenders, anti-pollution: 31, 32, 50, 52 to 54),
 * `sailing` (36), `pleasure` (37), `military` (military, law enforcement,
 * search and rescue: 35, 55, 51) or `other` (anything else, unknown types
 * included).
 * @param {string|number|null|undefined} type
 * @returns {string} One of {@link VESSEL_KINDS}.
 */
export function vesselKind(type) {
  const text = normalizeVesselType(type);
  let kind = KIND_MEMO.get(text);
  if (kind !== undefined) return kind;
  kind = VESSEL_KIND_RULES.find(([, pattern]) => pattern.test(text))?.[0];
  kind ??= 'other';
  if (KIND_MEMO.size >= KIND_MEMO_MAX) KIND_MEMO.clear();
  KIND_MEMO.set(text, kind);
  return kind;
}

/**
 * The kind of aid to navigation an AIS aid-to-navigation report (message 21)
 * names by its type code, 0 to 31 (ITU-R M.1371, IALA marks): beacons and
 * floating marks by their cardinal quadrant, lateral side, safe water,
 * isolated danger or special mark, and the lights, RACONs and reference
 * points around them. Code 0 names no kind.
 */
const AID_TYPE_NAMES = Object.freeze([
  'Navigation aid',
  'Reference point',
  'RACON',
  'Fixed structure off shore',
  'Emergency wreck marking buoy',
  'Light, without sectors',
  'Light, with sectors',
  'Leading light front',
  'Leading light rear',
  'Beacon, Cardinal N',
  'Beacon, Cardinal E',
  'Beacon, Cardinal S',
  'Beacon, Cardinal W',
  'Beacon, Port hand',
  'Beacon, Starboard hand',
  'Beacon, Preferred channel port hand',
  'Beacon, Preferred channel starboard hand',
  'Beacon, Isolated danger',
  'Beacon, Safe water',
  'Beacon, Special mark',
  'Cardinal Mark N',
  'Cardinal Mark E',
  'Cardinal Mark S',
  'Cardinal Mark W',
  'Port hand Mark',
  'Starboard hand Mark',
  'Preferred Channel Port hand',
  'Preferred Channel Starboard hand',
  'Isolated danger',
  'Safe Water',
  'Special Mark',
  'Light Vessel / LANBY / Rigs',
]);

/**
 * The kind an AIS aid-to-navigation type code names ("19" → "Beacon, Special
 * mark"); "Navigation aid" for code 0 and for a code outside 0 to 31.
 * @param {string|number|null|undefined} code
 * @returns {string}
 */
export function aidToNavigationTypeName(code) {
  const text = String(code ?? '').trim();
  const index = /^\d+$/.test(text) ? Number(text) : -1;
  return AID_TYPE_NAMES[index] ?? AID_TYPE_NAMES[0];
}

/** Every kind {@link aidToNavigationTypeName} names, lowercased. */
const AID_TYPE_NAME_SET = new Set(
  AID_TYPE_NAMES.map((name) => name.toLowerCase()),
);

/**
 * Words a vessel type uses for an aid to navigation. A vessel that works on
 * one ("Buoy Tender", "Buoy-Laying Vessel", "Buoy Layer") is a ship underway,
 * not a mark on the water.
 */
const AID_TYPE_TEXT =
  /navaid|\baton\b|aids? to nav|nav(igation)? aid|racon|lighthouse|lightship|light vessel|reference point|hand mark|cardinal|safe water|preferred channel|isolated danger|special mark|beacon|buoy/i;
const AID_WORKER_TEXT = /tender|lay(ing|er)\b/i;

/** ITU MID 99: the MMSI of an AIS aid-to-navigation station (99MIDxxxx). */
const AID_MMSI = /^99\d{7}$/;

/**
 * Whether each type text seen names an aid. Vessel layers ask per vessel on
 * their draw passes, and a feed uses few distinct type texts, so each is
 * matched once; the memo is bounded against a feed of free-form types.
 */
const AID_TYPE_MEMO = new Map();
const AID_TYPE_MEMO_MAX = 1024;

function typeNamesAid(text) {
  let aid = AID_TYPE_MEMO.get(text);
  if (aid !== undefined) return aid;
  aid =
    AID_TYPE_NAME_SET.has(text.toLowerCase()) ||
    (AID_TYPE_TEXT.test(text) && !AID_WORKER_TEXT.test(text));
  if (AID_TYPE_MEMO.size >= AID_TYPE_MEMO_MAX) AID_TYPE_MEMO.clear();
  AID_TYPE_MEMO.set(text, aid);
  return aid;
}

/**
 * Whether a vessel record is an aid to navigation (a buoy, beacon, mark,
 * RACON or light) rather than a vessel: its type is one of the kinds an aid
 * report names or uses a word for one, or its MMSI is an aid-to-navigation
 * station's, or it is a virtual aid. A numeric AIS ship type never names one.
 * @param {{type?: string|number|null, mmsi?: string|number|null,
 *   virtual?: boolean}} vessel
 * @returns {boolean}
 */
export function isAidToNavigation({ type, mmsi, virtual } = {}) {
  if (virtual === true) return true;
  const text = typeof type === 'string' ? type.trim() : String(type ?? '');
  if (text && typeNamesAid(text)) return true;
  if (mmsi === null || mmsi === undefined || mmsi === '') return false;
  return AID_MMSI.test(typeof mmsi === 'string' ? mmsi.trim() : String(mmsi));
}
