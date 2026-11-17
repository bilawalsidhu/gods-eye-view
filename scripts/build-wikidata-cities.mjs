#!/usr/bin/env node
/**
 * Build the bundled world cities pack read by `src/data/wikidataCities.js`:
 *
 *   src/data/local_data/wikidata_cities/cities.json
 *
 * Source: Wikidata (CC0), read once from the public query service at build
 * time. The app itself never calls Wikidata: it reads this file.
 *
 * What goes in: items that are a human settlement (an instance of any subclass
 * of Q486972), have coordinates (P625) and a population (P1082) at or above
 * the cut-off. Each row keeps the English label, coordinates to three
 * decimals, the largest stated population, the ISO 3166-1 alpha-2 country
 * code and the Wikidata id. Groupings of settlements (metropolitan areas,
 * agglomerations, conurbations) and places that no longer stand are left out.
 *
 * The query service limits each query to 60 s, so the population range is
 * read in bands without labels, the settlement test runs here against the
 * class list, and labels and countries are read afterwards in batches. One
 * request runs at a time, with a pause between requests, and a refusal's
 * Retry-After is honoured.
 *
 * Usage:
 *   node scripts/build-wikidata-cities.mjs [--min-population 15000]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT =
  'gods-eye-view-places-builder/0.2 (offline data pack; one-off build; https://github.com/bilawalsidhu/gods-eye-view)';
const SETTLEMENT = 'Q486972';
const PAUSE_MS = 1500;
const LABEL_BATCH = 400;

const args = process.argv.slice(2);
const flag = (name) =>
  args.includes(name) ? Number(args[args.indexOf(name) + 1]) : NaN;
const minPopulation = flag('--min-population') || 15000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src/data/local_data/wikidata_cities');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const qid = (uri) => uri.slice(uri.lastIndexOf('/') + 1);

/** The service ran out of time on a query: a smaller one may still answer. */
class QueryTimeout extends Error {}

async function sparql(query, attempt = 1) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `query=${encodeURIComponent(query)}`,
      // The service stops a query at 60 s; past that the answer is lost.
      signal: AbortSignal.timeout(90000),
    });
  } catch (error) {
    // Our own time limit: the query is too big, as with a 504.
    if (error.name === 'TimeoutError' && attempt >= 2)
      throw new QueryTimeout('Wikidata did not answer in time');
    if (attempt >= 4) throw error;
    console.warn(`  ${error.message}; waiting ${20 * attempt} s`);
    await sleep(20000 * attempt);
    return sparql(query, attempt + 1);
  }
  if (response.status === 504 && attempt >= 2)
    throw new QueryTimeout('Wikidata answered 504');
  // A malformed query fails the same way every time.
  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 429
  )
    throw new Error(
      `Wikidata answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  if (!response.ok) {
    if (attempt >= 4) throw new Error(`Wikidata answered ${response.status}`);
    const wait =
      Number(response.headers.get('retry-after')) * 1000 || 20000 * attempt;
    console.warn(`  ${response.status}; waiting ${Math.round(wait / 1000)} s`);
    await sleep(wait);
    return sparql(query, attempt + 1);
  }
  // The service can stop a long answer partway; that arrives as broken JSON.
  let rows;
  try {
    rows = JSON.parse(await response.text()).results.bindings;
  } catch (error) {
    // The service stops a query that runs too long partway through its answer.
    if (attempt >= 2)
      throw new QueryTimeout(`Wikidata answer was cut short: ${error.message}`);
    console.warn(`  answer cut short; waiting ${20 * attempt} s`);
    await sleep(20000 * attempt);
    return sparql(query, attempt + 1);
  }
  await sleep(PAUSE_MS);
  return rows;
}

/**
 * Population bands, narrow where places are many, so each answer stays well
 * under the service's 60 s limit (about 35,000 places a band).
 */
function bands(min, max) {
  const stepAt = (pop) =>
    pop < 2000
      ? 200
      : pop < 5000
        ? 500
        : pop < 10000
          ? 1000
          : pop < 20000
            ? 2500
            : pop < 30000
              ? 10000
              : pop < 50000
                ? 20000
                : pop < 100000
                  ? 50000
                  : Infinity;
  const list = [];
  for (let low = min; low < max;) {
    const high = Math.min(max, low + stepAt(low));
    list.push([low, high]);
    low = high;
  }
  return list;
}

console.log('Settlement classes…');
const classes = new Set(
  (await sparql(`SELECT ?c WHERE { ?c wdt:P279* wd:${SETTLEMENT} }`)).map(
    (row) => qid(row.c.value),
  ),
);
console.log(`  ${classes.size} classes`);

// Groupings of settlements (metropolitan areas, agglomerations, conurbations,
// capital regions)
// are settlements in Wikidata too, and are left out so a view is named after
// the city rather than the area around it. An item stated as one of these
// classes goes, whatever else it is ("New York metropolitan area" is also a
// megacity). An item of a narrower kind only goes when it is nothing else:
// Istanbul is a "metropolitan municipality in Turkey", a kind of
// metropolitan area, and a megacity, so it stays.
const GROUPING_TREES = [
  'Q1907114', // metropolitan area
  'Q159313', // urban agglomeration
  'Q245260', // conurbation
  'Q1062177', // capital region
  'Q1768043', // metropolitan statistical area
  'Q3175539', // functional urban area
];
// Left out as stated only: "city in the United States" is a subclass of
// these, so their subclasses must stay.
const GROUPING_CLASSES = [
  'Q702492', // urban area
  'Q2342385', // urban area (statistical)
  'Q5951278', // urban area of the United States
];
// Places that no longer stand as settlements (former entities, ghost towns,
// abandoned villages, archaeological sites) are settlements in Wikidata too.
// An item typed only as one of these, with every subclass, is left out; one
// that is also a living settlement (a city that is also a former capital)
// stays.
const HISTORICAL_TREES = [
  'Q15893266', // former entity
  'Q19953632', // former administrative territorial entity
  'Q74047', // ghost town
  'Q350895', // abandoned village
  'Q839954', // archaeological site
];
const former = new Set(
  (
    await sparql(
      `SELECT ?c WHERE { VALUES ?top { ${HISTORICAL_TREES.map((id) => `wd:${id}`).join(' ')} } ?c wdt:P279* ?top }`,
    )
  ).map((row) => qid(row.c.value)),
);
console.log(`  ${former.size} former-place classes`);
const groupings = new Set([
  ...(
    await sparql(
      `SELECT ?c WHERE { VALUES ?top { ${GROUPING_TREES.map((id) => `wd:${id}`).join(' ')} } ?c wdt:P279* ?top }`,
    )
  ).map((row) => qid(row.c.value)),
  ...GROUPING_CLASSES,
]);
console.log(`  ${groupings.size} grouping classes left out`);
// A band's rows; one the service cannot answer in time is asked again in two
// halves.
async function bandRows(low, high) {
  const range = Number.isFinite(high)
    ? `?pop >= ${low} && ?pop < ${high}`
    : `?pop >= ${low}`;
  try {
    return await sparql(
      `SELECT ?item ?pop ?coord ?type WHERE { ?item wdt:P1082 ?pop . FILTER(${range}) ?item wdt:P625 ?coord ; wdt:P31 ?type . }`,
    );
  } catch (error) {
    const mid = Number.isFinite(high) ? Math.round((low + high) / 2) : low * 4;
    if (!(error instanceof QueryTimeout) || mid <= low || mid === high)
      throw error;
    console.warn(`  splitting ${low}–${high} at ${mid}`);
    return [...(await bandRows(low, mid)), ...(await bandRows(mid, high))];
  }
}

const GROUPING_STATED = new Set([...GROUPING_TREES, ...GROUPING_CLASSES]);
const living = new Set();
const stated = new Set();
const grouped = new Set();
const settled = new Set();

const places = new Map();
for (const [low, high] of bands(minPopulation, Infinity)) {
  console.log(`Population ${low}–${Number.isFinite(high) ? high : '∞'}…`);
  const rows = await bandRows(low, high);
  let kept = 0;
  for (const row of rows) {
    const type = qid(row.type.value);
    if (GROUPING_STATED.has(type)) stated.add(qid(row.item.value));
    if (groupings.has(type)) grouped.add(qid(row.item.value));
    if (!classes.has(type)) continue;
    if (!groupings.has(type) && !former.has(type))
      settled.add(qid(row.item.value));
    if (!former.has(type)) living.add(qid(row.item.value));
    const match = /^Point\(([-\d.eE]+) ([-\d.eE]+)\)$/.exec(row.coord.value);
    if (!match) continue;
    const id = qid(row.item.value);
    const pop = Math.round(Number(row.pop.value));
    const known = places.get(id);
    if (known) {
      known.pop = Math.max(known.pop, pop);
      // Of several stated coordinates, the same one on every build.
      const lon = Number(match[1]);
      const lat = Number(match[2]);
      if (lat < known.lat || (lat === known.lat && lon < known.lon)) {
        known.lat = lat;
        known.lon = lon;
      }
      continue;
    }
    places.set(id, { id, pop, lon: Number(match[1]), lat: Number(match[2]) });
    kept++;
  }
  console.log(`  ${rows.length} rows, ${kept} new settlements`);
}

let groupingsLeftOut = 0;
for (const id of grouped) {
  if ((settled.has(id) && !stated.has(id)) || !places.delete(id)) continue;
  groupingsLeftOut++;
}
console.log(`${groupingsLeftOut} groupings left out`);
// A place typed only as a former kind is held until its end date is known: a
// unit dissolved in a recent reform still stands (below).
for (const [id, place] of places) if (!living.has(id)) place.formerOnly = true;
const ids = [...places.keys()];
console.log(`Labels and countries for ${ids.length} places…`);
for (let start = 0; start < ids.length; start += LABEL_BATCH) {
  const values = ids
    .slice(start, start + LABEL_BATCH)
    .map((id) => `wd:${id}`)
    .join(' ');
  const rows = await sparql(
    `SELECT ?item ?label ?iso ?ended WHERE { VALUES ?item { ${values} } OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") } OPTIONAL { ?item wdt:P17 ?country . ?country wdt:P297 ?iso } OPTIONAL { ?item wdt:P576 ?ended } }`,
  );
  for (const row of rows) {
    const place = places.get(qid(row.item.value));
    if (!place) continue;
    if (row.label && !place.name) place.name = row.label.value;
    // Of several stated countries, the same one on every build.
    if (row.iso && (!place.cc || row.iso.value < place.cc))
      place.cc = row.iso.value;
    // Dissolved, abolished or merged as a unit (P576), and when.
    if (row.ended) {
      place.ended = true;
      const year = Number(/^-?\d+/.exec(row.ended.value)?.[0]);
      if (Number.isFinite(year))
        place.endedYear = Math.max(place.endedYear ?? -Infinity, year);
    }
  }
  if ((start / LABEL_BATCH) % 10 === 0)
    console.log(
      `  ${Math.min(start + LABEL_BATCH, ids.length)} / ${ids.length}`,
    );
}

// A dissolved place goes only where another place still names the spot (a
// city merged into its neighbour, a former district inside its city). Where
// nothing else does, the town is still there under its name and stays: many
// of Vietnam's provincial cities ended as units in 2025, and with them their
// class, so they are typed only as a former kind. A place typed only as a
// former kind stays only that way: dissolved within the last ten years with
// nothing else near it. Ghost towns and ancient cities go.
const SUCCESSOR_KM = 15;
const RECENT_YEARS = 10;
const recent = new Date().getUTCFullYear() - RECENT_YEARS;
const standing = [...places.values()].filter(
  (place) => place.name && !place.ended && !place.formerOnly,
);
const near = (a, b) => {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))) <= SUCCESSOR_KM;
};
const byCell = new Map();
const cellOf = (lat, lon) => `${Math.floor(lat)},${Math.floor(lon)}`;
for (const place of standing) {
  const key = cellOf(place.lat, place.lon);
  if (!byCell.has(key)) byCell.set(key, []);
  byCell.get(key).push(place);
}
let dissolved = 0;
let formerOnly = 0;
for (const [id, place] of places) {
  if (place.formerOnly && !(place.ended && place.endedYear >= recent)) {
    places.delete(id);
    formerOnly++;
    continue;
  }
  if (!place.ended) continue;
  let succeeded = false;
  for (let dLat = -1; dLat <= 1 && !succeeded; dLat++)
    for (let dLon = -1; dLon <= 1 && !succeeded; dLon++)
      succeeded = (
        byCell.get(cellOf(place.lat + dLat, place.lon + dLon)) || []
      ).some((other) => near(place, other));
  if (succeeded) dissolved++;
  else place.ended = false;
}
console.log(`${formerOnly} former places left out`);
console.log(`${dissolved} dissolved places left out`);

// A place whose stated country is a former one (no ISO code) takes the
// country of the area it lies in, one area level up at a time (a path of
// several levels in one query runs past the service's time limit).
const COUNTRY_BATCH = 50;
const countryless = () =>
  [...places.values()]
    .filter((place) => place.name && !place.cc && !place.ended)
    .map((place) => place.id);
for (const hops of [1, 2, 3]) {
  const ids = countryless();
  if (!ids.length) break;
  console.log(`Countries ${hops} area level(s) up for ${ids.length} places…`);
  const pathToArea = Array.from({ length: hops }, () => 'wdt:P131').join('/');
  for (let start = 0; start < ids.length; start += COUNTRY_BATCH) {
    const values = ids
      .slice(start, start + COUNTRY_BATCH)
      .map((id) => `wd:${id}`)
      .join(' ');
    const rows = await sparql(
      `SELECT ?item ?iso WHERE { VALUES ?item { ${values} } ?item ${pathToArea} ?area . ?area wdt:P17 ?country . ?country wdt:P297 ?iso }`,
    );
    for (const row of rows) {
      const place = places.get(qid(row.item.value));
      if (!place || (place.cc && place.hops !== hops)) continue;
      if (!place.cc || row.iso.value < place.cc) {
        place.cc = row.iso.value;
        place.hops = hops;
      }
    }
  }
}
console.log(`  ${countryless().length} places still without a country`);

const rows = [...places.values()]
  .filter(
    (place) =>
      place.name &&
      !place.ended &&
      Math.abs(place.lat) <= 90 &&
      Math.abs(place.lon) <= 180,
  )
  .sort((a, b) => b.pop - a.pop || a.id.localeCompare(b.id))
  .map((place) => [
    place.name,
    Number(place.lat.toFixed(3)),
    Number(place.lon.toFixed(3)),
    place.pop,
    place.cc || '',
    place.id,
  ]);

// A filter that is too wide drops real cities without any error; these must
// survive, and no settlement grouping may.
const MUST_HAVE = {
  Q1490: 'Tokyo',
  Q84: 'London',
  Q16559: 'Austin',
  Q16555: 'Houston',
  Q1355: 'Bengaluru',
  Q3630: 'Jakarta',
  Q174: 'São Paulo',
  Q34600: 'Kyoto',
  Q656: 'Saint Petersburg',
  Q406: 'Istanbul',
  Q8678: 'Rio de Janeiro',
  Q1345: 'Philadelphia',
  Q586: 'Bonn',
  Q1449: 'Genoa',
  Q1563: 'Havana',
  // Provincial cities dissolved as units in 2025 that still stand.
  Q19491: 'Nha Trang',
  Q36081: 'Quy Nhon',
};
// Groupings that are also typed as cities; none may get in.
const MUST_NOT = {
  Q683705: 'New York metropolitan area',
  Q665894: 'Greater Mexico City',
  Q13580: 'Metro Manila',
  Q3114019: 'Katowice urban area',
};
const present = new Set(rows.map((row) => row[5]));
const missing = Object.entries(MUST_HAVE).filter(([id]) => !present.has(id));
const intruders = Object.entries(MUST_NOT).filter(([id]) => present.has(id));
if (intruders.length) {
  throw new Error(
    `Groupings got in: ${intruders.map(([id, name]) => `${name} (${id})`).join(', ')}`,
  );
}
if (missing.length) {
  throw new Error(
    `Expected cities are missing: ${missing.map(([id, name]) => `${name} (${id})`).join(', ')}`,
  );
}

const meta = {
  source: 'Wikidata (https://www.wikidata.org), via the Wikidata Query Service',
  license: 'CC0 1.0',
  built: new Date().toISOString(),
  minPopulation,
  count: rows.length,
  columns: ['name', 'lat', 'lon', 'population', 'country', 'wikidata'],
};

await mkdir(outDir, { recursive: true });
const file = path.join(outDir, 'cities.json');
await writeFile(file, `${JSON.stringify({ meta, rows })}\n`);
console.log(`Wrote ${rows.length} places to ${path.relative(root, file)}`);
