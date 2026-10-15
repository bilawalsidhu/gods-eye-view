export const LAYER_ID = 'avalanches';

/** Same-origin proxy (server/providers/avalanches.js). */
export const API_BASE = '/api/avalanches';

/**
 * The European avalanche danger scale, in the EAWS colours every European
 * bulletin uses. Level 0 is Varsom's "no rating" (off-season or no forecast),
 * drawn as nothing rather than as a colour that could read as safe.
 */
export const DANGER_LEVELS = Object.freeze([
  Object.freeze({ level: 0, label: 'No rating', color: null }),
  Object.freeze({ level: 1, label: 'Low', color: '#ccff66' }),
  Object.freeze({ level: 2, label: 'Moderate', color: '#ffff00' }),
  Object.freeze({ level: 3, label: 'Considerable', color: '#ff9900' }),
  Object.freeze({ level: 4, label: 'High', color: '#ff0000' }),
  Object.freeze({ level: 5, label: 'Very high', color: '#7a0000' }),
]);

/** Days of observed history before the anchor day. */
export const PAST_DAYS = 7;

/** Forecast days after the anchor day; Varsom publishes two ahead. */
export const FORECAST_DAYS = 2;

/** Varsom forecasts daily from 1 December to 31 May. */
export const SEASON = Object.freeze({ startMonth: 12, endMonth: 5 });

/** Time one day takes at play speed; the ten-day window plays in ~16 s. */
export const DAY_DURATION_MS = 1600;

/** Share of a day spent blending region colours into the next day's rating. */
export const CROSSFADE_SHARE = 0.5;

/**
 * Share of a day an avalanche takes to run from release to runout on screen.
 * The real event lasts a minute; this is how long the eye needs to see it.
 */
export const RUNOUT_SHARE = 0.35;

/** Days an observed avalanche takes to fade after it happened. */
export const FADE_DAYS = PAST_DAYS;

/** Opacity floor for an old avalanche, so a week of activity stays readable. */
export const FADED_ALPHA = 0.28;

/** Duration of a glide to a clicked day. */
export const SEEK_DURATION_MS = 450;

/** Region fill opacity at full strength. */
export const REGION_ALPHA = 0.42;

/** Avalanche path colour: snow, not a danger colour, so it reads over any fill. */
export const PATH_COLOR = '#e8f4ff';

/** Release-point marker size in pixels by destructive size (unknown = 0). */
export const MARKER_PX = Object.freeze([6, 6, 7, 9, 11, 13]);

/** Path width in pixels by destructive size (unknown = 0). */
export const PATH_WIDTH_PX = Object.freeze([2, 2, 2.5, 3.5, 4.5, 6]);

/** Request deadline and response caps for the browser source. */
export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
