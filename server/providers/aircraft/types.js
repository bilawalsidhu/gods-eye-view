import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { readResponseBytesCapped } from '../common/http.js';
import { readRequestBodyCapped } from '../common/request.js';
import { readZipEntry } from '../../../src/data/zipEntry.js';

/**
 * Aircraft type database: ICAO 24-bit address → ICAO type designator and
 * registration, from the Mictronics aircraft database (ODC-By 1.0, updated
 * weekly). OpenSky state vectors carry neither, so without this an area query
 * can only say "no type reported" for civil traffic, and the per-aircraft
 * adsbdb lookup is rate-bounded to a few hundred aircraft per session.
 *
 * One ~3.4 MB download a week, kept in .gev-cache so a restart reads it from
 * disk. The index is a sorted Uint32Array of addresses with parallel type and
 * registration columns (~7 MB in all, against ~40 MB for a Map of strings).
 *
 * POST /api/aircraft-types {"ids": ["a1b2c3", ...]} →
 *   {"aircraft": {"a1b2c3": ["B738", "N123AB"]}, "typeNames": {"B738": "BOEING 737-800"}}
 * Addresses the database doesn't know are left out of `aircraft`.
 */
export const MICTRONICS_DB_URL =
  'https://raw.githubusercontent.com/Mictronics/aircraft-database/main/indexedDB.zip';
/** The export measures 3.4 MB; aircrafts.json inside it 14.7 MB. */
const DB_MAX_BYTES = 16 * 1024 * 1024;
const ENTRY_MAX_BYTES = 64 * 1024 * 1024;
/** The upstream files are regenerated once a week. */
export const REFRESH_MS = 7 * 24 * 3600_000;
/** After a failed download, wait this long before trying again. */
export const RETRY_MS = 3600_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Above a whole-world OpenSky snapshot (~10k aircraft) with headroom. */
export const MAX_IDS = 20_000;
const MAX_BODY_BYTES = MAX_IDS * 12 + 64;
const HEX_RE = /^[0-9a-f]{6}$/;
/** Short capitalised words in type names that are words, not abbreviations. */
const NAME_WORDS = Object.freeze({
  AIR: 'Air',
  DE: 'de',
  NEW: 'New',
  SKY: 'Sky',
  FLY: 'Fly',
  CUB: 'Cub',
});

/**
 * The database writes manufacturers in capitals ("BOEING 737-800", "DE
 * HAVILLAND DHC-8-400 Dash 8"); read them as names ("Boeing 737-800", "de
 * Havilland DHC-8-400 Dash 8"). Words of three letters or fewer stay as
 * written (ATR, IAI, MBB), as does anything with a digit or lowercase letter.
 */
export function readableTypeName(name) {
  const part = (word) => {
    if (NAME_WORDS[word]) return NAME_WORDS[word];
    if (!/^[A-Z]{4,}$/.test(word)) return word;
    if (word.startsWith('MC'))
      return 'Mc' + word[2] + word.slice(3).toLowerCase();
    return word[0] + word.slice(1).toLowerCase();
  };
  return String(name)
    .trim()
    .split(' ')
    .map((word) => word.split('-').map(part).join('-'))
    .join(' ');
}

/**
 * Build the lookup index from the export's aircrafts.json
 * ({"A835AF": ["N628TS", "GLF6", "00"], ...}) and types.json
 * ({"GLF6": ["GULFSTREAM AEROSPACE G-650", "L2J", "M"], ...}). Aircraft with
 * no type designator are left out.
 */
export function buildTypeIndex(aircrafts, types = {}) {
  const rows = [];
  for (const [hex, row] of Object.entries(aircrafts ?? {})) {
    const key = String(hex).toLowerCase();
    const typeCode = Array.isArray(row) ? String(row[1] ?? '').trim() : '';
    if (!HEX_RE.test(key) || !typeCode) continue;
    rows.push([parseInt(key, 16), typeCode, String(row[0] ?? '').trim()]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const typeCodes = [...new Set(rows.map((row) => row[1]))];
  const typeIndex = new Map(typeCodes.map((code, i) => [code, i]));
  const keys = new Uint32Array(rows.length);
  const typeOf = new Uint16Array(rows.length);
  const registrationEnd = new Uint32Array(rows.length);
  const registrations = [];
  let offset = 0;
  rows.forEach(([key, typeCode, registration], i) => {
    keys[i] = key;
    typeOf[i] = typeIndex.get(typeCode);
    registrations.push(registration);
    offset += registration.length;
    registrationEnd[i] = offset;
  });
  const registrationText = registrations.join('');
  const typeNames = new Map();
  for (const code of typeCodes) {
    const name = types?.[code]?.[0];
    if (typeof name === 'string' && name.trim())
      typeNames.set(code, readableTypeName(name));
  }

  function find(hex) {
    if (!HEX_RE.test(hex)) return -1;
    const target = parseInt(hex, 16);
    let lo = 0;
    let hi = keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (keys[mid] === target) return mid;
      if (keys[mid] < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  return {
    size: keys.length,
    /** `{typeCode, typeName, registration}` for a lowercase hex, or null. */
    lookup(hex) {
      const i = find(String(hex ?? '').toLowerCase());
      if (i < 0) return null;
      const typeCode = typeCodes[typeOf[i]];
      const start = i === 0 ? 0 : registrationEnd[i - 1];
      return {
        typeCode,
        typeName: typeNames.get(typeCode) ?? null,
        registration: registrationText.slice(start, registrationEnd[i]) || null,
      };
    },
  };
}

/** Parse the Mictronics indexedDB.zip export into a lookup index. */
export async function parseTypeDatabase(zipBytes) {
  const json = async (name) =>
    JSON.parse(
      new TextDecoder().decode(
        await readZipEntry(zipBytes, name, ENTRY_MAX_BYTES),
      ),
    );
  const index = buildTypeIndex(
    await json('aircrafts.json'),
    await json('types.json'),
  );
  if (!index.size) throw new Error('aircraft type database has no entries');
  return index;
}

/**
 * The database's lifecycle: read the disk copy on first use, download when
 * there is none or it is older than REFRESH_MS, and keep serving the current
 * copy while a refresh runs or after one fails. Nothing waits for loading: a
 * flight snapshot must never be held back by its type lookup.
 */
export function createAircraftTypeDatabase({
  fetchImpl = (...args) => globalThis.fetch(...args),
  cachePath = path.join(
    process.cwd(),
    '.gev-cache',
    'mictronics-aircraft-db.zip',
  ),
  now = () => Date.now(),
  fs = fsp,
} = {}) {
  let index = null;
  let fetchedAt = 0;
  let retryAt = 0;
  let loading = null;
  let diskTried = false;

  async function download() {
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const response = await fetchImpl(MICTRONICS_DB_URL, { signal });
    if (!response.ok)
      throw new Error(
        `aircraft type database download: HTTP ${response.status}`,
      );
    const bytes = await readResponseBytesCapped(response, DB_MAX_BYTES, signal);
    const fresh = await parseTypeDatabase(bytes);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, bytes);
    index = fresh;
    fetchedAt = now();
  }

  async function readDisk() {
    let bytes;
    let mtimeMs;
    try {
      [bytes, { mtimeMs }] = await Promise.all([
        fs.readFile(cachePath),
        fs.stat(cachePath),
      ]);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    index = await parseTypeDatabase(new Uint8Array(bytes));
    fetchedAt = mtimeMs;
  }

  function load() {
    loading ??= (async () => {
      if (!diskTried) {
        diskTried = true;
        await readDisk().catch((error) => {
          console.warn(
            `[aircraft-types] unreadable disk copy; downloading: ${error.message}`,
          );
        });
      }
      if ((!index || now() - fetchedAt > REFRESH_MS) && now() >= retryAt)
        await download().catch((error) => {
          retryAt = now() + RETRY_MS;
          console.warn(
            `[aircraft-types] ${index ? 'refresh failed; keeping the current copy' : 'download failed'}: ${error.message}`,
          );
        });
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  return {
    /**
     * The index now, or null while the first copy loads or after a failed
     * download. Starts a load or a refresh when one is due, never waiting for
     * it; `loaded()` is the same load, for a caller that can wait.
     */
    current() {
      const due = !diskTried || !index || now() - fetchedAt > REFRESH_MS;
      if (due && (!diskTried || now() >= retryAt)) void load();
      return index;
    },
    loaded() {
      return load().then(() => index);
    },
    /** Milliseconds until a failed download may be tried again (0 if none). */
    retryInMs: () => Math.max(0, retryAt - now()),
  };
}

/** Vite plugin: POST /api/aircraft-types. */
export function aircraftTypesProxy({
  database = createAircraftTypeDatabase(),
} = {}) {
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  const installMiddleware = (server) => {
    server.middlewares.use('/api/aircraft-types', async (req, res) => {
      if (req.method !== 'POST')
        return send(
          res,
          405,
          { error: 'method not allowed' },
          { Allow: 'POST' },
        );
      let ids;
      try {
        const body = JSON.parse(
          (await readRequestBodyCapped(req, MAX_BODY_BYTES)).toString('utf8'),
        );
        ids = body?.ids;
      } catch (error) {
        return error?.code === 'BODY_TOO_LARGE'
          ? send(res, 413, { error: `at most ${MAX_IDS} ids` })
          : send(res, 400, { error: 'body must be JSON {"ids": [...]}' });
      }
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_IDS ||
        !ids.every((id) => typeof id === 'string')
      )
        return send(res, 400, {
          error: `ids must be an array of at most ${MAX_IDS} hex addresses`,
        });
      const index = database.current();
      if (!index) {
        // Loading, or the download failed: answer now so the caller's flight
        // snapshot isn't held up, and say when asking again is worthwhile.
        const failedFor = database.retryInMs();
        return send(
          res,
          503,
          {
            error:
              failedFor > 0
                ? 'aircraft_types_unavailable'
                : 'aircraft_types_loading',
          },
          { 'Retry-After': String(Math.max(5, Math.ceil(failedFor / 1000))) },
        );
      }
      const aircraft = {};
      const typeNames = {};
      for (const id of ids) {
        const hex = id.toLowerCase();
        const found = index.lookup(hex);
        if (!found) continue;
        aircraft[hex] = [found.typeCode, found.registration];
        if (found.typeName) typeNames[found.typeCode] = found.typeName;
      }
      return send(res, 200, { aircraft, typeNames });
    });
  };

  return {
    name: 'aircraft-types',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
