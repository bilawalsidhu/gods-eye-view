import {
  googleServerApiKey,
  keylessGooglePlacesResponse,
  keylessGoogleGeocodeResponse,
} from './google-key.js';
import { makeOptInRateLimiter, clientKey } from '../common/rate-limit.js';
import {
  projectNearbyPlaces,
  projectTextSearchPlaces,
} from '../../../src/data/placeProviderPayloads.js';

// Construct lazily after the standalone environment has loaded.
// undefined = not built yet; null = unlimited; fn = active limiter
let _googleRateLimiter;

/** Google cost endpoint (nearby-places). Null = unlimited (default). */
function googleRateLimiter() {
  if (_googleRateLimiter === undefined)
    _googleRateLimiter = makeOptInRateLimiter(
      process.env.GEV_RATELIMIT_GOOGLE_PER_MIN,
    );
  return _googleRateLimiter;
}

/** Validate raw lat/lon presence and WGS84 bounds before consuming request quota. */
export function validatePlacesCoordinates(searchParams) {
  const rawLat = searchParams.get('lat');
  const rawLon = searchParams.get('lon');
  if (rawLat === null || rawLon === null || !rawLat.trim() || !rawLon.trim()) {
    return { ok: false, error: 'lat and lon are required' };
  }
  const latitude = Number(rawLat);
  const longitude = Number(rawLon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, error: 'Valid lat and lon are required' };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return {
      ok: false,
      error: 'lat must be within [-90, 90] and lon within [-180, 180]',
    };
  }
  return { ok: true, latitude, longitude };
}

/** Longest accepted geocoder query. Real place names are far shorter. */
const GEOCODE_MAX_QUERY = 200;

/** Validate a free-text geocoder query before consuming request quota. */
export function validateGeocodeAddress(searchParams) {
  const address = String(searchParams.get('address') || '').trim();
  if (!address) return { ok: false, error: 'address is required' };
  if (address.length > GEOCODE_MAX_QUERY)
    return { ok: false, error: 'address is too long' };
  return { ok: true, address };
}

/**
 * Validate the optional viewport bias, which Google reads as
 * `sw_lat,sw_lng|ne_lat,ne_lng`. An unparsed value is dropped rather than
 * refused: the bias only ranks results, so a malformed one costs relevance,
 * not an answer.
 */
export function geocodeBounds(searchParams) {
  const raw = String(searchParams.get('bounds') || '').trim();
  if (!raw) return null;
  const corners = raw.split('|');
  if (corners.length !== 2) return null;
  const numbers = corners.flatMap((corner) => corner.split(',').map(Number));
  if (numbers.length !== 4 || !numbers.every(Number.isFinite)) return null;
  const [swLat, swLon, neLat, neLon] = numbers;
  if (Math.abs(swLat) > 90 || Math.abs(neLat) > 90) return null;
  if (Math.abs(swLon) > 180 || Math.abs(neLon) > 180) return null;
  return raw;
}

/** Nearby place labels and view-biased text search, with request-time key resolution. */
export function googlePlacesContextProxy({
  resolveApiKey = googleServerApiKey,
  fetchImpl = (...args) => fetch(...args),
  endpoints = {},
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/google/nearby-places', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = resolveApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const coordinates = validatePlacesCoordinates(requestUrl.searchParams);
      if (!coordinates.ok) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: coordinates.error, places: [] }));
        return;
      }
      const { latitude, longitude } = coordinates;

      // Opt-in per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN). No-op when unset.
      // Inlined (not the shared helper) so the 429 body keeps this endpoint's
      // `places: []` contract that the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const radiusM = Math.max(
        25,
        Math.min(5000, Number(requestUrl.searchParams.get('radiusM')) || 250),
      );

      try {
        const response = await fetchImpl(
          endpoints.nearby ||
            'https://places.googleapis.com/v1/places:searchNearby',
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': [
                'places.id',
                'places.displayName',
                'places.formattedAddress',
                'places.shortFormattedAddress',
                'places.location',
                'places.primaryType',
                'places.primaryTypeDisplayName',
                'places.types',
              ].join(','),
            },
            body: JSON.stringify({
              maxResultCount: 20,
              rankPreference: 'DISTANCE',
              locationRestriction: {
                circle: {
                  center: { latitude, longitude },
                  radius: radiusM,
                },
              },
            }),
          },
        );
        const data = await response.json().catch(() => ({}));
        const places = projectNearbyPlaces(data, latitude, longitude);

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(
          JSON.stringify({
            places,
            error: response.ok
              ? null
              : data.error?.message || 'Google Places request failed',
          }),
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: error?.message || 'Google Places request failed',
            places: [],
          }),
        );
      }
    });

    // Text Search: resolve a named landmark/POI to a real coordinate, biased to
    // the view. Geocoding scatters obscure monument/POI names across the city;
    // a view-biased Text Search lands on the actual feature. Same key, field
    // mask, throttle, and `places: []` error contract as nearby-places above.
    middlewares.use('/api/google/text-search', async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed', places: [] }));
        return;
      }

      // Keyless place context has no provider cost, so it resolves before the
      // paid-endpoint limiter can consume or exhaust quota (mirrors the HUD
      // summary route).
      const apiKey = resolveApiKey();
      const keyless = keylessGooglePlacesResponse(apiKey);
      if (keyless) {
        res.statusCode = keyless.statusCode;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(keyless.payload));
        return;
      }

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const textQuery = String(requestUrl.searchParams.get('q') || '').trim();
      if (!textQuery) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ error: 'q, lat and lon are required', places: [] }),
        );
        return;
      }
      const coordinates = validatePlacesCoordinates(requestUrl.searchParams);
      if (!coordinates.ok) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: coordinates.error, places: [] }));
        return;
      }
      const { latitude, longitude } = coordinates;

      // Opt-in per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN). No-op when unset.
      // Inlined (like nearby-places) so the 429 body keeps the `places: []`
      // contract the client expects on every error response.
      const _grl = googleRateLimiter();
      if (_grl && !_grl(clientKey(req))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Retry-After', '5');
        res.end(JSON.stringify({ error: 'Rate limit exceeded', places: [] }));
        return;
      }

      const radiusM = Math.max(
        50,
        Math.min(50000, Number(requestUrl.searchParams.get('radiusM')) || 4000),
      );

      try {
        const response = await fetchImpl(
          endpoints.textSearch ||
            'https://places.googleapis.com/v1/places:searchText',
          {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': [
                'places.id',
                'places.displayName',
                'places.formattedAddress',
                'places.location',
                'places.viewport',
                'places.primaryType',
                'places.types',
              ].join(','),
            },
            body: JSON.stringify({
              textQuery,
              locationBias: {
                circle: {
                  center: { latitude, longitude },
                  radius: radiusM,
                },
              },
              maxResultCount: 5,
            }),
          },
        );
        const data = await response.json().catch(() => ({}));
        const places = projectTextSearchPlaces(data, latitude, longitude);

        res.statusCode = response.ok ? 200 : response.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(
          JSON.stringify({
            places,
            error: response.ok
              ? null
              : data.error?.message || 'Google Places request failed',
          }),
        );
      } catch (error) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: error?.message || 'Google Places request failed',
            places: [],
          }),
        );
      }
    });

    /**
     * Geocoding belongs on the server, not in the page. Google's Geocoding web
     * service refuses referrer-restricted keys, so calling it from the browser
     * forces GOOGLE_MAPS_API_KEY — which ships in the bundle by design — to be
     * left unrestricted (#363). Here the request carries the server key, and
     * the browser key no longer needs the Geocoding API at all.
     *
     * Unlike the two Places routes above, these answer in Google's own shape
     * (`status` + `results`) rather than the `places: []` contract: the browser
     * normalizers read that shape directly, and keeping it means the proxy adds
     * a hop without adding a translation nobody asked for.
     */
    function installGeocodeRoute(path, readQuery) {
      middlewares.use(path, async (req, res) => {
        const refuse = (statusCode, error) => {
          res.statusCode = statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ status: 'REQUEST_DENIED', results: [], error }),
          );
        };

        if (req.method !== 'GET') {
          refuse(405, 'Method not allowed');
          return;
        }

        // A keyless geocode has no provider cost, so it resolves before the
        // paid-endpoint limiter can consume or exhaust quota (mirrors the
        // Places routes above).
        const apiKey = resolveApiKey();
        const keyless = keylessGoogleGeocodeResponse(apiKey);
        if (keyless) {
          res.statusCode = keyless.statusCode;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(keyless.payload));
          return;
        }

        const requestUrl = new URL(req.url || '', 'http://localhost');
        const query = readQuery(requestUrl.searchParams);
        if (!query.ok) {
          refuse(400, query.error);
          return;
        }

        // Opt-in per-IP throttle (GEV_RATELIMIT_GOOGLE_PER_MIN), shared with
        // the Places routes because both spend the same Google budget.
        const _grl = googleRateLimiter();
        if (_grl && !_grl(clientKey(req))) {
          res.statusCode = 429;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Retry-After', '5');
          res.end(
            JSON.stringify({
              status: 'OVER_QUERY_LIMIT',
              results: [],
              error: 'Rate limit exceeded',
            }),
          );
          return;
        }

        try {
          const upstream = new URL(
            endpoints.geocode ||
              'https://maps.googleapis.com/maps/api/geocode/json',
          );
          for (const [name, value] of Object.entries(query.params))
            upstream.searchParams.set(name, value);
          upstream.searchParams.set('key', apiKey);
          const response = await fetchImpl(upstream.toString(), {
            redirect: 'error',
          });
          const data = await response.json().catch(() => null);

          res.statusCode = response.ok ? 200 : response.status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'private, max-age=300');
          res.end(
            JSON.stringify(
              data ?? {
                status: 'UNKNOWN_ERROR',
                results: [],
                error: 'Google Geocoding request failed',
              },
            ),
          );
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              status: 'UNKNOWN_ERROR',
              results: [],
              error: error?.message || 'Google Geocoding request failed',
            }),
          );
        }
      });
    }

    installGeocodeRoute('/api/google/geocode', (searchParams) => {
      const address = validateGeocodeAddress(searchParams);
      if (!address.ok) return address;
      const bounds = geocodeBounds(searchParams);
      return {
        ok: true,
        params: {
          address: address.address,
          ...(bounds ? { bounds } : {}),
        },
      };
    });

    installGeocodeRoute('/api/google/reverse-geocode', (searchParams) => {
      const coordinates = validatePlacesCoordinates(searchParams);
      if (!coordinates.ok) return coordinates;
      const { latitude, longitude } = coordinates;
      return { ok: true, params: { latlng: `${latitude},${longitude}` } };
    });
  }

  return {
    name: 'google-places-context-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
