import path from 'node:path';
import https from 'node:https';
import { promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';

import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';

/**
 * The per-address connection errors behind a fetch failure, or null. Node 24
 * puts the AggregateError directly on `err.cause`; Node 26's fetch wraps it in
 * a ConnectTimeoutError one level deeper.
 * @param {unknown} err
 * @returns {?Array<unknown>}
 */
function connectAttemptErrors(err) {
  let cause = err?.cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    if (Array.isArray(cause.errors)) return cause.errors;
    cause = cause.cause;
  }
  return null;
}

/**
 * Describe a fetch failure with its socket-level cause. Node reports every
 * connection failure as `fetch failed`; the cause carries the error code and
 * the address that failed (never the URL, which embeds the MAP_KEY).
 * @param {unknown} err
 * @returns {string}
 */
export function describeFetchError(err) {
  const message = err?.message || String(err);
  const cause = err?.cause;
  if (!cause) return message;
  const attempts = connectAttemptErrors(err);
  const parts = attempts?.length
    ? attempts.map((inner) => inner?.message || inner?.code || String(inner))
    : [cause.message || cause.code || String(cause)];
  return `${message} (${parts.join('; ')})`;
}

/**
 * Whether a fetch failed because every address it tried failed to connect.
 * Node's network-family auto-selection gives each address a short attempt
 * timeout, so a slow IPv4 handshake is abandoned in favour of an unreachable
 * IPv6 address and the whole request fails (#68).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAddressSelectionFailure(err) {
  return err instanceof TypeError && connectAttemptErrors(err)?.length > 0;
}

/**
 * GET over IPv4 only, with one connection attempt bounded by the caller's
 * signal rather than by the auto-selection attempt timeout.
 * @param {string} url
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Response>}
 */
export function fetchIpv4(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        signal,
        family: 4,
        autoSelectFamily: false,
        agent: false,
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, String(value));
        }
        resolve(
          new Response(Readable.toWeb(response), {
            status: response.statusCode || 500,
            statusText: response.statusMessage || '',
            headers,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Fetch a FIRMS URL, retrying once over IPv4 when address selection fails.
 * Other failures (HTTP status, timeout, DNS) are returned or thrown as is.
 * @param {string} url
 * @param {{signal?: AbortSignal}} options
 * @param {{fetchImpl?: typeof fetch, fetchIpv4Impl?: typeof fetchIpv4, warn?: Function}} [deps]
 * @returns {Promise<Response>}
 */
export async function fetchFirms(
  url,
  options,
  { fetchImpl = fetch, fetchIpv4Impl = fetchIpv4, warn = console.warn } = {},
) {
  try {
    return await fetchImpl(url, options);
  } catch (err) {
    if (!isAddressSelectionFailure(err) || options?.signal?.aborted) throw err;
    warn(`[firms-proxy] ${describeFetchError(err)} — retrying over IPv4`);
    return fetchIpv4Impl(url, options);
  }
}

/**
 * NASA FIRMS live active-fire proxy with a memory + disk cache.
 * Upstream: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/2
 *
 * Merges three VIIRS NRT sources (NOAA-20, NOAA-21, Suomi-NPP — independent
 * satellites, no cross-source dedup) plus MODIS_NRT (combined Terra+Aqua,
 * ~1 km, numeric 0-100 confidence), fetched sequentially (quota courtesy)
 * with `days=2` (`days=1` means "current UTC day", nearly empty just after
 * 00:00Z) and clamps to the trailing 24 h via src/data/firmsCsv.js. FIRMS
 * quota is 5,000 transactions / 10 min per MAP_KEY, so the cache is the point:
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
  const SOURCES = [
    'VIIRS_NOAA20_NRT',
    'VIIRS_NOAA21_NRT',
    'VIIRS_SNPP_NRT',
    'MODIS_NRT',
  ];
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const CACHE_PATH = path.join(CACHE_DIR, 'firms.json');

  /** @type {?{at: number, sources: Array<object>, fires: Array<object>}} */
  let mem = null;
  let diskChecked = false;
  /** @type {?Promise<?{at: number, sources: Array<object>, fires: Array<object>}>} single-flight refresh */
  let inflight = null;
  /** @type {?{at: number, transactions: ?{used: number, limit: number}}} mapkey_status cache */
  let statusCache = null;
  /** @type {?Promise<?{used: number, limit: number}>} */
  let statusInflight = null;

  const mapKey = () => String(process.env.FIRMS_MAP_KEY || '').trim();

  async function readDiskOnce() {
    if (diskChecked) return;
    diskChecked = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (
        Number.isFinite(parsed?.at) &&
        Array.isArray(parsed?.sources) &&
        Array.isArray(parsed?.fires)
      ) {
        mem = parsed;
      }
    } catch {
      /* no disk cache yet */
    }
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
    const res = await fetchFirms(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = parseFirmsCsv(await res.text());
    if (records === null) throw new Error('non-CSV upstream response');
    return records;
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
        // NOT fires.push(...records): spread passes each record as an argument,
        // and a world/2 VIIRS pull exceeds V8's argument limit (~125k) at
        // ~131k records — RangeError, and the whole source is silently dropped.
        for (const record of records) fires.push(record);
        sources.push({ source, count: records.length, ok: true });
      } catch (err) {
        console.warn(
          `[firms-proxy] ${source} fetch failed:`,
          describeFetchError(err),
        );
        sources.push({ source, count: 0, ok: false });
      }
    }
    if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
    return { at: now, sources, fires };
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
          const res = await fetchFirms(url, {
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          const used = Number(body?.current_transactions);
          const limit = Number(body?.transaction_limit);
          return Number.isFinite(used) && Number.isFinite(limit)
            ? { used, limit }
            : null;
        } catch (err) {
          console.warn(
            '[firms-proxy] mapkey status failed:',
            describeFetchError(err),
          );
          return null;
        }
      })()
        .then((transactions) => {
          statusCache = { at: Date.now(), transactions };
          return transactions;
        })
        .finally(() => {
          statusInflight = null;
        });
    }
    return statusInflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/firms', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
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
              lastFetch: null,
              count: null,
              stale: false,
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
          sendJson(503, { error: 'no_key' });
          return;
        }

        const entry = mem;
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
              console.warn(
                `[firms-proxy] refresh failed (${err?.message || err}) — serving cache if any`,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const pending = inflight;
        const fresh = await pending;
        if (fresh) {
          sendJson(200, buildPayload(fresh, false));
        } else if (entry) {
          sendJson(200, buildPayload(entry, true)); // upstream down — stale beats empty
        } else {
          sendJson(502, {
            error: 'firms fetch failed and no cache available',
          });
        }
      } catch (err) {
        console.warn('[firms-proxy] error:', err?.message || err);
        sendJson(500, { error: 'firms proxy error' });
      }
    });
  };
  return {
    name: 'firms-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
