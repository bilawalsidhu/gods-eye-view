/**
 * Cloudflare Pages Function — /api/tomtom/[[path]] (catch-all)
 *
 * Lives at a catch-all because the client only ever calls SUBPATHS
 * (`/api/tomtom/status`, `/api/tomtom/flow/{z}/{x}/{y}.pbf`); Pages routes a
 * static function file at its EXACT path only, so the previous flat
 * `tomtom.js` never answered those requests on real deployments (they fell
 * through to the SPA's index.html).
 * TomTom flow-tile proxy: the production counterpart of the dev middleware in
 * `vite.config.js` (tomtom-proxy). Replaces an earlier host-swap forwarder
 * that relayed ANY path on api.tomtom.com with the account key appended (an
 * open, billable proxy) and built a nonexistent upstream path, so the flow
 * layer was broken on Pages deployments anyway.
 *
 * Routes (same contract as dev):
 *   GET /api/tomtom/status              → {hasKey, dailyCount, budget, date}
 *   GET /api/tomtom/flow/{z}/{x}/{y}.pbf → application/x-protobuf tile
 *     400 {error:'invalid_tile'} · 404 {error:'not_found'}
 *     429 {error:'budget'}       · 503 {error:'no_key'}
 *     502 {error:'upstream'}     · 500 {error:'proxy'}
 *   OPTIONS → 204 CORS preflight
 *
 * Quota protection: tiles are single-flighted per key with a 120 s TTL and a
 * soft daily budget (TOMTOM_DAILY_TILE_BUDGET, default 40 000 — the free
 * tier) that resets per UTC date. Workers are multi-isolate, so the counter
 * is per-isolate — a backstop, not a global quota (same honesty note as the
 * dev limiter in functions/_lib.js); a hard global cap needs a Durable
 * Object and stays out of scope until the budget is actually hit.
 *
 * The key never appears in a response, a cache header, or an error message.
 */
import { jsonResponse, methodNotAllowed } from '../../_lib.js';
import { isValidTileCoord } from '../../../src/data/tomtomTiles.js';

/** How long a fetched tile is served without re-fetching (dev parity). */
const TILE_TTL_MS = 120_000;
/** Memory-cache ceiling (dev parity: 256 entries, oldest evicted). */
const MEM_MAX_ENTRIES = 256;
/** Upstream call bound (dev parity). */
const UPSTREAM_TIMEOUT_MS = 15_000;
/** Soft daily tile cap when TOMTOM_DAILY_TILE_BUDGET is unset. */
const DEFAULT_DAILY_BUDGET = 40_000;

// Per-isolate state: tile cache, single-flight map, daily budget counter.
const mem = new Map();
const inflight = new Map();
const budget = { date: utcDate(), count: 0 };

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method !== 'GET') return methodNotAllowed();

  try {
    const urlPath = new URL(request.url).pathname.replace(/\/+$/, '');
    const dailyLimit = dailyBudgetLimit(env);

    if (/\/tomtom\/status$/.test(urlPath)) {
      return jsonResponse({
        hasKey: Boolean(env?.TOMTOM_API_KEY),
        dailyCount: budgetCount().count,
        budget: dailyLimit,
        date: budgetCount().date,
      }, { cacheControl: 'no-store' });
    }

    const m = urlPath.match(/\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (!m) return jsonResponse({ error: 'not_found' }, { status: 404, cacheControl: 'no-store' });
    const z = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    if (!isValidTileCoord(z, x, y)) {
      return jsonResponse({ error: 'invalid_tile' }, { status: 400, cacheControl: 'no-store' });
    }
    if (!env?.TOMTOM_API_KEY) {
      return jsonResponse({ error: 'no_key' }, { status: 503, cacheControl: 'no-store' });
    }
    const key = `${z}/${x}/${y}`;
    const now = Date.now();

    // Fresh cache hit — never counts against the budget.
    const entry = mem.get(key);
    if (entry && now - entry.at < TILE_TTL_MS) return sendTile(entry.buf, 'HIT');

    // Budget governor: over the soft cap, last-good data beats a dead layer.
    if (budgetCount().count >= dailyLimit) {
      if (entry) return sendTile(entry.buf, 'STALE-BUDGET');
      return jsonResponse({ error: 'budget' }, { status: 429, cacheControl: 'no-store' });
    }

    // Stale or missing → refresh, single-flight per tile.
    if (!inflight.has(key)) {
      inflight.set(key, fetchUpstream(env, z, x, y)
        .then((buf) => {
          const fresh = { at: Date.now(), buf };
          memSet(key, fresh);
          return fresh;
        })
        .catch(() => null)
        .finally(() => inflight.delete(key)));
    }
    const fresh = await inflight.get(key);
    if (fresh) return sendTile(fresh.buf, 'MISS');
    if (entry) return sendTile(entry.buf, 'STALE-ERROR'); // upstream down — stale beats empty
    return jsonResponse({ error: 'upstream' }, { status: 502, cacheControl: 'no-store' });
  } catch (err) {
    console.warn('[/api/tomtom]', err?.message || err);
    return jsonResponse({ error: 'proxy' }, { status: 500, cacheControl: 'no-store' });
  }
}

/** Explicit upstream build — the ONLY path that ever reaches TomTom. */
async function fetchUpstream(env, z, x, y) {
  const url = 'https://api.tomtom.com/traffic/map/4/tile/flow/relative/'
    + `${z}/${x}/${y}.pbf?key=${encodeURIComponent(env.TOMTOM_API_KEY)}`;
  budget.count += 1; // attempts count — upstream bills the request either way
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty tile body');
  return buf;
}

/** The daily budget object rolls over per UTC date (read → maybe reset). */
function budgetCount() {
  const today = utcDate();
  if (budget.date !== today) {
    budget.date = today;
    budget.count = 0;
  }
  return budget;
}

function dailyBudgetLimit(env) {
  const raw = Number.parseInt(String(env?.TOMTOM_DAILY_TILE_BUDGET ?? ''), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

/** LRU-ish memory insert (Map preserves insertion order; evict the oldest). */
function memSet(key, entry) {
  if (!mem.has(key) && mem.size >= MEM_MAX_ENTRIES) {
    mem.delete(mem.keys().next().value);
  }
  mem.set(key, entry);
}

function sendTile(buf, cacheStatus) {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-protobuf',
      'Cache-Control': 'no-store',
      'x-tomtom-cache': cacheStatus,
    },
  });
}

/** Test seam: the budget/cache state is module-scoped. */
export function resetTomTomStateForTest() {
  mem.clear();
  inflight.clear();
  budget.date = utcDate();
  budget.count = 0;
}

/** Test seam: age one cached tile past the TTL without waiting 120 s. */
export function expireTomTomTileForTest(key) {
  const entry = mem.get(key);
  if (entry) entry.at = Date.now() - TILE_TTL_MS - 1;
}
