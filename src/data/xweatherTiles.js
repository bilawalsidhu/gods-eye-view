/**
 * @file Tile validation and tuning defaults for the Xweather radar proxy.
 *
 * Shared by the `/api/xweather` vite plugin (coordinate validation before the
 * key check, budget and cadence defaults) and the precipitation layer, which
 * needs the same zoom ceiling it asks Cesium to stop at. Zero dependencies and
 * Cesium-free so both sides can unit-test against it with node:test.
 *
 * Slippy scheme: standard Web Mercator XYZ, y growing southward — Xweather
 * serves 256x256 PNG tiles in Spherical Mercator, the scheme every common
 * mapping library uses.
 *
 * @module data/xweatherTiles
 */

/** @const {number} Whole-globe tile; Xweather serves radar from here up. */
export const MIN_TILE_ZOOM = 0;

/**
 * @const {number} Deepest tile this app requests.
 *
 * Measured against the live service rather than guessed from the nominal
 * resolution. Over Tokyo, with convection in range of a dense radar network,
 * level 8 still showed discrete cells with intensity cores; level 10 was
 * already smooth blobs and level 11 a single faceted smear — the service
 * upsampling a coarser source. Level 9 is ~305 m/px, comfortably past a ~1 km
 * composite, so it is the last level carrying real information.
 *
 * Stopping here is also the cheapest lever available: each further level is an
 * entirely new tile set to pay for, and they would only ever be blurrier
 * copies of this one. Cesium magnifies past it, which costs nothing.
 */
export const MAX_TILE_ZOOM = 9;

/**
 * @const {number} Default refresh cadence, deliberately conservative.
 *
 * Xweather updates radar-global every two minutes, so this is far slower than
 * the data — an hourly tick can show a sweep up to an hour old. It starts here
 * because every tile is billable and the real call volume has to be measured
 * before choosing; `XWEATHER_REFRESH_MS` overrides it.
 */
export const DEFAULT_REFRESH_MS = 60 * 60 * 1000;

/** @const {number} Floor on the configured cadence, so a stray 0 cannot hammer upstream. */
export const MIN_REFRESH_MS = 60 * 1000;

/**
 * @const {number} Default upstream fetches allowed per UTC day.
 *
 * The free allowance is 15,000 accesses a month; 400/day is ~12,000 across a
 * 30-day month, leaving headroom. A soft cap, not a billing guarantee.
 */
export const DEFAULT_DAILY_TILE_BUDGET = 400;

/** @const {number} Default ceiling on the on-disk tile cache. */
export const DEFAULT_DISK_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Validate a z/x/y tile coordinate for the Xweather radar proxy.
 *
 * Checked before the key is read, so a malformed request is a 400 rather than
 * a billable upstream fetch.
 *
 * @param {number} z - Zoom level; integer within [MIN_TILE_ZOOM, MAX_TILE_ZOOM].
 * @param {number} x - Tile column; integer within [0, 2^z - 1].
 * @param {number} y - Tile row; integer within [0, 2^z - 1].
 * @returns {boolean} True when the coordinate is a fetchable tile.
 */
export function isValidTileCoord(z, x, y) {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y))
    return false;
  if (z < MIN_TILE_ZOOM || z > MAX_TILE_ZOOM) return false;
  const n = 2 ** z;
  return x >= 0 && x < n && y >= 0 && y < n;
}

/**
 * Resolve the refresh cadence from the environment, clamped to the floor.
 *
 * @param {string|undefined} raw - Configured value, typically process.env.
 * @returns {number} Milliseconds between refreshes.
 */
export function resolveRefreshMs(raw) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REFRESH_MS;
  return Math.max(MIN_REFRESH_MS, parsed);
}
