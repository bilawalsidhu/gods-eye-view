/**
 * Keyless Wikidata lookups for the Radio dossier.
 *
 * Radio Browser stations carry no Wikidata id, so a station is resolved in
 * two steps. A North American call sign in the name ("KEXP 90.3") is matched
 * exactly through call-sign statements (P2317). Otherwise the cleaned name
 * ("Radio Paradise Main Mix (EU) 320k AAC" → "Radio Paradise Main Mix") is
 * searched among radio-station items, first in the station's country, and a
 * hit is accepted only when its English label or an alias names the station
 * and, when both have coordinates, it is within 1,500 km of the marker.
 */
import {
  claimsOf,
  commonsImage,
  createCachedLookup,
  createWikidataClient,
  decimal,
  formatDate,
  groupInteger,
  itemIds,
  labelList,
  quantities,
  strings,
  times,
} from './wikidataClient.js';

export const RADIO_WIKIDATA_CLIENT_ID =
  'GodsEyeView/radio (https://github.com/robarbms/gods-eye-view)';
const CACHE_LIMIT = 96;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 30 * 60 * 1000;
const SEARCH_CANDIDATES = 5;
const MAX_LISTED = 3;
const MAX_DISTANCE_KM = 1500;
/** Below this a frequency reads in kHz (LW/MW/SW), above it in MHz. */
const KHZ_DISPLAY_LIMIT = 30_000;
/** K/W/C call signs are only meaningful in these catalogs ('' = unknown). */
const CALL_SIGN_COUNTRIES = new Set(['US', 'CA', '']);

const P = {
  instanceOf: 'P31',
  country: 'P17',
  locatedIn: 'P131',
  headquarters: 'P159',
  licensedTo: 'P1408',
  owner: 'P127',
  parent: 'P749',
  operator: 'P137',
  format: 'P415',
  genre: 'P136',
  callSign: 'P2317',
  frequency: 'P2144',
  power: 'P2109',
  language: 'P407',
  languageUsed: 'P2936',
  inception: 'P571',
  dissolved: 'P576',
  slogan: 'P6251',
  website: 'P856',
  logo: 'P154',
  image: 'P18',
  coordinates: 'P625',
  isoCountry: 'P297',
};

/** Radio station, community radio, internet radio, radio channel. */
export const RADIO_CLASSES = ['Q14350', 'Q1179112', 'Q184973', 'Q1474440'];
const RADIO_CLASS_SET = new Set(RADIO_CLASSES);

/** Words that say nothing about which station it is. */
const GENERIC = new Set([
  'radio',
  'fm',
  'am',
  'the',
  'station',
  'hd',
  'online',
]);
/** Stream/catalog noise Radio Browser appends to names. */
const NOISE =
  /\b(?:\d{2,4}\s?k(?:bps|b)?|kbps|mp3|aac\+?|he-aac|opus|ogg|flac|hifi|hq|lq|stream|live|official|\d{2,3}[.,]\d{1,2}\s?(?:fm|mhz)?|\d{3,4}\s?(?:am|khz))\b/gi;

/**
 * Exact call signs in a station name: K/W (US) or CF/CH/CI/CJ/CK (Canada)
 * plus 2–3 letters, optionally "-FM"/"-AM". Case-sensitive on purpose.
 * @param {string} name
 * @returns {string[]} Candidate P2317 values, most specific first.
 */
export function stationCallSigns(name) {
  const match =
    /(?:^|[^A-Za-z])((?:[KW][A-Z]{2,3}|C[FHIJK][A-Z]{2}))(?:-(FM|AM))?(?![A-Za-z])/.exec(
      String(name ?? ''),
    );
  if (!match) return [];
  const [, base, band] = match;
  return band ? [`${base}-${band}`, base] : [`${base}-FM`, base, `${base}-AM`];
}

/**
 * Reduce a Radio Browser name to a search phrase: drop bracketed asides,
 * a slogan after " - " / " | " / " : ", bitrates, codecs and frequencies.
 * @param {string} name
 * @returns {string}
 */
export function radioSearchPhrase(name) {
  const text = String(name ?? '')
    .replace(/[([{].*?[)\]}]/g, ' ')
    .replace(/^[\s\-–—|:#·]+/, '')
    .split(/\s+[-–—|:·]\s+|\s*\|\s*/)[0]
    .replace(NOISE, ' ')
    .replace(/[^\p{L}\p{N}\s'&.!-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 80);
}

const nameTokens = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * How well do the entity's English names identify the station? 3 = exact
 * label, 2 = label, 1 = alias, 0 = no match. Every distinctive word of the
 * Wikidata name must appear in the station phrase; labels must cover at least
 * half of the phrase's distinctive words or lead it ("Radio Paradise" ↔
 * "Radio Paradise Main Mix"). Aliases, often former names, must cover all of
 * them ("Virgin Radio" alias of Absolute Radio ✗ "Virgin Radio UK").
 */
export function radioNameScore(entity, phrase) {
  const wanted = nameTokens(phrase).filter((token) => !GENERIC.has(token));
  if (!wanted.length) return 0;
  const wantedSet = new Set(wanted);
  const covers = (candidate, strict) => {
    const have = [
      ...new Set(nameTokens(candidate).filter((t) => !GENERIC.has(t))),
    ];
    if (!have.length || !have.every((token) => wantedSet.has(token)))
      return false;
    if (strict) return have.length === wantedSet.size;
    const leads = have.every((token, index) => wanted[index] === token);
    return leads || have.length * 2 >= wanted.length;
  };
  const label = entity?.labels?.en?.value;
  if (label && covers(label, false)) return covers(label, true) ? 3 : 2;
  const aliases = (entity?.aliases?.en || []).map((alias) => alias?.value);
  return aliases.some((alias) => alias && covers(alias, true)) ? 1 : 0;
}

/** Does one of the entity's English names identify the station? */
export function radioNamesMatch(entity, phrase) {
  return radioNameScore(entity, phrase) > 0;
}

/**
 * Search phrases from most to least specific: the phrase, its first two
 * words, then its first word when that is distinctive ("SomaFM Groove
 * Salad" → "SomaFM Groove" → "SomaFM").
 * @param {string} phrase From {@link radioSearchPhrase}.
 */
export function radioSearchVariants(phrase) {
  const words = String(phrase ?? '')
    .split(' ')
    .filter(Boolean);
  const variants = [words.join(' '), words.slice(0, 2).join(' ')];
  if (words[0]?.length >= 3 && !GENERIC.has(words[0].toLowerCase()))
    variants.push(words[0]);
  return [...new Set(variants.filter(Boolean))];
}

/** Is this item a radio station, channel or network? */
export function isRadioEntity(entity) {
  return itemIds(entity, P.instanceOf).some((id) => RADIO_CLASS_SET.has(id));
}

function coordinatesOf(entity) {
  const value = claimsOf(entity, P.coordinates)[0]?.mainsnak?.datavalue?.value;
  return Number.isFinite(value?.latitude) && Number.isFinite(value?.longitude)
    ? { lat: value.latitude, lon: value.longitude }
    : null;
}

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Is the item (when it has coordinates) near the station marker? */
export function isNearStation(entity, station) {
  const at = coordinatesOf(entity);
  if (!at || !Number.isFinite(station?.lat) || !Number.isFinite(station?.lon))
    return true;
  return distanceKm(at, station) <= MAX_DISTANCE_KM;
}

/** Monolingual texts, English first. */
function texts(entity, property) {
  const values = claimsOf(entity, property)
    .map((claim) => claim.mainsnak.datavalue.value)
    .filter((value) => typeof value?.text === 'string' && value.text.trim());
  values.sort(
    (a, b) => (a.language === 'en' ? 0 : 1) - (b.language === 'en' ? 0 : 1),
  );
  return values.map((value) => value.text.trim());
}

/**
 * Pull station facts from a radio entity.
 * @param {object} entity
 * @returns {object} Raw facts; item references are QIDs for labelling.
 */
export function extractRadioFacts(entity) {
  const logo = strings(entity, P.logo)[0] || null;
  return {
    id: entity.id,
    label: entity.labels?.en?.value || null,
    types: itemIds(entity, P.instanceOf).slice(0, 2),
    formats: itemIds(entity, P.format),
    genres: itemIds(entity, P.genre),
    callSigns: [...new Set(strings(entity, P.callSign))],
    frequencies: quantities(entity, P.frequency)
      .filter((entry) => entry.unit === 'kHz' && entry.value > 0)
      .map((entry) => entry.value),
    power: Math.max(
      0,
      ...quantities(entity, P.power)
        .filter((entry) => entry.unit === 'kW')
        .map((entry) => entry.value),
    ),
    licensedTo: itemIds(entity, P.licensedTo),
    basedIn: [
      ...itemIds(entity, P.headquarters),
      ...itemIds(entity, P.locatedIn),
    ].slice(0, 1),
    countries: itemIds(entity, P.country).slice(0, 1),
    owners: itemIds(entity, P.owner),
    parents: itemIds(entity, P.parent),
    operators: itemIds(entity, P.operator),
    languages: [
      ...new Set([
        ...itemIds(entity, P.language),
        ...itemIds(entity, P.languageUsed),
      ]),
    ],
    inception: times(entity, P.inception)[0] || null,
    dissolved: times(entity, P.dissolved).at(-1) || null,
    slogan: texts(entity, P.slogan)[0] || null,
    website: strings(entity, P.website)[0] || null,
    image: logo || strings(entity, P.image)[0] || null,
    imageIsLogo: Boolean(logo),
  };
}

function referencedIds(facts) {
  return [
    ...facts.types,
    ...facts.formats.slice(0, 2),
    ...facts.genres.slice(0, MAX_LISTED),
    ...facts.licensedTo.slice(0, 2),
    ...facts.basedIn,
    ...facts.countries,
    ...facts.owners.slice(0, 2),
    ...facts.parents.slice(0, 1),
    ...facts.operators.slice(0, 2),
    ...facts.languages.slice(0, 2),
  ];
}

/** "90.3 MHz", "1010 kHz". */
export function formatFrequency(khz) {
  if (!Number.isFinite(khz) || khz <= 0) return null;
  if (khz < KHZ_DISPLAY_LIMIT) return `${groupInteger(khz)} kHz`;
  const mhz = khz / 1000;
  return `${Number.isInteger(mhz) ? mhz.toFixed(1) : String(+mhz.toFixed(3))} MHz`;
}

/** "44 kW", "250 W". */
export function formatPower(kw) {
  if (!Number.isFinite(kw) || kw <= 0) return null;
  return kw >= 1 ? `${decimal(kw)} kW` : `${groupInteger(kw * 1000)} W`;
}

/** Host of a website URL without "www.". */
export function websiteHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

const sentenceCase = (text) =>
  text ? text.charAt(0).toUpperCase() + text.slice(1) : text;

function push(lines, label, value) {
  if (value) lines.push({ label, value });
}

/**
 * Display lines for a radio station.
 * @param {object} facts From {@link extractRadioFacts}.
 * @param {Map<string, string>} labels
 */
export function formatRadioDossier(facts, labels) {
  const lines = [];
  const list = (ids, max = MAX_LISTED) => labelList(ids || [], labels, max);
  push(lines, 'Type', sentenceCase(list(facts.types, 2)?.replace(', ', ' · ')));
  push(lines, 'Format', sentenceCase(list(facts.formats, 2)));
  push(lines, 'Genre', sentenceCase(list(facts.genres)));
  push(lines, 'Call sign', facts.callSigns.slice(0, 2).join(', '));
  push(
    lines,
    'Frequency',
    [...new Set(facts.frequencies.map(formatFrequency).filter(Boolean))]
      .slice(0, 3)
      .join(' · '),
  );
  push(lines, 'Power', formatPower(facts.power));
  push(lines, 'Licensed to', list(facts.licensedTo, 2));
  push(lines, 'Based in', list(facts.basedIn, 1));
  push(lines, 'Country', list(facts.countries, 1));
  push(lines, 'Owner', list(facts.owners, 2));
  push(lines, 'Parent', list(facts.parents, 1));
  push(lines, 'Operator', list(facts.operators, 2));
  push(lines, 'Language', sentenceCase(list(facts.languages, 2)));
  push(lines, 'On air since', formatDate(facts.inception));
  push(lines, 'Closed', formatDate(facts.dissolved));
  if (facts.slogan) push(lines, 'Slogan', `“${facts.slogan.slice(0, 80)}”`);
  push(lines, 'Website', websiteHost(facts.website));
  return lines;
}

/**
 * Create the cached Radio dossier source.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 */
export function createRadioWikidataSource({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new TypeError('Radio Wikidata source requires fetch');
  const { getEntities, getLabels, searchStatements } = createWikidataClient({
    fetchImpl,
    clientId: RADIO_WIKIDATA_CLIENT_ID,
  });
  const classFilter = `haswbstatement:${RADIO_CLASSES.map((id) => `${P.instanceOf}=${id}`).join('|')}`;
  const countryIds = new Map();

  async function countryId(code, signal) {
    if (!/^[A-Z]{2}$/.test(code)) return null;
    if (!countryIds.has(code)) {
      const { ids } = await searchStatements(
        `haswbstatement:${P.isoCountry}=${code}`,
        1,
        signal,
      );
      countryIds.set(code, ids[0] || null);
    }
    return countryIds.get(code);
  }

  /** Best accepted candidate: highest score, then search rank. */
  async function bestAccepted(query, score, signal) {
    const { ids } = await searchStatements(query, SEARCH_CANDIDATES, signal);
    if (!ids.length) return null;
    const entities = await getEntities(ids, 'labels|aliases|claims', signal);
    let best = null;
    let bestScore = 0;
    for (const qid of ids) {
      const value = entities[qid] ? score(entities[qid]) : 0;
      if (value > bestScore) [best, bestScore] = [entities[qid], value];
    }
    return best;
  }

  async function resolve(station, signal) {
    const signs = CALL_SIGN_COUNTRIES.has(station.countryCode)
      ? stationCallSigns(station.name)
      : [];
    if (signs.length) {
      const entity = await bestAccepted(
        `haswbstatement:${signs.map((sign) => `${P.callSign}=${sign}`).join('|')}`,
        (item) => (isNearStation(item, station) ? 1 : 0),
        signal,
      );
      if (entity) return entity;
    }
    const phrase = radioSearchPhrase(station.name);
    if (!nameTokens(phrase).some((token) => !GENERIC.has(token))) return null;
    const score = (item) =>
      isNearStation(item, station) ? radioNameScore(item, phrase) : 0;
    const country = await countryId(station.countryCode, signal).catch(
      (error) => {
        if (signal?.aborted) throw error;
        return null;
      },
    );
    const scope = country ? ` haswbstatement:${P.country}=${country}` : '';
    const variants = radioSearchVariants(phrase.replace(/"/g, ''));
    for (const variant of variants) {
      const entity = await bestAccepted(
        `${variant} ${classFilter}${scope}`,
        score,
        signal,
      );
      if (entity) return entity;
    }
    // Catalog countries are sometimes the stream host's, not the station's.
    return scope
      ? bestAccepted(`${variants[0]} ${classFilter}`, score, signal)
      : null;
  }

  async function loadStation(station, signal) {
    const entity = await resolve(station, signal);
    if (!entity?.claims) return null;
    const facts = extractRadioFacts(entity);
    const labels = await getLabels(referencedIds(facts), signal);
    const image = commonsImage(facts.image);
    return {
      id: entity.id,
      title: facts.label || entity.id,
      image: image && facts.imageIsLogo ? { ...image, logo: true } : image,
      lines: formatRadioDossier(facts, labels),
    };
  }

  const stations = createCachedLookup({
    load: loadStation,
    now,
    limit: CACHE_LIMIT,
    ttlMs: CACHE_TTL_MS,
    missTtlMs: NOT_FOUND_TTL_MS,
  });

  /**
   * Station dossier; resolves null when nothing matches.
   * @param {{name: string, countryCode?: string, lat?: number, lon?: number}} station
   * @param {{signal?: AbortSignal}} [options]
   */
  function lookupStation(station = {}, { signal } = {}) {
    const name = String(station.name ?? '').trim();
    if (!name) return Promise.resolve(null);
    const countryCode = String(station.countryCode ?? '')
      .trim()
      .toUpperCase();
    const subject = {
      name,
      countryCode,
      lat: Number(station.lat),
      lon: Number(station.lon),
    };
    // Stream variants ("WALM HD", "WALM 2 HD Opus") share one lookup.
    const key = `${radioSearchPhrase(name).toLowerCase()}|${stationCallSigns(name)[0] || ''}|${countryCode}`;
    return stations(key, signal, subject);
  }

  return { lookupStation };
}
