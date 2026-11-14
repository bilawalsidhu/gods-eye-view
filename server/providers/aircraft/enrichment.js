import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { readResponseJsonCapped } from '../common/http.js';
import {
  createAnacRab,
  normalizeRegistration,
  rabTypeName,
} from './anacRab.js';

/** Route and aircraft lookups are a few hundred bytes; 1 MiB is a hard bound. */
const ADSBDB_MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * adsbdb.com enrichment proxy: callsign → route (airline + origin/destination
 * airports) and hex → aircraft type/registration. Free community API — cached
 * aggressively: successes and 404s are kept per key for 24 hours (TTL_MS) and
 * persisted to disk so restarts don't re-hammer it; other failures are not
 * cached. Adapted from skylight
 * (MIT) server/src/enrich/routes.ts.
 */
export function adsbdbProxy(options = {}) {
  const TTL_MS = 24 * 3600_000;
  const CACHE_PATH = path.join(process.cwd(), '.gev-cache', 'adsbdb.json');
  let cache = { routes: {}, aircraft: {} };
  let dirty = false;
  let loaded = false;
  const inflight = new Map();
  // ANAC RAB details for Brazilian registrations (anacRab.js). The index is
  // created on the first Brazilian lookup, so an install that never sees a
  // PP/PR/PS/PT/PU aircraft never downloads the file. ANAC_RAB_ENABLED=0 opts out.
  const RAB_WAIT_MS = 20_000;
  let registry = null;

  /**
   * @param {object|null} data adsbdb's answer for `hex`.
   * @param {string} hex Transponder address, lowercase.
   * @param {string|null} tail The client's callsign when it is itself a
   *   Brazilian mark ("PTTSI"), as general aviation flies. It stands in only
   *   when adsbdb has no registration and the transponder is in Brazil's ICAO
   *   block (E40000-E7FFFF); adsbdb's registration, tied to the hex, wins.
   */
  async function withRegistry(data, hex, tail) {
    let reg = null;
    if (data?.registration) reg = normalizeRegistration(data.registration);
    else if (tail && /^e[4-7][0-9a-f]{4}$/.test(hex))
      reg = normalizeRegistration(tail);
    if (!reg) return data;
    if (String(process.env.ANAC_RAB_ENABLED ?? '').trim() === '0') return data;
    registry ??= (options.createRegistry ?? createAnacRab)();
    // The first Brazilian lookup waits for the download (a few seconds); a
    // slow ANAC answers without details rather than holding the type up.
    let timer;
    await Promise.race([
      registry.ensureFresh(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, RAB_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    const rab = registry.lookup(reg);
    if (!rab) return data;
    return {
      ...data,
      typeCode: data?.typeCode || rab.icaoType || null,
      typeName: data?.typeName || rabTypeName(rab),
      registration: data?.registration || `${reg.slice(0, 2)}-${reg.slice(2)}`,
      rab: { year: rab.year, seats: rab.seats, operation: rab.operation },
    };
  }

  async function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      cache = { routes: parsed.routes ?? {}, aircraft: parsed.aircraft ?? {} };
    } catch {
      /* first run */
    }
    setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
        await fsp.writeFile(CACHE_PATH, JSON.stringify(cache), 'utf8');
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
    if (fresh(store[key])) return Promise.resolve(store[key].data);
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
            const signal = AbortSignal.timeout(8000);
            const res = await fetch(url, { signal });
            if (res.ok) {
              const payload = await readResponseJsonCapped(
                res,
                ADSBDB_MAX_RESPONSE_BYTES,
                signal,
              );
              const data =
                kind === 'route' ? parseRoute(payload) : parseAircraft(payload);
              store[key] = { at: Date.now(), data }; // data may be null — negative cache
              dirty = true;
              return data;
            }
            if (res.status === 404) {
              store[key] = { at: Date.now(), data: null }; // known-missing — cache the miss
              dirty = true;
            }
            // other statuses: leave uncached so we retry later
            return fresh(store[key]) ? store[key].data : null;
          } catch {
            return fresh(store[key]) ? store[key].data : null; // network error → stale if any
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
      await loadOnce();
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
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
          const tail = new URLSearchParams(
            String(req.url || '').split('?')[1] || '',
          ).get('tail');
          const data = await withRegistry(
            await lookup('aircraft', hex),
            hex,
            tail,
          );
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
