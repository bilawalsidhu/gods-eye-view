// Shared by the server proxy (server/providers/airAccidents.js) and the
// browser layer, so it must not load the i18n catalogs: values stay data.

/** Brazilian CENIPA open-data tables the proxy reads (DEDALO host, ODbL). */
export const CENIPA_BASE_URL = 'https://dedalo.sti.fab.mil.br/dadosabertos/';
/** CENIPA's public page for final reports (searched by report number). */
export const CENIPA_REPORTS_URL =
  'https://sistema.cenipa.fab.mil.br/cenipa/paginas/relatorios/relatorios.php';

export const AIR_ACCIDENT_KINDS = Object.freeze([
  'accident',
  'serious-incident',
]);

const CENIPA_KIND = Object.freeze({
  ACIDENTE: 'accident',
  'INCIDENTE GRAVE': 'serious-incident',
});

const MAX_TEXT = 120;
const MAX_AIRCRAFT = 4;
const MAX_EVENTS = 4;

/** CENIPA writes "***", "NULL" or nothing where a value is unknown. */
function clean(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f<>]/g, ' ').trim();
  if (!text || text === '***' || /^null$/i.test(text) || /^\*+$/.test(text))
    return null;
  return text.length > max ? text.slice(0, max) : text;
}

function int(value, min = 0, max = 100000) {
  const text = clean(String(value ?? ''));
  if (text === null || !/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

function coordinate(value, limit) {
  const text = clean(String(value ?? ''));
  if (text === null) return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) && Math.abs(n) <= limit && n !== 0 ? n : null;
}

/**
 * Split CENIPA's semicolon-separated tables into objects keyed by the header.
 * Quoted fields may hold the separator; doubled quotes escape a quote.
 * @param {string} text Decoded CSV text.
 * @returns {Array<Record<string, string>>}
 */
export function parseSemicolonCsv(text) {
  if (typeof text !== 'string') return [];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ';') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((key) => key.trim().replace(/^﻿/, ''));
  return body.map((values) =>
    Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ''])),
  );
}

/** "19/04/2026" → "2026-04-19"; null when it is not a calendar date. */
function isoDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(clean(value) || '');
  if (!match) return null;
  const [, day, month, year] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(time);
  if (date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

function hhmm(value) {
  const match = /^(\d{2}):(\d{2})/.exec(clean(value) || '');
  return match && Number(match[1]) < 24 && Number(match[2]) < 60
    ? `${match[1]}:${match[2]}`
    : null;
}

/**
 * Join CENIPA's occurrence, aircraft and occurrence-type tables into one
 * record per accident or serious incident with a position. Only technical
 * columns are read: the tables hold no names, and none are kept.
 * @param {{occurrences: object[], aircraft: object[], types: object[]}} tables
 * @returns {object[]}
 */
export function normalizeCenipaTables({
  occurrences = [],
  aircraft = [],
  types = [],
} = {}) {
  const aircraftByCode = new Map();
  for (const row of aircraft) {
    const code = clean(row.codigo_ocorrencia2);
    if (!code) continue;
    const list = aircraftByCode.get(code) || [];
    if (list.length >= MAX_AIRCRAFT) continue;
    list.push({
      registration: clean(row.aeronave_matricula, 12),
      category: clean(row.aeronave_tipo_equipamento, 40),
      maker: clean(row.aeronave_fabricante, 60),
      model: clean(row.aeronave_modelo, 40),
      icaoType: clean(row.aeronave_tipo_icao, 8),
      year: int(row.aeronave_ano_fabricacao, 1900, 2100),
      phase: clean(row.aeronave_fase_operacao, 60),
      operation: clean(row.aeronave_tipo_operacao, 40),
      damage: clean(row.aeronave_nivel_dano, 30),
      fatalities: int(row.aeronave_fatalidades_total, 0, 1000),
    });
    aircraftByCode.set(code, list);
  }
  const eventsByCode = new Map();
  for (const row of types) {
    const code = clean(row.codigo_ocorrencia1);
    const label = clean(row.ocorrencia_tipo, 90);
    if (!code || !label) continue;
    const list = eventsByCode.get(code) || [];
    if (list.length >= MAX_EVENTS || list.some((e) => e.label === label))
      continue;
    list.push({ label, icao: clean(row.taxonomia_tipo_icao, 16) });
    eventsByCode.set(code, list);
  }

  const records = [];
  const seen = new Set();
  for (const row of occurrences) {
    const kind = CENIPA_KIND[clean(row.ocorrencia_classificacao)];
    const id = clean(row.codigo_ocorrencia, 12);
    const lat = coordinate(row.ocorrencia_latitude, 90);
    const lon = coordinate(row.ocorrencia_longitude, 180);
    const date = isoDate(row.ocorrencia_dia);
    if (!kind || !id || lat === null || lon === null || !date) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const planes = aircraftByCode.get(clean(row.codigo_ocorrencia2)) || [];
    const known = planes.filter((plane) => plane.fatalities !== null);
    const published = clean(row.divulgacao_relatorio_publicado) === 'SIM';
    const status = clean(row.investigacao_status);
    records.push({
      id: `cenipa:${id}`,
      source: 'cenipa',
      kind,
      lat,
      lon,
      date,
      time: hhmm(row.ocorrencia_hora),
      city: clean(row.ocorrencia_cidade, 60),
      state: clean(row.ocorrencia_uf, 4),
      country: clean(row.ocorrencia_pais, 40),
      aerodrome: clean(row.ocorrencia_aerodromo, 8),
      approximate: false,
      fatalities: known.length
        ? known.reduce((sum, plane) => sum + plane.fatalities, 0)
        : null,
      injuries: null,
      aircraft: planes.map(({ fatalities, ...plane }) => plane),
      events: eventsByCode.get(clean(row.codigo_ocorrencia1)) || [],
      investigation:
        status === 'FINALIZADA'
          ? 'finished'
          : status === 'ATIVA'
            ? 'active'
            : null,
      report: published ? clean(row.divulgacao_relatorio_numero, 40) : null,
      name: null,
      url: null,
    });
  }
  // Many occurrences share one point: the aerodrome's reference position,
  // not where the aircraft came to rest. Say so on the card.
  const atPoint = new Map();
  for (const record of records) {
    const key = `${record.lat.toFixed(4)},${record.lon.toFixed(4)}`;
    atPoint.set(key, (atPoint.get(key) || 0) + 1);
  }
  for (const record of records)
    record.approximate =
      atPoint.get(`${record.lat.toFixed(4)},${record.lon.toFixed(4)}`) > 1;
  return records;
}

/** Wikidata items that are aviation accidents (Q744913) and have a position. */
export const WIKIDATA_QUERY = `SELECT ?item ?itemLabel ?date ?coord ?deaths ?injured ?operatorLabel ?enwiki ?ptwiki WHERE {
  ?item wdt:P31/wdt:P279* wd:Q744913 ; wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P585 ?date }
  OPTIONAL { ?item wdt:P1120 ?deaths }
  OPTIONAL { ?item wdt:P1339 ?injured }
  OPTIONAL { ?item wdt:P137 ?operator }
  OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  OPTIONAL { ?ptwiki schema:about ?item ; schema:isPartOf <https://pt.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,pt,mul". }
}`;

function wikiUrl(value) {
  const text = clean(value, 400);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' &&
      /^(en|pt)\.wikipedia\.org$/.test(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * One record per Wikidata accident item from a SPARQL JSON result. Only the
 * event's own properties are read (never victims or crew items).
 * @param {object} payload SPARQL results JSON.
 * @returns {object[]}
 */
export function normalizeWikidataResults(payload) {
  const bindings = payload?.results?.bindings;
  if (!Array.isArray(bindings)) return [];
  const byItem = new Map();
  for (const binding of bindings) {
    const value = (key) => binding?.[key]?.value;
    const qid = /\/entity\/(Q\d{1,12})$/.exec(value('item') || '')?.[1];
    if (!qid || byItem.has(qid)) continue;
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
    const name = clean(value('itemLabel'));
    const date = /^(-?\d{4})-(\d{2})-(\d{2})T/.exec(value('date') || '');
    byItem.set(qid, {
      id: `wikidata:${qid}`,
      source: 'wikidata',
      kind: 'accident',
      lat,
      lon,
      date: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
      time: null,
      city: null,
      state: null,
      country: null,
      aerodrome: null,
      approximate: false,
      fatalities: int(String(value('deaths') ?? '').replace(/\.0+$/, '')),
      injuries: int(String(value('injured') ?? '').replace(/\.0+$/, '')),
      aircraft: [],
      events: [],
      investigation: null,
      report: null,
      // An unlabelled item reads back as its own Q-id; that is no name.
      name: name && name !== qid ? name : null,
      operator: clean(value('operatorLabel'), 80),
      url:
        wikiUrl(value('enwiki')) ||
        wikiUrl(value('ptwiki')) ||
        `https://www.wikidata.org/wiki/${qid}`,
    });
  }
  return [...byItem.values()];
}

/**
 * Fold Wikidata items that describe a CENIPA accident (same day, within
 * about 50 km) into that record, which gains the article's name and link.
 * @param {object[]} cenipa
 * @param {object[]} wikidata
 * @returns {object[]}
 */
export function mergeAirAccidentRecords(cenipa = [], wikidata = []) {
  const byDate = new Map();
  for (const record of cenipa) {
    const list = byDate.get(record.date) || [];
    list.push(record);
    byDate.set(record.date, list);
  }
  const rest = [];
  for (const item of wikidata) {
    const match = (byDate.get(item.date) || []).find(
      (record) =>
        record.kind === 'accident' &&
        Math.abs(record.lat - item.lat) < 0.5 &&
        Math.abs(record.lon - item.lon) < 0.5,
    );
    if (match && !match.url) {
      match.name = item.name;
      match.url = item.url;
      if (match.fatalities === null) match.fatalities = item.fatalities;
      match.injuries = item.injuries;
    } else rest.push(item);
  }
  return [...cenipa, ...rest];
}

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
      ids.has(record.id) ||
      !AIR_ACCIDENT_KINDS.includes(record.kind) ||
      !['cenipa', 'wikidata'].includes(record.source) ||
      !Number.isFinite(record.lat) ||
      !Number.isFinite(record.lon) ||
      Math.abs(record.lat) > 90 ||
      Math.abs(record.lon) > 180
    )
      continue;
    ids.add(record.id);
    rows.push({
      ...record,
      aircraft: Array.isArray(record.aircraft) ? record.aircraft : [],
      events: Array.isArray(record.events) ? record.events : [],
    });
  }
  return rows;
}
