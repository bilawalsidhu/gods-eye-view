import { VESSEL_LABEL_GRID_PX } from '../../data/vesselLabels.js';

export const FOCUS_EVIDENCE_DEV = import.meta.env?.DEV === true;

export const DEFAULT_RENDER_ROWS = 12000;

export const DEFAULT_ACTIVE_LABELS = 900;

export const REFRESH_MS = 60000;

/** Bounded wait for the first accepted vessel position in one enabled session. */

export const AIS_FIRST_CONNECT_GRACE_MS = 30000;

export const AIS_FIRST_CONNECT_LABEL = 'awaiting first AIS position…';

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

/** Number of consecutive refreshes a selected-but-vanished vessel is retained. */

export const SELECTED_PIN_REFRESHES = 3;

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

/** Combined cap on trail vertices (server backfill + live accumulation). */

export const TRAIL_MAX_POINTS = 400;

/** Minimum movement (m) before a reconcile refresh appends a new trail point. */

export const TRAIL_MIN_MOVE_M = 25;

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
  'missing-key': 'AISSTREAM_API_KEY not set',
  unsupported: 'live feed unsupported',
  connecting: 'connecting to feed…',
  closed: 'feed disconnected',
  error: 'feed down',
  idle: 'feed idle',
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

/** Missing records in an incomplete observation are retained for at most five minutes. */
export const PARTIAL_RETENTION_MS = 5 * 60 * 1000;
