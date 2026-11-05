import { SONDE_MAX_SERIALS } from './records.js';

export const RADIOSONDE_COLOR = '#ff8fb1';
const landedSymbol = Object.freeze({
  shape: 'ground',
  color: '#b499a2',
  alpha: 0.55,
});
// Bake alpha into cached art shared by the globe and Weather legend.
export const RADIOSONDE_SYMBOLS = Object.freeze({
  ascending: Object.freeze({
    shape: 'balloon',
    color: RADIOSONDE_COLOR,
    alpha: 0.95,
  }),
  descending: Object.freeze({
    shape: 'parachute',
    color: RADIOSONDE_COLOR,
    alpha: 0.95,
  }),
  unknown: Object.freeze({
    shape: 'balloon',
    color: RADIOSONDE_COLOR,
    alpha: 0.75,
  }),
  landed: landedSymbol,
  'landed-inferred': landedSymbol,
  'signal-lost': Object.freeze({
    shape: 'lost-balloon',
    color: '#a2a9b0',
    alpha: 0.55,
  }),
});
export const RADIOSONDE_ALTITUDE_TICKS_M = Object.freeze([
  10_000, 20_000, 30_000,
]);
// Most stations release during the hour preceding each 00/12 UTC observation.
export const RADIOSONDE_LAUNCH_PERIOD_MS = 12 * 60 * 60_000;
export const RADIOSONDE_LAUNCH_WINDOW_MS = 60 * 60_000;
export const RADIOSONDE_DROP_LINE_ALPHA = 0.48;
export const RADIOSONDE_OUTLINE = 'rgba(4,12,16,0.9)';
export const RADIOSONDE_MONO_COLOR = '#FFFFFF';
export const RADIOSONDE_SPRITE_PX = 20;
// Match the aircraft sprite scale so contacts remain legible from orbit.
export const RADIOSONDE_SCALE_BY_DISTANCE = Object.freeze([1000, 3, 8e6, 0.5]);
// Drop lines no longer communicate altitude above this camera height (metres).
export const RADIOSONDE_DROP_LINE_MAX_HEIGHT_M = 3_000_000;
export const RADIOSONDE_DROP_LINE_HYSTERESIS = 0.1;
// One selected path, bounded like transit; horizon sampling includes both ends.
export const RADIOSONDE_TRAIL_MAX_VERTICES = 640;
export const RADIOSONDE_TRAIL_CULL_STRIDE = 32;
// Sub-centimetre edges collapse in Cesium geometry; never stage an empty path.
export const RADIOSONDE_TRAIL_MIN_SEGMENT_M = 0.01;
// The entire retained feed fits within the renderer's population budget.
export const MAX_SONDES_RENDERED = SONDE_MAX_SERIALS;
// More compact labels than a typical viewport can fit; the overlay host owns
// collision/declutter. Bound projection and host work rather than label density.
export const RADIOSONDE_LABEL_CANDIDATE_CAP = 150;
// Historical contacts remain as muted icons in regional/orbital views.
export const RADIOSONDE_TERMINAL_LABEL_MAX_HEIGHT_M = 1_500_000;
// After the first useful data, coalesce pushes to two display batches per second.
export const RADIOSONDE_DATA_BATCH_MS = 500;
// Bound cold-start acquisition even when a server advertises a longer delay.
export const RADIOSONDE_BUILDING_RETRY_MAX_MS = 1000;
// A stuck GPU primitive must not keep a request-render scene awake forever.
export const RADIOSONDE_TRAIL_READY_MAX_CHECKS = 120;
// Backstop for stream gaps and clients without EventSource.
export const RADIOSONDE_UPDATE_INTERVAL_MS = 60_000;
export const STALE_AFTER_MS = 5 * 60_000;
export const RADIOSONDE_STREAM_FRESH_MS = 10_000;
export const LABEL_VIEW_MARGIN_PX = 16;
export const RADIOSONDE_CREDIT = Object.freeze({
  id: 'radiosondes',
  credit: Object.freeze({ html: '© SondeHub contributors (CC BY-SA 2.0)' }),
});
/** Keep drop lines stable near the camera-height cutoff. */
export function dropLinesVisible(heightM, previous) {
  const edge =
    RADIOSONDE_DROP_LINE_MAX_HEIGHT_M *
    (1 + (previous ? 1 : -1) * RADIOSONDE_DROP_LINE_HYSTERESIS);
  return heightM <= edge;
}
