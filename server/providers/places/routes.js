import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { haversineKm } from '../common/geo.js';
import { readResponseTextCapped } from '../common/http.js';
import { normalizeOsrmSteps } from '../../../src/data/routeSteps.js';
import {
  normalizeRouteProfile,
  projectRouteResult,
} from '../../../src/data/placeProviderPayloads.js';

/**
 * OSM routing (FOSSGIS OSRM) cache: profile|coords ->
 * { payload, hasSteps, cachedAt }. `hasSteps` records whether the upstream
 * call behind this entry asked for maneuvers, because an entry without them
 * cannot answer a request that wants them.
 */
const ROUTE_CACHE_MS = 600000;

/**
 * Upstream calls currently in flight, keyed by endpoint + route + step shape.
 * Two identical requests that arrive before the first one answers (three rapid
 * reroutes of the same A→B, a second browser tab) await the SAME upstream
 * fetch. The FOSSGIS servers ask for no heavy use; the cheapest way to honour
 * that is not to make the call twice. Module-level, because what it is
 * deduplicating is this process's outbound traffic — the endpoint is part of
 * the key, so two installations pointed at different services never share one.
 * @type {Map<string, Promise<{payload: object|null, error: string|null}>>}
 */
const _routeInflight = new Map();

/** Hard cap on the OSRM route response we will buffer. */
const ROUTE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB

/** Reject routes whose straight-line spans are obviously abusive (km). */
const ROUTE_MAX_LEG_KM = 600;

const ROUTE_MAX_TOTAL_KM = 2500;

const _routeRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 60,
  globalMax: 200,
});

/** Test seam: forget the outbound state this module keeps between requests. */
export function _resetRouteUpstreamForTest() {
  _routeInflight.clear();
}

/** Test seam: how many upstream calls are coalescing right now. */
export function _routeInflightCountForTest() {
  return _routeInflight.size;
}

/** Release a response body we are not going to read. */
async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    /* already closed */
  }
}

/**
 * Fetch one route from the routing service and project it.
 * @param {object} request
 * @param {string} request.profile foot | car | bike
 * @param {string} request.osrmProfile Upstream profile name.
 * @param {string} request.base Endpoint base for this profile.
 * @param {string} request.coords `lon,lat;lon,lat[;...]`
 * @param {boolean} request.withSteps Ask upstream for maneuvers.
 * @param {Function} request.fetchImpl Injected request function.
 * @returns {Promise<{payload: object|null, error: string|null}>}
 */
async function fetchRoute({
  profile,
  osrmProfile,
  base,
  coords,
  withSteps,
  fetchImpl,
}) {
  // `steps` is opt-in per request. Asking for maneuvers on every call made the
  // response several times larger for the callers that never read them (the
  // voice route annotation, fly_route), on someone else's bandwidth.
  const upstream =
    `${base.replace(/\/$/, '')}/route/v1/${osrmProfile}/${coords}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=${withSteps ? 'true' : 'false'}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let osrm;
  try {
    const upstreamRes = await fetchImpl(upstream, {
      signal: controller.signal,
      redirect: 'error',
      headers: { 'User-Agent': 'gods-eye-view/dev (local)' },
    });
    if (!upstreamRes.ok) {
      await cancelBody(upstreamRes);
      return { payload: null, error: 'no route found' };
    }
    const ctype = upstreamRes.headers.get('content-type') || '';
    if (!ctype.includes('json')) {
      await cancelBody(upstreamRes);
      return { payload: null, error: 'no route found' };
    }
    const text = await readResponseTextCapped(
      upstreamRes,
      ROUTE_MAX_RESPONSE_BYTES,
    );
    osrm = JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
  const route = osrm?.routes?.[0];
  if (osrm?.code !== 'Ok' || !route?.geometry?.coordinates?.length)
    return { payload: null, error: 'no route found' };
  const payload = projectRouteResult(route, profile);
  if (withSteps) payload.steps = normalizeOsrmSteps(route);
  return { payload, error: null };
}

export function installRouteMiddleware(
  middlewares,
  { endpoints = {}, fetchImpl = (...args) => fetch(...args) } = {},
) {
  const _routeCache = new Map();

  // Real OSM routing via the public FOSSGIS OSRM servers (foot/car/bike).
  // GET /api/route?profile=foot|car|bike&coords=lon,lat;lon,lat[;...][&steps=1]
  // `steps=1` adds turn-by-turn maneuvers (src/data/routeSteps.js) and is the
  // only shape that asks the upstream for them. A response WITHOUT steps is
  // byte for byte what this endpoint has always returned.
  middlewares.use('/api/route', async (req, res) => {
    const fail = (msg) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    };
    try {
      if (!_routeRateLimiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '5',
        });
        res.end(JSON.stringify({ ok: false, error: 'rate limited' }));
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const raw = (url.searchParams.get('profile') || 'foot').toLowerCase();
      const profile = normalizeRouteProfile(raw);
      if (!profile) return fail('invalid profile');
      const osrmProfile = profile === 'car' ? 'driving' : profile;
      const pairs = (url.searchParams.get('coords') || '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      if (pairs.length < 2 || pairs.length > 12)
        return fail('need 2-12 coordinates');
      const clean = [];
      const pts = [];
      for (const pr of pairs) {
        const parts = pr.split(',');
        if (parts.length !== 2) return fail('invalid coordinate');
        const lon = Number(parts[0]);
        const lat = Number(parts[1]);
        if (
          !Number.isFinite(lon) ||
          !Number.isFinite(lat) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        ) {
          return fail('invalid coordinate');
        }
        clean.push(`${lon},${lat}`);
        pts.push([lon, lat]);
      }
      // Reject obviously-abusive spans — a real walking/driving route is local,
      // so a cross-continent request is either a bug or an attempt to drive
      // heavy upstream OSRM work.
      let totalKm = 0;
      for (let i = 1; i < pts.length; i += 1) {
        // pts are [lon, lat]; existing haversineKm takes (lat1, lon1, lat2, lon2).
        const legKm = haversineKm(
          pts[i - 1][1],
          pts[i - 1][0],
          pts[i][1],
          pts[i][0],
        );
        if (legKm > ROUTE_MAX_LEG_KM) return fail('route leg too long');
        totalKm += legKm;
      }
      if (totalKm > ROUTE_MAX_TOTAL_KM) return fail('route too long');
      const coords = clean.join(';');
      const cacheKey = `${profile}|${coords}`;
      const base =
        endpoints[profile] ||
        `https://routing.openstreetmap.de/routed-${profile}`;
      const now = Date.now();
      const wantSteps = url.searchParams.get('steps') === '1';
      // A caller that did not ask for maneuvers never sees them, even when the
      // cached entry carries them for someone else.
      const shapePayload = (payload) =>
        wantSteps ? payload : { ...payload, steps: undefined };
      const cached = _routeCache.get(cacheKey);
      if (
        cached &&
        now - cached.cachedAt <= ROUTE_CACHE_MS &&
        (!wantSteps || cached.hasSteps)
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(shapePayload(cached.payload)));
        return;
      }
      const inflightKey = `${base}|${cacheKey}|${wantSteps ? 's' : 'n'}`;
      // A stepless request can also ride a stepful call already in flight —
      // it just drops the maneuvers on the way out.
      let pending =
        _routeInflight.get(inflightKey) ||
        (wantSteps ? null : _routeInflight.get(`${base}|${cacheKey}|s`));
      if (!pending) {
        pending = fetchRoute({
          profile,
          osrmProfile,
          base,
          coords,
          withSteps: wantSteps,
          fetchImpl,
        });
        _routeInflight.set(inflightKey, pending);
        const settle = () => {
          if (_routeInflight.get(inflightKey) === pending)
            _routeInflight.delete(inflightKey);
        };
        pending.then(settle, settle);
      }
      const { payload, error } = await pending;
      if (error || !payload) return fail(error || 'no route found');
      _routeCache.set(cacheKey, {
        payload,
        hasSteps: Array.isArray(payload.steps),
        cachedAt: Date.now(),
      });
      if (_routeCache.size > 200)
        _routeCache.delete(_routeCache.keys().next().value);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(shapePayload(payload)));
    } catch (e) {
      console.error('[Route Proxy]', e?.message || e);
      fail('route proxy error');
    }
  });
}
