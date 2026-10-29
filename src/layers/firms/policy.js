import { FIRMS_AMBIENT_COHORT_LIMIT } from '../../data/firmsLabels.js';
import { FRP_RAMP } from '../../data/firmsIntensity.js';
import * as Cesium from 'cesium';

/** Client poll interval; the proxy's 30 min TTL is what guards upstream quota. */

export const REFRESH_INTERVAL_MS = 600_000;

/**
 * LOD bands keyed by camera height. `heat` bands (above ~3,000 km) drape a
 * Snap Map–style heatmap over the globe (firmsHeatRaster.js); their
 * `gridDegrees` aggregation only feeds the "N FIRES" cards. `detections`
 * bands render individual fire detections as glow-sprite billboards.
 * Labels in every band go through the shared screen-space greedy declutter
 * (hard cap MAX_AMBIENT_LABELS) — there are no per-band label knobs.
 */

export const LOD_LEVELS = [
  {
    id: 'global',
    minHeight: 9000000,
    mode: 'heat',
    gridDegrees: 2.0,
    maxCells: 1800,
    labelDistance: 12000000,
  },
  {
    id: 'regional',
    minHeight: 3000000,
    mode: 'heat',
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

/**
 * Global heat raster for the `heat` bands: ≈0.18° per pixel, Gaussian σ in
 * pixels. Built once per data refresh or filter change, never per camera move.
 */

export const HEAT_RASTER = Object.freeze({
  width: 2048,
  height: 1024,
  sigmaPx: 3,
});

/**
 * Trailing delay before a stale heatmap is rebuilt while one is already on
 * screen: a slider drag fires many filter changes, and a build plus PNG
 * encode costs a few hundred milliseconds. The first paint is immediate.
 */

export const HEAT_REBUILD_MS = 150;

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

/**
 * Color stops for detection glow sprites and card accents: the
 * six-stop cold → hot FRP ramp (firmsIntensity.js), coldest first, as Cesium
 * colors. Stop names key the glow-sprite cache and the card accents.
 */

export const DETECTION_COLOR_STOPS = FRP_RAMP.map((stop) =>
  Object.freeze({
    name: stop.name,
    minFrp: stop.minFrp,
    color: Cesium.Color.fromCssColorString(stop.hex),
  }),
);
