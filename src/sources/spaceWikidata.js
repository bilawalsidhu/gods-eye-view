/**
 * Keyless Wikidata lookups for the Space Missions dossier.
 *
 * Satellites are matched exactly by NORAD catalog number (P377) through
 * Wikidata's statement search; when no item carries that number (most
 * mega-constellation spacecraft) the catalog name falls back to an English
 * Wikipedia search that only accepts spacecraft and constellations, flagged
 * as a name match. Launches resolve the rocket configuration through
 * Wikipedia's search (accepting only rocket models, series and families,
 * gaps filled from the parent family) and, when Launch Library names one, the
 * mission itself (accepted only when it is a spaceflight launched within a
 * year of this launch, so a reused name never matches an older mission).
 */
import {
  claimsOf,
  commonsImage,
  createCachedLookup,
  createWikidataClient,
  decimal,
  formatDate,
  formatRange,
  groupInteger,
  itemIds,
  labelList,
  quantities,
  range,
  strings,
  times,
} from './wikidataClient.js';

export const SPACE_WIKIDATA_CLIENT_ID =
  'GodsEyeView/space (https://github.com/robarbms/gods-eye-view)';
const CACHE_LIMIT = 96;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 30 * 60 * 1000;
const SEARCH_CANDIDATES = 4;
const MAX_LISTED = 4;
const MAX_PARENTS = 2;

const P = {
  instanceOf: 'P31',
  subclassOf: 'P279',
  partOf: 'P361',
  hasParts: 'P527',
  manufacturer: 'P176',
  operator: 'P137',
  countryOfOrigin: 'P495',
  launchDate: 'P619',
  launchVehicle: 'P375',
  launchSite: 'P1427',
  launchContractor: 'P1079',
  cospar: 'P247',
  norad: 'P377',
  mass: 'P2067',
  length: 'P2043',
  width: 'P2049',
  height: 'P2048',
  diameter: 'P2386',
  orbitType: 'P522',
  periapsis: 'P2244',
  apoapsis: 'P2243',
  inclination: 'P2045',
  period: 'P2146',
  orbits: 'P1418',
  instruments: 'P1202',
  crew: 'P1029',
  bus: 'P707',
  poweredBy: 'P516',
  firstFlight: 'P606',
  serviceEntry: 'P729',
  serviceRetirement: 'P730',
  decay: 'P621',
  image: 'P18',
};

/** Rocket models, series, families and launch-vehicle classes. */
const ROCKET_CLASSES = new Set([
  'Q110055303', // rocket model
  'Q111722634', // rocket series
  'Q109542585', // rocket family
  'Q697175', // launch vehicle
  'Q15078724', // expendable launch vehicle
  'Q22908850', // small-lift launch vehicle
  'Q22906832', // medium-lift launch vehicle
  'Q11222716', // heavy-lift launch vehicle
  'Q23759442', // super heavy-lift launch vehicle
  'Q30128', // reusable launch vehicle
]);

/** Spacecraft and spaceflight classes a satellite or mission can belong to. */
const SPACECRAFT_CLASSES = new Set([
  'Q40218', // spacecraft
  'Q26540', // artificial satellite
  'Q12832168', // artificial satellite of the Earth
  'Q25956', // space station
  'Q26529', // space probe
  'Q1378139', // robotic spacecraft
  'Q402330', // cargo spacecraft
  'Q7217761', // crewed spacecraft
  'Q148578', // space telescope
  'Q752783', // human spaceflight
  'Q2133344', // space mission
]);
const CONSTELLATIONS = new Set([
  'Q967145', // satellite constellation
  'Q54806917', // satellite internet constellation
]);

/** Launch-vehicle classes, ordered so the lift class wins over "expendable". */
const LIFT_CLASSES = [
  ['Q23759442', 'Super heavy-lift launch vehicle'],
  ['Q11222716', 'Heavy-lift launch vehicle'],
  ['Q22906832', 'Medium-lift launch vehicle'],
  ['Q22908850', 'Small-lift launch vehicle'],
];
const REUSABLE = 'Q30128';
/** Series and families list their variants, not stages, under "has parts". */
const VARIANT_PARENTS = new Set(['Q111722634', 'Q109542585']);

/** Sanity bands that drop unit slips (Falcon 9's diameter is "3.7 miles"). */
const ROCKET_DIAMETER_M = [0.2, 20];
const ROCKET_HEIGHT_M = [2, 200];
const SPACECRAFT_DIMENSION_M = [0.01, 500];

/**
 * Reduce a catalog satellite name to a search phrase ("STARLINK-1007" →
 * "Starlink", "NOAA 20 (JPSS-1)" → "NOAA 20").
 * @param {string} name
 * @returns {string}
 */
export function satelliteSearchPhrase(name) {
  const text = String(name ?? '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s\-/.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  // Hyphen-serialled constellation members: keep the family name only.
  const serial = /^([\p{L}][\p{L}\s]*?)-\d+[\p{L}\d-]*$/u.exec(text);
  const phrase = serial && serial[1].length >= 3 ? serial[1] : text;
  return phrase
    .toLowerCase()
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
    .replace(/\b(Iss|Noaa|Goes|Gps|Iridium Next)\b/g, (word) =>
      word.toUpperCase(),
    )
    .slice(0, 80);
}

/**
 * Rocket search phrase from Launch Library's configuration name.
 * @param {string} rocket e.g. "Falcon 9 Block 5" or "Soyuz 2.1b/Fregat-M".
 * @returns {string}
 */
export function rocketSearchPhrase(rocket) {
  return String(rocket ?? '')
    .split('|')[0]
    .replace(/[^\p{L}\p{N}\s\-/.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

const classIds = (entity) => [
  ...itemIds(entity, P.instanceOf),
  ...itemIds(entity, P.subclassOf),
];

/**
 * Is this entity a launch vehicle model, series or family?
 * @param {object} entity Wikidata entity JSON.
 */
export function isRocketEntity(entity) {
  return classIds(entity).some((id) => ROCKET_CLASSES.has(id));
}

/**
 * Is this entity a spacecraft or spaceflight (not a list, pad or rocket)?
 * @param {object} entity Wikidata entity JSON.
 */
export function isSpacecraftEntity(entity) {
  if (!entity?.claims || isRocketEntity(entity)) return false;
  if (itemIds(entity, P.instanceOf).some((id) => SPACECRAFT_CLASSES.has(id)))
    return true;
  return (
    claimsOf(entity, P.launchDate).length > 0 ||
    strings(entity, P.cospar).length > 0 ||
    claimsOf(entity, P.crew).length > 0
  );
}

const isConstellation = (entity) =>
  itemIds(entity, P.instanceOf).some((id) => CONSTELLATIONS.has(id));

const nameTokens = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Does one of the entity's English names contain every token of `name`?
 * ("Crew-9" matches "SpaceX Crew-9"; "Starlink Group 10-12" does not match
 * "Starship Flight 14".)
 */
export function namesMatch(entity, name) {
  const wanted = nameTokens(name);
  if (!wanted.length) return false;
  const names = [
    entity?.labels?.en?.value,
    ...(entity?.aliases?.en || []).map((alias) => alias?.value),
  ].filter(Boolean);
  return names.some((candidate) => {
    const have = new Set(nameTokens(candidate));
    return wanted.every((token) => have.has(token));
  });
}

/**
 * Would this mission entity plausibly be the given launch? It must be a
 * spaceflight named like the mission and, when dated, launched within a year.
 * @param {object} entity
 * @param {string} missionName
 * @param {number|null} launchYear
 */
export function isMatchingMission(entity, missionName, launchYear) {
  if (!isSpacecraftEntity(entity) || !namesMatch(entity, missionName))
    return false;
  const launched = times(entity, P.launchDate);
  if (!launched.length || !Number.isFinite(launchYear)) return true;
  return launched.some((date) => Math.abs(date.year - launchYear) <= 1);
}

const within =
  ([min, max]) =>
  (entry) =>
    entry.unit === 'm' && entry.value >= min && entry.value <= max;

const maxOf = (values) =>
  values.length ? Math.max(...values.map((entry) => entry.value)) : null;

/** Statement-ordered labels to fetch, deduplicated. */
function referencedIds(facts) {
  return [
    ...facts.types,
    ...facts.operators.slice(0, MAX_LISTED),
    ...facts.makers.slice(0, 2),
    ...facts.countries,
    ...(facts.parts || []).slice(0, MAX_LISTED),
    ...(facts.engines || []).slice(0, 2),
    ...(facts.launchVehicles || []).slice(0, 2),
    ...(facts.launchSites || []).slice(0, 1),
    ...(facts.orbitTypes || []).slice(0, 2),
    ...(facts.instruments || []).slice(0, MAX_LISTED),
    ...(facts.crew || []).slice(0, MAX_LISTED),
    ...(facts.bus || []).slice(0, 1),
    ...(facts.partOf || []).slice(0, 1),
  ];
}

/**
 * Pull satellite or mission facts from a spacecraft entity.
 * @param {object} entity
 * @returns {object} Raw facts; item references are QIDs for labelling.
 */
export function extractSpacecraftFacts(entity) {
  const dims = (property) =>
    quantities(entity, property).filter(within(SPACECRAFT_DIMENSION_M));
  return {
    id: entity.id,
    label: entity.labels?.en?.value || null,
    types: itemIds(entity, P.instanceOf).slice(0, 2),
    operators: itemIds(entity, P.operator),
    makers: itemIds(entity, P.manufacturer),
    countries: itemIds(entity, P.countryOfOrigin).slice(0, 2),
    launched: times(entity, P.launchDate)[0] || null,
    launchVehicles: itemIds(entity, P.launchVehicle),
    launchSites: itemIds(entity, P.launchSite),
    cospar: strings(entity, P.cospar)[0] || null,
    norad: strings(entity, P.norad)[0] || null,
    mass: range(quantities(entity, P.mass).filter((v) => v.unit === 'kg')),
    length: maxOf(dims(P.length)),
    width: maxOf(dims(P.width)),
    height: maxOf(dims(P.height)),
    diameter: maxOf(dims(P.diameter)),
    orbitTypes: itemIds(entity, P.orbitType),
    periapsis: range(
      quantities(entity, P.periapsis).filter((v) => v.unit === 'km'),
    ),
    apoapsis: range(
      quantities(entity, P.apoapsis).filter((v) => v.unit === 'km'),
    ),
    inclination: range(
      quantities(entity, P.inclination).filter((v) => v.unit === 'deg'),
    ),
    period: range(quantities(entity, P.period).filter((v) => v.unit === 'min')),
    orbits: maxOf(quantities(entity, P.orbits).filter((v) => v.unit === '')),
    instruments: itemIds(entity, P.instruments),
    crew: itemIds(entity, P.crew),
    bus: itemIds(entity, P.bus),
    partOf: itemIds(entity, P.partOf),
    serviceEntry: times(entity, P.serviceEntry)[0] || null,
    retired: times(entity, P.serviceRetirement).at(-1) || null,
    decay: times(entity, P.decay).at(-1) || null,
    image: strings(entity, P.image)[0] || null,
  };
}

/**
 * Pull rocket facts, filling gaps from parent rocket families.
 * @param {object} entity Resolved rocket entity.
 * @param {object[]} [parents] Parent (P279) entities.
 */
export function extractRocketFacts(entity, parents = []) {
  const chain = [entity, ...parents.filter(isRocketEntity)];
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
    return Array.isArray(read(entity)) ? [] : null;
  };
  const allClasses = new Set(chain.flatMap(classIds));
  const lift = LIFT_CLASSES.find(([id]) => allClasses.has(id));
  return {
    id: entity.id,
    ids: chain.map((item) => item.id),
    label: entity.labels?.en?.value || null,
    liftClass: lift ? lift[1] : null,
    reusable: allClasses.has(REUSABLE),
    types: lift ? [] : itemIds(entity, P.instanceOf).slice(0, 1),
    makers: first((item) => itemIds(item, P.manufacturer)),
    operators: first((item) => itemIds(item, P.operator)),
    countries: first((item) => itemIds(item, P.countryOfOrigin)).slice(0, 2),
    height: first((item) =>
      maxOf(quantities(item, P.height).filter(within(ROCKET_HEIGHT_M))),
    ),
    diameter: first((item) =>
      maxOf(quantities(item, P.diameter).filter(within(ROCKET_DIAMETER_M))),
    ),
    mass: first((item) =>
      range(
        quantities(item, P.mass).filter(
          (v) => v.unit === 'kg' && v.value >= 1000,
        ),
      ),
    ),
    parts: itemIds(entity, P.hasParts),
    partsAreVariants: itemIds(entity, P.instanceOf).some((id) =>
      VARIANT_PARENTS.has(id),
    ),
    engines: first((item) => itemIds(item, P.poweredBy)),
    firstFlight: first((item) => times(item, P.firstFlight)[0] || null),
    serviceEntry: first((item) => times(item, P.serviceEntry)[0] || null),
    retired: first((item) => times(item, P.serviceRetirement).at(-1) || null),
    image: first((item) => strings(item, P.image)[0] || null),
  };
}

const KG = { format: groupInteger, unit: 'kg' };
const TONNES = { format: (value) => decimal(value / 1000), unit: 't' };
const LB = { format: (value) => groupInteger(value / 0.45359237), unit: 'lb' };
const METRES = { format: decimal, unit: 'm' };
const FEET = { format: (value) => groupInteger(value / 0.3048), unit: 'ft' };

function formatMass(span) {
  if (!span) return null;
  return formatRange(span, span.max >= 10_000 ? TONNES : KG, LB);
}

const formatMetres = (value) =>
  value === null ? null : formatRange({ min: value, max: value }, METRES, FEET);

function formatSize(facts) {
  const parts = [
    ['L', facts.length],
    ['W', facts.width],
    ['H', facts.height],
    ['Ø', facts.diameter],
  ]
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key} ${decimal(value)} m`);
  return parts.length ? parts.join(' · ') : null;
}

function formatOrbit(facts) {
  const { periapsis, apoapsis } = facts;
  if (!periapsis && !apoapsis) return null;
  const km = (span) => (span ? groupInteger(span.max) : '?');
  return `${km(periapsis)} × ${km(apoapsis)} km`;
}

const sentenceCase = (text) =>
  text ? text.charAt(0).toUpperCase() + text.slice(1) : text;

/** Status from retirement / decay dates relative to now. */
function formatStatus(facts, nowYear) {
  if (facts.decay) {
    return facts.decay.year > nowYear
      ? `Re-entry expected ${formatDate(facts.decay)}`
      : `Re-entered ${formatDate(facts.decay)}`;
  }
  if (facts.retired && facts.retired.year <= nowYear)
    return `Retired ${formatDate(facts.retired)}`;
  return null;
}

function push(lines, label, value) {
  if (value) lines.push({ label, value });
}

/**
 * Display lines for a satellite or mission.
 * @param {object} facts From {@link extractSpacecraftFacts}.
 * @param {Map<string, string>} labels
 * @param {{nowYear?: number}} [options]
 */
export function formatSpacecraftDossier(facts, labels, { nowYear } = {}) {
  const lines = [];
  const list = (ids, max = MAX_LISTED) => labelList(ids || [], labels, max);
  push(lines, 'Type', sentenceCase(list(facts.types, 2)?.replace(', ', ' · ')));
  push(lines, 'Program', list(facts.partOf, 1));
  push(lines, 'Operator', list(facts.operators));
  push(lines, 'Maker', list(facts.makers, 2));
  push(lines, 'Origin', list(facts.countries, 2));
  push(lines, 'Bus', list(facts.bus, 1));
  push(lines, 'Crew', list(facts.crew));
  push(lines, 'Launched', formatDate(facts.launched));
  push(lines, 'Rocket', list(facts.launchVehicles, 2));
  push(lines, 'Launch site', list(facts.launchSites, 1));
  push(lines, 'In service', formatDate(facts.serviceEntry));
  push(lines, 'COSPAR', facts.cospar);
  push(lines, 'Mass', formatMass(facts.mass));
  push(lines, 'Size', formatSize(facts));
  push(lines, 'Orbit', list(facts.orbitTypes, 2));
  push(lines, 'Perigee × apogee', formatOrbit(facts));
  if (facts.inclination)
    push(lines, 'Inclination', `${facts.inclination.max.toFixed(2)}°`);
  if (facts.period) push(lines, 'Period', `${facts.period.max.toFixed(1)} min`);
  if (facts.orbits !== null && facts.orbits > 0)
    push(lines, 'Orbits', groupInteger(facts.orbits));
  push(lines, 'Instruments', list(facts.instruments));
  push(
    lines,
    'Status',
    formatStatus(facts, nowYear ?? new Date().getUTCFullYear()),
  );
  return lines;
}

/**
 * Display lines for a rocket.
 * @param {object} facts From {@link extractRocketFacts}.
 * @param {Map<string, string>} labels
 * @param {number|null} payloads Wikidata payload items launched on it.
 */
export function formatRocketDossier(facts, labels, payloads = null) {
  const lines = [];
  const list = (ids, max = MAX_LISTED) => labelList(ids || [], labels, max);
  const type =
    facts.liftClass ||
    sentenceCase(list(facts.types, 1)) ||
    (facts.reusable ? 'Launch vehicle' : null);
  push(
    lines,
    'Type',
    type && facts.reusable && !/reusable/i.test(type)
      ? `${type} · reusable`
      : type,
  );
  push(lines, 'Maker', list(facts.makers, 2));
  push(lines, 'Origin', list(facts.countries, 2));
  push(lines, 'Operator', list(facts.operators));
  push(lines, 'Height', formatMetres(facts.height));
  push(lines, 'Diameter', formatMetres(facts.diameter));
  push(lines, 'Mass', formatMass(facts.mass));
  push(
    lines,
    facts.partsAreVariants ? 'Variants' : 'Components',
    list(facts.parts),
  );
  push(lines, 'Engines', list(facts.engines, 2));
  push(lines, 'First flight', formatDate(facts.firstFlight));
  if (facts.serviceEntry || facts.retired)
    push(
      lines,
      'In service',
      `${facts.serviceEntry ? formatDate(facts.serviceEntry) : '?'}–${
        facts.retired ? formatDate(facts.retired) : 'present'
      }`,
    );
  if (payloads > 0)
    push(lines, 'Payloads', `${groupInteger(payloads)} on Wikidata`);
  return lines;
}

/**
 * Create the cached Space Missions dossier source.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 */
export function createSpaceWikidataSource({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Space Wikidata source requires fetch');
  const { getEntities, getLabels, searchWikipedia, searchStatements } =
    createWikidataClient({ fetchImpl, clientId: SPACE_WIKIDATA_CLIENT_ID });
  const nowYear = () => new Date(now()).getUTCFullYear();

  async function candidates(query, signal) {
    const pages = await searchWikipedia(query, SEARCH_CANDIDATES, signal);
    return pages
      .filter((page) => !/^(List of |Timeline of )/i.test(page.title))
      .map((page) => page.id);
  }

  async function firstAccepted(query, accept, signal, props = 'labels|claims') {
    const ids = await candidates(query, signal);
    if (!ids.length) return null;
    const entities = await getEntities(ids, props, signal);
    const id = ids.find((qid) => accept(entities[qid]));
    return id ? entities[id] : null;
  }

  async function spacecraftResult(entity, signal, extra = []) {
    const facts = extractSpacecraftFacts(entity);
    const labels = await getLabels(referencedIds(facts), signal);
    return {
      id: entity.id,
      title: facts.label || entity.id,
      image: commonsImage(facts.image),
      lines: [
        ...extra,
        ...formatSpacecraftDossier(facts, labels, { nowYear: nowYear() }),
      ],
    };
  }

  async function loadSatellite({ noradId, name }, signal) {
    const { ids } = await searchStatements(
      `haswbstatement:${P.norad}=${noradId}`,
      3,
      signal,
    );
    if (ids.length) {
      const entities = await getEntities(
        ids.slice(0, 1),
        'labels|claims',
        signal,
      );
      const entity = entities[ids[0]];
      if (entity?.claims) return spacecraftResult(entity, signal);
    }
    const phrase = satelliteSearchPhrase(name);
    if (!phrase) return null;
    const entity = await firstAccepted(
      `${phrase} satellite`,
      (item) => isSpacecraftEntity(item) || isConstellation(item),
      signal,
    );
    if (!entity) return null;
    return spacecraftResult(entity, signal, [
      {
        label: 'Match',
        value: isConstellation(entity)
          ? `Constellation (no item for NORAD ${noradId})`
          : `By name (no item for NORAD ${noradId})`,
      },
    ]);
  }

  async function loadRocket(phrase, signal) {
    const entity = await firstAccepted(
      `${phrase} rocket`,
      isRocketEntity,
      signal,
    );
    if (!entity) return null;
    const parentIds = itemIds(entity, P.subclassOf).slice(0, MAX_PARENTS);
    const parents = Object.values(
      await getEntities(parentIds, 'labels|claims', signal).catch((error) => {
        if (signal.aborted) throw error;
        return {};
      }),
    );
    const facts = extractRocketFacts(entity, parents);
    const labels = await getLabels(
      [
        ...facts.types,
        ...facts.makers.slice(0, 2),
        ...facts.countries,
        ...facts.operators.slice(0, MAX_LISTED),
        ...facts.parts.slice(0, MAX_LISTED),
        ...facts.engines.slice(0, 2),
      ],
      signal,
    );
    const payloads = await searchStatements(
      `haswbstatement:${facts.ids.map((id) => `${P.launchVehicle}=${id}`).join('|')}`,
      1,
      signal,
    ).then(
      (result) => result.total,
      (error) => {
        if (signal.aborted) throw error;
        return null;
      },
    );
    return {
      id: entity.id,
      title: facts.label || phrase,
      image: commonsImage(facts.image),
      lines: formatRocketDossier(facts, labels, payloads),
    };
  }

  async function loadMission({ missionName, launchYear }, signal) {
    const entity = await firstAccepted(
      missionName,
      (item) => isMatchingMission(item, missionName, launchYear),
      signal,
      'labels|aliases|claims',
    );
    return entity ? spacecraftResult(entity, signal) : null;
  }

  const satellites = createCachedLookup({
    load: loadSatellite,
    now,
    limit: CACHE_LIMIT,
    ttlMs: CACHE_TTL_MS,
    missTtlMs: NOT_FOUND_TTL_MS,
  });
  const rockets = createCachedLookup({
    load: loadRocket,
    now,
    limit: CACHE_LIMIT,
    ttlMs: CACHE_TTL_MS,
    missTtlMs: NOT_FOUND_TTL_MS,
  });
  const missions = createCachedLookup({
    load: loadMission,
    now,
    limit: CACHE_LIMIT,
    ttlMs: CACHE_TTL_MS,
    missTtlMs: NOT_FOUND_TTL_MS,
  });

  /**
   * Satellite dossier by NORAD id; resolves null when nothing matches.
   * @param {{noradId: string|number, name?: string}} subject
   * @param {{signal?: AbortSignal}} [options]
   */
  function lookupSatellite({ noradId, name = '' } = {}, { signal } = {}) {
    const id = String(noradId ?? '').trim();
    if (!/^\d{1,9}$/.test(id)) return Promise.resolve(null);
    return satellites(id, signal, { noradId: id, name });
  }

  /**
   * Launch dossier: the rocket, plus the mission when Wikidata has it.
   * Resolves null when neither matches.
   * @param {{rocket?: string, missionName?: string, launchYear?: number}} launch
   * @param {{signal?: AbortSignal}} [options]
   */
  async function lookupLaunch(
    { rocket = '', missionName = '', launchYear = null } = {},
    { signal } = {},
  ) {
    const rocketPhrase = rocketSearchPhrase(rocket);
    const missionPhrase = String(missionName ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    // Sequential on purpose: Wikimedia throttles bursts from one client.
    const rocketResult = rocketPhrase
      ? await rockets(rocketPhrase.toLowerCase(), signal, rocketPhrase)
      : null;
    const missionResult = missionPhrase
      ? await missions(
          `${missionPhrase.toLowerCase()}|${launchYear ?? ''}`,
          signal,
          { missionName: missionPhrase, launchYear },
        ).catch((error) => {
          if (signal?.aborted) throw error;
          return null;
        })
      : null;
    if (!rocketResult && !missionResult) return null;
    const lines = [];
    if (rocketResult)
      lines.push(
        { section: `Rocket · ${rocketResult.title}` },
        ...rocketResult.lines,
      );
    if (missionResult)
      lines.push(
        { section: `Mission · ${missionResult.title}` },
        ...missionResult.lines,
      );
    return {
      id: [rocketResult?.id, missionResult?.id].filter(Boolean).join(', '),
      title: missionResult?.title || rocketResult.title,
      image: missionResult?.image || rocketResult?.image || null,
      lines,
    };
  }

  return { lookupSatellite, lookupLaunch };
}
