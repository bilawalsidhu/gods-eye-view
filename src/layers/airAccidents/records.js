// Shared by the server proxy (server/providers/airAccidents.js) and the
// browser layer, so it must not load the i18n catalogs: values stay data.

const MAX_TEXT = 120;

function clean(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f<>]/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function int(value, min = 0, max = 100000) {
  const text = clean(String(value ?? '').replace(/\.0+$/, ''));
  if (text === null || !/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/** Aviation Safety Network record page for its accident id (Wikidata P1755). */
export const ASN_RECORD_URL =
  'https://aviation-safety.net/database/record.php?id=';

// The properties of the event itself; never people (victims, crew).
const FIELDS = `
  OPTIONAL { ?item wdt:P585 ?date }
  OPTIONAL { ?item wdt:P1120 ?deaths }
  OPTIONAL { ?item wdt:P1339 ?injured }
  OPTIONAL { ?item wdt:P1561 ?survivors }
  OPTIONAL { ?item wdt:P137 ?operator }
  OPTIONAL { ?item wdt:P1876|wdt:P121 ?vehicle }
  OPTIONAL { ?item wdt:P1427 ?origin }
  OPTIONAL { ?item wdt:P1444 ?destination }
  OPTIONAL { ?item wdt:P3090 ?flight }
  OPTIONAL { ?item wdt:P426 ?registration }
  OPTIONAL { ?item wdt:P1755 ?asn }
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}`;
const SELECT =
  'SELECT ?item ?itemLabel ?date ?coord ?placeLabel ?countryLabel ?deaths ?injured ?survivors ?operatorLabel ?vehicleLabel ?originLabel ?destinationLabel ?flight ?registration ?asn ?enwiki WHERE {';

/**
 * Wikidata aviation accidents (Q744913 and its subclasses) with a coordinate
 * of their own. One query for both kinds of position runs past the query
 * service's 60 s limit, so they are two.
 */
export const WIKIDATA_QUERY = `${SELECT}
  ?item wdt:P31/wdt:P279* wd:Q744913 ; wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P276 ?place }${FIELDS}`;

/**
 * Accidents without a coordinate, placed at their location item (P276): an
 * airport, a mountain, a town. Their markers are approximate.
 */
export const WIKIDATA_PLACED_QUERY = `${SELECT}
  ?item wdt:P31/wdt:P279* wd:Q744913 ; wdt:P276 ?place .
  FILTER NOT EXISTS { ?item wdt:P625 [] }
  ?place wdt:P625 ?coord .${FIELDS}`;

function wikiUrl(value) {
  const text = clean(value, 400);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname === 'en.wikipedia.org'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function asnUrl(value) {
  const id = clean(value, 20);
  return id && /^\d{8}-\d{1,2}$/.test(id) ? `${ASN_RECORD_URL}${id}` : null;
}

/**
 * Wikidata often names one aircraft at several levels ("Boeing 747-100" and
 * "Boeing 747"), so the values read as one line, and a name that only starts
 * another one is dropped.
 * @param {string[]} models
 * @returns {string|null}
 */
function vehicleText(models) {
  const kept = models.filter(
    (model) =>
      !models.some((other) => other !== model && other.startsWith(model)),
  );
  return kept.length ? kept.join(' / ') : null;
}

/**
 * One record per Wikidata accident item from a SPARQL JSON result. Only the
 * event's own properties are read (never victims or crew items).
 * @param {object} payload SPARQL results JSON.
 * @param {{approximate?: boolean}} [options] `approximate`: the coordinates
 *   are the location item's, not the accident's own.
 * @returns {object[]}
 */
export function normalizeWikidataResults(
  payload,
  { approximate = false } = {},
) {
  const bindings = payload?.results?.bindings;
  if (!Array.isArray(bindings)) return [];
  const byItem = new Map();
  const models = new Map();
  for (const binding of bindings) {
    const value = (key) => binding?.[key]?.value;
    const qid = /\/entity\/(Q\d{1,12})$/.exec(value('item') || '')?.[1];
    if (!qid) continue;
    const label = (key) => {
      const text = clean(value(key), 80);
      // An unlabelled item reads back as its Q-id; that is no name.
      return text && !/^Q\d+$/.test(text) ? text : null;
    };
    const known = byItem.get(qid);
    if (known) {
      // Each extra row carries another value of a many-valued property.
      const model = label('vehicleLabel');
      if (model) models.get(qid).add(model);
      continue;
    }
    const point = /^Point\(([-\d.eE]+) ([-\d.eE]+)\)$/.exec(
      value('coord') || '',
    );
    const lon = point ? Number(point[1]) : NaN;
    const lat = point ? Number(point[2]) : NaN;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    const name = label('itemLabel');
    const date = /^(-?\d{4})-(\d{2})-(\d{2})T/.exec(value('date') || '');
    const model = label('vehicleLabel');
    models.set(qid, new Set(model ? [model] : []));
    byItem.set(qid, {
      id: `wikidata:${qid}`,
      lat,
      lon,
      approximate,
      date: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
      place: label('placeLabel'),
      country: label('countryLabel'),
      fatalities: int(value('deaths')),
      injuries: int(value('injured')),
      survivors: int(value('survivors')),
      aircraft: null,
      name,
      operator: label('operatorLabel'),
      flight: clean(value('flight'), 20),
      registration: clean(value('registration'), 20),
      origin: label('originLabel'),
      destination: label('destinationLabel'),
      url:
        wikiUrl(value('enwiki')) ||
        asnUrl(value('asn')) ||
        `https://www.wikidata.org/wiki/${qid}`,
    });
  }
  for (const [qid, record] of byItem)
    record.aircraft = vehicleText([...models.get(qid)]);
  return [...byItem.values()];
}

/**
 * Join the two query results; an item in both keeps its own coordinate.
 * @param {object[]} own Records with the accident's own coordinate.
 * @param {object[]} placed Records placed at their location item.
 * @returns {object[]}
 */
export function mergeAirAccidentRecords(own = [], placed = []) {
  const ids = new Set(own.map((record) => record.id));
  return [...own, ...placed.filter((record) => !ids.has(record.id))];
}

const TEXT_FIELDS = Object.freeze([
  'date',
  'place',
  'country',
  'aircraft',
  'name',
  'operator',
  'flight',
  'registration',
  'origin',
  'destination',
  'url',
]);
const COUNT_FIELDS = Object.freeze(['fatalities', 'injuries', 'survivors']);

/**
 * Validate the proxy's snapshot in the browser before it replaces the shown
 * one; rows that do not fit are dropped, a malformed payload is rejected.
 * @param {object} payload
 * @returns {object[]|null}
 */
export function normalizeAirAccidentSnapshot(payload) {
  if (!Array.isArray(payload?.records)) return null;
  const rows = [];
  const ids = new Set();
  for (const record of payload.records) {
    if (
      !record ||
      typeof record.id !== 'string' ||
      !/^wikidata:Q\d{1,12}$/.test(record.id) ||
      ids.has(record.id) ||
      !Number.isFinite(record.lat) ||
      !Number.isFinite(record.lon) ||
      Math.abs(record.lat) > 90 ||
      Math.abs(record.lon) > 180
    )
      continue;
    ids.add(record.id);
    const row = {
      id: record.id,
      lat: record.lat,
      lon: record.lon,
      approximate: record.approximate === true,
    };
    for (const key of TEXT_FIELDS)
      row[key] = typeof record[key] === 'string' ? record[key] : null;
    for (const key of COUNT_FIELDS)
      row[key] =
        Number.isInteger(record[key]) && record[key] >= 0 ? record[key] : null;
    // Only article, ASN and Wikidata links open from a card.
    if (
      row.url &&
      !/^https:\/\/(en\.wikipedia\.org|aviation-safety\.net|www\.wikidata\.org)\//.test(
        row.url,
      )
    )
      row.url = null;
    rows.push(row);
  }
  return spreadStackedRecords(rows);
}

// About 3 km between neighbours: apart once the camera is low enough to tell
// them apart, close enough to stay on the same airport or town.
const SPREAD_DEGREES = 0.03;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Accidents placed at the same location item (an airport, a region) share one
 * coordinate (or one within about 100 m), so only the top marker could be clicked. Keep the first record
 * of each stack (one with its own coordinate when there is one) and lay the
 * rest on a small spiral around it.
 * @param {object[]} records
 * @returns {object[]}
 */
export function spreadStackedRecords(records) {
  const stacks = new Map();
  for (const record of records) {
    const key = `${record.lat.toFixed(3)},${record.lon.toFixed(3)}`;
    const stack = stacks.get(key);
    if (stack) stack.push(record);
    else stacks.set(key, [record]);
  }
  for (const stack of stacks.values()) {
    if (stack.length < 2) continue;
    stack.sort((a, b) => Number(a.approximate) - Number(b.approximate));
    const [{ lat, lon }] = stack;
    const lonScale = 1 / Math.max(Math.cos((lat * Math.PI) / 180), 0.1);
    stack.slice(1).forEach((record, index) => {
      const radius = SPREAD_DEGREES * Math.sqrt(index + 1);
      const angle = (index + 1) * GOLDEN_ANGLE;
      record.lat = Math.max(-90, Math.min(90, lat + radius * Math.sin(angle)));
      record.lon =
        ((lon + radius * Math.cos(angle) * lonScale + 540) % 360) - 180;
    });
  }
  return records;
}
