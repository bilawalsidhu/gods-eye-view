import { FIRMS_AMBIENT_COHORT_LIMIT } from '../../data/firmsLabels.js';
import * as Cesium from 'cesium';

/** Client poll interval; the proxy's 30 min TTL is what guards upstream quota. */

export const REFRESH_INTERVAL_MS = 600_000;

/**
 * LOD bands keyed by camera height. `cells` bands render aggregated
 * ground-clamped heat rectangles; `detections` bands (< ~750km plus the
 * local band) render individual fire detections as glow-sprite icons.
 * Labels in every band go through the shared screen-space greedy declutter
 * (hard cap MAX_AMBIENT_LABELS) — there are no per-band label knobs.
 */

export const LOD_LEVELS = [
  {
    id: 'global',
    minHeight: 9000000,
    mode: 'cells',
    gridDegrees: 2.0,
    maxCells: 1800,
    labelDistance: 12000000,
  },
  {
    id: 'regional',
    minHeight: 3000000,
    mode: 'cells',
    gridDegrees: 1.0,
    maxCells: 3600,
    labelDistance: 8500000,
  },
  {
    id: 'local',
    minHeight: 750000,
    mode: 'detections',
    maxDetections: 2500,
    labelDistance: 4500000,
  },
  {
    id: 'close',
    minHeight: 0,
    mode: 'detections',
    maxDetections: 3000,
    labelDistance: 1800000,
  },
];

export const LOD_CHECK_MS = 650;

/** +/-10% hysteresis on LOD band edges so slow zooms don't thrash rebuilds. */

export const LOD_HYSTERESIS = 0.1;

/** Padding fraction applied to the camera view rectangle before clipping. */

export const VIEW_PADDING = 0.3;

/** Number of top-FRP detections registered in the shared context store. */

export const CONTEXT_TOP_N = 50;

/** Hard cap on ambient (non-selected) labels, regardless of zoom/density. */

export const MAX_AMBIENT_LABELS = FIRMS_AMBIENT_COHORT_LIMIT;

/** Min screen-space separation between accepted labels, in CSS pixels. */

export const LABEL_MIN_SEP_PX = 150;

/** Candidates projecting outside the canvas by more than this are skipped. */

export const LABEL_VIEW_MARGIN_PX = 16;

/**
 * Glow sprites are rasterised once per colour at the largest core size
 * (frpPixelSize tops out at 28 px, a 56 px sprite) and drawn smaller per fire:
 * the gradient stops are relative, so the glow keeps its shape at any size.
 */

export const GLOW_SPRITE_PX = 56;

/** Color stops shared by cell heat fills and detection glow sprites. */

export const DETECTION_COLOR_STOPS = [
  { name: 'red', color: Cesium.Color.RED },
  { name: 'orange', color: Cesium.Color.ORANGE },
  { name: 'yellow', color: Cesium.Color.YELLOW },
];
