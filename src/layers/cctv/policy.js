export {
  FRAME_ENDPOINT,
  SOURCE_ENDPOINT,
  HEALTH_ENDPOINT,
  MEDIA_ENDPOINT,
  ACTIVE_FRAME_REFRESH_MS,
} from './sourcePolicy.js';
import * as Cesium from 'cesium';
import { CCTV_CARD_FETCH_BURST_SPACING_MS } from '../../data/cctvCards.js';
import { CCTV_AMBIENT_CARD_MAX } from '../../data/cctvLod.js';

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timing and geometry constants
// ---------------------------------------------------------------------------

export const DEFAULT_UPDATE_INTERVAL_MS = 10000;

export const MIN_AUTO_HOP_SEC = 8;

export const MAX_AUTO_HOP_SEC = 90;

export const HEALTH_SYNC_INTERVAL_MS = 7000;

export const IDLE_FRAME_REFRESH_MS = 60000;

export const PROJECTION_ACTIVE_REFRESH_MS = 10000;

export const PROJECTION_IDLE_REFRESH_MS = 60000;

export const PROJECTION_CANVAS_WIDTH = 1920;

export const PROJECTION_CANVAS_HEIGHT = 1080;

// Downsample grid for the unchanged-frame signature (drawProjectionFrame).
// 64x36 keeps the 16:9 aspect and reads ~9 KB per check versus the 8.3 MB a
// full-resolution compare would touch.

export const FRAME_SIGNATURE_W = 64;

export const FRAME_SIGNATURE_H = 36;

export const COVERAGE_NEIGHBOR_LIMIT = 14;

export const COVERAGE_NEIGHBOR_RADIUS_KM = 1.8;

// Staggered geometry/frame loading: ground-sampled coverage geometry is
// refined in small batches (active camera first, then nearest-to-viewer) so
// enabling the layer never raycasts every camera in a single frame.

export const GEO_LOAD_BATCH_SIZE = 4;

export const GEO_LOAD_BATCH_DELAY_MS = 120;

export const GEO_TRACKING_BATCH_SIZE = 2;

export const GEO_TRACKING_BATCH_DELAY_MS = 250;

export const GEO_PROGRESS_NOTIFY_INTERVAL_MS = 300;

export const GEO_PROGRESS_NOTIFY_BATCH_LIMIT = 10;

// Throttle for placeholder repaints — the projection RAF loop must not
// re-fill a 1080p canvas on every frame while a feed image is still loading.

export const PLACEHOLDER_REPAINT_MS = 750;

// v1 key is retired dead data (owner decision #3, §9.3 — WIPE CLEAN, no
// legacy import): kept here only as a documented constant so nothing ever
// re-reads it by accident. Exported for the unit suite's "v1 is ignored"
// assertion; there is NO read path for this key anywhere in the module.

export const CCTV_CALIBRATION_STORAGE_KEY_V1 =
  'godsEyeView.cctv.calibration.v1';

/** v2 store key. Entries: { values: <7-field calibration offsets>, source: 'manual', savedAt: <epoch ms> }. */

export const CCTV_CALIBRATION_STORAGE_KEY_V2 =
  'godsEyeView.cctv.calibration.v2';

// H5: throttle for double-buffered canvas texture swaps (<=1Hz; each swap is a
// full 1080p texture re-upload because Cesium re-uploads only on a NEW image
// object reference).

export const PROJECTION_TEXTURE_SWAP_MS = 1000;

export const PROJECTION_VERT_ASPECT =
  PROJECTION_CANVAS_WIDTH / PROJECTION_CANVAS_HEIGHT;

// V2 frustum geometry (design §2a/§6): the far-cap center + corners never sink
// below groundAlt + this clearance, so a fabricated pitch (-24°) cannot bury
// the monitor plane in the 3D tiles. Exported for the unit suite.

export const FRUSTUM_GROUND_CLEARANCE_M = 2;
/**
 * Most the footprint clearance may lift a monitor plane beyond what the
 * ground at its own mount requires (metres). A plane whose far edge crosses
 * a tall building would otherwise float hundreds of metres up to "clear" it;
 * past this the plane accepts the intersection instead of leaving the scene.
 */
export const PLANE_FOOTPRINT_LIFT_CAP_M = 60;
/** Client range floor the pose model and catalog agree on (metres). */
export const CALIBRATION_RANGE_FLOOR_M = 120;
/** The floor saved v2 calibrations were authored against before 2026-09-13. */
export const LEGACY_CALIBRATION_RANGE_FLOOR_M = 220;

/** Public result codes for explicit CCTV camera flights. */

export const CCTV_FOCUS_RESULT = Object.freeze({
  FOCUSED: 'focused',
  NO_ACTIVE_CAMERA: 'no-active-camera',
  TRACKING_HOLDS_VIEW: 'tracking-holds-view',
  COCKPIT_ACTIVE: 'cockpit-active',
});

// §9.1 activation obstruction probe: clamp the plane's effective range to just
// short of the first pickFromRay hit along the frustum axis, with a floor so a
// point-blank obstruction never collapses the frustum to zero. The floor is
// the old H6 monitor's 8-15 m distance band: small enough that a pitched-down
// camera whose axis meets the street ~25 m out still clamps SHORT of the hit
// (a larger floor would push the plane back through the obstruction).

export const PROBE_CLEARANCE_M = 4;

export const PROBE_MIN_RANGE_M = 12;

// Bounded wait for the enable-time ground-prior batch: warm proxy disk cache
// resolves in milliseconds; a cold/slow upstream must never hang layer init,
// so past this budget init proceeds on catalog fallbacks and the batch applies
// post-hoc (applyLateGroundPriors) when it lands.

export const GROUND_PRIOR_INIT_WAIT_MS = 8000;

/** Default calibration offsets — all zeroed, range scale 1x. */

export const DEFAULT_CAMERA_CALIBRATION = Object.freeze({
  offsetNorthM: 0,
  offsetEastM: 0,
  headingDeg: 0,
  pitchDeg: 0,
  fovDeg: 0,
  rangeScale: 1,
  heightM: 0,
});

/** Base64-encoded SVG camera icon for billboard rendering. */

export const CAMERA_ICON = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <defs>
      <linearGradient id="lens" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#c9f6ff"/>
        <stop offset="45%" stop-color="#6fd9ff"/>
        <stop offset="100%" stop-color="#1a5f78"/>
      </linearGradient>
    </defs>
    <g transform="translate(4 6)">
      <rect x="0" y="8" width="20" height="9" rx="2.5" fill="#0e1720" stroke="#75e7ff" stroke-width="1.2"/>
      <rect x="17" y="10" width="10" height="5" rx="1.5" fill="#132433" stroke="#75e7ff" stroke-width="1"/>
      <circle cx="24" cy="12.5" r="3.1" fill="url(#lens)" stroke="#dbfbff" stroke-width="0.8"/>
      <rect x="6.4" y="17" width="4.2" height="8.5" rx="1.2" fill="#10212d" stroke="#75e7ff" stroke-width="1"/>
      <rect x="4.2" y="24" width="8.6" height="2.5" rx="1.1" fill="#0b151d" stroke="#4ecde7" stroke-width="0.8"/>
    </g>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
})();

/**
 * Seed camera definitions used when no live sources are available.
 * Each seed references a city from CITY_POIS and a POI index within that city,
 * plus offsets to place the camera near the POI.
 */

export const CAMERA_SEEDS = [
  {
    id: 'nyc-midtown-w',
    cityId: 'nyc',
    poiIndex: 1,
    label: 'Midtown West @ 34th',
    offsetNorthM: 120,
    offsetEastM: -70,
    headingDeg: 206,
    fovDeg: 74,
    rangeM: 880,
    elevationM: 26,
  },
  {
    id: 'nyc-wtc-n',
    cityId: 'nyc',
    poiIndex: 2,
    label: 'WTC North Plaza',
    offsetNorthM: 95,
    offsetEastM: 34,
    headingDeg: 164,
    fovDeg: 68,
    rangeM: 760,
    elevationM: 32,
  },
  {
    id: 'nyc-times-square-ne',
    cityId: 'nyc',
    poiIndex: 1,
    label: 'Times Sq Northeast',
    offsetNorthM: 230,
    offsetEastM: 120,
    headingDeg: 218,
    fovDeg: 66,
    rangeM: 640,
    elevationM: 24,
  },

  {
    id: 'sf-market-5th',
    cityId: 'sf',
    poiIndex: 2,
    label: 'Market & 5th',
    offsetNorthM: -160,
    offsetEastM: 80,
    headingDeg: 320,
    fovDeg: 70,
    rangeM: 780,
    elevationM: 20,
  },
  {
    id: 'sf-financial-district',
    cityId: 'sf',
    poiIndex: 1,
    label: 'SF Financial Core',
    offsetNorthM: 110,
    offsetEastM: 52,
    headingDeg: 205,
    fovDeg: 72,
    rangeM: 760,
    elevationM: 24,
  },

  {
    id: 'tokyo-shibuya-scramble',
    cityId: 'tokyo',
    poiIndex: 4,
    label: 'Shibuya Crossing',
    offsetNorthM: 180,
    offsetEastM: 46,
    headingDeg: 18,
    fovDeg: 82,
    rangeM: 640,
    elevationM: 30,
  },
  {
    id: 'tokyo-ginza-core',
    cityId: 'tokyo',
    poiIndex: 0,
    label: 'Ginza Core',
    offsetNorthM: -180,
    offsetEastM: 150,
    headingDeg: 245,
    fovDeg: 70,
    rangeM: 690,
    elevationM: 28,
  },
  {
    id: 'tokyo-asakusa-n',
    cityId: 'tokyo',
    poiIndex: 3,
    label: 'Asakusa North Gate',
    offsetNorthM: 110,
    offsetEastM: -65,
    headingDeg: 192,
    fovDeg: 68,
    rangeM: 620,
    elevationM: 24,
  },

  {
    id: 'london-city-a1',
    cityId: 'london',
    poiIndex: 4,
    label: 'City Cluster A1',
    offsetNorthM: 80,
    offsetEastM: 65,
    headingDeg: 220,
    fovDeg: 71,
    rangeM: 720,
    elevationM: 27,
  },
  {
    id: 'london-soho-core',
    cityId: 'london',
    poiIndex: 2,
    label: 'Soho Core',
    offsetNorthM: 210,
    offsetEastM: 120,
    headingDeg: 206,
    fovDeg: 70,
    rangeM: 700,
    elevationM: 22,
  },

  {
    id: 'paris-rivoli',
    cityId: 'paris',
    poiIndex: 4,
    label: 'Rue de Rivoli',
    offsetNorthM: 55,
    offsetEastM: 85,
    headingDeg: 248,
    fovDeg: 66,
    rangeM: 640,
    elevationM: 22,
  },
  {
    id: 'paris-champs-n',
    cityId: 'paris',
    poiIndex: 1,
    label: 'Champs-Élysées North',
    offsetNorthM: 130,
    offsetEastM: -38,
    headingDeg: 175,
    fovDeg: 68,
    rangeM: 700,
    elevationM: 26,
  },

  {
    id: 'dc-mall-center',
    cityId: 'dc',
    poiIndex: 1,
    label: 'National Mall Center',
    offsetNorthM: 120,
    offsetEastM: 20,
    headingDeg: 258,
    fovDeg: 78,
    rangeM: 940,
    elevationM: 24,
  },
  {
    id: 'dc-pentagon-s',
    cityId: 'dc',
    poiIndex: 3,
    label: 'Pentagon South',
    offsetNorthM: -100,
    offsetEastM: 92,
    headingDeg: 14,
    fovDeg: 66,
    rangeM: 620,
    elevationM: 21,
  },

  {
    id: 'dubai-difc-loop',
    cityId: 'dubai',
    poiIndex: 4,
    label: 'DIFC Loop',
    offsetNorthM: 92,
    offsetEastM: -45,
    headingDeg: 196,
    fovDeg: 70,
    rangeM: 720,
    elevationM: 26,
  },
  {
    id: 'dubai-downtown-east',
    cityId: 'dubai',
    poiIndex: 0,
    label: 'Downtown East',
    offsetNorthM: -130,
    offsetEastM: 190,
    headingDeg: 322,
    fovDeg: 72,
    rangeM: 760,
    elevationM: 28,
  },

  {
    id: 'austin-congress-s',
    cityId: 'austin',
    poiIndex: 0,
    label: 'Congress Southbound',
    offsetNorthM: -165,
    offsetEastM: 40,
    headingDeg: 12,
    fovDeg: 74,
    rangeM: 760,
    elevationM: 24,
  },
  {
    id: 'austin-downtown-west',
    cityId: 'austin',
    poiIndex: 1,
    label: 'Downtown West',
    offsetNorthM: -120,
    offsetEastM: -160,
    headingDeg: 120,
    fovDeg: 69,
    rangeM: 700,
    elevationM: 20,
  },
];

// ---------------------------------------------------------------------------
// Visual style constants
// ---------------------------------------------------------------------------

export const IDLE_CAMERA_COLOR =
  Cesium.Color.fromCssColorString('#6be8ff').withAlpha(0.88);

export const ACTIVE_CAMERA_COLOR =
  Cesium.Color.fromCssColorString('#ffd97a').withAlpha(0.95);

export const IDLE_COVERAGE_COLOR =
  Cesium.Color.fromCssColorString('#2fe0ff').withAlpha(0.24);

export const IDLE_COVERAGE_CENTER_MUTED =
  Cesium.Color.fromCssColorString('#2fe0ff').withAlpha(0.2);

export const IDLE_COVERAGE_EDGE_MUTED =
  Cesium.Color.fromCssColorString('#2fe0ff').withAlpha(0.18);

export const ACTIVE_COVERAGE_EDGE =
  Cesium.Color.fromCssColorString('#8dff87').withAlpha(0.58);

export const ACTIVE_COVERAGE_CENTER =
  Cesium.Color.fromCssColorString('#d7ff8d').withAlpha(0.82);

// H6: dimmer depth-fail materials let the active frustum wireframe read
// through buildings while in monitor fallback mode.

export const ACTIVE_COVERAGE_EDGE_DEPTHFAIL =
  Cesium.Color.fromCssColorString('#8dff87').withAlpha(0.18);

export const ACTIVE_COVERAGE_CENTER_DEPTHFAIL =
  Cesium.Color.fromCssColorString('#d7ff8d').withAlpha(0.26);

export const PLANE_OUTLINE_COLOR =
  Cesium.Color.fromCssColorString('#6be8ff').withAlpha(0.55);

/**
 * Card budget while the staggered geometry drain is running — the raised
 * 20/28/40 tiers resume when loading completes (see refreshAmbientCards).
 */

export const CCTV_AMBIENT_CARD_DRAIN_CAP = 16;

// Global static-frame pacing (owner finding 3): the pacer ticks at the burst
// spacing (250 ms) but cardFetchPolicy gates launches — cold fill (selected
// cards still missing their FIRST frame) allows up to 4 in-flight fetches at
// 250 ms spacing; steady state keeps the salvaged Part C gate of at most one
// request per second with an in-flight fetch blocking the tick, so slow
// responses only lower the rate.

export const CARD_FETCH_TICK_MS = CCTV_CARD_FETCH_BURST_SPACING_MS;

// In-view margin so cards whose anchors sit just beyond an edge don't churn
// while the operator makes minor camera adjustments (Part C recordIsInView).

export const CARD_VIEW_MARGIN = 0.06;

/** Card leader gap: clears the 24px icon (12px half + breathing room). */

export const CARD_GAP_PX = 16;

export const CCTV_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: CCTV_AMBIENT_CARD_MAX,
  collisionCapacity: CCTV_AMBIENT_CARD_MAX,
  moving: true,
  solveIntervalMs: 125,
});

export const CCTV_PROJECTION_OVERLAY_SOURCE_ID = 'cctv-projection';

export const CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

// Hover-summoned card (owner round 2, item B): pointing at a cardless camera
// icon shows its card immediately as a PINNED entry (budget-exempt, top
// draw-pass declutter priority).
/** Min spacing between hover scene.pick calls (event-driven, user gesture). */

export const HOVER_PICK_THROTTLE_MS = 120;

/** How long the hover card lingers after the pointer leaves the icon. */

export const HOVER_RELEASE_MS = 1_000;
