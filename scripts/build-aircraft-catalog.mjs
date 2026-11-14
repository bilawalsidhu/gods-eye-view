#!/usr/bin/env node
/**
 * Builds the bundled aircraft type library: ICAO type designator -> name,
 * class, specs and one licensed photo.
 *
 *   node scripts/build-aircraft-catalog.mjs --snapshot <adsbdb.json>
 *     regenerate src/data/aircraftTypes/typeFrequency.json from an adsbdb
 *     cache (type counts and the commonest type name only).
 *   node scripts/build-aircraft-catalog.mjs [--top 150] [--offline]
 *     build catalog.json, public/aircraft-types/*.webp and
 *     docs/AIRCRAFT-PHOTO-CREDITS.md for the top civil types plus every
 *     type in designators.json. --explain B733,C150 prints each type's ranked
 *     photo candidates, for choosing a `photo` pin in designators.json.
 *
 * Sources: ICAO Doc 8643 (designator, engines, engine type), the English
 * Wikipedia "List of aircraft type designators" (designator -> article),
 * Wikidata (item, specs, P18, Commons category) and Wikimedia Commons
 * (licence, author). Wikidata has no ICAO type designator property, so the
 * designator -> item link comes from designators.json (item or article), then
 * the Wikipedia list; the item must be an aircraft.
 *
 * Every response is cached under .gev-cache/aircraft-catalog/, so a rerun is
 * offline and produces the same files.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { classifyAircraft } from '../src/data/aircraftClass.js';
import {
  MAX_PHOTO_WIDTH,
  validateCatalog,
} from '../src/data/aircraftTypes/validateCatalog.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const TYPES_DIR = path.join(ROOT, 'src/data/aircraftTypes');
const FREQUENCY_FILE = path.join(TYPES_DIR, 'typeFrequency.json');
const DESIGNATORS_FILE = path.join(TYPES_DIR, 'designators.json');
const CATALOG_FILE = path.join(TYPES_DIR, 'catalog.json');
const PHOTO_DIR = path.join(ROOT, 'public/aircraft-types');
const CREDITS_FILE = path.join(ROOT, 'docs/AIRCRAFT-PHOTO-CREDITS.md');
const CACHE_DIR = path.join(ROOT, '.gev-cache/aircraft-catalog');
const REPORT_FILE = path.join(CACHE_DIR, 'report.json');

const USER_AGENT = 'aircraft-catalog-builder/1.0';
const MIN_INTERVAL_MS = 400;
const WEBP_QUALITY = 70;

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';
const DOC8643 = 'https://doc8643.icao.int/external/aircrafttypes';

const AIRCRAFT_ITEM = 'Q11436';
// "aircraft family" and "aircraft model" are not subclasses of aircraft.
const AIRCRAFT_MODEL_ITEMS = ['Q15056993', 'Q15056995'];
const UNIT_TO_METRES = {
  Q11573: 1,
  Q3710: 0.3048,
  Q218593: 0.0254,
  Q174728: 0.01,
};

// --- arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    top: 150,
    offline: false,
    snapshot: null,
    only: null,
    explain: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--offline') args.offline = true;
    else if (flag === '--top') args.top = Number(argv[++i]);
    else if (flag === '--snapshot') args.snapshot = argv[++i];
    else if (flag === '--only') args.only = argv[++i].split(',');
    else if (flag === '--explain') args.explain = argv[++i].split(',');
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!Number.isInteger(args.top) || args.top <= 0)
    throw new Error('--top must be a positive integer');
  return args;
}

// --- cached, rate-limited HTTP -------------------------------------------------

let offline = false;
let lastRequestAt = 0;
const httpStats = { network: 0, cached: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha1 = (text) => createHash('sha1').update(text).digest('hex');

async function request(url, { method = 'GET', headers = {}, binary = false }) {
  const key = sha1(`${method} ${url}`);
  const file = path.join(CACHE_DIR, binary ? 'bin' : 'http', key);
  if (existsSync(file)) {
    httpStats.cached++;
    return binary ? readFileSync(file) : readFileSync(file, 'utf8');
  }
  if (offline) throw new Error(`Offline and not cached: ${url}`);
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    httpStats.network++;
    if (process.env.CATALOG_DEBUG)
      console.error(`${method} ${url.slice(0, 160)}`);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (response.ok) {
      const body = binary
        ? Buffer.from(await response.arrayBuffer())
        : await response.text();
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
      return body;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 4)
      throw new Error(`${response.status} ${method} ${url}`);
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2000 * 2 ** attempt,
    );
  }
}

const getJson = async (url, options = {}) =>
  JSON.parse(await request(url, options));

const apiUrl = (base, params) =>
  `${base}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;

async function sparql(query) {
  const url = `${SPARQL}?${new URLSearchParams({ query })}`;
  const data = await getJson(url, {
    headers: { Accept: 'application/sparql-results+json' },
  });
  return data.results.bindings;
}

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// --- snapshot mode -------------------------------------------------------------

function writeSnapshot(adsbdbFile) {
  const cache = JSON.parse(readFileSync(adsbdbFile, 'utf8'));
  const airframes = Object.values(cache.aircraft ?? {});
  const counts = new Map();
  for (const record of airframes) {
    const code = String(record?.data?.typeCode ?? '')
      .trim()
      .toUpperCase();
    if (!code) continue;
    const slot = counts.get(code) ?? { count: 0, names: new Map() };
    slot.count++;
    const name = String(record.data.typeName ?? '').trim();
    if (name) slot.names.set(name, (slot.names.get(name) ?? 0) + 1);
    counts.set(code, slot);
  }
  const types = [...counts]
    .map(([icao, { count, names }]) => ({
      icao,
      count,
      typeName:
        [...names].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0] ??
        null,
    }))
    .sort((a, b) => b.count - a.count || cmp(a.icao, b.icao));
  const snapshot = {
    source: 'adsbdb aircraft cache (.gev-cache/adsbdb.json)',
    airframes: airframes.length,
    withTypeCode: types.reduce((sum, type) => sum + type.count, 0),
    types,
  };
  writeFileSync(FREQUENCY_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `typeFrequency.json: ${snapshot.airframes} airframes, ${snapshot.withTypeCode} with a type code, ${types.length} types`,
  );
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --- ICAO Doc 8643 ---------------------------------------------------------------

async function loadDoc8643() {
  const rows = await getJson(DOC8643, {
    method: 'POST',
    headers: { 'Content-Length': '0' },
  });
  const byDesignator = new Map();
  for (const row of rows) {
    const list = byDesignator.get(row.Designator) ?? [];
    list.push(row);
    byDesignator.set(row.Designator, list);
  }
  return byDesignator;
}

const titleCase = (text) =>
  text
    .toLowerCase()
    .replace(
      /(^|[\s(/-])([a-z])/g,
      (_, lead, letter) => lead + letter.toUpperCase(),
    )
    .replace(/\s*\(\d+\)$/, '');

/** Summarise the Doc 8643 rows of one designator. */
function describeDoc(icao, rows) {
  const tally = (pick, bonus = () => 0) => {
    const counts = new Map();
    for (const row of rows)
      counts.set(pick(row), (counts.get(pick(row)) ?? 0) + 1);
    return [...counts]
      .map(([key, count]) => [key, count + bonus(key)])
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0][0];
  };
  const manufacturer = tally((row) => row.ManufacturerCode);
  // The model that spells the designator wins ("U-2" over "ER-2" for U2,
  // "Mi-8" over "Mi-17" for MI8), then the commonest.
  const code = normalise(icao);
  const modelToken = tally(
    (row) =>
      row.ModelFullName.replace(/\(.*?\)/g, '')
        .trim()
        .split(/\s+/)[0],
    (token) =>
      normalise(token) === code
        ? 1000
        : normalise(token).includes(code)
          ? 100
          : 0,
  );
  const engines = Number(rows[0].EngineCount);
  return {
    manufacturer: titleCase(manufacturer),
    modelToken,
    model: rows.find((row) => row.ManufacturerCode === manufacturer)
      .ModelFullName,
    description: rows[0].AircraftDescription,
    engineType: rows[0].EngineType,
    engines: Number.isInteger(engines) && engines > 0 ? engines : undefined,
    wtc: rows[0].WTC,
    bizjetRows: rows.filter((row) => BIZJET_NAME.test(row.ModelFullName))
      .length,
    rows: rows.length,
  };
}

const ENGINE_TYPES = {
  Jet: 'jet',
  'Turboprop/Turboshaft': 'turbine',
  Piston: 'piston',
  Electric: 'electric',
  Rocket: 'rocket',
};

// --- class -------------------------------------------------------------------------

const BIZJET_NAME =
  /gulfstream|challenger|global|learjet|falcon|citation|phenom|praetor|legacy|hawker|hondajet|premier|vision|pc-24|lineage|beechjet|sabreliner|westwind|astra|\bg[1-7]\d{2}\b/i;

/**
 * classifyAircraft returns 'airliner' for any designator outside its sets, so
 * that result is the only one Doc 8643 may correct. A curated class wins.
 */
function resolveClass(icao, doc, curated) {
  const classifier = classifyAircraft({ typeCode: icao });
  let cls = classifier;
  let reason = null;
  if (curated?.class) {
    cls = curated.class;
    reason = curated.classReason ?? 'curated in designators.json';
  } else if (classifier === 'airliner' && doc) {
    if (/Helicopter|Gyrocopter/.test(doc.description)) {
      cls = 'helicopter';
      reason = `ICAO Doc 8643 describes it as ${doc.description}`;
    } else if (doc.description === 'Tiltrotor') {
      cls = 'turboprop';
      reason = 'ICAO Doc 8643: tiltrotor, nearest class is turboprop';
    } else if (doc.engineType === 'Turboprop/Turboshaft') {
      cls = 'turboprop';
      reason = 'ICAO Doc 8643 engine type is turboprop';
    } else if (doc.engineType === 'Piston' || doc.engineType === 'Electric') {
      cls = 'light';
      reason = `ICAO Doc 8643 engine type is ${doc.engineType.toLowerCase()}`;
    } else if (doc.engineType === 'Jet' && doc.engines >= 4) {
      cls = 'quadjet';
      reason = `ICAO Doc 8643: ${doc.engines} jet engines`;
    } else if (
      doc.engineType === 'Jet' &&
      doc.wtc !== 'H' &&
      doc.bizjetRows * 2 >= doc.rows
    ) {
      cls = 'bizjet';
      reason = `ICAO Doc 8643 names a business jet in ${doc.bizjetRows} of ${doc.rows} model rows`;
    }
  }
  if (cls === classifier) return { class: cls };
  return { class: cls, classOverride: { classifier, reason } };
}

// --- designator -> Wikidata item ---------------------------------------------------------

async function loadWikipediaList() {
  const data = await getJson(
    apiUrl(WIKIPEDIA_API, {
      action: 'parse',
      page: 'List of aircraft type designators',
      prop: 'wikitext',
    }),
  );
  const map = new Map();
  const row =
    /^\|\s*([A-Z0-9]{2,4})\s*\|\|[^|\n]*\|\|\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/gm;
  for (const match of data.parse.wikitext.matchAll(row)) {
    const list = map.get(match[1]) ?? [];
    list.push({
      article: match[2].trim(),
      label: (match[3] ?? match[2]).trim(),
    });
    map.set(match[1], list);
  }
  return map;
}

async function articlesToItems(titles) {
  const result = new Map();
  for (const batch of chunks([...new Set(titles)], 50)) {
    const data = await getJson(
      apiUrl(WIKIPEDIA_API, {
        action: 'query',
        prop: 'pageprops',
        ppprop: 'wikibase_item',
        redirects: '1',
        titles: batch.join('|'),
      }),
    );
    // Several requested titles can normalise or redirect to one page.
    const sources = new Map();
    for (const step of [
      ...(data.query.normalized ?? []),
      ...(data.query.redirects ?? []),
    ])
      sources.set(step.to, [...(sources.get(step.to) ?? []), step.from]);
    for (const page of data.query.pages) {
      const item = page.pageprops?.wikibase_item;
      if (!item) continue;
      const pending = [page.title];
      while (pending.length) {
        const title = pending.pop();
        result.set(title, item);
        pending.push(...(sources.get(title) ?? []));
      }
    }
  }
  return result;
}

async function aircraftItems(ids) {
  const yes = new Set();
  for (const batch of chunks([...new Set(ids)], 40)) {
    const rows = await sparql(
      `SELECT DISTINCT ?item WHERE { VALUES ?item { ${batch.map((id) => `wd:${id}`).join(' ')} } { ?item wdt:P31 ?model . VALUES ?model { ${AIRCRAFT_MODEL_ITEMS.map((id) => `wd:${id}`).join(' ')} } } UNION { ?item (wdt:P31|wdt:P279)/wdt:P279* wd:${AIRCRAFT_ITEM} } }`,
    );
    for (const row of rows) yes.add(row.item.value.split('/').pop());
  }
  return yes;
}

const entities = new Map();

async function loadEntities(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !entities.has(id));
  for (const batch of chunks(missing, 50)) {
    const data = await getJson(
      apiUrl(WIKIDATA_API, {
        action: 'wbgetentities',
        ids: batch.join('|'),
        props: 'claims|labels',
        languages: 'en',
      }),
    );
    for (const [id, entity] of Object.entries(data.entities))
      entities.set(id, entity);
  }
}

/** Statement values of one property, preferred rank first, deprecated dropped. */
function claims(id, property) {
  const statements = entities.get(id)?.claims?.[property] ?? [];
  const live = statements.filter((s) => s.rank !== 'deprecated');
  const preferred = live.filter((s) => s.rank === 'preferred');
  return (preferred.length ? preferred : live)
    .map((s) => s.mainsnak?.datavalue?.value)
    .filter((value) => value !== undefined);
}

const label = (id) => entities.get(id)?.labels?.en?.value ?? null;
const normalise = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

async function childrenOf(ids) {
  const children = new Map();
  for (const batch of chunks([...new Set(ids)], 40)) {
    const rows = await sparql(
      `SELECT ?parent ?child ?label WHERE { VALUES ?parent { ${batch.map((id) => `wd:${id}`).join(' ')} } ?child wdt:P279 ?parent . ?child rdfs:label ?label . FILTER(LANG(?label) = "en") }`,
    );
    for (const row of rows) {
      const parent = row.parent.value.split('/').pop();
      const list = children.get(parent) ?? [];
      list.push({
        id: row.child.value.split('/').pop(),
        label: row.label.value,
      });
      children.set(parent, list);
    }
  }
  for (const list of children.values()) list.sort((a, b) => cmp(a.id, b.id));
  return children;
}

/**
 * The subclass item of `base` that names this designator's model. The token
 * is the commonest first word of the Doc 8643 model names ("787-9"). A
 * subclass's last word must equal it and its first word must match the
 * base's, so neither a licence build ("Reims F172" under "Cessna 172") nor a
 * prototype ("YF-16" under "F-16") wins; a base that already ends with the
 * token is the model itself.
 */
function pickVariant(base, baseLabel, doc, children, notes) {
  if (!doc?.modelToken || !baseLabel) return null;
  const token = normalise(doc.modelToken);
  if (token.length < 2 || normalise(baseLabel).endsWith(token)) return null;
  const brand = normalise(baseLabel.split(/\s+/)[0]);
  const hits = [
    ...new Map(
      (children.get(base) ?? [])
        .filter((child) => {
          const words = child.label.trim().split(/\s+/);
          return (
            normalise(words.at(-1)) === token &&
            normalise(child.label).startsWith(brand)
          );
        })
        .map((child) => [child.id, child]),
    ).values(),
  ].sort((a, b) => a.label.length - b.label.length || cmp(a.id, b.id));
  if (hits.length > 1)
    notes.push(
      `variant: ${hits.length} subclasses of ${base} match "${doc.modelToken}" (${hits.map((hit) => hit.id).join(', ')}); kept the shortest label`,
    );
  return hits[0]?.id ?? null;
}

// --- specs --------------------------------------------------------------------------------

function quantityMetres(id, property) {
  for (const value of claims(id, property)) {
    const unit = String(value.unit ?? '')
      .split('/')
      .pop();
    const factor = UNIT_TO_METRES[unit];
    const amount = Number(value.amount);
    if (factor && Number.isFinite(amount) && amount > 0)
      return Math.round(amount * factor * 100) / 100;
  }
  return undefined;
}

function firstFlightYear(id) {
  for (const value of claims(id, 'P606')) {
    const year = Number(/^\+?(\d{4})/.exec(value.time ?? '')?.[1]);
    if (year > 1900) return year;
  }
  return undefined;
}

/** Each field from the most specific item in `chain` that has it, with its source. */
function collectSpecs(chain, doc) {
  const specs = {};
  const source = {};
  const fields = {
    lengthM: (id) => quantityMetres(id, 'P2043'),
    spanM: (id) => quantityMetres(id, 'P2050'),
    firstFlightYear,
  };
  for (const [field, read] of Object.entries(fields)) {
    for (const id of chain) {
      const value = read(id);
      if (value !== undefined) {
        specs[field] = value;
        source[field] = `wikidata:${id}`;
        break;
      }
    }
  }
  if (doc?.engines) {
    specs.engines = doc.engines;
    source.engines = 'ICAO Doc 8643';
  }
  if (doc && ENGINE_TYPES[doc.engineType]) {
    specs.engineType = ENGINE_TYPES[doc.engineType];
    source.engineType = 'ICAO Doc 8643';
  }
  return { specs, specsSource: source };
}

// --- photos -------------------------------------------------------------------------------

const POSITIVE =
  /in[ -]flight|airborne|take-?off|taking off|landing at|on approach|approach to|departing|departure|climb|fly-?past|fly-?by|flying|overflight|aerial/i;
const SIDE = /side view|profile|taxiing|lined up/i;
const NEGATIVE =
  /cockpit|interior|cabin|seats?\b|engine|wheel|landing gear|undercarriage|\btail\b|nose\b|detail|\bmodel\b|toy|replica|mock-?up|museum|wreck|crash|accident|\bfire\b|drawing|diagram|3-?view|three-view|\.svg|logo|\bmap\b|instrument|panel|hangar|assembly|factory|production|construction|dash ?board|livery|painting|stamp|poster|line-?up|formation|scale|front office|\b1[:/]\d+/i;

const stripHtml = (html) =>
  String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Commons licence metadata -> allowlisted short name, or null with the raw value. */
function normaliseLicence(meta) {
  if (meta.NonFree?.value === 'true') return null;
  const code = String(meta.License?.value ?? '').toLowerCase();
  const short = String(meta.LicenseShortName?.value ?? '');
  if (code === 'cc0' || /^cc0/i.test(short)) return 'CC0';
  if (code === 'pd' || code.startsWith('pd-') || /^public domain/i.test(short))
    return 'PD';
  const cc = /^cc-by(-sa)?-(\d\.\d)/.exec(code);
  if (cc) return `CC BY${cc[1] ? '-SA' : ''} ${cc[2]}`;
  return null;
}

/** Canonical https deed of an allowlisted licence; PD has none. */
function licenceUrlOf(licence) {
  if (licence === 'CC0')
    return 'https://creativecommons.org/publicdomain/zero/1.0/';
  const cc = /^CC (BY(?:-SA)?) (\d\.\d)$/.exec(licence);
  return cc
    ? `https://creativecommons.org/licenses/${cc[1].toLowerCase()}/${cc[2]}/`
    : null;
}

/**
 * Files of a Commons category, plus the files of its "<category> in flight"
 * subcategory (a Commons naming convention) flagged as in flight.
 */
async function categoryFiles(category) {
  const members = async (title, cmtype) =>
    (
      await getJson(
        apiUrl(COMMONS_API, {
          action: 'query',
          list: 'categorymembers',
          cmtitle: title,
          cmtype,
          cmlimit: '50',
        }),
      )
    ).query?.categorymembers ?? [];
  const files = [];
  for (const member of await members(`Category:${category}`, 'file|subcat')) {
    if (member.title.startsWith('File:'))
      files.push({ file: member.title.slice(5), inFlight: false });
    else if (/ in flight$/i.test(member.title))
      for (const sub of await members(member.title, 'file'))
        files.push({ file: sub.title.slice(5), inFlight: true });
  }
  return files;
}

const imageInfo = new Map();

async function loadImageInfo(files) {
  const missing = [...new Set(files)].filter((file) => !imageInfo.has(file));
  for (const batch of chunks(missing, 50)) {
    const data = await getJson(
      apiUrl(COMMONS_API, {
        action: 'query',
        prop: 'imageinfo',
        iiprop: 'url|size|mime|extmetadata',
        iiurlwidth: '960',
        iiextmetadatafilter:
          'License|LicenseShortName|LicenseUrl|Artist|Credit|ImageDescription|NonFree|AttributionRequired',
        titles: batch.map((file) => `File:${file}`).join('|'),
      }),
    );
    const alias = new Map(
      (data.query.normalized ?? []).map((step) => [step.to, step.from]),
    );
    for (const page of data.query.pages) {
      const title = page.title.replace(/^File:/, '');
      const info = page.imageinfo?.[0] ?? null;
      imageInfo.set(title, info);
      const from = alias.get(page.title);
      if (from) imageInfo.set(from.replace(/^File:/, ''), info);
    }
    for (const file of batch)
      if (!imageInfo.has(file)) imageInfo.set(file, null);
  }
}

/** Usable candidates, best first, each with why it scored as it did. */
function choosePhoto(candidates, stats, typeWords = []) {
  const ranked = [];
  for (const candidate of candidates) {
    const info = imageInfo.get(candidate.file);
    if (!info) continue;
    if (!/^image\/(jpeg|png|webp)$/.test(info.mime)) continue;
    const meta = info.extmetadata ?? {};
    const licence = normaliseLicence(meta);
    if (!licence) {
      stats.licenceRejected.push(
        `${candidate.file}: ${meta.LicenseShortName?.value ?? meta.License?.value ?? 'no licence'}`,
      );
      continue;
    }
    const author =
      stripHtml(meta.Artist?.value) ||
      stripHtml(meta.Credit?.value) ||
      (licence === 'PD' ? 'Unknown author' : '');
    if (!author) {
      stats.licenceRejected.push(`${candidate.file}: no author for ${licence}`);
      continue;
    }
    const text = `${candidate.file} ${stripHtml(meta.ImageDescription?.value)}`;
    const why = [candidate.origin];
    let score = candidate.prior;
    if (POSITIVE.test(text)) {
      score += 3;
      why.push('in-flight wording');
    } else if (SIDE.test(text)) {
      score += 2;
      why.push('side-view wording');
    }
    // Spotter photos are titled with the type or a registration; camera
    // default names (IMG_1234, DSC8255, 2017-12-03_15.35.45) are not.
    const title = normalise(candidate.file.replace(/\.[a-z]+$/i, ''));
    if (
      typeWords.some((word) => title.includes(word)) ||
      /\b[A-Z]{1,2}-[A-Z0-9]{3,5}\b|\bN\d{2,5}[A-Z]{0,2}\b/.test(candidate.file)
    ) {
      score += 2;
      why.push('title names the type or a registration');
    } else if (
      /^(?:img|dsc|dscf|dscn|pict?|p\d|_?\d)/i.test(candidate.file) ||
      !/[a-z]{3}/i.test(candidate.file.replace(/\.[a-z]+$/i, ''))
    ) {
      score -= 3;
      why.push('camera-default title');
    }
    if (NEGATIVE.test(candidate.file)) {
      score -= 6;
      why.push('detail/non-photo wording in title');
    }
    const ratio = info.width / info.height;
    if (ratio < 1) continue;
    if (ratio < 1.2 || ratio > 2.6) {
      score -= 3;
      why.push(`aspect ${ratio.toFixed(2)}`);
    }
    if (info.width < 480) score -= 4;
    ranked.push({ candidate, info, licence, author, score, why });
  }
  ranked.sort(
    (a, b) => b.score - a.score || cmp(a.candidate.file, b.candidate.file),
  );
  return ranked;
}

/** Scale to at most MAX_PHOTO_WIDTH px wide; sharp drops EXIF/XMP by default. */
async function encodeWebp(input, output) {
  const info = await sharp(input)
    .rotate()
    .resize({ width: MAX_PHOTO_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY, effort: 6 })
    .toFile(output);
  return { width: info.width, height: info.height };
}

// --- build ---------------------------------------------------------------------------------

async function build(args) {
  const frequency = JSON.parse(readFileSync(FREQUENCY_FILE, 'utf8'));
  const curated = JSON.parse(readFileSync(DESIGNATORS_FILE, 'utf8')).types;
  const doc8643 = await loadDoc8643();
  const wikipediaList = await loadWikipediaList();

  const civil = frequency.types.slice(0, args.top).map((type) => type.icao);
  const typeNames = new Map(frequency.types.map((t) => [t.icao, t.typeName]));
  let targets = [...new Set([...civil, ...Object.keys(curated)])].sort(cmp);
  if (args.only) targets = targets.filter((icao) => args.only.includes(icao));

  const notes = new Map(targets.map((icao) => [icao, []]));
  const docs = new Map();
  for (const icao of targets) {
    const docCode = curated[icao]?.docDesignator ?? icao;
    const rows = doc8643.get(docCode);
    if (rows) docs.set(icao, describeDoc(icao, rows));
    else notes.get(icao).push('not in ICAO Doc 8643');
    if (docCode !== icao)
      notes.get(icao).push(`ICAO Doc 8643 data from designator ${docCode}`);
  }

  // Designator -> base item: curated item, curated article, Wikipedia list.
  const base = new Map();
  const match = new Map();
  const articles = new Map();
  for (const icao of targets) {
    if (curated[icao]?.wikidata) {
      base.set(icao, curated[icao].wikidata);
      match.set(icao, 'curated item');
    } else if (curated[icao]?.article) {
      articles.set(icao, [curated[icao].article]);
      match.set(icao, 'curated article');
    } else if (wikipediaList.has(icao)) {
      articles.set(
        icao,
        wikipediaList.get(icao).map((row) => row.article),
      );
      match.set(icao, 'wikipedia designator list');
    }
  }
  const articleItems = await articlesToItems([...articles.values()].flat());
  for (const [icao, titles] of articles) {
    const items = [
      ...new Set(
        titles.map((title) => articleItems.get(title)).filter(Boolean),
      ),
    ];
    if (!items.length) {
      notes.get(icao).push(`no Wikidata item for article ${titles.join('; ')}`);
      match.delete(icao);
      continue;
    }
    if (items.length > 1)
      notes
        .get(icao)
        .push(
          `Wikipedia list links ${items.length} articles (${titles.join('; ')}); kept the first`,
        );
    base.set(icao, items[0]);
  }
  const aircraft = await aircraftItems([...base.values()]);
  for (const [icao, id] of base) {
    if (aircraft.has(id)) continue;
    notes.get(icao).push(`${id} is not an aircraft item; dropped`);
    base.delete(icao);
    match.delete(icao);
  }
  for (const icao of targets)
    if (!base.has(icao) && !curated[icao]?.article && !wikipediaList.has(icao))
      notes.get(icao).push('no article: add one to designators.json');

  // Base -> the subclass item naming this designator's model, when one does.
  await loadEntities([...base.values()]);
  const children = await childrenOf([...base.values()]);
  const chains = new Map();
  for (const [icao, id] of base) {
    const variant = pickVariant(
      id,
      label(id),
      docs.get(icao),
      children,
      notes.get(icao),
    );
    chains.set(icao, variant ? [variant, id] : [id]);
  }
  // A base with no variant falls back to its parent model or family
  // ("Cessna 210 Centurion" -> "Cessna 210"), never to a generic class.
  const parents = new Map();
  for (const [icao, ids] of chains)
    if (ids.length === 1) {
      const parent = claims(ids[0], 'P279').map((value) => value.id)[0];
      if (parent) parents.set(icao, parent);
    }
  await loadEntities([...parents.values()]);
  for (const [icao, parent] of parents)
    if (
      claims(parent, 'P31').some((value) =>
        AIRCRAFT_MODEL_ITEMS.includes(value.id),
      )
    )
      chains.get(icao).push(parent);
  await loadEntities([...chains.values()].map((ids) => ids[0]));
  await loadEntities(
    [...chains.values()].flatMap((ids) =>
      ids.flatMap((id) => claims(id, 'P176').map((value) => value.id)),
    ),
  );

  // Photo candidates.
  const typeWords = (icao) =>
    [docs.get(icao)?.modelToken, ...(chains.get(icao) ?? []).map(label)]
      .filter(Boolean)
      .flatMap((text) => text.split(/\s+/))
      .map(normalise)
      .filter((word) => /\d/.test(word) && word.length >= 3);
  const candidates = new Map();
  for (const icao of targets) {
    const list = [];
    const pinned = curated[icao]?.photo;
    if (pinned)
      list.push({
        file: pinned,
        prior: 20,
        origin: 'pinned in designators.json',
      });
    const ids = chains.get(icao) ?? [];
    ids.forEach((id, index) => {
      for (const file of claims(id, 'P18'))
        list.push({
          file,
          prior: 6 - 2 * index,
          origin: `P18 of ${id}${index === 0 && ids.length > 1 ? ' (variant)' : ''}`,
        });
    });
    candidates.set(icao, list);
  }
  await loadImageInfo([...candidates.values()].flat().map((c) => c.file));
  // Commons throttles anonymous clients hard, so a type lists its categories
  // only when no P18 photo is usable.
  for (const icao of targets) {
    if (
      choosePhoto(
        candidates.get(icao),
        { licenceRejected: [] },
        typeWords(icao),
      ).length
    )
      continue;
    const ids = chains.get(icao) ?? [];
    for (const [index, id] of ids.slice(0, 2).entries()) {
      for (const category of claims(id, 'P373').slice(0, 2)) {
        for (const { file, inFlight } of await categoryFiles(category))
          candidates.get(icao).push({
            file,
            prior: (index === 0 ? 1 : 0) + (inFlight ? 3 : 0),
            origin: `Commons category "${category}${inFlight ? ' in flight' : ''}"`,
          });
      }
    }
  }
  for (const [icao, list] of candidates) {
    const unique = new Map();
    for (const candidate of list)
      if (!unique.has(candidate.file)) unique.set(candidate.file, candidate);
    candidates.set(icao, [...unique.values()]);
  }
  await loadImageInfo([...candidates.values()].flat().map((c) => c.file));

  // Entries.
  mkdirSync(PHOTO_DIR, { recursive: true });
  const stats = {
    attempted: targets.length,
    withPhoto: 0,
    licenceRejected: [],
    licenceRejectedTypes: [],
    ambiguous: [],
    missingItem: [],
    missingPhoto: [],
  };
  const entries = [];
  const keepPhotos = new Set();
  for (const icao of targets) {
    const doc = docs.get(icao);
    const ids = chains.get(icao) ?? [];
    const head = ids[0];
    const typeStats = { licenceRejected: [] };
    const ranked = choosePhoto(
      candidates.get(icao) ?? [],
      typeStats,
      typeWords(icao),
    );
    if (args.explain?.includes(icao))
      for (const option of ranked.slice(0, 25))
        console.error(
          `${icao} ${option.score} ${option.licence} ${option.info.width}x${option.info.height} ${option.candidate.file} [${option.why.join('; ')}]`,
        );
    const chosen = ranked[0] ?? null;
    stats.licenceRejected.push(
      ...typeStats.licenceRejected.map((line) => `${icao} ${line}`),
    );
    const manufacturerId = ids
      .flatMap((id) => claims(id, 'P176').map((value) => value.id))
      .find(Boolean);
    const role = curated[icao]?.role ?? 'civil';
    const entry = {
      icao,
      name:
        curated[icao]?.name ??
        (head && label(head)) ??
        (doc
          ? `${doc.manufacturer} ${doc.model}`
          : (typeNames.get(icao) ?? icao)),
      manufacturer:
        (manufacturerId && label(manufacturerId)) ?? doc?.manufacturer ?? null,
      role,
      ...resolveClass(icao, doc, curated[icao]),
      ...collectSpecs(ids, doc),
      wikidata: head ?? null,
      match: match.get(icao) ?? null,
      photo: null,
    };
    if (chosen) {
      const source = path.join(
        CACHE_DIR,
        'bin',
        sha1(`GET ${chosen.info.thumburl ?? chosen.info.url}`),
      );
      await request(chosen.info.thumburl ?? chosen.info.url, { binary: true });
      const output = path.join(PHOTO_DIR, `${icao}.webp`);
      const { width, height } = await encodeWebp(source, output);
      keepPhotos.add(`${icao}.webp`);
      const meta = chosen.info.extmetadata ?? {};
      entry.photo = {
        path: `/aircraft-types/${icao}.webp`,
        width,
        height,
        author: chosen.author,
        licence: chosen.licence,
        licenceUrl: licenceUrlOf(chosen.licence),
        sourceUrl: chosen.info.descriptionurl,
        cropped: false,
        reason: chosen.why.join('; '),
      };
      stats.withPhoto++;
    } else {
      stats.missingPhoto.push(icao);
      if (typeStats.licenceRejected.length)
        stats.licenceRejectedTypes.push(icao);
    }
    if (!head) stats.missingItem.push(icao);
    if (notes.get(icao).length) {
      entry.notes = notes.get(icao);
      stats.ambiguous.push(icao);
    }
    entries.push(entry);
  }
  for (const file of readdirSync(PHOTO_DIR))
    if (!keepPhotos.has(file)) rmSync(path.join(PHOTO_DIR, file));

  const problems = validateCatalog(entries, {
    photoBytes: (publicPath) => {
      const file = path.join(ROOT, 'public', publicPath);
      return existsSync(file) ? statSync(file).size : null;
    },
  });
  if (problems.length) {
    console.error(problems.join('\n'));
    throw new Error(`${problems.length} catalog problems; nothing written`);
  }
  writeFileSync(CATALOG_FILE, `${JSON.stringify(entries, null, 2)}\n`);
  writeFileSync(CREDITS_FILE, renderCredits(entries));
  return { stats, entries };
}

function renderCredits(entries) {
  const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Aircraft photo credits',
    '',
    'Generated by `scripts/build-aircraft-catalog.mjs`; do not edit by hand.',
    '',
    'Each photo in `public/aircraft-types/` comes from Wikimedia Commons. It was',
    `scaled to at most ${MAX_PHOTO_WIDTH} px wide and re-encoded as WebP; nothing else was`,
    'changed. Each file stays under the licence listed for it. These credits do',
    'not imply endorsement by the authors.',
    '',
    '| Type | Aircraft | Author | Licence | Source |',
    '|---|---|---|---|---|',
  ];
  for (const entry of entries) {
    if (!entry.photo) continue;
    const { author, licence, licenceUrl, sourceUrl } = entry.photo;
    const licenceCell = licenceUrl ? `[${licence}](${licenceUrl})` : licence;
    lines.push(
      `| ${entry.icao} | ${cell(entry.name)} | ${cell(author)} | ${licenceCell} | [Commons file page](${sourceUrl}) |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// --- main -----------------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
offline = args.offline;
if (args.snapshot) {
  writeSnapshot(args.snapshot);
} else {
  const { stats, entries } = await build(args);
  const frequency = JSON.parse(readFileSync(FREQUENCY_FILE, 'utf8'));
  const withPhoto = new Set(entries.filter((e) => e.photo).map((e) => e.icao));
  const covered = frequency.types
    .filter((type) => withPhoto.has(type.icao))
    .reduce((sum, type) => sum + type.count, 0);
  const bytes = readdirSync(PHOTO_DIR).reduce(
    (sum, file) => sum + statSync(path.join(PHOTO_DIR, file)).size,
    0,
  );
  const licences = {};
  for (const entry of entries)
    if (entry.photo)
      licences[entry.photo.licence] = (licences[entry.photo.licence] ?? 0) + 1;
  const report = {
    attempted: stats.attempted,
    withPhoto: stats.withPhoto,
    licenceRejectedCandidates: stats.licenceRejected.length,
    typesWithOnlyRejectedCandidates: stats.licenceRejectedTypes,
    ambiguous: stats.ambiguous.length,
    missingItem: stats.missingItem,
    missingPhoto: stats.missingPhoto,
    coverage: `${((100 * covered) / frequency.withTypeCode).toFixed(2)}% of ${frequency.withTypeCode} airframes`,
    photoBytes: bytes,
    licences,
    http: httpStats,
  };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    REPORT_FILE,
    `${JSON.stringify({ ...report, licenceRejected: stats.licenceRejected }, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
}
