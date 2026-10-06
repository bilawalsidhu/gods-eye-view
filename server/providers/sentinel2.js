import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  SENTINEL_HUB_CATALOG_URL,
  SENTINEL_HUB_ORIGINS,
  SENTINEL_HUB_PROCESS_URL,
  SENTINEL_HUB_TOKEN_URL,
  SENTINEL2_DEFAULT_DAILY_BUDGET,
  SENTINEL2_MAX_CLOUD,
  SENTINEL2_MAX_ZOOM,
  SENTINEL2_MIN_ZOOM,
  SENTINEL2_WINDOW_DAYS,
  buildSentinel2CatalogSearch,
  buildSentinel2ProcessRequest,
  isValidSentinel2Tile,
  pickLeastCloudyScene,
  quantizeScenePoint,
} from '../../src/data/sentinel2Tiles.js';
import {
  isOverBudget,
  normalizeBudget,
  utcDayKey,
} from '../../src/data/tomtomTiles.js';
import {
  readResponseBytesCapped,
  readResponseJsonCapped,
} from './common/http.js';
import { admitSameSite } from './common/same-site.js';

/**
 * "Sentinel-2 Latest" tile proxy: Copernicus Data Space Ecosystem (CDSE)
 * Sentinel Hub, true colour, least-cloudy scene of the trailing 30 days.
 *
 * Credentials: SENTINEL_HUB_CLIENT_ID + SENTINEL_HUB_CLIENT_SECRET, an OAuth
 * client from the CDSE dashboard. SERVER-SIDE ONLY: the server mints a
 * client-credentials bearer token, keeps it in memory (never on disk), and
 * the browser fetches same-origin `/api/sentinel2/tile/{z}/{x}/{y}.png`. The
 * secret and the token never appear in a response or a log line.
 *
 * Token: reused until 60 s before `expires_in`, single-flight (concurrent
 * tiles share one token request — CDSE rate-limits token requests), a 30 s
 * cooldown after a failed mint, and one forced re-mint when Sentinel Hub
 * answers 401 (a revoked or rotated client). Mirrors getOpenSkyToken.
 *
 * Tiles: memory LRU + disk (.gev-cache/sentinel2/), TTL 48 h, single-flight
 * per tile, serve-stale-on-failure — the tomtomProxy pattern. A 30-day
 * least-cloudy mosaic changes at most once per Sentinel-2 revisit (~5 days),
 * so a long TTL costs little freshness and saves the free quota. Zoom is
 * limited to z8-z14 (see src/data/sentinel2Tiles.js); the browser layer never
 * asks outside it and the proxy refuses it.
 *
 * Budget: CDSE's free tier is 10,000 requests / month. A persistent UTC-day
 * counter (.gev-cache/sentinel2/budget.json) counts every Sentinel Hub
 * request (tiles + scene lookups) against SENTINEL_HUB_DAILY_REQUEST_BUDGET
 * (default 300/day ≈ 9,300/month). Over it, stale tiles are served when
 * cached, else 429 {error:'budget'} and the map falls back to Esri.
 *
 * Allowlist: upstream URLs are fixed constants — the browser supplies only
 * integer z/x/y or a lon/lat — and every fetch is checked against
 * SENTINEL_HUB_ORIGINS with redirects refused. Every route passes the shared
 * cross-site gate, so a foreign page cannot spend the quota through a
 * visitor's browser.
 *
 * Routes:
 *   GET /api/sentinel2/status            → {hasKey, dailyCount, budget, date, minZoom, maxZoom, windowDays, maxCloud}
 *   GET /api/sentinel2/tile/{z}/{x}/{y}.png → image/png
 *   GET /api/sentinel2/scene?lon=&lat=   → {date, datetime, cloudCover, windowDays, maxCloud} (date null when no scene)
 *
 * Keyless: status reports hasKey:false, tile and scene answer 503
 * {error:'no_key'}, and upstream is never touched.
 *
 * @returns {import('vite').Plugin}
 */
export function sentinel2Proxy() {
  const TILE_TTL_MS = 48 * 3_600_000;
  const SCENE_TTL_MS = 6 * 3_600_000;
  const TOKEN_MARGIN_MS = 60_000;
  const TOKEN_FAILURE_COOLDOWN_MS = 30_000;
  const UPSTREAM_TIMEOUT_MS = 20_000;
  const MAX_TILE_BYTES = 2 * 1024 * 1024;
  const MAX_JSON_BYTES = 1024 * 1024;
  const MEM_MAX_TILES = 256;
  const MEM_MAX_SCENES = 512;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache', 'sentinel2');
  const BUDGET_PATH = path.join(CACHE_DIR, 'budget.json');

  /** @type {Map<string, {at:number, buf:Uint8Array}>} `z/x/y` → tile, kept past TTL for serve-stale. */
  const tiles = new Map();
  /** @type {Map<string, Promise<{at:number, buf:Uint8Array}|null>>} single-flight per tile. */
  const tileInflight = new Map();
  /** @type {Map<string, {at:number, scene:object|null}>} quantized cell → scene. */
  const scenes = new Map();
  /** @type {Map<string, Promise<{at:number, scene:object|null}|null>>} */
  const sceneInflight = new Map();

  /** @type {?{value: string, expiresAt: number, clientId: string}} */
  let token = null;
  /** @type {?Promise<?string>} */
  let tokenInflight = null;
  let tokenFailedAt = -Infinity;

  /** @type {{date:string, count:number}|null} */
  let budget = null;
  let budgetLoaded = false;

  const credentials = () => {
    const clientId = String(process.env.SENTINEL_HUB_CLIENT_ID || '').trim();
    const clientSecret = String(
      process.env.SENTINEL_HUB_CLIENT_SECRET || '',
    ).trim();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  };

  function dailyBudgetLimit() {
    const raw = Number.parseInt(
      process.env.SENTINEL_HUB_DAILY_REQUEST_BUDGET || '',
      10,
    );
    return Number.isFinite(raw) && raw > 0
      ? raw
      : SENTINEL2_DEFAULT_DAILY_BUDGET;
  }

  async function loadBudgetOnce() {
    if (budgetLoaded) return;
    budgetLoaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(BUDGET_PATH, 'utf8'));
      if (
        parsed &&
        typeof parsed.date === 'string' &&
        Number.isFinite(parsed.count)
      ) {
        budget = parsed;
      }
    } catch {
      /* no budget file yet */
    }
  }

  async function persistBudget() {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(BUDGET_PATH, JSON.stringify(budget), 'utf8');
    } catch (err) {
      console.warn(
        '[sentinel2-proxy] budget write failed:',
        err?.message || err,
      );
    }
  }

  function currentBudget() {
    budget = normalizeBudget(budget, utcDayKey());
    return budget;
  }

  const overBudget = () => isOverBudget(currentBudget(), dailyBudgetLimit());

  /** Count one Sentinel Hub request — upstream counts it whatever it answers. */
  function recordUpstreamRequest() {
    currentBudget().count += 1;
    void persistBudget();
  }

  /**
   * The only way this module reaches the network: a fixed CDSE origin, no
   * redirects, a hard timeout. Throws before fetching anything else.
   */
  function upstream(url, init) {
    if (!SENTINEL_HUB_ORIGINS.has(new URL(url).origin))
      throw new Error('upstream origin not allowed');
    return fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  }

  /**
   * A valid bearer token for these credentials, or null. Never logs the
   * response body: an identity-server error can echo the client ID.
   */
  function getToken(creds, { force = false } = {}) {
    const now = Date.now();
    if (force) token = null;
    if (
      token &&
      token.clientId === creds.clientId &&
      now < token.expiresAt - TOKEN_MARGIN_MS
    )
      return Promise.resolve(token.value);
    if (tokenInflight) return tokenInflight;
    if (!force && now - tokenFailedAt < TOKEN_FAILURE_COOLDOWN_MS)
      return Promise.resolve(null);
    tokenInflight = (async () => {
      try {
        const res = await upstream(SENTINEL_HUB_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
          }).toString(),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`token HTTP ${res.status}`);
        }
        const data = await readResponseJsonCapped(res, MAX_JSON_BYTES);
        const value = data?.access_token;
        if (typeof value !== 'string' || !value)
          throw new Error('token response without access_token');
        const expiresIn = Number(data?.expires_in);
        token = {
          value,
          clientId: creds.clientId,
          expiresAt:
            Date.now() +
            (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600) *
              1000,
        };
        return value;
      } catch (err) {
        console.warn(
          '[sentinel2-proxy] token request failed:',
          err?.message || err,
        );
        token = null;
        tokenFailedAt = Date.now();
        return null;
      } finally {
        tokenInflight = null;
      }
    })();
    return tokenInflight;
  }

  /**
   * One authorized Sentinel Hub call. A 401 means the cached token is dead
   * (rotated or revoked client): mint once more and retry once.
   */
  async function authorizedRequest(creds, url, init) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bearer = await getToken(creds, { force: attempt > 0 });
      if (!bearer) throw new Error('no token');
      recordUpstreamRequest();
      const res = await upstream(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${bearer}` },
      });
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      return res;
    }
    throw new Error('unauthorized');
  }

  async function fetchTile(creds, z, x, y) {
    const res = await authorizedRequest(creds, SENTINEL_HUB_PROCESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'image/png' },
      body: JSON.stringify(buildSentinel2ProcessRequest(z, x, y)),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    if (
      !String(res.headers.get('content-type') || '').startsWith('image/png')
    ) {
      await res.body?.cancel().catch(() => {});
      throw new Error('non-PNG upstream response');
    }
    const buf = await readResponseBytesCapped(res, MAX_TILE_BYTES);
    if (buf.byteLength === 0) throw new Error('empty tile body');
    return buf;
  }

  async function fetchScene(creds, point) {
    const res = await authorizedRequest(creds, SENTINEL_HUB_CATALOG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/geo+json, application/json',
      },
      body: JSON.stringify(buildSentinel2CatalogSearch(point.lon, point.lat)),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await readResponseJsonCapped(res, MAX_JSON_BYTES);
    return pickLeastCloudyScene(body?.features);
  }

  const tilePath = (key) =>
    path.join(CACHE_DIR, `s2-${key.replaceAll('/', '-')}.png`);

  async function readDiskTile(key) {
    try {
      const [stat, buf] = await Promise.all([
        fsp.stat(tilePath(key)),
        fsp.readFile(tilePath(key)),
      ]);
      return { at: stat.mtimeMs, buf };
    } catch {
      return null;
    }
  }

  async function writeDiskTile(key, buf) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(tilePath(key), buf);
    } catch (err) {
      console.warn(
        `[sentinel2-proxy] tile cache write failed for ${key}:`,
        err?.message || err,
      );
    }
  }

  /** Insertion-ordered LRU-ish insert: evict the oldest entry when full. */
  function lruSet(map, max, key, entry) {
    if (!map.has(key) && map.size >= max) map.delete(map.keys().next().value);
    map.set(key, entry);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/sentinel2', async (req, res) => {
      // Sanitized responses only: no upstream error text, never the
      // credentials, the token or an upstream URL.
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      const sendTile = (buf, cacheStatus) => {
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'private, max-age=3600',
          'x-sentinel2-cache': cacheStatus,
        });
        res.end(buf);
      };

      try {
        if (admitSameSite(req, res)) return;
        if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        await loadBudgetOnce();
        const [urlPath, search = ''] = String(req.url || '').split('?');
        const creds = credentials();

        if (urlPath === '/status') {
          const b = currentBudget();
          sendJson(200, {
            hasKey: Boolean(creds),
            dailyCount: b.count,
            budget: dailyBudgetLimit(),
            date: b.date,
            minZoom: SENTINEL2_MIN_ZOOM,
            maxZoom: SENTINEL2_MAX_ZOOM,
            windowDays: SENTINEL2_WINDOW_DAYS,
            maxCloud: SENTINEL2_MAX_CLOUD,
          });
          return;
        }

        if (urlPath === '/scene') {
          const params = new URLSearchParams(search);
          const lonRaw = params.get('lon');
          const latRaw = params.get('lat');
          const point =
            lonRaw && latRaw
              ? quantizeScenePoint(Number(lonRaw), Number(latRaw))
              : null;
          if (!point) {
            sendJson(400, { error: 'invalid_point' });
            return;
          }
          if (!creds) {
            sendJson(503, { error: 'no_key' });
            return;
          }
          const sendScene = (scene) =>
            sendJson(200, {
              date: scene?.date ?? null,
              datetime: scene?.datetime ?? null,
              cloudCover: scene?.cloudCover ?? null,
              windowDays: SENTINEL2_WINDOW_DAYS,
              maxCloud: SENTINEL2_MAX_CLOUD,
            });
          const cached = scenes.get(point.key);
          if (cached && Date.now() - cached.at < SCENE_TTL_MS) {
            sendScene(cached.scene);
            return;
          }
          if (overBudget()) {
            if (cached) sendScene(cached.scene);
            else sendJson(429, { error: 'budget' });
            return;
          }
          if (!sceneInflight.has(point.key)) {
            sceneInflight.set(
              point.key,
              fetchScene(creds, point)
                .then((scene) => {
                  const entry = { at: Date.now(), scene };
                  lruSet(scenes, MEM_MAX_SCENES, point.key, entry);
                  return entry;
                })
                .catch((err) => {
                  console.warn(
                    `[sentinel2-proxy] scene ${point.key} failed:`,
                    err?.message || err,
                  );
                  return null;
                })
                .finally(() => sceneInflight.delete(point.key)),
            );
          }
          const fresh = await sceneInflight.get(point.key);
          if (fresh) sendScene(fresh.scene);
          else if (cached) sendScene(cached.scene);
          else sendJson(502, { error: 'upstream' });
          return;
        }

        const m = urlPath.match(
          /^\/tile\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/,
        );
        if (!m) {
          sendJson(404, { error: 'not_found' });
          return;
        }
        const z = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        if (!isValidSentinel2Tile(z, x, y)) {
          sendJson(400, { error: 'invalid_tile' });
          return;
        }
        if (!creds) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const key = `${z}/${x}/${y}`;
        let entry = tiles.get(key);
        if (!entry) {
          entry = await readDiskTile(key);
          if (entry) lruSet(tiles, MEM_MAX_TILES, key, entry);
        }
        // Fresh cache hit — never counts against the budget.
        if (entry && Date.now() - entry.at < TILE_TTL_MS) {
          sendTile(entry.buf, 'HIT');
          return;
        }
        // Over the daily budget, last-good imagery beats a dead map.
        if (overBudget()) {
          if (entry) sendTile(entry.buf, 'STALE-BUDGET');
          else sendJson(429, { error: 'budget' });
          return;
        }
        if (!tileInflight.has(key)) {
          tileInflight.set(
            key,
            fetchTile(creds, z, x, y)
              .then(async (buf) => {
                const fresh = { at: Date.now(), buf };
                lruSet(tiles, MEM_MAX_TILES, key, fresh);
                await writeDiskTile(key, buf);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[sentinel2-proxy] ${key} fetch failed (${err?.message || err}) — serving stale if any`,
                );
                return null;
              })
              .finally(() => tileInflight.delete(key)),
          );
        }
        const fresh = await tileInflight.get(key);
        if (fresh) sendTile(fresh.buf, 'MISS');
        else if (entry) sendTile(entry.buf, 'STALE-ERROR');
        else sendJson(502, { error: 'upstream' });
      } catch (err) {
        console.warn('[sentinel2-proxy] error:', err?.message || err);
        sendJson(500, { error: 'proxy' });
      }
    });
  };
  return {
    name: 'sentinel2-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
