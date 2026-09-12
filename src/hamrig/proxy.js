/**
 * HamRig proxy middleware — `/api/hamrig/*` (Node-only; contract §1.6).
 *
 * One Connect middleware serves every amateur-radio route the client layers
 * need. Upstream data comes from three places:
 *  - the HamRig REST API through `createHamrigClient()` (public routes, plus
 *    login-gated `my/*` and VHF-beacon routes when credentials are configured),
 *  - three public feeds fetched directly (POTA, SOTA, KC2G ionosondes),
 *  - the live DX-cluster spot feed (`spotFeed`) and the geolocator.
 *
 * Every JSON answer carries `Cache-Control: no-store`, `generatedAt` and
 * `sources: string[]`. Errors are `{ error }` with 400 (validation), 403
 * (login not configured), 404 (no such station/route), 405, 502 (upstream)
 * or 503 (integration disabled). A throwing upstream never crashes the dev
 * server: everything is caught and mapped to 502, and short-lived in-memory
 * caches (with stale fallback) keep the layers alive through upstream blips.
 *
 * Security notes: HAMRIG_BASE_URL is operator configuration (read from `.env`
 * by the plugin), not user input, so no DNS pinning is required for it. The
 * only user-supplied values that ever reach an upstream URL are validated
 * callsigns, Maidenhead grids and range-checked numbers.
 */

import { isValidGrid } from '../data/maidenhead.js';
import {
  BANDS,
  bandForHz,
  normalizeAurora,
  normalizeBotaSpot,
  normalizeDxccStatus,
  normalizeDxpedition,
  normalizeIonosondes,
  normalizePotaSpot,
  normalizePropagation,
  normalizeReception,
  normalizeRepeaters,
  normalizeRotators,
  normalizeSotaSpot,
  normalizeStation,
  normalizeVhfBeacons,
  normalizeVoacap,
  normalizeWorkedGrids,
  normalizeWwffSpot,
} from './normalize.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HAMRIG_PROXY_USER_AGENT = 'GodsEyeView/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** Public feeds fetched directly (constants — never derived from user input). */
export const HAMRIG_DIRECT_SOURCES = Object.freeze({
  pota: 'https://api.pota.app/spot/activator',
  sota: 'https://api2.sota.org.uk/api/spots/200/all/all',
  sotaSummit: 'https://api2.sota.org.uk/api/summits/',
  kc2g: 'https://prop.kc2g.com/api/stations.json',
});

/** Upstream timeout for direct fetches (the HamRig client carries its own). */
const UPSTREAM_TIMEOUT_MS = 20000;
/** Largest direct-fetch body we buffer (the SOTA/POTA lists are ~100 KB). */
const UPSTREAM_MAX_BYTES = 16 * 1024 * 1024;
/** Largest POST body accepted by `/locate`. */
const REQUEST_BODY_MAX_BYTES = 64 * 1024;

const MINUTE = 60 * 1000;
export const HAMRIG_CACHE_TTL_MS = Object.freeze({
  activations: 60 * 1000,
  sotaSummit: 30 * 24 * 60 * MINUTE,
  dxpeditions: 30 * MINUTE,
  propagation: 5 * MINUTE,
  aurora: 10 * MINUTE,
  voacap: 10 * MINUTE,
  ionosondes: 10 * MINUTE,
  beaconsVhf: 5 * MINUTE,
  repeaters: 10 * MINUTE,
  reception: 20 * 1000,
  rotators: 10 * 1000,
  myStation: 5 * MINUTE,
});

/** A stale cache entry may still be served for this many TTLs after an upstream failure. */
const STALE_TTL_FACTOR = 10;

const CALLSIGN_RE = /^[A-Z0-9/-]{3,15}$/i;
/** Prefix-only DXpedition callsigns ('TF', 'J3') and locate() inputs may be shorter. */
const LOOSE_CALLSIGN_RE = /^[A-Z0-9/-]{1,15}$/i;
const MAX_LOCATE_CALLS = 300;
const ACTIVATION_PROGRAMS = Object.freeze(['POTA', 'SOTA', 'WWFF', 'BOTA']);
const REPEATER_BANDS = Object.freeze(['6m', '2m', '1.25m', '70cm']);
const REPEATER_KINDS = Object.freeze(['all', 'fm', 'dstar']);
const VOACAP_RESOLUTIONS = Object.freeze([5, 10, 15, 20]);
const SPOT_MODES = Object.freeze(['CW', 'SSB', 'FT8', 'FT4', 'RTTY', 'PSK', 'JS8', 'WSPR', 'MSK144', 'DIGI', 'AM', 'FM', 'SSTV', 'BEACON']);
const DIGITAL_MODES = new Set(['FT8', 'FT4', 'RTTY', 'PSK', 'JS8', 'WSPR', 'MSK144', 'DIGI']);
const BAND_NAMES = new Set(BANDS.map((row) => row.band));
const DEFAULT_HOME_GRID = 'JO32';

/** Keys that must never appear in a serialized response (contract §0). */
export const HAMRIG_FORBIDDEN_KEYS = Object.freeze([
  'email', 'email_address', 'addr1', 'addr2', 'address', 'zip', 'zip_code', 'county', 'bio', 'data_sources', 'trustee',
  'gateway_key', 'password', 'token',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function badRequest(message) { return new HttpError(400, message); }
function upstreamError(message) { return new HttpError(502, message); }

function shortMessage(error) {
  const text = typeof error === 'string' ? error : (error?.message ?? String(error ?? 'unknown error'));
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

function parseNumber(value, { name, min, max, integer = false, fallback = undefined }) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${name} is required`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw badRequest(`${name} must be a number`);
  if (integer && !Number.isInteger(number)) throw badRequest(`${name} must be an integer`);
  if (min !== undefined && number < min) throw badRequest(`${name} must be >= ${min}`);
  if (max !== undefined && number > max) throw badRequest(`${name} must be <= ${max}`);
  return number;
}

function parseCallsign(value, { name = 'callsign', loose = false, required = true } = {}) {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) {
    if (!required) return null;
    throw badRequest(`${name} is required`);
  }
  if (!(loose ? LOOSE_CALLSIGN_RE : CALLSIGN_RE).test(text)) throw badRequest(`${name} is not a valid callsign`);
  return text;
}

function parseGrid(value, { name = 'grid', fallback = null } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (!isValidGrid(text)) throw badRequest(`${name} is not a valid Maidenhead locator`);
  return text.slice(0, 2).toUpperCase() + text.slice(2, 4) + text.slice(4, 6).toLowerCase() + text.slice(6);
}

function parseChoice(value, choices, { name, fallback, transform = (v) => v }) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const candidate = transform(text);
  if (!choices.includes(candidate)) throw badRequest(`${name} must be one of ${choices.join(', ')}`);
  return candidate;
}

function parseBand(value, { name = 'band', allowed = null } = {}) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'all') return null;
  const list = allowed ?? [...BAND_NAMES];
  if (!list.includes(text)) throw badRequest(`${name} must be one of all, ${list.join(', ')}`);
  return text;
}

function ok(result) {
  return result && result.status >= 200 && result.status < 300;
}

/** Turn a client result into its JSON payload or throw a 502 for the route. */
function requireJson(result, label) {
  if (!ok(result)) {
    const detail = result?.error ? `: ${result.error}` : '';
    throw upstreamError(`HamRig ${label} returned HTTP ${result?.status ?? 0}${detail}`);
  }
  if (result.json === null || result.json === undefined) throw upstreamError(`HamRig ${label} returned no JSON`);
  if (result.json && typeof result.json === 'object' && result.json.success === false) {
    throw upstreamError(`HamRig ${label} reported ${shortMessage(result.json.error ?? 'failure')}`);
  }
  return result.json;
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function mapToObject(map) {
  const out = {};
  if (map instanceof Map) {
    for (const [key, value] of map) out[key] = value ?? null;
  } else if (map && typeof map === 'object') {
    for (const key of Object.keys(map)) out[key] = map[key] ?? null;
  }
  return out;
}

const FORBIDDEN_KEY_SET = new Set(HAMRIG_FORBIDDEN_KEYS);

/**
 * Deep-copy `value` without any forbidden key (PII / secrets), whichever
 * upstream or sibling module produced it. Applied to every payload before it
 * is serialized — the normalizers already strip PII, this is the backstop.
 */
export function scrubForbiddenKeys(value) {
  if (Array.isArray(value)) return value.map(scrubForbiddenKeys);
  if (value instanceof Map) return scrubForbiddenKeys(mapToObject(value));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY_SET.has(key)) continue;
    out[key] = scrubForbiddenKeys(value[key]);
  }
  return out;
}

/** Read a JSON request body with a hard byte cap (Connect req is an async iterable). */
async function readJsonBody(req, maxBytes = REQUEST_BODY_MAX_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Request body must be JSON');
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create the Connect middleware serving `/api/hamrig/*`.
 *
 * @param {object} options
 * @param {object|null} [options.client] HamRig client (`createHamrigClient`)
 * @param {object|null} [options.cty] cty resolver (`createCtyResolver`)
 * @param {object|null} [options.geolocator] `createGeolocator` instance
 * @param {object|null} [options.spotFeed] `createSpotFeed` instance
 * @param {typeof fetch} [options.fetchImpl] used for POTA/SOTA/KC2G direct fetches
 * @param {() => number} [options.now]
 * @param {{ warn?: Function, info?: Function }|null} [options.log]
 * @param {{ enabled?: boolean, homeGrid?: string|null, baseUrl?: string|null, spotsWsUrl?: string|null }} [options.config]
 */
export function createHamrigProxyMiddleware({
  client = null,
  cty = null,
  geolocator = null,
  spotFeed = null,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = console,
  config = {},
} = {}) {
  const enabled = config?.enabled !== false;
  const homeGrid = config?.homeGrid && isValidGrid(config.homeGrid) ? String(config.homeGrid).trim() : null;
  const sotaEnabled = config?.sotaEnabled === true;
  const SOTA_DISABLED_MESSAGE = 'disabled by configuration: the SOTA API terms require prior approval for AI-written clients — set HAMRIG_SOTA_ENABLED=1 once approved';
  const warn = (message) => { try { log?.warn?.(message); } catch { /* logging never breaks a request */ } };

  // ----- caches ------------------------------------------------------------

  const cache = new Map();
  const inflight = new Map();

  /**
   * Memoise `producer()` under `key` for `ttlMs`. Concurrent callers share one
   * in-flight promise. When the producer fails and a stale entry exists (up to
   * STALE_TTL_FACTOR × ttl old) the stale value is returned with `stale: true`.
   */
  async function cached(key, ttlMs, producer) {
    const entry = cache.get(key);
    const age = entry ? now() - entry.cachedAt : Infinity;
    if (entry && age < ttlMs) return { value: entry.value, stale: false, cachedAt: entry.cachedAt };
    if (!inflight.has(key)) {
      inflight.set(key, Promise.resolve().then(producer).finally(() => { inflight.delete(key); }));
    }
    try {
      const value = await inflight.get(key);
      const cachedAt = now();
      cache.set(key, { value, cachedAt });
      return { value, stale: false, cachedAt };
    } catch (error) {
      if (entry && age < ttlMs * STALE_TTL_FACTOR) {
        warn(`[hamrig] ${key}: ${shortMessage(error)} — serving cached copy`);
        return { value: entry.value, stale: true, cachedAt: entry.cachedAt, error };
      }
      throw error;
    }
  }

  // ----- upstream access ---------------------------------------------------

  function requireClient() {
    if (!client || !client.configured) throw new HttpError(502, 'HamRig client is not configured');
    return client;
  }

  /** GET a HamRig route and return its JSON (throws 502 on any failure). */
  async function hamrigJson(path, { query, auth = false, label = path } = {}) {
    const api = requireClient();
    let result;
    try {
      result = await api.get(path, { query, auth });
    } catch (error) {
      throw upstreamError(`HamRig ${label} failed: ${shortMessage(error)}`);
    }
    return requireJson(result, label);
  }

  /** Direct GET of a constant public URL (POTA/SOTA/KC2G) with a UA and timeout. */
  async function fetchDirectJson(url, label) {
    if (typeof fetchImpl !== 'function') throw upstreamError(`${label}: fetch is not available`);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS) : null;
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { Accept: 'application/json', 'User-Agent': HAMRIG_PROXY_USER_AGENT },
          signal: controller?.signal,
        });
      } catch (error) {
        throw upstreamError(`${label} request failed: ${shortMessage(error)}`);
      }
      if (!response || !response.ok) throw upstreamError(`${label} returned HTTP ${response?.status ?? 0}`);
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > UPSTREAM_MAX_BYTES) throw upstreamError(`${label} response too large`);
      let text;
      try {
        text = await response.text();
      } catch (error) {
        throw upstreamError(`${label} body could not be read: ${shortMessage(error)}`);
      }
      if (Buffer.byteLength(text) > UPSTREAM_MAX_BYTES) throw upstreamError(`${label} response too large`);
      try {
        return JSON.parse(text);
      } catch {
        throw upstreamError(`${label} returned invalid JSON`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  let ctyReadyPromise = null;
  /** Await the cty resolver once (memoised); never throws. */
  function ensureCty() {
    if (!cty || typeof cty.ready !== 'function') return Promise.resolve(null);
    if (!ctyReadyPromise) {
      ctyReadyPromise = Promise.resolve()
        .then(() => cty.ready())
        .catch((error) => { warn(`[hamrig] cty.dat unavailable: ${shortMessage(error)}`); return null; });
    }
    return ctyReadyPromise;
  }

  function ctyResolve(callsign) {
    try {
      return cty?.resolve?.(callsign) ?? null;
    } catch {
      return null;
    }
  }

  /** Entity-level location (sync) via the geolocator, else cty. */
  function locateEntity(callsign) {
    if (geolocator && typeof geolocator.locateEntity === 'function') {
      try {
        const loc = geolocator.locateEntity(callsign);
        if (loc) return loc;
      } catch { /* fall through to cty */ }
    }
    const hit = ctyResolve(callsign);
    if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) return null;
    return {
      lat: hit.lat,
      lon: hit.lon,
      precision: hit.precision === 'area' ? 'area' : 'entity',
      entity: hit.entity ?? null,
      continent: hit.continent ?? null,
      adif: null,
      cq: hit.cq ?? null,
    };
  }

  // ----- route handlers ----------------------------------------------------

  function statusPayload() {
    const clientStatus = client && typeof client.status === 'function' ? client.status() : null;
    let feedStatus = null;
    try { feedStatus = spotFeed && typeof spotFeed.status === 'function' ? spotFeed.status() : null; } catch { feedStatus = null; }
    return {
      enabled,
      configured: Boolean(clientStatus?.configured ?? client?.configured ?? false),
      baseUrl: clientStatus?.baseUrl ?? config?.baseUrl ?? null,
      authenticated: Boolean(clientStatus?.authenticated),
      canAuthenticate: Boolean(clientStatus?.canAuthenticate ?? client?.canAuthenticate ?? false),
      homeGrid,
      features: {
        spotsLive: Boolean(spotFeed && typeof spotFeed.getSpots === 'function'),
        myStation: Boolean(clientStatus?.canAuthenticate ?? client?.canAuthenticate ?? false),
        sota: sotaEnabled,
      },
      spotFeed: feedStatus ? { live: Boolean(feedStatus.live), updatedAt: feedStatus.updatedAt ?? null } : null,
      cty: cty && typeof cty.status === 'function' ? { loaded: Boolean(cty.status()?.loaded), entities: cty.status()?.entities ?? 0 } : null,
      sources: [],
    };
  }

  async function stationPayload(rawCallsign) {
    const callsign = parseCallsign(rawCallsign);
    await ensureCty();
    let station = null;
    if (geolocator && typeof geolocator.stationFor === 'function') {
      try {
        station = await geolocator.stationFor(callsign);
      } catch (error) {
        throw upstreamError(`Station lookup failed: ${shortMessage(error)}`);
      }
    } else {
      const ctyResult = ctyResolve(callsign);
      let payload = null;
      if (client && client.configured) {
        let result;
        try {
          result = await client.get(`/api/public/callsign-db/${encodeURIComponent(callsign)}`);
        } catch (error) {
          throw upstreamError(`HamRig callsign-db failed: ${shortMessage(error)}`);
        }
        if (ok(result) && result.json && typeof result.json === 'object') payload = result.json;
        else if (result && result.status >= 500) throw upstreamError(`HamRig callsign-db returned HTTP ${result.status}`);
      }
      station = normalizeStation(payload ?? { callsign }, ctyResult, { baseUrl: client?.status?.().baseUrl ?? config?.baseUrl, callsign });
    }
    if (!station) throw new HttpError(404, `No station found for ${callsign}`);
    return { station, sources: Array.isArray(station.sources) ? station.sources : [] };
  }

  async function locatePayload(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.calls)) throw badRequest('calls must be an array of callsigns');
    if (body.calls.length > MAX_LOCATE_CALLS) throw badRequest(`calls must contain at most ${MAX_LOCATE_CALLS} entries`);
    const precise = body.precise === true;
    const located = {};
    const valid = [];
    for (const raw of body.calls) {
      if (typeof raw !== 'string') continue;
      const call = raw.trim().toUpperCase();
      if (!call) continue;
      if (!LOOSE_CALLSIGN_RE.test(call)) { located[call] = null; continue; }
      if (!(call in located)) { located[call] = null; valid.push(call); }
    }
    await ensureCty();
    if (geolocator && typeof geolocator.locateMany === 'function') {
      let result;
      try {
        result = await geolocator.locateMany(valid, { precise });
      } catch (error) {
        throw upstreamError(`Locate failed: ${shortMessage(error)}`);
      }
      Object.assign(located, mapToObject(result));
    } else {
      for (const call of valid) located[call] = locateEntity(call);
    }
    return { located, precise, sources: precise ? ['cty.dat', 'hamrig:callsign-db'] : ['cty.dat'] };
  }

  async function spotsPayload(params) {
    const minutes = parseNumber(params.get('minutes'), { name: 'minutes', min: 1, max: 24 * 60, fallback: 60 });
    const band = parseBand(params.get('band'));
    const mode = parseChoice(params.get('mode'), [...SPOT_MODES, 'ALL'], { name: 'mode', fallback: null, transform: (v) => v.toUpperCase() });
    const dx = parseCallsign(params.get('dx'), { name: 'dx', loose: true, required: false });
    const limit = parseNumber(params.get('limit'), { name: 'limit', min: 1, max: 2000, integer: true, fallback: 500 });
    if (!spotFeed || typeof spotFeed.getSpots !== 'function') throw upstreamError('Live spot feed is not available');
    const sinceMs = now() - minutes * MINUTE;
    let result;
    try {
      result = await spotFeed.getSpots({ sinceMs, band, mode: mode && mode !== 'ALL' ? mode : null, dx, limit: Math.min(2000, limit * 2) });
    } catch (error) {
      throw upstreamError(`Spot feed failed: ${shortMessage(error)}`);
    }
    let spots = Array.isArray(result?.spots) ? result.spots : Array.isArray(result) ? result : [];
    spots = spots.filter((spot) => {
      if (!spot || typeof spot !== 'object') return false;
      const ms = Date.parse(spot.timeIso ?? '');
      if (Number.isFinite(ms) && ms < sinceMs) return false;
      if (band && spot.band !== band) return false;
      if (mode && mode !== 'ALL') {
        const spotMode = spot.mode ? String(spot.mode).toUpperCase() : null;
        if (mode === 'DIGI' ? !DIGITAL_MODES.has(spotMode) : spotMode !== mode) return false;
      }
      if (dx && String(spot.dx ?? '').toUpperCase() !== dx) return false;
      return true;
    });
    spots = spots.slice(0, limit);
    return {
      spots,
      live: Boolean(result?.live),
      updatedAt: result?.updatedAt ?? null,
      filter: { minutes, band: band ?? 'all', mode: mode ?? 'all', dx, limit },
      sources: [result?.live ? 'hamrig:spots-ws' : 'hamrig:spots-rest', 'cty.dat'],
    };
  }

  const summitCache = new Map();
  async function sotaSummit(summitCode) {
    const code = String(summitCode ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,4}\/[A-Z]{2}-\d{3}$/.test(code)) return null;
    const hit = summitCache.get(code);
    if (hit && now() - hit.cachedAt < HAMRIG_CACHE_TTL_MS.sotaSummit) return hit.value;
    try {
      const summit = await fetchDirectJson(`${HAMRIG_DIRECT_SOURCES.sotaSummit}${encodeURIComponent(code)}`, 'SOTA summit');
      summitCache.set(code, { value: summit, cachedAt: now() });
      return summit;
    } catch {
      summitCache.set(code, { value: null, cachedAt: now() });
      return null;
    }
  }

  const activationLoaders = {
    POTA: async () => {
      const rows = await fetchDirectJson(HAMRIG_DIRECT_SOURCES.pota, 'POTA');
      if (!Array.isArray(rows)) throw upstreamError('POTA returned an unexpected payload');
      const nowMs = now();
      return rows.map((row) => normalizePotaSpot(row, { nowMs })).filter(Boolean);
    },
    SOTA: async () => {
      const rows = await fetchDirectJson(HAMRIG_DIRECT_SOURCES.sota, 'SOTA');
      if (!Array.isArray(rows)) throw upstreamError('SOTA returned an unexpected payload');
      const nowMs = now();
      const out = [];
      for (const row of rows) {
        let summit = null;
        const hasPosition = Number.isFinite(Number(row?.latitude)) && Number.isFinite(Number(row?.longitude))
          && row?.latitude !== null && row?.longitude !== null;
        if (!hasPosition && row?.summitCode) summit = await sotaSummit(row.summitCode);
        const activation = normalizeSotaSpot(row, summit, { nowMs });
        if (activation) out.push(activation);
      }
      return out;
    },
    WWFF: async () => {
      const payload = await hamrigJson('/api/wwff', { label: 'wwff' });
      const rows = Array.isArray(payload?.spots) ? payload.spots : [];
      const nowMs = now();
      return rows.map((row) => normalizeWwffSpot(row, { nowMs })).filter(Boolean);
    },
    BOTA: async () => {
      const payload = await hamrigJson('/api/bota', { label: 'bota' });
      const rows = Array.isArray(payload?.spots) ? payload.spots : [];
      const nowMs = now();
      return rows.map((row) => normalizeBotaSpot(row, { nowMs })).filter(Boolean);
    },
  };
  const ACTIVATION_SOURCES = {
    POTA: 'pota:api.pota.app',
    SOTA: 'sota:api2.sota.org.uk',
    WWFF: 'hamrig:wwff (WWFF Spotline)',
    BOTA: 'hamrig:bota (WWBOTA)',
  };

  async function activationsPayload(params) {
    const programsRaw = String(params.get('programs') ?? '').trim();
    const programs = programsRaw
      ? programsRaw.split(',').map((p) => p.trim().toUpperCase()).filter(Boolean)
      : [...ACTIVATION_PROGRAMS];
    for (const program of programs) {
      if (!ACTIVATION_PROGRAMS.includes(program)) throw badRequest(`programs must be a subset of ${ACTIVATION_PROGRAMS.join(',').toLowerCase()}`);
    }
    const limit = parseNumber(params.get('limit'), { name: 'limit', min: 1, max: 2000, integer: true, fallback: 400 });
    const requested = [...new Set(programs)];
    const unique = sotaEnabled ? requested : requested.filter((program) => program !== 'SOTA');
    const outcomes = await Promise.all(unique.map((program) => cached(`activations:${program}`, HAMRIG_CACHE_TTL_MS.activations, activationLoaders[program])
      .then((hit) => ({ program, ok: true, hit }))
      .catch((error) => ({ program, ok: false, error }))));
    const errors = {};
    if (requested.includes('SOTA') && !sotaEnabled) errors.SOTA = SOTA_DISABLED_MESSAGE;
    const sources = [];
    let activations = [];
    let updatedAt = 0;
    let anySuccess = false;
    let stale = false;
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        errors[outcome.program] = shortMessage(outcome.error);
        continue;
      }
      anySuccess = true;
      sources.push(ACTIVATION_SOURCES[outcome.program]);
      if (outcome.hit.stale) { stale = true; errors[outcome.program] = `${shortMessage(outcome.hit.error)} (cached copy)`; }
      activations = activations.concat(outcome.hit.value);
      updatedAt = Math.max(updatedAt, outcome.hit.cachedAt);
    }
    if (!anySuccess && unique.length) {
      throw new HttpError(502, `Activation feeds unavailable: ${Object.values(errors).join('; ')}`, { errors, activations: [] });
    }
    activations.sort((a, b) => Date.parse(b.timeIso ?? 0) - Date.parse(a.timeIso ?? 0));
    return {
      activations: activations.slice(0, limit),
      updatedAt: new Date(updatedAt || now()).toISOString(),
      errors,
      stale,
      programs: unique,
      sources,
    };
  }

  async function dxpeditionsPayload() {
    await ensureCty();
    const hit = await cached('dxpeditions', HAMRIG_CACHE_TTL_MS.dxpeditions, async () => {
      const [opsOutcome, wantedOutcome] = await Promise.allSettled([
        hamrigJson('/api/dx-operations', { label: 'dx-operations' }),
        hamrigJson('/api/mostwanted', { label: 'mostwanted' }),
      ]);
      if (opsOutcome.status === 'rejected') throw opsOutcome.reason;
      const ops = Array.isArray(opsOutcome.value?.operations) ? opsOutcome.value.operations : [];
      const wantedRows = wantedOutcome.status === 'fulfilled' && Array.isArray(wantedOutcome.value?.operations)
        ? wantedOutcome.value.operations
        : [];
      if (wantedOutcome.status === 'rejected') warn(`[hamrig] mostwanted unavailable: ${shortMessage(wantedOutcome.reason)}`);
      const wantedByCall = new Map();
      for (const row of wantedRows) {
        const call = String(row?.callsign ?? '').trim().toUpperCase();
        if (call && !wantedByCall.has(call)) wantedByCall.set(call, row);
      }
      const operations = ops.map((op) => normalizeDxpedition(op, wantedByCall, locateEntity)).filter(Boolean);
      const sources = ['hamrig:dx-operations (NG3K ADXO)', 'cty.dat'];
      if (wantedOutcome.status === 'fulfilled') sources.push('hamrig:mostwanted (Club Log)');
      return { operations, sources };
    });
    return {
      operations: hit.value.operations,
      updatedAt: new Date(hit.cachedAt).toISOString(),
      stale: hit.stale,
      sources: hit.value.sources,
    };
  }

  async function propagationPayload(params) {
    const grid = parseGrid(params.get('grid'), { fallback: homeGrid ?? DEFAULT_HOME_GRID });
    const gridKey = grid.slice(0, 4).toUpperCase();
    const hit = await cached(`propagation:${gridKey}`, HAMRIG_CACHE_TTL_MS.propagation, async () => {
      const [conditions, solarExtended, iono] = await Promise.allSettled([
        hamrigJson('/api/propagation/conditions', { label: 'propagation/conditions' }),
        hamrigJson('/api/solar-extended', { label: 'solar-extended' }),
        hamrigJson('/api/iono', { query: { grid: gridKey }, label: 'iono' }),
      ]);
      const pick = (outcome) => (outcome.status === 'fulfilled' ? outcome.value : null);
      const failures = [conditions, solarExtended, iono].filter((o) => o.status === 'rejected').map((o) => shortMessage(o.reason));
      if (failures.length === 3) throw upstreamError(`Propagation feeds unavailable: ${failures.join('; ')}`);
      const summary = normalizePropagation({ conditions: pick(conditions), solarExtended: pick(solarExtended), iono: pick(iono) });
      return { ...summary, grid: gridKey, errors: failures };
    });
    return { ...hit.value, stale: hit.stale, updatedAt: new Date(hit.cachedAt).toISOString() };
  }

  async function auroraPayload() {
    const hit = await cached('aurora', HAMRIG_CACHE_TTL_MS.aurora, async () => {
      const payload = await hamrigJson('/api/overlay/aurora', { label: 'overlay/aurora' });
      const aurora = normalizeAurora(payload);
      return { ...aurora, points: aurora.points.filter((point) => point.value > 5), sources: ['hamrig:overlay-aurora (NOAA SWPC OVATION)'] };
    });
    return { ...hit.value, stale: hit.stale, updatedAt: new Date(hit.cachedAt).toISOString() };
  }

  async function voacapPayload(params) {
    const lat = parseNumber(params.get('lat'), { name: 'lat', min: -90, max: 90 });
    const lon = parseNumber(params.get('lon'), { name: 'lon', min: -180, max: 180 });
    const frequencyMhz = parseNumber(params.get('frequencyMhz') ?? params.get('frequency'), { name: 'frequencyMhz', min: 1.8, max: 30, fallback: 14.1 });
    const hourParam = params.get('hour');
    const hour = hourParam === null || hourParam === '' || hourParam === 'now'
      ? new Date(now()).getUTCHours()
      : parseNumber(hourParam, { name: 'hour', min: 0, max: 23, integer: true });
    const resolution = parseNumber(params.get('resolution'), { name: 'resolution', integer: true, fallback: 10 });
    if (!VOACAP_RESOLUTIONS.includes(resolution)) throw badRequest(`resolution must be one of ${VOACAP_RESOLUTIONS.join(', ')}`);
    const key = `voacap:${lat.toFixed(2)}|${lon.toFixed(2)}|${frequencyMhz}|${hour}|${resolution}`;
    const hit = await cached(key, HAMRIG_CACHE_TTL_MS.voacap, async () => {
      const payload = await hamrigJson('/api/overlay/voacap', {
        query: { tx_lat: lat.toFixed(4), tx_lon: lon.toFixed(4), frequency: frequencyMhz, hour, resolution },
        label: 'overlay/voacap',
      });
      const grid = normalizeVoacap(payload);
      return {
        ...grid,
        txLat: grid.txLat ?? lat,
        txLon: grid.txLon ?? lon,
        frequencyMhz: grid.frequencyMhz ?? frequencyMhz,
        utcHour: grid.utcHour ?? hour,
        resolution,
        sources: ['hamrig:overlay-voacap (VOACAP)'],
      };
    });
    return { ...hit.value, stale: hit.stale, updatedAt: new Date(hit.cachedAt).toISOString() };
  }

  async function ionosondesPayload() {
    const hit = await cached('ionosondes', HAMRIG_CACHE_TTL_MS.ionosondes, async () => {
      const rows = await fetchDirectJson(HAMRIG_DIRECT_SOURCES.kc2g, 'KC2G ionosondes');
      if (!Array.isArray(rows)) throw upstreamError('KC2G ionosondes returned an unexpected payload');
      return normalizeIonosondes(rows, { nowMs: now() });
    });
    return { stations: hit.value, stale: hit.stale, updatedAt: new Date(hit.cachedAt).toISOString(), sources: ['kc2g:prop.kc2g.com (GIRO)'] };
  }

  function requireLogin(extra = null) {
    if (!client || !client.configured || !client.canAuthenticate) {
      throw new HttpError(403, 'HamRig login not configured', extra);
    }
  }

  async function beaconsVhfPayload() {
    requireLogin({ beacons: [] });
    const hit = await cached('beacons:vhf', HAMRIG_CACHE_TTL_MS.beaconsVhf, async () => {
      const payload = await hamrigJson('/api/beacons/vhf', { auth: true, label: 'beacons/vhf' });
      return normalizeVhfBeacons(payload);
    });
    return { beacons: hit.value, stale: hit.stale, updatedAt: new Date(hit.cachedAt).toISOString(), sources: ['hamrig:beacons-vhf'] };
  }

  async function repeatersPayload(params) {
    const lat = parseNumber(params.get('lat'), { name: 'lat', min: -90, max: 90 });
    const lon = parseNumber(params.get('lon'), { name: 'lon', min: -180, max: 180 });
    const radiusKm = parseNumber(params.get('radiusKm') ?? params.get('radius'), { name: 'radiusKm', min: 1, max: 500, fallback: 100 });
    const limit = parseNumber(params.get('limit'), { name: 'limit', min: 1, max: 200, integer: true, fallback: 200 });
    const band = parseBand(params.get('band'), { allowed: [...REPEATER_BANDS] });
    const kind = parseChoice(params.get('kind'), [...REPEATER_KINDS], { name: 'kind', fallback: 'all', transform: (v) => v.toLowerCase() });
    const key = `repeaters:${(Math.round(lat * 10) / 10).toFixed(1)}|${(Math.round(lon * 10) / 10).toFixed(1)}|${Math.round(radiusKm)}|${limit}|${band ?? 'all'}|${kind}`;
    const hit = await cached(key, HAMRIG_CACHE_TTL_MS.repeaters, async () => {
      const wantFm = kind === 'all' || kind === 'fm';
      const wantDstar = kind === 'all' || kind === 'dstar';
      const fmQuery = { lat: lat.toFixed(4), lng: lon.toFixed(4), radius: Math.round(radiusKm), limit };
      if (band) fmQuery.band = band;
      const [fm, dstar] = await Promise.allSettled([
        wantFm ? hamrigJson('/api/fm/repeaters/nearby', { query: fmQuery, label: 'fm/repeaters/nearby' }) : Promise.resolve(null),
        wantDstar
          ? hamrigJson('/api/dstar/repeaters/nearby', { query: { lat: lat.toFixed(4), lng: lon.toFixed(4), radius: Math.round(radiusKm), limit: Math.min(limit, 100) }, label: 'dstar/repeaters/nearby' })
          : Promise.resolve(null),
      ]);
      const errors = {};
      if (fm.status === 'rejected') errors.FM = shortMessage(fm.reason);
      if (dstar.status === 'rejected') errors['D-STAR'] = shortMessage(dstar.reason);
      const requested = (wantFm ? 1 : 0) + (wantDstar ? 1 : 0);
      if (Object.keys(errors).length === requested) throw upstreamError(`Repeater feeds unavailable: ${Object.values(errors).join('; ')}`);
      let repeaters = normalizeRepeaters(fm.status === 'fulfilled' ? fm.value : null, dstar.status === 'fulfilled' ? dstar.value : null);
      if (band) repeaters = repeaters.filter((r) => (r.outputHz ? bandForHz(r.outputHz) === band : false));
      const sources = [];
      if (fm.status === 'fulfilled' && wantFm) sources.push('hamrig:fm-repeaters');
      if (dstar.status === 'fulfilled' && wantDstar) sources.push('hamrig:dstar-repeaters');
      return { repeaters: repeaters.slice(0, limit), errors, sources };
    });
    return {
      ...hit.value,
      search: { lat, lon, radiusKm, band: band ?? 'all', kind, limit },
      stale: hit.stale,
      updatedAt: new Date(hit.cachedAt).toISOString(),
    };
  }

  async function receptionPayload(params) {
    const call = parseCallsign(params.get('call'), { name: 'call', required: false });
    const grid = parseGrid(params.get('grid'));
    if (!call && !grid) throw badRequest('call or grid is required');
    const minutes = parseNumber(params.get('minutes'), { name: 'minutes', min: 1, max: 24 * 60, integer: true, fallback: 30 });
    const key = `reception:${call ?? ''}|${grid ? grid.slice(0, 2).toUpperCase() : ''}|${minutes}`;
    const hit = await cached(key, HAMRIG_CACHE_TTL_MS.reception, async () => {
      const [psk, wspr] = await Promise.allSettled([
        call ? hamrigJson('/api/pskreporter', { query: { call, minutes }, label: 'pskreporter' }) : Promise.resolve(null),
        grid ? hamrigJson('/api/wspr', { query: { grid, minutes }, label: 'wspr' }) : Promise.resolve(null),
      ]);
      const errors = {};
      if (psk.status === 'rejected') errors.psk = shortMessage(psk.reason);
      if (wspr.status === 'rejected') errors.wspr = shortMessage(wspr.reason);
      const requested = (call ? 1 : 0) + (grid ? 1 : 0);
      if (Object.keys(errors).length === requested) throw upstreamError(`Reception feeds unavailable: ${Object.values(errors).join('; ')}`);
      const reception = normalizeReception(psk.status === 'fulfilled' ? psk.value : null, wspr.status === 'fulfilled' ? wspr.value : null);
      const sources = [];
      if (call && psk.status === 'fulfilled') sources.push('hamrig:pskreporter (PSKReporter MQTT)');
      if (grid && wspr.status === 'fulfilled') sources.push('hamrig:wspr (wspr.live)');
      return { ...reception, errors, sources };
    });
    return {
      ...hit.value,
      warmingUp: Boolean(hit.value.psk?.warmingUp),
      query: { call, grid, minutes },
      stale: hit.stale,
      updatedAt: new Date(hit.cachedAt).toISOString(),
    };
  }

  async function myPayload(kind) {
    requireLogin();
    if (kind === 'dxcc-status') {
      const hit = await cached('my:dxcc-status', HAMRIG_CACHE_TTL_MS.myStation, async () => {
        const payload = await hamrigJson('/api/map/data/dxcc-status', { auth: true, label: 'map/data/dxcc-status' });
        return {
          entities: normalizeDxccStatus(payload),
          worked: Number(payload?.worked) || 0,
          total: Number(payload?.total) || 0,
          scoped: payload?.scoped ?? null,
        };
      });
      return { ...hit.value, stale: hit.stale, updatedAt: new Date(hit.cachedAt).toISOString(), sources: ['hamrig:map-data/dxcc-status'] };
    }
    if (kind === 'worked-grids') {
      const hit = await cached('my:worked-grids', HAMRIG_CACHE_TTL_MS.myStation, async () => {
        const payload = await hamrigJson('/api/map/data/worked-grids', { auth: true, label: 'map/data/worked-grids' });
        return { grids: normalizeWorkedGrids(payload), total: Number(payload?.total) || 0 };
      });
      return { ...hit.value, stale: hit.stale, updatedAt: new Date(hit.cachedAt).toISOString(), sources: ['hamrig:map-data/worked-grids'] };
    }
    if (kind === 'rotators') {
      const hit = await cached('my:rotators', HAMRIG_CACHE_TTL_MS.rotators, async () => {
        const list = await hamrigJson('/api/rotators', { auth: true, label: 'rotators' });
        const rows = Array.isArray(list) ? list : Array.isArray(list?.rotators) ? list.rotators : Array.isArray(list?.list) ? list.list : [];
        const statuses = new Map();
        await Promise.all(rows.map(async (row) => {
          const id = row?.id;
          if (id === null || id === undefined || !/^[A-Za-z0-9_-]{1,32}$/.test(String(id))) return;
          try {
            const status = await hamrigJson(`/api/rotators/${encodeURIComponent(String(id))}/status`, { auth: true, label: 'rotators/status' });
            if (status && typeof status === 'object') statuses.set(String(id), status);
          } catch (error) {
            warn(`[hamrig] rotator ${id} status unavailable: ${shortMessage(error)}`);
          }
        }));
        return { rotators: normalizeRotators(rows, statuses) };
      });
      return { ...hit.value, stale: hit.stale, updatedAt: new Date(hit.cachedAt).toISOString(), sources: ['hamrig:rotators'] };
    }
    throw new HttpError(404, 'Unknown HamRig route');
  }

  // ----- dispatch ----------------------------------------------------------

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(scrubForbiddenKeys({ generatedAt: isoNow(now), sources: [], ...body })));
  }

  function methodNotAllowed(res, allow) {
    res.writeHead(405, { Allow: allow, 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `Method not allowed (use ${allow})`, generatedAt: isoNow(now), sources: [] }));
  }

  async function route(req, pathname, params) {
    const method = String(req.method || 'GET').toUpperCase();
    const segments = pathname.split('/').filter(Boolean);
    const head = segments[0] ?? '';

    if (head === 'locate') {
      if (segments.length !== 1) throw new HttpError(404, 'Unknown HamRig route');
      if (method !== 'POST') return { status: 405, allow: 'POST' };
      return { status: 200, body: await locatePayload(await readJsonBody(req)) };
    }
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, allow: 'GET' };

    if (head === 'status' && segments.length === 1) return { status: 200, body: statusPayload() };
    if (head === 'station' && segments.length === 2) return { status: 200, body: await stationPayload(decodeURIComponent(segments[1])) };
    if (head === 'spots' && segments.length === 1) return { status: 200, body: await spotsPayload(params) };
    if (head === 'activations' && segments.length === 1) return { status: 200, body: await activationsPayload(params) };
    if (head === 'dxpeditions' && segments.length === 1) return { status: 200, body: await dxpeditionsPayload() };
    if (head === 'propagation' && segments.length === 1) return { status: 200, body: await propagationPayload(params) };
    if (head === 'aurora' && segments.length === 1) return { status: 200, body: await auroraPayload() };
    if (head === 'voacap' && segments.length === 1) return { status: 200, body: await voacapPayload(params) };
    if (head === 'ionosondes' && segments.length === 1) return { status: 200, body: await ionosondesPayload() };
    if (head === 'beacons' && segments[1] === 'vhf' && segments.length === 2) return { status: 200, body: await beaconsVhfPayload() };
    if (head === 'repeaters' && segments.length === 1) return { status: 200, body: await repeatersPayload(params) };
    if (head === 'reception' && segments.length === 1) return { status: 200, body: await receptionPayload(params) };
    if (head === 'my' && segments.length === 2) return { status: 200, body: await myPayload(segments[1]) };
    throw new HttpError(404, 'Unknown HamRig route');
  }

  return async function hamrigProxyMiddleware(req, res, next) {
    let requestUrl;
    try {
      requestUrl = new URL(req.url || '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Malformed request URL' });
      return;
    }
    // Connect strips the mount prefix (`server.middlewares.use('/api/hamrig', …)`);
    // tolerate the unstripped form as well so the middleware can be mounted anywhere.
    let pathname = requestUrl.pathname.replace(/^\/api\/hamrig(?=\/|$)/, '') || '/';
    pathname = pathname.replace(/\/+$/, '') || '/';

    if (!enabled) {
      sendJson(res, 503, { error: 'HamRig integration disabled', enabled: false });
      return;
    }

    try {
      const outcome = await route(req, pathname, requestUrl.searchParams);
      if (outcome.status === 405) {
        methodNotAllowed(res, outcome.allow);
        return;
      }
      sendJson(res, outcome.status, outcome.body);
    } catch (error) {
      if (error instanceof HttpError) {
        const status = error.status;
        if (status >= 500) warn(`[hamrig] ${req.method} ${pathname}: ${error.message}`);
        sendJson(res, status, { error: error.message, ...(error.extra ?? {}) });
        return;
      }
      warn(`[hamrig] ${req.method} ${pathname} crashed: ${shortMessage(error)}`);
      sendJson(res, 502, { error: `HamRig upstream failure: ${shortMessage(error)}` });
    }
  };
}
