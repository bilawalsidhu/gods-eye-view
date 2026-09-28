import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
/**
 * adsbdb.com enrichment proxy: callsign → route (airline + origin/destination
 * airports) and hex → aircraft type/registration. Free community API — cached
 * aggressively: ONE upstream request per new key ever (404s negative-cached),
 * persisted to disk so restarts don't re-hammer it. Adapted from skylight
 * (MIT) server/src/enrich/routes.ts.
 */
export function adsbdbProxy(options = {}) {
  // Destructured in the body, not the signature: `proxyErrorResponses.test.mjs`
  // extracts these proxies by slicing to the first closing brace in column zero.
  const {
    cacheMaxEntries = 20_000,
    cacheMaxDiskBytes = 16 * 1024 * 1024,
    cachePath,
  } = options;
  const TTL_MS = 24 * 3600_000;
  const CACHE_PATH =
    cachePath || path.join(process.cwd(), '.gev-cache', 'adsbdb.json');
  /**
   * Entry ceiling per store.
   *
   * Both keyspaces are enumerable by the caller — a callsign is 2-8 of
   * `[A-Z0-9]`, a hex is six of `[0-9a-f]` — and every distinct key that
   * reaches upstream is cached, 404s included. Without a ceiling the maps, and
   * the file they are written to, grow for as long as a caller keeps asking.
   * Sized from a real session's own file: `.gev-cache/adsbdb.json` held 397
   * aircraft entries (~100 B each) and 3 route entries (~231 B each), so
   * 20,000 per store is roughly fifty times an ordinary working set and still
   * bounds the file at about 7 MB.
   */
  const CACHE_MAX_ENTRIES = cacheMaxEntries;
  const CACHE_MAX_DISK_BYTES = cacheMaxDiskBytes;
  /**
   * Requests/minute/IP. The browser cannot exceed 300 by construction —
   * `ENRICH_DISPATCH_GAP_MS` (200 ms) drips at most five enrichment lookups a
   * second — so 360 leaves the real client untouched while still capping an
   * enumerating caller. The global backstop is the usual generous multiple.
   */
  const RATE_PER_MIN = 360;
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: RATE_PER_MIN,
    globalMax: RATE_PER_MIN * 3,
  });
  // Maps, not plain objects: `size` is O(1), so the ceiling can be enforced on
  // every write, and iteration is true insertion order (an all-digit callsign
  // like "1234" would sort ahead of everything else as an object key).
  let cache = { routes: new Map(), aircraft: new Map() };
  let dirty = false;
  let loaded = false;
  const inflight = new Map();

  /** Rehydrate one store, dropping entries that expired while we were down. */
  function toStore(raw) {
    const store = new Map();
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw ?? {})) {
      const at = Number(entry?.at);
      if (!Number.isFinite(at) || now - at >= TTL_MS) continue;
      store.set(key, entry);
    }
    prune(store);
    return store;
  }

  /** Hold the store at its ceiling, dropping least-recently-written first. */
  function prune(store) {
    while (store.size > CACHE_MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  /** Write `key` as the newest entry, then restore the ceiling. */
  function remember(store, key, entry) {
    store.delete(key); // re-insert so insertion order tracks last write
    store.set(key, entry);
    prune(store);
    dirty = true;
  }

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    let sizeBytes = null;
    try {
      sizeBytes = (await fsp.stat(CACHE_PATH)).size;
    } catch {
      sizeBytes = null; // cannot measure it — let the read below decide
    }
    if (sizeBytes !== null && sizeBytes > CACHE_MAX_DISK_BYTES) {
      console.warn('[adsbdb-proxy] cache file above ceiling — starting empty');
    } else {
      try {
        const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
        cache = {
          routes: toStore(parsed.routes),
          aircraft: toStore(parsed.aircraft),
        };
      } catch {
        /* first run */
      }
    }
    setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
        await fsp.writeFile(
          CACHE_PATH,
          JSON.stringify({
            routes: Object.fromEntries(cache.routes),
            aircraft: Object.fromEntries(cache.aircraft),
          }),
          'utf8',
        );
      } catch {
        dirty = true;
      } // retry next tick
    }, 15_000).unref?.();
  }

  const fresh = (e) => e && Date.now() - e.at < TTL_MS;

  function parseRoute(json) {
    const fr = json?.response?.flightroute;
    if (!fr?.origin || !fr?.destination) return null;
    const airport = (a) => ({
      code: a.iata_code || a.icao_code || '',
      name: a.municipality || a.name || '',
      lat: Number.isFinite(a.latitude) ? a.latitude : null,
      lon: Number.isFinite(a.longitude) ? a.longitude : null,
    });
    return {
      airline: fr.airline?.name || null,
      origin: airport(fr.origin),
      destination: airport(fr.destination),
    };
  }

  function parseAircraft(json) {
    const a = json?.response?.aircraft;
    if (!a) return null;
    return {
      typeCode: a.icao_type || null, // ICAO designator, e.g. "B738" — feeds classifyAircraft
      typeName:
        a.manufacturer && a.type
          ? `${a.manufacturer} ${a.type}`
          : a.type || null,
      registration: a.registration || null,
    };
  }

  function lookup(kind, key) {
    const store = kind === 'route' ? cache.routes : cache.aircraft;
    if (fresh(store.get(key))) return Promise.resolve(store.get(key).data);
    const ik = `${kind}:${key}`;
    if (!inflight.has(ik)) {
      inflight.set(
        ik,
        (async () => {
          try {
            const url =
              kind === 'route'
                ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
                : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
              const data =
                kind === 'route'
                  ? parseRoute(await res.json())
                  : parseAircraft(await res.json());
              // data may be null — negative cache
              remember(store, key, { at: Date.now(), data });
              return data;
            }
            if (res.status === 404) {
              // known-missing — cache the miss
              remember(store, key, { at: Date.now(), data: null });
            }
            // other statuses: leave uncached so we retry later
            return fresh(store.get(key)) ? store.get(key).data : null;
          } catch {
            // network error → stale if any
            return fresh(store.get(key)) ? store.get(key).data : null;
          } finally {
            inflight.delete(ik);
          }
        })(),
      );
    }
    return inflight.get(ik);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/adsbdb', async (req, res) => {
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          ...headers,
        });
        res.end(JSON.stringify(obj));
      };
      // Before any work: a refused request must not touch the cache, the disk,
      // or api.adsbdb.com.
      if (!allow(clientKey(req)))
        return send(
          429,
          { error: 'Rate limit exceeded' },
          {
            'Retry-After': '10',
          },
        );
      await loadOnce();
      try {
        const [, kind, rawKey] = String(req.url || '')
          .split('?')[0]
          .split('/');
        if (kind === 'route') {
          const cs = String(rawKey || '').toUpperCase();
          if (!/^[A-Z0-9]{2,8}$/.test(cs))
            return send(400, { error: 'invalid callsign' });
          const data = await lookup('route', cs);
          return send(200, data ? { found: true, ...data } : { found: false });
        }
        if (kind === 'type') {
          const hex = String(rawKey || '').toLowerCase();
          if (!/^[0-9a-f]{6}$/.test(hex))
            return send(400, { error: 'invalid hex' });
          const data = await lookup('aircraft', hex);
          return send(200, data ? { found: true, ...data } : { found: false });
        }
        return send(404, { error: 'unknown endpoint' });
      } catch (err) {
        console.error('[adsbdb-proxy] request failed');
        return send(500, { error: 'adsbdb proxy error' });
      }
    });
  };
  return {
    name: 'adsbdb-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
