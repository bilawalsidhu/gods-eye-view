/**
 * Keyless geocode proxy (`/api/geocode`) — thin dev adapter over the shared
 * `resolveGeocodeRequest` core in `src/data/geocodePolicy.js`, which the
 * Pages Function (`functions/api/geocode.js`) imports verbatim. OpenStreetMap
 * Nominatim search for keyless installs; see the policy module for the HTTP
 * contract, caching, and Nominatim usage-policy notes.
 */

import {
  NOMINATIM_SEARCH_ENDPOINT,
  resolveGeocodeRequest,
} from '../../src/data/geocodePolicy.js';

export function geocodeProxy() {
  /** @type {Map<string,{at:number,payload:object}>} */
  const cache = new Map();
  /** @type {Map<string,Promise<object>>} */
  const inFlight = new Map();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const outcome = await resolveGeocodeRequest({
      method: req.method,
      searchParams: url.searchParams,
      cache,
      inFlight,
      baseUrl: process.env.NOMINATIM_BASE_URL || NOMINATIM_SEARCH_ENDPOINT,
    });
    res.statusCode = outcome.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', outcome.cacheControl);
    res.setHeader('X-GEV-Cache', outcome.cacheState);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify(outcome.payload));
  }

  return {
    name: 'geocode-proxy',
    configureServer(server) {
      server.middlewares.use('/api/geocode', handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/geocode', handle);
    },
  };
}
