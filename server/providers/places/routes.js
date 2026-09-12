import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { haversineKm } from '../common/geo.js';
import { readResponseTextCapped } from '../common/http.js';
import {
  normalizeRouteProfile,
  projectRouteResult,
} from '../../../src/data/placeProviderPayloads.js';

/** OSM routing (FOSSGIS OSRM) cache: profile|coords -> { payload, cachedAt }. */
const ROUTE_CACHE_MS = 600000;

const _routeCache = new Map();

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

export function installRouteMiddleware(middlewares) {
  // Real OSM routing via the public FOSSGIS OSRM servers (foot/car/bike).
  // GET /api/route?profile=foot|car|bike&coords=lon,lat;lon,lat[;...]
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
      const now = Date.now();
      const cached = _routeCache.get(cacheKey);
      if (cached && now - cached.cachedAt <= ROUTE_CACHE_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cached.payload));
        return;
      }
      const upstream = `https://routing.openstreetmap.de/routed-${profile}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let osrm;
      try {
        const upstreamRes = await fetch(upstream, {
          signal: controller.signal,
          headers: { 'User-Agent': 'gods-eye-view/dev (local)' },
        });
        if (!upstreamRes.ok) return fail('no route found');
        const ctype = upstreamRes.headers.get('content-type') || '';
        if (!ctype.includes('json')) return fail('no route found');
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
        return fail('no route found');
      const payload = projectRouteResult(route, profile);
      _routeCache.set(cacheKey, { payload, cachedAt: now });
      if (_routeCache.size > 200)
        _routeCache.delete(_routeCache.keys().next().value);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (e) {
      console.error('[Route Proxy]', e?.message || e);
      fail('route proxy error');
    }
  });
}
