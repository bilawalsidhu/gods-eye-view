import { makeRateLimiter } from '../common/rate-limit.js';

// ---------------------------------------------------------------------------
// Street View fallback admission
// ---------------------------------------------------------------------------
// `/api/cctv/frame/:id` degrades upstream snapshot -> Street View -> synthetic
// SVG. Only the middle step leaves the machine on a metered account: Street
// View Static bills the operator's own Google key per image. Everything else
// this proxy does is free, so this is the one branch where an unauthenticated
// request costs the operator money, and it is the branch that decides who is
// allowed to spend it.

/** Fixed window for the Street View admission counter. */
export const STREET_VIEW_WINDOW_MS = 60_000;

/**
 * Per-IP Street View lookups per minute.
 *
 * Sized from what the layer itself asks for rather than from a round number:
 * the ambient card drain is capped at 16 cameras (CCTV_AMBIENT_CARD_DRAIN_CAP)
 * and an active card re-requests its frame every ACTIVE_FRAME_REFRESH_MS
 * (10s), so a viewer whose cameras have all lost their upstreams sits at
 * 16 x 6 = 96 fallback frames per minute. That is the honest worst case for
 * one person using the layer as designed, which is why the shared 90/min used
 * by the Overpass-backed routes would cut into normal use here. 240 leaves
 * that case 2.5x of headroom while still refusing the unbounded loop the
 * route accepted before.
 */
export const STREET_VIEW_MAX_PER_IP = 240;

/** Aggregate backstop so one host cannot spend the whole key by itself. */
export const STREET_VIEW_GLOBAL_MAX = 720;

/** Build the per-IP Street View admission gate. */
export function makeStreetViewRateLimiter() {
  return makeRateLimiter({
    windowMs: STREET_VIEW_WINDOW_MS,
    max: STREET_VIEW_MAX_PER_IP,
    globalMax: STREET_VIEW_GLOBAL_MAX,
  });
}

/**
 * Wrap a bearing into [0, 360).
 *
 * Street View reads `heading` as a compass bearing, and a bearing is periodic:
 * the right answer for 400 is 40, and for -90 it is 270, so this wraps where
 * `fov` and `pitch` clamp. A non-finite bearing has no sensible wrap and
 * becomes 0, which is what the route already did.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeHeadingDeg(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return ((num % 360) + 360) % 360;
}

/**
 * Read one coordinate, treating "absent" as absent rather than as zero.
 *
 * `Number(null)` and `Number('')` are both `0`, so a catalog row that simply
 * has no position would otherwise resolve to a perfectly finite point in the
 * Gulf of Guinea and buy a Street View frame of the ocean. Sources are parsed
 * from CSV and JSON feeds, so a numeric string is still accepted.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function coordinate(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Resolve the coordinates a Street View fallback may be fetched for, or null
 * when the request must not reach Google at all.
 *
 * The frame route accepts `lat`/`lon` on the query string, and the browser
 * sends them on every frame: `frameUrlFor` in `src/layers/cctv/source.js`
 * copies them off the camera record it got from `/api/cctv/sources`. They are
 * therefore always a restatement of what the server already holds, which is
 * what makes them safe to stop honouring — the registered pose is used
 * instead, so a hand-written query cannot point a billable lookup at an
 * address of its choosing. The pose angles stay client-supplied because those
 * are a genuine refinement (`frames.js` sends a default pitch where the
 * catalog has none) and they only aim a lookup that is already paid for.
 *
 * An unregistered camera id resolves to nothing, so an id the catalog never
 * served cannot spend a lookup either.
 *
 * @param {{lat?:unknown, lon?:unknown}|undefined|null} source - Registered camera record.
 * @returns {{lat:number, lon:number}|null} Billable target, or null to refuse.
 */
export function resolveStreetViewTarget(source) {
  if (!source) return null;
  const lat = coordinate(source.lat);
  const lon = coordinate(source.lon);
  if (lat === null || lon === null) return null;
  // A finite number is not a coordinate. Google answers 400 for an off-globe
  // location, but the request has already been made by then, so the bound is
  // checked here instead of being discovered upstream.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}
