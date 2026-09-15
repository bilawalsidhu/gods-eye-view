import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  DEFAULT_DISK_CACHE_BYTES,
  DEFAULT_MONTHLY_TILE_BUDGET,
  isValidTileCoord as isValidXweatherTile,
  resolveRefreshMs,
} from '../../src/data/xweatherTiles.js';
import {
  isAllowedLayer,
  layerMaxZoom,
} from '../../src/data/xweatherCatalogue.js';
import { providerCacheDir } from './common/cache-dir.js';
import {
  utcMonthKey as xweatherUtcMonthKey,
  normalizeBudget as normalizeXweatherBudget,
  isOverBudget as isXweatherOverBudget,
} from '../../src/data/tileBudget.js';

/**
 * Vaisala Xweather raster-tile proxy with a monthly budget governor.
 *
 * Upstream: https://maps.api.xweather.com/{id}_{secret}/{layer}/{z}/{x}/{y}/current.png
 * — 256x256 PNG in Spherical Mercator. The layer arrives from the browser and
 * is therefore checked against the catalogue allowlist before anything else:
 * forwarded on trust, this would be an open proxy to every Xweather product on
 * the account, including the ones billing at ten times the rate.
 *
 * This proxy is not optional the way the others are. Xweather puts BOTH the
 * client id and the client secret in the URL path, so the browser can never be
 * allowed to build that URL: it fetches same-origin
 * `/api/xweather/tile/{layer}/{z}/{x}/{y}.png` and the credentials stay here.
 * A keyless or CORS-open source needs no such thing and is read straight from
 * the page; this one cannot be.
 *
 * Cache: memory + disk (.gev-cache/xweather/), TTL defaults to the refresh
 * cadence, single-flight per tile, serve-stale-on-failure — the tomtomProxy
 * pattern. Unlike that one the disk cache is bounded and evicts oldest-first,
 * because paid raster tiles across a dozen zoom levels grow without limit.
 * Cache hits never count against the budget.
 *
 * Budget governor: a persistent counter (.gev-cache/xweather/budget.json, keyed
 * by UTC month) counts upstream fetch attempts against the account's only real
 * quota — 15,000 accesses a month on the free tier, which is also the default
 * cap, so the proxy stops where free ends rather than at an invented margin.
 * Over the cap it serves stale tiles when available, else 429 {error:'budget'}.
 * `monthCount` on /status is what the Weather panel displays.
 *
 * A tile request may carry `?t=<epoch ms>`, the freshness floor: the moment
 * the client last asked for new data. A cached tile older than that is
 * refetched, which is what makes the panel's Refresh do anything at all — the
 * TTL alone is far longer than the weather stays still.
 *
 * GET /api/xweather/status → {hasKey, monthCount, budget, month, refreshMs}.
 * Keyless mode: status reports hasKey:false and the tile endpoint 503s
 * {error:'no_key'} without touching upstream. There is no keyless fallback for
 * this layer — the weather row reports unavailable and draws nothing.
 *
 * @returns {import('vite').Plugin}
 */
export function xweatherProxy() {
  const UPSTREAM_ORIGIN = 'https://maps.api.xweather.com';
  const CACHE_DIR = providerCacheDir('xweather');
  const BUDGET_PATH = path.join(CACHE_DIR, 'budget.json');
  const MEM_MAX_ENTRIES = 512;
  const UPSTREAM_TIMEOUT_MS = 15000;
  /** Sweep the disk cache every N writes rather than on each one. */
  const PRUNE_EVERY_WRITES = 50;

  /** @type {Map<string, {at:number, buf:Buffer}>} tile key `z/x/y` -> cached tile (kept past TTL for serve-stale). */
  const mem = new Map();
  /** @type {Map<string, Promise<{at:number, buf:Buffer}|null>>} single-flight per tile. */
  const inflight = new Map();

  /** @type {{date:string, count:number}|null} lazily-loaded persistent counter. */
  let budget = null;
  let budgetLoaded = false;
  let writesSincePrune = 0;
  /** @type {Promise<void>|null} the cache directory is created once, not per write. */
  let cacheDirReady = null;
  /** @type {NodeJS.Timeout|null} pending debounced write of the counter. */
  let budgetFlush = null;

  /**
   * Filesystem calls run on libuv's thread pool, which this process shares
   * with the dev server's file watching — so every avoidable one is latency
   * on a tile request.
   */
  function ensureCacheDir() {
    cacheDirReady ??= fsp.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
    return cacheDirReady;
  }

  const credentials = () => ({
    id: process.env.XWEATHER_CLIENT_ID || '',
    secret: process.env.XWEATHER_CLIENT_SECRET || '',
  });

  /** Both halves are required; one alone cannot authenticate. */
  function hasCredentials() {
    const { id, secret } = credentials();
    return Boolean(id && secret);
  }

  /**
   * Scrub the credentials out of anything on its way to a log line.
   *
   * This provider carries its secret in the URL *path*, not a query parameter,
   * so an upstream error that quotes the request — a DNS or TLS failure often
   * does — would otherwise write the secret into the server log. Client
   * responses never include upstream text at all; this guards the other exit.
   */
  function redact(text) {
    const { id, secret } = credentials();
    let out = String(text ?? '');
    for (const part of [secret, id])
      if (part) out = out.replaceAll(part, '***');
    return out;
  }

  function refreshMs() {
    return resolveRefreshMs(process.env.XWEATHER_REFRESH_MS);
  }

  /** Longer TTL is directly fewer billable accesses, at the cost of staler pixels. */
  function tileTtlMs() {
    const raw = Number.parseInt(process.env.XWEATHER_TILE_TTL_MS || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : refreshMs();
  }

  function monthlyBudgetLimit() {
    const raw = Number.parseInt(
      process.env.XWEATHER_MONTHLY_TILE_BUDGET || '',
      10,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MONTHLY_TILE_BUDGET;
  }

  function diskCacheLimitBytes() {
    const raw = Number.parseInt(
      process.env.XWEATHER_DISK_CACHE_BYTES || '',
      10,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DISK_CACHE_BYTES;
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

  /**
   * Persist the counter at most once a second.
   *
   * The count in memory is the one that governs; the file only has to survive
   * a restart. Writing it per fetch would put two thread-pool operations in
   * front of every tile, and losing a second of counting to a crash is much
   * cheaper than that.
   */
  function persistBudget() {
    if (budgetFlush) return;
    budgetFlush = setTimeout(async () => {
      budgetFlush = null;
      try {
        await ensureCacheDir();
        await fsp.writeFile(BUDGET_PATH, JSON.stringify(budget), 'utf8');
      } catch (err) {
        console.warn(
          '[xweather-proxy] budget write failed:',
          redact(err?.message || err),
        );
      }
    }, 1000);
    budgetFlush.unref?.();
  }

  /** Roll the counter to this month (UTC) and return it. */
  function currentBudget() {
    budget = normalizeXweatherBudget(budget, xweatherUtcMonthKey());
    return budget;
  }

  /** Count one upstream fetch attempt against this month's budget. */
  function recordUpstreamFetch() {
    currentBudget().count += 1;
    void persistBudget();
  }

  /**
   * Cache file for one tile of one layer.
   *
   * The layer has to be part of the name: two layers share every z/x/y, and a
   * key that ignored it would serve wind speed where radar was asked for.
   */
  const tilePath = (key) =>
    path.join(CACHE_DIR, `${key.replaceAll('/', '-')}.png`);

  /** Disk-cache read; tile age comes from the file's mtime. */
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

  /**
   * Keep the tile directory under its byte ceiling, oldest first.
   *
   * Paid tiles accumulate across every zoom the camera visits, so unlike the
   * traffic cache this one cannot grow forever. Eviction is by mtime, which is
   * also how age is read, so the tile evicted is always the least recently
   * refreshed.
   */
  async function pruneDisk() {
    const limit = diskCacheLimitBytes();
    try {
      const names = (await fsp.readdir(CACHE_DIR)).filter((name) =>
        name.endsWith('.png'),
      );
      const entries = [];
      let total = 0;
      for (const name of names) {
        try {
          const stat = await fsp.stat(path.join(CACHE_DIR, name));
          entries.push({ name, at: stat.mtimeMs, size: stat.size });
          total += stat.size;
        } catch {
          /* raced with another sweep */
        }
      }
      if (total <= limit) return;
      entries.sort((a, b) => a.at - b.at);
      for (const entry of entries) {
        if (total <= limit) break;
        try {
          await fsp.unlink(path.join(CACHE_DIR, entry.name));
          total -= entry.size;
          // Filenames flatten the key's slashes to dashes; undo that so the
          // in-memory copy is dropped too rather than outliving the file. The
          // layer name itself may contain dashes, so only the trailing three
          // segments — z, x, y — are restored.
          const stem = entry.name.slice(0, -'.png'.length);
          const cut = stem.split('-');
          const zxy = cut.splice(-3).join('/');
          mem.delete(`${cut.join('-')}/${zxy}`);
        } catch {
          /* already gone */
        }
      }
    } catch (err) {
      console.warn(
        '[xweather-proxy] cache prune failed:',
        redact(err?.message || err),
      );
    }
  }

  async function writeDiskTile(key, buf) {
    try {
      await ensureCacheDir();
      await fsp.writeFile(tilePath(key), buf);
      writesSincePrune += 1;
      if (writesSincePrune >= PRUNE_EVERY_WRITES) {
        writesSincePrune = 0;
        await pruneDisk();
      }
    } catch (err) {
      console.warn(
        `[xweather-proxy] tile cache write failed for ${key}:`,
        redact(err?.message || err),
      );
    }
  }

  /** LRU-ish memory insert (Map preserves insertion order; evict the oldest). */
  function memSet(key, entry) {
    if (!mem.has(key) && mem.size >= MEM_MAX_ENTRIES) {
      const oldest = mem.keys().next().value;
      mem.delete(oldest);
    }
    mem.set(key, entry);
  }

  async function fetchUpstream(layer, z, x, y) {
    const { id, secret } = credentials();
    // One host, deliberately. The vendor offers maps1..maps4 so a *browser*
    // can exceed its per-host connection limit; this is a single server-side
    // client, where spreading requests across four names costs a DNS lookup
    // and a TLS handshake per tile instead of reusing one warm connection.
    const url =
      `${UPSTREAM_ORIGIN}/${encodeURIComponent(id)}_${encodeURIComponent(secret)}` +
      `/${encodeURIComponent(layer)}/${z}/${x}/${y}/current.png`;
    recordUpstreamFetch(); // attempts count — upstream bills the request either way
    const res = await fetch(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Xweather reports quota and auth failures as a non-image body with a 200,
    // so the content type is the real check — caching one as a tile would pin
    // an error page over the globe until the TTL expired.
    const contentType = String(res.headers.get('content-type') || '');
    if (!contentType.startsWith('image/'))
      throw new Error('non-image response');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('empty tile body');
    return buf;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/xweather', async (req, res) => {
      // Sanitized responses only (proxy/security baseline): no upstream
      // error details, and never echo the credentials or the upstream URL.
      const sendJson = (status, obj, extraHeaders = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...extraHeaders,
        });
        res.end(JSON.stringify(obj));
      };
      const sendTile = (buf, cacheStatus) => {
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'x-xweather-cache': cacheStatus,
        });
        res.end(buf);
      };

      try {
        await loadBudgetOnce();
        const [urlPath, rawQuery = ''] = String(req.url || '').split('?');

        if (urlPath === '/status') {
          const b = currentBudget();
          sendJson(200, {
            hasKey: hasCredentials(),
            monthCount: b.count,
            budget: monthlyBudgetLimit(),
            month: b.date,
            refreshMs: refreshMs(),
          });
          return;
        }

        const m = urlPath.match(
          /^\/tile\/([a-z0-9-]{1,48})\/(\d+)\/(\d+)\/(\d+)\.png$/,
        );
        if (!m) {
          sendJson(404, { error: 'not_found' });
          return;
        }
        const layer = m[1];
        const z = Number(m[2]);
        const x = Number(m[3]);
        const y = Number(m[4]);
        // Allowlist and coordinates are both checked before the key is read, so
        // a probe for a layer this app does not draw can never become a
        // billable upstream fetch.
        if (!isAllowedLayer(layer)) {
          sendJson(400, { error: 'unknown_layer' });
          return;
        }
        // Each layer is held to its own ceiling, so a level 12 radar tile is
        // refused rather than billed for a blurrier copy of level 9.
        if (!isValidXweatherTile(z, x, y, layerMaxZoom(layer))) {
          sendJson(400, { error: 'invalid_tile' });
          return;
        }
        if (!hasCredentials()) {
          sendJson(503, { error: 'no_key' });
          return;
        }

        const key = `${layer}/${z}/${x}/${y}`;
        const now = Date.now();
        // The freshness floor: the moment the client last asked for new data.
        // The TTL alone cannot decide this — it defaults to the refresh
        // cadence, a whole day, while radar and lightning move in minutes, so
        // a tile can be well inside its TTL and still show weather that has
        // gone. Bounded to now, so a client clock running fast cannot force a
        // refetch of something already current.
        const notBefore = Math.min(
          Number.parseInt(new URLSearchParams(rawQuery).get('t') || '', 10) ||
            0,
          now,
        );

        let entry = mem.get(key);
        if (!entry) {
          entry = await readDiskTile(key);
          if (entry) memSet(key, entry);
        }
        // Fresh cache hit — never counts against the budget.
        if (entry && now - entry.at < tileTtlMs() && entry.at >= notBefore) {
          sendTile(entry.buf, 'HIT');
          return;
        }

        // Budget governor: over the soft cap, last-good data beats a dead layer.
        if (isXweatherOverBudget(currentBudget(), monthlyBudgetLimit())) {
          if (entry) {
            sendTile(entry.buf, 'STALE-BUDGET');
          } else {
            sendJson(429, { error: 'budget' });
          }
          return;
        }

        // Stale or missing → refresh, single-flight per tile.
        if (!inflight.has(key)) {
          inflight.set(
            key,
            fetchUpstream(layer, z, x, y)
              .then((buf) => {
                const fresh = { at: Date.now(), buf };
                memSet(key, fresh);
                // Write through in the background. The tile is already in
                // memory and the disk copy only has to survive a restart, so
                // making the response wait on a thread-pool write — shared
                // with the dev server's file watching — buys nothing.
                void writeDiskTile(key, buf);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[xweather-proxy] ${key} fetch failed (${redact(err?.message || err)}) — serving stale if any`,
                );
                return null;
              })
              .finally(() => inflight.delete(key)),
          );
        }
        const fresh = await inflight.get(key);
        if (fresh) {
          sendTile(fresh.buf, 'MISS');
        } else if (entry) {
          sendTile(entry.buf, 'STALE-ERROR'); // upstream down — stale beats empty
        } else {
          sendJson(502, { error: 'upstream' });
        }
      } catch (err) {
        console.warn('[xweather-proxy] error:', redact(err?.message || err));
        sendJson(500, { error: 'proxy' });
      }
    });
  };

  return {
    name: 'xweather-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
