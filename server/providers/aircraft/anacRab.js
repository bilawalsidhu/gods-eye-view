import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { readResponseTextCapped } from '../common/http.js';

/**
 * ANAC's Registro Aeronáutico Brasileiro (RAB): technical details for
 * Brazilian-registered aircraft, joined to adsbdb's registration.
 *
 * Source: one ';'-separated UTF-8 CSV (about 24 MB, 35k aircraft) that ANAC
 * refreshes daily. Its first line reads "Atualizado em: YYYY-MM-DD", the second
 * is the header. The RAB is public by law (Lei 7.565/1986, art. 72) and the
 * file is open data of a federal agency (Decreto 8.777/2016, art. 3, IV).
 *
 * Privacy: the same file lists owners and operators (names, CPF/CNPJ), liens,
 * sale dates and sale prices. `parseRabCsv` copies only the technical columns
 * in `KEPT`, by position, while it scans each row; every other field is
 * skipped without being sliced out, so personal and financial values are never
 * stored, cached, logged or returned.
 *
 * Cancelled registrations are left out: a transponder still announcing one
 * is better shown without details than with another airframe's.
 */

export const RAB_URL =
  'https://sistemas.anac.gov.br/dadosabertos/Aeronaves/RAB/dados_aeronaves.csv';
/** About 24 MB in November 2026; the cap leaves room for growth. */
const RAB_MAX_BYTES = 64 * 1024 * 1024;
/** ANAC republishes daily; one download a day is the most this needs. */
const REFRESH_MS = 24 * 3600_000;
/** After a failed download, wait this long before trying again. */
const RETRY_MS = 30 * 60_000;
const TIMEOUT_MS = 90_000;
const USER_AGENT =
  'gods-eye-view-aircraft (+https://github.com/bilawalsidhu/gods-eye-view)';
const CACHE_VERSION = 1;

/** The only columns read. Personal and financial columns are not listed. */
const KEPT = Object.freeze([
  'MARCAS',
  'DS_MODELO',
  'NM_FABRICANTE',
  'CD_TIPO_ICAO',
  'NR_ASSENTOS',
  'NR_ANO_FABRICACAO',
  'CF_OPERACIONAL',
  'TP_OPERACAO',
  'DT_CANC',
]);

/**
 * Brazilian nationality marks: PP, PR, PS, PT or PU followed by three letters.
 * @param {unknown} value A registration as adsbdb or ANAC writes it ("PR-ABC").
 * @returns {string|null} "PRABC", or null when it is not a Brazilian mark.
 */
export function normalizeRegistration(value) {
  const reg = String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return /^P[PRSTU][A-Z]{3}$/.test(reg) ? reg : null;
}

/**
 * Split one CSV row, returning only the fields at `wanted` positions.
 * Unwanted fields are walked over, never copied into a string.
 * @param {string} line
 * @param {Map<number, string>} wanted position → column name
 * @returns {{count: number, values: Record<string, string>}}
 */
function pickFields(line, wanted) {
  const values = {};
  let field = 0;
  let i = 0;
  const n = line.length;
  while (i <= n) {
    const name = wanted.get(field);
    let value = name ? '' : null;
    if (line[i] === '"') {
      i++;
      for (;;) {
        const quote = line.indexOf('"', i);
        if (quote === -1) {
          if (value !== null) value += line.slice(i);
          i = n;
          break;
        }
        if (value !== null) value += line.slice(i, quote);
        if (line[quote + 1] === '"') {
          if (value !== null) value += '"';
          i = quote + 2;
          continue;
        }
        i = quote + 1;
        break;
      }
      const sep = line.indexOf(';', i);
      i = sep === -1 ? n + 1 : sep + 1;
    } else {
      const sep = line.indexOf(';', i);
      const end = sep === -1 ? n : sep;
      if (value !== null) value = line.slice(i, end);
      i = end + 1;
    }
    if (name) values[name] = value;
    field++;
  }
  return { count: field, values };
}

const clean = (value, max) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
};

const positiveInt = (value, max) => {
  if (!/^\d{1,6}$/.test(String(value ?? '').trim())) return null;
  const n = Number.parseInt(value, 10);
  return n > 0 && n <= max ? n : null;
};

/**
 * RBAC 121 and 135 certificates mark airline and air-taxi aircraft; the
 * remaining (RBAC 91) fleet is private or government by TP_OPERACAO.
 * @returns {'airline'|'air-taxi'|'government'|'private'|null}
 */
function operationOf(certificate, operation) {
  const cert = String(certificate ?? '').toUpperCase();
  if (/\b121\b/.test(cert)) return 'airline';
  if (/\b135\b/.test(cert)) return 'air-taxi';
  const kind = String(operation ?? '').toUpperCase();
  if (kind.startsWith('PUBLIC')) return 'government';
  if (kind.startsWith('PRIVAD')) return 'private';
  return null;
}

/**
 * Parse the RAB CSV into the technical index.
 * @param {string} text Whole file.
 * @param {{year?: number}} [options] `year` bounds a plausible build year.
 * @returns {{updated: string|null, records: Map<string, object>, rows: number,
 *   skipped: number}|null} null when the text is not the RAB file.
 */
export function parseRabCsv(text, { year = new Date().getUTCFullYear() } = {}) {
  if (typeof text !== 'string' || !text) return null;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let start = 0;
  const nextLine = () => {
    if (start > body.length) return null;
    let end = body.indexOf('\n', start);
    if (end === -1) end = body.length;
    let line = body.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    start = end + 1;
    return line;
  };
  let first = nextLine();
  const stamp = /^Atualizado em:\s*(\d{4}-\d{2}-\d{2})/.exec(first ?? '');
  const updated = stamp ? stamp[1] : null;
  if (stamp) first = nextLine();
  const header = (first ?? '')
    .split(';')
    .map((h) => h.replace(/"/g, '').trim());
  const wanted = new Map();
  for (const name of KEPT) {
    const at = header.indexOf(name);
    if (at === -1) return null;
    wanted.set(at, name);
  }
  const records = new Map();
  let rows = 0;
  let skipped = 0;
  for (let line = nextLine(); line !== null; line = nextLine()) {
    if (!line.trim()) continue;
    rows++;
    const { count, values } = pickFields(line, wanted);
    const reg = normalizeRegistration(values.MARCAS);
    if (count !== header.length || !reg) {
      skipped++;
      continue;
    }
    if (clean(values.DT_CANC, 32)) continue;
    const icao = clean(values.CD_TIPO_ICAO, 4);
    const built = positiveInt(values.NR_ANO_FABRICACAO, year + 1);
    records.set(reg, {
      model: clean(values.DS_MODELO, 40),
      manufacturer: clean(values.NM_FABRICANTE, 48),
      icaoType:
        icao && /^[A-Z0-9]{2,4}$/.test(icao) && icao !== 'ZZZZ' ? icao : null,
      year: built && built >= 1900 ? built : null,
      seats: positiveInt(values.NR_ASSENTOS, 999),
      operation: operationOf(values.CF_OPERACIONAL, values.TP_OPERACAO),
    });
  }
  return { updated, records, rows, skipped };
}

/**
 * The type name adsbdb lacks, from the RAB's manufacturer and model.
 * @param {object|null} record
 * @returns {string|null}
 */
export function rabTypeName(record) {
  if (!record?.model) return null;
  const maker = record.manufacturer;
  return maker && !record.model.toUpperCase().startsWith(maker.toUpperCase())
    ? `${maker} ${record.model}`
    : record.model;
}

/**
 * Lazily downloaded, disk-cached RAB index.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {string} [options.cachePath]
 * @param {{warn: Function}} [options.log]
 */
export function createAnacRab({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  cachePath = path.join(process.cwd(), '.gev-cache', 'anac-rab.json'),
  log = console,
} = {}) {
  /** @type {?{fetchedAt: number, updated: string|null, etag: string|null,
   *   lastModified: string|null, records: Map<string, object>}} */
  let index = null;
  let diskRead = null;
  let inflight = null;
  let failedAt = 0;

  async function loadDisk() {
    try {
      const saved = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (saved?.v !== CACHE_VERSION || !Array.isArray(saved.records)) return;
      index = {
        fetchedAt: Number(saved.fetchedAt) || 0,
        updated: saved.updated ?? null,
        etag: saved.etag ?? null,
        lastModified: saved.lastModified ?? null,
        records: new Map(saved.records),
      };
    } catch {
      /* no cache yet */
    }
  }

  function readDisk() {
    return (diskRead ??= loadDisk());
  }

  async function writeDisk() {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(
        cachePath,
        JSON.stringify({
          v: CACHE_VERSION,
          fetchedAt: index.fetchedAt,
          updated: index.updated,
          etag: index.etag,
          lastModified: index.lastModified,
          records: [...index.records],
        }),
        'utf8',
      );
    } catch (err) {
      log.warn?.(`[anac-rab] cache write failed: ${err?.code || err?.message}`);
    }
  }

  async function download() {
    const headers = { 'User-Agent': USER_AGENT };
    if (index?.etag) headers['If-None-Match'] = index.etag;
    if (index?.lastModified) headers['If-Modified-Since'] = index.lastModified;
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetchImpl(RAB_URL, { headers, signal });
    if (res.status === 304 && index) {
      index = { ...index, fetchedAt: now() };
      await writeDisk();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readResponseTextCapped(res, RAB_MAX_BYTES, signal);
    const parsed = parseRabCsv(text);
    if (!parsed || parsed.records.size === 0)
      throw new Error('not the RAB aircraft file');
    index = {
      fetchedAt: now(),
      updated: parsed.updated,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      records: parsed.records,
    };
    await writeDisk();
  }

  /**
   * Make the index current: read the disk cache once, then download when it
   * is a day old. Concurrent callers share one download; a failure keeps the
   * previous index and waits RETRY_MS before the next attempt.
   * @returns {Promise<void>}
   */
  async function ensureFresh() {
    await readDisk();
    if (index && now() - index.fetchedAt < REFRESH_MS) return;
    if (failedAt && now() - failedAt < RETRY_MS) return;
    if (!inflight) {
      inflight = download()
        .then(() => {
          failedAt = 0;
        })
        .catch((err) => {
          failedAt = now();
          log.warn?.(`[anac-rab] refresh failed: ${err?.message || err}`);
        })
        .finally(() => {
          inflight = null;
        });
    }
    await inflight;
  }

  /**
   * @param {unknown} registration
   * @returns {object|null} The technical record, or null when unknown.
   */
  function lookup(registration) {
    const reg = normalizeRegistration(registration);
    return (reg && index?.records.get(reg)) || null;
  }

  return {
    ensureFresh,
    lookup,
    status: () => ({
      loaded: Boolean(index),
      updated: index?.updated ?? null,
      fetchedAt: index?.fetchedAt ?? null,
      aircraft: index?.records.size ?? 0,
    }),
  };
}
