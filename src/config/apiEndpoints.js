/**
 * apiEndpoints.js — Central API endpoint configuration
 *
 * Provides the base URL for all backend API calls, plus `api` — the single
 * inventory of concrete client-callable routes. Client code must not
 * hardcode `/api/...` literals; compose URLs through this module so every
 * dev middleware (see vite/proxies/*) and Pages Function has exactly one
 * client-side declaration to stay in sync with.
 *
 * Strategy:
 *  - In development (npm run dev): uses the local Vite proxy at /api/*
 *    The Vite dev server implements /api/* as native middlewares
 *    (see vite/proxies/*) that broker keys and forward to upstream APIs.
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
 * @property {string} radio          — Radio Browser
 * @property {string} rocketLaunches — Launch Library 2
 * @property {string} militaryInstallations — Military installations
 * @property {string} regionalBrief  — Regional briefing
 * @property {string} geocode        — Keyless Nominatim geocode
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
  // Explicit override (e.g. staging environment). Static member access only:
  // Vite folds `import.meta.env.VITE_API_BASE_URL` at build time, and its SSR
  // module runner (used by the trafficTiming harness) rejects dynamic
  // `import.meta.env` access outright.
  const override = import.meta.env?.VITE_API_BASE_URL;
  if (override) {
    return override.replace(/\/$/, '');
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
  radio:            `${API_BASE}/api/radio`,
  rocketLaunches:   `${API_BASE}/api/launches`,
  militaryInstallations: `${API_BASE}/api/military-installations`,
  regionalBrief:    `${API_BASE}/api/regional-brief`,
  geocode:          `${API_BASE}/api/geocode`,
};

/**
 * Route builders — one per concrete client-callable route. Each reproduces,
 * byte for byte, the URL its call site used to compose inline. Query-string
 * builders take a URLSearchParams or a preformatted string (template
 * interpolation stringifies both); builders whose call site appends its own
 * `?query` take no argument.
 */
export const api = {
  // ── Aircraft ──────────────────────────────────────────────────────────
  /** OpenSky state vectors (flights layer builds its bbox query itself). */
  opensky: () => apiEndpoints.opensky,
  /** OpenSky single-flight track backfill. */
  openskyTrack: (icao24) => `${apiEndpoints.openskyTrack}?icao24=${encodeURIComponent(icao24)}`,
  /** adsbdb aircraft type lookup by icao24. */
  adsbdbType: (icao24) => `${apiEndpoints.adsbdb}/type/${icao24.toLowerCase()}`,
  /** adsbdb route lookup by callsign. */
  adsbdbRoute: (callsign) => `${apiEndpoints.adsbdb}/route/${encodeURIComponent(callsign)}`,
  /** adsb.lol military state vectors (militaryFlights composes its query). */
  adsblol: () => `${API_BASE}/api/adsblol`,
  /** adsb.lol military snapshot. */
  adsblolMil: () => `${API_BASE}/api/adsblol/mil`,
  /** adsb.lol per-aircraft trace. */
  adsblolTrace: (icao24) => `${API_BASE}/api/adsblol/trace?hex=${encodeURIComponent(icao24)}`,
  /** AISStream live vessel snapshot (layer composes its query). */
  aisLive: () => apiEndpoints.aisLive,
  /** AIS per-vessel track history. */
  aisLiveTrack: (mmsi) => `${apiEndpoints.aisLive}/track?mmsi=${encodeURIComponent(mmsi)}`,

  // ── Orbit / space ─────────────────────────────────────────────────────
  /** CelesTrak TLE group fetch (`path` is the upstream GROUP name). */
  celestrak: (path) => `${apiEndpoints.celestrak}/${path}`,
  /** Launch Library 2 recent launches. */
  rocketLaunches: () => apiEndpoints.rocketLaunches,

  // ── Earth observation / environment ───────────────────────────────────
  /** NASA FIRMS active-fire detections. */
  firms: () => apiEndpoints.firms,
  /** Camera-local weather observations for cloud/precip effects. */
  weatherEffects: (query) => `${API_BASE}/api/weather-effects?${query}`,

  // ── Ground transport ──────────────────────────────────────────────────
  /** TomTom budget/status probe (keyless-degradable). */
  tomtomStatus: () => `${API_BASE}/api/tomtom/status`,
  /** TomTom traffic-flow vector tile. */
  tomtomFlowTile: (z, x, y) => `${API_BASE}/api/tomtom/flow/${z}/${x}/${y}.pbf`,
  /** GBFS bikeshare feed passthrough (the upstream URL is the path). */
  gbfs: (upstreamUrl) => `${apiEndpoints.gbfs}/${encodeURIComponent(upstreamUrl)}`,

  // ── Map data ──────────────────────────────────────────────────────────
  /** OpenStreetMap Overpass API (POST body composed by the caller). */
  overpass: () => apiEndpoints.overpass,
  /** FOSSGIS OSRM walking/driving route snap. */
  route: (profile, coords) => `${API_BASE}/api/route?profile=${profile}&coords=${encodeURIComponent(coords)}`,
  /** Keyless terrain heights (`points=lon,lat;lon,lat;…`). */
  terrainHeights: (points) => `${API_BASE}/api/terrain/heights?points=${encodeURIComponent(points)}`,
  /** Keyless Nominatim geocode (`query` carries q/viewbox/limit). */
  geocode: (query) => `${API_BASE}/api/geocode?${query}`,

  // ── Places / context ──────────────────────────────────────────────────
  /** Cached place + weather + news brief (`query` carries lat/lon). */
  regionalBrief: (query) => `${apiEndpoints.regionalBrief}?${query}`,
  /** Google Places text search (key stays server-side). */
  googleTextSearch: (query) => `${API_BASE}/api/google/text-search?${query}`,
  /** Google Places nearby search (key stays server-side). */
  googleNearbyPlaces: (query) => `${API_BASE}/api/google/nearby-places?${query}`,
  /** Bounded mapped-installation context (bbox query). */
  militaryInstallations: (query) => `${apiEndpoints.militaryInstallations}?${query}`,
  /** OpenZenith reverse geocode (lat/lon already formatted by the caller). */
  openzenithReverseGeocode: (lat, lon) => `${API_BASE}/api/openzenith/reverse-geocode?lat=${lat}&lon=${lon}`,

  // ── CCTV ──────────────────────────────────────────────────────────────
  /** CCTV camera catalog (sources). */
  cctvSources: () => `${apiEndpoints.cctv}/sources`,
  /** CCTV health probe. */
  cctvHealth: () => `${apiEndpoints.cctv}/health`,
  /** CCTV still frame for one camera; `query` carries cache-busting params. */
  cctvFrame: (cameraId, query = '') => `${apiEndpoints.cctv}/frame/${encodeURIComponent(cameraId)}${query}`,
  /** CCTV video media stream for one camera. */
  cctvMedia: (cameraId, query = '') => `${apiEndpoints.cctv}/media/${encodeURIComponent(cameraId)}${query}`,

  // ── Radio ─────────────────────────────────────────────────────────────
  /** Radio Browser station directory search. */
  radioStations: () => `${apiEndpoints.radio}/stations`,
  /** Radio Browser click counting. */
  radioClick: (stationId) => `${apiEndpoints.radio}/click/${encodeURIComponent(stationId)}`,

  // ── Voice / HUD ───────────────────────────────────────────────────────
  /** OpenAI Realtime ephemeral token mint. */
  realtimeToken: () => `${API_BASE}/api/realtime/token`,
  /** Realtime conversation debug-log sink. */
  realtimeDebugLog: () => `${API_BASE}/api/realtime/debug-log`,
  /** HUD AI scene summary. */
  hudSummary: () => `${API_BASE}/api/openai/hud-summary`,
  /** Anonymous session-analytics ping (no-op acknowledge). */
  analytics: () => `${API_BASE}/api/analytics`,
};

export { apiEndpoints };
