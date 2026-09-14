import * as Cesium from 'cesium';

/**
 * @file Street Traffic — animated dots along OSM road polylines, colored by
 * live TomTom congestion when a key is configured.
 *
 * Road geometry: OSM Overpass API (free, no auth). Fetches road polylines for
 * the camera viewport, spawns PointPrimitives that lerp along pre-computed
 * Cartesian3 waypoints. Camera-gated: only active below ~8 km altitude.
 *
 * Two modes (decided once per session via `/api/tomtom/status`):
 *  - `sim` (keyless default): white dots at hardcoded per-road-class speeds —
 *    the original simulation, byte-identical behavior.
 *  - `live`: TomTom flow tiles (`flowTiles.js`) are matched onto the same
 *    Overpass roads (`flowMatch.js`); matched roads color/slow/densify their
 *    dots by real congestion (`trafficFlowStyle.js`), closed roads spawn no
 *    dots, and unmatched roads keep the simulated white.
 *
 * Architecture overview:
 *  - Camera-change listener triggers debounced road fetching per viewport tile.
 *  - Fetch bounds center on the camera's look-at point (`trafficBounds.js`, C4).
 *  - Roads are fetched in two passes: major-only (fast) then full graph (detailed).
 *  - Fetched tiles are cached by clamped bounding-box key to avoid re-fetching.
 *  - Dot budget allocation distributes a hard cap fairly across visible roads.
 *  - Each dot lerps along pre-computed Cartesian3 waypoints every preRender frame.
 *
 * @module data/traffic
 */

/** @const {string} Proxy endpoint for Overpass API queries */

export const OVERPASS_URL = '/api/overpass';

/** @const {number} Meters — hide all traffic dots above this camera altitude */

export const ACTIVATION_ALTITUDE = 8000;

/** @const {number} Meters — above this altitude, only major roads are fetched */

export const FAST_FETCH_ALTITUDE = 4500;

/** @const {number} Milliseconds — debounce delay before fetching after camera settles */

export const FETCH_DEBOUNCE = 320;

/** @const {number} Meters — vertical offset to keep dots above clamped terrain surface */

export const DOT_HEIGHT_OFFSET = 3.0;

/** @const {number} Fraction (0-1) — skip re-fetch when viewport overlap exceeds this */

export const OVERLAP_THRESHOLD = 0.6;

/** @const {number} Hard cap on total rendered dot primitives for GPU/CPU performance */

export const MAX_DOTS = 6000;

/** @const {number} Polylines longer than this are simplified by sub-sampling */

export const MAX_WAYPOINTS_PER_ROAD = 80;

/** @const {number} Km — minimum viewport center shift before allowing refresh */

export const MIN_CENTER_SHIFT_KM = 0.35;

/**
 * @const {number} Km — max great-circle distance the fetch center may sit from
 * the camera nadir. Traffic only activates below ACTIVATION_ALTITUDE (8 km),
 * so a look-at ground point farther than this is horizon-gazing and gets
 * pulled back toward nadir (C4 oblique-bounds fix).
 */

export const MAX_LOOKAT_PULL_KM = 12;

/**
 * Development-only causal timing. Vite folds `import.meta.env.DEV` to false
 * in production, so the query-string read, nullable trace branches, and every
 * debug helper are removed from production builds. The remaining load-path
 * selectors point directly at the original functions: no marks, listeners,
 * observers, timers, counters, or per-road timing checks are installed.
 */

export const TRAFFIC_TIMING_ENABLED =
  import.meta.env?.DEV &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('trafficDebug') === '1';

/** @const {Object<string,number>} Speed in meters per second by highway tag (approximate real-world values) */

export const SPEED_MPS = {
  motorway: 25, // ~90 km/h
  trunk: 20, // ~72 km/h
  primary: 14, // ~50 km/h
  secondary: 11, // ~40 km/h
  tertiary: 8, // ~30 km/h
  residential: 5, // ~18 km/h
  unclassified: 5,
};

/** @const {Object<string,number>} Density multiplier — higher values spawn more dots on important roads */

export const DENSITY_MULT = {
  motorway: 3.0,
  trunk: 2.5,
  primary: 2.0,
  secondary: 1.5,
  tertiary: 1.0,
  residential: 0.5,
  unclassified: 0.4,
};

/** @const {Object<string,number>} Pixel size per road type (scaled up 25% for screen-recording visibility) */

export const SIZE_BY_TYPE = {
  motorway: 6,
  trunk: 6,
  primary: 5,
  secondary: 5,
  tertiary: 4,
  residential: 4,
  unclassified: 4,
};

/**
 * Live-flow bucket colors (thresholds live in `trafficFlowStyle.js`):
 * green free flow / amber slow / red jam, all at 0.9 alpha.
 * Roads without flow data (`road.flow == null`) keep the sim's white.
 * @const {Object<string, Cesium.Color>}
 */

export const FLOW_BUCKET_COLORS = {
  free: Cesium.Color.fromCssColorString('#2ecc71').withAlpha(0.9),
  slow: Cesium.Color.fromCssColorString('#f0b23e').withAlpha(0.9),
  jam: Cesium.Color.fromCssColorString('#e05252').withAlpha(0.9),
};

// ─── Jam-viz prototype (live mode only — see 2026-07-21 design doc) ────────
/** @const {number} Max congestion heat-line polylines per render (jam first). */

export const HEAT_LINE_CAP = 400;

/** @const {number} Px — glowing jam corridor line width. */

export const HEAT_LINE_JAM_WIDTH = 9;

/** @const {number} Px — flat slow corridor line width. */

export const HEAT_LINE_SLOW_WIDTH = 4;

/** @const {number} Jam heat-line alpha midpoint (pulse oscillates around it). */

export const HEAT_JAM_BASE_ALPHA = 0.55;

/** @const {number} Jam heat-line pulse amplitude (±, ~1.6 s period). */

export const HEAT_JAM_PULSE_ALPHA = 0.2;

/** @const {Cesium.Color} Jam corridor color (bucket red, alpha pulsed live). */

export const HEAT_JAM_COLOR = Cesium.Color.fromCssColorString('#e05252');

/** @const {Cesium.Color} Slow corridor color (bucket amber, faint + static). */

export const HEAT_SLOW_COLOR =
  Cesium.Color.fromCssColorString('#f0b23e').withAlpha(0.2);

/**
 * @const {number} Meters — jam dots depth-test-punch through the 3D tiles out
 * to this camera distance so queues stay visible at city scale. The single
 * start-of-road terrain sample puts much of a road below the rendered mesh
 * at oblique city views (first A/B capture: 396 jam dots, zero visible), so
 * the shipped 2 km window hides exactly the congestion this prototype is
 * meant to surface. Live jam dots only; sim dots keep the shipped 2 km.
 */

export const JAM_DOT_DEPTH_PUNCH = 15000;

/** @const {number} Far-distance scale floor for jam dots (shipped: 0.3). */

export const JAM_DOT_FAR_SCALE = 0.55;

/** @const {number} Speed multiplier while a stop-and-go jam dot bursts forward. */

export const CREEP_BURST = 2.2;

/** @const {number[]} Ms range a jam dot creeps forward before stopping. */

export const CREEP_MOVE_MS = [1200, 3000];

/** @const {number[]} Ms range a jam dot sits stopped between creeps. */

export const CREEP_STOP_MS = [1500, 5000];

/**
 * @const {number} Minimum base pixel size for COLORED dots while a styled
 * preset is active — residential-road dots spawn at 4 px and vanish into
 * post-FX pixelation; presence is the dots' whole job there (owner round
 * 2). Sim dots and the normal profile keep SIZE_BY_TYPE untouched.
 */

export const STYLED_MIN_BASE_PX = 5;

/** @const {number} Maximum tile cache entries before LRU eviction */

export const TILE_CACHE_MAX_ENTRIES = 64;

/**
 * Milliseconds the first dot paint will wait for flow data. Cached flow
 * settles within this window (decode cache, 120 s TTL) and renders fully
 * colored; a cold tile fetch loses the race, dots paint immediately in
 * white, and recolorDotsInPlace applies the colors when flow arrives —
 * field-test round 1's "takes forever to load" was the sequential wait.
 */

export const FLOW_RENDER_RACE_MS = 250;
