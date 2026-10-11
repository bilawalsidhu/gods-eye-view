/**
 * Keyless Wikidata lookup for an aircraft type's dossier.
 *
 * Wikidata has no ICAO type-designator property, so the feed's type text
 * (e.g. "Boeing 737-8AS" or "B738") is resolved through English Wikipedia's
 * search to the linked Wikidata item, then that item's claims (falling back to
 * its parent family for gaps) give dimensions, engines, weights, capacity,
 * service dates and production. The safety line counts fatal accidents that
 * Wikidata links to the type through "item operated" (P121), which is a
 * best-effort lower bound: many accidents link only to the individual airframe.
 *
 * Uses the MediaWiki Action APIs with `origin=*` (CORS) rather than the query
 * service, every request has a deadline and a body cap, and answers are
 * cached per type text.
 */
import {
  claimsOf,
  commonsImage,
  createCachedLookup,
  createWikidataClient,
  decimal,
  formatRange,
  groupInteger,
  itemIds,
  range,
  quantities as readQuantities,
  strings,
} from './wikidataClient.js';

export {
  WIKIDATA_API,
  WIKIPEDIA_API,
  commonsThumbnailUrl,
} from './wikidataClient.js';
export const AIRCRAFT_WIKIDATA_CLIENT_ID =
  'GodsEyeView/aircraft (https://github.com/robarbms/gods-eye-view)';
const CACHE_LIMIT = 64;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 30 * 60 * 1000;
const SEARCH_CANDIDATES = 4;
const MAX_ACCIDENTS = 50;
const MAX_SEARCHES = 3;

/** Wikidata items that mark an aircraft model or family. */
const AIRCRAFT_CLASSES = new Set([
  'Q15056993', // aircraft family
  'Q15056995', // aircraft model
  'Q11436', // aircraft
  'Q197', // airplane
]);

const P = {
  instanceOf: 'P31',
  subclassOf: 'P279',
  use: 'P366',
  manufacturer: 'P176',
  poweredBy: 'P516',
  quantity: 'P1114',
  wingspan: 'P2050',
  length: 'P2043',
  height: 'P2048',
  mass: 'P2067',
  capacity: 'P1083',
  cruise: 'P2217',
  range: 'P2073',
  ceiling: 'P2254',
  firstFlight: 'P606',
  serviceEntry: 'P729',
  serviceRetirement: 'P730',
  produced: 'P1092',
  stallSpeed: 'P6510',
  wingArea: 'P2112',
  payload: 'P4519',
  power: 'P2109',
  speed: 'P2052',
  deaths: 'P1120',
  operated: 'P121',
  image: 'P18',
  operator: 'P137',
  countryOfOrigin: 'P495',
  militaryDesignation: 'P798',
};

/** Operators named in the dossier; the rest are summarised as "+N more". */
const MAX_OPERATORS = 4;

/**
 * Statement roles, read from the "object of statement has role" (P3831) or
 * "criterion used" (P1013) qualifier, that split one generic property
 * (speed P2052, mass P2067, payload P4519) into distinct figures.
 */
const ROLE = {
  maxTakeoffWeight: 'Q938476',
  normalTakeoffWeight: 'Q1434070',
  loadedWeight: 'Q21023768',
  emptyWeight: 'Q6753082',
  manufacturersEmptyWeight: 'Q25304553',
  cruise: 'Q2063640',
  cruisingSpeed: 'Q115155589',
  neverExceed: 'Q11830531',
  maxSpeedOfAircraft: 'Q11830539',
  maxSpeed: 'Q11830537',
  rateOfClimb: 'Q1141401',
  bombload: 'Q113189684',
  record: 'Q1241356',
};
const anyOf =
  (...roles) =>
  (role) =>
    roles.includes(role);

/**
 * Normalize feed type text into a search phrase and cache key.
 * @param {string} text Type name or ICAO designator.
 * @returns {string}
 */
export function normalizeAircraftType(text) {
  return String(text ?? '')
    .replace(/[^\p{L}\p{N}\s\-/.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Search phrases for a type, most specific first: feed text often carries a
 * customer/variant suffix ("Airbus A321 251NXSL", "Boeing 737-8AS") that
 * Wikipedia's search cannot match, so retry with trailing tokens dropped.
 * @param {string} phrase Normalized type text.
 * @returns {string[]} Up to {@link MAX_SEARCHES} distinct phrases.
 */
export function aircraftSearchPhrases(phrase) {
  const tokens = normalizeAircraftType(phrase).split(' ').filter(Boolean);
  const phrases = [];
  const add = (text) => {
    if (text && !phrases.includes(text)) phrases.push(text);
  };
  add(tokens.join(' '));
  const last = tokens.at(-1) || '';
  // "737-8AS" → "737": keep the model number, drop the customer code.
  if (tokens.length > 1 && /^[\p{L}\p{N}]+-[\p{L}\p{N}]+$/u.test(last))
    add([...tokens.slice(0, -1), last.split('-')[0]].join(' '));
  for (let n = tokens.length - 1; n >= 2; n -= 1)
    add(tokens.slice(0, n).join(' '));
  return phrases.slice(0, MAX_SEARCHES);
}

const quantities = (entity, property, acceptRole = null) =>
  readQuantities(entity, property, acceptRole);

function earliestYear(entity, property) {
  let best = null;
  for (const claim of claimsOf(entity, property)) {
    const match = /^([+-]\d+)-/.exec(
      claim.mainsnak.datavalue.value?.time || '',
    );
    const year = match ? Number(match[1]) : NaN;
    if (Number.isFinite(year) && (best === null || year < best)) best = year;
  }
  return best;
}

function latestYear(entity, property) {
  let best = null;
  for (const claim of claimsOf(entity, property)) {
    const match = /^([+-]\d+)-/.exec(
      claim.mainsnak.datavalue.value?.time || '',
    );
    const year = match ? Number(match[1]) : NaN;
    if (Number.isFinite(year) && (best === null || year > best)) best = year;
  }
  return best;
}

const rangeIn = (values, unit) =>
  range(values.filter((entry) => entry.unit === unit));

/** Drops sub-100 kg masses, which are decimal-separator slips ("61.000" kg). */
const MIN_AIRCRAFT_MASS_KG = 100;
const massRange = (values) =>
  rangeIn(
    values.filter((entry) => entry.value >= MIN_AIRCRAFT_MASS_KG),
    'kg',
  );

/** Airspeed as km/h and/or Mach ranges; null when neither is stated. */
function airspeed(values) {
  const kmh = rangeIn(values, 'km/h');
  const mach = rangeIn(values, 'mach');
  return kmh || mach ? { kmh, mach } : null;
}

/** Rate of climb in m/s (Wikidata's m/s values arrive here as km/h). */
function climbRate(values) {
  return range(
    values
      .filter((entry) => entry.unit === 'm/s' || entry.unit === 'km/h')
      .map((entry) =>
        entry.unit === 'km/h'
          ? { value: entry.value / 3.6, unit: 'm/s' }
          : entry,
      ),
  );
}

/**
 * Is this Wikidata entity an aircraft type (not a list, airline or crash)?
 * @param {object} entity Wikidata entity JSON.
 * @returns {boolean}
 */
export function isAircraftEntity(entity) {
  if (!entity?.claims) return false;
  if (itemIds(entity, P.instanceOf).some((id) => AIRCRAFT_CLASSES.has(id)))
    return true;
  return (
    itemIds(entity, P.manufacturer).length > 0 &&
    (claimsOf(entity, P.wingspan).length > 0 ||
      claimsOf(entity, P.firstFlight).length > 0 ||
      claimsOf(entity, P.poweredBy).length > 0)
  );
}

/**
 * Pull the dossier facts from a type entity, filling gaps from its parents.
 * @param {object} entity Wikidata entity JSON for the resolved type.
 * @param {object[]} [parents] Parent (P279) aircraft entities.
 * @returns {object} Raw facts; item references are QIDs for labelling.
 */
export function extractAircraftFacts(entity, parents = []) {
  const chain = [entity, ...parents.filter(isAircraftEntity)];
  const first = (read) => {
    for (const item of chain) {
      const value = read(item);
      if (
        value !== null &&
        value !== undefined &&
        !(Array.isArray(value) && !value.length)
      )
        return value;
    }
    return null;
  };
  const engines = first((item) =>
    claimsOf(item, P.poweredBy)
      .map((claim) => {
        const count = Number(
          claim.qualifiers?.[P.quantity]?.[0]?.datavalue?.value?.amount,
        );
        return {
          id: claim.mainsnak.datavalue.value?.id,
          count: Number.isFinite(count) && count > 0 ? count : null,
        };
      })
      .filter((engine) => typeof engine.id === 'string'),
  );
  // Role classes ("narrow-body airliner", "utility helicopter") live in P279
  // and P366, sometimes only on the parent family; skip aircraft parents.
  const skip = new Set(chain.map((item) => item?.id).filter(Boolean));
  const classes = [
    ...new Set(
      chain.flatMap((item) => [
        ...itemIds(item, P.subclassOf),
        ...itemIds(item, P.use),
      ]),
    ),
  ].filter((id) => !skip.has(id));
  return {
    id: entity?.id || null,
    label: entity?.labels?.en?.value || null,
    classes: classes.slice(0, 12),
    image: first((item) => strings(item, P.image)[0] || null),
    operators: first((item) => itemIds(item, P.operator)) || [],
    countries: first((item) => itemIds(item, P.countryOfOrigin)) || [],
    militaryDesignations: strings(entity, P.militaryDesignation),
    manufacturer: first((item) => itemIds(item, P.manufacturer)[0] || null),
    engines: engines || [],
    wingspan: first((item) => range(quantities(item, P.wingspan))),
    length: first((item) => range(quantities(item, P.length))),
    height: first((item) => range(quantities(item, P.height))),
    wingArea: first((item) => rangeIn(quantities(item, P.wingArea), 'm²')),
    // Prefer an explicit maximum take-off weight; otherwise unqualified or
    // loaded figures, never empty or landing weights.
    mass: first(
      (item) =>
        massRange(quantities(item, P.mass, anyOf(ROLE.maxTakeoffWeight))) ||
        massRange(
          quantities(
            item,
            P.mass,
            anyOf(null, ROLE.normalTakeoffWeight, ROLE.loadedWeight),
          ),
        ),
    ),
    emptyWeight: first((item) =>
      massRange(
        quantities(
          item,
          P.mass,
          anyOf(ROLE.emptyWeight, ROLE.manufacturersEmptyWeight),
        ),
      ),
    ),
    payload: first((item) =>
      rangeIn(
        quantities(
          item,
          P.payload,
          (role) => role !== ROLE.bombload && role !== ROLE.record,
        ),
        'kg',
      ),
    ),
    bombLoad: first((item) =>
      rangeIn(quantities(item, P.payload, anyOf(ROLE.bombload)), 'kg'),
    ),
    capacity: first((item) => rangeIn(quantities(item, P.capacity), '')),
    cruise: first((item) =>
      airspeed([
        ...quantities(item, P.cruise),
        ...quantities(item, P.speed, anyOf(ROLE.cruise, ROLE.cruisingSpeed)),
      ]),
    ),
    // Unqualified P2052 speeds on aircraft are top speeds.
    maxSpeed: first((item) =>
      airspeed(
        quantities(
          item,
          P.speed,
          anyOf(null, ROLE.maxSpeedOfAircraft, ROLE.maxSpeed),
        ),
      ),
    ),
    neverExceed: first((item) =>
      airspeed(quantities(item, P.speed, anyOf(ROLE.neverExceed))),
    ),
    stallSpeed: first((item) => airspeed(quantities(item, P.stallSpeed))),
    climb: first((item) =>
      climbRate(quantities(item, P.speed, anyOf(ROLE.rateOfClimb))),
    ),
    power: first((item) => rangeIn(quantities(item, P.power), 'kW')),
    range: first((item) => rangeIn(quantities(item, P.range), 'km')),
    ceiling: first((item) => rangeIn(quantities(item, P.ceiling), 'm')),
    firstFlight: first((item) => earliestYear(item, P.firstFlight)),
    serviceEntry: first((item) => earliestYear(item, P.serviceEntry)),
    serviceRetirement: latestYear(entity, P.serviceRetirement),
    // Production counts belong to the exact item; a parent's total would
    // overstate a single variant.
    produced: range(quantities(entity, P.produced)),
  };
}

/**
 * Sum the fatal accidents Wikidata links to the type.
 * @param {object[]} accidents Accident entities.
 * @param {number} total Search hit count (may exceed the fetched page).
 * @returns {{accidents: number, deaths: number}}
 */
export function summarizeAccidents(accidents, total = accidents.length) {
  let deaths = 0;
  for (const accident of accidents) {
    const values = quantities(accident, P.deaths).map((entry) => entry.value);
    if (values.length) deaths += Math.max(...values);
  }
  return {
    accidents: Math.max(total, accidents.length),
    deaths: Math.round(deaths),
  };
}

const METRES = { format: decimal, unit: 'm' };
const FEET = { format: (value) => groupInteger(value / 0.3048), unit: 'ft' };
const TONNES = { format: (value) => decimal(value / 1000), unit: 't' };
const POUNDS = {
  format: (value) => groupInteger(value / 0.45359237),
  unit: 'lb',
};
const KMH = { format: groupInteger, unit: 'km/h' };
const KNOTS = { format: (value) => groupInteger(value / 1.852), unit: 'kt' };
const KM = { format: groupInteger, unit: 'km' };
const NMI = { format: (value) => groupInteger(value / 1.852), unit: 'nmi' };
const COUNT = { format: groupInteger, unit: '' };
const SQ_METRES = { format: decimal, unit: 'm²' };
const SQ_FEET = {
  format: (value) => groupInteger(value / 0.09290304),
  unit: 'ft²',
};
const METRES_PER_SECOND = { format: decimal, unit: 'm/s' };
const FEET_PER_MINUTE = {
  format: (value) => groupInteger(value / 0.00508),
  unit: 'ft/min',
};
const KILOWATTS = { format: groupInteger, unit: 'kW' };
const HORSEPOWER = {
  format: (value) => groupInteger(value / 0.745699872),
  unit: 'hp',
};
const machNumber = (value) => String(Number(value.toFixed(2)));

/** "903 km/h (488 kt) · Mach 0.82", either part optional. */
function formatAirspeed(speed) {
  if (!speed) return null;
  const parts = [];
  if (speed.kmh) parts.push(formatRange(speed.kmh, KMH, KNOTS));
  if (speed.mach) {
    const { min, max } = speed.mach;
    parts.push(
      `Mach ${Math.abs(max - min) < 1e-9 ? machNumber(max) : `${machNumber(min)}–${machNumber(max)}`}`,
    );
  }
  return parts.join(' · ') || null;
}

/** Broad categories, highest priority first, matched against class labels. */
const AIRCRAFT_CATEGORIES = [
  {
    name: 'Helicopter',
    pattern: /helicopter|rotorcraft|gyroplane|autogyro|tiltrotor/i,
    military: true,
  },
  {
    name: 'Drone',
    pattern: /unmanned|\bdrone\b|\buav\b/i,
    military: true,
  },
  {
    name: 'Military aircraft',
    pattern:
      /military|fighter|interceptor|bomber|attack aircraft|tanker|airlift|reconnaissance|maritime patrol|early warning|electronic warfare/i,
  },
  { name: 'Regional airliner', pattern: /regional (?:airliner|jet)|commuter/i },
  {
    name: 'Commercial airliner',
    pattern: /airliner|commercial aviation|passenger aircraft/i,
  },
  { name: 'Cargo aircraft', pattern: /cargo|freighter/i },
  { name: 'Business aircraft', pattern: /business jet|executive|bizjet/i },
  { name: 'Trainer aircraft', pattern: /trainer/i },
  {
    name: 'Light / utility aircraft',
    pattern:
      /utility aircraft|light aircraft|general aviation|sport aircraft|ultralight|bush plane/i,
  },
  { name: 'Glider', pattern: /glider|sailplane/i },
  { name: 'Airship / balloon', pattern: /airship|balloon|blimp/i },
];
const MILITARY = AIRCRAFT_CATEGORIES[2].pattern;

/**
 * Pick a broad aircraft category from Wikidata class labels.
 * @param {string[]} labels Class labels in claim order.
 * @returns {{category: string, detail: string|null}|null}
 */
export function classifyAircraft(labels) {
  const names = (labels || []).filter(
    (label) => typeof label === 'string' && label.trim(),
  );
  if (!names.length) return null;
  for (const { name, pattern, military } of AIRCRAFT_CATEGORIES) {
    const matches = names.filter((label) => pattern.test(label));
    if (!matches.length) continue;
    const category =
      military && names.some((label) => MILITARY.test(label))
        ? `Military ${name.toLowerCase()}`
        : name;
    const detail =
      matches.find(
        (label) => !category.toLowerCase().includes(label.toLowerCase()),
      ) || null;
    return { category, detail };
  }
  const [firstLabel] = names;
  return {
    category: firstLabel[0].toUpperCase() + firstLabel.slice(1),
    detail: null,
  };
}

/**
 * Turn facts, labels and the safety summary into display lines.
 * @param {object} facts From {@link extractAircraftFacts}.
 * @param {Map<string, string>|object} [labels] QID → English label.
 * @param {{accidents: number, deaths: number}|null} [safety]
 * @returns {{label: string, value: string}[]}
 */
export function formatAircraftDossier(
  facts,
  labels = new Map(),
  safety = null,
) {
  const labelOf = (id) =>
    (labels instanceof Map ? labels.get(id) : labels?.[id]) || null;
  const lines = [];
  const push = (label, value) => {
    if (value) lines.push({ label, value });
  };
  push('Model', facts.label);
  const kind = classifyAircraft((facts.classes || []).map(labelOf));
  push('Type', kind?.category);
  push('Class', kind?.detail);
  push(
    'Origin',
    (facts.countries || []).map(labelOf).filter(Boolean).join(' / '),
  );
  push(
    'Designation',
    [...new Set(facts.militaryDesignations || [])].slice(0, 4).join(', '),
  );
  push('Maker', labelOf(facts.manufacturer));
  const engines = facts.engines
    .map((engine) => {
      const name = labelOf(engine.id);
      if (!name) return null;
      return engine.count ? `${engine.count} × ${name}` : name;
    })
    .filter(Boolean);
  push(
    'Engines',
    engines.length
      ? `${engines.slice(0, 3).join(' / ')}${engines.length > 3 ? ' …' : ''}`
      : null,
  );
  const dimension = (span) =>
    span?.unit === 'm' ? formatRange(span, METRES, FEET) : null;
  push('Wingspan', dimension(facts.wingspan));
  push('Length', dimension(facts.length));
  push('Height', dimension(facts.height));
  if (facts.wingArea?.unit === 'm²')
    push('Wing area', formatRange(facts.wingArea, SQ_METRES, SQ_FEET));
  const weight = (span) =>
    span?.unit === 'kg' ? formatRange(span, TONNES, POUNDS) : null;
  push('Gross weight', weight(facts.mass));
  push('Empty weight', weight(facts.emptyWeight));
  push('Payload', weight(facts.payload));
  push('Bomb load', weight(facts.bombLoad));
  if (facts.capacity?.unit === '')
    push('Passengers', formatRange(facts.capacity, COUNT));
  push('Cruise', formatAirspeed(facts.cruise));
  push('Max speed', formatAirspeed(facts.maxSpeed));
  push('Never exceed', formatAirspeed(facts.neverExceed));
  push('Stall speed', formatAirspeed(facts.stallSpeed));
  if (facts.climb?.unit === 'm/s')
    push(
      'Climb rate',
      formatRange(facts.climb, METRES_PER_SECOND, FEET_PER_MINUTE),
    );
  if (facts.power?.unit === 'kW')
    push('Power', formatRange(facts.power, KILOWATTS, HORSEPOWER));
  if (facts.range?.unit === 'km')
    push('Range', formatRange(facts.range, KM, NMI));
  push('Ceiling', dimension(facts.ceiling));
  push('First flight', facts.firstFlight ? String(facts.firstFlight) : null);
  if (facts.serviceEntry || facts.serviceRetirement)
    push(
      'In service',
      `${facts.serviceEntry ?? '?'} – ${facts.serviceRetirement ?? 'present'}`,
    );
  push('Built', facts.produced ? groupInteger(facts.produced.max) : null);
  const operators = (facts.operators || [])
    .map(labelOf)
    .filter(Boolean)
    .slice(0, MAX_OPERATORS);
  const moreOperators = (facts.operators || []).length - operators.length;
  push(
    'Operators',
    operators.length
      ? `${operators.join(', ')}${moreOperators > 0 ? ` +${moreOperators} more` : ''}`
      : null,
  );
  if (safety)
    push(
      'Safety',
      safety.accidents
        ? `${safety.accidents} fatal accident${safety.accidents === 1 ? '' : 's'} · ${groupInteger(safety.deaths)} deaths (Wikidata-linked)`
        : 'No fatal accidents linked on Wikidata',
    );
  return lines;
}

/**
 * Create the cached aircraft dossier source.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @returns {{lookup: (type: string, options?: {signal?: AbortSignal}) =>
 *   Promise<{id: string, title: string, lines: {label: string,
 *   value: string}[]}|null>}}
 */
export function createAircraftWikidataSource({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Aircraft Wikidata source requires fetch');
  const { getEntities, getLabels, searchWikipedia, searchStatements } =
    createWikidataClient({ fetchImpl, clientId: AIRCRAFT_WIKIDATA_CLIENT_ID });

  async function resolveCandidates(phrase, signal) {
    const pages = await searchWikipedia(
      `${phrase} aircraft`,
      SEARCH_CANDIDATES,
      signal,
    );
    return pages
      .filter((page) => !/^List of /i.test(page.title))
      .map((page) => page.id);
  }

  async function safetyFor(ids, signal) {
    const operated = ids.map((id) => `${P.operated}=${id}`).join('|');
    const { ids: hits, total } = await searchStatements(
      `haswbstatement:${P.deaths} haswbstatement:${operated}`,
      MAX_ACCIDENTS,
      signal,
    );
    const accidents = Object.values(await getEntities(hits, 'claims', signal));
    return summarizeAccidents(accidents, total);
  }

  async function resolveEntity(phrase, signal) {
    for (const attempt of aircraftSearchPhrases(phrase)) {
      const candidates = await resolveCandidates(attempt, signal);
      if (!candidates.length) continue;
      const entities = await getEntities(candidates, 'labels|claims', signal);
      const id = candidates.find((qid) => isAircraftEntity(entities[qid]));
      if (id) return entities[id];
    }
    return null;
  }

  async function load(phrase, signal) {
    const entity = await resolveEntity(phrase, signal);
    if (!entity?.id) return null;
    const id = entity.id;
    const parentIds = itemIds(entity, P.subclassOf).slice(0, 3);
    const parents = Object.values(
      await getEntities(parentIds, 'labels|claims', signal),
    );
    const facts = extractAircraftFacts(entity, parents);
    const referenced = [
      facts.manufacturer,
      ...facts.engines.map((engine) => engine.id),
      ...facts.classes,
      ...facts.countries,
      ...facts.operators.slice(0, MAX_OPERATORS),
    ];
    // Sequential on purpose: Wikimedia throttles bursts from one client.
    const labels = await getLabels(referenced, signal);
    const safety = await safetyFor(
      [id, ...parents.filter(isAircraftEntity).map((parent) => parent.id)],
      signal,
    ).catch((error) => {
      if (signal.aborted) throw error;
      return null;
    });
    return {
      id,
      title: facts.label || phrase,
      image: commonsImage(facts.image),
      lines: formatAircraftDossier(facts, labels, safety),
    };
  }

  /**
   * Look up a type's dossier; resolves null when nothing matches.
   * @param {string} type Feed type name or ICAO designator.
   * @param {{signal?: AbortSignal}} [options]
   */
  const cachedLoad = createCachedLookup({
    load,
    now,
    limit: CACHE_LIMIT,
    ttlMs: CACHE_TTL_MS,
    missTtlMs: NOT_FOUND_TTL_MS,
  });

  async function lookup(type, { signal } = {}) {
    const phrase = normalizeAircraftType(type);
    if (!phrase) return null;
    return cachedLoad(phrase.toLowerCase(), signal, phrase);
  }

  return { lookup };
}
