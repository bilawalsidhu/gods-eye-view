import { FIRMS_AMBIENT_COHORT_LIMIT } from '../../data/firmsLabels.js';
import * as Cesium from 'cesium';

/** Client poll interval; the proxy's 30 min TTL is what guards upstream quota. */

export const REFRESH_INTERVAL_MS = 600_000;

/**
 * LOD bands keyed by camera height. `cells` bands render aggregated
 * ground-clamped heat rectangles; `detections` bands (< ~750km plus the
 * local band) render individual fire detections as glow-sprite billboards.
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
 * Anchors below this height get a separate LIFTED point for occlusion tests
 * (never for rendering). Mirrors the flights layer's `cullPosition` idiom
 * (`renderAltitudeM < 10` → test at 12 m): `fireAnchorHeight` is ground floor
 * + lift, and in negative-geoid coastal regions that lands a few tens of
 * metres BELOW the WGS84 ellipsoid — EllipsoidalOccluder then judges such a
 * point "beyond the horizon" while its true-surface neighbours stay visible,
 * so near-limb fires would blink out for a datum reason.
 */

export const CULL_LIFT_THRESHOLD_M = 10;

/** Height of the lifted occlusion-test point (flights uses the same 12 m). */

export const CULL_LIFT_M = 12;

/** Color stops shared by cell heat fills and detection glow sprites. */

export const DETECTION_COLOR_STOPS = [
  { name: 'red', color: Cesium.Color.RED },
  { name: 'orange', color: Cesium.Color.ORANGE },
  { name: 'yellow', color: Cesium.Color.YELLOW },
];
