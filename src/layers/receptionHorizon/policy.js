export const LAYER_ID = 'reception-horizon';
export const LAYER_NAME = 'Reception Horizon';
export const LAYER_SOURCE = 'Your receiver · this session';
export const ENTITY_PREFIX = `${LAYER_ID}:`;

/**
 * Bearing resolution of the horizon: 72 directions around the antenna. Wide
 * enough to fill within minutes of ordinary traffic, narrow enough to show a
 * ridge or a building shadowing the antenna.
 */
export const HORIZON_BIN_DEG = 5;
/** Between neighbouring heard directions the outline is drawn every 1°. */
export const HORIZON_OUTLINE_STEP_DEG = 1;
/**
 * Directions with nothing heard for more than this break the outline, so an
 * unheard sector reads as open rather than bridged by a straight edge.
 */
export const HORIZON_GAP_DEG = 30;
/** A band draws once it has heard this many directions. */
export const HORIZON_MIN_BINS = 3;
/**
 * Farther than any line-of-sight path: a 45,000 ft aircraft and a 1,500 m
 * mountaintop antenna are about 640 km apart at the 4/3-Earth radio horizon.
 * Positions beyond this are counted as implausible and never drawn.
 */
export const HORIZON_MAX_RANGE_KM = 800;
/**
 * Accepted positions kept for rebuilding the horizon when the antenna
 * position arrives or changes. Older positions still count toward the
 * horizon already drawn; they are only lost to a rebuild.
 */
export const HORIZON_FIX_BUFFER = 20_000;
/** The horizon redraws at most this often while positions arrive. */
export const HORIZON_REDRAW_MS = 1_000;
/**
 * Optional display stretch for heights. At true scale the shell is 14 km
 * tall and hundreds of km wide, so its steps read as flat rings.
 */
export const HORIZON_HEIGHT_EXAGGERATION = 10;
/** Antenna moves smaller than this keep the horizon as it is. */
export const HORIZON_ANTENNA_EPSILON_M = 25;

/**
 * Altitude bands, barometric feet. `drawFloorFt`/`drawCeilingFt` are the wall
 * extent on the globe; the open-ended top band draws to 45,000 ft.
 */
export const HORIZON_BANDS = Object.freeze([
  Object.freeze({
    id: 'below-5k',
    label: 'Below 5,000 ft',
    shortLabel: '<5k ft',
    minFt: -Infinity,
    maxFt: 5_000,
    drawFloorFt: 0,
    drawCeilingFt: 5_000,
    color: '#34d399',
  }),
  Object.freeze({
    id: '5k-15k',
    label: '5,000–15,000 ft',
    shortLabel: '5–15k',
    minFt: 5_000,
    maxFt: 15_000,
    drawFloorFt: 5_000,
    drawCeilingFt: 15_000,
    color: '#22d3ee',
  }),
  Object.freeze({
    id: '15k-25k',
    label: '15,000–25,000 ft',
    shortLabel: '15–25k',
    minFt: 15_000,
    maxFt: 25_000,
    drawFloorFt: 15_000,
    drawCeilingFt: 25_000,
    color: '#60a5fa',
  }),
  Object.freeze({
    id: '25k-35k',
    label: '25,000–35,000 ft',
    shortLabel: '25–35k',
    minFt: 25_000,
    maxFt: 35_000,
    drawFloorFt: 25_000,
    drawCeilingFt: 35_000,
    color: '#fbbf24',
  }),
  Object.freeze({
    id: 'above-35k',
    label: '35,000 ft and above',
    shortLabel: '35k+ ft',
    minFt: 35_000,
    maxFt: Infinity,
    drawFloorFt: 35_000,
    drawCeilingFt: 45_000,
    color: '#f97316',
  }),
]);

export const ANTENNA_COLOR = '#ffffff';
export const ANTENNA_SOURCE_LABELS = Object.freeze({
  manual: 'set at view centre',
  feed: 'decoder receiver.json',
  browser: 'browser location (LOCATE)',
});
