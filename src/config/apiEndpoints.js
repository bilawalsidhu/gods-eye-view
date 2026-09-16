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
 * @typedef {object} ApiEndpoints
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
 * @returns {string} API base URL — '' (relative URLs) unless VITE_API_BASE_URL
 *   overrides it; a trailing slash is stripped so path joins stay clean.
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
  /**
   * OpenSky state vectors; the flights layer builds its bbox query itself.
   * @returns {string} Base `/api/opensky` URL with no query string.
   */
  opensky: () => apiEndpoints.opensky,
  /**
   * OpenSky single-flight track backfill.
   * @param {string} icao24 - ICAO24 transponder hex address of the aircraft.
   * @returns {string} Track URL carrying an encoded `icao24` query parameter.
   */
  openskyTrack: (icao24) => `${apiEndpoints.openskyTrack}?icao24=${encodeURIComponent(icao24)}`,
  /**
   * adsbdb aircraft type lookup by icao24.
   * @param {string} icao24 - ICAO24 hex address; lower-cased for the path segment.
   * @returns {string} REST-style `/type/<icao24>` lookup URL.
   */
  adsbdbType: (icao24) => `${apiEndpoints.adsbdb}/type/${icao24.toLowerCase()}`,
  /**
   * adsbdb route lookup by callsign.
   * @param {string} callsign - Radio callsign (e.g. `UAL123`) to resolve to a route.
   * @returns {string} REST-style `/route/<callsign>` lookup URL.
   */
  adsbdbRoute: (callsign) => `${apiEndpoints.adsbdb}/route/${encodeURIComponent(callsign)}`,
  /**
   * adsb.lol military state vectors; militaryFlights composes its query.
   * @returns {string} Base `/api/adsblol` URL with no query string.
   */
  adsblol: () => `${API_BASE}/api/adsblol`,
  /**
   * adsb.lol military snapshot.
   * @returns {string} `/api/adsblol/mil` URL (military-only airframes).
   */
  adsblolMil: () => `${API_BASE}/api/adsblol/mil`,
  /**
   * adsb.lol per-aircraft trace.
   * @param {string} icao24 - ICAO24 hex address of the aircraft to trace.
   * @returns {string} Trace URL carrying an encoded `hex` query parameter.
   */
  adsblolTrace: (icao24) => `${API_BASE}/api/adsblol/trace?hex=${encodeURIComponent(icao24)}`,
  /**
   * AISStream live vessel snapshot; the layer composes its query.
   * @returns {string} Base `/api/ais-live` URL with no query string.
   */
  aisLive: () => apiEndpoints.aisLive,
  /**
   * AIS per-vessel track history (server-side ring buffer since server boot).
   * @param {string} mmsi - Maritime Mobile Service Identity of the vessel.
   * @returns {string} Track URL carrying an encoded `mmsi` query parameter.
   */
  aisLiveTrack: (mmsi) => `${apiEndpoints.aisLive}/track?mmsi=${encodeURIComponent(mmsi)}`,

  // ── Orbit / space ─────────────────────────────────────────────────────
  /**
   * CelesTrak TLE group fetch; `path` is the upstream GROUP name.
   * @param {string} path - CelesTrak group segment (e.g. `active`, `starlink`).
   * @returns {string} Group-scoped `/api/celestrak/<path>` URL.
   */
  celestrak: (path) => `${apiEndpoints.celestrak}/${path}`,
  /**
   * Launch Library 2 recent launches; the layer appends its own query.
   * @returns {string} Base `/api/launches` URL with no query string.
   */
  rocketLaunches: () => apiEndpoints.rocketLaunches,

  // ── Earth observation / environment ───────────────────────────────────
  /**
   * NASA FIRMS active-fire detections; the layer composes its query.
   * @returns {string} Base `/api/firms` URL with no query string.
   */
  firms: () => apiEndpoints.firms,
  /**
   * Camera-local weather observations for cloud/precip effects.
   * @param {string|URLSearchParams} query - Precomposed query (interpolated
   *   here, so URLSearchParams stringifies); a leading `?` is added by this
   *   builder.
   * @returns {string} `/api/weather-effects` URL carrying the caller's query.
   */
  weatherEffects: (query) => `${API_BASE}/api/weather-effects?${query}`,

  // ── Ground transport ──────────────────────────────────────────────────
  /**
   * TomTom budget/status probe (keyless-degradable).
   * @returns {string} `/api/tomtom/status` URL.
   */
  tomtomStatus: () => `${API_BASE}/api/tomtom/status`,
  /**
   * TomTom traffic-flow vector tile.
   * @param {number} z - Tile zoom level.
   * @param {number} x - Tile column at that zoom.
   * @param {number} y - Tile row at that zoom.
   * @returns {string} Slippy-tile path `/api/tomtom/flow/<z>/<x>/<y>.pbf`.
   */
  tomtomFlowTile: (z, x, y) => `${API_BASE}/api/tomtom/flow/${z}/${x}/${y}.pbf`,
  /**
   * GBFS bikeshare feed passthrough; the upstream URL is the path.
   * @param {string} upstreamUrl - Absolute upstream GBFS endpoint URL.
   * @returns {string} Proxy URL with the upstream URL encoded as one segment.
   */
  gbfs: (upstreamUrl) => `${apiEndpoints.gbfs}/${encodeURIComponent(upstreamUrl)}`,

  // ── Map data ──────────────────────────────────────────────────────────
  /**
   * OpenStreetMap Overpass API; the POST body is composed by the caller.
   * @returns {string} Base `/api/overpass` URL with no query string.
   */
  overpass: () => apiEndpoints.overpass,
  /**
   * FOSSGIS OSRM walking/driving route snap.
   * @param {string} profile - OSRM profile (`car` | `bike` | `foot`).
   * @param {string} coords - Semicolon-joined `lon,lat` waypoints already
   *   formatted by the caller.
   * @returns {string} `/api/route` URL with `profile` and encoded `coords`.
   */
  route: (profile, coords) => `${API_BASE}/api/route?profile=${profile}&coords=${encodeURIComponent(coords)}`,
  /**
   * Keyless terrain heights; `points=lon,lat;lon,lat;…`.
   * @param {string} points - Semicolon-joined `lon,lat` sample points.
   * @returns {string} Heights URL with the encoded `points` query parameter.
   */
  terrainHeights: (points) => `${API_BASE}/api/terrain/heights?points=${encodeURIComponent(points)}`,
  /**
   * Keyless Nominatim geocode; `query` carries q/viewbox/limit.
   * @param {string|URLSearchParams} query - Precomposed query (interpolated
   *   here, so URLSearchParams stringifies); a leading `?` is added here.
   * @returns {string} `/api/geocode` URL carrying the caller's query.
   */
  geocode: (query) => `${API_BASE}/api/geocode?${query}`,

  // ── Places / context ──────────────────────────────────────────────────
  /**
   * Cached place + weather + news brief; `query` carries lat/lon.
   * @param {string|URLSearchParams} query - Precomposed query (interpolated
   *   here, so URLSearchParams stringifies); a leading `?` is added here.
   * @returns {string} `/api/regional-brief` URL carrying the caller's query.
   */
  regionalBrief: (query) => `${apiEndpoints.regionalBrief}?${query}`,
  /**
   * Google Places text search; the key stays server-side.
   * @param {string|URLSearchParams} query - Precomposed query (interpolated
   *   here, so URLSearchParams stringifies); a leading `?` is added here.
   * @returns {string} `/api/google/text-search` URL carrying the query.
   */
  googleTextSearch: (query) => `${API_BASE}/api/google/text-search?${query}`,
  /**
   * Google Places nearby search; the key stays server-side.
   * @param {string|URLSearchParams} query - Precomposed query (interpolated
   *   here, so URLSearchParams stringifies); a leading `?` is added here.
   * @returns {string} `/api/google/nearby-places` URL carrying the query.
   */
  googleNearbyPlaces: (query) => `${API_BASE}/api/google/nearby-places?${query}`,
  /**
   * Bounded mapped-installation context; the caller sends a bbox query.
   * @param {string|URLSearchParams} query - Precomposed query (interpolated
   *   here, so URLSearchParams stringifies); a leading `?` is added here.
   * @returns {string} `/api/military-installations` URL carrying the query.
   */
  militaryInstallations: (query) => `${apiEndpoints.militaryInstallations}?${query}`,
  /**
   * OpenZenith reverse geocode; lat/lon are already formatted by the caller.
   * @param {number|string} lat - Latitude as a number or a fixed-precision string.
   * @param {number|string} lon - Longitude as a number or a fixed-precision string.
   * @returns {string} Reverse-geocode URL with `lat` and `lon` query parameters.
   */
  openzenithReverseGeocode: (lat, lon) => `${API_BASE}/api/openzenith/reverse-geocode?lat=${lat}&lon=${lon}`,

  // ── CCTV ──────────────────────────────────────────────────────────────
  /**
   * CCTV camera catalog (sources).
   * @returns {string} `/api/cctv/sources` URL.
   */
  cctvSources: () => `${apiEndpoints.cctv}/sources`,
  /**
   * CCTV health probe.
   * @returns {string} `/api/cctv/health` URL.
   */
  cctvHealth: () => `${apiEndpoints.cctv}/health`,
  /**
   * CCTV still frame for one camera; `query` carries cache-busting params.
   * @param {string} cameraId - Source-qualified camera identifier.
   * @param {string} [query] - Query suffix the caller already composed
   *   (includes its own `?`); defaults to none.
   * @returns {string} Frame URL for that camera.
   */
  cctvFrame: (cameraId, query = '') => `${apiEndpoints.cctv}/frame/${encodeURIComponent(cameraId)}${query}`,
  /**
   * CCTV video media stream for one camera.
   * @param {string} cameraId - Source-qualified camera identifier.
   * @param {string} [query] - Query suffix the caller already composed
   *   (includes its own `?`); defaults to none.
   * @returns {string} Media-stream URL for that camera.
   */
  cctvMedia: (cameraId, query = '') => `${apiEndpoints.cctv}/media/${encodeURIComponent(cameraId)}${query}`,

  // ── Radio ─────────────────────────────────────────────────────────────
  /**
   * Radio Browser station directory search; the layer composes its query.
   * @returns {string} `/api/radio/stations` URL with no query string.
   */
  radioStations: () => `${apiEndpoints.radio}/stations`,
  /**
   * Radio Browser click counting.
   * @param {string} stationId - Directory station uuid credited with the play.
   * @returns {string} Click-count POST URL for that station.
   */
  radioClick: (stationId) => `${apiEndpoints.radio}/click/${encodeURIComponent(stationId)}`,

  // ── Voice / HUD ───────────────────────────────────────────────────────
  /**
   * OpenAI Realtime ephemeral token mint.
   * @returns {string} `/api/realtime/token` URL.
   */
  realtimeToken: () => `${API_BASE}/api/realtime/token`,
  /**
   * Realtime conversation debug-log sink.
   * @returns {string} `/api/realtime/debug-log` URL.
   */
  realtimeDebugLog: () => `${API_BASE}/api/realtime/debug-log`,
  /**
   * HUD AI scene summary.
   * @returns {string} `/api/openai/hud-summary` URL.
   */
  hudSummary: () => `${API_BASE}/api/openai/hud-summary`,
  /**
   * Anonymous session-analytics ping (no-op acknowledge).
   * @returns {string} `/api/analytics` URL.
   */
  analytics: () => `${API_BASE}/api/analytics`,
};

export { apiEndpoints };
