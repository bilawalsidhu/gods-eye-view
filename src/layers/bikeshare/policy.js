import * as Cesium from 'cesium';

export const BIKESHARE_SELECTED_OVERLAY_SOURCE_ID = 'bikeshare-selected';

export const BIKESHARE_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

// --- Activation / display thresholds ---
/** Altitude (m) at which bikeshare layer becomes eligible for display. */

export const ACTIVATION_ALTITUDE_M = 50000;

/** Hysteresis enter threshold — layer activates when camera drops below this. */

export const ACTIVATION_ENTER_ALTITUDE_M = ACTIVATION_ALTITUDE_M - 2000;

/** Hysteresis exit threshold — layer deactivates when camera rises above this. */

export const ACTIVATION_EXIT_ALTITUDE_M = ACTIVATION_ALTITUDE_M + 2000;

/** Debounce interval (ms) for camera-change proximity checks. */

export const CAMERA_DEBOUNCE_MS = 340;

/** Default radius (km) for determining whether a city is in camera range. */

export const CITY_RANGE_BASE_KM = 100;

/** Polling interval (ms) for refreshing station status data. */

export const STATUS_POLL_MS = 60000;

// --- Point rendering constants ---
/** Minimum rendered point size in pixels. */

export const POINT_SIZE_MIN = 4;

/** Maximum rendered point size in pixels. */

export const POINT_SIZE_MAX = 12;

/** Fallback station capacity when real data is unavailable. */

export const DEFAULT_CAPACITY = 15;

/** Vertical offset (m) above terrain for station points. */

export const POINT_HEIGHT_OFFSET_M = 2.0;

/** Hard cap on total rendered station points across all cities. */

export const MAX_TOTAL_POINTS = 8000;

// --- Availability color palette ---
/** Station has >60% bikes available. */

export const COLOR_GREEN =
  Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.95);

/** Station has 30-60% bikes available. */

export const COLOR_YELLOW =
  Cesium.Color.fromCssColorString('#ffaa00').withAlpha(0.94);

/** Station has <30% bikes available. */

export const COLOR_RED =
  Cesium.Color.fromCssColorString('#ff4444').withAlpha(0.94);

/** No status data available for station. */

export const COLOR_NEUTRAL =
  Cesium.Color.fromCssColorString('#91a4b4').withAlpha(0.62);

/** Station is offline (not installed, not renting, or not returning). */

export const COLOR_MUTED =
  Cesium.Color.fromCssColorString('#687581').withAlpha(0.48);

/** Outline color for all station points. */

export const COLOR_OUTLINE = Cesium.Color.BLACK.withAlpha(0.25);
