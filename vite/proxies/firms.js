/**
 * NASA FIRMS detection proxy (`/api/firms`).
 *
 * Extracted verbatim from vite.config.js (Batch 4, PLAN.md) so each
 * endpoint can be unit-tested in isolation; vite.config.js assembles the
 * plugin list from these modules.
 */

import path from 'node:path';
import net from 'node:net';
import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';
import { promises as fsp } from 'node:fs';

/**
 * NASA FIRMS live active-fire proxy with a memory + disk cache.
 * Upstream: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/2
 *
 * Merges three VIIRS NRT sources (NOAA-20, NOAA-21, Suomi-NPP — independent
 * satellites, no cross-source dedup) fetched sequentially with `days=2`
 * (`days=1` means "current UTC day", nearly empty just after 00:00Z) and
 * clamps to the trailing 24 h via src/data/firmsCsv.js. FIRMS quota is
 * 5,000 transactions / 10 min per MAP_KEY, so the cache is the point:
 * TTL 30 min, single-flight refresh, serve-stale-on-failure, and a
 * fresh-enough disk cache (.gev-cache/firms.json) prevents ANY upstream
 * fetch across dev-server restarts. Pattern mirrors celestrakProxy.
 *
 * Routes:
 *   GET /api/firms        → {fetchedAt, stale, ttlMs, sources, count, fires}
 *   GET /api/firms/status → {hasKey, lastFetch, count, stale, ttlMs, transactions}
 *
 * Keyless (no FIRMS_MAP_KEY): /api/firms → 503 {error:'no_key'}; status →
 * {hasKey:false}. Upstream is never touched without a key.
 *
 * @returns {import('vite').Plugin}
 */
export function firmsProxy() {
  const TTL_MS = 30 * 60_000;
  const STATUS_TTL_MS = 5 * 60_000;
  const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'firms.json');

  /** @type {?{at: number, sources: Array<object>, fires: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, sources: Array<object>, fires: Array<object>}>} single-flight refresh */
  let inflight = null;
  /** Same, for the keyless public source (kept separate so a keyed request
   * never consumes a public refresh's result or vice versa). */
  let inflightPublic = null;
  /** @type {?{at: number, transactions: ?{used: number, limit: number}}} mapkey_status cache */
  let statusCache = null;
  /** @type {?Promise<?{used: number, limit: number}>} */
  let statusInflight = null;

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  /**
   * issue #68 / PR #126: on hosts where IPv6 is advertised but unreachable
   * (no route / blackholed), Node's default Happy-Eyeballs address-family
   * racing was observed stalling the FIRMS fetches until the 60 s abort
   * instead of failing over, starving the layer. Pinning the socket stack
   * back to single-family connect at proxy init sidesteps the racing bug on
   * those hosts. Opt out on IPv6-primary networks (where falling back is
   * what makes egress work at all) with FIRMS_KEEP_AUTO_SELECT_FAMILY=1.
   * Dev-server-only by construction: the Pages Function runtime (workerd)
   * has no `node:net`, and its fetch is not Node's.
   *
   * @returns {boolean} true when the process default was changed.
   */
  function pinSocketFamilyToSingleConnect() {
    if (String(process.env.FIRMS_KEEP_AUTO_SELECT_FAMILY || '') === '1') return false;
    try {
      if (typeof net.setDefaultAutoSelectFamily !== 'function') return false;
      net.setDefaultAutoSelectFamily(false);
      return true;
    } catch {
      return false;
    }
  }

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.sources) && Array.isArray(parsed?.fires)) {
        mem = parsed;
      }
    } catch { /* no disk cache yet */ }
  }

  async function writeDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[firms-proxy] cache write failed:', err?.message || err);
    }
  }

  /**
   * Fetch + parse one FIRMS source. Throws on HTTP error or a non-CSV body
   * (FIRMS reports errors as HTML/plain text, never CSV). Never log the URL —
   * it embeds the MAP_KEY.
   */
  async function fetchSource(key, source) {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = parseFirmsCsv(await res.text());
    if (records === null) throw new Error('non-CSV upstream response');
    return records;
  }

  /**
   * Keyless source: NASA's public (no MAP_KEY) rolling 24h SNPP VIIRS global
   * CSV. Same NRT record schema as the keyed area API (column order differs —
   * the parser indexes by header name — `confidence` spells out low/nominal/
   * high, which normalizeConfidence already accepts). Quota-free, so it backs
   * the layer with real data when no MAP_KEY is configured; 503 no_key becomes
   * the last-resort failure only when this is unreachable too.
   */
  const PUBLIC_SOURCE_URL =
    'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv';

  async function refreshPublic() {
    const now = Date.now();
    const res = await fetch(PUBLIC_SOURCE_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = filterTrailing24h(parseFirmsCsv(await res.text()) ?? [], now);
    if (!records.length) throw new Error('public FIRMS CSV parsed to zero rows');
    return {
      at: now,
      mode: 'public',
      sources: [{ source: 'VIIRS_SNPP_24h_public', count: records.length, ok: true, keyless: true }],
      fires: records,
    };
  }

  /**
   * Refresh all sources sequentially (quota courtesy — never in parallel).
   * Partial success (≥1 source ok) still produces a cacheable entry with the
   * failed sources marked ok:false; total failure throws so the caller can
   * serve stale.
   */
  async function refreshUpstream(key) {
    const now = Date.now();
    const sources = [];
    const fires = [];
    for (const source of SOURCES) {
      try {
        const records = filterTrailing24h(await fetchSource(key, source), now);
        // Append element-by-element: a global VIIRS sweep returns ~131k rows
        // and `push(...records)` throws RangeError past V8's ~124k argument
        // limit — inside this try, so a healthy source would be misreported
        // as failed and its rows silently dropped (upstream PR #181/#156).
        for (const record of records) fires.push(record);
        // Bookkeeping moves AFTER the rows land: a source is only ok:true
        // once its records are actually in the merged array.
        sources.push({ source, count: records.length, ok: true });
      } catch (err) {
        console.warn(`[firms-proxy] ${source} fetch failed:`, err?.message || err);
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
    return { at: now, mode: 'keyed', sources, fires };
  }

  /**
   * Cache entry → response payload. Fires are RE-filtered to the trailing
   * 24 h at serve time so a stale cache never serves >24h-old detections.
   */
  function buildPayload(entry, stale) {
    const fires = filterTrailing24h(entry.fires, Date.now());
    return {
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      sources: entry.sources,
      count: fires.length,
      fires,
    };
  }

  /** mapkey_status transactions, cached 5 min, best-effort (null on failure). */
  function getTransactions(key) {
    const now = Date.now();
    if (statusCache && now - statusCache.at < STATUS_TTL_MS) {
      return Promise.resolve(statusCache.transactions);
    }
    if (!statusInflight) {
      statusInflight = (async () => {
        try {
          const url = `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          const used = Number(body?.current_transactions);
          const limit = Number(body?.transaction_limit);
          return Number.isFinite(used) && Number.isFinite(limit) ? { used, limit } : null;
        } catch (err) {
          console.warn('[firms-proxy] mapkey status failed:', err?.message || err);
          return null;
        }
      })()
        .then((transactions) => {
          statusCache = { at: Date.now(), transactions };
          return transactions;
        })
        .finally(() => { statusInflight = null; });
    }
    return statusInflight;
  }

  return {
    name: 'firms-proxy',
    configureServer(server) {
      if (pinSocketFamilyToSingleConnect()) {
        console.log('[firms-proxy] net.setDefaultAutoSelectFamily(false) — IPv6-race workaround active (FIRMS_KEEP_AUTO_SELECT_FAMILY=1 to disable)');
      }
      server.middlewares.use('/api/firms', async (req, res) => {
        const sendJson = (status, obj) => {
          if (res.headersSent) return;
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(obj));
        };
        try {
          const subPath = String(req.url || '').split('?')[0];
          const key = mapKey();
          await readDiskOnce();

          if (subPath === '/status') {
            if (!key) {
              sendJson(200, {
                hasKey: false,
                keyless: true,
                lastFetch: mem && mem.mode === 'public' ? mem.at : null,
                count: mem && mem.mode === 'public' ? mem.fires.length : null,
                stale: mem && mem.mode === 'public' ? Date.now() - mem.at >= TTL_MS : false,
                ttlMs: TTL_MS,
                transactions: null,
              });
              return;
            }
            const transactions = await getTransactions(key);
            sendJson(200, {
              hasKey: true,
              lastFetch: mem ? mem.at : null,
              count: mem ? mem.fires.length : null,
              stale: mem ? Date.now() - mem.at >= TTL_MS : false,
              ttlMs: TTL_MS,
              transactions,
            });
            return;
          }

          if (!key) {
            // No MAP_KEY: serve the public-source cache while fresh, else
            // refresh it single-flight. 503 no_key is now the LAST resort —
            // only when the public endpoint is unreachable too.
            const publicEntry = mem && mem.mode === 'public' ? mem : null;
            if (publicEntry && Date.now() - publicEntry.at < TTL_MS) {
              sendJson(200, buildPayload(publicEntry, false));
              return;
            }
            if (!inflightPublic) {
              inflightPublic = refreshPublic()
                .then(async (fresh) => {
                  mem = fresh;
                  await writeDisk(fresh);
                  return fresh;
                })
                .catch((err) => {
                  console.warn(`[firms-proxy] public refresh failed (${err?.message || err}) — serving cache if any`);
                  return null;
                })
                .finally(() => { inflightPublic = null; });
            }
            const pendingPublic = inflightPublic;
            const freshPublic = await pendingPublic;
            if (freshPublic) {
              sendJson(200, buildPayload(freshPublic, false));
            } else if (publicEntry) {
              sendJson(200, buildPayload(publicEntry, true)); // public endpoint down — stale beats empty
            } else {
              sendJson(503, { error: 'no_key' });
            }
            return;
          }

          const entry = mem && (mem.mode === 'keyed' || !mem.mode) ? mem : null;
          if (entry && Date.now() - entry.at < TTL_MS) {
            sendJson(200, buildPayload(entry, false));
            return;
          }
          // Stale or missing → refresh, single-flight (concurrent requests
          // share one upstream pass). Capture the promise locally BEFORE
          // awaiting: the .finally() nulls `inflight` the moment it settles.
          if (!inflight) {
            inflight = refreshUpstream(key)
              .then(async (fresh) => {
                mem = fresh;
                await writeDisk(fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(`[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`);
                return null;
              })
              .finally(() => { inflight = null; });
          }
          const pending = inflight;
          const fresh = await pending;
          if (fresh) {
            sendJson(200, buildPayload(fresh, false));
          } else if (entry) {
            sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
          } else if (mem && mem.mode === 'public') {
            // Keyed refresh failed but a real (keyless-source) cache exists —
            // still live fire data, and a far better answer than a 502.
            sendJson(200, buildPayload(mem, true));
          } else {
            sendJson(502, { error: 'firms fetch failed and no cache available' });
          }
        } catch (err) {
          console.warn('[firms-proxy] error:', err?.message || err);
          sendJson(500, { error: 'firms proxy error' });
        }
      });
    },
  };
}
