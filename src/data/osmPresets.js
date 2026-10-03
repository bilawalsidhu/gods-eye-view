/**
 * The OpenStreetMap feature kinds voice can search for ("hospitals",
 * "petrol stations", "police"), each with the exact tags it stands for.
 *
 * The server compiles Overpass queries only from these ids: a request names a
 * preset, never a tag, a regex or query text. Pure data; the browser and the
 * server both import it.
 *
 * @module data/osmPresets
 */

/**
 * id → { label (plural, spoken), terms (other ways to say it), tags: [[key, value]] }.
 * A feature matches a preset when it carries ANY of the preset's tags.
 */
const PRESETS = {
  hospital: {
    label: 'hospitals',
    terms: ['hospital', 'er', 'emergency room', 'medical center'],
    tags: [['amenity', 'hospital']],
  },
  clinic: {
    label: 'clinics',
    terms: ['clinic', 'health center', 'health post', 'medical clinic'],
    tags: [['amenity', 'clinic']],
  },
  doctors: {
    label: 'doctors',
    terms: ['doctor', "doctor's office", 'gp', 'physician'],
    tags: [['amenity', 'doctors']],
  },
  dentist: {
    label: 'dentists',
    terms: ['dentist', 'dental clinic'],
    tags: [['amenity', 'dentist']],
  },
  pharmacy: {
    label: 'pharmacies',
    terms: ['pharmacy', 'chemist', 'drugstore', 'drug store'],
    tags: [['amenity', 'pharmacy']],
  },
  school: {
    label: 'schools',
    terms: ['school', 'primary school', 'secondary school', 'high school'],
    tags: [['amenity', 'school']],
  },
  kindergarten: {
    label: 'kindergartens',
    terms: ['kindergarten', 'preschool', 'nursery school'],
    tags: [['amenity', 'kindergarten']],
  },
  university: {
    label: 'universities',
    terms: ['university', 'campus'],
    tags: [['amenity', 'university']],
  },
  college: {
    label: 'colleges',
    terms: ['college'],
    tags: [['amenity', 'college']],
  },
  library: {
    label: 'libraries',
    terms: ['library'],
    tags: [['amenity', 'library']],
  },
  police: {
    label: 'police stations',
    terms: ['police', 'police station', 'police post'],
    tags: [['amenity', 'police']],
  },
  fire_station: {
    label: 'fire stations',
    terms: ['fire station', 'fire department', 'firehouse'],
    tags: [['amenity', 'fire_station']],
  },
  prison: {
    label: 'prisons',
    terms: ['prison', 'jail', 'correctional facility'],
    tags: [['amenity', 'prison']],
  },
  courthouse: {
    label: 'courthouses',
    terms: ['courthouse', 'court'],
    tags: [['amenity', 'courthouse']],
  },
  townhall: {
    label: 'town halls',
    terms: ['town hall', 'city hall'],
    tags: [['amenity', 'townhall']],
  },
  embassy: {
    label: 'embassies',
    terms: ['embassy', 'consulate'],
    tags: [
      ['office', 'diplomatic'],
      ['amenity', 'embassy'],
    ],
  },
  post_office: {
    label: 'post offices',
    terms: ['post office'],
    tags: [['amenity', 'post_office']],
  },
  bank: { label: 'banks', terms: ['bank'], tags: [['amenity', 'bank']] },
  atm: {
    label: 'ATMs',
    terms: ['atm', 'cash machine', 'cashpoint'],
    tags: [['amenity', 'atm']],
  },
  fuel: {
    label: 'fuel stations',
    terms: [
      'gas station',
      'petrol station',
      'fuel station',
      'filling station',
      'gas',
    ],
    tags: [['amenity', 'fuel']],
  },
  charging_station: {
    label: 'EV charging stations',
    terms: ['charging station', 'ev charger', 'ev charging', 'car charger'],
    tags: [['amenity', 'charging_station']],
  },
  parking: {
    label: 'car parks',
    terms: ['parking', 'parking lot', 'car park', 'parking garage'],
    tags: [['amenity', 'parking']],
  },
  restaurant: {
    label: 'restaurants',
    terms: ['restaurant'],
    tags: [['amenity', 'restaurant']],
  },
  cafe: {
    label: 'cafés',
    terms: ['cafe', 'café', 'coffee shop', 'coffee'],
    tags: [['amenity', 'cafe']],
  },
  fast_food: {
    label: 'fast-food places',
    terms: ['fast food', 'fast-food'],
    tags: [['amenity', 'fast_food']],
  },
  bar: {
    label: 'bars',
    terms: ['bar', 'pub'],
    tags: [
      ['amenity', 'bar'],
      ['amenity', 'pub'],
    ],
  },
  place_of_worship: {
    label: 'places of worship',
    terms: [
      'place of worship',
      'church',
      'mosque',
      'temple',
      'synagogue',
      'gurdwara',
    ],
    tags: [['amenity', 'place_of_worship']],
  },
  marketplace: {
    label: 'markets',
    terms: ['market', 'marketplace', 'bazaar'],
    tags: [['amenity', 'marketplace']],
  },
  supermarket: {
    label: 'supermarkets',
    terms: ['supermarket', 'grocery store', 'grocery'],
    tags: [['shop', 'supermarket']],
  },
  mall: {
    label: 'shopping malls',
    terms: ['mall', 'shopping mall', 'shopping center', 'shopping centre'],
    tags: [['shop', 'mall']],
  },
  convenience: {
    label: 'convenience stores',
    terms: ['convenience store', 'corner shop'],
    tags: [['shop', 'convenience']],
  },
  hotel: { label: 'hotels', terms: ['hotel'], tags: [['tourism', 'hotel']] },
  hostel: {
    label: 'hostels',
    terms: ['hostel'],
    tags: [['tourism', 'hostel']],
  },
  museum: {
    label: 'museums',
    terms: ['museum'],
    tags: [['tourism', 'museum']],
  },
  attraction: {
    label: 'tourist attractions',
    terms: ['tourist attraction', 'attraction', 'sight', 'sights'],
    tags: [['tourism', 'attraction']],
  },
  viewpoint: {
    label: 'viewpoints',
    terms: ['viewpoint', 'lookout', 'scenic view'],
    tags: [['tourism', 'viewpoint']],
  },
  zoo: { label: 'zoos', terms: ['zoo'], tags: [['tourism', 'zoo']] },
  cinema: {
    label: 'cinemas',
    terms: ['cinema', 'movie theater', 'movie theatre'],
    tags: [['amenity', 'cinema']],
  },
  theatre: {
    label: 'theatres',
    terms: ['theatre', 'theater', 'playhouse'],
    tags: [['amenity', 'theatre']],
  },
  stadium: {
    label: 'stadiums',
    terms: ['stadium', 'arena'],
    tags: [['leisure', 'stadium']],
  },
  park: { label: 'parks', terms: ['park'], tags: [['leisure', 'park']] },
  playground: {
    label: 'playgrounds',
    terms: ['playground'],
    tags: [['leisure', 'playground']],
  },
  sports_centre: {
    label: 'sports centres',
    terms: ['sports center', 'sports centre', 'gym', 'leisure center'],
    tags: [
      ['leisure', 'sports_centre'],
      ['leisure', 'fitness_centre'],
    ],
  },
  cemetery: {
    label: 'cemeteries',
    terms: ['cemetery', 'graveyard'],
    tags: [
      ['landuse', 'cemetery'],
      ['amenity', 'grave_yard'],
    ],
  },
  toilets: {
    label: 'public toilets',
    terms: ['toilet', 'toilets', 'restroom', 'public toilet', 'bathroom'],
    tags: [['amenity', 'toilets']],
  },
  drinking_water: {
    label: 'drinking water points',
    terms: ['drinking water', 'water fountain', 'water point'],
    tags: [['amenity', 'drinking_water']],
  },
  shelter: {
    label: 'shelters',
    terms: ['shelter', 'emergency shelter'],
    tags: [['amenity', 'shelter']],
  },
  airport: {
    label: 'airports',
    terms: ['airport', 'airfield', 'aerodrome', 'airstrip'],
    tags: [['aeroway', 'aerodrome']],
  },
  helipad: {
    label: 'helipads',
    terms: ['helipad', 'heliport'],
    tags: [
      ['aeroway', 'helipad'],
      ['aeroway', 'heliport'],
    ],
  },
  train_station: {
    label: 'train stations',
    terms: ['train station', 'railway station', 'rail station'],
    tags: [['railway', 'station']],
  },
  bus_station: {
    label: 'bus stations',
    terms: ['bus station', 'bus terminal', 'bus depot'],
    tags: [['amenity', 'bus_station']],
  },
  ferry_terminal: {
    label: 'ferry terminals',
    terms: ['ferry terminal', 'ferry'],
    tags: [['amenity', 'ferry_terminal']],
  },
  harbour: {
    label: 'harbours',
    terms: ['harbour', 'harbor', 'port', 'marina'],
    tags: [
      ['harbour', 'yes'],
      ['leisure', 'marina'],
      ['landuse', 'port'],
    ],
  },
  bridge: {
    label: 'bridges',
    terms: ['bridge'],
    tags: [['man_made', 'bridge']],
  },
  lighthouse: {
    label: 'lighthouses',
    terms: ['lighthouse'],
    tags: [['man_made', 'lighthouse']],
  },
  water_tower: {
    label: 'water towers',
    terms: ['water tower'],
    tags: [['man_made', 'water_tower']],
  },
  power_plant: {
    label: 'power plants',
    terms: ['power plant', 'power station', 'generating station'],
    tags: [['power', 'plant']],
  },
  substation: {
    label: 'substations',
    terms: ['substation', 'electrical substation'],
    tags: [['power', 'substation']],
  },
  wind_turbine: {
    label: 'wind turbines',
    terms: ['wind turbine', 'windmill'],
    tags: [['generator:source', 'wind']],
  },
  dam: { label: 'dams', terms: ['dam'], tags: [['waterway', 'dam']] },
  military: {
    label: 'military sites',
    terms: ['military base', 'military site', 'base', 'barracks'],
    tags: [
      ['landuse', 'military'],
      ['military', 'base'],
      ['military', 'barracks'],
    ],
  },
  peak: {
    label: 'peaks',
    terms: ['peak', 'mountain peak', 'summit', 'mountain'],
    tags: [['natural', 'peak']],
  },
  waterfall: {
    label: 'waterfalls',
    terms: ['waterfall', 'falls'],
    tags: [['waterway', 'waterfall']],
  },
};

/** Frozen preset table. */
export const OSM_PRESETS = Object.freeze(
  Object.fromEntries(
    Object.entries(PRESETS).map(([id, preset]) => [
      id,
      Object.freeze({
        id,
        label: preset.label,
        terms: Object.freeze([...preset.terms]),
        tags: Object.freeze(
          preset.tags.map((pair) => Object.freeze([...pair])),
        ),
      }),
    ]),
  ),
);

/** Every preset id, for tool enums. */
export const OSM_PRESET_IDS = Object.freeze(Object.keys(OSM_PRESETS));

const normalize = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Naive singular: "pharmacies" → "pharmacy", "hospitals" → "hospital". */
function singular(word) {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}
const singularPhrase = (text) => text.split(' ').map(singular).join(' ');

const TERM_INDEX = (() => {
  const index = new Map();
  for (const preset of Object.values(OSM_PRESETS)) {
    for (const term of [
      preset.id.replace(/_/g, ' '),
      singularPhrase(normalize(preset.label)),
      ...preset.terms,
    ]) {
      const key = singularPhrase(normalize(term));
      if (key && !index.has(key)) index.set(key, preset.id);
    }
  }
  return index;
})();

/**
 * The preset a spoken phrase names ("all the hospitals" → hospital), or null.
 * An exact preset id wins; otherwise the longest known term found in the
 * phrase.
 * @param {string} phrase
 * @returns {object|null} A preset.
 */
export function matchOsmPreset(phrase) {
  const raw = String(phrase || '').trim();
  if (Object.hasOwn(OSM_PRESETS, raw)) return OSM_PRESETS[raw];
  const text = singularPhrase(
    normalize(raw).replace(/^(all|every|the|any)( the)? /, ''),
  );
  if (!text) return null;
  if (TERM_INDEX.has(text)) return OSM_PRESETS[TERM_INDEX.get(text)];
  let best = null;
  for (const [term, id] of TERM_INDEX) {
    if (term.length < 3) continue;
    if (!new RegExp(`(^| )${term}( |$)`).test(text)) continue;
    if (!best || term.length > best.term.length) best = { term, id };
  }
  return best ? OSM_PRESETS[best.id] : null;
}
