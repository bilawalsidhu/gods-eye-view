/**
 * Dev/preview proxy for guided tours: catalog, individual fetch, and route helpers.
 * Authored tours ship from `src/tours/data`; optional on-disk JSON under `.gev-tours/generated`
 * is listed for future-compat (no generate or memory endpoints in this build).
 * @module tours/toursProxy
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTourQuery, normalizeTour, summarizeTour } from './tourSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTHORED_DIR = path.join(__dirname, 'data');

function resolveToursRoot() {
  const candidates = [
    process.env.GEV_TOURS_DIR,
    path.join(process.cwd(), '.gev-tours'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return path.join(process.cwd(), '.gev-tours');
}

const TOURS_ROOT = resolveToursRoot();
const GENERATED_DIR = path.join(TOURS_ROOT, 'generated');

const FLIGHT_MIN_KM = 8;
const FLIGHT_MIN_SEC = 25 * 60;

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function decodePolyline(encoded) {
  if (!encoded) return [];
  const pts = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    pts.push({ lat: lat / 1e5, lon: lon / 1e5, height: 0 });
  }
  return pts;
}

async function loadAuthoredTours() {
  const names = await fsp.readdir(AUTHORED_DIR).catch(() => []);
  const tours = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(AUTHORED_DIR, name), 'utf8'));
      tours.push(normalizeTour(raw, { source: 'authored' }));
    } catch (error) {
      console.warn('[tours] authored load failed', name, error?.message || error);
    }
  }
  return tours;
}

async function loadGeneratedTours() {
  const names = await fsp.readdir(GENERATED_DIR).catch(() => []);
  const tours = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(GENERATED_DIR, name), 'utf8'));
      tours.push(normalizeTour(raw, { source: 'generated' }));
    } catch (error) {
      console.warn('[tours] generated load failed', name, error?.message || error);
    }
  }
  return tours;
}

async function loadAllTours() {
  const [authored, generated] = await Promise.all([loadAuthoredTours(), loadGeneratedTours()]);
  const byId = new Map();
  for (const tour of [...authored, ...generated]) byId.set(tour.id, tour);
  return [...byId.values()];
}

async function fetchOsrm(from, to, profile) {
  const osrmProfile = profile === 'car' ? 'driving' : profile;
  const routed = profile === 'car' ? 'car' : profile;
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const url = `https://routing.openstreetmap.de/routed-${routed}/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'gods-eye-view/tours' } });
    const data = await res.json().catch(() => ({}));
    const route = data?.routes?.[0];
    const coordsOut = route?.geometry?.coordinates;
    if (data?.code !== 'Ok' || !Array.isArray(coordsOut) || !coordsOut.length) return null;
    return {
      mode: profile === 'car' ? 'drive' : profile === 'bike' ? 'bike' : 'walk',
      durationRealSec: Number(route.duration) || 0,
      distanceM: Number(route.distance) || 0,
      polyline: coordsOut.map(([lon, lat]) => ({ lat, lon, height: 0 })),
      source: 'osrm',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleRoute(from, to, travelMode, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lon } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lon } } },
        travelMode,
        polylineQuality: 'OVERVIEW',
        computeAlternativeRoutes: false,
      }),
    });
    const data = await res.json().catch(() => ({}));
    const route = data?.routes?.[0];
    if (!route?.polyline?.encodedPolyline) return null;
    const durationRealSec = Number(String(route.duration || '').replace('s', '')) || 0;
    const mode = travelMode === 'TRANSIT' ? 'transit'
      : travelMode === 'DRIVE' ? 'drive'
        : travelMode === 'BICYCLE' ? 'bike'
          : 'walk';
    return {
      mode,
      durationRealSec,
      distanceM: Number(route.distanceMeters) || 0,
      polyline: decodePolyline(route.polyline.encodedPolyline),
      source: 'google-routes',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function bestRoute(from, to) {
  const km = haversineKm(from.lat, from.lon, to.lat, to.lon);
  if (km > FLIGHT_MIN_KM) {
    const googleKey = process.env.GOOGLE_MAPS_API_KEY;
    const candidates = [];
    if (googleKey) {
      for (const mode of ['TRANSIT', 'DRIVE', 'WALK']) {
        const got = await fetchGoogleRoute(from, to, mode, googleKey);
        if (got) candidates.push(got);
      }
    }
    if (!candidates.length) {
      for (const profile of ['car', 'foot']) {
        const got = await fetchOsrm(from, to, profile);
        if (got) candidates.push(got);
      }
    }
    candidates.sort((a, b) => a.durationRealSec - b.durationRealSec);
    const best = candidates[0];
    if (best && best.durationRealSec <= FLIGHT_MIN_SEC && km <= 80) return best;
    return {
      mode: 'flight',
      durationRealSec: Math.round((km / 700) * 3600),
      distanceM: km * 1000,
      polyline: [from, to],
      source: 'flight-hop',
    };
  }
  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  const candidates = [];
  if (googleKey) {
    for (const mode of ['WALK', 'TRANSIT', 'DRIVE', 'BICYCLE']) {
      const got = await fetchGoogleRoute(from, to, mode, googleKey);
      if (got) candidates.push(got);
    }
  }
  if (!candidates.length) {
    for (const profile of ['foot', 'bike', 'car']) {
      const got = await fetchOsrm(from, to, profile);
      if (got) candidates.push(got);
    }
  }
  candidates.sort((a, b) => a.durationRealSec - b.durationRealSec);
  return candidates[0] || {
    mode: 'walk',
    durationRealSec: 0,
    distanceM: km * 1000,
    polyline: [from, to],
    source: 'straight',
  };
}

/**
 * Vite plugin: serve /api/tours catalog, tour-by-id, and route helpers in dev/preview.
 * @returns {{ name: string, configureServer: Function, configurePreviewServer: Function }}
 */
export function toursProxy() {
  const install = (middlewares) => {
    middlewares.use('/api/tours', async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        let pathname = url.pathname.replace(/\/+$/, '') || '/';
        if (pathname.startsWith('/api/tours')) pathname = pathname.slice('/api/tours'.length) || '/';
        if (!pathname.startsWith('/')) pathname = `/${pathname}`;

        if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
          const tours = await loadAllTours();
          return json(res, 200, { ok: true, tours: tours.map(summarizeTour) });
        }

        if (req.method === 'GET' && pathname === '/route') {
          const from = { lat: Number(url.searchParams.get('fromLat')), lon: Number(url.searchParams.get('fromLon')) };
          const to = { lat: Number(url.searchParams.get('toLat')), lon: Number(url.searchParams.get('toLon')) };
          if (![from.lat, from.lon, to.lat, to.lon].every(Number.isFinite)) {
            return json(res, 200, { ok: false, error: 'need from/to coordinates' });
          }
          const routed = await bestRoute(from, to);
          return json(res, 200, { ok: true, ...routed });
        }

        if (req.method === 'GET' && pathname.length > 1) {
          const id = decodeURIComponent(pathname.slice(1));
          const tours = await loadAllTours();
          const tour = tours.find((item) => item.id === id) || matchTourQuery(tours, id);
          if (!tour) return json(res, 404, { ok: false, error: `No tour "${id}"` });
          return json(res, 200, { ok: true, tour });
        }

        return json(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        console.error('[tours]', error?.message || error);
        return json(res, 200, { ok: false, error: error?.message || 'tours proxy error' });
      }
    });
  };

  return {
    name: 'gev-tours-proxy',
    configureServer(server) { install(server.middlewares); },
    configurePreviewServer(server) { install(server.middlewares); },
  };
}
