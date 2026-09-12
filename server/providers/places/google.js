import {
  googleServerApiKey,
  keylessGooglePlacesResponse,
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

/** Nearby place labels and view-biased text search, with request-time key resolution. */
export function googlePlacesContextProxy({
  resolveApiKey = googleServerApiKey,
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

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const latitude = Number(requestUrl.searchParams.get('lat'));
      const longitude = Number(requestUrl.searchParams.get('lon'));
      const radiusM = Math.max(
        25,
        Math.min(5000, Number(requestUrl.searchParams.get('radiusM')) || 250),
      );
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 'Valid lat and lon are required',
            places: [],
          }),
        );
        return;
      }

      try {
        const response = await fetch(
          'https://places.googleapis.com/v1/places:searchNearby',
          {
            method: 'POST',
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

      const requestUrl = new URL(req.url || '', 'http://localhost');
      const textQuery = String(requestUrl.searchParams.get('q') || '').trim();
      const latitude = Number(requestUrl.searchParams.get('lat'));
      const longitude = Number(requestUrl.searchParams.get('lon'));
      const radiusM = Math.max(
        50,
        Math.min(50000, Number(requestUrl.searchParams.get('radiusM')) || 4000),
      );
      if (
        !textQuery ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ error: 'q, lat and lon are required', places: [] }),
        );
        return;
      }

      try {
        const response = await fetch(
          'https://places.googleapis.com/v1/places:searchText',
          {
            method: 'POST',
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
