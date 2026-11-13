/**
 * Turn what a Data Library upstream returns into bounded GeoJSON features.
 *
 * Shared by the browser (browser-direct entries) and the server's generic
 * proxy (proxied entries), so a dataset looks the same whichever way it is
 * fetched. Pure: no fetch, no DOM. Callers own transport, caps on bytes and
 * cancellation; this module owns shape, coordinate sanity and feature caps.
 */

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);
const LAT_COLUMNS = ['lat', 'latitude', 'y'];
const LON_COLUMNS = ['lon', 'lng', 'long', 'longitude', 'x'];
const MAX_DETAIL_CHARS = 80;
const MAX_NAME_CHARS = 120;

/** Error for an upstream body that is not the declared format. */
export class LibraryFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LibraryFormatError';
    this.code = 'malformed';
  }
}

const validPosition = (position) =>
  Array.isArray(position) &&
  position.length >= 2 &&
  Number.isFinite(position[0]) &&
  Number.isFinite(position[1]) &&
  Math.abs(position[0]) <= 180 &&
  Math.abs(position[1]) <= 90;

function validCoordinates(type, coordinates, depth = 0) {
  if (!Array.isArray(coordinates) || depth > 4) return false;
  if (type === 'Point') return validPosition(coordinates);
  if (type === 'MultiPoint' || type === 'LineString')
    return coordinates.length > 0 && coordinates.every(validPosition);
  if (type === 'MultiLineString' || type === 'Polygon')
    return (
      coordinates.length > 0 &&
      coordinates.every((ring) => validCoordinates('LineString', ring))
    );
  if (type === 'MultiPolygon')
    return (
      coordinates.length > 0 &&
      coordinates.every((polygon) => validCoordinates('Polygon', polygon))
    );
  return false;
}

/** Only real, in-range geometries survive; everything else is dropped. */
export function validLibraryGeometry(geometry) {
  return (
    Boolean(geometry) &&
    GEOMETRY_TYPES.has(geometry.type) &&
    validCoordinates(geometry.type, geometry.coordinates)
  );
}

function cleanValue(value, max) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || text === 'null' || text === 'undefined') return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function readPath(properties, path) {
  let value = properties;
  for (const part of String(path).split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = value[part];
  }
  return value;
}

/**
 * Give a feature the presentation fields the map reads: `name` for its label
 * and `__gevDetails` (up to two lines) for its card. Upstream properties are
 * kept as they are; feed data is never translated.
 * @param {object} properties
 * @param {{ label?: string, fields?: string[] }} display
 * @returns {object}
 */
export function presentLibraryProperties(properties, display = {}) {
  const source =
    properties && typeof properties === 'object' && !Array.isArray(properties)
      ? properties
      : {};
  const result = { ...source };
  const label = display.label
    ? cleanValue(readPath(source, display.label), MAX_NAME_CHARS)
    : cleanValue(source.name ?? source.title, MAX_NAME_CHARS);
  if (label) result.name = label;
  else delete result.name;
  const details = [];
  for (const field of display.fields || []) {
    const value = cleanValue(readPath(source, field), MAX_DETAIL_CHARS);
    if (value) details.push(`${field.split('.').pop()}: ${value}`);
    if (details.length === 2) break;
  }
  result.__gevDetails = details;
  // The value a colorBy legend groups on, flattened so nested fields
  // (EONET's categories.0.title) colour the same in every renderer.
  if (display.colorBy)
    result.__gevColorKey = cleanValue(
      readPath(source, display.colorBy.field),
      MAX_NAME_CHARS,
    );
  return result;
}

/** Highest importance a manifest rank can add (below the named/unnamed gap). */
export const LIBRARY_RANK_MAX = 600;

function rankValue(properties, field) {
  const raw = readPath(properties, field);
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const number = Number(raw);
  if (Number.isFinite(number)) return number;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : null;
}

/**
 * Order candidates by the manifest's importance field, most important first,
 * so a capped dataset keeps its top features and the map's level of detail
 * can prefer them. Features without a value keep their order, last.
 * @param {object[]} features
 * @param {{ field: string, order?: 'desc'|'asc' }} rank
 * @returns {Array<{ feature: object, value: number|null }>}
 */
function rankCandidates(features, rank) {
  const sign = rank.order === 'asc' ? 1 : -1;
  return features
    .map((feature, index) => ({
      feature,
      index,
      value: rankValue(feature?.properties, rank.field),
    }))
    .sort((a, b) => {
      if (a.value === null || b.value === null)
        return (a.value === null) - (b.value === null) || a.index - b.index;
      return sign * (a.value - b.value) || a.index - b.index;
    });
}

/**
 * Bound and present a list of candidate features.
 * @param {unknown[]} candidates
 * @param {{ maxFeatures: number, display?: object }} options
 * @returns {{ features: object[], dropped: number, truncated: boolean }}
 */
export function boundLibraryFeatures(candidates, { maxFeatures, display }) {
  const valid = [];
  let dropped = 0;
  for (const candidate of candidates) {
    if (validLibraryGeometry(candidate?.geometry)) valid.push(candidate);
    else dropped += 1;
  }
  const ranked = display?.rank
    ? rankCandidates(valid, display.rank)
    : valid.map((feature) => ({ feature, value: null }));
  const kept = ranked.slice(0, maxFeatures);
  const scored = kept.filter(({ value }) => value !== null).length;
  const features = kept.map(({ feature, value }, position) => {
    const properties = presentLibraryProperties(feature.properties, display);
    // Importance for the map's level of detail: the top feature earns the
    // most, the least important ranked feature none.
    if (display?.rank)
      properties.__gevRank =
        value === null || scored < 2
          ? 0
          : Math.round(LIBRARY_RANK_MAX * (1 - position / (scored - 1)));
    return { type: 'Feature', geometry: feature.geometry, properties };
  });
  return { features, dropped, truncated: ranked.length > maxFeatures };
}

function geojsonCandidates(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload?.type === 'FeatureCollection' && Array.isArray(payload.features))
    return payload.features;
  if (payload?.type === 'Feature') return [payload];
  throw new LibraryFormatError('not a GeoJSON FeatureCollection');
}

/** Parse JSON text, reporting a format error rather than a SyntaxError. */
export function parseLibraryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new LibraryFormatError('response is not JSON');
  }
}

/**
 * Split CSV text into rows (RFC 4180: quoted fields, doubled quotes, CRLF).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text).replace(/^﻿/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new LibraryFormatError('unterminated quoted CSV field');
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

function csvCandidates(text, columns) {
  const rows = parseCsvRows(text);
  if (rows.length < 1) throw new LibraryFormatError('CSV has no header');
  const header = rows[0].map((name) => name.trim());
  const lower = header.map((name) => name.toLowerCase());
  const find = (explicit, fallbacks) =>
    explicit
      ? header.indexOf(explicit)
      : lower.findIndex((name) => fallbacks.includes(name));
  const latIndex = find(columns?.lat, LAT_COLUMNS);
  const lonIndex = find(columns?.lon, LON_COLUMNS);
  if (latIndex < 0 || lonIndex < 0)
    throw new LibraryFormatError('CSV has no latitude/longitude columns');
  return rows.slice(1).map((values) => {
    const properties = {};
    header.forEach((name, index) => {
      if (index !== latIndex && index !== lonIndex && name)
        properties[name] = values[index] ?? '';
    });
    const lat = Number.parseFloat(values[latIndex]);
    const lon = Number.parseFloat(values[lonIndex]);
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties,
    };
  });
}

/**
 * Point features from a JSON array of records (an API that answers
 * `{ "stations": [{ "lat": …, "lng": … }] }` rather than GeoJSON).
 * @param {unknown} payload Parsed JSON.
 * @param {{ records?: string, columns?: { lat: string, lon: string } }} source
 */
function jsonCandidates(payload, { records, columns } = {}) {
  const list = records ? readPath(payload, records) : payload;
  if (!Array.isArray(list))
    throw new LibraryFormatError('JSON has no record list at source.records');
  const pick = (record, explicit, fallbacks) => {
    if (explicit) return explicit;
    return Object.keys(record).find((key) =>
      fallbacks.includes(key.toLowerCase()),
    );
  };
  return list.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record))
      return { geometry: null };
    const latKey = pick(record, columns?.lat, LAT_COLUMNS);
    const lonKey = pick(record, columns?.lon, LON_COLUMNS);
    const properties = {};
    for (const [key, value] of Object.entries(record))
      if (key !== latKey && key !== lonKey) properties[key] = value;
    return {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [
          Number.parseFloat(record[lonKey]),
          Number.parseFloat(record[latKey]),
        ],
      },
      properties,
    };
  });
}

/**
 * Parse one upstream body in a declared vector format.
 * @param {'geojson'|'geojsonl'|'csv'|'json'|'arcgis'} format
 * @param {string} text
 * @param {{ columns?: { lat: string, lon: string }, records?: string }} [source]
 * @returns {{ candidates: unknown[], exceededTransferLimit: boolean }}
 */
export function parseLibraryBody(format, text, source = {}) {
  if (format === 'csv')
    return {
      candidates: csvCandidates(text, source.columns),
      exceededTransferLimit: false,
    };
  if (format === 'geojsonl') {
    const candidates = String(text)
      .split('\n')
      .filter((line) => line.trim())
      .map(parseLibraryJson);
    return { candidates, exceededTransferLimit: false };
  }
  const payload = parseLibraryJson(text);
  if (format === 'json')
    return {
      candidates: jsonCandidates(payload, source),
      exceededTransferLimit: false,
    };
  if (format === 'arcgis' && payload?.error)
    throw new LibraryFormatError('ArcGIS service returned an error');
  return {
    candidates: geojsonCandidates(payload),
    exceededTransferLimit:
      format === 'arcgis' &&
      (payload?.exceededTransferLimit === true ||
        payload?.properties?.exceededTransferLimit === true),
  };
}

/**
 * The ArcGIS FeatureServer query URL for one page. The manifest's query may
 * set `where` and `outFields`; geometry is always WGS84 GeoJSON.
 * @param {string} layerUrl `.../FeatureServer/<n>` or `.../MapServer/<n>`.
 * @param {Record<string,string>|undefined} query
 * @param {number} offset
 * @param {number} pageSize
 * @returns {string}
 */
export function arcgisPageUrl(
  layerUrl,
  query = {},
  offset = 0,
  pageSize = 2000,
  bbox = null,
) {
  const url = new URL(`${String(layerUrl).replace(/\/+$/, '')}/query`);
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    ...query,
    outSR: '4326',
    f: 'geojson',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
    // A view-bounded load asks for what intersects the camera's box only.
    ...(bbox
      ? {
          geometry: bbox.map((value) => value.toFixed(6)).join(','),
          geometryType: 'esriGeometryEnvelope',
          inSR: '4326',
          spatialRel: 'esriSpatialRelIntersects',
        }
      : {}),
  });
  url.search = params.toString();
  return url.href;
}

/**
 * The URL to request for a non-ArcGIS dataset: the manifest URL plus its
 * declared query parameters.
 * @param {{ url: string, query?: Record<string,string> }} source
 * @returns {string}
 */
export function datasetRequestUrl(source) {
  const url = new URL(source.url);
  for (const [name, value] of Object.entries(source.query || {}))
    url.searchParams.set(name, value);
  return url.href;
}

/**
 * Fetch and normalize a whole dataset through a caller-supplied page reader,
 * following ArcGIS paging. The reader returns one page's text and owns byte
 * caps, redirects and cancellation.
 * @param {object} entry A validated library entry (kind dataset).
 * @param {(url: string, budget: { remainingBytes: number }) => Promise<string>} readPage
 * @param {{ bbox?: number[]|null }} [options] A view-bounded ArcGIS load's
 *   `[west, south, east, north]`.
 * @returns {Promise<{ type: 'FeatureCollection', features: object[], dropped: number, truncated: boolean }>}
 */
export async function loadLibraryDataset(
  entry,
  readPage,
  { bbox = null } = {},
) {
  const { source, display } = entry;
  const budget = { remainingBytes: source.maxBytes };
  const candidates = [];
  let truncated = false;
  if (source.format === 'arcgis') {
    for (let page = 0; page < source.maxPages; page++) {
      const url = arcgisPageUrl(
        source.url,
        source.query,
        candidates.length,
        2000,
        bbox,
      );
      const parsed = parseLibraryBody('arcgis', await readPage(url, budget));
      candidates.push(...parsed.candidates);
      if (!parsed.exceededTransferLimit || !parsed.candidates.length) break;
      // The upstream holds more than was read: stopping here, at the
      // feature cap or the last page, leaves the dataset partial.
      if (
        candidates.length >= source.maxFeatures ||
        page === source.maxPages - 1
      ) {
        truncated = true;
        break;
      }
    }
  } else {
    const parsed = parseLibraryBody(
      source.format,
      await readPage(datasetRequestUrl(source), budget),
      source,
    );
    candidates.push(...parsed.candidates);
  }
  const bounded = boundLibraryFeatures(candidates, {
    maxFeatures: source.maxFeatures,
    display,
  });
  return {
    type: 'FeatureCollection',
    features: bounded.features,
    dropped: bounded.dropped,
    truncated: truncated || bounded.truncated,
  };
}
