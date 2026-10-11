/**
 * Pure Wikidata query builders and SPARQL-JSON parsers for the Metro layer.
 *
 * Acquisition is two-step, following the Wikidata "Metro station of city"
 * example: first resolve the cities in view to their Wikidata item ids, then
 * ask for the metro stations (Q928830 and subclasses) located in those items.
 */

export const METRO_STATION_CLASS = 'Q928830';
export const CITY_CLASS = 'Q515';
/** Smallest place population treated as a city that may own a metro. */
export const MIN_CITY_POPULATION = 50_000;
/** Cities resolved per view (largest first); each bounds the station query. */
export const MAX_CITIES_PER_VIEW = 6;
export const MAX_STATIONS_PER_QUERY = 3000;
/** Views wider or taller than this (degrees) ask the operator to zoom in. */
export const MAX_VIEW_SPAN_DEG = 1.5;
/** City lookups snap to this grid so small pans reuse the same answer. */
export const CITY_BOX_SNAP_DEG = 0.25;
export const DEFAULT_STATION_COLOR = '#f5f5f5';
/** Adjacent stations farther apart than this are treated as bad data. */
export const MAX_SEGMENT_KM = 15;

const QID_PATTERN = /^Q[1-9]\d{0,11}$/;
const ENTITY_PREFIX = 'http://www.wikidata.org/entity/';

/** Extract a bare Q-id from a Wikidata entity URI or id, or null. */
export function qidFromEntity(value) {
  const text = String(value ?? '').trim();
  const id = text.startsWith(ENTITY_PREFIX)
    ? text.slice(ENTITY_PREFIX.length)
    : text;
  return QID_PATTERN.test(id) ? id : null;
}

/** Parse a WKT `Point(lon lat)` literal into finite degrees, or null. */
export function parseWktPoint(value) {
  const match = /^\s*Point\(\s*(\S+)\s+(\S+)\s*\)\s*$/.exec(
    String(value ?? ''),
  );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lon, lat };
}

/** Normalize a Wikidata sRGB (P465) value to `#rrggbb`, or null. */
export function normalizeLineColor(value) {
  const hex = String(value ?? '')
    .trim()
    .replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

function finiteBox(box) {
  return Boolean(
    box &&
    [box.west, box.south, box.east, box.north].every(Number.isFinite) &&
    box.north > box.south &&
    box.east > box.west,
  );
}

/** Whether a view box is small enough for a city lookup. */
export function isViewQueryable(box) {
  return (
    finiteBox(box) &&
    box.east - box.west <= MAX_VIEW_SPAN_DEG &&
    box.north - box.south <= MAX_VIEW_SPAN_DEG
  );
}

/** Expand a box outward to the city-lookup grid so nearby views share a key. */
export function snapCityBox(box, step = CITY_BOX_SNAP_DEG) {
  if (!finiteBox(box)) return null;
  const down = (v) => Math.floor(v / step) * step;
  const up = (v) => Math.ceil(v / step) * step;
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return {
    west: round(Math.max(-180, down(box.west))),
    south: round(Math.max(-90, down(box.south))),
    east: round(Math.min(180, up(box.east))),
    north: round(Math.min(90, up(box.north))),
  };
}

export function cityBoxKey(box) {
  return [box.west, box.south, box.east, box.north].join(',');
}

const wktPoint = (lon, lat) => `"Point(${lon} ${lat})"^^geo:wktLiteral`;

/**
 * SPARQL for the most populous cities whose coordinates fall inside `box`.
 * @param {{west:number,south:number,east:number,north:number}} box
 */
export function buildCitiesQuery(box, { limit = MAX_CITIES_PER_VIEW } = {}) {
  if (!finiteBox(box)) throw new TypeError('A finite view box is required');
  const count = Math.max(1, Math.min(20, Math.floor(limit)));
  return `SELECT ?city (SAMPLE(?label) AS ?name) (MAX(?pop) AS ?population) (SAMPLE(?coord) AS ?location) WHERE {
  SERVICE wikibase:box {
    ?city wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest ${wktPoint(box.west, box.south)} .
    bd:serviceParam wikibase:cornerNorthEast ${wktPoint(box.east, box.north)} .
  }
  ?city wdt:P1082 ?pop .
  FILTER(?pop >= ${MIN_CITY_POPULATION})
  FILTER EXISTS { ?city wdt:P31/wdt:P279* wd:${CITY_CLASS} . }
  OPTIONAL { ?city rdfs:label ?label . FILTER(LANG(?label) = "en") }
}
GROUP BY ?city
ORDER BY DESC(?population)
LIMIT ${count}`;
}

/**
 * SPARQL for open metro stations located in any of `cityIds`, with each
 * station's lines (`id~rgb~label`) and adjacent stations (`id~lineId`, P197
 * with its P81 qualifier) packed into `|`-separated strings.
 *
 * The documented example walks `wdt:P131*` from the city, which times out for
 * large cities (New York, Tokyo, London). A bounded one-to-four hop walk from
 * each station, geared forward, answers the same question in a few seconds.
 * @param {string[]} cityIds Wikidata Q-ids.
 */
export function buildStationsQuery(cityIds) {
  const ids = [...new Set((cityIds || []).map(qidFromEntity))].filter(Boolean);
  if (!ids.length) throw new TypeError('At least one city id is required');
  return `SELECT ?station ?stationLabel ?coord ?city (GROUP_CONCAT(DISTINCT ?lineInfo; separator="|") AS ?lineData) (GROUP_CONCAT(DISTINCT ?adjInfo; separator="|") AS ?adjacent) WHERE {
  { SELECT DISTINCT ?station ?coord ?city WHERE {
      VALUES ?city { ${ids.map((id) => `wd:${id}`).join(' ')} }
      ?station wdt:P31/wdt:P279* wd:${METRO_STATION_CLASS} .
      ?station wdt:P131/wdt:P131?/wdt:P131?/wdt:P131? ?city .
      hint:Prior hint:gearing "forward" .
      ?station wdt:P625 ?coord .
      FILTER NOT EXISTS { ?station wdt:P576 [] . }
      FILTER NOT EXISTS { ?station wdt:P3999 [] . }
    } LIMIT ${MAX_STATIONS_PER_QUERY} }
  OPTIONAL {
    ?station wdt:P81 ?line .
    OPTIONAL { ?line wdt:P465 ?rgb . }
    OPTIONAL { ?line rdfs:label ?lineLabel . FILTER(LANG(?lineLabel) = "en") }
    BIND(CONCAT(STRAFTER(STR(?line), "entity/"), "~", COALESCE(?rgb, ""), "~", COALESCE(?lineLabel, "")) AS ?lineInfo)
  }
  OPTIONAL {
    ?station p:P197 ?adjStmt .
    ?adjStmt ps:P197 ?adj .
    OPTIONAL { ?adjStmt pq:P81 ?adjLine . }
    BIND(CONCAT(STRAFTER(STR(?adj), "entity/"), "~", COALESCE(STRAFTER(STR(?adjLine), "entity/"), "")) AS ?adjInfo)
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". ?station rdfs:label ?stationLabel . }
}
GROUP BY ?station ?stationLabel ?coord ?city`;
}

function bindings(json) {
  const rows = json?.results?.bindings;
  if (!Array.isArray(rows)) throw new Error('Malformed Wikidata response');
  return rows;
}

const cellText = (cell) =>
  typeof cell?.value === 'string' ? cell.value.trim() : '';

const packed = (cell) =>
  cellText(cell)
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

/** Parse `id~rgb~label` line entries, unique by line id. */
function parseLineRefs(cell) {
  const byId = new Map();
  for (const entry of packed(cell)) {
    const [rawId, rgb, ...label] = entry.split('~');
    const id = qidFromEntity(rawId);
    if (!id) continue;
    const previous = byId.get(id);
    byId.set(id, {
      id,
      name: label.join('~').trim() || previous?.name || id,
      color: normalizeLineColor(rgb) || previous?.color || null,
    });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse `stationId~lineId` adjacency entries; the line is optional. */
function parseAdjacent(cell, selfId) {
  const seen = new Set();
  const adjacent = [];
  for (const entry of packed(cell)) {
    const [rawId, rawLine] = entry.split('~');
    const id = qidFromEntity(rawId);
    if (!id || id === selfId) continue;
    const lineId = qidFromEntity(rawLine);
    const key = `${id}~${lineId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    adjacent.push({ id, lineId });
  }
  return adjacent;
}

/** Parse the cities query into `{ id, name, population, lon, lat }` rows. */
export function parseCities(json) {
  const seen = new Set();
  const cities = [];
  for (const row of bindings(json)) {
    const id = qidFromEntity(cellText(row.city));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const location = parseWktPoint(cellText(row.location));
    const population = Number(cellText(row.population));
    cities.push({
      id,
      name: cellText(row.name) || id,
      population: Number.isFinite(population) ? population : null,
      lon: location?.lon ?? null,
      lat: location?.lat ?? null,
    });
  }
  return cities;
}

/**
 * Parse the stations query into a Map of city id → station records.
 * Every requested city gets an entry (possibly empty) so an answered city
 * is never re-queried just because Wikidata has no stations for it.
 */
export function parseStations(json, requestedCityIds = []) {
  const byCity = new Map();
  for (const id of requestedCityIds) {
    const qid = qidFromEntity(id);
    if (qid) byCity.set(qid, []);
  }
  for (const row of bindings(json)) {
    const cityId = qidFromEntity(cellText(row.city));
    const id = qidFromEntity(cellText(row.station));
    const position = parseWktPoint(cellText(row.coord));
    if (!cityId || !id || !position) continue;
    const name = cellText(row.stationLabel);
    const lineRefs = parseLineRefs(row.lineData);
    if (!byCity.has(cityId)) byCity.set(cityId, []);
    byCity.get(cityId).push({
      id,
      name: name && name !== id ? name : 'Unnamed station',
      lon: position.lon,
      lat: position.lat,
      lines: lineRefs.map((line) => line.name),
      lineRefs,
      adjacent: parseAdjacent(row.adjacent, id),
      color: lineRefs.find((line) => line.color)?.color || null,
      url: `https://www.wikidata.org/wiki/${id}?origin=*`,
    });
  }
  return byCity;
}

/** Union per-city station lists into one list, unique by station id. */
export function mergeStations(lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const station of list || []) {
      if (!byId.has(station.id)) byId.set(station.id, station);
    }
  }
  return [...byId.values()];
}

/** Count stations per line, with each line's own P465 colour. */
export function summarizeLines(stations, limit = 8) {
  const lines = new Map();
  for (const station of stations) {
    for (const line of station.lineRefs || []) {
      const entry = lines.get(line.id) || {
        name: line.name,
        color: null,
        count: 0,
      };
      entry.count += 1;
      entry.color ||= line.color;
      lines.set(line.id, entry);
    }
  }
  return [...lines.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Track segments between adjacent loaded stations, one per station pair and
 * line, coloured by that line. An adjacency without a line qualifier takes
 * the line both stations share; neighbours outside the loaded set are skipped.
 * @returns {Array<{id:string, from:object, to:object, lineId:?string, color:string}>}
 */
export function buildLineSegments(stations) {
  const byId = new Map();
  const lineColors = new Map();
  for (const station of stations || []) {
    byId.set(station.id, station);
    for (const line of station.lineRefs || [])
      if (line.color && !lineColors.has(line.id))
        lineColors.set(line.id, line.color);
  }
  const segments = new Map();
  for (const from of byId.values()) {
    for (const { id, lineId } of from.adjacent || []) {
      const to = byId.get(id);
      if (!to || distanceKm(from, to) > MAX_SEGMENT_KM) continue;
      const toLines = new Set((to.lineRefs || []).map((line) => line.id));
      const line =
        lineId ||
        (from.lineRefs || []).find((ref) => toLines.has(ref.id))?.id ||
        null;
      const [a, b] = from.id < to.id ? [from, to] : [to, from];
      const key = `${a.id}-${b.id}~${line || ''}`;
      if (segments.has(key)) continue;
      segments.set(key, {
        id: key,
        from: a,
        to: b,
        lineId: line,
        color:
          (line && lineColors.get(line)) ||
          from.color ||
          to.color ||
          DEFAULT_STATION_COLOR,
      });
    }
  }
  // A pair already drawn for a named line needs no unqualified duplicate.
  for (const [key, segment] of segments) {
    if (segment.lineId) continue;
    const pair = key.slice(0, key.indexOf('~'));
    for (const other of segments.keys())
      if (other !== key && other.startsWith(`${pair}~`)) {
        segments.delete(key);
        break;
      }
  }
  return [...segments.values()];
}
