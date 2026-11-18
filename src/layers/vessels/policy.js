import { VESSEL_LABEL_GRID_PX } from '../../data/vesselLabels.js';
import { msg } from '../../i18n/index.js';

export const FOCUS_EVIDENCE_DEV = import.meta.env?.DEV === true;

export const DEFAULT_RENDER_ROWS = 12000;

export const DEFAULT_ACTIVE_LABELS = 900;

export const REFRESH_MS = 60000;

/** Bounded wait for the first accepted vessel position in one enabled session. */

export const AIS_FIRST_CONNECT_GRACE_MS = 30000;

export const VISIBILITY_UPDATE_MS = 800;

/** Focus alpha alone samples faster inside the existing preRender pass. */

export const FOCUS_UPDATE_MS = 80;

export const LABEL_GRID_PX = VESSEL_LABEL_GRID_PX;

/**
 * Minimum screen-space separation between accepted vessel cards (matches the
 * FIRMS card declutter). The 118px grid alone under-spaces the wider canvas
 * cards; the greedy pass below enforces true card-scale spacing.
 */

export const CARD_MIN_SEP_PX = 150;

/** Trail hue for the selected vessel (PRD F4, pinned to the AIS teal-green family). */

export const TRAIL_COLOR = '#39ffd5';

/** Slight lift (m) for trail vertices to avoid sea-surface z-fighting. */

export const TRAIL_HEIGHT_M = 3;

/**
 * Lift (m) above the local sea surface (geoid) for vessel anchors — locked
 * height-datum principle #1: never below the visible surface, slightly above
 * is always fine (clears tide/mesh noise in the photoreal sea mesh).
 */

export const VESSEL_LIFT_M = 3;

/**
 * How far (m) above or below sea level, as the terrain service gives it,
 * water must be before a vessel is drawn on it instead of on the geoid.
 * Lakes, rivers and locked docks are drawn at their own level (Lake Michigan
 * ≈ 176 m, the Seine in Paris ≈ 27 m, the Caspian ≈ −28 m); nearer sea level
 * it is the sea. Checked against 495 live AIS positions: open and tidal water
 * around ports reads −3…+4 m, while the lowest raised water among them (the
 * Seattle ship canal behind its locks; Liverpool's and Antwerp's impounded
 * docks) reads 4.8–5 m. Quays beside sea berths that read 5–10 m are the
 * residual error (a vessel there is drawn a few metres high).
 */
export const INLAND_WATER_MIN_ELEVATION_M = 4.5;

/**
 * How close (m) two terrain cells must read to confirm a water level. The
 * terrain flattens lakes and rivers to within about a metre; one cell lower
 * than the rest (a lock chamber, a hole in the data, the far bank's foot)
 * is not water on its own.
 */
export const INLAND_WATER_AGREE_M = 1;

/**
 * Lowest water level (m above sea level) taken from the terrain: below the
 * Dead Sea, whose surface is about −439 m and falling (older terrain reads it
 * higher). A terrain source that gave sea-floor depths instead of the water's
 * surface cannot put vessels below it; one that gave a flat harbour floor
 * could, which is why the terrain must be the water's surface (Re:Earth's is).
 */
export const INLAND_WATER_LOWEST_M = -450;

/**
 * Highest camera (m) at which the layer asks the terrain for water levels
 * under the vessels in view. Above it a lake's height is invisible, and a
 * continent's worth of cells is not worth fetching.
 */
export const WATER_SURFACE_MAX_CAMERA_HEIGHT_M = 60_000;

/**
 * Smallest radius (km) around the middle of the view whose vessels get their
 * water level: a low, tilted camera sees well past its own height (from 3 km
 * up, ships 15 km away are on screen).
 */
export const WATER_SURFACE_MIN_RADIUS_KM = 30;

/**
 * The radius grows with the camera's height by this factor (a camera 12 km
 * up and tilted shows vessels about 50 km away), up to
 * WATER_SURFACE_MAX_RADIUS_KM.
 */
export const WATER_SURFACE_RADIUS_PER_HEIGHT = 4;

/** Largest radius (km) whose vessels get their water level. */
export const WATER_SURFACE_MAX_RADIUS_KM = 150;

/** Most vessels, nearest first, whose water level one poll asks for. */
export const WATER_SURFACE_MAX_VESSELS = 120;

/**
 * How far ahead (s at its reported speed, up to WATER_SURFACE_AHEAD_MAX_M) a
 * moving vessel's water is asked for, so it stays known as the vessel is
 * drawn along between polls.
 */
export const WATER_SURFACE_AHEAD_S = 120;

/** Longest look ahead (m) along a vessel's course. */
export const WATER_SURFACE_AHEAD_MAX_M = 4000;

/**
 * Terrain cells asked for in one batch: four of the terrain proxy's 64-point
 * requests, sent one after another. A vessel at sea needs one cell; one on
 * raised water needs the 8 around it too.
 */
export const WATER_SURFACE_CELLS_PER_BATCH = 256;

/**
 * Most terrain cells one poll's view asks for (eight requests). Sized against
 * the terrain proxy's limit of 90 requests a minute per client, which aircraft,
 * transit and rail floors share: a poll comes every minute, or when the view
 * moves on, and a view already fetched asks for nothing.
 */
export const WATER_SURFACE_MAX_CELLS_PER_POLL = 512;

/**
 * Most terrain cells the layer fetches in any minute, whatever polls and pans
 * ask for (twelve 64-point requests, about an eighth of a client's 90): a
 * batch past it waits for the minute to free up.
 */
export const WATER_SURFACE_MAX_CELLS_PER_MINUTE = 768;

/**
 * Most trail samples whose own cell the selected vessel's trail asks for,
 * newest first; the vessel's own level stands in for the rest.
 */
export const WATER_SURFACE_TRAIL_CELLS = 128;

/**
 * How far (m) a vessel's last read level stands in over cells not fetched
 * yet. Past it (a clock jump, a long way drawn without a poll) the vessel is
 * on the geoid until its own water is read.
 */
export const WATER_SURFACE_STAND_IN_M = 5000;

/** Combined cap on trail vertices (server backfill + live accumulation). */

export const TRAIL_MAX_POINTS = 400;

/** Minimum movement (m) before a reconcile refresh appends a new trail point. */

export const TRAIL_MIN_MOVE_M = 25;

/** Longest head (m) drawn from the trail's last drawn fix to the vessel: a
 * farther vessel (the clock jumped past the fixes the trail holds) keeps no
 * head until its fixes arrive. */

export const TRAIL_HEAD_MAX_M = 20000;

/** Whether the layer shows the world clock's time instead of the live feed:
 *  its source declares a timeline and the clock is away from live. */
export const followsClock = (vesselState) =>
  vesselState.timeline?.active() === true;

export const DEFAULT_AIS_RUNTIME = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
});

/**
 * Human-readable reasons for a non-'open' AISStream feed status, keyed to the
 * server's `_aisStreamStatus` values (see vite.config.js). Surfaced verbatim in
 * the layer chip so a dead feed reads "feed down" instead of a healthy-looking
 * "just now · 0 vessels".
 */

export const AIS_STATUS_REASON = {
  'missing-key': msg('AISSTREAM_API_KEY not set'),
  unsupported: msg('live feed unsupported'),
  connecting: msg('connecting to feed…'),
  closed: msg('feed disconnected'),
  error: msg('feed down'),
  idle: msg('feed idle'),
};

/**
 * Statuses in which fresh data is flowing. 'open' is the pre-watchdog spelling
 * and is still accepted so a cached bundle and a restarted server never
 * disagree about health.
 */

export const AIS_HEALTHY_STATUSES = new Set(['live', 'open']);

/**
 * Server statuses meaning "the feed is not delivering right now". These are
 * surfaced even while cached vessels are still drawn: rows retained from
 * before the outage must never make a dead feed read as a healthy one.
 */

export const AIS_DEGRADED_STATUSES = new Set([
  'stale',
  'reconnecting',
  'down',
  'auth-failed',
]);
