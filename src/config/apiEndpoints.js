/**
 * apiEndpoints.js — Central API endpoint configuration
 *
 * Provides the base URL for all backend API calls.
 *
 * Strategy:
 *  - In development (npm run dev): uses the local Vite proxy at /api/*
 *    The Vite dev server proxies /api/* requests to individual backend services
 *    running locally (wrangler dev on port 8787) or directly to upstream APIs.
 *    This keeps dev working without any external infrastructure.
 *
 *  - In production (npm run build → deployed to Cloudflare Pages):
 *    Browser → Cloudflare Pages (static assets) + /api/* → Cloudflare Workers
 *    Workers → upstream APIs (keys kept server-side).
 *
 * The VITE_API_BASE_URL env var overrides the default production behavior
 * when set. Useful for staging environments or local production testing.
 */

const DEV_API_BASE = ''; // Relative URLs — Vite dev server proxy handles routing

/**
 * @typedef {Object} ApiEndpoints
 * @property {string} opensky         — OpenSky aircraft state vectors
 * @property {string} openskyTrack   — OpenSky single-flight history
 * @property {string} adsbdb          — ADSB.fi database lookup
 * @property {string} celestrak      — CelesTrak satellite TLE
 * @property {string} aisLive       — AISStream vessel WebSocket
 * @property {string} firms          — NASA FIRMS fire detection
 * @property {string} tomtom         — TomTom traffic flow
 * @property {string} cctv          — CCTV camera catalog
 * @property {string} overpass      — OpenStreetMap Overpass
 * @property {string} gbfs          — GBFS bikeshare feeds
 * @property {string} terrain        — Terrain height lookup
 * @property {string} weather        — Open-Meteo weather
 * @property {string} radio          — Radio Browser
 * @property {string} rocketLaunches — Launch Library 2
 * @property {string} militaryInstallations — Military installations
 * @property {string} regionalBrief  — Regional briefing
 */

/**
 * Returns the configured API base URL.
 * Defaults to empty string (relative URLs) in development.
 * In production builds, this resolves to the Workers API URL when configured,
 * or falls back to relative URLs when deploying to Cloudflare Pages with a
 * worker binding at the same domain.
 *
 * @returns {string}
 */
function getApiBase() {
  // Explicit override (e.g. staging environment)
  const envBase = /** @type {any} */ (import.meta);
  const env = envBase?.env ?? {};
  if (env.VITE_API_BASE_URL) {
    return env.VITE_API_BASE_URL.replace(/\/$/, '');
  }
  // Production: no prefix needed when Cloudflare Workers serves /api/* at the same domain
  // as the static pages. The browser fetches relative URLs and Cloudflare routes them.
  return DEV_API_BASE;
}

const API_BASE = getApiBase();

// NOTE: ADSB.fi and ADSB.flights don't have dedicated proxy workers yet.
// The browser fetches these directly (CORS allowed by their servers).
// When proxy workers are added, update adsbDb and adsbFlights paths.

/** @type {ApiEndpoints} */
const apiEndpoints = {
  opensky:          `${API_BASE}/api/opensky`,
  openskyTrack:     `${API_BASE}/api/opensky-track`,
  adsbdb:           `${API_BASE}/api/adsbdb`,          // ADSB.fi lookup (no key)
  celestrak:        `${API_BASE}/api/celestrak`,
  aisLive:          `${API_BASE}/api/ais-live`,
  firms:            `${API_BASE}/api/firms`,
  tomtom:           `${API_BASE}/api/tomtom`,
  cctv:             `${API_BASE}/api/cctv`,
  overpass:         `${API_BASE}/api/overpass`,
  gbfs:             `${API_BASE}/api/gbfs`,
  terrain:          `${API_BASE}/api/terrain`,
  weather:          `${API_BASE}/api/weather`,
  radio:            `${API_BASE}/api/radio`,
  rocketLaunches:   `${API_BASE}/api/launches`,
  militaryInstallations: `${API_BASE}/api/military-installations`,
  regionalBrief:    `${API_BASE}/api/regional-brief`,
};

export { apiEndpoints };
