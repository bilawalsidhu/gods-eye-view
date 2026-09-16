/**
 * @file Live intercity trains layer.
 *
 * Data source: Amtrak's live GPS positions via the Amtraker community API
 * (https://amtraker.com — keyless, CORS-open JSON refreshed about once a
 * minute upstream). Positions are the operator's own telemetry; the
 * community service only relays and decodes it. This is vehicle telemetry
 * for public transportation, not passenger data — trains, never people.
 *
 * @module data/liveTrains
 */

export const LAYER_ID = 'live-trains';

export const TRAINS_API_URL = 'https://api.amtraker.com/v3/trains';

/** Amtrak GPS updates land upstream every minute or two; poll to match. */
export const UPDATE_INTERVAL_MS = 60000;

/** Render cap — the national fleet is ~200-400 active trains, so this is
 * headroom, not a filter; it only guards against a malformed giant payload. */
export const MAX_RENDERED = 600;

/** Neutral badge color when a train reports no timeliness color of its own. */
export const TRAIN_COLOR = '#52d4ff';

/** Labels stay legible: shown from street level out to regional views. */
export const LABEL_MAX_DISTANCE_M = 2_500_000;

/** Milliseconds a dot may dead-reckon past its latest GPS fix before it
 * rests. Amtrak fixes land every one to five minutes; two minutes of
 * carry-forward keeps the fleet visibly moving without letting a stale
 * train wander far from where it was last actually seen. */
export const TRAIN_EXTRAPOLATION_MAX_MS = 120000;
