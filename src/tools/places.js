/**
 * Place services backed by the app's own routes. Applications with different
 * providers can supply any objects with the same contracts:
 *
 * - `places.resolve(name, { signal })` turns a name into bounds (`/api/geocode`).
 * - `placeSearch.search(query, near, { signal })` and
 *   `placeSearch.nearby(near, { signal })` find points of interest
 *   (`/api/google/*`), reporting whether search is configured.
 * - `routing.route(points, profile, { signal })` plans a route (`/api/route`).
 */

import { ToolError } from './catalog.js';

const POINT_RADIUS_DEGREES = 0.25;

/**
 * Resolve place names to `{ name, bounds: { west, south, east, north }, point }`
 * or null. `point` is the place's own location, which can lie far from the
 * middle of its bounds (a region with remote islands, for example).
 */
export function createGeocodePlaceService({
  fetchImpl = (...args) => globalThis.fetch(...args),
  cacheSize = 200,
  cacheMs = 10 * 60_000,
  timeoutMs = 15_000,
  now = () => Date.now(),
} = {}) {
  // Recent answers by name, so tools that combine others resolve a place to
  // the same point once instead of once per section. A pending lookup is
  // shared by its callers: it has its own deadline, is cancelled when every
  // caller has given up, and only a successful answer stays cached.
  const cache = new Map();
  async function lookup(name, signal) {
    const query = new URLSearchParams({ q: name });
    const response = await fetchImpl(`/api/geocode?${query}`, { signal });
    if (!response.ok) throw new Error(`Geocode HTTP ${response.status}`);
    const payload = await response.json();
    return placeFromGeocodeResult(payload?.results?.[0]);
  }
  function start(key, name) {
    const controller = new AbortController();
    const entry = {
      at: now(),
      controller,
      waiters: 0,
      settled: false,
      place: lookup(
        name,
        AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      ),
    };
    entry.place.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
        if (cache.get(key) === entry) cache.delete(key);
      },
    );
    cache.set(key, entry);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return entry;
  }
  function join(key, entry, signal) {
    if (!signal) {
      // A caller that cannot cancel keeps the lookup alive.
      entry.waiters = Infinity;
      return entry.place;
    }
    signal.throwIfAborted();
    entry.waiters += 1;
    return new Promise((resolve, reject) => {
      const leave = () => {
        entry.waiters -= 1;
        reject(signal.reason);
        if (entry.waiters <= 0 && !entry.settled) {
          entry.controller.abort(signal.reason);
          if (cache.get(key) === entry) cache.delete(key);
        }
      };
      signal.addEventListener('abort', leave, { once: true });
      entry.place
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', leave));
    });
  }
  return {
    async resolve(name, { signal } = {}) {
      signal?.throwIfAborted();
      const key = name.trim().toLowerCase();
      let entry = cache.get(key);
      if (entry && now() - entry.at < cacheMs) {
        cache.delete(key);
        cache.set(key, entry);
      } else entry = start(key, name);
      return join(key, entry, signal);
    },
  };
}

/** Convert one geocode result to a place with bounds, or null. */
export function placeFromGeocodeResult(result) {
  const location = result?.geometry?.location;
  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng))
    return null;
  const viewport = result.geometry.viewport;
  const bounds =
    viewport &&
    [
      viewport.southwest?.lat,
      viewport.southwest?.lng,
      viewport.northeast?.lat,
      viewport.northeast?.lng,
    ].every(Number.isFinite)
      ? {
          west: viewport.southwest.lng,
          south: viewport.southwest.lat,
          east: viewport.northeast.lng,
          north: viewport.northeast.lat,
        }
      : {
          west: Math.max(-180, location.lng - POINT_RADIUS_DEGREES),
          south: Math.max(-90, location.lat - POINT_RADIUS_DEGREES),
          east: Math.min(180, location.lng + POINT_RADIUS_DEGREES),
          north: Math.min(90, location.lat + POINT_RADIUS_DEGREES),
        };
  return {
    name: result.formatted_address || null,
    bounds,
    point: { lat: location.lat, lon: location.lng },
  };
}

/** Search points of interest; `configured` is false when the server has no search key. */
export function createPlaceSearchService({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function read(path, params, signal) {
    const response = await fetchImpl(`${path}?${new URLSearchParams(params)}`, {
      signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* the status below is authoritative */
    }
    if (!response.ok) throw httpFailure(response, 'Place search');
    return {
      configured: payload?.configured !== false,
      places: Array.isArray(payload?.places) ? payload.places : [],
    };
  }
  return {
    search(query, { latitude, longitude, radiusM }, { signal } = {}) {
      return read(
        '/api/google/text-search',
        { q: query, lat: latitude, lon: longitude, radiusM },
        signal,
      );
    },
    nearby({ latitude, longitude, radiusM }, { signal } = {}) {
      return read(
        '/api/google/nearby-places',
        { lat: latitude, lon: longitude, radiusM },
        signal,
      );
    },
  };
}

/** Plan routes between `[{ lat, lon }]` points; resolves `{ ok, ... }`. */
export function createRouteService({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async route(points, profile, { signal } = {}) {
      const coords = points
        .map((point) => `${point.lon.toFixed(6)},${point.lat.toFixed(6)}`)
        .join(';');
      const response = await fetchImpl(
        `/api/route?${new URLSearchParams({ profile, coords })}`,
        { signal },
      );
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* the status below is authoritative */
      }
      if (response.status === 429) throw httpFailure(response, 'Routing');
      if (payload?.ok === false || response.status === 400)
        return { ok: false, error: payload?.error || 'no route found' };
      if (!response.ok) throw httpFailure(response, 'Routing');
      return payload;
    },
  };
}

function httpFailure(response, label) {
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    return new ToolError('retry_later', `${label} is rate limited`, {
      retryAfterSeconds:
        Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    });
  }
  return new Error(`${label} HTTP ${response.status}`);
}
