import path from 'node:path';

/** Mapillary vector tile root; the path template is /{layer}/2/{z}/{x}/{y}. */
export const MAPILLARY_TILE_HOST = 'https://tiles.mapillary.com/maps/vtp';

/** Public tile layer names this proxy exposes, mapped to Mapillary's ids. */
export const TILE_LAYERS = Object.freeze({
  // Overview points (z0–5), sequences (z6–14) and image points (z14 only).
  // The z14 `image` point layer is ~98% of a 10 MB tile and unused here:
  // image positions come from the graph API per sequence. Dropped in transit.
  coverage: Object.freeze({
    upstream: 'mly1_public',
    minZoom: 0,
    maxZoom: 14,
    dropLayers: Object.freeze(['image']),
  }),
});

/** Disk cache root, alongside the other providers' caches. */
export const MAPILLARY_CACHE_DIR = path.join(
  process.cwd(),
  '.gev-cache',
  'mapillary',
);
export const TILE_DISK_DIR = path.join(MAPILLARY_CACHE_DIR, 'tiles');

/**
 * Tiles change when new imagery is processed, which is far slower than the
 * 15-minute upstream Cache-Control. A day keeps a session over one city from
 * re-downloading its tiles on every camera move.
 */
export const TILE_DISK_TTL_MS = 24 * 60 * 60 * 1000;

/** A z14 image tile over a dense city is ~11 MB; anything past this is wrong. */
export const TILE_MAX_BYTES = 48 * 1024 * 1024;

/** In-memory tile cache budget (bytes) and upstream fetch timeout. */
export const TILE_MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;
export const TILE_FETCH_TIMEOUT_MS = 60_000;

/** The client token lives in the browser by design; the server adds it to tile URLs too. */
export function mapillaryToken() {
  return String(process.env.MAPILLARY_CLIENT_TOKEN || '').trim();
}
