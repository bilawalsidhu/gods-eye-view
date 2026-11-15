// Shared by the server proxy (server/providers/shipwrecks.js) and the browser
// layer, so it must not load the i18n catalogs: values stay data.

/** EMODnet Human Activities "Cultural Heritage – Ship wrecks" (CC BY 4.0). */
export const EMODNET_WFS_URL =
  'https://ows.emodnet-humanactivities.eu/wfs?service=WFS&request=GetFeature' +
  '&version=2.0.0&typeNames=emodnet:heritageshipwrecks' +
  '&outputFormat=application/json&srsName=EPSG:4326';
/** Landing page shown when an EMODnet wreck has no web page of its own. */
export const EMODNET_PAGE_URL =
  'https://emodnet.ec.europa.eu/en/human-activities';

export const SHIPWRECK_SOURCES = Object.freeze(['emodnet', 'wikidata']);

/**
 * Wikidata (CC0): shipwreck items that have at least one Wikipedia article,
 * so the worldwide set stays to notable wrecks and skips bulk register
 * imports, plus sinking events ("sinking of the RMS Titanic"), which are where
 * Wikidata keeps the death toll. Dates, the end of service (P576) included,
 * come with their precision so a month-precise date is not shown as the 1st.
 * Only ship and event facts are read: no items about people.
 */
export const WIKIDATA_QUERY = `SELECT ?item ?itemLabel ?itemDescription ?coord ?sunk ?sunkPrecision ?end ?endPrecision ?deaths ?survivors ?typeLabel ?enwiki ?event WHERE {
  {
    ?item wdt:P31/wdt:P279* wd:Q852190 ; wdt:P625 ?coord ; wikibase:sitelinks ?links .
    FILTER(?links > 0)
    OPTIONAL { ?item p:P793 ?wreck . ?wreck ps:P793 wd:Q906512 ; pqv:P585 [ wikibase:timeValue ?sunk ; wikibase:timePrecision ?sunkPrecision ] }
    OPTIONAL { ?item p:P576 [ a wikibase:BestRank ; psv:P576 [ wikibase:timeValue ?end ; wikibase:timePrecision ?endPrecision ] ] }
    OPTIONAL { ?item wdt:P31 ?type . FILTER(?type != wd:Q852190) }
  } UNION {
    ?item wdt:P31/wdt:P279* wd:Q906512 ; wdt:P625 ?coord .
    BIND("event" AS ?event)
    OPTIONAL { ?item p:P585/psv:P585 [ wikibase:timeValue ?sunk ; wikibase:timePrecision ?sunkPrecision ] }
    OPTIONAL { ?item wdt:P1561 ?survivors }
  }
  OPTIONAL { ?item wdt:P1120 ?deaths }
  OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,fr,de,es,it,pt,ru,uk,ja,zh,ar". }
}`;

const MAX_TEXT = 160;
const MAX_NOTE = 260;
/** Same name within this distance: one wreck seen by both sources. */
const SAME_WRECK_KM = 3;

// Free text sometimes names people (owners, masters, divers who reported a
// wreck). The layer is about ships, so text that refers to a person by a title
// or role is dropped whole. This is a keyword filter: a bare name with none of
// these words still passes.
const PERSON_TEXT =
  /\b(mr|mrs|ms|dr|capt|captain|master|skipper|owner|owned|crew|body|bodies|drowned|reported by|according to)\b/i;

/** EMODnet writes "n/a" or nothing where a value is unknown. */
function clean(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/[\u0000-\u001f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /^(n\/a|null|unknown|none|-)$/i.test(text)) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Free text with none of the person keywords in it, or null. */
function impersonalText(value, max) {
  const text = clean(value, max);
  return text && !PERSON_TEXT.test(text) ? text : null;
}

function positiveNumber(value, max) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 && n <= max ? n : null;
}

function count(value) {
  const text = String(value ?? '').replace(/\.0+$/, '');
  if (!/^\d{1,6}$/.test(text)) return null;
  return Number(text);
}

/** A sinking year from "1917", "1917-1918" or "c. 1917"; null otherwise. */
export function parseYear(value, maxYear = new Date().getUTCFullYear()) {
  const match = /(?:^|\D)(\d{3,4})(?:\D|$)/.exec(String(value ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 100 && year <= maxYear ? year : null;
}

function validPoint(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function httpUrl(value) {
  const text = clean(value, 400);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Whether a provenance or link value points at wrecksite.eu, in any form. */
function fromWrecksite(value) {
  return typeof value === 'string' && /wrecksite/i.test(value);
}

/**
 * Normalize EMODnet's shipwreck GeoJSON. Records the portal took from
 * wrecksite.eu, named in the provenance or linked as the record's page, are
 * skipped: that site's data is not openly licensed.
 * @param {object} payload WFS GeoJSON FeatureCollection.
 * @returns {object[]} Shipwreck records.
 */
export function normalizeEmodnetFeatures(payload) {
  const features = payload?.features;
  if (!Array.isArray(features)) return [];
  const out = [];
  const ids = new Set();
  for (const feature of features) {
    const p = feature?.properties || {};
    const coords = feature?.geometry?.coordinates;
    if (feature?.geometry?.type !== 'Point' || !Array.isArray(coords)) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!validPoint(lat, lon)) continue;
    // Checked on the raw values: the shown origin is cut to 80 characters,
    // and a long provenance list can name wrecksite.eu after the cut.
    if (fromWrecksite(p.source_inf) || fromWrecksite(p.website1)) continue;
    const origin = clean(p.source_inf, 80);
    const key = clean(String(feature.id ?? p.source_id ?? ''), 80);
    if (!key) continue;
    const id = `emodnet:${key}`;
    if (ids.has(id)) continue;
    ids.add(id);
    const year = parseYear(p.sink_yr);
    const dating = clean(p.dating, 60);
    const period = clean(p.period, 60);
    const vesselType =
      clean(p.obj_type, 60) ||
      (() => {
        // ship_char is sometimes a short type ("Trawler"), sometimes a long
        // history that can name people; only the short form is a type.
        const text = clean(p.ship_char, 40);
        return text && !/\d/.test(text) && !PERSON_TEXT.test(text)
          ? text
          : null;
      })();
    out.push({
      id,
      source: 'emodnet',
      lat,
      lon,
      name: clean(p.name, 100),
      vesselType,
      year,
      date: null,
      dating: year ? null : dating,
      ancient: !year && Boolean(period || dating),
      cause: impersonalText(p.sink_context, MAX_NOTE),
      notes: period && dating ? `${period} (${dating})` : period,
      cargo: impersonalText(p.artefacts, 120),
      protected: /protected/i.test(p.statutory || ''),
      depth: positiveNumber(p.least_depth, 11000),
      depthQuality: clean(p.depth_prec, 80),
      positionAccuracy: positiveNumber(p.loc_prec, 100000),
      positionNote: /centroid/i.test(p.point_info || '')
        ? 'Centre of the protected area'
        : null,
      casualties: null,
      survivors: null,
      country: clean(p.country, 60),
      originator: origin,
      url: httpUrl(p.website1),
    });
  }
  return out;
}

function wikiUrl(value) {
  const url = httpUrl(value);
  return url && /^https:\/\/[a-z]{2,3}\.wikipedia\.org\/wiki\//.test(url)
    ? url
    : null;
}

/**
 * A Wikidata time as a day ("1912-04-15") when it is day-precise, else as a
 * year only: a month- or year-precise value reads back as the 1st. A year
 * before AD 100 ("-0299", 300 BC) has no place on the year picker, so it is
 * kept as ancient with its year as text, like EMODnet's period-dated wrecks.
 * @returns {{date: string|null, year: number|null, dating: string|null}}
 */
function wikidataTime(value, precision) {
  const none = { date: null, year: null, dating: null };
  const match = /^([+-]?)(\d{4,})-(\d{2})-(\d{2})T/.exec(value || '');
  if (!match) return none;
  // A value without a precision is only trusted to the year.
  const p = precision == null ? 9 : Number(precision);
  // 11 = day; 10 = month; 9 = year; below 9 is a decade or coarser.
  if (!Number.isFinite(p) || p < 9) return none;
  const signed = Number(`${match[1] === '-' ? '-' : ''}${match[2]}`);
  if (signed < 100) {
    // The query service writes XSD 1.1 years: 0000 is 1 BC, -0299 is 300 BC.
    const dating = signed <= 0 ? `${1 - signed} BC` : `AD ${signed}`;
    return { date: null, year: null, dating };
  }
  const year = parseYear(String(signed));
  if (year === null) return none;
  if (p >= 11)
    return { date: `${match[2]}-${match[3]}-${match[4]}`, year, dating: null };
  return { date: null, year, dating: null };
}

/** Whether a record (or a parsed time) says when the ship sank. */
function hasWhen(when) {
  return Boolean(when.date || Number.isInteger(when.year) || when.dating);
}

/** Copy when a ship sank from one record (or parsed time) to another. */
function takeWhen(target, from) {
  target.date = from.date ?? null;
  target.year = from.year ?? null;
  target.dating = from.dating ?? null;
  target.ancient = Boolean(from.dating) || Boolean(from.ancient);
}

/** "sinking of the RMS Titanic" → "Sinking of the RMS Titanic". */
function sentenceCase(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Normalize Wikidata SPARQL results to shipwreck records (one per item).
 * Sinking events are folded into the ship they sank when both are listed.
 * @param {object} payload SPARQL JSON results.
 * @returns {object[]}
 */
export function normalizeWikidataResults(payload) {
  const bindings = payload?.results?.bindings;
  if (!Array.isArray(bindings)) return [];
  const byItem = new Map();
  for (const binding of bindings) {
    const value = (key) => binding?.[key]?.value;
    const qid = /\/entity\/(Q\d{1,12})$/.exec(value('item') || '')?.[1];
    if (!qid) continue;
    const sunk = wikidataTime(value('sunk'), value('sunkPrecision'));
    const ended = wikidataTime(value('end'), value('endPrecision'));
    const known = byItem.get(qid);
    if (known) {
      // Extra rows only add what the first one lacked.
      known.vesselType ||= clean(value('typeLabel'), 60);
      if (!hasWhen(known)) takeWhen(known, hasWhen(sunk) ? sunk : ended);
      known.casualties ??= count(value('deaths'));
      known.survivors ??= count(value('survivors'));
      continue;
    }
    const point = /^Point\(([-\d.eE]+) ([-\d.eE]+)\)$/.exec(
      value('coord') || '',
    );
    const lon = point ? Number(point[1]) : NaN;
    const lat = point ? Number(point[2]) : NaN;
    if (!validPoint(lat, lon)) continue;
    const name = clean(value('itemLabel'), 100);
    const event = value('event') === 'event';
    const when = hasWhen(sunk) ? sunk : ended;
    byItem.set(qid, {
      id: `wikidata:${qid}`,
      source: 'wikidata',
      event,
      lat,
      lon,
      // An unlabelled item reads back as its own Q-id; that is no name.
      name: name && name !== qid ? (event ? sentenceCase(name) : name) : null,
      vesselType: event ? null : clean(value('typeLabel'), 60),
      year: when.year,
      date: when.date,
      dating: when.dating,
      ancient: Boolean(when.dating),
      cause: null,
      notes: impersonalText(value('itemDescription'), MAX_TEXT),
      cargo: null,
      protected: false,
      depth: null,
      depthQuality: null,
      positionAccuracy: null,
      positionNote: null,
      casualties: count(value('deaths')),
      survivors: count(value('survivors')),
      country: null,
      originator: null,
      url:
        // English Wikipedia, else the Wikidata item, which links the
        // article in every language that has one.
        wikiUrl(value('enwiki')) || `https://www.wikidata.org/wiki/${qid}`,
    });
  }
  return foldSinkingEvents([...byItem.values()]);
}

/** An event this far from a listed ship whose name it contains is that ship's sinking. */
const SAME_SINKING_KM = 50;

/**
 * "Sinking of the RMS Titanic" near the RMS Titanic wreck is one marker: the
 * ship keeps its article and takes the event's date, deaths and survivors.
 */
function foldSinkingEvents(records) {
  // Wikidata sometimes has both the ship and its wreck as items at one spot
  // ("Titanic", "wreck of the RMS Titanic"): keep the ship, one marker.
  const isWreckItem = (record) => (/^wreck\b/i.test(record.name || '') ? 1 : 0);
  const ships = [];
  const candidates = records
    .filter((record) => !record.event)
    .sort((a, b) => isWreckItem(a) - isWreckItem(b));
  for (const record of candidates) {
    const key = nameKey(record.name);
    const twin =
      key &&
      ships.find(
        (ship) =>
          nameKey(ship.name) === key &&
          distanceKm(ship, record) <= SAME_WRECK_KM,
      );
    if (!twin) {
      ships.push(record);
      continue;
    }
    twin.vesselType ||= record.vesselType;
    if (!hasWhen(twin)) takeWhen(twin, record);
    twin.casualties ??= record.casualties;
    twin.survivors ??= record.survivors;
  }
  const out = [...ships];
  for (const event of records.filter((record) => record.event)) {
    const eventKey = ` ${nameKey(event.name)} `;
    const ship = ships.find((candidate) => {
      const key = nameKey(candidate.name);
      return (
        key.length >= 3 &&
        eventKey.includes(` ${key} `) &&
        distanceKm(candidate, event) <= SAME_SINKING_KM
      );
    });
    if (!ship) {
      out.push(event);
      continue;
    }
    if (!hasWhen(ship)) {
      takeWhen(ship, event);
    } else if (!ship.date && event.date && event.year === ship.year) {
      ship.date = event.date;
    }
    ship.casualties ??= event.casualties;
    ship.survivors ??= event.survivors;
  }
  for (const record of out) delete record.event;
  return out;
}

function nameKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(wreck|sinking|loss|disaster|of)\b/g, ' ')
    .replace(
      /\b(hms|hmt|hmhs|hmas|sms|ss|ms|mv|rms|uss|hm|s\/s|m\/v|the)\b/g,
      ' ',
    )
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * One list from both sources. A wreck in both (same name, a few km apart)
 * keeps the Wikidata record, which links an article, and takes EMODnet's
 * survey facts (depth, sinking text, year) that Wikidata lacks.
 */
export function mergeShipwreckRecords(emodnet = [], wikidata = []) {
  const byName = new Map();
  for (const record of wikidata) {
    const key = nameKey(record.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(record);
  }
  const kept = [];
  for (const record of emodnet) {
    const twin = (byName.get(nameKey(record.name)) || []).find(
      (candidate) => distanceKm(candidate, record) <= SAME_WRECK_KM,
    );
    if (!twin) {
      kept.push(record);
      continue;
    }
    if (!hasWhen(twin)) takeWhen(twin, record);
    twin.vesselType ||= record.vesselType;
    twin.cause ||= record.cause;
    twin.depth ??= record.depth;
    twin.depthQuality ||= record.depthQuality;
    twin.positionAccuracy ??= record.positionAccuracy;
    twin.country ||= record.country;
    twin.protected ||= record.protected;
    twin.alsoIn = 'emodnet';
  }
  return [...wikidata, ...kept];
}

/**
 * Validate the proxy's snapshot in the browser.
 * @returns {object[]|null} Records, or null when the payload is malformed.
 */
export function normalizeShipwreckSnapshot(payload) {
  if (!Array.isArray(payload?.records)) return null;
  const rows = [];
  const ids = new Set();
  for (const record of payload.records) {
    if (
      !record ||
      typeof record.id !== 'string' ||
      ids.has(record.id) ||
      !SHIPWRECK_SOURCES.includes(record.source) ||
      !validPoint(record.lat, record.lon)
    )
      continue;
    ids.add(record.id);
    rows.push({
      ...record,
      year: Number.isInteger(record.year) ? record.year : null,
      url: httpUrl(record.url),
    });
  }
  return rows;
}
