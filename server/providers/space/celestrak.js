import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { celestrakTleUrl } from '../../../src/data/spaceProviderRequests.js';
import {
  fetchUpstream,
  providerStatus,
  statusHeaders,
} from '../common/upstream.js';
import {
  celestrakSnapshotGroup,
  isTleText,
  loadCelestrakSnapshot,
  tleTextStats,
} from './celestrak-snapshot.js';

/**
 * CelesTrak GP/TLE proxy (Vite plugin + serverless middleware).
 *
 * CelesTrak sends no CORS headers, so the browser reads
 * `/api/celestrak/<group>[?format=tle|json]` and this middleware fetches
 * https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=<format>
 * server-side. Built on server/providers/common/upstream.js (10 s per attempt,
 * two jittered retries, descriptive User-Agent, 8 MB body cap).
 *
 * CelesTrak asks clients not to re-fetch GP data more often than ~every 2 h
 * and blocks IPs that do — a cold serverless instance re-fetching seven groups
 * in parallel is exactly that pattern — so every answer that has ANY data is
 * an HTTP 200 with a structured provider status, in this order per group:
 *
 *   1. memory / disk cache younger than 6 h ............ HIT         live
 *   2. celestrak.org ................................... MISS        live
 *   3. celestrak.com (same path, best effort) .......... MISS        live  (source "CelesTrak (celestrak.com)")
 *   4. memory / disk cache of any age, or the bundled
 *      snapshot (data/celestrak-active-snapshot.json,
 *      whichever is newer) ............................. STALE-ERROR / SNAPSHOT   stale
 *   5. nothing anywhere ................................ NONE        503 JSON { error, provider }
 *
 * Headers: `x-tle-cache` (above), `x-tle-source` (celestrak.org |
 * celestrak.com | cache | snapshot) and the shared X-Provider-* set. Live and
 * fresh-cache answers carry `Cache-Control: s-maxage=3600,
 * stale-while-revalidate=86400` so the Vercel edge serves and revalidates TLEs
 * (they change slowly); stale/snapshot answers use 300 / 3600. A raw upstream
 * 5xx is never relayed. Adapted from skylight's TleStore (MIT).
 */

export const CELESTRAK_TLE_TTL_MS = 6 * 3600_000;
export const CELESTRAK_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const CELESTRAK_EDGE_CACHE_FRESH = Object.freeze({
  edgeMaxAgeSec: 3600,
  staleWhileRevalidateSec: 86400,
});
export const CELESTRAK_EDGE_CACHE_STALE = Object.freeze({
  edgeMaxAgeSec: 300,
  staleWhileRevalidateSec: 3600,
});

/**
 * Origins in fallback order. celestrak.com currently serves an EXPIRED TLS
 * certificate, so it is a single, shorter, best-effort attempt (the budget must
 * stay inside a 60 s function: 3 × 10 s + backoff for .org, then ≤ 8 s here).
 */
export const CELESTRAK_ORIGINS = Object.freeze([
  Object.freeze({
    host: 'celestrak.org',
    source: 'CelesTrak',
    timeoutMs: 10_000,
    retries: 2,
  }),
  Object.freeze({
    host: 'celestrak.com',
    source: 'CelesTrak (celestrak.com)',
    timeoutMs: 8_000,
    retries: 0,
  }),
]);

const SNAPSHOT_SOURCE = 'CelesTrak (bundled snapshot)';
const GROUP_PATTERN = /^[a-z0-9-]+$/i;

/** Upstream request URL for one group/format on one origin. */
export function celestrakOriginUrl(group, format, host) {
  const url = celestrakTleUrl(group);
  url.hostname = host;
  if (format === 'json') url.searchParams.set('FORMAT', 'json');
  return url;
}

/** Human, URL-free reason for a failed upstream attempt (headers + 503 body). */
export function celestrakErrorText(error, status = 0) {
  const code = error?.code || 'network';
  if (code === 'timeout') return 'CelesTrak timed out';
  if (code === 'malformed') return 'CelesTrak returned no TLE data';
  if (code === 'too_large') return 'CelesTrak response too large';
  if (code === 'cancelled') return 'CelesTrak request cancelled';
  if (
    ['upstream_5xx', 'upstream_4xx', 'auth', 'rate_limited'].includes(code) &&
    status
  )
    return `CelesTrak HTTP ${status}`;
  return 'CelesTrak unreachable';
}

/**
 * Parse `/<group>?format=…` (or `?GROUP=<group>`); null when the group name is
 * not a plain CelesTrak group token. The raw path is inspected BEFORE any URL
 * normalisation so `/../active` stays rejected.
 */
export function parseCelestrakRequest(rawUrl) {
  const [rawPath = '', rawQuery = ''] = String(rawUrl || '').split('?');
  const params = new URLSearchParams(rawQuery);
  const group =
    rawPath.replace(/^\//, '') ||
    params.get('GROUP') ||
    params.get('group') ||
    '';
  if (!GROUP_PATTERN.test(group)) return null;
  const format = String(params.get('format') || params.get('FORMAT') || 'tle')
    .trim()
    .toLowerCase();
  if (format !== 'tle' && format !== 'json') return { group, format: null };
  return { group, format };
}

/** Body validation per format: TLE text with `1 …` lines, or a JSON array. */
function validateBody(text, format) {
  if (format === 'json') {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? { count: parsed.length } : null;
    } catch {
      return null;
    }
  }
  return isTleText(text) ? { count: tleTextStats(text).satellites } : null;
}

/**
 * @param {object} [options]
 * @param {Function} [options.loadSnapshot]  bundled-snapshot loader (tests)
 * @param {Function} [options.fetchImpl]     defaults to globalThis.fetch at call time
 * @param {Function} [options.sleep]         retry backoff sleeper (tests)
 * @param {Function} [options.random]        backoff jitter source (tests)
 * @returns {import('vite').Plugin}
 */
export function celestrakProxy({
  loadSnapshot = loadCelestrakSnapshot,
  fetchImpl,
  sleep,
  random,
} = {}) {
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const mem = new Map(); // key -> { at, body, origin, count }
  const inflight = new Map(); // key -> Promise<{ entry, origin, error }>

  const cacheKey = (group, format) =>
    format === 'json' ? `${group}--json` : group;
  const diskPath = (key) => path.join(CACHE_DIR, `celestrak-${key}.json`);

  async function readDisk(key) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(key), 'utf8'));
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at))
        return parsed;
    } catch {
      /* no disk cache yet */
    }
    return null;
  }

  async function writeDisk(key, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(diskPath(key), JSON.stringify(entry), 'utf8');
    } catch {
      console.warn('[celestrak-proxy] cache write failed');
    }
  }

  /** Try every origin in order; resolve to the first valid body or the last error. */
  async function fetchGroup(group, format) {
    let lastError = { code: 'network', message: 'CelesTrak fetch failed' };
    let lastStatus = 0;
    for (const origin of CELESTRAK_ORIGINS) {
      const result = await fetchUpstream(
        celestrakOriginUrl(group, format, origin.host),
        {
          timeoutMs: origin.timeoutMs,
          retries: origin.retries,
          accept: format === 'json' ? 'application/json' : 'text/plain',
          maxBytes: CELESTRAK_MAX_BODY_BYTES,
          label: 'CelesTrak',
          fetchImpl,
          sleep,
          random,
        },
      );
      if (result.ok) {
        const valid = validateBody(result.text, format);
        if (valid) {
          return {
            entry: {
              at: Date.now(),
              body: result.text,
              origin: origin.host,
              count: valid.count,
            },
            origin,
            error: null,
          };
        }
        // An error page or "No GP data found" parses to nothing — a failure.
        lastError = {
          code: 'malformed',
          message: 'CelesTrak returned no TLE data',
        };
        lastStatus = result.status;
      } else {
        lastError = result.error || lastError;
        lastStatus = result.status;
        // A caller cancel is final; nothing else is worth another origin.
        if (lastError.code === 'cancelled') break;
      }
      console.warn(
        `[celestrak-proxy] ${origin.host} failed for group "${group}" (${lastError.code}${lastStatus ? ` HTTP ${lastStatus}` : ''}, ${result.attempts} attempt${result.attempts === 1 ? '' : 's'})`,
      );
    }
    return { entry: null, origin: null, error: lastError, status: lastStatus };
  }

  /** Single-flight refresh per cache key; the settled outcome is shared by every waiter. */
  function refresh(key, group, format) {
    if (!inflight.has(key)) {
      inflight.set(
        key,
        fetchGroup(group, format)
          .then(async (outcome) => {
            if (outcome.entry) {
              mem.set(key, outcome.entry);
              await writeDisk(key, outcome.entry);
            }
            return outcome;
          })
          .catch((error) => ({
            entry: null,
            origin: null,
            error: {
              code: 'network',
              message: String(error?.message || error),
            },
            status: 0,
          }))
          .finally(() => inflight.delete(key)),
      );
    }
    return inflight.get(key);
  }

  const originSource = (host) =>
    CELESTRAK_ORIGINS.find((origin) => origin.host === host)?.source ||
    'CelesTrak';

  const entryCount = (entry, format) => {
    if (Number.isFinite(entry.count)) return entry.count;
    const valid = validateBody(entry.body, format);
    return valid ? valid.count : null;
  };

  const installMiddleware = (server) => {
    server.middlewares.use('/api/celestrak', async (req, res) => {
      const parsed = parseCelestrakRequest(req.url);
      if (!parsed) {
        res.writeHead(400, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        });
        res.end('invalid group');
        return;
      }
      const { group, format } = parsed;
      if (!format) {
        res.writeHead(400, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        });
        res.end('invalid format');
        return;
      }
      const contentType =
        format === 'json'
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8';
      // Guard against a double-send (a throw AFTER a response already went out
      // routing into the catch): writeHead after headersSent throws.
      const send = (httpStatus, body, headers) => {
        if (res.headersSent) return;
        res.writeHead(httpStatus, headers);
        res.end(body);
      };
      const sendData = ({ body, cacheStatus, tleSource, status, edge }) =>
        send(200, body, {
          'Content-Type': contentType,
          'x-tle-cache': cacheStatus,
          'x-tle-source': tleSource,
          ...statusHeaders(status, edge),
        });
      const sendUnavailable = (reason, cacheStatus = 'NONE') => {
        const status = providerStatus({
          status: 'unavailable',
          source: 'CelesTrak',
          error: reason,
        });
        send(503, JSON.stringify({ error: reason, provider: status }), {
          'Content-Type': 'application/json; charset=utf-8',
          'x-tle-cache': cacheStatus,
          ...statusHeaders(status, null),
        });
      };
      try {
        const key = cacheKey(group, format);
        let entry = mem.get(key);
        if (!entry) {
          entry = await readDisk(key);
          if (entry) mem.set(key, entry);
        }
        if (entry && Date.now() - entry.at < CELESTRAK_TLE_TTL_MS) {
          sendData({
            body: entry.body,
            cacheStatus: 'HIT',
            tleSource: 'cache',
            status: providerStatus({
              status: 'live',
              source: originSource(entry.origin),
              fetchedAt: entry.at,
              count: entryCount(entry, format),
            }),
            edge: CELESTRAK_EDGE_CACHE_FRESH,
          });
          return;
        }
        // Stale or missing → refresh, single-flight per group.
        const outcome = await refresh(key, group, format);
        if (outcome.entry) {
          sendData({
            body: outcome.entry.body,
            cacheStatus: 'MISS',
            tleSource: outcome.entry.origin,
            status: providerStatus({
              status: 'live',
              source: originSource(outcome.entry.origin),
              fetchedAt: outcome.entry.at,
              count: outcome.entry.count,
            }),
            edge: CELESTRAK_EDGE_CACHE_FRESH,
          });
          return;
        }
        const reason = celestrakErrorText(outcome.error, outcome.status);
        // Upstream is down: the newest of (stale cache, bundled snapshot) beats
        // an empty satellites layer. The snapshot only exists for TLE text.
        const snapshotEntry =
          format === 'tle'
            ? celestrakSnapshotGroup(await loadSnapshot(), group)
            : null;
        if (snapshotEntry && (!entry || snapshotEntry.fetchedAtMs > entry.at)) {
          sendData({
            body: snapshotEntry.tle,
            cacheStatus: 'SNAPSHOT',
            tleSource: 'snapshot',
            status: providerStatus({
              status: 'stale',
              source: SNAPSHOT_SOURCE,
              fetchedAt: snapshotEntry.fetchedAtMs,
              error: reason,
              count: snapshotEntry.satellites,
            }),
            edge: CELESTRAK_EDGE_CACHE_STALE,
          });
          return;
        }
        if (entry) {
          sendData({
            body: entry.body,
            cacheStatus: 'STALE-ERROR',
            tleSource: 'cache',
            status: providerStatus({
              status: 'stale',
              source: originSource(entry.origin),
              fetchedAt: entry.at,
              error: reason,
              count: entryCount(entry, format),
            }),
            edge: CELESTRAK_EDGE_CACHE_STALE,
          });
          return;
        }
        sendUnavailable(
          `${reason} — no cached TLEs for group "${group}" on this instance`,
        );
      } catch {
        console.error('[celestrak-proxy] request failed');
        sendUnavailable('CelesTrak proxy error', 'ERROR');
      }
    });
  };
  return {
    name: 'celestrak-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
