/**
 * AD1C "big CTY" cty.dat parsing and callsign → DXCC entity resolution.
 *
 * Node-only (the resolver touches the filesystem), but `parseCtyDat`,
 * `resolveCallsign` and `callAreaCentroid` are pure and never throw.
 *
 * File format (https://www.country-files.com/cty-dat-format/):
 *
 *   Name: CQ: ITU: Cont: Lat: Lon: TZ: Prefix:
 *       prefix,prefix,=EXACTCALL,prefix(cq)[itu]<lat/lon>{cont}~tz~,...;
 *
 * Longitude and TZ are sign-inverted in the file (west-positive longitude,
 * "hours to add to local time to reach UTC" for TZ). This module normalises
 * both: `lon` is east-positive and `utcOffset` is the usual UTC offset in
 * hours (Germany +1, US east coast −5). WAE-only entities are marked with a
 * `*` on the header's primary prefix (Sicily `*IT9`); they are skipped for
 * DXCC-style resolution unless `allowWae` is set.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CTY_URL = 'https://www.country-files.com/bigcty/cty.dat';
const CTY_FILE_NAME = 'cty.dat';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20000;
const CTY_USER_AGENT = 'GodsEyeView/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';
const MAX_RESOLUTION_DEPTH = 8;

/** Trailing designators that never denote a location. */
const DESIGNATORS = new Set(['P', 'M', 'QRP', 'A', 'LH', 'J', 'R', 'B', 'E', 'T']);

/** Primary prefixes of entities large enough that a call-area centroid beats the entity centroid. */
const LARGE_ENTITY_PREFIXES = new Set(['K', 'VE', 'UA', 'UA9', 'VK', 'JA', 'PY', 'BY']);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TOKEN_RE = /^(=?)([A-Z0-9/]+)((?:\(\d+\)|\[\d+\]|<-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?>|\{[A-Z]{2}\}|~-?\d+(?:\.\d+)?~)*)$/;
const OVERRIDE_RE = /\((\d+)\)|\[(\d+)\]|<(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)>|\{([A-Z]{2})\}|~(-?\d+(?:\.\d+)?)~/g;

function toNumber(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

/** Negate without producing -0 (file values of 0.0 stay a clean 0). */
function negate(n) {
  return n === 0 ? 0 : -n;
}

function parseHeader(line) {
  const trimmed = line.trim().replace(/:$/, '');
  const parts = trimmed.split(':');
  if (parts.length < 8) return null;
  const tail = parts.slice(-7).map((p) => p.trim());
  const name = parts.slice(0, -7).join(':').trim();
  const [cq, itu, continent, lat, lon, tz, prefixField] = tail;
  const latN = toNumber(lat);
  const lonN = toNumber(lon);
  const tzN = toNumber(tz);
  if (!name || latN === null || lonN === null || tzN === null || !prefixField) return null;
  const waeOnly = prefixField.startsWith('*');
  return {
    name,
    cq: toNumber(cq),
    itu: toNumber(itu),
    continent: continent.toUpperCase(),
    lat: latN,
    lon: negate(lonN),
    utcOffset: negate(tzN),
    // Keep the file's case: `3Y/b`, `GM/s`, `JW/b` are AD1C pseudo-prefixes, not list prefixes.
    primaryPrefix: prefixField.replace(/^\*/, ''),
    waeOnly,
  };
}

function parseToken(rawToken, entity, entityIndex) {
  const token = rawToken.trim().toUpperCase();
  if (!token) return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const ref = {
    entityIndex,
    cq: entity.cq,
    itu: entity.itu,
    continent: entity.continent,
    lat: entity.lat,
    lon: entity.lon,
    utcOffset: entity.utcOffset,
  };
  const overrides = m[3] || '';
  if (overrides) {
    OVERRIDE_RE.lastIndex = 0;
    let o;
    while ((o = OVERRIDE_RE.exec(overrides)) !== null) {
      if (o[1] !== undefined) ref.cq = Number(o[1]);
      else if (o[2] !== undefined) ref.itu = Number(o[2]);
      else if (o[3] !== undefined) { ref.lat = Number(o[3]); ref.lon = negate(Number(o[4])); }
      else if (o[5] !== undefined) ref.continent = o[5];
      else if (o[6] !== undefined) ref.utcOffset = negate(Number(o[6]));
    }
  }
  return { exact: m[1] === '=', key: m[2], ref };
}

/**
 * Parse cty.dat text into an index. Never throws; malformed lines are skipped.
 * The returned `exact` and `prefixes` maps hold DXCC (non-WAE) entries, with
 * WAE-only entries in `waeExact` / `waePrefixes` so callers can pick either view.
 */
export function parseCtyDat(text) {
  const index = { entities: [], exact: new Map(), prefixes: new Map(), waeExact: new Map(), waePrefixes: new Map() };
  const lines = String(text ?? '').split(/\r?\n/);
  let current = null;
  let currentIndex = -1;
  let buffer = '';

  const flush = () => {
    if (!current || !buffer) { buffer = ''; return; }
    const list = buffer.replace(/;\s*$/, '');
    for (const raw of list.split(',')) {
      const parsed = parseToken(raw, current, currentIndex);
      if (!parsed) continue;
      const exactMap = current.waeOnly ? index.waeExact : index.exact;
      const prefixMap = current.waeOnly ? index.waePrefixes : index.prefixes;
      const target = parsed.exact ? exactMap : prefixMap;
      if (!target.has(parsed.key)) target.set(parsed.key, parsed.ref);
    }
    buffer = '';
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      if (current) buffer += line.trim();
      continue;
    }
    flush();
    const header = parseHeader(line);
    if (!header) { current = null; currentIndex = -1; continue; }
    current = header;
    currentIndex = index.entities.push(header) - 1;
  }
  flush();
  return index;
}

// ---------------------------------------------------------------------------
// Call-area centroids
// ---------------------------------------------------------------------------

const US_AREAS = {
  0: { lat: 42.0, lon: -97.0 },   // CO IA KS MN MO NE ND SD
  1: { lat: 43.5, lon: -71.5 },   // New England
  2: { lat: 42.0, lon: -75.0 },   // NY NJ
  3: { lat: 40.0, lon: -77.0 },   // PA MD DE DC
  4: { lat: 34.0, lon: -83.0 },   // Southeast
  5: { lat: 32.0, lon: -97.0 },   // AR LA MS NM OK TX
  6: { lat: 37.0, lon: -120.0 },  // California
  7: { lat: 44.0, lon: -114.0 },  // Pacific NW / Mountain
  8: { lat: 41.0, lon: -83.0 },   // MI OH WV
  9: { lat: 42.0, lon: -89.0 },   // IL IN WI
};
const US_EXCLUDED_LETTERS = new Set(['KH', 'KL', 'KP', 'AH', 'AL', 'NH', 'NL', 'NP', 'WH', 'WL', 'WP']);

const VE_AREAS = {
  1: { lat: 45.0, lon: -63.0 },   // Nova Scotia
  2: { lat: 50.0, lon: -72.0 },   // Quebec
  3: { lat: 48.0, lon: -83.0 },   // Ontario
  4: { lat: 54.0, lon: -97.0 },   // Manitoba
  5: { lat: 53.0, lon: -106.0 },  // Saskatchewan
  6: { lat: 54.0, lon: -115.0 },  // Alberta
  7: { lat: 53.0, lon: -123.0 },  // British Columbia
  8: { lat: 64.0, lon: -118.0 },  // Northwest Territories
  9: { lat: 46.5, lon: -66.0 },   // New Brunswick
};
const VO_AREAS = {
  1: { lat: 48.5, lon: -56.0 },   // Newfoundland
  2: { lat: 54.0, lon: -62.0 },   // Labrador
};
const VY_AREAS = {
  0: { lat: 68.0, lon: -90.0 },   // Nunavut
  1: { lat: 63.0, lon: -135.0 },  // Yukon
  2: { lat: 46.3, lon: -63.2 },   // Prince Edward Island
};
const VE_LETTERS = new Set(['VA', 'VB', 'VC', 'VE', 'VG', 'VX', 'CF', 'CG', 'CJ', 'CK', 'XL', 'XM']);

const RU_AREAS = {
  1: { lat: 60.0, lon: 35.0 },    // North-west Russia
  3: { lat: 55.5, lon: 38.0 },    // Central Russia (Moscow)
  4: { lat: 55.0, lon: 50.0 },    // Volga
  6: { lat: 45.5, lon: 42.0 },    // South / North Caucasus
  7: { lat: 45.5, lon: 42.0 },    // South (R7 blocks)
  8: { lat: 58.0, lon: 65.0 },    // Urals / West Siberia (R8 blocks)
  9: { lat: 57.0, lon: 70.0 },    // Urals / West Siberia
  0: { lat: 56.0, lon: 110.0 },   // East Siberia / Far East
};
const RU_KALININGRAD = { lat: 54.7, lon: 20.5 };

const VK_AREAS = {
  1: { lat: -35.3, lon: 149.1 },  // ACT
  2: { lat: -32.5, lon: 147.0 },  // NSW
  3: { lat: -37.0, lon: 144.5 },  // Victoria
  4: { lat: -22.5, lon: 144.0 },  // Queensland
  5: { lat: -30.0, lon: 135.0 },  // South Australia
  6: { lat: -26.0, lon: 121.0 },  // Western Australia
  7: { lat: -42.0, lon: 146.5 },  // Tasmania
  8: { lat: -19.5, lon: 133.5 },  // Northern Territory
};

const JA_AREAS = {
  1: { lat: 36.0, lon: 139.5 },   // Kanto
  2: { lat: 35.2, lon: 137.5 },   // Tokai
  3: { lat: 34.8, lon: 135.5 },   // Kinki
  4: { lat: 34.8, lon: 133.0 },   // Chugoku
  5: { lat: 33.7, lon: 133.5 },   // Shikoku
  6: { lat: 32.8, lon: 130.8 },   // Kyushu
  7: { lat: 38.8, lon: 140.5 },   // Tohoku
  8: { lat: 43.2, lon: 142.8 },   // Hokkaido
  9: { lat: 36.6, lon: 137.0 },   // Hokuriku
  0: { lat: 37.0, lon: 138.5 },   // Shin'etsu
};

const PY_AREAS = {
  1: { lat: -22.5, lon: -43.0 },  // Rio de Janeiro / Espírito Santo
  2: { lat: -22.5, lon: -48.5 },  // São Paulo
  3: { lat: -30.0, lon: -53.0 },  // Rio Grande do Sul
  4: { lat: -18.5, lon: -44.5 },  // Minas Gerais
  5: { lat: -26.0, lon: -50.5 },  // Paraná / Santa Catarina
  6: { lat: -12.5, lon: -41.5 },  // Bahia / Sergipe
  7: { lat: -7.5, lon: -37.5 },   // North-east
  8: { lat: -4.0, lon: -55.0 },   // North (Pará / Amazonas)
  9: { lat: -15.0, lon: -53.0 },  // Centre-west
};

const CALL_STRUCTURE_RE = /^\d?[A-Z]+\d+[A-Z]+$/;
const CALL_HEAD_RE = /^(\d?[A-Z]+)(\d)/;

function looksLikeCall(token) {
  return CALL_STRUCTURE_RE.test(token);
}

function pick(table, digit) {
  const hit = table[digit];
  return hit ? { lat: hit.lat, lon: hit.lon } : null;
}

/**
 * Approximate centroid of the call area encoded in a callsign, or null when
 * the call does not belong to one of the large entities with call areas
 * (USA, Canada, Russia, Australia, Japan, Brazil). A trailing `/digit`
 * overrides the base call's area digit (`W1AW/7` → area 7); `/MM` and `/AM`
 * yield null because the station is at sea or airborne.
 */
export function callAreaCentroid(callsign) {
  try {
    const call = normalizeCall(callsign);
    if (!call) return null;
    const parts = call.split('/');
    if (parts.some((p) => p === 'MM' || p === 'AM')) return null;
    let digitOverride = null;
    if (parts.length > 1 && /^\d$/.test(parts[parts.length - 1])) {
      digitOverride = Number(parts[parts.length - 1]);
      parts.pop();
    }
    const base = parts.find(looksLikeCall) ?? parts[0];
    const m = CALL_HEAD_RE.exec(base);
    if (!m) return null;
    const letters = m[1];
    const digit = digitOverride ?? Number(m[2]);

    if (/^(?:A[A-L]|[KNW][A-Z]?)$/.test(letters) && !US_EXCLUDED_LETTERS.has(letters)) return pick(US_AREAS, digit);
    if (VE_LETTERS.has(letters)) return pick(VE_AREAS, digit);
    if (letters === 'VO') return pick(VO_AREAS, digit);
    if (letters === 'VY') return pick(VY_AREAS, digit);
    if (/^(?:R[A-Z]?|U[A-I][A-Z]?)$/.test(letters)) {
      if (digit === 2) return letters.startsWith('U') ? { ...RU_KALININGRAD } : pick(RU_AREAS, 3);
      return pick(RU_AREAS, digit);
    }
    if (/^(?:AX|V[IJKL])$/.test(letters)) return pick(VK_AREAS, digit);
    if (/^(?:J[A-CE-S]|7[J-N]|8[J-N])$/.test(letters)) return pick(JA_AREAS, digit);
    if (/^(?:P[P-Y]|Z[V-Z])$/.test(letters)) return pick(PY_AREAS, digit);
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function normalizeCall(callsign) {
  let call = String(callsign ?? '').trim().toUpperCase();
  if (!call) return null;
  // Skimmer / cluster node suffixes: DL8LAS-#, W3LPL-2
  const dash = call.indexOf('-');
  if (dash >= 0) call = call.slice(0, dash);
  call = call.replace(/\s+/g, '').replace(/[^A-Z0-9/]/g, '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return call || null;
}

function lookupExact(index, call, allowWae) {
  if (allowWae && index.waeExact?.has(call)) return index.waeExact.get(call);
  return index.exact.get(call) ?? null;
}

function longestPrefix(index, token, allowWae) {
  for (let len = token.length; len >= 1; len -= 1) {
    const prefix = token.slice(0, len);
    if (allowWae && index.waePrefixes?.has(prefix)) return { ref: index.waePrefixes.get(prefix), prefix };
    if (index.prefixes.has(prefix)) return { ref: index.prefixes.get(prefix), prefix };
  }
  return null;
}

function buildResult(index, ref, matchType, token) {
  const entity = index.entities[ref.entityIndex];
  if (!entity) return null;
  let { lat, lon } = ref;
  let precision = 'entity';
  if (LARGE_ENTITY_PREFIXES.has(entity.primaryPrefix)) {
    const area = callAreaCentroid(token);
    if (area) { lat = area.lat; lon = area.lon; precision = 'area'; }
  }
  return {
    entity: entity.name,
    primaryPrefix: entity.primaryPrefix,
    cq: ref.cq,
    itu: ref.itu,
    continent: ref.continent,
    lat,
    lon,
    utcOffset: ref.utcOffset,
    matchType,
    waeOnly: entity.waeOnly,
    precision,
  };
}

function swapCallArea(headParts, digit) {
  const out = headParts.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const m = /^(.*?)(\d)([A-Z]+)$/.exec(out[i]);
    if (m) { out[i] = `${m[1]}${digit}${m[3]}`; return out; }
  }
  return out; // no call-area digit to replace → the digit was a plain designator
}

function resolveNormalized(index, call, allowWae, depth) {
  if (depth > MAX_RESOLUTION_DEPTH || !call) return null;
  const exact = lookupExact(index, call, allowWae);
  if (exact) return buildResult(index, exact, 'exact', call);

  if (!call.includes('/')) {
    const m = longestPrefix(index, call, allowWae);
    return m ? buildResult(index, m.ref, 'prefix', call) : null;
  }

  const parts = call.split('/').filter(Boolean);
  if (parts.length === 1) return resolveNormalized(index, parts[0], allowWae, depth + 1);
  const last = parts[parts.length - 1];
  const head = parts.slice(0, -1);

  // Maritime / aeronautical mobile: no fixed location (exact entries like =N2NL/MM(7) were tried above).
  if (last === 'MM' || last === 'AM') return null;

  // Single-digit suffix replaces the base call's area digit (W1AW/7 → W7AW).
  if (/^\d$/.test(last)) return resolveNormalized(index, swapCallArea(head, last).join('/'), allowWae, depth + 1);
  // Multi-digit suffixes (/70, /2026) are anniversaries, never locations.
  if (/^\d+$/.test(last)) return resolveNormalized(index, head.join('/'), allowWae, depth + 1);
  if (DESIGNATORS.has(last)) return resolveNormalized(index, head.join('/'), allowWae, depth + 1);
  if (/^[A-Z]{1,4}$/.test(last)) {
    const m = longestPrefix(index, last, true);
    if (!m || m.prefix.length !== last.length) return resolveNormalized(index, head.join('/'), allowWae, depth + 1);
  }

  if (parts.length > 2) return resolveNormalized(index, head.join('/'), allowWae, depth + 1);

  // X/Y: decide which side is the location designator.
  const [a, b] = parts;
  const ma = longestPrefix(index, a, true);
  const mb = longestPrefix(index, b, true);
  const wholeA = Boolean(ma && ma.prefix.length === a.length);
  const wholeB = Boolean(mb && mb.prefix.length === b.length);
  let designator;
  if (wholeA !== wholeB) designator = wholeA ? a : b;
  else {
    const structA = looksLikeCall(a);
    const structB = looksLikeCall(b);
    if (structA !== structB) designator = structA ? b : a;
    else if (a.length !== b.length) designator = a.length < b.length ? a : b;
    else designator = a;
  }
  const other = designator === a ? b : a;
  const chosen = longestPrefix(index, designator, allowWae);
  if (chosen) return buildResult(index, chosen.ref, 'designator', designator);
  const fallback = longestPrefix(index, other, allowWae);
  return fallback ? buildResult(index, fallback.ref, 'designator', other) : null;
}

/**
 * Resolve a callsign (or bare prefix) against a parsed cty.dat index.
 * Returns null for unknown calls, /MM, /AM, or bad input. With
 * `allowWae=false` (default) WAE-only entities are skipped in favour of the
 * next-longest DXCC match (IT9ABC → Italy); a WAE-only entity is returned only
 * when nothing else matches at all (flagged `waeOnly: true`).
 */
export function resolveCallsign(index, callsign, { allowWae = false } = {}) {
  try {
    if (!index || !(index.exact instanceof Map) || !(index.prefixes instanceof Map) || !Array.isArray(index.entities)) return null;
    const call = normalizeCall(callsign);
    if (!call) return null;
    const hit = resolveNormalized(index, call, Boolean(allowWae), 0);
    if (hit) return hit;
    if (!allowWae) return resolveNormalized(index, call, true, 0);
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download + cache resolver
// ---------------------------------------------------------------------------

/**
 * Lazily downloads cty.dat into `cacheDir/cty.dat` (reused while younger than
 * `maxAgeMs`; a stale copy is the fallback when the download fails). `ready()`
 * resolves the index or null and never rejects; `resolve()` is synchronous and
 * returns null until the index is loaded.
 */
export function createCtyResolver({
  fetchImpl = globalThis.fetch,
  cacheDir = path.join(os.tmpdir(), 'gods-eye-view'),
  url = DEFAULT_CTY_URL,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now,
  log = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const cacheFile = path.join(cacheDir, CTY_FILE_NAME);
  let index = null;
  let readyPromise = null;
  let settled = false;
  const state = { source: null, loadedAt: null, cacheMtimeMs: null, lastError: null };

  const warn = (...args) => { try { log?.warn?.(...args); } catch { /* no-op */ } };
  const info = (...args) => { try { log?.info?.(...args); } catch { /* no-op */ } };

  async function readCache() {
    try {
      const stat = await fsp.stat(cacheFile);
      if (!stat.isFile()) return null;
      const text = await fsp.readFile(cacheFile, 'utf8');
      return { text, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  async function writeCache(text) {
    const tmp = `${cacheFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, cacheFile);
    } catch (err) {
      warn(`[hamrig/cty] could not write cache ${cacheFile}: ${err?.message ?? err}`);
      try { await fsp.rm(tmp, { force: true }); } catch { /* no-op */ }
    }
  }

  async function download() {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'text/plain', 'User-Agent': CTY_USER_AGENT },
        signal: controller?.signal,
      });
      if (!response || !response.ok) throw new Error(`cty.dat download returned ${response?.status ?? 'no response'}`);
      const text = await response.text();
      if (!text || !text.trim()) throw new Error('cty.dat download was empty');
      return text;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function parseUsable(text) {
    const parsed = parseCtyDat(text);
    return parsed.entities.length > 0 ? parsed : null;
  }

  async function load() {
    const cached = await readCache();
    const cachedIndex = cached ? parseUsable(cached.text) : null;
    if (cached) state.cacheMtimeMs = cached.mtimeMs;
    if (cachedIndex && now() - cached.mtimeMs < maxAgeMs) {
      index = cachedIndex;
      state.source = 'cache';
      state.loadedAt = now();
      return index;
    }
    try {
      const text = await download();
      const parsed = parseUsable(text);
      if (!parsed) throw new Error('cty.dat parsed to zero entities');
      index = parsed;
      state.source = 'download';
      state.loadedAt = now();
      state.lastError = null;
      await writeCache(text);
      info(`[hamrig/cty] loaded ${parsed.entities.length} entities from ${url}`);
      return index;
    } catch (err) {
      state.lastError = String(err?.message ?? err);
      if (cachedIndex) {
        index = cachedIndex;
        state.source = 'stale-cache';
        state.loadedAt = now();
        warn(`[hamrig/cty] download failed (${state.lastError}); using stale cache ${cacheFile}`);
        return index;
      }
      warn(`[hamrig/cty] download failed and no cache available (${state.lastError})`);
      return null;
    }
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = load()
        .catch((err) => { state.lastError = String(err?.message ?? err); return null; })
        .then((result) => { settled = true; return result; });
    }
    return readyPromise;
  }

  function resolve(callsign, opts) {
    if (!index) return null;
    return resolveCallsign(index, callsign, opts);
  }

  function status() {
    return {
      ready: settled,
      loaded: index !== null,
      entities: index ? index.entities.length : 0,
      source: state.source,
      loadedAt: state.loadedAt,
      cacheFile,
      cacheMtimeMs: state.cacheMtimeMs,
      url,
      lastError: state.lastError,
    };
  }

  return { ready, resolve, status };
}

/** Synchronous helper for tests and scripts: parse a cty.dat file from disk. */
export function loadCtyDatFileSync(filePath) {
  return parseCtyDat(fs.readFileSync(filePath, 'utf8'));
}
