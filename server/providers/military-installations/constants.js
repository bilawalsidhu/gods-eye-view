import path from 'node:path';

// ---------------------------------------------------------------------------
// Military-installation context proxy
// ---------------------------------------------------------------------------
// This narrow endpoint deliberately does not expose arbitrary Overpass QL to
// the browser. It returns only allow-listed mapped context and rejects global,
// cross-dateline, or oversized requests before touching public OSM mirrors.
const MILITARY_INSTALLATION_CACHE_MS = 5 * 60_000;

const MILITARY_INSTALLATION_STALE_MS = 60 * 60_000;

const MILITARY_INSTALLATION_MAX_CACHE = 80;

const MILITARY_INSTALLATION_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Upstream element cap. A response that hits it exactly is SATURATED — Overpass
 * truncated, so off-viewport features from the snapped bbox may have crowded out
 * in-viewport ones. Callers re-ask for the exact viewport in that case.
 */
const MILITARY_INSTALLATION_ELEMENT_CAP = 700;

/**
 * Disk-cache TTL for mapped installations (ms) — 30 days.
 *
 * Owner playtest 2026-08-18: "search nearby sites" was slow because every look
 * around paid a live Overpass round trip, and the 5-minute in-memory tier died
 * with the dev server. Mapped military features change on a survey timescale,
 * not a session one, so a month-old answer is still the right answer — the same
 * reasoning the Overpass proxy already applies to admin boundaries.
 */
const MILITARY_INSTALLATION_DISK_TTL_MS = 30 * 86_400_000;

/** Disk-cache directory for mapped installation payloads. */
const MILITARY_INSTALLATION_DISK_DIR = path.join(
  process.cwd(),
  '.gev-cache',
  'military-installations',
);

/**
 * Cache-key grid step in degrees (~5.5 km).
 *
 * The browser sends the raw view rectangle, so every pixel of pan minted a new
 * key and a new upstream query. Snapping the bbox OUTWARD onto a coarse grid
 * makes neighbouring viewports share one entry, and because the snap only ever
 * grows the box, the cached answer is always a superset of what was asked for.
 */
const MILITARY_INSTALLATION_BBOX_STEP_DEG = 0.05;

export {
  MILITARY_INSTALLATION_ELEMENT_CAP,
  MILITARY_INSTALLATION_MAX_RESPONSE_BYTES,
  MILITARY_INSTALLATION_DISK_TTL_MS,
  MILITARY_INSTALLATION_STALE_MS,
  MILITARY_INSTALLATION_CACHE_MS,
  MILITARY_INSTALLATION_DISK_DIR,
  MILITARY_INSTALLATION_MAX_CACHE,
  MILITARY_INSTALLATION_BBOX_STEP_DEG,
};
