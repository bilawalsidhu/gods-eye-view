import * as Cesium from 'cesium';

/** Shared-host source for the selected vehicle's card. */
export const TRANSIT_SELECTED_OVERLAY_SOURCE_ID = 'transit-selected';
export const TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: true,
});

/** Pick-registry and sprite-order key for this layer. */
export const TRANSIT_LAYER_KEY = 'transit';

// --- Polling / activation ---
/** Poll interval (ms). Also the glide duration between two fixes. */
export const TRANSIT_POLL_MS = 15_000;
/** Camera altitude (m) above which the layer idles: a national fleet still reads at 3,000 km. */
export const ACTIVATION_ALTITUDE_M = 3_000_000;
export const ACTIVATION_ENTER_ALTITUDE_M = ACTIVATION_ALTITUDE_M - 150_000;
export const ACTIVATION_EXIT_ALTITUDE_M = ACTIVATION_ALTITUDE_M + 150_000;
/** Debounce (ms) for camera-change proximity checks. */
export const CAMERA_DEBOUNCE_MS = 340;
/** Extra coverage radius (km) granted to a feed that is already active, so it does not flap at the edge. */
export const RANGE_SLACK_KM = 40;
/** Hard cap on rendered vehicles across all active feeds. */
export const MAX_VEHICLES_TOTAL = 15_000;
/** A vehicle absent from this many consecutive polls is removed. */
export const MISSED_POLLS_TO_DROP = 2;
/** Feed fixes older than this (s) are ignored — a parked bus reporting yesterday's position. */
export const VEHICLE_MAX_AGE_S = 10 * 60;

// --- Ground floor ---
/**
 * Below this camera altitude (m) a vehicle is anchored to the shared ground
 * floor before it is shown; above it a few metres of terrain are invisible
 * and the fleet renders at the ellipsoid, always visible through the mesh.
 */
export const FLOOR_ANCHOR_MAX_ALTITUDE_M = 60_000;
/** Cells warmed per poll; the rest anchor on a later poll. */
export const FLOOR_WARM_PER_POLL = 300;
/** Re-read delay (ms) after warming, and how many re-reads before the next poll takes over. */
export const FLOOR_REREAD_MS = 700;
export const FLOOR_REREAD_ATTEMPTS = 6;

// --- Rendering ---
export const POINT_PIXEL_SIZE = 7;
export const SELECTED_PIXEL_SIZE = 13;
export const POINT_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  20_000,
  1.0,
  2_500_000,
  0.45,
);
export const OUTLINE_COLOR = Cesium.Color.BLACK.withAlpha(0.4);
export const SELECTED_OUTLINE_COLOR = Cesium.Color.CYAN;
/** Mode palette: distinct at a glance, none reused by flights (white/cyan), military (amber), or vessels. */
export const TRANSIT_MODE_COLORS = Object.freeze({
  bus: '#4ade80',
  tram: '#fbbf24',
  subway: '#f87171',
  rail: '#c084fc',
  ferry: '#38bdf8',
  unknown: '#cbd5e1',
});
export const MODE_CESIUM_COLORS = Object.freeze(
  Object.fromEntries(
    Object.entries(TRANSIT_MODE_COLORS).map(([mode, css]) => [
      mode,
      Cesium.Color.fromCssColorString(css).withAlpha(0.95),
    ]),
  ),
);
/** Throttle (ms) for re-anchoring the selected vehicle's card while it glides. */
export const SELECTED_CARD_REFRESH_MS = 250;
