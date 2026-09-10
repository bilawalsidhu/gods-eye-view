// functions/api/adsbdb/[[path]].js
/**
 * `/api/adsbdb/<kind>/<key>` — Cloudflare Pages Function.
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (adsbdbProxy). adsbdb.com is a free community API with no browser CORS, so
 * `src/data/flights.js` enriches aircraft through this same-origin proxy:
 *   /api/adsbdb/route/<CALLSIGN> → airline + origin/destination airports
 *   /api/adsbdb/type/<icao24hex> → aircraft type/registration
 *
 * ROUTE SHAPE — optional catch-all (`[[path]]`), because the dev middleware is
 * mounted as a Connect *prefix* and slices the remainder as
 * `String(req.url).split('?')[0].split('/')`, i.e. `/route` with no key and
 * even `/route/A/ignored` are both valid inputs on dev. An optional catch-all
 * plus the same slice reproduces that; a `[kind]/[key]` file would 404 the
 * no-key shape that dev answers with 400. Like the dev middleware, the key is
 * read from the still-percent-encoded path (the client sends
 * `encodeURIComponent(callsign)`), so an encoded non-`[A-Z0-9]` character is a
 * 400 here just as it is in dev.
 *
 * Contract (identical to dev — `Content-Type: application/json`, and note
 * there is deliberately NO `Cache-Control`: the caching that matters is the
 * server-side store below, and the client treats enrichment as fail-silent):
 *   200 {found:true, airline, origin, destination}   kind=route, resolved
 *   200 {found:true, typeCode, typeName, registration} kind=type, resolved
 *   200 {found:false}                                known-missing (404 upstream,
 *                                                    or a route with no
 *                                                    usable flightroute)
 *   400 {error:'invalid callsign'}                   route key outside
 *                                                    /^[A-Z0-9]{2,8}$/ (uppercased first)
 *   400 {error:'invalid hex'}                        type key outside /^[0-9a-f]{6}$/ (lowercased first)
 *   404 {error:'unknown endpoint'}                   any other kind
 *   500 {error}                                      defensive — `lookup` absorbs
 *                                                    its own failures, so this is
 *                                                    not reachable through the
 *                                                    normal path on either runtime
 *
 * Normalization: `parseRoute`/`parseAircraft` are ports of the dev
 * middleware's own functions — that logic does NOT exist in `src/` (the client
 * consumes the already-normalized shape), so there was nothing to import and
 * re-shaping the payload would break `flights.js` field-for-field.
 *
 * Caching: ONE upstream request per key, ever, per isolate — 24 h TTL,
 * 404/negative results cached too, other statuses left uncached so a transient
 * upstream 5xx is retried on the next request, and a network error falls back
 * to a still-fresh entry. The dev middleware additionally persists the store to
 * `.gev-cache/adsbdb.json` every 15 s so restarts don't re-hammer adsbdb;
 * Workers have no writable filesystem, so that tier has no analogue here and
 * the store is per-isolate memory only.
 */
const MOUNT = '/api/adsbdb';
const TTL_MS = 24 * 3600_000;

/**
 * Enrichment store, shaped like the dev middleware's `{routes, aircraft}` so a
 * future KV/Durable Object sink can take over the persistence without touching
 * the lookup logic.
 * @type {{routes: Object<string, {at:number, data:object|null}>, aircraft: Object<string, {at:number, data:object|null}>}}
 */
const store = { routes: {}, aircraft: {} };
/** @type {Map<string, Promise<object|null>>} `kind:key` single-flight. */
const inflight = new Map();

const fresh = (entry) => entry && Date.now() - entry.at < TTL_MS;

/** Airport → the three fields the client renders. `code` prefers IATA. */
function airport(a) {
  return {
    code: a.iata_code || a.icao_code || '',
    name: a.municipality || a.name || '',
    lat: Number.isFinite(a.latitude) ? a.latitude : null,
    lon: Number.isFinite(a.longitude) ? a.longitude : null,
  };
}

/**
 * adsbdb flightroute → {airline, origin, destination}, or null when either
 * endpoint is missing (a route with one leg is useless to the client, which
 * only draws complete great-circle legs).
 */
function parseRoute(json) {
  const fr = json?.response?.flightroute;
  if (!fr?.origin || !fr?.destination) return null;
  return {
    airline: fr.airline?.name || null,
    origin: airport(fr.origin),
    destination: airport(fr.destination),
  };
}

/** adsbdb aircraft → the classification inputs `flights.js` consumes. */
function parseAircraft(json) {
  const a = json?.response?.aircraft;
  if (!a) return null;
  return {
    typeCode: a.icao_type || null, // ICAO designator, e.g. "B738" — feeds classifyAircraft
    typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null),
    registration: a.registration || null,
  };
}

function lookup(kind, key) {
  const target = kind === 'route' ? store.routes : store.aircraft;
  if (fresh(target[key])) return Promise.resolve(target[key].data);
  const ik = `${kind}:${key}`;
  if (!inflight.has(ik)) {
    inflight.set(ik, (async () => {
      try {
        const url = kind === 'route'
          ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
          : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = kind === 'route' ? parseRoute(await res.json()) : parseAircraft(await res.json());
          target[key] = { at: Date.now(), data }; // data may be null — negative cache
          return data;
        }
        if (res.status === 404) {
          target[key] = { at: Date.now(), data: null }; // known-missing — cache the miss
        }
        // other statuses: leave uncached so we retry later
        return fresh(target[key]) ? target[key].data : null;
      } catch {
        return fresh(target[key]) ? target[key].data : null; // network error → stale if any
      } finally {
        inflight.delete(ik);
      }
    })());
  }
  return inflight.get(ik);
}

export async function onRequest(context) {
  const { request } = context;

  const send = (status, obj) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const [, kind, rawKey] = new URL(request.url).pathname.slice(MOUNT.length).split('/');
    if (kind === 'route') {
      const cs = String(rawKey || '').toUpperCase();
      if (!/^[A-Z0-9]{2,8}$/.test(cs)) return send(400, { error: 'invalid callsign' });
      const data = await lookup('route', cs);
      return send(200, data ? { found: true, ...data } : { found: false });
    }
    if (kind === 'type') {
      const hex = String(rawKey || '').toLowerCase();
      if (!/^[0-9a-f]{6}$/.test(hex)) return send(400, { error: 'invalid hex' });
      const data = await lookup('aircraft', hex);
      return send(200, data ? { found: true, ...data } : { found: false });
    }
    return send(404, { error: 'unknown endpoint' });
  } catch (err) {
    return send(500, { error: String(err?.message || err) });
  }
}
