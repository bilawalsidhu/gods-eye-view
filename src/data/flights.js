/**
 * @module flights
 * @description Real-time flight tracking layer powered by the OpenSky Network API
 * (authenticated via Vite dev-server proxy at /api/opensky).
 *
 * Rendering strategy: all aircraft are drawn as billboards in a single
 * BillboardCollection for GPU-efficient batching (handles 5000+ aircraft).
 * Each billboard's alignedAxis is set to the WGS84 ellipsoid surface normal
 * so that the rotation value (derived from true_track heading) operates in
 * the local tangent plane (0 deg = north, 90 deg = east).
 *
 * Click-to-track: clicking a billboard creates a tracked Entity whose
 * position is driven by a dead-reckoning CallbackProperty.  Between API
 * refreshes (every ~10-30 s) the aircraft advances smoothly using ENU frame
 * math.  When a new API fix arrives, a 1-second lerp blends the current
 * dead-reckoned position into the corrected fix to avoid visual snapping.
 *
 * Press Escape or click empty space to deselect a tracked flight — the camera
 * is released IN PLACE (no flyTo), so the user keeps the context they were
 * looking at (product rule 2026-07-02).
 */
import * as Cesium from 'cesium';
import { aircraftIncludedInNearby } from './aircraftNearbyPolicy.js';
import { logDebug, logWarn } from '../logger.js';
import { readLocalCache, trimLocalCache, writeLocalCache } from './localCache.js';
import { reverseGeocodePlace } from './openzenith.js';
import { registerPickOwner, unregisterPickOwner, isOwnedByOtherLayer, resolvePickId } from './pickRegistry.js';
import {
  registerSpriteCollection,
  restoreSpriteOrder,
  restoreSpriteOrderOnEnable,
} from './spriteOrder.js';
import {
  bindTrackingClickGesture,
  domEventPressClock,
  isTrackingClickGesture,
  isTrackingSelectionGesture,
} from './trackingClickGesture.js';
import { createTrail } from './trailRenderer.js';
import { isExplicitLayerStateOrigin } from './layerState.js';
import {
  screenProjectedRotation,
  stabilizeScreenRotation,
  horizonOccluder,
  cameraPoseSignature,
} from './iconOrientation.js';
import { stickyText, stickyNumber } from './aircraftMeta.js';
import { classifyAircraft, CLASS_SCALE_2D, CLASS_SCALE_3D, CLASS_MODEL_URL, CLASS_MODEL_REAL } from './aircraftClass.js';
import { modelVisualAnchor, trailAnchorForModel, trailHeadStart, visualCenterForModel } from './modelVisualAnchor.js';
import { aircraftIcon, TRACKED_ICON_PX } from './aircraftIcons.js';
import {
  isTr3b, tr3bAircraftClass, tr3bTypeLabel,
} from './tr3bRegistry.js';
import {
  applyTrackedCameraFrame,
  trackedModelScaleForPixelCap,
} from './trackedCamera.js';
import {
  courseBetweenCartesians, limitCourseStep, turnRateFromFixHistory,
  lerpAngleDeg, speedRamp, courseSlewCapDps, displayedKinematics, staleCoastLimitSeconds,
  liftRepeatedGroundFix, synthesizeForwardKinematicsFix, corridorPathLatLon,
  COURSE_HOLD_SPEED_MPS,
} from './motionModel.js';
import { routePlausible } from './routePlausible.js';
import { isMilitaryIcao, isMilitaryLayerActive, refreshMilitaryRegistryIfStale, onMilitaryLayerActiveChange } from './militaryRegistry.js';
import { formatFlightLevel } from './detectionDraw.js';
import { geoidSurfaceLastResortM, pickRenderAltitudeM } from './renderAltitude.js';
import { allocateCorridorCells, cachedGroundFloor, coarseFloorCoord, corridorFloorCells, displayFloorHeightM, floorAltitudeM, neighborFloorM, stickyFloorCell, warmGroundFloor, resolveGroundFloorCellsBounded, GROUND_FLOOR_LIFT_M } from './groundFloor.js';
import { sampleMeshFloorCells } from './meshFloorSampler.js';
import { ensureGeoidReady, geoidHeight } from './geoid.js';
import {
  advanceFocusEvidenceNowMs,
  advanceProjectedSpriteFocus,
  clearFocusTarget,
  focusNowMs,
  getFocusDeemphasisParams,
  getFocusTarget,
  nearFarScalarValueAtDistance,
  publishFocusTargetFromCachedPosition,
  setFocusEvidenceNowMs,
  setFocusDeemphasisParams,
} from './focusDeemphasis.js';
import {
  applyAircraftBillboardTreatment,
  applyAircraftModelTreatment,
  getAircraftRecessionParams,
  setAircraftRecessionParams,
} from './aircraftRecession.js';
import { refreshTrackedReadout, trackedLabelModelFromText } from './trackedReadout.js';
import {
  clearTrackedSubjectContext,
  selectTrackedSubjectContext,
} from './contextStore.js';
import { CONTACT_MATCH_TIER, contactMatchWins, rankContactMatch } from './contactMatch.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';

const FOCUS_EVIDENCE_DEV = import.meta.env?.DEV === true;

/** Amber tint for known-military aircraft rendered by this layer (matches the military layer's icon color). */
const MIL_TINT = Cesium.Color.fromCssColorString('#FFB800');

/** Close-range cockpit civilian billboard tint (matches the HUD accent). */
const COCKPIT_CIVILIAN_COLOR = Cesium.Color.fromCssColorString('#DCEEFF');

// --- Ground traffic (product change 2026-07-03: "absolutely we should see planes
// taxiing and landing") -----------------------------------------------------------
// Present-but-grounded planes are RENDERED instead of being skipped: same class
// silhouette + rotation pipeline, clickable/trackable/detectable, sticky metadata
// updating normally. Landing/takeoff is a TRANSITION — the on_ground flip restyles
// the existing billboard in place, never a removal. Ground planes draw no trails
// and are excluded from the ambient enrichment sweep (click-to-enrich still
// works). In 3D mode they take model slots like airborne planes (product rule
// 2026-07-03 — no air/ground distinction), placed by the one-shot ground snap
// (see p._modelDisplayPosition).
//
// TINT: full-strength, same pipeline as airborne (white / amber-military /
// cyan-tracked). Day 1 shipped a slate-gray 50%-alpha "muted" ground tint; the
// owner killed it the same day ("just leave them as white, dude … in NYC I can
// barely see them, extremely grayed out"). "On the ground" reads from the ×0.8
// scale + missing trail; "feed-dropped, coasting" stays the 45%-alpha stale
// fade — a full-alpha ground icon can never be confused with it.
/** Ground billboards render slightly smaller so airport clutter stays visually minor. */
const GROUND_SCALE = 0.8;

/** Fleet (untracked) billboard tint: amber for known-military, white otherwise.
 *  Ground traffic gets NO special tint (validated behavior 2026-07-03 field test). */
function _fleetBillboardColor(icao24) {
  return isMilitaryIcao(icao24) ? MIL_TINT : Cesium.Color.WHITE;
}

/** Fleet billboard scale: per-class scale, ×GROUND_SCALE while grounded. */
function _fleetBillboardScale(icao24, klass) {
  return (CLASS_SCALE_2D[klass] || 1) * (p._flightData.get(icao24)?.onGround ? GROUND_SCALE : 1);
}

/** Cockpit-dot freshness tint: registry-driven (amber military / civilian accent). */
function _fleetFreshnessColor(icao24, alpha) {
  return (isMilitaryIcao(icao24) ? MIL_TINT : COCKPIT_CIVILIAN_COLOR).withAlpha(alpha);
}

/** INFO-record kinematics fallbacks (OpenSky/adsb.lol field names). */
function _infoSpeed(info) {
  return info && info.velocity;
}
function _infoHeading(info) {
  return info && info.true_track;
}


// --- 3D model rendering (B3) ---------------------------------------------------------
// When enabled, aircraft render as 3D glTF models once the camera is below p.MODEL_ALT_CEIL_M
// (zoomed in); higher up they stay flat billboards. Eligibility is FRUSTUM-based (on-screen), and
// the slots go to either the nearest planes ('proximity') or every in-view plane ('all'), each
// backed by a hard cap so a draw-call explosion can't tank the frame (no instancing yet).
const PLANE_MODEL_URL = '/models/airplane.glb';
export const TRACKED_MODEL_MAX_PX = 200; // selected close-range tracked-target feel
const MODEL_NATIVE_RADIUS_M = 34.41;
const MODEL_SCALE = 1;          // airplane.glb is transform-applied and baked to real-world meters
// Per-mode caps. Each model is its own draw call (no instancing yet), so these bound the frame cost.
const MODEL_MAX = 150;          // 'proximity' cap (the planes immediately around you)
const MODEL_MAX_ALL = 350;      // 'all' cap (everything out to ~the horizon)

const COCKPIT_MODEL_MAX = 60;         // max concurrent GLBs in cockpit (never raises the map cap)
const MODEL_HEADING_OFFSET_DEG = 180; // airplane.glb nose is opposite Cesium heading-0
// Owner launch-polish direction: models should read as clean light silhouettes,
// with only a weak diffuse contribution from the existing approved textures.
const MODEL_COLOR_BLEND_AMOUNT = 0.94;
// Grounded-model belly offset: airplane.glb's centred origin sits 6.719 m ABOVE its
// lowest vertex (glTF Y-up scene AABB with node transforms applied — same reader as
// modelScale.test.mjs, measured after its 24× transform bake). × class multiplier ≈ 5.0–9.7 m
// of lift, so a ground-snapped model rests its lowest geometry (gear/belly) ON the sampled
// tile skin instead of sinking to the fuselage-centerline origin. Locked against the GLB
// by modelScale.test.mjs.
const MODEL_BELLY_OFFSET_NATIVE = 6.719;
/** Per-class model spec. Hangar-fleet classes (CLASS_MODEL_REAL) ship GLBs
 *  vertex-baked to real-world METERS in the airplane.glb axis convention, so
 *  they render at scale 1 with their own measured belly lift and bounding
 *  radius. Every other class keeps the shared-airplane.glb formula
 *  (MODEL_SCALE × CLASS_SCALE_3D). nativeRadiusM is PER SCALE UNIT — pixel-cap
 *  math multiplies it by `scale`, so world radius = nativeRadiusM × scale in
 *  both branches. The code-side MIX tint dominates every existing asset so
 *  class silhouettes stay light without modifying third-party GLBs/textures. */
/*  Specs are static per class, and the detection weld now asks for one per
 *  MODELED contact per frame (up to the fleet cap) on top of the 12 Hz fleet
 *  pass — so this is memoized, as militaryFlights.js already does. */
const _specCache = new Map();
function _modelSpec(klass) {
  const cached = _specCache.get(klass);
  if (cached) return cached;
  const real = CLASS_MODEL_REAL[klass];
  let spec;
  if (real) {
    spec = {
      url: real.url,
      scale: 1,
      nativeRadiusM: real.radiusM,
      bellyM: real.bellyM,
      blendAmount: MODEL_COLOR_BLEND_AMOUNT,
      visualCenterNative: visualCenterForModel(real.url),
      trailAnchorNative: trailAnchorForModel(real.url),
    };
  } else {
    const scale = MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
    const url = CLASS_MODEL_URL[klass] || PLANE_MODEL_URL;
    spec = {
      url,
      scale,
      nativeRadiusM: MODEL_NATIVE_RADIUS_M,
      bellyM: MODEL_BELLY_OFFSET_NATIVE * scale,
      blendAmount: MODEL_COLOR_BLEND_AMOUNT,
      visualCenterNative: visualCenterForModel(url),
      trailAnchorNative: trailAnchorForModel(url),
    };
  }
  _specCache.set(klass, spec);
  return spec;
}
let _lastModelCapWarnMs = 0; // throttle the "more planes in view than the cap" console notice
/** @type {Cesium.Model|null} retained preload that keeps the glTF cache warm */
let _preloadModel = null;
const CYAN_TRANSPARENT = Cesium.Color.CYAN.withAlpha(0);
const _scratchModelHpr = new Cesium.HeadingPitchRoll(0, 0, 0);
const _scratchModelMtx = new Cesium.Matrix4();
const _scratchModelBS = new Cesium.BoundingSphere(new Cesium.Cartesian3(), 1.0); // frustum-visibility test

import { api, apiEndpoints } from '../config/apiEndpoints.js';
import { createFlightTrackingPipeline } from './flightsTracking.js';

// Batch 5 item 2 (sub-unit a): the shared tracking/DR/billboard/cockpit/trail
// pipeline lives in flightsTracking.js; `p` is this layer's private instance.
const p = createFlightTrackingPipeline({
  modelSpec: _modelSpec,
  refreshTr3bContact: _refreshTr3bContact,
  clearTracking: _clearTracking,
  trackFlight: _trackFlight,
  updateTrackedModel: _updateTrackedModel,
  contextSubjectMetadata: _contextSubjectMetadata,
  fleetBillboardColor: _fleetBillboardColor,
  fleetBillboardScale: _fleetBillboardScale,
  modelCap: _modelCap,
  modelColor: _modelColor,
  modelMatrix: _modelMatrix,
  normalBillboardScaleByDistance: _normalBillboardScaleByDistance,
  refreshTrailDisplay: _refreshTrailDisplay,
  requestTypeEnrichment: _requestTypeEnrichment,
  trackedLabelText: _trackedLabelText,
  fleetFreshnessColor: _fleetFreshnessColor,
  infoSpeed: _infoSpeed,
  infoHeading: _infoHeading,
  trackedModelMaxPx: TRACKED_MODEL_MAX_PX,
  trackedFocusScaleBase: 1,
  trackedLabelAccent: '#39d0ff',
  unmodeledTrackedColor: CYAN_TRANSPARENT,
  modeledIconColor: Cesium.Color.CYAN,
});


/** @constant {string} API_URL - OpenSky aircraft state vectors */
const API_URL = apiEndpoints.opensky;
const SOURCE_STALE_MS = 120_000;
/** @constant {number} BACKOFF_INTERVAL - Cooldown (ms) after 429 / auth errors */
const BACKOFF_INTERVAL = 45000; // 45s on rate limit
/** @constant {number} ERROR_BACKOFF_INTERVAL - Cooldown (ms) after transient errors */
const ERROR_BACKOFF_INTERVAL = 20000; // transient error retry
/** Adaptive refresh: altitude bands drive poll rate. Street-level = faster updates. */
const FLIGHT_REFRESH_MS = {
  street:   15_000,  // < 50km   — 15s (close aircraft move fast)
  city:     20_000,  // < 150km  — 20s
  regional: 30_000,  // < 500km  — 30s
  global:   45_000,  // default  — 45s
};
const FLIGHT_REFRESH_ALT_THRESHOLDS = {
  street:   50_000,
  city:    150_000,
  regional: 500_000,
};
/** @constant {number} POSITION_HISTORY_LIMIT - Max position samples kept per aircraft for dead reckoning */
const POSITION_HISTORY_LIMIT = 5; // keep last N positions per aircraft

// ---------------------------------------------------------------------------
// Module-level state: billboard collection and per-aircraft lookup maps
// ---------------------------------------------------------------------------

/** Stable lightweight records reused by the detection overlay between polls. */
let _detectionObjects = new Map();
/** DEV-only explicit-position contacts used by qa-focus-evidence.mjs. */
const _focusEvidenceIds = new Set();
/** @type {boolean} True once ensureGeoidReady() has resolved (awaited once at enable()) */
let _geoidReady = false;
/** @type {Map<string, number>} icao24 -> geoid undulation N (m), cached (negligible drift per-aircraft). */
const _geoidNCache = new Map();
/** @type {number} Current number of visible aircraft */
let _count = 0;
/** @type {number|null} Epoch ms of last successful API update */
let _lastUpdate = null;
/** @type {boolean} True while in a backoff/cooldown window */
let _backoff = false;
/** @type {number} Epoch ms — earliest time the next fetch is allowed */
let _retryAt = 0;
/** @type {string|null} Human-readable error string shown in stats chip */
let _lastError = null;

/** @type {number|null} HTTP status of the most recent API response */
let _lastStatus = null;
/** @type {string} Source used by the latest successful snapshot. */
let _lastSource = 'OpenSky Network';
/** @type {string} Completeness boundary for the latest successful snapshot. */
let _lastCoverage = 'worldwide upstream snapshot';

/**
 * Get the adaptive refresh interval (ms) for the current camera altitude.
 * Street-level zoom = faster updates.
 */
function _flightRefreshIntervalForAltitude(altitudeM) {
  if (altitudeM < FLIGHT_REFRESH_ALT_THRESHOLDS.street)   return FLIGHT_REFRESH_MS.street;
  if (altitudeM < FLIGHT_REFRESH_ALT_THRESHOLDS.city)    return FLIGHT_REFRESH_MS.city;
  if (altitudeM < FLIGHT_REFRESH_ALT_THRESHOLDS.regional) return FLIGHT_REFRESH_MS.regional;
  return FLIGHT_REFRESH_MS.global;
}


function _flightApiUrl(viewer) {
  const cartographic = viewer?.camera?.positionCartographic;
  if (!cartographic) return API_URL;
  const latitude = Cesium.Math.toDegrees(cartographic.latitude);
  const longitude = Cesium.Math.toDegrees(cartographic.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return API_URL;
  const params = new URLSearchParams({
    lat: latitude.toFixed(4),
    lon: longitude.toFixed(4),
  });
  return `${API_URL}?${params}`;
}

// ---------------------------------------------------------------------------
// Click-to-track state
// ---------------------------------------------------------------------------

let _trackingRefreshEpoch = 0;
let _lastTrackingRefreshOutcome = {
  epoch: 0,
  status: 'unavailable',
  ids: new Set(),
  source: 'OpenSky Network',
  coverage: null,
};
/** Disposes the single active tracked-camera framing owner. */
let _trackedCameraFrameStop = null;
/** @type {Cesium.ScreenSpaceEventHandler|null} Click handler on the scene canvas */
let _clickHandler = null;
/**
 * Press-duration clock for the click gesture: DOM event stamps, immune to
 * main-thread queueing delay (under load an instant tap must not read as a
 * long press just because a render frame sat between the two events).
 */
let _clickPressClock = null;
/** @type {((event: CustomEvent) => void)|null} */
let _cockpitModeListener = null;


function _publishTrackedSelection(icao24, origin = 'programmatic') {
  const bb = p._billboards.get(icao24);
  const info = p._flightData.get(icao24);
  if (!bb?.position || !info) return false;
  if (p._trackedEntity) p._trackedEntity.gevSelectionOrigin = origin;
  p._emitAwarenessEvent('gev:awareness-subject-selected', {
    layerId: 'flights',
    id: icao24,
    // Canonical display chain (callsign → registration → hex). Publishing a
    // bare `callsign || icao24` here resurrected the pre-enrichment behavior:
    // a callsign-less contact reached Context as its raw hex even once adsbdb
    // had supplied a registration. Identity below stays `icao24`.
    label: _contactLabel(icao24, info),
    position: Cesium.Cartesian3.clone(bb.position),
    origin,
  });
  selectTrackedSubjectContext(_contextSubjectMetadata(icao24));
  return true;
}

/**
 * Describe the selected contact for the shared context slot the voice tools
 * and Cockpit read. Values are the LIVE descriptor, not a selection-time
 * snapshot, so a long follow never narrates a position the plane has left.
 * @param {string} icao24 Contact identity.
 * @returns {object|null} Context metadata, or null when the contact is gone.
 */
function _contextSubjectMetadata(icao24) {
  const described = _describeFlight(icao24);
  if (!described) return null;
  const altFt = Math.round((described.altitudeM || 0) * 3.28084);
  const route = described.route && _routeIsPlausible(icao24, described.route)
    ? `${described.route.origin.code} → ${described.route.destination.code}`
    : null;
  return {
    id: icao24,
    layerId: 'flights',
    layerName: 'Live Flights',
    source: 'OpenSky Network',
    label: _contactLabel(icao24, p._flightData.get(icao24)),
    latitude: described.latitude,
    longitude: described.longitude,
    // Flat text only: the voice payload compacts properties through a
    // string cleaner that drops nested objects.
    properties: {
      name: _contactLabel(icao24, p._flightData.get(icao24)),
      operator: described.airline || '',
      callsign: described.callsign || '',
      registration: described.registration || '',
      type: described.typeName || described.typeCode || '',
      altitude: described.onGround ? 'on ground' : `${altFt.toLocaleString('en-US')} ft`,
      speed: Number.isFinite(described.velocityMps)
        ? `${Math.round(described.velocityMps * 1.944)} kt`
        : '',
      heading: Number.isFinite(described.track) ? `${Math.round(described.track)}°` : '',
      route: route || '',
      icao24,
      // Honesty cue: the contact is coasting on dead reckoning, so the
      // narrated position/velocity are last-known rather than live.
      status: described.stale ? 'stale (missed polls)' : 'live',
    },
  };
}


function _normalBillboardScaleByDistance() {
  // Preserve the established close-range 3× scale. Any smaller user-visible
  // default belongs in a separate evidence-backed proposal.
  return new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5);
}







// ---------------------------------------------------------------------------
// Track-history trail state (PRD WS-F F1/F4): a fading polyline behind the
// tracked aircraft. The accumulation array is intentionally SEPARATE from
// p._positionHistory (capped at POSITION_HISTORY_LIMIT=5 for dead reckoning)
// so the visible trail can grow to p.TRAIL_MAX_POINTS fixes.
// ---------------------------------------------------------------------------

/** @constant {string} Civilian trail hue (PRD F4, pinned). */
const TRAIL_COLOR = '#00d4ff';
/** @type {number} Uniquifier for head-segment entity ids (Cesium requires unique ids). */
let _trailHeadSeq = 0;

// ---------------------------------------------------------------------------
// Render-behind smoothing (PRD WS-C C2 — approved product decision):
// the fleet renders at now - p.RENDER_DELAY_SEC so positions interpolate
// BETWEEN two known fixes instead of extrapolating ahead and snapping back
// when the next poll lands. All consumers (labels, HUD, detection,
// frame_overhead) share this delayed clock; removing the delay reintroduces
// the back/forward oscillation and is a regression.
// ---------------------------------------------------------------------------

/** @constant {number} Polls an aircraft may miss before removal (transient OpenSky dropouts). */
const MISSING_POLL_LIMIT = 3;
// --- Landed-plane fast cull (field report 2026-07-02: "phantom" planes
// lingered ~2 min at airports after touchdown). OpenSky's on_ground flag LAGS
// the actual landing, so a landed plane's last airborne-classified fixes show
// it low + slow on the runway; when such a plane then drops out of the poll,
// it has landed (the feed reclassified it to ground traffic we filter out),
// not hit a transient gap — evict after ONE missed poll instead of the full
// grace. Thresholds: below ~150 m baro (MSL, so this only fires near
// sea-level-ish fields — deliberately conservative; a high-elevation airport
// ghost just falls back to the normal grace) AND below ~45 kts ground speed
// (≈23 m/s — rollout/taxi; nothing in normal FLIGHT is this slow, so cruise
// planes always keep the full grace that absorbs real feed gaps).
/** @constant {number} Max baro altitude (m, MSL) for the landed fast cull. */
const LANDED_ALT_MAX_M = 150;
/** @constant {number} Max ground speed (m/s) for the landed fast cull (~45 kts). */
const LANDED_SPEED_MAX_MPS = 23;
/** @constant {number} Missed-poll allowance for likely-landed planes (1 = removed on the first missed poll). */
const LANDED_MISSING_POLL_LIMIT = 1;
// Field-test rounds 1+3 (2026-07-06): below-ground floor clamp scope. Only
// contacts rendering below the alt ceiling are ever clamped/warmed (terrain
// tops out well under it outside the extreme Himalaya; cruise traffic can't
// be below ground and costs zero lookups). The radius bounds the FLEET clamp
// to viewer-visible traffic — clamping thousands of global contacts would
// need unbounded terrain resolution (the tracked contact clamps regardless).
/** @constant {number} Max render altitude (m, ellipsoidal) eligible for the ground-floor clamp. */
const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;
/** @constant {number} Max viewer distance (km) for the fleet ground-floor clamp. */
const GROUND_FLOOR_CLAMP_RADIUS_KM = 150;
/** @type {Map<string, number>} icao24 -> consecutive missed polls */
let _missingPolls = new Map();

/**
 * Cheap equirectangular distance (km) — plenty accurate for the ~150 km
 * ground-floor clamp gate; runs once per contact per poll, so no trig-heavy
 * haversine needed.
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} Approximate great-circle distance in km.
 */
function _approxDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111.32;
  const dLon = (lon2 - lon1) * 111.32 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * True when the aircraft's latest metadata reads "on or about the runway"
 * (low + slow) — see the landed fast-cull rationale above. Both gates must
 * hold, so a plane missing either datum keeps the normal grace.
 * @param {string} icao24 - ICAO 24-bit transponder address.
 * @returns {boolean}
 */
function _likelyLanded(icao24) {
  const info = p._flightData.get(icao24);
  if (!info) return false;
  // Round 7: the fast cull only applies to contacts that were AIRBORNE
  // this session — its original target, the post-LANDING ghost. OpenSky's
  // ground coverage flaps constantly, so fast-culling every grounded contact
  // put parked planes in an evict/re-enter churn: each re-entry was a
  // brand-new contact with cold floor state (geoid-height first poll), so
  // the apron looked half-empty AND perpetually sunken. First-seen-grounded
  // contacts now ride the normal MISSING_POLL_LIMIT grace and keep their
  // identity (and warmed floors) across feed flaps.
  if (info.wasAirborne !== true) return false;
  // Was airborne, then grounded, then VANISHED from the poll — landed ghost.
  if (info.onGround) return true;
  return Number.isFinite(info.altitude) && info.altitude < LANDED_ALT_MAX_M
    && Number.isFinite(info.velocity) && info.velocity < LANDED_SPEED_MAX_MPS;
}

// ---------------------------------------------------------------------------
// Icon orientation (2026-06-10 playtest fix): rotation is computed by
// projecting each aircraft's course vector into WINDOW coordinates
// (iconOrientation.js) with alignedAxis always ZERO — exact at every camera
// pitch/heading, including tracked-entity orbit mode. Rotation passes run on
// the fleet tick only when the camera pose changed (or 1s drift catch-up).
// The same tick horizon-culls billboards: with the Cesium globe hidden there
// is no far-side depth, so planes otherwise show through the planet.
// ---------------------------------------------------------------------------

/** @constant {number} Fleet dead-reckoning tick interval (ms) — ~12Hz, not per-frame. */
const FLEET_DR_INTERVAL_MS = 80;
/** @constant {number} Max ms between rotation passes while the camera is idle. */
const ROTATION_REFRESH_MS = 1000;
/** @type {number} Epoch ms of the last full rotation pass */
let _lastRotPassMs = 0;
/** @type {Cesium.Event.RemoveCallback|null} preRender listener disposer */
let _preRenderRemove = null;
let _trackedModelPreUpdateRemove = null;
/** @type {Cesium.Event.RemoveCallback|null} camera.moveEnd listener disposer (arrival rotation pass) */
let _moveEndRemove = null;
/** @type {Cesium.Event.RemoveCallback|null} trackedEntityChanged listener disposer (cross-layer untrack) */
let _trackedEntityChangedRemove = null;
/** @type {(() => void)|null} militaryRegistry active-transition unsubscribe (M2 handoff sweep) */
let _milActiveChangeUnsub = null;

// ---------------------------------------------------------------------------
// Scratch (reusable) variables — avoid per-frame heap allocation
// ---------------------------------------------------------------------------

const _scratchCarto = new Cesium.Cartographic();
const _scratchRenderTime = new Cesium.JulianDate();
const _scratchFleetPos = new Cesium.Cartesian3();
const _scratchDrRaw = new Cesium.Cartesian3();
const _trackedPosHolder = new Cesium.Cartesian3();

// ---------------------------------------------------------------------------
// Per-frame cache for the tracked entity's dead-reckoned position.
// The position, alignedAxis, and rotation CallbackProperties all fire each
// render frame; caching avoids running _deadReckon three times.
// ---------------------------------------------------------------------------


/** Sibling scratch `_drExtrapolating` (set by the shared `_deadReckon` in
 *  flightsTracking.js): whether the position just returned came from
 *  EXTRAPOLATION rather than interpolation — see the factory state block. */

// ---------------------------------------------------------------------------
// adsbdb enrichment (best-effort, fail-silent). Bounded fan-out: max 4
// concurrent requests, dispatches dripped ≥ENRICH_DISPATCH_GAP_MS apart
// (≤5/s — adsbdb is a free community API; the dev-server proxy additionally
// caches per-key on disk forever, negative results included, so repeat
// sessions never re-hit adsbdb). Each key is requested at most once per
// session. Priority jobs (tracked plane, model-eligible planes) jump the
// queue; the ambient fleet sweep (below) fills the back at poll cadence.
// In a static deployment there is no server disk, so the BROWSER carries
// that cache instead: localStorage via localCache.js, one entry per key
// (negatives included — a plane that has no route today won't tomorrow),
// 30-day TTL (registrations/types/routes are near-immutable).
// ---------------------------------------------------------------------------
const ENRICH_MAX_INFLIGHT = 4;
/** Min ms between request dispatches — the drip that bounds the fan-out to ≤5/s. */
const ENRICH_DISPATCH_GAP_MS = 200;
/** Browser-cache TTL for one adsbdb type/route answer (see block comment). */
const ENRICH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let _enrichActive = 0;
let _enrichLastDispatchMs = 0;
/** @type {ReturnType<typeof setTimeout>|null} pending drip wake-up */
let _enrichDripTimer = null;
const _enrichQueue = [];
const _enrichSeen = new Set();

function _enqueueEnrich(key, url, onData, priority = false) {
  if (_enrichSeen.has(key)) return;
  _enrichSeen.add(key);
  const job = { url, cacheKey: `adsbdb:${key}`, onData };
  // Priority (tracked / model-eligible) goes to the FRONT so a deep ambient
  // backlog can never delay the plane the user just clicked or zoomed into.
  if (priority) _enrichQueue.unshift(job); else _enrichQueue.push(job);
  _drainEnrich();
}

function _drainEnrich() {
  while (_enrichActive < ENRICH_MAX_INFLIGHT && _enrichQueue.length) {
    // Drip: at most one dispatch per ENRICH_DISPATCH_GAP_MS. When the gap
    // hasn't elapsed yet, park a single wake-up timer and stop — completions
    // and enqueues in the meantime re-enter here harmlessly.
    const wait = ENRICH_DISPATCH_GAP_MS - (Date.now() - _enrichLastDispatchMs);
    if (wait > 0) {
      if (!_enrichDripTimer) {
        _enrichDripTimer = setTimeout(() => { _enrichDripTimer = null; _drainEnrich(); }, wait);
      }
      return;
    }
    const job = _enrichQueue.shift();
    // Browser cache first: a hit answers synchronously and costs no dispatch
    // slot or drip budget (only real fetches pace against the gap). Delivered
    // found OR negative — same contract as the network branch.
    const cached = readLocalCache(job.cacheKey);
    if (cached.hit) {
      if (cached.value) job.onData(cached.value);
      continue;
    }
    _enrichLastDispatchMs = Date.now();
    _enrichActive += 1;
    fetch(job.url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        // Persist before delivering, matching the dev proxy's write-on-answer
        // (negatives included). Failure to persist is silent by contract.
        if (writeLocalCache(job.cacheKey, data, { ttlMs: ENRICH_CACHE_TTL_MS })) trimLocalCache();
        // Delivered for found AND negative answers — both production handlers
        // no-op on absent fields, and delivering negatives keeps the test seam
        // able to observe a settled job.
        job.onData(data);
      })
      .catch(() => { /* enrichment never surfaces errors */ })
      .finally(() => { _enrichActive -= 1; _drainEnrich(); });
  }
}

/**
 * Test seam: run one enrichment job through the production queue, drip,
 * browser-cache and persistence path. Resolves with the answered payload
 * (found or negative) once the job settles.
 *
 * @param {string} key Enrichment key (`t:<icao24>` / `r:<callsign>`)
 * @param {string} url Proxy URL to fetch
 * @returns {Promise<object>} Settled payload, or `null` when the job never
 *   answers (network error).
 */
export function _runEnrichJobForTest(key, url) {
  return new Promise((resolve) => _enqueueEnrich(key, url, resolve, true));
}

function _requestTypeEnrichment(icao24, priority = false) {
  if (!/^[0-9a-f]{6}$/i.test(icao24)) return;
  _enqueueEnrich(`t:${icao24}`, api.adsbdbType(icao24), (data) => {
    const meta = p._flightData.get(icao24);
    if (!meta) return; // evicted while the lookup was in flight
    meta.typeCode = data.typeCode || meta.typeCode;
    meta.typeName = data.typeName || meta.typeName;
    meta.registration = data.registration || meta.registration;
    if (meta.typeCode) {
      const klass = classifyAircraft({ typeCode: meta.typeCode, category: meta.category });
      if (klass !== meta.klass) {
        meta.klass = klass;
        const bb = p._billboards.get(icao24);
        if (bb) p._applyFleetBillboardPresentation(icao24, bb);
        // Hangar fleet: the class's GLB/scale may have changed — resync the
        // live model, any in-flight load, and the tracked standalone model.
        p._syncModelToClass(icao24);
      }
    }
    if (icao24 === p._trackedIcao && p._trackedEntity) p._updateTrackedLabelModel(icao24);
  }, priority);
}

function _requestRouteEnrichment(icao24) {
  const cs = String(p._flightData.get(icao24)?.callsign || '').trim().toUpperCase();
  if (!/^[A-Z]{3}\d/.test(cs)) return; // airline-style callsigns only (LLL + digit); GA tails won't resolve
  _enqueueEnrich(`r:${cs}`, api.adsbdbRoute(cs), (data) => {
    const meta = p._flightData.get(icao24);
    if (!meta) return;
    meta.airline = data.airline || meta.airline;
    if (data.origin && data.destination) meta.route = { origin: data.origin, destination: data.destination };
    if (icao24 === p._trackedIcao && p._trackedEntity) p._updateTrackedLabelModel(icao24);
  }, true); // route lookups only fire for the TRACKED plane — front of the queue
}

/**
 * Ground context for the tracked readout: ONE OpenZenith reverse-geocode of
 * the contact's last known position, re-rendering the label with an
 * "over <city>, <state>" line when it resolves. Browser-cached by ~100 m
 * cell for 30 d (openzenith.js); failures and addressless cells (open water)
 * stay silent — this line is garnish, never worth an error surface.
 * @param {string} icao24
 */
async function _requestPlaceContext(icao24) {
  const info = p._flightData.get(icao24);
  if (!Number.isFinite(info?.rawLat) || !Number.isFinite(info?.rawLon)) return;
  const place = await reverseGeocodePlace(info.rawLat, info.rawLon);
  const meta = p._flightData.get(icao24);
  if (!meta) return; // evicted while the lookup was in flight
  if (place?.label) meta.placeLabel = `over ${place.label}`;
  if (icao24 === p._trackedIcao && p._trackedEntity && meta.placeLabel) {
    p._updateTrackedLabelModel(icao24);
  }
  return meta;
}

/** Test seam: drive the tracked-target place lookup without a viewer. */
export function _requestPlaceContextForTest(icao24) {
  return _requestPlaceContext(icao24);
}

// ---------------------------------------------------------------------------
// Ambient fleet type enrichment (2026-07-02 field data: OpenSky's live
// category field is 0/"no info" for ~94% of planes, so ambient classification
// defaulted nearly the whole fleet to the airliner silhouette). Each poll,
// ON-SCREEN planes — same horizon-occluder + frustum tests the fleet tick's
// model-eligibility pass uses; no new per-plane raycast — that haven't been
// requested this session are enqueued NEAREST-TO-CAMERA FIRST, bounded by:
//   - the shared queue's 4-concurrent / 200 ms-drip dispatch (above),
//   - ≤ ENRICH_AMBIENT_PER_SWEEP new enqueues per poll (= one poll interval
//     of drip, so the backlog can't outgrow a poll and re-sorts fresh), and
//   - a ROLLING token-bucket budget (below) bounding the sustained ambient
//     request rate (repeat sessions resolve instantly from the proxy's
//     permanent disk cache).
// Fail-silent by contract: the sweep never throws into the poll loop, never
// blocks rendering, and never touches tracking state. When a type answer
// lands, _requestTypeEnrichment's callback swaps the billboard glyph + scale
// in place (bb.scale composes multiplicatively with scaleByDistance).
// ---------------------------------------------------------------------------
// Rolling ambient budget (2026-07-03 field fix). The old ONE-SHOT session cap
// (300, refilled only in init) burned out in the first two polls of a busy
// region and never recovered — an hours-long session showed airliner
// monoculture in every NEW region until planes were clicked (the tracked path
// is uncapped). Token bucket instead: starts full at the ceiling, refills
// ENRICH_AMBIENT_REFILL_TOKENS every ENRICH_AMBIENT_REFILL_WINDOW_MS, clamped
// at the ceiling (no banking beyond one bucket). Numbers: 150 / 5 min sustains
// 0.5 req/s worst case — an order of magnitude under the 5/s drip that (with
// the 4-concurrent limit + the proxy's permanent disk cache) is the REAL
// politeness bound on adsbdb; the 300 ceiling preserves the old first-look
// burst so a fresh region still classifies quickly.
/** Bucket ceiling: max ambient tokens held at once (= the initial burst). */
const ENRICH_AMBIENT_BUDGET_CEIL = 300;
/** Tokens added back per refill window. */
const ENRICH_AMBIENT_REFILL_TOKENS = 150;
/** Refill window length (ms). */
const ENRICH_AMBIENT_REFILL_WINDOW_MS = 5 * 60 * 1000;
/** Max new ambient enqueues per poll sweep (≈ rate × poll interval). */
const ENRICH_AMBIENT_PER_SWEEP = 150;
let _enrichAmbientBudget = ENRICH_AMBIENT_BUDGET_CEIL;
/** Epoch ms the bucket last accounted a refill window from (0 = unset). */
let _enrichAmbientRefillAnchorMs = 0;

/** QA seam: headless harnesses (scripts/qa-enrich-ambient.mjs) shrink the
 *  bucket knobs via window.__GEV_ENRICH_AMBIENT_QA = {ceil, refillTokens,
 *  windowMs} — they cannot wait out a real 5-minute window. Read lazily each
 *  refill so a pre-boot override (or a mid-run windowMs swap) applies.
 *  Production never sets this; the constants above are the defaults. */
function _ambientBudgetKnobs() {
  const o = (typeof window !== 'undefined' && window.__GEV_ENRICH_AMBIENT_QA) || null;
  return {
    ceil: Number.isFinite(o?.ceil) && o.ceil > 0 ? o.ceil : ENRICH_AMBIENT_BUDGET_CEIL,
    refillTokens: Number.isFinite(o?.refillTokens) && o.refillTokens > 0 ? o.refillTokens : ENRICH_AMBIENT_REFILL_TOKENS,
    windowMs: Number.isFinite(o?.windowMs) && o.windowMs > 0 ? o.windowMs : ENRICH_AMBIENT_REFILL_WINDOW_MS,
  };
}

/** Advance the token bucket: add refillTokens per FULLY elapsed window since
 *  the anchor, clamp at the ceiling, and move the anchor forward by the whole
 *  windows consumed (while the bucket sits full this still advances, so idle
 *  time never banks more than one bucket's worth of burst). */
function _refillAmbientBudget(nowMs) {
  const { ceil, refillTokens, windowMs } = _ambientBudgetKnobs();
  if (!_enrichAmbientRefillAnchorMs) { _enrichAmbientRefillAnchorMs = nowMs; return; }
  const windows = Math.floor((nowMs - _enrichAmbientRefillAnchorMs) / windowMs);
  if (windows <= 0) return;
  _enrichAmbientBudget = Math.min(ceil, _enrichAmbientBudget + windows * refillTokens);
  _enrichAmbientRefillAnchorMs += windows * windowMs;
}

function _sweepAmbientEnrichment() {
  _refillAmbientBudget(Date.now());
  if (_enrichAmbientBudget <= 0 || !p._viewer || !p._billboardCollection || !p._billboardCollection.show) return;
  try {
    const camera = p._viewer.camera;
    const camPos = camera.positionWC;
    const occluder = horizonOccluder(camera);
    const cull = camera.frustum.computeCullingVolume(camPos, camera.directionWC, camera.upWC);
    const cand = [];
    for (const [icao24, bb] of p._billboards) {
      if (_enrichSeen.has(`t:${icao24}`)) continue; // answered / queued / negative this session
      if (!/^[0-9a-f]{6}$/i.test(icao24)) continue; // adsbdb keys are 6-char hex only
      if (p._flightData.get(icao24)?.onGround) continue; // ground traffic never spends ambient budget (click-to-enrich still works)
      if (!bb.position || !occluder.isPointVisible(bb.position)) continue; // beyond the limb
      Cesium.Cartesian3.clone(bb.position, _scratchModelBS.center);
      if (cull.computeVisibility(_scratchModelBS) === Cesium.Intersect.OUTSIDE) continue; // off-screen
      cand.push([icao24, Cesium.Cartesian3.distanceSquared(camPos, bb.position)]);
    }
    cand.sort((a, b) => a[1] - b[1]); // nearest first — what the user is looking at resolves first
    const n = Math.min(cand.length, ENRICH_AMBIENT_PER_SWEEP, _enrichAmbientBudget);
    for (let i = 0; i < n; i++) {
      _enrichAmbientBudget -= 1;
      _requestTypeEnrichment(cand[i][0]); // non-priority: fills the back of the queue
    }
  } catch { /* ambient enrichment is best-effort — never disturb the poll loop */ }
}

// Round 5: the old `_warmGroundedAircraftSurfaceCache` (global exact-5-decimal
// warm for every grounded contact on Earth) is GONE. Parked-aircraft GPS
// jitter minted fresh keys every poll → thousands of upstream points per
// minute → Re:Earth proxy failures → geoid-fallback POISON cached at
// sea-level heights → sunken sprites/trails and rejected mesh samples. The
// coarse ~111 m floor cells (viewer-proximate, collected in the poll loop)
// are the only DEM warm the layer needs.

/**
 * Round 6: lifts STALE grounded contacts onto floors that warmed after
 * their last feed fix. A parked plane whose transponder went quiet keeps
 * coasting on its final meta — if that fix predated the floor warm, it sat
 * frozen underground forever. Runs once per poll over the (bounded) flight
 * map; touches only grounded, feed-absent, demonstrably-below-floor
 * contacts, and patches the stored fix + billboard in place (zero-velocity
 * DR renders the patched fix verbatim).
 * @param {Set<string>} currentIcaos - Contacts present in THIS poll (already
 *   floored by the live path — skipped here).
 */
function _refloorStaleGroundedContacts(currentIcaos) {
  for (const [icao24, info] of p._flightData) {
    if (!info?.onGround || currentIcaos.has(icao24)) continue;
    if (!Number.isFinite(info.rawLat) || !Number.isFinite(info.rawLon)) continue;
    const floor = cachedGroundFloor(info.rawLat, info.rawLon);
    if (!Number.isFinite(floor)) continue;
    const lifted = floor + GROUND_FLOOR_LIFT_M;
    if (Number.isFinite(info.renderAltitudeM) && info.renderAltitudeM >= floor - 1) continue;
    info.renderAltitudeM = lifted;
    info.cullPosition = null; // above the ellipsoid now (or floors say otherwise next poll)
    const position = Cesium.Cartesian3.fromDegrees(info.rawLon, info.rawLat, lifted);
    const history = p._positionHistory.get(icao24);
    const newest = history?.[history.length - 1];
    if (newest) newest.position = Cesium.Cartesian3.clone(position, newest.position);
    const bb = p._billboards.get(icao24);
    if (bb) bb.position = position;
  }
}

// ---------------------------------------------------------------------------
// Tracked-display reconciliation. _deadReckon gives the RAW position from real
// fixes; at the warm-up→interpolation handoff (and on feed glitches / backfill
// splices) that raw value can step discontinuously. We absorb a step into a
// correction offset that decays to zero over DR_CORRECTION_MS, so the tracked
// icon, camera, and trail head never visibly jump — with ZERO steady-state lag
// (the correction stays ~0 whenever motion is already continuous).
// ---------------------------------------------------------------------------

const DR_CORRECTION_MS = 900;
const _drCorrection = new Cesium.Cartesian3(0, 0, 0);
let _drCorrectionStartMs = 0;
const _drPrevRaw = new Cesium.Cartesian3();
const _drPrevDisplay = new Cesium.Cartesian3();
let _drPrevMs = 0;

/**
 * Normalize a value to a trimmed lowercase string.
 * @param {*} value - Any value (typically a header string or null).
 * @returns {string} Lowercase trimmed string, or '' if falsy.
 */
function _toLowerText(value) {
  return String(value || '').trim().toLowerCase();
}


/**
 * The layer's ONE label convention: spoken callsign → tail registration → raw
 * ICAO hex. Mirrors militaryFlights.js so the same aircraft reads identically
 * in both layers.
 *
 * Registration is aircraft IDENTITY, not route, so unlike the origin/destination
 * line it is NOT plausibility-gated — an adsbdb tail number describes the
 * airframe itself and cannot go stale the way a leg can.
 *
 * This is a DISPLAY string only. Identity everywhere in this layer is `icao24`
 * (the `p._billboards`/`p._flightData` key, the `sourceId` detection declutter hashes,
 * the `id` that trackById/Context cohorts resolve) — never the label.
 * @param {string} icao24 - ICAO 24-bit transponder address (the identity key).
 * @param {object|null|undefined} info - `p._flightData` record for this aircraft.
 * @returns {string} Display label; never empty.
 */
function _contactLabel(icao24, info) {
  return p._toCleanText(info?.callsign) || p._toCleanText(info?.registration) || icao24;
}

/**
 * Map OpenSky proxy response headers into a human-readable auth error string.
 * The Vite proxy forwards `x-opensky-auth-mode-used` and `x-opensky-auth-reason`
 * headers so the client can display a meaningful diagnostic.
 * @param {object} params
 * @param {string} params.detail  - Error body text from the proxy, if any.
 * @param {string} params.authMode - Normalized auth mode header value.
 * @param {string} params.authReason - Normalized auth reason header value.
 * @returns {string} Concise error description for UI display.
 */
function _deriveOpenSkyAuthError({ detail, authMode, authReason }) {
  const reason = _toLowerText(authReason);
  const mode = _toLowerText(authMode);

  if (reason === 'oauth_invalid_or_missing') {
    return 'OpenSky OAuth client missing/invalid';
  }
  if (reason === 'oauth_invalid_credentials') {
    return 'OpenSky OAuth rejected credentials';
  }
  if (reason === 'basic_invalid_credentials') {
    return 'OpenSky username/password rejected';
  }
  if (reason === 'missing_basic_creds' || reason === 'missing_oauth_and_basic_creds') {
    return 'OpenSky auth missing';
  }
  if (reason === 'auth_required') {
    return 'OpenSky auth required';
  }
  if (reason.startsWith('oauth_') || reason.startsWith('basic_')) {
    return 'OpenSky auth invalid';
  }
  if (reason === 'forced_anonymous' || mode === 'anon') {
    return 'OpenSky auth required';
  }
  if (detail) return detail;
  return 'OpenSky auth failed';
}

/**
 * Dead-reckon an aircraft's current position using ENU (East-North-Up) frame math.
 *
 * Projects forward from the last known API fix using the aircraft's ground
 * velocity and true_track heading.  The ENU transform avoids repeated lat/lon
 * trig, keeping the per-frame cost low.
 *
 * If this aircraft is the tracked target and a lerp is in progress (new API
 * fix just arrived), the function first blends from the old dead-reckoned
 * position toward the corrected fix before projecting forward.
 *
 * @param {string} icao24 - ICAO 24-bit transponder address of the aircraft.
 * @returns {Cesium.Cartesian3|null} Estimated ECEF position, or null if no history exists.
 */
function _deadReckon(icao24, result) {
  const info = p._flightData.get(icao24);
  if (FOCUS_EVIDENCE_DEV && _focusEvidenceIds.has(icao24)) {
    const position = p._billboards.get(icao24)?.position;
    p._drCourseDeg = info?.true_track || 0;
    p._drSpeedMps = info?.velocity || 0;
    p._drCourseHold = p._drSpeedMps < COURSE_HOLD_SPEED_MPS;
    p._drExtrapolating = false;
    return position ? Cesium.Cartesian3.clone(position, result || new Cesium.Cartesian3()) : null;
  }
  const history = p._positionHistory.get(icao24);
  if (!history || history.length === 0) {
    p._drCourseDeg = null; p._drSpeedMps = null; p._drCourseHold = false; p._drExtrapolating = false;
    return null;
  }

  const out = result || new Cesium.Cartesian3();
  // Render one poll interval behind real time so we interpolate between
  // two KNOWN fixes whenever possible (see p.RENDER_DELAY_SEC rationale).
  const renderTime = Cesium.JulianDate.addSeconds(
    Cesium.JulianDate.now(), -p.RENDER_DELAY_SEC, _scratchRenderTime
  );

  // Bracketing pair: interpolate — no extrapolation error, no snap-back.
  for (let i = history.length - 1; i >= 1; i--) {
    const a = history[i - 1];
    const b = history[i];
    if (
      Cesium.JulianDate.lessThanOrEquals(a.time, renderTime) &&
      Cesium.JulianDate.lessThanOrEquals(renderTime, b.time)
    ) {
      const span = Cesium.JulianDate.secondsDifference(b.time, a.time);
      const t = span > 0
        ? Cesium.JulianDate.secondsDifference(renderTime, a.time) / span
        : 1.0;
      // Course of the DISPLAYED motion. The chord is only trustworthy when the
      // segment covers real ground (at hover its direction is GPS jitter; on a
      // slow tight turn it STEPS the whole per-segment turn at each boundary),
      // so it is blended against the reported per-fix track by displayed
      // ground speed — and the track is TIME-INTERPOLATED between the fixes so
      // a slow turner's nose advances continuously through the segment instead
      // of snapping once per poll. Helicopters always use the reported track
      // (rotorcraft chords are noise-dominated at their typical speeds).
      const chordLenM = Cesium.Cartesian3.distance(a.position, b.position);
      const segSpeed = span > 0 ? chordLenM / span : ((info && info.velocity) || 0);
      const fallbackTrack = (info && info.true_track) || 0;
      const trackFrom = Number.isFinite(a.track) ? a.track : fallbackTrack;
      const trackTo = Number.isFinite(b.track) ? b.track : trackFrom;
      const trackCourse = lerpAngleDeg(trackFrom, trackTo, t);
      const w = (info && info.klass === 'helicopter') ? 0 : speedRamp(segSpeed);
      const chordCourse = w > 0 ? courseBetweenCartesians(a.position, b.position) : null;
      p._drCourseDeg = chordCourse != null ? lerpAngleDeg(trackCourse, chordCourse, w) : trackCourse;
      p._drSpeedMps = segSpeed;
      p._drCourseHold = segSpeed < COURSE_HOLD_SPEED_MPS;
      p._drExtrapolating = false;
      return Cesium.Cartesian3.lerp(a.position, b.position, t, out);
    }
  }

  const newest = history.at(-1);
  const elapsedSec = Cesium.JulianDate.secondsDifference(renderTime, newest.time);
  if (elapsedSec <= 0) {
    // Warm-up: renderTime predates ALL history (freshly seen / just-started-tracking
    // aircraft, before p.RENDER_DELAY_SEC of history has accumulated, so no bracketing
    // pair exists yet). Render at the DELAYED renderTime — preserving the 30s-behind
    // invariant — by extrapolating the OLDEST fix BACKWARD to renderTime. As history
    // fills, renderTime advances toward the first fix and the icon glides FORWARD into
    // the bracketing interpolation above with NO freeze and NO backward snap. (Holding
    // the oldest fix froze the icon; extrapolating the NEWEST fix to wall-clock now made
    // the icon jump back ~one poll interval the instant interpolation took over.)
    const oldest = history[0];
    const lookbackSec = Cesium.JulianDate.secondsDifference(oldest.time, renderTime); // ≥ 0
    return p._extrapolateFix(oldest, info, -Math.min(lookbackSec, 60), out, (info && info.turnRateDps) || 0);
  }

  // Newest POSITION is older than renderTime. OpenSky can still be receiving
  // fresh contact/kinematic messages for that aircraft; freezing at a hard
  // 60 s-after-position boundary produced the visible stop → catch-up → stop
  // cadence. Coast through the latest real contact plus a bounded grace
  // window, with an absolute cap so a stale cached feed cannot drift forever.
  const coastLimitSec = staleCoastLimitSeconds({
    // `epochMs` is captured once when the poll is normalized. Avoid allocating
    // a Date per aircraft on every 12 Hz fleet tick.
    fixEpochMs: Number.isFinite(newest.epochMs)
      ? newest.epochMs
      : Cesium.JulianDate.toDate(newest.time).getTime(),
    lastContactEpochMs: info?.lastContactEpochMs,
    // Permit one minute of contact grace but cap any cached-feed drift at
    // five minutes. Source backoff is exposed separately as a STALE cue.
    minimumSec: 60,
    maximumSec: 300,
  });
  return p._extrapolateFix(
    newest,
    info,
    Math.min(elapsedSec, coastLimitSec),
    out,
    (info && info.turnRateDps) || 0,
  );
}




/**
 * Per-frame-cached, discontinuity-smoothed tracked DISPLAY position. Cached by Cesium
 * frame number so the position / rotation / trail-head callbacks share ONE computation
 * (and one reconciliation-state update) per frame. Returns a stable module holder, or
 * null when the aircraft has no fix.
 * @param {string} icao24
 * @returns {Cesium.Cartesian3|null}
 */
function _trackedDisplayPosition(icao24) {
  const frame = p._viewer?.scene?.frameState?.frameNumber ?? -1;
  if (frame === p._cachedDRFrame && icao24 === p._drReconcileIcao) return p._cachedDRPosition;

  // Does the reconciliation state belong to THIS aircraft? (Capture before overwriting
  // p._drReconcileIcao, so a track switch doesn't inherit the old plane's _drPrevRaw.)
  const sameTrack = p._drReconcileValid && p._drReconcileIcao === icao24;
  const raw = _deadReckon(icao24, _scratchDrRaw);
  p._cachedDRCourse = p._drCourseDeg;
  p._cachedDRSpeedMps = p._drSpeedMps;
  p._cachedDRHold = p._drCourseHold;
  p._cachedDRFrame = frame;
  p._drReconcileIcao = icao24;
  if (!raw) {
    p._cachedDRPosition = null;
    p._drReconcileValid = false;
    clearFocusTarget('flights', icao24);
    return null;
  }

  const nowMs = Date.now();
  const info = p._flightData.get(icao24);
  if (sameTrack) {
    const dtSec = Math.max(0.001, (nowMs - _drPrevMs) / 1000);
    const speed = (info && info.velocity) || 0;
    // Plausible single-frame motion (m): real velocity × frame Δt, ×4 slack + 25 m base.
    const plausible = speed * dtSec * 4 + 25;
    if (Cesium.Cartesian3.distance(raw, _drPrevRaw) > plausible) {
      // Discontinuity — re-anchor so the DISPLAYED position stays continuous, then decay.
      Cesium.Cartesian3.subtract(_drPrevDisplay, raw, _drCorrection);
      _drCorrectionStartMs = nowMs;
    }
  } else {
    Cesium.Cartesian3.fromElements(0, 0, 0, _drCorrection);
    _drCorrectionStartMs = nowMs - DR_CORRECTION_MS; // fully decayed
  }

  const elapsed = nowMs - _drCorrectionStartMs;
  const factor = elapsed >= DR_CORRECTION_MS ? 0 : 1 - elapsed / DR_CORRECTION_MS;
  let display = Cesium.Cartesian3.multiplyByScalar(_drCorrection, factor, _trackedPosHolder);
  Cesium.Cartesian3.add(raw, display, display);
  // Same display floor the fleet pass applies — otherwise selecting a correctly
  // floored grounded billboard swapped it for an unfloored tracked entity and
  // dropped the cyan target back under the mesh. Applied HERE, at the single
  // point every VISUAL consumer's per-frame position is computed, so the
  // readout anchor, detection bracket, trail head and follow-camera all read
  // the one floored value (the anti-jitter contract forbids recomputing per
  // consumer). NOT the single point for DATA: `_describeFlight` deliberately
  // reports sensor truth — see the note there. Skipped while a tracked 3D model
  // owns the visual: it rides groundSnap's one-shot sample and moving its input
  // would force a re-sample (T7).
  display = _floorGroundedDisplayPosition(icao24, info, display, p._modelOwnsVisual(icao24), nowMs);

  Cesium.Cartesian3.clone(raw, _drPrevRaw);
  Cesium.Cartesian3.clone(display, _drPrevDisplay);
  _drPrevMs = nowMs;
  p._drReconcileValid = true;
  p._cachedDRPosition = display;
  const focusSizePx = p._trackedFocusSizePx(icao24, p._cachedDRPosition);
  // Publish only the exact per-frame display cache the tracked entity/camera
  // consumes. Re-running DR from a later frame phase recreates the historical
  // target-vs-camera jitter bug.
  publishFocusTargetFromCachedPosition({
    ownerLayer: 'flights',
    id: icao24,
    scene: p._viewer?.scene,
    camera: p._viewer?.camera,
    displayPosition: p._cachedDRPosition,
    widthPx: focusSizePx,
    heightPx: focusSizePx,
  });
  return display;
}


/** Scratch for the shortened trail-head start. Owned by the head-segment
 *  callback alone, so nothing else can overwrite it mid-frame. */
const _scratchTrailHead = new Cesium.Cartesian3();







/**
 * Per-preRender fleet pass at ~12Hz: dead-reckons every untracked billboard,
 * horizon-culls billboards beyond the limb (no far-side depth with the globe
 * hidden), and refreshes screen-projected icon rotations whenever the camera
 * pose changed (plus a 1s drift catch-up while idle). Driven by
 * scene.preRender — NOT camera.changed, whose granularity is globally
 * degraded by other layers mutating camera.percentageChanged.
 * @returns {void}
 */

/** Model tint, mirroring the billboard color rules. */
function _modelColor(icao24) {
  if (icao24 === p._trackedIcao) return Cesium.Color.CYAN;
  return isMilitaryIcao(icao24) ? MIL_TINT : Cesium.Color.WHITE;
}



const TRACKED_MODEL_RETRY_BACKOFF_MS = 1500;



/** Record a rejected tracked-model load and arm the backoff / give-up latch. */
function _noteTrackedModelLoadFailure(url, err) {
  if (p._trackedModelFailIcao !== p._trackedIcao) {
    p._trackedModelFailIcao = p._trackedIcao;
    p._trackedModelFailCount = 0;
  }
  p._trackedModelFailCount += 1;
  p._trackedModelRetryAtMs = Date.now() + TRACKED_MODEL_RETRY_BACKOFF_MS;
  if (p._trackedModelFailCount >= p.TRACKED_MODEL_MAX_LOAD_FAILS) {
    logWarn(
      'Data:Flights',
      `tracked 3D model gave up after ${p._trackedModelFailCount} failed loads of ${url} — `
      + 'this contact stays 2D until another is selected',
      err,
    );
  }
}



/** Active model cap — the eligibility pre-pass AND p._ensureModel's admission checks must use the
 *  SAME value, else 'all' (MODEL_MAX_ALL) would mark planes eligible that p._ensureModel then refuses
 *  at the lower MODEL_MAX, silently degrading 'all' to 'proximity'. */
function _modelCap() {
  const mapCap = p._models3dMode === 'all' ? MODEL_MAX_ALL : MODEL_MAX;
  // `Math.min` on purpose: cockpit may only ever LOWER the GLB budget. Cockpit is
  // already the heaviest mode (20 Hz camera setView ahead of scene update, photoreal
  // retraversal, the cloud pass) and every model is its own draw call.
  return p._cockpitContactMode ? Math.min(COCKPIT_MODEL_MAX, mapCap) : mapCap;
}


/** World model matrix from a position + course heading (pitch/roll 0; ENU frame). Writes into
 *  `result` and returns it — pass each model's OWN `.modelMatrix` so models never share one
 *  mutable matrix object. `Model.modelMatrix` is a plain field (not a cloning setter); Cesium
 *  clones it per frame in updateModelMatrix(). Sharing a single scratch made every model render at
 *  the LAST-written transform — all stacked on one plane — and, once the tracked model wrote the
 *  scratch every frame, the stack point oscillated frame-to-frame: the "flickering like mad" bug. */
function _modelMatrix(pos, headingDeg, result = _scratchModelMtx) {
  _scratchModelHpr.heading = Cesium.Math.toRadians((headingDeg || 0) + MODEL_HEADING_OFFSET_DEG);
  _scratchModelHpr.pitch = 0;
  _scratchModelHpr.roll = 0;
  return Cesium.Transforms.headingPitchRollToFixedFrame(
    pos, _scratchModelHpr, Cesium.Ellipsoid.WGS84, undefined, result,
  );
}






/** @type {Cesium.Cartographic} Scratch for the grounded display-floor read. */
const _scratchDisplayCarto = new Cesium.Cartographic();
/** @type {Map<string, {cell: {lat: number, lon: number}, effectiveM: number|null,
 *  in: Cesium.Cartesian3, out: Cesium.Cartesian3|null, heldM: number|null,
 *  heldCell: {lat: number, lon: number}|null,
 *  heldTier: 'own'|'neighbor'|null, heldActive: boolean, seeded: boolean,
 *  probeMs: number|null, retiredMs: number|null,
 *  easedM: number|null, easeMs: number|null}>} Per-grounded-contact
 *  display-floor state: the cell it is currently reading (boundary hysteresis),
 *  the last input position and the effective floor that produced the cached
 *  output (rebuild skip), the last floor that actually RESOLVED for it plus the
 *  tier it came from (the hold, below), whether that floor is a REHYDRATED SEED
 *  rather than something measured while the contact stood here (`seeded` — it
 *  ranks below live evidence), and the value the downward ease is currently
 *  displaying while it approaches a lower floor.
 *  Dropped with the contact, and whenever it stops being a grounded billboard. */
const _displayFloorState = new Map();
/** @constant {number} Cap on NEW cells the display corridors may add to one
 *  poll's warm/sample batch — a view full of ground traffic must not balloon
 *  it. Cells the poll already collected are free (deduped before budgeting). */
const DISPLAY_CORRIDOR_CELL_BUDGET = 64;
/** @constant {number} Cells any single contact may claim in the first pass, so
 *  one long corridor cannot spend the whole budget while other contacts get
 *  nothing. Leftovers are handed out in a second pass. */
const DISPLAY_CORRIDOR_FAIR_SHARE = 4;
/** @constant {number} How far ahead a COASTING contact's corridor reaches:
 *  two poll intervals, so the ground it covers before the next batch lands is
 *  already warm. */
const DISPLAY_CORRIDOR_LOOKAHEAD_SEC = p.RENDER_DELAY_SEC * 2;
/** @type {number} Poll counter handed to the corridor allocator: it rotates
 *  runs of EQUALLY needy contacts so a tie larger than the budget cycles across
 *  polls instead of the same prefix winning forever. */
let _corridorEpoch = 0;
/** @constant {number} Corridors are only collected this close to the viewer:
 *  the mesh sampler ignores anything past 15 km, and a far contact's exact
 *  datum is subpixel. */
const DISPLAY_CORRIDOR_RADIUS_KM = 25;

/** @constant {number} How far a contact may travel from the cell that supplied
 *  its held floor before that floor stops describing the ground under it.
 *
 *  Sized to the same worst-case ground segment `CORRIDOR_MAX_CELLS` is sized
 *  for — a 27 m/s rollout covers ~810 m in one poll interval — with headroom
 *  for a couple of polls of coasting. That is ~9 cells: aprons, taxiways and
 *  runways really are flat at that scale. An early draft used 5 km, which is
 *  ~45 cells and can leave the airfield entirely — the KAUS note in this file
 *  records a 21 m spread across the field alone — so the bound is the distance
 *  the contact can actually have travelled since the measurement rather than a
 *  comfortable-looking number. */
const HELD_FLOOR_MAX_DRIFT_KM = 1;
/** @constant {number} Minimum gap between adjacent-cell probes for one contact
 *  whose held floor is missing or came from a borrowed tier. A contact standing
 *  on its own resolved floor never probes at all.
 *
 *  This per-contact throttle is the ONLY rationing on the probe path, and that
 *  is deliberate. A probe is eight synchronous `Map` reads against the shared
 *  floor cache — no fetch, no `sampleHeight`, nothing async — so it cannot
 *  queue work anywhere; every DEM request is driven by `warmGroundFloor` from
 *  the poll loop, already bounded by DISPLAY_CORRIDOR_CELL_BUDGET and the
 *  resolver's single-flight chain. Measured worst case (`scripts/qa-floorhold-
 *  probe-cost.mjs`): 200 synchronized all-cold contacts probing on the SAME
 *  tick cost 2.1 ms, 2.6% of one 80 ms fleet tick, and 2.1 ms per second of
 *  wall clock sustained under this throttle. An earlier draft added a global
 *  per-tick budget with a fairness queue on top of that; it protected ~2 ms and
 *  cost two starvation defects, so it was deleted. Nothing can starve here
 *  because there is no shared resource to be starved of. */
const NEIGHBOR_FLOOR_PROBE_MS = 500;
/** @constant {number} Time constant of the downward floor ease. A floor that
 *  drops UNDER a contact standing on a borrowed one is approached
 *  exponentially: each tick closes `1 - e^(-dt/TAU)` of the remaining gap, so
 *  at the 80 ms fleet cadence a tick moves ~20% of what is left and the value
 *  is within a few centimetres inside ~1.6 s. FLOOR_EASE_MAX_STEP caps that
 *  fraction so a delayed tick cannot close more.
 *
 *  Exponential rather than a fixed-duration interpolation because the target
 *  MOVES: a second, lower neighbour can warm mid-ease. A from/duration ease
 *  re-evaluated against a new target jumps by the eased fraction of the change
 *  (measured: a 100 m single-tick drop late in an ease). Approaching from the
 *  CURRENTLY DISPLAYED value has no such seam — retargeting is just a different
 *  destination for the same continuous follow, and the per-tick bound holds
 *  however often the target moves.
 *
 *  Rises are never eased: up is the safe direction, and easing up would park
 *  the contact under the mesh for the duration — the exact failure this whole
 *  path exists to prevent.
 *
 *  Reachability note (2026-08-21, after neighborFloorM moved to a low lean):
 *  the ordinary arrival flows no longer produce a downward move at all — a
 *  borrowed floor is now the apron rather than a roof, so the contact rises
 *  once and stays (`scripts/qa-floorhold-staircase.mjs`: one step, zero float,
 *  in every scenario that settles). This machinery still guards the re-latch
 *  paths — a lower neighbour warming later, or an own-cell resolve below a
 *  hold — which the pins exercise directly. Whether those paths are worth the
 *  code is a follow-up judgement, deliberately not made in this change. */
const FLOOR_EASE_TAU_MS = 360;
/** @constant {number} Hard ceiling on the fraction of the remaining gap ONE
 *  tick may close, whatever its dt. The exponential alone is timing-dependent:
 *  it closes 19.9% at the 80 ms fleet cadence but 28.4% at 120 ms and 75% after
 *  a 500 ms stall (a hidden tab, a long frame, a GC pause), which would turn a
 *  delayed tick back into the snap this approach exists to prevent. Clamping
 *  the fraction rather than dt keeps the never-snap property a property of the
 *  code instead of a property of the schedule; a stalled tick simply resumes
 *  the approach at full rate rather than jumping most of the way. */
const FLOOR_EASE_MAX_STEP = 0.22;
/** @constant {number} Distance from the target at which the ease finishes
 *  exactly, so a parked contact stops rebuilding its position. Two orders of
 *  magnitude under GROUND_FLOOR_LIFT_M — invisible. */
const FLOOR_EASE_EPSILON_M = 0.02;
/**
 * The floor to stand a grounded contact on while its own cell is unresolved.
 *
 * Product invariant (2026-08-21, after a Re:Earth outage buried a parked contact
 * at a Texas field): "hold the last known altitude until a fresh one comes in.
 * Never render otherwise." Two tiers, strongest first:
 *  own — a floor this contact's OWN cell resolved to while it stood there.
 *        Nothing weaker can improve on it, and its cell warming again is picked
 *        up by the live read, not here. Valid only within
 *        HELD_FLOOR_MAX_DRIFT_KM of where it was measured.
 *  neighbor — the LOWEST of at least two resolved ADJACENT cells (~111 m away,
 *        the same apron). Two at least, because one reading cannot be checked
 *        against anything, and the LOWEST because a high reading beside a cold
 *        cell is as likely to be a terminal roof as ground — see neighborFloorM.
 *
 * BOTH are validated measurements out of the shared floor cache. A third tier
 * that read the rendered mesh directly, where no DEM existed to check it, was
 * built and then REMOVED: run against a real GPU with the proxy down it
 * recorded a coarse-LOD 20.6 m for ground that is really ~122 m (see the note
 * in meshFloorSampler.js). Nothing in this chain is a guess.
 *
 * A neighbour hold keeps re-probing at the throttle so it can UPGRADE: a parked
 * contact that first answered from one neighbour would otherwise keep it after
 * a better one warmed. A held value is never dropped for nothing — a failed
 * probe leaves the previous answer standing — and a re-probe that lands LOWER
 * eases rather than steps (see the ease note in the clamp below).
 *
 * A REHYDRATED SEED is the one exception to the tier order. A floor parked by
 * `_retireDisplayFloorState` and picked back up on a later re-ground was
 * measured while the contact stood somewhere it no longer necessarily is: it is
 * a memory, not a reading, and it outranks nothing. So `seeded` demotes an
 * `own` floor below the neighbour tier — when two fresh adjacent cells can
 * answer, they answer, and the seed is discarded. It serves only while nothing
 * fresh contradicts it, which is exactly the flap case it exists for (a rotation
 * outruns its own cells, so nothing nearby is warm either). Without this a
 * contact that re-grounded 0.5 km away kept a 200 m floor while its new
 * neighbourhood read 100 m and 105 m, and rendered 100 m in the air.
 *
 * @param {object} state - The contact's `_displayFloorState` entry (mutated).
 * @param {{lat: number, lon: number}} cell - Cell the display is reading now.
 * @param {number} nowMs - Tick clock.
 * @returns {number|null} Floor to use, or null when nothing anywhere can answer.
 */
function _heldDisplayFloorM(state, cell, nowMs) {
  if (state.heldTier && !(Number.isFinite(state.heldM) && state.heldCell
    && _approxDistanceKm(cell.lat, cell.lon, state.heldCell.lat, state.heldCell.lon)
      <= HELD_FLOOR_MAX_DRIFT_KM)) {
    // Out of range: the held value is no longer a measurement of anywhere this
    // contact has been. Drop it rather than stretch it.
    _dropHeldFloor(state);
  }
  if (state.heldTier === 'own' && !state.seeded) return state.heldM;
  if (state.probeMs != null && nowMs - state.probeMs < NEIGHBOR_FLOOR_PROBE_MS) return state.heldM;
  state.probeMs = nowMs;
  const near = neighborFloorM(cell);
  if (near != null) return _adoptHeldFloorM(state, near, cell, 'neighbor');
  return state.heldM;
}

/** Records a held floor and the tier it came from; returns it. Every caller
 *  passes a floor measured for the cell the contact is reading NOW, so an
 *  adoption always clears the seed flag: live evidence has arrived. */
function _adoptHeldFloorM(state, floorM, cell, tier) {
  state.heldM = floorM;
  state.heldCell = cell;
  state.heldTier = tier;
  state.seeded = false;
  return floorM;
}

/** Forgets the held floor and everything that describes where it came from,
 *  leaving the rest of the contact's display state alone. */
function _dropHeldFloor(state) {
  state.heldM = null;
  state.heldCell = null;
  state.heldTier = null;
  state.seeded = false;
}

/** @constant {number} How long a retired hold stays usable as a rehydration
 *  seed — three poll intervals.
 *
 *  Deleting the state outright was the first cut, and a field observation found
 *  what that costs: VIR138M at JFK, 45 kt down the runway, "clearly on good
 *  ground, then suddenly popped below the ground, then popped back up".
 *  OpenSky's `on_ground` flag is not clean through a rotation — it flaps — and
 *  the fix's own height source switches at the same moment, from the resolved
 *  surface to baro + geoid N, which at a sea-level field IS the geoid and sits
 *  below the runway. A single airborne poll therefore wiped the only thing that
 *  was hiding that: the contact came back grounded with no prior, outrunning
 *  its own floor cells at 23 m/s, and rendered at the geoid until something
 *  ahead of it warmed (`scripts/qa-floorhold-staircase.mjs` §F1: 12 of 22
 *  grounded ticks below the runway, and not recovering).
 *
 *  So a retired hold is PARKED, not destroyed, and a contact that re-grounds
 *  soon after picks it back up. What makes that safe is the bound already in
 *  `_heldDisplayFloorM`: a seed only answers within HELD_FLOOR_MAX_DRIFT_KM of
 *  where it was measured AND only while no fresh neighbour contradicts it, so a
 *  genuine departure-and-landing-elsewhere still starts clean — the grace window
 *  is belt to those braces, retiring the seed outright once a contact has been
 *  airborne long enough to have gone anywhere. */
const FLOOR_SEED_GRACE_MS = 90_000;

/** Whether a parked seed has been away longer than the grace window.
 *
 *  ONE judgement, asked from BOTH sides of the park, because neither side sees
 *  the whole story on its own. While the contact keeps reporting, the retire
 *  path asks it and drops the entry. But a contact can be parked and then make
 *  no calls at all — off the poll for a long-haul cruise, out of the corridor
 *  radius, tab hidden — and then re-ground; nothing ran in between, so an
 *  expiry checked only on the retire path never fires and an arbitrarily old
 *  measurement walks back in (measured: parked 198 s, still reused). The
 *  rehydration side therefore asks the same question against the wall clock
 *  before it clears `retiredMs`.
 *  @param {object} state @param {number} nowMs - Tick clock. */
function _seedExpired(state, nowMs) {
  return state.retiredMs != null && nowMs - state.retiredMs > FLOOR_SEED_GRACE_MS;
}

/** Retires a contact's display-floor state. Called the moment it stops being a
 *  grounded billboard — airborne, model-owned, or gone.
 *
 *  The floor itself is kept as a rehydration seed for FLOOR_SEED_GRACE_MS (see
 *  above) and MARKED as one; everything that describes the contact's CURRENT
 *  rendering is cleared, so a re-ground recomputes from scratch and cannot be
 *  mistaken for a hold release. Nothing visual is touched, so the T7
 *  model-ownership gate is unaffected.
 *  @param {string} icao24 @param {number} nowMs - Tick clock. */
function _retireDisplayFloorState(icao24, nowMs) {
  const state = _displayFloorState.get(icao24);
  if (!state) return;
  if (state.retiredMs == null) {
    state.retiredMs = nowMs;
    state.seeded = true;        // what it answers with next is a memory, not a reading
    state.heldActive = false;   // a later landing is an arrival, not a release
    state.easedM = null;
    state.easeMs = null;
    state.probeMs = null;       // re-ground may probe immediately
    state.out = null;
    state.effectiveM = null;
    Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO, state.in); // invalidate the memo
  } else if (_seedExpired(state, nowMs)) {
    _displayFloorState.delete(icao24); // airborne long enough to be anywhere
  }
}

/**
 * Floors a GROUNDED contact's DISPLAYED position onto the local ground.
 *
 * `renderAltitudeM` is chosen once per poll from the floor of the FIX's coarse
 * cell. The position that renders is the dead-reckoned one, which drifts away
 * from that fix for the whole segment — and for up to 300 s / several hundred
 * metres while a ground contact coasts through its stale-feed grace. Across a
 * graded apron (KAUS spans ~119–140 m ellipsoidal) that drift buries the
 * sprite under the mesh it is now over; `scripts/qa-floor-verify.mjs` measured
 * −15.5 m. A second, smaller share comes from the fix-time floor itself: a
 * taxiing contact whose current cell is still cold falls back to the PREVIOUS
 * fix's cell (see the grounded `surfaceM` chain) and nothing revisits that
 * height once the cell warms — the stale re-floor sweep deliberately skips
 * contacts present in the poll. Both are cured by reading the floor at the
 * coordinate actually being displayed.
 *
 * Discipline:
 *  - READ-ONLY against the shared floor cache. No latch, no heal, no sampling.
 *    Keeping cold cells rare is `_collectDisplayCorridorCells`'s job, not this
 *    one's. A cold cell used to mean NO clamp at all, which was only safe while
 *    the un-clamped height was a real reading — and for a grounded contact with
 *    no altitude data it is not: the poll path's last resort is the geoid, tens
 *    of metres under the mesh at an inland field. When the cell cannot answer,
 *    `_heldDisplayFloorM` holds the last floor that DID (owner, 2026-08-21).
 *    Still never an invented surface: every tier is a measurement, and when
 *    none exists the position passes through as before.
 *  - Grounded contacts only. Airborne heights are the fix-time clamp's job.
 *  - NEVER when a 3D model owns the visual (T7): the model rides groundSnap's
 *    one-shot tileset sample and the billboard hides behind it, so clamping the
 *    hidden billboard would put a SECOND ground chain on one contact — and the
 *    one the operator is not looking at. (The original rationale was narrower:
 *    lifting the datum dragged groundSnap's input past its 50 m
 *    move-invalidation and forced a re-sample every frame. groundSnap now
 *    measures that distance on the ellipsoid, so a purely vertical change costs
 *    nothing; the gate stays for the reason above.) Same gate the military
 *    layer's grounded billboard lift uses.
 *
 * @param {string} icao24 - Contact key (owns one `_displayFloorState` entry).
 * @param {object|null|undefined} info - `p._flightData` record for this contact.
 * @param {Cesium.Cartesian3|null} pos - Dead-reckoned display position.
 * @param {boolean} modelOwnsVisual - Whether a 3D model is drawing this contact.
 * @param {number} [nowMs] - Tick clock, passed by both callers so the release
 *   ease advances on the same clock the rest of the tick uses.
 * @returns {Cesium.Cartesian3|null} `pos` itself when nothing moves (the common
 *   case — no allocation, no rebuild), otherwise the lifted position.
 */
function _floorGroundedDisplayPosition(icao24, info, pos, modelOwnsVisual, nowMs = Date.now()) {
  if (!pos || !info?.onGround || modelOwnsVisual) {
    _retireDisplayFloorState(icao24, nowMs);
    return pos;
  }
  const state = _displayFloorState.get(icao24);
  const carto = Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, _scratchDisplayCarto);
  // Boundary hysteresis: a position jittering across a cell edge would flip
  // floors at fleet-tick rate (see stickyFloorCell).
  const cell = stickyFloorCell(
    Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude), state?.cell,
  );
  const floor = cachedGroundFloor(cell.lat, cell.lon);
  const next = state || {
    cell, in: new Cesium.Cartesian3(), out: null, effectiveM: null,
    heldM: null, heldCell: null, heldTier: null, heldActive: false, seeded: false,
    probeMs: null, easedM: null, easeMs: null, retiredMs: null,
  };
  // Back on the ground. Judge the seed's AGE here, before `retiredMs` is
  // cleared: a contact that made no calls while it was away never reached the
  // retire path's own expiry branch, so this is the only place that can tell an
  // hour-old measurement from a three-poll-old one.
  if (_seedExpired(next, nowMs)) _dropHeldFloor(next);
  // The seed (if any survived) is live again, and the drift bound plus the
  // neighbour tier in the hold chain decide whether it still describes ground
  // this contact is on.
  next.retiredMs = null;
  // The floor to clamp against: this cell when it has one, otherwise the last
  // one that resolved for this contact (never the geoid the poll path fell to).
  // Snapshot what the contact was standing on BEFORE the chain overwrites it —
  // the ease decision below needs the previous value, and `_heldDisplayFloorM`
  // adopts into the same fields.
  const wasHeld = next.heldActive;
  const stoodOnM = next.heldM;
  let effective = floor;
  if (Number.isFinite(effective)) {
    _adoptHeldFloorM(next, effective, cell, 'own');
    next.heldActive = false;
  } else {
    effective = _heldDisplayFloorM(next, cell, nowMs);
    next.heldActive = Number.isFinite(effective);
  }
  // The floor moved DOWN under a contact that was standing on a BORROWED one.
  // Dropping it by that difference in a single tick is the snap product behavior requires
  // not to have, so approach it instead. Two ways in, and both need it:
  //  - the real floor arrives below the hold (releasing the hold);
  //  - a re-probe finds a LOWER neighbour than the one being held, which the
  //    12 m spread bound can make a large step on a mesa edge (200 m held, a
  //    120 m neighbour warms, the bounded answer is 132 m) — and can happen
  //    AGAIN while the first approach is still running.
  // Scoped to a borrowed floor on purpose: an ordinary cell-to-cell change
  // between two resolved floors is the existing path and keeps its timing.
  if (next.easedM == null && wasHeld && Number.isFinite(stoodOnM)
    && Number.isFinite(effective) && effective < stoodOnM) {
    next.easedM = stoodOnM; // start from where the contact is actually drawn
    next.easeMs = nowMs;
  }
  if (next.easedM != null) {
    if (!Number.isFinite(effective) || effective >= next.easedM) {
      // Nothing to approach, or the floor rose: take it whole and stop.
      next.easedM = null;
      next.easeMs = null;
    } else {
      // Exponential approach from the DISPLAYED value. The target may have
      // moved since last tick; that changes only where this is heading, never
      // where it is, so there is no seam to jump across.
      const dtMs = Math.max(0, nowMs - next.easeMs);
      next.easeMs = nowMs;
      const closed = Math.min(FLOOR_EASE_MAX_STEP, 1 - Math.exp(-dtMs / FLOOR_EASE_TAU_MS));
      let value = next.easedM + (effective - next.easedM) * closed;
      if (Math.abs(value - effective) <= FLOOR_EASE_EPSILON_M) {
        value = effective; // arrive exactly, so a parked contact stops rebuilding
        next.easedM = null;
        next.easeMs = null;
      } else {
        next.easedM = value;
      }
      effective = value;
    }
  }
  // Same input position AND the same EFFECTIVE floor ⇒ the same answer as last
  // tick, so skip the rebuild. A clamped stationary contact (parked, coasting
  // on a zero-velocity fix) hits this every tick; without it the identical
  // Cartesian was rebuilt at ~12 Hz forever. The test is deliberately on the
  // OUTPUT of the hold chain, not on its inputs: keying it to the raw cell
  // floor let a parked contact whose cell never warmed return a memoized
  // unresolved answer forever, so an adjacent-cell floor warming later was
  // never adopted. One owned entry per grounded
  // contact — O(grounded), dropped on eviction, on destroy, and the moment the
  // contact stops being a grounded billboard.
  if (state && state.effectiveM === effective && Cesium.Cartesian3.equals(pos, state.in)) {
    return state.out || pos;
  }
  const lifted = displayFloorHeightM(carto.height, effective);
  next.cell = cell;
  next.effectiveM = effective;
  Cesium.Cartesian3.clone(pos, next.in);
  if (lifted == null) {
    next.out = null;
  } else {
    // The cache OWNS its output: returning a shared scratch would let the next
    // contact in the fleet loop overwrite a position already handed out.
    next.out = Cesium.Cartesian3.fromRadians(
      carto.longitude, carto.latitude, lifted, Cesium.Ellipsoid.WGS84,
      next.out || new Cesium.Cartesian3(),
    );
  }
  if (!state) _displayFloorState.set(icao24, next);
  return next.out || pos;
}

/** @type {Cesium.Cartographic} Scratch for the corridor's display-end read. */
const _scratchCorridorCarto = new Cesium.Cartographic();
/** @type {Cesium.Cartesian3} Scratch for the corridor's dead-reckon probe. */
const _scratchCorridorPos = new Cesium.Cartesian3();

/**
 * Adds the cells each grounded contact's DISPLAY is about to render over to
 * this poll's floor warm/sample batch.
 *
 * The poll loop otherwise collects FIX cells only, so the clamp above has data
 * exactly where the contact ISN'T. A contact taxiing at 10 m/s crosses a
 * ~111 m cell every ~11 s while the batch runs once per 30 s poll, so it stays
 * permanently ahead of its own floor data (the "taxiing cache" failure mode, at
 * cell granularity) and the clamp silently passes.
 *
 * The corridor therefore follows the direction the display is actually MOVING,
 * which is not always toward the fix:
 *  - INTERPOLATING between two fixes — the display is walking to the newest
 *    fix, so that fix is the endpoint (exact, no projection error).
 *  - EXTRAPOLATING — coasting past the newest fix on a stale feed, or the
 *    pre-history warm-up — the display travels along its course AWAY from that
 *    fix. Aiming at the fix here warms the BACKTRAIL while the contact stays
 *    one sampling cycle ahead and buried, so the endpoint is the position its
 *    own kinematics put it at two poll intervals from now.
 *
 * Runs EVERY poll, warm cells included, for the same reason the fix cells do:
 * `warmGroundFloor` skips cells that already have a real DEM, but the mesh
 * sampler needs to see a cell again AFTER its DEM prior lands, since a sample
 * without that prior is rejected. Offering a cell once would leave it DEM-only
 * for the session — at fields where the photogrammetric mesh sits well above
 * bare earth that is still metres of burial.
 *
 * Budgeting is need-ranked and dedupe-first: cells this poll already collected
 * cost NOTHING (a parked contact's corridor is its own fix cell, so it never
 * competes), candidates are ordered by how many of their cells are actually
 * cold, and each takes at most DISPLAY_CORRIDOR_FAIR_SHARE before anyone takes
 * seconds. Insertion-order spending starved the contacts that needed it most.
 *
 * Purely additive to the existing batch: same fire-and-forget DEM resolve, same
 * one-shot DEM-validated mesh sampler. No latch, no heal.
 *
 * @param {Array<{lat: number, lon: number}>} out - This poll's warm points.
 * @param {number|null} viewerLat @param {number|null} viewerLon - Viewer subpoint.
 */
function _collectDisplayCorridorCells(out, viewerLat, viewerLon) {
  if (viewerLat == null || viewerLon == null) return;
  // Cells the poll already collected (grounded + low-airborne fix cells).
  const seen = new Set();
  for (const p of out) {
    const c = coarseFloorCoord(p.lat, p.lon);
    seen.add(`${c.lat},${c.lon}`);
  }

  const candidates = [];
  for (const [icao24, info] of p._flightData) {
    if (!info?.onGround) continue;
    // T7: a contact whose 3D model is the visual never reads a display floor.
    if (p._modelOwnsVisual(icao24)) continue;
    if (!Number.isFinite(info.rawLat) || !Number.isFinite(info.rawLon)) continue;
    if (_approxDistanceKm(viewerLat, viewerLon, info.rawLat, info.rawLon) > DISPLAY_CORRIDOR_RADIUS_KM) continue;
    const dr = _deadReckon(icao24, _scratchCorridorPos);
    if (!dr) continue;
    // Read the sibling scratches IMMEDIATELY, before any other _deadReckon call.
    const extrapolating = p._drExtrapolating;
    const speedMps = Number.isFinite(p._drSpeedMps) ? p._drSpeedMps : (info.velocity || 0);
    const courseDeg = p._drCourseDeg != null ? p._drCourseDeg : (info.true_track || 0);
    const c = Cesium.Cartographic.fromCartesian(dr, Cesium.Ellipsoid.WGS84, _scratchCorridorCarto);
    const lat = Cesium.Math.toDegrees(c.latitude);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const cells = corridorFloorCells(corridorPathLatLon({
      extrapolating,
      displayLat: lat,
      displayLon: lon,
      courseDeg,
      speedMps,
      // Same turn the dead-reckon integrates — a sustained-turn taxi leaves a
      // straight tangent within a few hundred metres.
      turnRateDps: info.turnRateDps || 0,
      fixLat: info.rawLat,
      fixLon: info.rawLon,
      lookaheadSec: DISPLAY_CORRIDOR_LOOKAHEAD_SEC,
    }));
    let cold = 0;
    for (const cell of cells) {
      if (cachedGroundFloor(cell.lat, cell.lon) == null) cold += 1;
    }
    candidates.push({ cells, cold, speedMps });
  }
  _corridorEpoch += 1;
  for (const cell of allocateCorridorCells(
    candidates, seen, DISPLAY_CORRIDOR_CELL_BUDGET, DISPLAY_CORRIDOR_FAIR_SHARE, _corridorEpoch,
  )) {
    out.push(cell);
  }
}

/** Test seam for the display-floor clamp (unit-tested against real Cesium math
 *  with seeded mesh cells — the drift mechanism is otherwise only reachable
 *  through a live poll + render loop). */
export function _floorGroundedDisplayPositionForTest(
  info, pos, modelOwnsVisual, icao24 = '__test__', nowMs = Date.now(),
) {
  return _floorGroundedDisplayPosition(icao24, info, pos, modelOwnsVisual, nowMs);
}

/** Test seam: the per-contact display-floor state the clamp actually used —
 *  the sticky cell (boundary hysteresis) and the effective floor after the
 *  hold chain. Browser harness scenarios compare a rendered height against
 *  THIS floor rather than re-deriving one from raw coordinates: the clamp
 *  deliberately keeps the cell it already holds when the contact drifts
 *  across a boundary, so a raw read at the displayed coordinate can disagree
 *  by a whole cell and misreport a correct clamp. */
export function _displayFloorStateForTest(icao24) {
  const state = _displayFloorState.get(icao24);
  if (!state) return null;
  return {
    cell: state.cell ? { lat: state.cell.lat, lon: state.cell.lon } : null,
    effectiveM: state.effectiveM,
    heldM: state.heldM,
    heldActive: state.heldActive,
  };
}

/** Test hook: drops the per-contact display-floor state (hysteresis + rebuild
 *  cache) so each case starts clean. There is no cross-contact state to reset —
 *  the clamp is per-contact all the way down. */
export function _clearDisplayFloorStateForTest() {
  _displayFloorState.clear();
}

/** Test hook: drops cached model ground snaps so a browser-harness scenario
 *  cannot inherit another scenario's per-contact measurement. */
export function _clearGroundSnapStateForTest() {
  p._groundSnap.clear();
}








/** Per-frame driver for the standalone tracked model. Runs every preUpdate (not the 80 ms fleet
 *  cadence) so the centered plane moves smoothly. The tracked entity stays a pure billboard, so the
 *  follow-camera's bounding sphere is ALWAYS ready — toggling 3D, or tracking while already zoomed
 *  in, can never stall or freeze the centering (the old model-graphic-on-entity failure mode). */
function _updateTrackedModel() {
  const active = p._trackedIcao && p._trackedModelRegimeActive()
    && p._modelCollection && !p._modelCollection.isDestroyed();
  if (!active) { if (p._trackedModel) p._trackedModel.show = false; return; }
  // Ask the frame-cached source directly. If the entity callback already ran,
  // this is a no-op; if model loading completed between phases, it establishes
  // this frame's single sample before the model renders. Camera, detection, and
  // readout consumers then reuse that exact cached position.
  const pos = _trackedDisplayPosition(p._trackedIcao) || p._billboards.get(p._trackedIcao)?.position;
  if (!pos) { if (p._trackedModel) p._trackedModel.show = false; return; }
  if (!p._trackedModel && !p._trackedModelLoading && p._trackedModelLoadAllowed()) {
    p._trackedModelLoading = true;
    const gen = p._trackedModelGen;
    const trackedSpec = _modelSpec(p._flightData.get(p._trackedIcao)?.klass);
    const trackedKey = p._specKeyFor(p._flightData.get(p._trackedIcao)?.klass);
    const trackedIrBoost = p._irBoost;
    Cesium.Model.fromGltfAsync({
      url: trackedSpec.url,
      asynchronous: false,
      minimumPixelSize: p.TRACKED_MODEL_MIN_PX,
      scale: trackedSpec.scale,
      color: p._irBoost ? Cesium.Color.WHITE : Cesium.Color.CYAN,
      colorBlendMode: Cesium.ColorBlendMode.MIX,
      // The tracked aircraft uses the same dominant light tint as the fleet;
      // IR boost removes the remaining diffuse hint with flat UNLIT white.
      colorBlendAmount: p._irBoost ? 1.0 : trackedSpec.blendAmount,
      customShader: p._irBoost ? p._IR_UNLIT_SHADER : undefined,
      // Pick id (H1): without it, clicking the very plane being tracked read as
      // EMPTY SPACE (scene.pick → primitive with no id) → an unintended
      // deselect. With the icao, the click handler recognizes it as ours.
      id: p._trackedIcao,
    }).then((m) => {
      // Untracked / re-tracked / torn down during the load → drop it.
      if (gen !== p._trackedModelGen || !p._modelCollection || p._modelCollection.isDestroyed()) { try { m.destroy(); } catch { /* gone */ } return; }
      // Class reclassified OR boost flipped mid-load (no release ran —
      // p._trackedModel was still null): drop the stale asset; driver reloads.
      if (p._specKeyFor(p._flightData.get(p._trackedIcao)?.klass) !== trackedKey || p._irBoost !== trackedIrBoost) {
        try { m.destroy(); } catch { /* gone */ }
        p._trackedModelLoading = false;
        return;
      }
      // Assign after resolution as well as in the creation options so the
      // standalone primitive always exposes the tracked aircraft pick id.
      m.id = p._trackedIcao;
      m._gevSpecKey = trackedKey; // class-change sync compares against this
      m.show = false; // admitted, not yet the visual — the driver shows it once placed
      // Seed the world transform before the primitive enters the scene. A model
      // can become ready+shown between render phases; leaving Cesium's identity
      // default here produces a one-frame jump to the Earth's center.
      const currentPos = p._trackedDisplayCached()
        || p._billboards.get(p._trackedIcao)?.position;
      if (currentPos) {
        const displayPos = p._modelDisplayPosition(p._trackedIcao, currentPos, p._scratchGroundPos);
        if (displayPos) _modelMatrix(displayPos, p._trackedDisplayCourse(), m.modelMatrix);
      }
      p._trackedModel = m;
      p._trackedModelLoading = false;
      // A good load retires this selection's failure budget — a contact that
      // recovers after a transient blip is not one attempt from giving up.
      p._trackedModelFailIcao = null;
      p._trackedModelFailCount = 0;
      p._trackedModelRetryAtMs = 0;
      p._modelCollection.add(m);
      p._planeModelLoaded = true; // GLB cached — the tracked billboard can fade out once the model is up
    }).catch((err) => {
      if (gen !== p._trackedModelGen) return; // superseded load — not this selection's failure
      p._trackedModelLoading = false;
      _noteTrackedModelLoadFailure(trackedSpec.url, err);
    });
    return; // billboard carries the visual until the model is ready
  }
  if (p._trackedModel) {
    // Keep the transform current while GPU resources are still loading. Cesium
    // can flip ready during scene update after this callback; waiting for ready
    // here would let that first rendered frame use a stale load-start matrix.
    const displayPos = p._modelDisplayPosition(p._trackedIcao, pos, p._scratchGroundPos);
    if (!displayPos) {
      p._trackedModel.show = false; // no ground evidence → the billboard carries it
      return;
    }
    _modelMatrix(displayPos, p._trackedDisplayCourse(), p._trackedModel.modelMatrix);
    if (!p._trackedModel.ready) return;
    const spec = _modelSpec(p._flightData.get(p._trackedIcao)?.klass);
    p._trackedModel.scale = trackedModelScaleForPixelCap({
      baseScale: spec.scale,
      nativeRadiusM: spec.nativeRadiusM,
      rangeM: Cesium.Cartesian3.distance(p._viewer.camera.positionWC, displayPos),
      viewportHeightPx: p._viewer.scene.canvas.clientHeight,
      fovyRad: p._viewer.camera.frustum.fovy,
      maximumPixelSize: TRACKED_MODEL_MAX_PX,
    });
    p._trackedModel.show = true;
  }
}

function _fleetTick() {
  if (!p._viewer || !p._billboardCollection || !p._billboardCollection.show) return;
  const scene = p._viewer.scene;
  const camera = p._viewer.camera;
  const nowMs = focusNowMs(Date.now());

  // (The tracked trail head is now the per-frame p._trailHeadEntity segment — no 1 Hz
  // primitive rebuild needed here anymore.)

  if ((nowMs - p._lastFleetTickMs) < FLEET_DR_INTERVAL_MS) return;
  const tickDtSec = p._lastFleetTickMs
    ? Math.min(p.COURSE_SLEW_DT_MAX_SEC, (nowMs - p._lastFleetTickMs) / 1000)
    : 0.08;
  p._lastFleetTickMs = nowMs;

  p._drainIrReloadQueue(); // bounded per-tick slice of any pending boost-flip reload
  if (p._cockpitContactMode) p._refreshCockpitNearContacts();
  const poseSig = cameraPoseSignature(camera);
  // Only the nearby Cockpit silhouettes need projected course; far dots are
  // rotation-free. The per-contact gate below keeps the pip path cheap.
  const doRotations = (poseSig !== p._lastCamPoseSig || (nowMs - _lastRotPassMs) >= ROTATION_REFRESH_MS);
  if (doRotations) {
    p._lastCamPoseSig = poseSig;
    _lastRotPassMs = nowMs;
  }

  const occluder = horizonOccluder(camera);
  const focusTarget = getFocusTarget();

  // 3D model regime: only when enabled AND the camera is zoomed in past the altitude ceiling.
  // Drop all models the moment we leave it (toggled off / zoomed out) so billboards resume.
  const useModels = p._modelRegimeActive();
  // Drop live models AND invalidate in-flight loads on leaving the regime (else a load that
  // resolves after zoom-out could briefly add a model outside the 3D-model regime).
  if (!useModels && (p._models.size || p._modelPending.size)) p._releaseModels();

  // 3D-model eligibility: by DISTANCE (the mode's add/keep band), with ON-SCREEN PRIORITY under the
  // cap. FOUR passes, visible-first, so the slots are spent on what you can see: (1) KEEP on-screen
  // already-modeled (hysteresis for visible planes); (2) ADD on-screen new inside the add radius,
  // nearest first; (3) KEEP off-screen already-modeled; (4) ADD off-screen new with leftover slots
  // (so a plane just off the cone still models — the "planes right next to me aren't 3D" complaint).
  // Crucially KEEP is SPLIT by frustum: an off-screen retained model (pass 3) can never starve an
  // on-screen plane that wants one (passes 1–2) — a single KEEP-everything pass could fill the cap
  // with off-screen retained models. Pure-distance let off-screen planes eat the cap; pure-frustum
  // filtering dropped near off-screen planes entirely. This does both right.
  let modelEligible = null;
  if (useModels) {
    const cap = _modelCap();
    const camPos = camera.positionWC;
    const addM = p._modelAddDistM();
    const addDistSq = addM * addM;
    const keepM = p._modelKeepDistM();
    const keepDistSq = keepM * keepM;
    const cull = camera.frustum.computeCullingVolume(camPos, camera.directionWC, camera.upWC);
    // Candidates = planes within the KEEP radius, nearest first, each tagged with on-screen-ness.
    const cand = [];
    for (const [icao, bb] of p._billboards) {
      if (icao === p._trackedIcao) continue;
      // A converted TR-3B renders as a billboard and can never take a model, so
      // it must not occupy a CAP SLOT either — excluded here at selection time,
      // not just at the handoff below, or accumulated conversions would starve
      // ordinary contacts of 3D models. (The handoff guard stays as defence.)
      if (isTr3b(icao)) continue;
      // Ground planes compete for model slots like everyone else (product rule
      // 2026-07-03: "3D mode is respected regardless of whether a plane is on the
      // ground or in the air — no distinction"). The cap + nearest-first ordering
      // below already bound airport clusters; grounded placement is handled by the
      // one-shot ground snap in p._modelDisplayPosition.
      const d2 = Cesium.Cartesian3.distanceSquared(camPos, bb.position);
      if (d2 > keepDistSq) continue; // beyond the keep radius → never eligible
      Cesium.Cartesian3.clone(bb.position, _scratchModelBS.center);
      cand.push([icao, d2, cull.computeVisibility(_scratchModelBS) !== Cesium.Intersect.OUTSIDE]);
    }
    cand.sort((a, b) => a[1] - b[1]); // nearest first
    if (cand.length > cap && (nowMs - _lastModelCapWarnMs) > 5000) {
      logWarn('Data:Flights', `${cand.length} planes in 3D range; capped at ${cap} (${p._models3dMode}). On-screen planes are prioritized.`);
      _lastModelCapWarnMs = nowMs;
    }
    modelEligible = new Set();
    // 1. KEEP on-screen already-modeled (visible retained — no flicker for what you can see).
    for (const [icao, , inF] of cand) { if (modelEligible.size >= cap) break; if (inF && p._models.has(icao)) modelEligible.add(icao); }
    // 2. ADD on-screen NEW inside the add radius, nearest first (visible additions win the cap).
    for (const [icao, d2, inF] of cand) { if (modelEligible.size >= cap) break; if (inF && d2 <= addDistSq && !modelEligible.has(icao)) modelEligible.add(icao); }
    // 3. KEEP off-screen already-modeled (hysteresis, but LOWER priority than anything visible — so a
    //    retained off-screen model can never starve an on-screen plane that wants one; dropping it is
    //    invisible and it re-adds the moment it's back in view).
    for (const [icao, , inF] of cand) { if (modelEligible.size >= cap) break; if (!inF && p._models.has(icao)) modelEligible.add(icao); }
    // 4. ADD off-screen NEW inside the add radius with any leftover slots.
    for (const [icao, d2, inF] of cand) { if (modelEligible.size >= cap) break; if (!inF && d2 <= addDistSq && !modelEligible.has(icao)) modelEligible.add(icao); }
    const toRelease = [];
    for (const icao of p._models.keys()) {
      if (icao !== p._trackedIcao && !modelEligible.has(icao)) toRelease.push(icao);
    }
    for (const icao of toRelease) p._releaseModel(icao);
  }

  for (const [icao24, bb] of p._billboards) {
    if (icao24 === p._trackedIcao) continue; // tracked entity owns its own motion

    const info = p._flightData.get(icao24);

    const dr = _deadReckon(icao24, _scratchFleetPos);
    // The dead-reckoned point drifts away from the fix whose cell supplied the
    // height, so a grounded contact's sprite ends up under the mesh it taxied
    // (or coasted) over. Re-floor at the DISPLAYED coordinate — read-only, and
    // never while a 3D model owns the visual (T7).
    const display = _floorGroundedDisplayPosition(icao24, info, dr, p._modelOwnsVisual(icao24), nowMs);
    // Gate the write — assigning Billboard.position dirties the whole
    // collection's vertex buffer, so skip sub-meter moves.
    if (display && Cesium.Cartesian3.distanceSquared(display, bb.position) > 1.0) {
      bb.position = display;
    }

    // Round 6: occlusion-test a LIFTED point for contacts rendering below
    // (or within a wingspan of) the ellipsoid — EllipsoidalOccluder judges a
    // sub-ellipsoid point near the limb "beyond the horizon" and the fleet
    // pass would hide a plane that is really just low over high-N terrain
    // waiting for its floor to warm (ATL grounded contacts at geoid −31 m).
    const beyondHorizon = !occluder.isPointVisible(info?.cullPosition || bb.position);
    // A billboard flipping INTO view (horizon reveal while the camera idles)
    // gets its rotation refreshed THIS tick even without a pose change —
    // otherwise it reappears wearing its stale (often creation-north) nose for
    // up to ROTATION_REFRESH_MS. (Model-handed-off planes also read show=false
    // here; harmless — the model branch below `continue`s past the rotation.)
    const revealed = !beyondHorizon && !bb.show;
    if (bb.show === beyondHorizon) bb.show = !beyondHorizon;
    if (beyondHorizon) {
      // Also hide any 3D model — otherwise a model that crossed the limb would keep
      // rendering through the hidden globe at its last matrix.
      const m = p._models.get(icao24);
      if (m && m.show) m.show = false;
      continue;
    }

    // One order-independent write site composes freshness × focus × limb haze
    // for alpha, and base class/ground scale × limb taper for scale. Cesium's
    // locked NearFarScalar remains a separate multiplicative stage. This
    // narrowly amends always-visible rendering without count culling or zero
    // alpha; nearer focus behavior remains tunable rather than universal.
    const cameraDistanceM = Cesium.Cartesian3.distance(camera.positionWC, bb.position);
    const distanceScale = nearFarScalarValueAtDistance(bb.scaleByDistance, cameraDistanceM);
    const focus = advanceProjectedSpriteFocus(
      bb,
      bb.position,
      scene,
      camera,
      nowMs,
      focusTarget,
      undefined,
      (bb.width || 20) * (bb.scale || 1) * distanceScale * 0.5,
      (bb.height || 20) * (bb.scale || 1) * distanceScale * 0.5,
    );
    const isCockpitNear = p._cockpitContactMode && p._cockpitNearContacts.has(icao24);
    const baseColor = p._cockpitContactMode && !isCockpitNear
      ? (isMilitaryIcao(icao24) ? MIL_TINT : COCKPIT_CIVILIAN_COLOR)
      : _fleetBillboardColor(icao24);
    const treatment = applyAircraftBillboardTreatment({
      billboard: bb,
      baseScale: p._cockpitContactMode && !isCockpitNear ? 1 : _fleetBillboardScale(icao24, info?.klass),
      baseAlpha: _missingPolls.get(icao24) ? 0.45 : 1,
      baseColor,
      focusFactor: focus.factor,
      cameraDistanceM,
      cameraHeightM: camera.positionCartographic?.height,
    });
    p._billboardLimbScale.set(bb, treatment.factors.scale);
    // Two-tier glyph raster (field test 2026-08-16): the billboard atlas
    // has no mipmaps, so no single texture stays crisp across the ~25–150
    // device-px range scaleByDistance produces. Swap between the 64 px fleet
    // raster and the 192 px close raster on the billboard's ACTUAL on-screen
    // size — post-treatment bb.scale, so focus/limb recession counts — with
    // hysteresis so zoom oscillation never thrashes the atlas.
    if (!p._cockpitContactMode || isCockpitNear) {
      const glyphDevPx = (bb.width || 20) * (bb.scale || 1)
        * distanceScale * (globalThis.devicePixelRatio || 1);
      const wantLarge = bb._gevIconLarge ? glyphDevPx > 56 : glyphDevPx > 76;
      if (wantLarge !== Boolean(bb._gevIconLarge)) {
        bb._gevIconLarge = wantLarge;
        bb.image = aircraftIcon(p._iconKind(icao24, info?.klass), wantLarge ? TRACKED_ICON_PX : undefined);
      }
    }

    // Smoothed display course: the path direction _deadReckon just reported
    // for THIS aircraft (nothing else calls _deadReckon in between), rate-
    // limited so segment-boundary course steps glide instead of snapping.
    // The slew cap eases toward COURSE_MIN_DPS at low speed, and a hovering
    // aircraft (hold flag) keeps its previous nose direction outright.
    const rawCourse = p._drCourseDeg != null ? p._drCourseDeg : ((info && info.true_track) || 0);
    const prevCourse = p._displayCourse.get(icao24);
    const course = (p._drCourseHold && prevCourse != null)
      ? prevCourse
      : limitCourseStep(
        prevCourse, rawCourse,
        courseSlewCapDps(p._drSpeedMps != null ? p._drSpeedMps : ((info && info.velocity) ?? Number.NaN), p.COURSE_MAX_DPS),
        tickDtSec,
      );
    p._displayCourse.set(icao24, course);

    // 3D model takes over from the billboard for in-view planes (modelEligible). GAP-PROOF: the
    // billboard stays shown until the model is actually READY to render, so a plane is never both
    // iconless AND modelless (the "planes vanish when 3D turns on" bug). Position the model every
    // tick regardless so it's framed the instant it becomes ready.
    // Converted TR-3Bs stay 2D on purpose: the Easter egg IS the triangle, and
    // there is no GLB for it, so the model handoff is suppressed rather than
    // fed a stand-in mesh. The billboard keeps rendering (and keeps satisfying
    // the getNearby/getDetectableObjects `bb.show` visibility guards), so a
    // converted contact still works in Contacts and Cockpit.
    if (useModels && dr && modelEligible.has(icao24) && !isTr3b(icao24)) {
      p._ensureModel(icao24);
      const model = p._models.get(icao24);
      const ownsVisual = p._driveFleetModelHandoff(
        icao24,
        model,
        bb,
        dr,
        course,
        () => {
          applyAircraftModelTreatment({
            model,
            // IR boost must survive the per-tick treatment write — otherwise
            // any alpha change would repaint the ordinary tint over the hot
            // white. Boosted models also skip the recession fade: hot targets
            // stay full-strength at any range (billboards keep their normal
            // fade — full-opacity glyph walls read as overwhelming).
            baseColor: p._irBoost ? Cesium.Color.WHITE : _modelColor(icao24),
            alpha: p._irBoost ? 1 : treatment.alpha,
          });
        },
      );
      if (ownsVisual) continue; // skip billboard rotation
    }

    if ((!p._cockpitContactMode || isCockpitNear) && (doRotations || revealed)) {
      const rot = screenProjectedRotation(scene, bb.position, course, bb.rotation);
      if (rot !== null && Math.abs(rot - bb.rotation) > 0.002) {
        bb.rotation = rot;
      }
    }
  }
}

/**
 * Build a public descriptor for one aircraft using its best current position
 * (dead-reckoned when history exists, billboard position otherwise).
 * @param {string} icao24 - ICAO 24-bit transponder address.
 * @returns {{icao24: string, callsign: string|null, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
 *   Descriptor with a cloned position, or null if the aircraft is unknown.
 */
function _describeFlight(icao24) {
  // DATA, NOT PIXELS — deliberately UNFLOORED (2026-08-19). The display floor
  // lifts grounded contacts onto the visible mesh so the sprite you see is not
  // buried; that is a rendering correction, not a measurement. This descriptor
  // feeds query/analyst/subject APIs — `findByQuery` (voice track-by-name),
  // `getTrackedInfo` (cockpit + readout altitude), `getTrackedSubject`
  // (proximity counts and distances) — where the honest answer is what the
  // aircraft REPORTED, not where its icon was nudged to avoid clipping tiles.
  // `altitudeM` is therefore the barometric/aviation value and `renderAltitudeM`
  // the fix-time datum, neither of them the floored display height. No
  // user-visible surface renders `position` as the plane's on-screen location —
  // every visual consumer reads the floored per-frame cache instead (see
  // `_trackedDisplayPosition`). If that ever changes, floor this path too.
  const info = p._flightData.get(icao24);
  const bb = p._billboards.get(icao24);
  const basePos = _deadReckon(icao24) || (bb ? bb.position : null);
  if (!basePos) return null;
  const displayed = displayedKinematics({
    derivedSpeedMps: p._drSpeedMps,
    derivedTrackDeg: p._drCourseDeg,
    reportedSpeedMps: info?.velocity,
    reportedTrackDeg: info?.true_track,
  });
  const carto = Cesium.Cartographic.fromCartesian(basePos, Cesium.Ellipsoid.WGS84, _scratchCarto);
  if (!carto) return null;
  return {
    icao24,
    callsign: String(info?.callsign || '').trim() || null,
    position: Cesium.Cartesian3.clone(basePos),
    latitude: Cesium.Math.toDegrees(carto.latitude),
    longitude: Cesium.Math.toDegrees(carto.longitude),
    // The cockpit instrument reports aviation altitude, not the Cesium
    // ellipsoid height of the camera/ground-clamped render position. The
    // latter can be slightly negative over terrain near the surface.
    altitudeM: Number.isFinite(info?.altitude) ? info.altitude : carto.height,
    renderAltitudeM: Number.isFinite(info?.renderAltitudeM) ? info.renderAltitudeM : carto.height,
    onGround: info?.onGround === true,
    velocityMps: displayed.speedMps,
    track: displayed.trackDeg,
    stale: Boolean(_missingPolls.get(icao24) || _backoff),
    airline: info?.airline ?? null,
    // CLASS label follows the TR-3B conversion so every downstream card
    // (cockpit, Contacts, analyst) agrees with the triangle on screen.
    typeName: tr3bTypeLabel(icao24, info?.typeName ?? null),
    typeCode: tr3bTypeLabel(icao24, info?.typeCode ?? null),
    // IDENTITY, deliberately NOT converted: registration is the airframe's tail
    // number and feeds `_contactLabel`'s callsign → registration → hex chain, so
    // a converted contact keeps the label convention every other contact uses.
    // Trimmed like `callsign` above so every consumer (cockpit readout, voice
    // narration, getTrackedSubject) can use it as a label link without
    // re-guarding a whitespace-only enrichment value.
    registration: p._toCleanText(info?.registration) || null,
    origin: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.origin.code : null,
    destination: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.destination.code : null,
    route: info?.route && _routeIsPlausible(icao24, info.route) ? {
      origin: { ...info.route.origin },
      destination: { ...info.route.destination },
    } : null,
  };
}


/**
 * Renders the trail with its head clamped to the render-behind display
 * position. Raw newest fixes run up to p.RENDER_DELAY_SEC ahead of the
 * displayed aircraft (PRD C2 delayed clock) — drawing them verbatim makes
 * the trail extend in FRONT of the icon. The head is refreshed ~1Hz from
 * the fleet tick so it stays glued to the moving aircraft.
 */
function _refreshTrailDisplay() {
  // The trail BODY is the accumulated fixes EXCLUDING the newest raw one — that newest
  // fix is at ~now, ~one poll interval AHEAD of the delayed icon (rendered at
  // now − p.RENDER_DELAY_SEC), so drawing it would push the trail in front of the plane.
  // The cheap per-frame p._trailHeadEntity segment bridges the last body point to the
  // delayed dead-reckoned head, so the body primitive only rebuilds on a real fix
  // (poll cadence), never at motion cadence.
  if (!p._trail) return;
  p._trail.setPositions(p._trailPositions.length > 1 ? p._trailPositions.slice(0, -1) : p._trailPositions);
}

/**
 * Start the trail for a newly tracked aircraft: seed it with the short
 * dead-reckoning history (chronological), render immediately, then
 * fire-and-forget an OpenSky track backfill.
 * @param {string} icao24 - ICAO 24-bit transponder address being tracked.
 */
function _startTrail(icao24) {
  p._trailBackfillToken += 1;
  p._trailPositions = [];
  const history = p._positionHistory.get(icao24) || [];
  // Seed only fixes at/behind the DELAYED display time (now − p.RENDER_DELAY_SEC). The
  // newest ~p.RENDER_DELAY_SEC of fixes are AHEAD of the displayed icon; including them
  // would draw the trail in front of the plane. They join the trail via p._appendTrailFix
  // as they age past the delay.
  const seedRenderTime = Cesium.JulianDate.addSeconds(
    Cesium.JulianDate.now(), -p.RENDER_DELAY_SEC, p._scratchWarmupTime
  );
  for (const fix of history) {
    if (Cesium.JulianDate.lessThanOrEquals(fix.time, seedRenderTime)) {
      p._trailPositions.push(Cesium.Cartesian3.clone(fix.position));
    }
  }
  if (!p._trail && p._viewer) {
    p._trail = createTrail(p._viewer, { color: TRAIL_COLOR, width: 2.5 });
  }
  p._trail?.setVisible(!p._cockpitContactMode);
  // Live head segment: last fix → current dead-reckoned icon, updated every frame via
  // a CallbackProperty (Cesium updates entity-polyline positions cheaply, unlike the
  // trail primitive which fully rebuilds on setPositions). Keeps the head glued to the
  // 12 Hz icon instead of lagging ~1 s behind it.
  if (!p._trailHeadEntity && p._viewer) {
    p._trailHeadEntity = p._viewer.entities.add({
      // 'gev-trail' namespace (round 6): claimed by trailRenderer's pick
      // owner so a click on the head segment never reads as empty space.
      id: `gev-trail:fl-head-${++_trailHeadSeq}`,
      show: !p._cockpitContactMode,
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          // Need ≥2 accumulated points: the body draws all-but-newest, so the head must
          // start at the last DISPLAYED body point (index n−2). With a single fix that
          // point would be the sole raw fix — which is ~now, AHEAD of the delayed icon —
          // so the segment would draw IN FRONT of the plane. Likewise during warm-up the
          // icon predates all real history, so there is no valid body point behind it.
          if (!p._trackedIcao || p._trailPositions.length < 2 || p._isTrackWarmingUp()) return [];
          const head = p._trackedTrailCached() || _trackedDisplayPosition(p._trackedIcao);
          if (!head) return [];
          // body[n−2] (last displayed body point) → delayed head: runs FORWARD, never a
          // backward/reversing segment.
          const start = p._trailPositions.at(-2);
          // On a contact that has not moved this segment runs from inside the
          // model out to its own anchor — a line through the fuselage. The END
          // never gives, so a moving trail still terminates on the tail; the
          // START is what slides, from nothing on a parked contact out to the
          // whole segment once it has cleared its own envelope.
          // See trailHeadStart. Read `head` in place and clone only on the draw
          // path — a suppressed parked contact runs this every frame.
          const from = trailHeadStart(
            start, head, p._trackedModelCenterWorld(), p._trackedModelEnvelopeM(), _scratchTrailHead,
          );
          if (!from) return [];
          return [from, Cesium.Cartesian3.clone(head)];
        }, false),
        width: 2.5,
        material: Cesium.Color.fromCssColorString(TRAIL_COLOR).withAlpha(0.9),
        // Round 4: the head must never vanish into the mesh either (dimmed
        // when occluded so depth still reads).
        depthFailMaterial: Cesium.Color.fromCssColorString(TRAIL_COLOR).withAlpha(0.45),
        arcType: Cesium.ArcType.GEODESIC, // round 8: consistent with the trail body (no chords)
      },
    });
  }
  _refreshTrailDisplay();

  const oldestFixEpochSec = history.length
    ? Cesium.JulianDate.toDate(history[0].time).getTime() / 1000
    : Infinity;
  _backfillTrail(icao24, p._trailBackfillToken, oldestFixEpochSec);
}

/**
 * Fire-and-forget OpenSky /tracks backfill (PRD F1). On success, splices
 * waypoints strictly older than the oldest seeded fix AHEAD of the locally
 * accumulated fine segment, capped at p.TRAIL_MAX_POINTS (newest kept). Any
 * failure (404/429/timeout/malformed) silently keeps the local-only trail.
 * @param {string} icao24 - ICAO 24-bit transponder address being tracked.
 * @param {number} token - Backfill token captured at request time.
 * @param {number} oldestFixEpochSec - Epoch seconds of the oldest seeded fix.
 * @returns {Promise<void>}
 */
async function _backfillTrail(icao24, token, oldestFixEpochSec) {
  let path = null;
  try {
    const response = await fetch(api.openskyTrack(icao24), {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const data = await response.json();
    path = Array.isArray(data?.path) ? data.path : null;
  } catch {
    return; // silent fallback to the accumulated trail
  }
  if (!path || token !== p._trailBackfillToken || icao24 !== p._trackedIcao) return;

  // OpenSky track waypoints: [time, latitude, longitude, baro_altitude, true_track, on_ground]
  // Height-datum fix (Task 6): /tracks only ever reports barometric/MSL altitude
  // (no per-waypoint geo_altitude in this endpoint), so waypoint render height is
  // the documented visual FALLBACK baroM + geoidHeight(waypointLat, waypointLon)
  // — geometrically approximate, not exact, same honesty caveat as the live
  // baro-fallback branch of pickRenderAltitudeM.
  await ensureGeoidReady();
  const parsed = [];
  for (const waypoint of path) {
    if (!Array.isArray(waypoint)) continue;
    const [time, lat, lon, baroAlt] = waypoint;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!Number.isFinite(time) || time >= oldestFixEpochSec) continue;
    parsed.push({ lat, lon, baroAlt });
  }
  if (!parsed.length) return;

  // Field-test fix (WAKE01 trail-underground, 2026-07-06 — mirror of
  // militaryFlights.js): resolve the coarse ellipsoidal ground along the track
  // and floor every waypoint at it so low baro segments never dive below the
  // mesh; a no-baro waypoint (predominantly taxi/ground segments in /tracks)
  // sits ON the surface when the floor is known.
  // Round-2 fix: the
  // resolve is BOUNDED (≤1.2 s), not a blocking await — a cold Re:Earth
  // lookup across a long path could stall the paint for seconds-to-timeout.
  // Paint with whatever cells are warm; the resolve keeps filling the cache
  // in the background for the next paint/select.
  await resolveGroundFloorCellsBounded(parsed);
  // Re-check the backfill token after the await (same guard as post-fetch):
  // tracking may have moved on while the terrain race was in flight.
  if (token !== p._trailBackfillToken || icao24 !== p._trackedIcao) return;

  const older = [];
  let lastAltM = null; // carry-forward for no-baro points whose cell isn't warm yet
  for (const { lat, lon, baroAlt } of parsed) {
    const baroM = Number.isFinite(baroAlt) ? baroAlt + geoidHeight(lat, lon) : null;
    let altM = floorAltitudeM(baroM, cachedGroundFloor(lat, lon));
    // No baro + unresolved floor: hold the previous waypoint's altitude
    // (continuity — never a dive/spike to a made-up height). Leading points
    // with nothing to carry keep the old 10 km airborne default.
    if (altM == null) altM = lastAltM != null ? lastAltM : 10000;
    lastAltM = altM;
    older.push(Cesium.Cartesian3.fromDegrees(lon, lat, altM));
  }

  p._trailPositions = older.concat(p._trailPositions);
  if (p._trailPositions.length > p.TRAIL_MAX_POINTS) {
    p._trailPositions = p._trailPositions.slice(p._trailPositions.length - p.TRAIL_MAX_POINTS);
  }
  _refreshTrailDisplay();
}



/**
 * Stop tracking the currently followed aircraft.
 *
 * Restores the hidden billboard, removes the tracked Entity, resets lerp
 * state, and RELEASES the camera IN PLACE — no flyTo. Deselect used to fly
 * an ~80 km pulled-back overview; the owner field-ruled that wrong
 * (2026-07-02: "it randomly zooms way up and loses my context"). The camera
 * now simply stays at its current position/orientation, immediately free to
 * orbit/zoom. Applies to every deselect path: click-empty-space, Escape,
 * aged-out plane, layer disable, and voice stopTracking.
 *
 * @param {boolean} [skipViewerUntrack=false] - ANOTHER layer just grabbed the
 *   follow-camera: tear down our own state but leave viewer.trackedEntity
 *   alone (the new owner controls it).
 * @param {object} [options] - Clear origin.
 * @param {boolean} [options.evicted=false] - The contact aged out of the feed
 *   rather than being deselected. Consumers that keep a readout on screen
 *   (the Cockpit Contact panel) hold last-known values for an eviction and
 *   only tear down on a deliberate clear.
 * @param {string} [options.origin='programmatic'] - Deselect provenance forwarded on the
 *   gev:awareness-subject-cleared event ('user', 'voice', 'share-restore', or 'programmatic').
 */
function _clearTracking(skipViewerUntrack = false, {
  evicted = false,
  origin = 'programmatic',
} = {}) {
  _trackedCameraFrameStop?.();
  _trackedCameraFrameStop = null;
  if (!p._trackedIcao) {
    clearFocusTarget('flights');
    return;
  }
  const clearedIcao = p._trackedIcao;
  clearFocusTarget('flights', clearedIcao);

  // Restore the original billboard appearance. The rotation is re-seeded from
  // the tracked entity's last rendered rotation and a rotation pass is forced
  // (p._lastCamPoseSig below): the fleet billboard otherwise reappears with the
  // STALE screen rotation it had when tracking began — up to a full
  // ROTATION_REFRESH_MS of a wrong (possibly reversed) nose on release.
  if (p._billboards.has(p._trackedIcao)) {
    const bb = p._billboards.get(p._trackedIcao);
    bb.show = true;
    bb.width = 20;
    bb.height = 20;
    // Ground/military-aware restore (a plane untracked while taxiing must come
    // back muted-gray at ground scale, not white at full scale).
    bb.color = _fleetBillboardColor(p._trackedIcao);
    bb.scale = _fleetBillboardScale(p._trackedIcao, p._flightData.get(p._trackedIcao)?.klass);
    bb.rotation = p._lastTrackedRotation;
  }
  p._lastCamPoseSig = ''; // force a fleet rotation pass on the next tick

  // Stop tracking and remove the entity. skipViewerUntrack: when ANOTHER layer just grabbed the
  // follow-camera, we tear down our own state but must NOT clear viewer.trackedEntity (the new owner
  // controls it now — clearing it would yank the camera off their plane). Releasing trackedEntity
  // does NOT move the camera: Cesium resets the lookAt transform in place, so the view stays where
  // the follow left it and the user can immediately orbit/zoom.
  if (p._viewer && !skipViewerUntrack) {
    p._viewer.trackedEntity = undefined;
  }
  if (p._trackedEntity) {
    p._viewer.entities.remove(p._trackedEntity);
    p._trackedEntity = null;
  }
  p._releaseTrackedModel();
  p._resetTrackedSelectionState(); // the zoom band + load-failure budget belong to the selection we just dropped
  p._trackedIcao = null;
  p._applyFleetBillboardPresentation(clearedIcao, p._billboards.get(clearedIcao));
  clearTrackedSubjectContext('flights');
  p._emitAwarenessEvent('gev:awareness-subject-cleared', {
    layerId: 'flights',
    id: clearedIcao,
    origin,
    reason: evicted ? 'evicted' : 'deliberate',
  });
  // Invalidate the per-frame DR cache + reconciliation state so a same-frame re-track
  // cannot read the previous aircraft's cached/smoothed position.
  p._resetTrackedDisplay();
  p._clearTrail();
}


function _isUsableOpenSkyState(state) {
  if (!Array.isArray(state) || typeof state[0] !== 'string' || !p._normalizeTrackedIcao(state[0])) {
    return false;
  }
  return Number.isFinite(state[5]) && Number.isFinite(state[6]);
}

/**
 * Whether the Military layer suppresses this civil duplicate right now.
 *
 * The dedicated Military layer owns icon/track/click for known-military
 * contacts, so the OpenSky duplicate is dropped while that layer is on. Two
 * contacts are exempt, both for the same reason — this layer still owns them:
 *
 *   - the CURRENTLY tracked one, which hands off on untrack; and
 *   - a target this layer is holding on its deferred-restore latch.
 *
 * The second exemption is what makes a shared/local Follow of a mil-registry
 * hex restorable at all. The accepted-snapshot id set is built BEFORE this
 * suppression runs, so without it the target is provably present in a healthy
 * feed yet has no billboard, `trackById` fails, and the restore reports
 * "feed unavailable" about a feed that was perfectly fine.
 *
 * @param {string} icao24 - Normalized ICAO 24-bit address.
 * @returns {boolean} True when the civil duplicate must be dropped.
 */
function _militaryLayerSuppresses(icao24) {
  if (!isMilitaryLayerActive()) return false;
  if (icao24 === p._trackedIcao) return false;
  if (icao24 === p._pendingTrackingRestore?.id) return false;
  return true;
}



/** Multi-line tracked presentation text: "CS · FL · kts" + "Airline · Type" +
 *  "ORIG → DEST". The route line is gated by
 *  routePlausible so a wrong-leg adsbdb route is hidden, not displayed.
 *  While the plane is in its missed-poll grace (coasting on dead reckoning
 *  with sticky metadata), the first line carries a "· STALE" cue — the fleet's
 *  45%-alpha billboard fade doesn't apply to the tracked plane (its entity
 *  owns the visual), so without this the readout would present last-known
 *  velocity/altitude as live. */
function _trackedLabelText(icao24) {
  const info = p._flightData.get(icao24);
  if (!info) return icao24;
  // A whitespace-only callsign ("   ") is truthy, so `(info.callsign || icao24)`
  // kept it, then .trim() emptied it → the callsign slot dropped out of the
  // readout. `_contactLabel` trims FIRST, then falls through registration to
  // the ICAO hex, so a callsign-less enriched contact heads its readout with
  // the tail number rather than raw hex.
  const cs = _contactLabel(icao24, info);
  const altFt = Math.round((info.altitude || 0) * 3.28084);
  const fl = altFt >= 18000 ? `FL${Math.round(altFt / 100)}` : `${altFt} ft`;
  const spd = info.velocity ? `${Math.round(info.velocity * 1.944)} kts` : '';
  const stale = (_missingPolls.get(icao24) || _backoff) ? 'STALE' : '';
  const lines = [[cs, fl, spd, stale].filter(Boolean).join(' · ')];
  // Ground context under the track: "over Austin, Texas" from the OpenZenith
  // reverse-geocode, resolved once per contact (browser-cached 30 d by cell).
  if (info.placeLabel) lines.push(info.placeLabel);
  // Converted contacts report their class as TR-3B and nothing else — the
  // operator/type identity is exactly what the Easter egg is replacing.
  const ident = isTr3b(icao24)
    ? tr3bTypeLabel(icao24)
    : [info.airline, info.typeName || info.typeCode].filter(Boolean).join(' · ');
  if (ident) lines.push(ident);
  if (info.route && _routeIsPlausible(icao24, info.route)) {
    lines.push(`${info.route.origin.code} → ${info.route.destination.code}`);
  }
  return lines.join('\n');
}



/**
 * Re-render one contact after its TR-3B conversion (or the active IR style)
 * changed. Converting drops any 3D model so the triangle owns the visual; the
 * billboard image, tracked entity, and tracked card are all re-derived here.
 * @param {string} icao24 - ICAO 24-bit address.
 * @returns {boolean} True when the layer owns this contact.
 */
function _refreshTr3bContact(icao24) {
  const id = String(icao24 || '').trim().toLowerCase();
  if (!id) return false;
  if (isTr3b(id)) {
    // Drop the 3D handoff for this contact — the fleet tick now skips it, so
    // an already-loaded model would otherwise linger with the billboard hidden.
    if (p._models.has(id) || p._modelPending.has(id)) p._releaseModel(id);
    const bb = p._billboards.get(id);
    if (bb && id !== p._trackedIcao) bb.show = true; // horizon cull re-asserts next tick
    if (id === p._trackedIcao) {
      p._releaseTrackedModel();
      p._syncTracked2dRotation();
    }
  }
  const bb = p._billboards.get(id);
  if (bb) p._applyFleetBillboardPresentation(id, bb);
  if (id === p._trackedIcao) {
    p._syncTrackedBillboardImage();
    p._updateTrackedLabelModel(id);
  }
  p._viewer?.scene?.requestRender?.();
  return p._billboards.has(id) || id === p._trackedIcao;
}


/**
 * Seed only the mutable state needed to exercise tracked-card refreshes through
 * the production poll reconciler. Tests still call `flightsLayer.update()`;
 * this seam avoids constructing the browser-only Cesium layer lifecycle.
 * @param {object} state
 * @param {string} state.icao24
 * @param {object} state.entity
 * @param {object} state.meta
 * @param {object} state.billboard
 * @param {object} state.billboardCollection
 * @param {object} state.viewer
 * @param {Array<object>} [state.history=[]]
 * @param {boolean} [state.tracked=true]
 * @param {Iterable<[string, object]>} [state.models=[]] - Fleet 3D models keyed
 *   by icao24, for the billboard-hidden/model-shown handoff state.
 * @param {object} [state.modelCollection=null] - Primitive collection hosting the fleet
 *   3D models; hidden when the layer disables.
 */
export function _setTrackedFlightRefreshStateForTest({
  icao24,
  entity,
  meta,
  billboard,
  billboardCollection,
  viewer,
  history = [],
  tracked = true,
  models = [],
  modelCollection = null,
}) {
  p._viewer = viewer;
  p._modelCollection = modelCollection;
  p._billboardCollection = billboardCollection;
  p._billboards = new Map([[icao24, billboard]]);
  p._models.clear();
  for (const [key, model] of models) p._models.set(key, model);
  _detectionObjects = new Map();
  p._flightData = new Map([[icao24, meta]]);
  p._positionHistory = new Map([[icao24, history]]);
  _missingPolls = new Map();
  p._displayCourse.clear();
  _geoidNCache.clear();
  p._trackedIcao = tracked ? icao24 : null;
  p._trackedEntity = tracked ? entity : null;
  p._trackedModel = null;
  p._cancelPendingTrackingRestore();
  p._trackedModelLoading = false;
  // NOTE: deliberately does NOT reset the per-selection latches. They are
  // production state owned by the tracking lifecycle (p._resetTrackedSelectionState),
  // and clearing them here would mask exactly the deselect→re-track hole this
  // seam is used to test.
  _backoff = false;
  _retryAt = 0;
}

/** Seed the authoritative snapshot outcome used by share-Follow tests. */
export function _setFlightTrackingRefreshOutcomeForTest({
  status = 'accepted',
  ids = [],
  source = 'OpenSky Network',
  coverage = 'test',
} = {}) {
  const epoch = ++_trackingRefreshEpoch;
  _lastTrackingRefreshOutcome = {
    epoch,
    status,
    ids: new Set(ids.map((id) => String(id).trim().toLowerCase())),
    source,
    coverage,
  };
}

/** Add a cached contact so tests can model a target arriving on a later feed. */
export function _addFlightTrackingCandidateForTest({ icao24, meta, billboard, history = [] }) {
  p._billboards.set(icao24, billboard);
  p._flightData.set(icao24, meta);
  p._positionHistory.set(icao24, history);
}

/** Expose the military-suppression decision for the civil duplicate. */
export function _militaryLayerSuppressesForTest(icao24) {
  return _militaryLayerSuppresses(icao24);
}

/** Arm the deferred restore latch directly, without a full setParams turn. */
export function _armFlightTrackingRestoreForTest(id, origin = 'share-restore') {
  p._pendingTrackingRestore = id === null
    ? null
    : { id, generation: p._trackingIntentGeneration, origin };
}

/** Return the deferred restore target held by the production tracker. */
export function _pendingFlightTrackingRestoreForTest() {
  return p._pendingTrackingRestore?.id ?? null;
}

/** Exercise the production deferred-restore retry after a simulated feed refresh. */
export function _applyPendingFlightTrackingRestoreForTest() {
  return p._applyPendingTrackingRestore();
}







/** Plausibility check anchored to the plane's billboard position (coarse is
 *  fine here — this gates a LABEL, and it must not touch the tracked frame
 *  cache). Missing data → true (never hide what we can't judge). */
function _routeIsPlausible(icao24, route) {
  const info = p._flightData.get(icao24);
  const bb = p._billboards.get(icao24);
  if (!info || !bb || !bb.position) return true;
  const carto = Cesium.Cartographic.fromCartesian(bb.position, Cesium.Ellipsoid.WGS84, _scratchCarto);
  if (!carto) return true;
  return routePlausible({
    latDeg: Cesium.Math.toDegrees(carto.latitude),
    lonDeg: Cesium.Math.toDegrees(carto.longitude),
    altitudeM: info.altitude ?? null,
    verticalRateMps: info.verticalRate ?? null,
    origin: route.origin,
    destination: route.destination,
  });
}

/**
 * Begin tracking a specific aircraft by ICAO24 address.
 *
 * Clears any existing tracked flight, hides its billboard, and creates a
 * new Entity with:
 *  - A CallbackProperty position driven by dead-reckoning (_deadReckon).
 *  - A CallbackProperty alignedAxis set to the surface normal at the
 *    dead-reckoned position (keeps the icon tangent to the earth).
 *  - A CallbackProperty rotation from the aircraft's true_track heading.
 *  - An explicit host presentation model with callsign, flight level, speed,
 *    identity, and plausible route text.
 *
 * The viewer's trackedEntity is set to this entity so the camera follows it.
 *
 * @param {string} icao24 - ICAO 24-bit transponder address to track.
 */
function _trackFlight(icao24, { origin = 'programmatic' } = {}) {
  _clearTracking(false, { origin }); // switching planes — the new follow-camera takes over

  const bb = p._billboards.get(icao24);
  const info = p._flightData.get(icao24);
  if (!bb || !info) return;

  p._trackedIcao = icao24;
  p._resetTrackedSelectionState(); // fresh selection: enter at the ENTER ceiling, full load-retry budget
  p._cachedDRFrame = -1;
  p._lastTrackedRotation = bb.rotation || 0;
  // Drop any fleet 3D model for this aircraft — the tracked entity now owns its visual (its
  // own billboard + model graphic), and the fleet tick skips the tracked icao, so a leftover
  // fleet model would be orphaned + double-rendered.
  p._releaseModel(icao24);

  // Hide the billboard — the tracked entity replaces it visually
  bb.show = false;

  // Helper: smoothed, per-frame-cached tracked position (see _trackedDisplayPosition —
  // one computation shared by the position/alignedAxis/rotation/trail-head callbacks,
  // with discontinuity reconciliation). Falls back to the last billboard position when
  // the aircraft has no fix.
  const getTrackedPosition = () => _trackedDisplayPosition(icao24) || bb.position;

  // Dead-reckoning position property — smooth continuous motion between API updates.
  const positionProperty = new Cesium.CallbackProperty(() => {
    return getTrackedPosition();
  }, false);

  // Create tracked entity: a 2D billboard when zoomed out, a 3D model when zoomed in past the
  // TRACKED altitude ceiling. That handoff is DEFAULT behaviour — it does NOT wait on the
  // DISPLAY-rail 3D toggle, which arms the FLEET. The plane the user zooms into always
  // resolves into an aircraft.
  //
  // The billboard stays SHOWN at all times and is hidden by going TRANSPARENT (alpha 0), not by
  // show=false. This is deliberate: viewer.trackedEntity derives the follow-camera framing from
  // the entity's bounding sphere, and a 3D model graphic reports a PENDING sphere until its glTF
  // finishes loading. If we hid the billboard outright, tracking a plane while already zoomed in
  // would stall the centering until the model loaded. A shown-but-transparent billboard always
  // supplies a ready sphere, so framing is instant; we only drop its alpha once the model GLB is
  // preloaded (p._planeModelLoaded), so there's neither a billboard+model double-image nor a gap.
  // The tracked entity is a PURE BILLBOARD — no label or model graphic. The 3D model for the
  // tracked plane is a standalone primitive driven by _updateTrackedModel(); keeping it off the
  // entity is what makes the follow-camera's bounding sphere always ready (see p._trackedModel).
  // Keep Cesium's generated entity ID: re-init without destroy can temporarily
  // overlap collections, and an explicit ICAO ID would throw on that duplicate.
  p._trackedEntity = p._viewer.entities.add({
    position: positionProperty,
    // Force Cesium's built-in EntityView and our close-range camera guard to
    // use the same local frame. AUTO can select a velocity frame while the
    // model matrix uses aircraft orientation; alternating between those
    // frames makes the target oscillate forward/back on screen.
    trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
    billboard: {
      image: aircraftIcon(p._iconKind(p._trackedIcao, p._flightData.get(p._trackedIcao)?.klass), TRACKED_ICON_PX),
      width: 28,
      height: 28,
      scale: CLASS_SCALE_2D[p._flightData.get(p._trackedIcao)?.klass] || 1,
      // Solid cyan when the billboard is the visual (zoomed out, 3D off, or model still loading);
      // transparent once the STANDALONE tracked model is actually up (ready + shown).
      color: new Cesium.CallbackProperty(() => (
        p._modelOwnsVisual(p._trackedIcao) ? CYAN_TRANSPARENT : Cesium.Color.CYAN
      ), false),
      sizeInMeters: false,
      scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5),
      alignedAxis: Cesium.Cartesian3.ZERO,
      // The tracked target must never vanish into tile geometry — tracking a
      // taxiing plane at street level would otherwise bury the cyan icon inside
      // the runway skin exactly like the fleet ground icons (p._groundDepthDistance);
      // its shared-host tracked card is top-composited separately.
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      // Screen-projected rotation, evaluated per frame: exact in tracked-orbit
      // mode where camera.heading lives in the entity's reference frame.
      rotation: new Cesium.CallbackProperty(() => {
        const tracked = p._flightData.get(p._trackedIcao);
        const pos = getTrackedPosition();
        if (!tracked || !pos || !p._viewer) return p._lastTrackedRotation;
        const projected = screenProjectedRotation(
          p._viewer.scene,
          pos,
          p._trackedDisplayCourse(),
          p._lastTrackedRotation,
        );
        const rot = stabilizeScreenRotation(p._lastTrackedRotation, projected);
        if (rot !== null) p._lastTrackedRotation = rot;
        return p._lastTrackedRotation;
      }, false),
    },
  });
  p._trackedEntity.gevSelectionOrigin = origin;
  p._trackedEntity.gevTrackedId = `flights:${icao24}`;
  p._trackedEntity.gevLabelModel = trackedLabelModelFromText(_trackedLabelText(icao24), '#39d0ff');

  // A billboard has a ~zero bounding sphere, so Cesium's default follow distance is
  // far too tight (the user had to scroll out to read the plane). Give the entity a
  // calibrated viewFrom — behind + above, distance scaled to altitude — for a readable
  // initial frame with surrounding context. (ENU: east=+X, north=+Y, up=+Z.)
  const followRange = Math.min(Math.max((info.altitude || 1500) * 1.1 + 2500, 3000), 30000);
  p._trackedEntity.viewFrom = new Cesium.Cartesian3(0, -followRange * 0.8, followRange * 0.55);

  // Cancel any in-progress camera flight first — otherwise Cesium won't apply the
  // tracked entity's viewFrom on the first frame, so voice-initiated tracking (which
  // often fires mid-fly_to_location) would follow the plane WITHOUT centering/framing it
  // the way a click (idle camera) does.
  // Expose the camera's already-settled position to cross-module HUD consumers (the tracked-target
  // readout) so they draw at the SAME spot the camera framed, without recomputing the dead-reckon in
  // postRender (which would jitter the label against the now-stable plane).
  p._trackedEntity.gevDisplayPosition = p._trackedDisplayCached;
  // Separate accessor on purpose: `gevDisplayPosition` carries the follow-camera
  // anti-jitter contract and must keep returning the cached DR position. Presentation
  // that should weld to the AIRCRAFT YOU SEE reads `gevVisualPosition` instead.
  p._trackedEntity.gevVisualPosition = p._trackedVisualCached;
  refreshTrackedReadout(p._trackedEntity);
  p._viewer.camera.cancelFlight();
  // Camera follows the tracked entity
  p._viewer.trackedEntity = p._trackedEntity;
  _trackedCameraFrameStop = applyTrackedCameraFrame(
    p._viewer,
    p._trackedEntity,
    p._trackedEntity.viewFrom,
  ) || null;

  // Track-history trail (PRD F1): seed from local history + async backfill.
  // Ground traffic draws NO trail (a taxi path is noise, not a track) — if the
  // plane takes off while tracked, the on_ground→false transition in update()
  // starts one.
  _requestTypeEnrichment(icao24, true); // tracked plane — front of the enrichment queue
  _requestRouteEnrichment(icao24);
  _requestPlaceContext(icao24);
  // Round 2 (owner): grounded contacts get trails too — a landed-but-taxiing
  // aircraft's history is retrievable on select. Grounded flights positions
  // are already surface-clamped (the surfaceM chain), so seeds/appends drape.
  _startTrail(icao24);

  _publishTrackedSelection(icao24, origin);

  logDebug('Data:Flights', `Tracking ${_contactLabel(icao24, info)} (${icao24})`);
}

/**
 * Immediate military-suppression handoff sweep (pre-ship audit M2).
 *
 * The poll-time suppression branch in update() only reconciles every 30 s, so
 * toggling the Military layer showed duplicate icons (military ON: both layers
 * render the same aircraft ~3-4 km apart) or holes (military OFF: suppressed
 * aircraft absent) for up to a full poll. Fired synchronously by the registry
 * on the active-state TRANSITION:
 *
 *  - activated  → suppress known-military billboards NOW (mirror of the
 *    poll-time branch, tracked aircraft excluded — it hands off on untrack);
 *  - deactivated → the suppressed aircraft's state was deleted, so bring the
 *    next OpenSky poll forward instead of waiting out the interval (update()
 *    itself still honors _retryAt backoff).
 *
 * @param {boolean} active - New military-layer active state.
 * @returns {void}
 */
function _onMilitaryActiveChange(active) {
  if (!p._viewer || !p._billboardCollection) return;
  if (active) {
    for (const [icao24, bb] of p._billboards) {
      if (!isMilitaryIcao(icao24) || icao24 === p._trackedIcao) continue;
      p._billboardCollection.remove(bb);
      p._billboards.delete(icao24);
      p._releaseModel(icao24); // military-suppression: drop any 3D model too
      p._flightData.delete(icao24);
      p._positionHistory.delete(icao24);
      p._displayCourse.delete(icao24);
      p._groundSnap.forget(icao24);
      _missingPolls.delete(icao24);
    }
    _count = p._billboards.size;
  } else if (p._billboardCollection.show) {
    // Fire-and-forget refresh; only while the layer is actually enabled.
    void flightsLayer.update(p._viewer);
  }
}

/**
 * Map one aircraft's internal poll record to a plain JSON-safe analyst
 * record (analyst query engine seam). Pure — no Cesium types, no fetches;
 * enrichment fields read the CACHED adsbdb values only. Missing/unknown
 * fields are null, never NaN/undefined. The route-plausibility verdict is
 * computed by the CALLER (it needs the billboard position) and passed in,
 * so an implausible cached route is never surfaced as fact.
 * @param {string} icao24 - ICAO 24-bit transponder address.
 * @param {object|null|undefined} info - `p._flightData` record for this aircraft.
 * @param {{military?: boolean, routeOk?: boolean}} [flags] - Shared-registry
 *   military flag + route-plausibility verdict.
 * @returns {{id: string, icao24: string, callsign: string|null, lat: number|null,
 *   lon: number|null, altitudeM: number|null, speedMps: number|null,
 *   heading: number|null, verticalRateMps: number|null, onGround: boolean,
 *   military: boolean, aircraftClass: string|null, originCountry: string|null,
 *   operator: string|null, routeOrigin: string|null, routeDestination: string|null}}
 */
export function mapAnalystRecord(icao24, info, { military = false, routeOk = false } = {}) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const callsign = text(info?.callsign);
  return {
    // Display identity for the narration layer. `id` is NOT a queryable field
    // (see ANALYST_LAYERS) and follow-ups carry whole records, so this is a
    // label, not a key — the engine keys on `icao24` below.
    id: callsign || text(info?.registration) || icao24,
    icao24,
    callsign,
    lat: num(info?.rawLat),
    lon: num(info?.rawLon),
    altitudeM: num(info?.altitude), // barometric/MSL — the aviation field, not the render height
    speedMps: num(info?.velocity),
    heading: num(info?.true_track),
    verticalRateMps: num(info?.verticalRate),
    onGround: info?.onGround === true,
    military,
    // A converted contact reports the class it RENDERS as, so an analyst
    // filter/superlative agrees with the triangle on screen.
    aircraftClass: tr3bAircraftClass(icao24, text(info?.klass)),
    originCountry: text(info?.originCountry),
    operator: text(info?.airline),
    routeOrigin: routeOk ? text(info?.route?.origin?.code) : null,
    routeDestination: routeOk ? text(info?.route?.destination?.code) : null,
  };
}

/** Resolve a JSON-safe evidence position into ECEF. DEV-only caller. */
function _focusEvidencePosition(record) {
  const cartesian = record?.cartesian;
  if (Array.isArray(cartesian) && cartesian.length >= 3
    && cartesian.slice(0, 3).every(Number.isFinite)) {
    return Cesium.Cartesian3.fromElements(cartesian[0], cartesian[1], cartesian[2]);
  }
  if (!Number.isFinite(record?.longitude) || !Number.isFinite(record?.latitude)) return null;
  return Cesium.Cartesian3.fromDegrees(
    record.longitude,
    record.latitude,
    Number.isFinite(record.altitudeM) ? record.altitudeM : 3_000,
  );
}

/** Replace the real fleet with deterministic explicit-position contacts. */
function _setFocusEvidenceAircraft(records = []) {
  if (!FOCUS_EVIDENCE_DEV || !p._billboardCollection || !p._viewer) return { ok: false, count: 0 };
  if (p._trackedIcao) _clearTracking();
  p._releaseModels();
  for (const bb of p._billboards.values()) p._billboardCollection.remove(bb);
  p._billboards.clear();
  p._flightData.clear();
  p._positionHistory.clear();
  p._displayCourse.clear();
  _missingPolls.clear();
  _focusEvidenceIds.clear();

  for (const record of Array.isArray(records) ? records : []) {
    const id = String(record?.id || '').trim().toLowerCase();
    const position = _focusEvidencePosition(record);
    if (!id || !position) continue;
    const klass = record.klass || 'airliner';
    const altitudeM = Number.isFinite(record.altitudeM)
      ? record.altitudeM
      : (Cesium.Cartographic.fromCartesian(position)?.height || 3_000);
    const meta = {
      callsign: String(record.callsign || id).toUpperCase(),
      altitude: altitudeM,
      renderAltitudeM: altitudeM,
      velocity: Number.isFinite(record.velocityMps) ? record.velocityMps : 0,
      true_track: Number.isFinite(record.trackDeg) ? record.trackDeg : 90,
      klass,
      onGround: false,
      wasAirborne: true,
      turnRateDps: 0,
      lastContactEpochMs: Date.now(),
      rawLat: record.latitude ?? null,
      rawLon: record.longitude ?? null,
      cullPosition: null,
    };
    p._flightData.set(id, meta);
    _focusEvidenceIds.add(id);
    const bb = p._billboardCollection.add({
      position,
      image: aircraftIcon(p._iconKind(id, klass)),
      width: 20,
      height: 20,
      scale: _fleetBillboardScale(id, klass),
      rotation: 0,
      alignedAxis: Cesium.Cartesian3.ZERO,
      color: _fleetBillboardColor(id),
      sizeInMeters: false,
      scaleByDistance: _normalBillboardScaleByDistance(),
      disableDepthTestDistance: p._groundDepthDistance(),
      id,
      show: true,
    });
    p._billboards.set(id, bb);
  }
  _count = p._billboards.size;
  p._lastFleetTickMs = 0;
  p._viewer.scene.requestRender?.();
  return { ok: true, count: _count };
}

/** Update explicit evidence positions without rebuilding billboards. */
function _moveFocusEvidenceAircraft(records = []) {
  if (!FOCUS_EVIDENCE_DEV) return { ok: false, moved: 0 };
  let moved = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const id = String(record?.id || '').trim().toLowerCase();
    if (!_focusEvidenceIds.has(id)) continue;
    const position = _focusEvidencePosition(record);
    const bb = p._billboards.get(id);
    if (!position || !bb) continue;
    bb.position = position;
    const meta = p._flightData.get(id);
    if (meta) {
      if (Number.isFinite(record.trackDeg)) meta.true_track = record.trackDeg;
      if (Number.isFinite(record.velocityMps)) meta.velocity = record.velocityMps;
    }
    moved += 1;
  }
  p._lastFleetTickMs = 0;
  p._viewer?.scene?.requestRender?.();
  return { ok: true, moved };
}

/** JSON-safe visual snapshot for the evidence report. */
function _focusEvidenceSnapshot() {
  if (!FOCUS_EVIDENCE_DEV || !p._viewer) return [];
  return [..._focusEvidenceIds].map((id) => {
    const bb = p._billboards.get(id);
    const screen = bb?.position
      ? Cesium.SceneTransforms.worldToWindowCoordinates(p._viewer.scene, bb.position)
      : null;
    return {
      id,
      show: bb?.show === true,
      scale: bb?.scale ?? null,
      alpha: bb?.color?.alpha ?? null,
      x: screen?.x ?? null,
      y: screen?.y ?? null,
      cameraDistanceM: bb?.position
        ? Cesium.Cartesian3.distance(p._viewer.camera.positionWC, bb.position)
        : null,
    };
  });
}

/**
 * Flights data-layer descriptor.
 * Conforms to the layer manager interface: init / enable / disable / update / destroy / getStats.
 * @type {object}
 */
const flightsLayer = {
  id: 'flights',
  name: 'Live Flights',
  icon: '✈️',
  source: 'OpenSky Network',
  // Browser-harness seam: isolates synthetic display-floor scenarios without
  // changing any production lifecycle or cache policy.
  _displayFloorStateForTest,
  _clearDisplayFloorStateForTest,
  _clearGroundSnapStateForTest,
  /** @type {number} Polling interval (ms) between update() calls */
  updateInterval: 30000,

  /**
   * Initialize the flights layer.
   * Creates the BillboardCollection, resets all state, and installs the
   * click-to-track handler on the scene canvas.
   * @param {Cesium.Viewer} viewer - The CesiumJS viewer instance.
   */
  init(viewer) {
    clearFocusTarget('flights');
    _focusEvidenceIds.clear();
    p._viewer = viewer;
    p._billboardCollection = new Cesium.BillboardCollection();
    viewer.scene.primitives.add(p._billboardCollection);
    registerSpriteCollection('flights', p._billboardCollection);
    p._modelCollection = new Cesium.PrimitiveCollection();
    viewer.scene.primitives.add(p._modelCollection);
    // Warm the glTF cache so the tracked plane's model instantiates instantly when first needed
    // (keeps the retained instance referenced; never rendered). Captured against this epoch so a
    // destroy/re-init mid-load doesn't flip the flag for a torn-down lifecycle.
    if (!_preloadModel) {
      const epoch = p._modelEpoch;
      Cesium.Model.fromGltfAsync({ url: PLANE_MODEL_URL, asynchronous: false })
        .then((m) => {
          if (epoch === p._modelEpoch) { _preloadModel = m; p._planeModelLoaded = true; }
          else { try { m.destroy(); } catch { /* gone */ } }
        })
        .catch(() => { /* tracked plane just stays a billboard a beat longer */ });
    }
    p._billboards = new Map();
    _detectionObjects = new Map();
    p._flightData = new Map();
    p._positionHistory = new Map();
    p._displayCourse.clear();
    p._groundSnap.clear();
    _count = 0;
    _lastUpdate = null;
    _backoff = false;
    _retryAt = 0;
    _lastError = null;
    _lastStatus = null;
    _lastSource = 'OpenSky Network';
    _lastCoverage = 'worldwide upstream snapshot';
    p._trackedIcao = null;
    p._resetTrackedSelectionState();
    p._trackedEntity = null;
    p._cockpitSubjectId = null;
    p._cockpitContactMode = document.body.classList.contains('cockpit-mode');
    p._cockpitNearContacts = new Set();
    if (!_cockpitModeListener) {
      _cockpitModeListener = (event) => p._applyCockpitState(event?.detail);
      window.addEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
    }
    // Fresh session — full bucket, anchor re-seeded on the first sweep.
    _enrichAmbientBudget = _ambientBudgetKnobs().ceil;
    _enrichAmbientRefillAnchorMs = 0;

    _installClickHandler(viewer);

    // React to Military-layer toggles IMMEDIATELY (suppress/restore sweep)
    // instead of waiting out the 30 s poll (M2).
    if (!_milActiveChangeUnsub) {
      _milActiveChangeUnsub = onMilitaryLayerActiveChange(_onMilitaryActiveChange);
    }

    restoreSpriteOrder(viewer);

    logDebug('Data:Flights', 'Initialized with billboard icons');
  },

  /**
   * Show the billboard collection and re-install the click handler.
   * @param {Cesium.Viewer} viewer
   */
  enable(viewer) {
    if (p._billboardCollection) p._billboardCollection.show = true;
    holdContinuousRender('flights'); // per-frame animator (perf wave 2)
    if (p._modelCollection) p._modelCollection.show = true;
    p._setCockpitContactMode(document.body.classList.contains('cockpit-mode'));
    // Height-datum fix: warm the geoid grid once per layer-enable. The poll loop
    // only reads geoidHeight() synchronously after this resolves (guarded by
    // _geoidReady) — never awaited per-aircraft, never blocking a poll tick.
    if (!_geoidReady) {
      ensureGeoidReady()
        .then(() => { _geoidReady = true; })
        .catch(() => { /* geoid grid failed to load — baro path stays un-geoid-corrected until retried */ });
    }
    _installClickHandler(viewer);
    registerPickOwner('flights', (pickedId) => p._billboards.has(pickedId));
    // Force a fresh rotation pass on the first tick after re-enable
    p._lastCamPoseSig = '';
    if (!_preRenderRemove && viewer?.scene) {
      _preRenderRemove = viewer.scene.preRender.addEventListener(_fleetTick);
    }
    if (!_trackedModelPreUpdateRemove && viewer?.scene) {
      _trackedModelPreUpdateRemove = viewer.scene.preUpdate.addEventListener(_updateTrackedModel);
    }
    if (!_moveEndRemove && viewer?.camera) {
      // Arrival polish (field test 2026-07-03: "planes look weird when you first
      // come to them"): when a camera move SETTLES (voice fly-to, fast pan
      // release), force a full rotation pass on the very next frame. The
      // pose-signature gate alone can eat the settle — the final easing frames
      // of a flight land inside one quantization bucket (10 m / 0.06°), leaving
      // every icon wearing its last mid-flight rotation for up to
      // ROTATION_REFRESH_MS. Zeroing the tick throttle too means the pass runs
      // on the next preRender, not up to FLEET_DR_INTERVAL_MS later. Cost: one
      // extra rotation pass per completed camera gesture — nothing per-frame.
      _moveEndRemove = viewer.camera.moveEnd.addEventListener(() => {
        p._lastCamPoseSig = '';
        p._lastFleetTickMs = 0;
      });
    }
    restoreSpriteOrderOnEnable('flights', viewer);
  },

  /**
   * Hide all flight billboards and tear down click/keyboard handlers.
   * Also clears any active flight tracking so the camera is released.
   * @param {Cesium.Viewer} _viewer
   */
  disable(_viewer) {
    p._abortActiveUpdates();
    p._cancelPendingTrackingRestore();
    if (p._billboardCollection) p._billboardCollection.show = false;
    releaseContinuousRender('flights');
    p._releaseModels();
    if (p._modelCollection) p._modelCollection.show = false;
    _clearTracking();
    p._destroyTrail();
    // Remove click handler + keydown listener while disabled to avoid
    // intercepting input when the layer is off
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    _clickPressClock?.dispose();
    _clickPressClock = null;
    if (_trackedEntityChangedRemove) {
      _trackedEntityChangedRemove();
      _trackedEntityChangedRemove = null;
    }
    document.removeEventListener('keydown', p._onKeyDown);
    unregisterPickOwner('flights');
    if (_preRenderRemove) {
      _preRenderRemove();
      _preRenderRemove = null;
    }
    if (_trackedModelPreUpdateRemove) {
      _trackedModelPreUpdateRemove();
      _trackedModelPreUpdateRemove = null;
    }
    if (_moveEndRemove) {
      _moveEndRemove();
      _moveEndRemove = null;
    }
  },

  /**
   * Fetch the latest aircraft state vectors from the OpenSky proxy and
   * reconcile them with the billboard collection.
   *
   * Handles HTTP 429 (rate-limit), 401/403 (auth), and transient errors
   * with exponential-ish backoff.  On success, adds, updates, or removes
   * billboards and position history, triggers lerp blending for the
   * tracked aircraft, and updates its label text.
   *
   * @param {Cesium.Viewer} viewer
   * @returns {Promise<void>}
   */
  async update(viewer, { signal = null } = {}) {
    const nowMs = Date.now();
    const trackingRefreshEpoch = ++_trackingRefreshEpoch;
    _lastTrackingRefreshOutcome = {
      epoch: trackingRefreshEpoch,
      status: 'source-unavailable',
      ids: new Set(),
      source: _lastSource,
      coverage: _lastCoverage,
    };
    if (_retryAt && nowMs < _retryAt) {
      _backoff = true;
      return;
    }

    const resourceController = new AbortController();
    p._activeUpdateControllers.add(resourceController);
    const updateSignal = signal
      ? AbortSignal.any([signal, resourceController.signal])
      : resourceController.signal;
    try {
      updateSignal.throwIfAborted();
      const response = await fetch(_flightApiUrl(viewer || p._viewer), { signal: updateSignal });
      _lastStatus = response.status;
      const responseSource = response.headers.get('x-flight-source');
      const responseCoverage = response.headers.get('x-flight-coverage');
      const authMode = _toLowerText(
        response.headers.get('x-opensky-auth-mode-used') || response.headers.get('x-opensky-auth')
      );
      const authReason = _toLowerText(response.headers.get('x-opensky-auth-reason'));

      if (response.status === 429) {
        logWarn('Data:Flights', 'Rate limited, backing off to 30s');
        _backoff = true;
        _retryAt = nowMs + BACKOFF_INTERVAL;
        _lastError = authMode && authMode !== 'anon'
          ? 'OpenSky rate limited'
          : 'OpenSky rate limited (anonymous)';
        return;
      }

      if (response.status === 401 || response.status === 403) {
        logWarn('Data:Flights', `OpenSky unavailable (${response.status}), backing off`);
        _backoff = true;
        _retryAt = nowMs + BACKOFF_INTERVAL;
        let detail = '';
        try {
          const body = await response.json();
          updateSignal.throwIfAborted();
          detail = typeof body?.error === 'string' ? body.error.trim() : '';
        } catch {
          detail = '';
        }
        _lastError = _deriveOpenSkyAuthError({
          detail,
          authMode,
          authReason,
        });
        return;
      }

      if (!response.ok) {
        logWarn('Data:Flights', `API returned ${response.status}`);
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        let detail = '';
        try {
          const body = await response.json();
          updateSignal.throwIfAborted();
          detail = typeof body?.error === 'string' ? body.error.trim() : '';
        } catch {
          detail = '';
        }
        _lastError = detail || `OpenSky HTTP ${response.status}`;
        return;
      }

      const data = await response.json();
      updateSignal.throwIfAborted();
      if (!data || !Array.isArray(data.states)) {
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        _lastError = 'Malformed OpenSky response';
        return;
      }

      const usableStates = data.states.filter(_isUsableOpenSkyState);
      if (data.states.length > 0 && usableStates.length === 0) {
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        _lastError = 'Malformed OpenSky aircraft rows';
        return;
      }

      const sourceEpochMs = Number.isFinite(Number(data.time)) && Number(data.time) > 0
        ? Number(data.time) * 1000
        : null;
      const sourceAgeMs = sourceEpochMs == null ? 0 : Math.max(0, Date.now() - sourceEpochMs);
      const sourceStale = sourceAgeMs > SOURCE_STALE_MS;
      _backoff = sourceStale;
      _retryAt = 0;
      _lastError = sourceStale
        ? `Source snapshot ${Math.max(2, Math.round(sourceAgeMs / 60_000))} min old`
        : null;
      _lastSource = responseSource || 'OpenSky Network';
      _lastCoverage = responseCoverage || 'worldwide upstream snapshot';
      const currentIcaos = new Set();
      const acceptedSnapshotIcaos = new Set();
      // Field-test round 3 (2026-07-06, Austin fleet-underground): viewer
      // subpoint + collected floor cells for the viewer-proximate low-contact
      // clamp below — one carto read per poll, one batch warm after the loop.
      const viewerCarto = (viewer || p._viewer)?.camera?.positionCartographic || null;
      const viewerLatDeg = viewerCarto ? Cesium.Math.toDegrees(viewerCarto.latitude) : null;
      const viewerLonDeg = viewerCarto ? Cesium.Math.toDegrees(viewerCarto.longitude) : null;
      const floorWarmPoints = [];

      // Destructure OpenSky state vector array (indices per API spec):
      // [0] icao24, [1] callsign, [2] origin_country, [3] time_position,
      // [4] last_contact, [5] longitude, [6] latitude, [7] baro_altitude,
      // [8] on_ground, [9] velocity, [10] true_track, [11] vertical_rate,
      // [12] sensors, [13] geo_altitude (WGS84 ellipsoidal — the CORRECT
      // globe-render height when present; height-datum fix Task 6).
      // Keep military classification fresh while the military layer is off
      refreshMilitaryRegistryIfStale();

      for (const state of usableStates) {
        const [rawIcao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_alt, on_ground, velocity, true_track, , , geo_alt] = state;
        const icao24 = p._normalizeTrackedIcao(rawIcao24);
        const category = Number.isFinite(state[17]) ? state[17] : null; // extended=1 emitter category
        const vertical_rate = Number.isFinite(state[11]) ? state[11] : null; // m/s, + = climbing
        acceptedSnapshotIcaos.add(icao24);
        const onGround = on_ground === true;

        // Known-military aircraft: the dedicated military layer wins
        // (icon + track + click) while it is enabled — suppress the
        // OpenSky duplicate entirely (except a currently tracked one,
        // which hands off on untrack).
        const isMil = isMilitaryIcao(icao24);
        if (isMil && _militaryLayerSuppresses(icao24)) {
          const dupe = p._billboards.get(icao24);
          if (dupe) {
            p._billboardCollection.remove(dupe);
            p._billboards.delete(icao24);
            p._releaseModel(icao24); // military-suppression: drop any 3D model too
            p._flightData.delete(icao24);
            p._positionHistory.delete(icao24);
            p._displayCourse.delete(icao24);
            p._groundSnap.forget(icao24);
            _missingPolls.delete(icao24);
            _geoidNCache.delete(icao24);
          }
          continue;
        }

        currentIcaos.add(icao24);
        _missingPolls.delete(icao24);
        // Sticky merge: OpenSky intermittently drops callsign/velocity/track for
        // aircraft it still positions — hold last-known-good instead of
        // regressing to the ICAO hex / a 0° (north) heading. Bounded by the
        // MISSING_POLL_LIMIT eviction below, which deletes the whole entry.
        const prevMeta = p._flightData.get(icao24);
        // Grounded planes with no baro reading sit at 0 m, not the 10 km
        // airborne default (a parked plane must never float).
        // NOTE (height-datum fix): `alt` stays the AVIATION field — the sticky
        // barometric/MSL altitude read by labels (FL/altitude readout),
        // route-plausibility, and follow-camera range heuristics. It is
        // NEVER overwritten or renamed. Where the aircraft actually RENDERS
        // on the ellipsoidal globe is a SEPARATE value (renderAltitudeM,
        // below) — geo_altitude when OpenSky reports it (already WGS84
        // ellipsoidal), else baro+geoid as a visual fallback, else ground
        // surface when parked. `Cartesian3.fromDegrees` gets renderAltitudeM,
        // never `alt` directly.
        const alt = stickyNumber(baro_alt, prevMeta?.altitude, onGround ? 0 : 10000);

        // geoid undulation N: cached per-aircraft (negligible drift — see
        // task brief) once the geoid grid has loaded; unavailable pre-load
        // just means the baro fallback branch below adds N=0 for a beat.
        let geoidN = _geoidNCache.get(icao24);
        if (geoidN === undefined && _geoidReady) {
          geoidN = geoidHeight(lat, lon);
          _geoidNCache.set(icao24, geoidN);
        }

        // on_ground surface prior: ONLY synchronous warm-cache reads here —
        // never a per-aircraft network fetch inside the poll loop (see the
        // batch resolve call below, which fills this cache for NEXT poll). A
        // Round 5 SIMPLIFICATION (product invariant: one floor, evenly applied):
        // the grounded surface is the round-4 choke point and nothing else —
        // rendered-mesh cell first, real (never fallback-poisoned) DEM cell
        // second. The old exact-5-decimal warm chain is GONE: it minted a new
        // key per parked-jitter poll for every grounded contact ON EARTH,
        // hammering Re:Earth into the very failures that poisoned the cache.
        let surfaceM = null;
        if (onGround) {
          surfaceM = cachedGroundFloor(lat, lon); // mesh ?? real DEM (coarse cell)
          // Taxiing crosses into a fresh cold cell every poll — always one
          // step ahead of the warm batch — so fall back to LAST poll's cell
          // (warmed by last poll's batch; aprons are flat across adjacent
          // 111 m cells). Round-5 verify caught taxiing contacts stuck at
          // the geoid without this (round 2's lesson, at cell granularity).
          if (surfaceM == null && Number.isFinite(prevMeta?.rawLat) && Number.isFinite(prevMeta?.rawLon)) {
            surfaceM = cachedGroundFloor(prevMeta.rawLat, prevMeta.rawLon);
          }
          // Grounded contacts near the viewer feed the floor warm/sampler
          // (the only ones whose exact height is visible; far contacts are
          // subpixel and always-on-top anyway).
          if (viewerLatDeg != null &&
              _approxDistanceKm(viewerLatDeg, viewerLonDeg, lat, lon) <= GROUND_FLOOR_CLAMP_RADIUS_KM) {
            floorWarmPoints.push({ lat, lon });
          }
          // Last synchronous resort for a BRAND-NEW grounded contact with NO
          // altitude data at all (nothing warm yet, not even the coarse
          // cell): the geoid surface. At the sea-level airports where most
          // grounded traffic sits, geoidN IS the local ellipsoidal ground to
          // within metres — instantly right — and at elevated fields it is
          // far less wrong than the raw 0 m ellipsoid default for the one
          // poll until the coarse cell warms. STRICTLY gated on "no geo, no
          // baro": a reported baro already reflects the field elevation, and
          // pickRenderAltitudeM's surfaceM branch would let this crude guess
          // outrank it (caught by the ground-3d track regression).
          //
          // 2026-08-21: the rule moved to geoidSurfaceLastResortM, which adds
          // one more gate — a contact that already HAS a render height keeps
          // it. Leaving surfaceM null routes it through the sentinel path
          // below, which holds that height.
          if (surfaceM == null) {
            surfaceM = geoidSurfaceLastResortM({
              geoAltM: geo_alt,
              baroAltM: baro_alt,
              priorRenderM: prevMeta?.renderAltitudeM,
              geoidN,
            });
          }
        }

        const geoAltitudeM = Number.isFinite(geo_alt) ? geo_alt : null;
        const pickedAltM = pickRenderAltitudeM({
          geoAltM: geoAltitudeM,
          baroAltM: Number.isFinite(baro_alt) ? baro_alt : null,
          onGround,
          surfaceM,
          geoidN,
        });
        // pickRenderAltitudeM returns the sentinel `null` only when NEITHER
        // geo_altitude nor baro_altitude was reported THIS poll. Two fallbacks,
        // in priority order:
        //   (1) hold the previous geoid-corrected render height if we have one —
        //       a one-poll baro dropout must NOT snap the plane down by the geoid
        //       undulation N (~46 m in London) and back up next poll. `alt` stays
        //       sticky for labels, so holding the last render height keeps the two
        //       layers consistent through the gap.
        //   (2) otherwise the SAME default policy `alt` already uses, so the two
        //       never disagree on the genuine "no data yet" case (a never-reported
        //       aircraft has no prior render height, so it lands here unchanged).
        let renderAltitudeM;
        if (pickedAltM != null) {
          renderAltitudeM = pickedAltM;
        } else if (Number.isFinite(prevMeta?.renderAltitudeM)) {
          renderAltitudeM = prevMeta.renderAltitudeM;
        } else {
          renderAltitudeM = alt;
        }
        // Field-test fix (WAKE01/RS46 class, 2026-07-06; widened round 3):
        // floor a low airborne contact's render height at the local coarse
        // ground so it can never dive below the mesh. Round 3 (Austin
        // fleet-underground): baro can read BELOW an elevated field — SWA696
        // showed 450 ft at Austin's 542 ft field elevation — and rollout/taxi
        // traffic that OpenSky hasn't flagged on_ground yet renders from that
        // baro, so the whole fleet sat buried at AUS in 2D. Clamping every
        // global contact would need unbounded terrain resolution; instead the
        // clamp covers the TRACKED contact (always) plus every low contact
        // within GROUND_FLOOR_CLAMP_RADIUS_KM of the viewer — the only ones
        // whose burial is visible. Cells warm in one batch after the loop.
        // Airborne only (grounded planes keep the surface-cache path above).
        if (!onGround && renderAltitudeM < GROUND_FLOOR_WARM_MAX_ALT_M &&
            (icao24 === p._trackedIcao ||
              (viewerLatDeg != null &&
                _approxDistanceKm(viewerLatDeg, viewerLonDeg, lat, lon) <= GROUND_FLOOR_CLAMP_RADIUS_KM))) {
          renderAltitudeM = floorAltitudeM(renderAltitudeM, cachedGroundFloor(lat, lon));
          floorWarmPoints.push({ lat, lon });
        }

        const position = Cesium.Cartesian3.fromDegrees(lon, lat, renderAltitudeM);
        // Landing/takeoff transition: the on_ground flip restyles IN PLACE.
        const groundFlipped = Boolean(prevMeta) && (prevMeta.onGround === true) !== onGround;
        // Either flip direction retires the model's ground snap: a departing plane
        // flies free of it, a landing plane earns a fresh sample where it rolls out.
        if (groundFlipped) p._groundSnap.forget(icao24);

        // Store flight metadata for click-to-track labels
        const cat = stickyNumber(category, prevMeta?.category, null);
        const meta = {
          callsign: stickyText(callsign, prevMeta?.callsign),
          altitude: alt,
          // geoAltitudeM/renderAltitudeM are ADDITIVE fields alongside the
          // untouched aviation `altitude` — never rename/replace it (labels,
          // FL readout, route-plausibility, and follow-camera range math all
          // still read `altitude`/baro).
          geoAltitudeM,
          renderAltitudeM,
          onGround,
          // Round 7: sticky airborne history — the landed fast-cull only
          // applies to contacts that actually flew this session.
          wasAirborne: prevMeta?.wasAirborne === true || !onGround,
          // Round 6: lifted occlusion-test point for contacts rendering
          // at/below the ellipsoid (fleet pass reads it — see the occluder
          // note there). Null for the overwhelmingly common airborne case.
          cullPosition: renderAltitudeM < 10 ? Cesium.Cartesian3.fromDegrees(lon, lat, 12) : null,
          velocity: stickyNumber(velocity, prevMeta?.velocity, 0),
          true_track: stickyNumber(true_track, prevMeta?.true_track, 0),
          category: cat,
          // An adsbdb-enriched type code outranks the coarse OpenSky category.
          klass: classifyAircraft({ typeCode: prevMeta?.typeCode ?? null, category: cat }),
          turnRateDps: prevMeta?.turnRateDps || 0,
          verticalRate: stickyNumber(vertical_rate, prevMeta?.verticalRate, null),
          // Analyst seam: OpenSky origin_country (state[2]) — additive, sticky
          // like callsign so a transient blank row doesn't blank the field.
          originCountry: stickyText(origin_country, prevMeta?.originCountry) || null,
          // OpenSky distinguishes the last position epoch from the last
          // transponder message. The fleet coast horizon uses this actual
          // contact time so a temporarily old position does not hard-freeze
          // while fresh velocity/track messages are still arriving.
          lastContactEpochMs: stickyNumber(
            Number.isFinite(last_contact) ? last_contact * 1000 : null,
            prevMeta?.lastContactEpochMs,
            null,
          ),
          // adsbdb enrichment — written by the enrichment callbacks, carried across polls:
          typeCode: prevMeta?.typeCode ?? null,
          typeName: prevMeta?.typeName ?? null,
          registration: prevMeta?.registration ?? null,
          airline: prevMeta?.airline ?? null,
          route: prevMeta?.route ?? null,
          // The RAW poll fix lat/lon (this tick's OpenSky state-vector
          // coords, pre-dead-reckon) — kept distinct from the continuously
          // dead-reckoned billboard position for any consumer that needs the
          // actual reported fix.
          rawLat: lat,
          rawLon: lon,
        };
        p._flightData.set(icao24, meta);

        const isTracked = icao24 === p._trackedIcao;

        // Append to position history stamped with the FEED's fix epoch
        // (time_position), not client receipt time — OpenSky positions arrive
        // 5-15s stale and receipt-time stamping is what caused the
        // back/forward oscillation. Only append when the fix actually
        // advances, so stale repeats don't create zero-dt segments.
        const fixEpochMs = Number.isFinite(time_position) && time_position > 0
          ? time_position * 1000
          : Date.now();
        const fixTime = Cesium.JulianDate.fromDate(new Date(fixEpochMs));
        if (!p._positionHistory.has(icao24)) {
          p._positionHistory.set(icao24, []);
        }
        const history = p._positionHistory.get(icao24);
        const newest = history.at(-1);
        if (!newest || Cesium.JulianDate.greaterThan(fixTime, newest.time)) {
          // Per-fix kinematics: the fix's own velocity/track ride along so the
          // extrapolation paths use the values that BELONG to the fix they
          // extend, not whatever the latest poll reported.
          history.push({
            time: fixTime,
            epochMs: fixEpochMs,
            position: position.clone(),
            velocity: meta.velocity,
            track: meta.true_track,
          });
          if (history.length > POSITION_HISTORY_LIMIT) {
            history.shift();
          }
          // Turn rate from the fix-track history — computed once per new fix
          // (≤5 samples), consumed by the extrapolation paths at tick rate.
          meta.turnRateDps = turnRateFromFixHistory(history);
          // Trail accumulation is separate from the 5-fix DR history (PRD F1)
          // so the visible trail keeps growing while tracked. Ground traffic
          // appends nothing — a touchdown freezes the existing trail.
          // Round 2 (owner): ground traffic appends too — taxi history stays
          // live after touchdown (grounded flights positions are already
          // surface-clamped via the surfaceM chain, so the ground leg drapes).
          if (isTracked) p._appendTrailFix(position.clone());
        } else {
          const modelOwnsGroundVisual = p._modelOwnsVisual(icao24);
          if (!modelOwnsGroundVisual) {
            liftRepeatedGroundFix(newest, position, meta.onGround);
          }
          // Apply fresh kinematics only from a forward synthetic fix. Mutating
          // the historical fix reprojects the entire stale interval and snaps
          // the rendered aircraft when course or speed changes late.
          const kinematicsChanged = newest.velocity !== meta.velocity
            || newest.track !== meta.true_track;
          if (kinematicsChanged) {
            const synthetic = synthesizeForwardKinematicsFix(newest, {
              epochMs: Date.now(),
              velocity: meta.velocity,
              track: meta.true_track,
              turnRateDps: meta.turnRateDps,
            });
            if (synthetic) {
              history.push(synthetic);
              if (history.length > POSITION_HISTORY_LIMIT) history.shift();
              meta.turnRateDps = turnRateFromFixHistory(history);
              if (isTracked) p._appendTrailFix(synthetic.position.clone());
            }
          }
        }

        if (p._billboards.has(icao24)) {
          const bb = p._billboards.get(icao24);
          // Reclassify if the category resolved/changed (first extended poll);
          // a ground flip (landing/takeoff) re-scales the SAME billboard in
          // place — the transition is a restyle, never a removal.
          // Round 5: depth policy is uniform (always depth-test-free, see
          // p._groundDepthDistance) — nothing to flip on landing/takeoff.
          // Position AND rotation are owned by the fleet pass (_fleetTick);
          // course changes land on the next rotation pass (forced below).
          if (!isTracked) {
            // Refresh affiliation hue without clobbering the tick-owned
            // freshness × focus × horizon alpha composition.
            bb.color = _fleetBillboardColor(icao24).withAlpha(bb.color?.alpha ?? 1);
          }
          if (prevMeta?.klass !== meta.klass || groundFlipped || p._cockpitContactMode) {
            p._applyFleetBillboardPresentation(icao24, bb);
          }
          // Poll-path class change (category updates): same model resync rule
          // as the enrichment path — the class's GLB/scale may have changed.
          if (prevMeta?.klass !== meta.klass) p._syncModelToClass(icao24);
        } else {
          const bb = p._billboardCollection.add({
            position,
            image: aircraftIcon(p._iconKind(icao24, meta.klass)),
            width: isTracked ? 24 : 20,
            height: isTracked ? 24 : 20,
            scale: _fleetBillboardScale(icao24, meta.klass),
            // Screen-projected rotation lands on the next fleet tick.
            rotation: 0,
            alignedAxis: Cesium.Cartesian3.ZERO,
            color: isTracked ? Cesium.Color.CYAN : _fleetBillboardColor(icao24),
            sizeInMeters: false,
            scaleByDistance: _normalBillboardScaleByDistance(),
            // Grounded/near-surface planes sit at/below the photoreal tile
            // surface — render them depth-test-free so they never vanish up
            // close (p._groundDepthDistance).
            disableDepthTestDistance: p._groundDepthDistance(),
            id: icao24,
            show: !isTracked, // hidden if currently tracked (entity replaces it)
          });
          p._billboards.set(icao24, bb);
          p._applyFleetBillboardPresentation(icao24, bb);
        }

        // Takeoff while TRACKED: ground traffic drew no trail, so start one
        // from the fresh airborne history (touchdown needs no action — the
        // append gate above simply freezes the existing trail).
        if (isTracked && groundFlipped && !meta.onGround) _startTrail(icao24);

        // If this is the tracked aircraft, update label text
        // (position updates automatically via dead-reckoning CallbackProperty)
        if (isTracked && p._trackedEntity) {
          p._updateTrackedLabelModel(icao24);
        }
      }

      // Remove aircraft only after MISSING_POLL_LIMIT consecutive absences.
      // OpenSky routinely drops aircraft for a single poll; immediate removal
      // made planes blink and yanked the camera off actively tracked flights.
      // EXCEPTION: likely-landed planes (last fix low + slow) get only
      // LANDED_MISSING_POLL_LIMIT — their disappearance means "landed", not a
      // feed gap, and the full grace left phantom planes parked at airports.
      for (const [icao24, bb] of p._billboards) {
        if (currentIcaos.has(icao24)) continue;
        const misses = (_missingPolls.get(icao24) || 0) + 1;
        const limit = _likelyLanded(icao24) ? LANDED_MISSING_POLL_LIMIT : MISSING_POLL_LIMIT;
        if (misses < limit) {
          _missingPolls.set(icao24, misses);
          if (icao24 === p._trackedIcao && p._trackedEntity) {
            // Honest readout: the tracked plane has no faded billboard (its
            // entity owns the visual), so refresh the label — with icao24 now
            // in _missingPolls, _trackedLabelText appends the STALE cue so
            // last-known velocity/altitude aren't presented as live.
            p._updateTrackedLabelModel(icao24);
          }
          continue;
        }
        _missingPolls.delete(icao24);

        // If the tracked flight is truly gone, clear tracking BEFORE deleting
        // its state (M3 ordering, keep it): teardown reads the maps this loop
        // is about to delete (billboard restore, DR cache reset), and we must
        // never leave the camera mid-follow with stale tracking state. The
        // camera is then RELEASED IN PLACE — it stays where the follow left
        // it, fully free (product rule 2026-07-02: no overview flyTo).
        if (icao24 === p._trackedIcao) {
          _clearTracking(false, { evicted: true });
        }

        p._billboardCollection.remove(bb);
        p._billboards.delete(icao24);
        p._releaseModel(icao24); // aged-out aircraft: drop its 3D model (no orphan / cap leak)
        p._flightData.delete(icao24);
        p._positionHistory.delete(icao24);
        p._displayCourse.delete(icao24);
        p._groundSnap.forget(icao24);
        _geoidNCache.delete(icao24);
        _displayFloorState.delete(icao24);
      }

      // Fresh courses arrived — force a rotation pass on the next fleet tick
      p._lastCamPoseSig = '';

      // Ambient type enrichment: give ON-SCREEN planes real types (bounded
      // sweep — see _sweepAmbientEnrichment; internally fail-silent).
      _sweepAmbientEnrichment();

      // 2026-08-19: the loop above only ever collects FIX cells, but a grounded
      // contact renders across every cell its dead-reckoned position drifts
      // through. Add those too, so the display clamp has data where the contact
      // actually is instead of silently passing.
      _collectDisplayCorridorCells(floorWarmPoints, viewerLatDeg, viewerLonDeg);

      // Field-test round 3: one batch warm of the viewer-proximate low-contact
      // floor cells collected in the loop (fire-and-forget, single-flight;
      // read synchronously by NEXT poll's clamp — the military-layer pattern).
      warmGroundFloor(floorWarmPoints);
      // Round 4: sample the RENDERED mesh for those same cells (one-shot per
      // cell, budget-capped, viewer-proximate, google-3d regime only). Own
      // billboards/models are excluded so a vertical probe can't land on an
      // aircraft instead of the pavement.
      sampleMeshFloorCells(p._viewer?.scene, floorWarmPoints, {
        excludeObjects: [...p._billboards.values(), ...p._models.values(), p._trackedModel].filter(Boolean),
        viewerLat: viewerLatDeg,
        viewerLon: viewerLonDeg,
      });

      // Round 5: the grounded exact-key warm that used to live here is gone —
      // see the note where _warmGroundedAircraftSurfaceCache was removed. The
      // viewer-proximate coarse warm + mesh sampler above cover everything
      // whose height is actually visible.
      // Round 6: re-floor STALE grounded contacts. A parked plane whose
      // transponder went quiet stops receiving poll updates, so a floor that
      // warms AFTER its last fix never applied — it sat frozen at the geoid
      // (ATL verify: FFT4347 at −30.7 m, 305 m under the apron, forever).
      // Grounded contacts are static, so lifting the stored fix + billboard
      // in place is safe (the DR extrapolates a zero-velocity fix).
      _refloorStaleGroundedContacts(currentIcaos);

      _count = p._billboards.size;
      // Freshness belongs to the source snapshot, not the moment this browser
      // received a cached 200 response.
      _lastUpdate = sourceEpochMs ?? Date.now();
      _lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'accepted',
        ids: acceptedSnapshotIcaos,
        source: _lastSource,
        coverage: _lastCoverage,
      };
      logDebug('Data:Flights', `Updated: ${_count} aircraft`);
      p._applyPendingTrackingRestore();

    } catch (e) {
      if (updateSignal.aborted || e?.name === 'AbortError') {
        throw new DOMException('Flights update aborted', 'AbortError');
      }
      logWarn('Data:Flights', 'Fetch error:', e);
      _backoff = true;
      _retryAt = Date.now() + ERROR_BACKOFF_INTERVAL;
      _lastError = 'OpenSky network error';
    } finally {
      p._activeUpdateControllers.delete(resourceController);
    }
  },

  /**
   * Fully tear down the flights layer — remove primitives, handlers,
   * tracked entities, and clear all internal state maps.
   * @param {Cesium.Viewer} viewer
   */
  destroy(viewer) {
    p._abortActiveUpdates();
    releaseContinuousRender('flights'); // direct-destroy path (perf wave 2 fix)
    _clearTracking();
    p._destroyTrail();
    p._cancelPendingTrackingRestore();
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    _clickPressClock?.dispose();
    _clickPressClock = null;
    if (_trackedEntityChangedRemove) {
      _trackedEntityChangedRemove();
      _trackedEntityChangedRemove = null;
    }
    if (_milActiveChangeUnsub) {
      _milActiveChangeUnsub();
      _milActiveChangeUnsub = null;
    }
    document.removeEventListener('keydown', p._onKeyDown);
    if (_cockpitModeListener) {
      window.removeEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
      _cockpitModeListener = null;
    }
    unregisterPickOwner('flights');
    if (_preRenderRemove) {
      _preRenderRemove();
      _preRenderRemove = null;
    }
    if (_trackedModelPreUpdateRemove) {
      _trackedModelPreUpdateRemove();
      _trackedModelPreUpdateRemove = null;
    }
    if (_moveEndRemove) {
      _moveEndRemove();
      _moveEndRemove = null;
    }
    p._releaseModels();
    if (p._billboardCollection) {
      viewer.scene.primitives.remove(p._billboardCollection);
      p._billboardCollection = null;
    }
    if (p._modelCollection) {
      viewer.scene.primitives.remove(p._modelCollection); // removing destroys it + its models
      p._modelCollection = null;
    }
    p._modelEpoch += 1; // invalidate any in-flight load from this lifecycle (settles post-destroy)
    p._modelPending.clear();
    p._modelGen.clear();
    if (_preloadModel) { try { _preloadModel.destroy(); } catch { /* gone */ } _preloadModel = null; }
    p._planeModelLoaded = false;
    p._billboards.clear();
    _detectionObjects.clear();
    p._flightData.clear();
    p._positionHistory.clear();
    p._displayCourse.clear();
    p._groundSnap.clear();
    _displayFloorState.clear();
    _enrichQueue.length = 0;
    _enrichSeen.clear();
    if (_enrichDripTimer) { clearTimeout(_enrichDripTimer); _enrichDripTimer = null; }
    _missingPolls.clear();
    _focusEvidenceIds.clear();
    _count = 0;
    _lastUpdate = null;
    p._cockpitContactMode = false;
    p._cockpitNearContacts = new Set();
    p._cockpitSubjectId = null;
    _trackingRefreshEpoch += 1;
    _lastTrackingRefreshOutcome = {
      epoch: _trackingRefreshEpoch,
      status: 'destroyed',
      ids: new Set(),
      source: _lastSource,
      coverage: _lastCoverage,
    };
    p._resetTrackedSelectionState(); // next lifecycle re-evaluates against the ENTER ceiling
    p._viewer = null;
  },

  /**
   * Live layer params.
   * `models3d` toggles 3D glTF model rendering for the FLEET (altitude-gated): when on,
   * surrounding aircraft become 3D models once the camera is zoomed in past p.MODEL_ALT_CEIL_M.
   * The TRACKED contact is NOT gated by this — it takes its 3D model by camera distance
   * regardless (see `p._trackedModelRegimeActive` / trackedModelRegime.js).
   * `models3dMode` is 'proximity' (nearest MODEL_MAX in view) or 'all' (every in-view plane).
   * @param {{models3d?: boolean, models3dMode?: 'proximity'|'all', selectedFlightsTrackingId?: string|null}} params
   */
  setParams(params = {}, { origin = 'programmatic' } = {}) {
    if (isExplicitLayerStateOrigin(origin)
        && !Object.hasOwn(params, 'selectedFlightsTrackingId')) {
      p._cancelPendingTrackingRestore();
    }
    if (typeof params.models3d === 'boolean' && params.models3d !== p._models3dEnabled) {
      p._models3dEnabled = params.models3d;
      if (!p._models3dEnabled) {
        p._releaseModels();
        p._syncTracked2dRotation();
        // Restore fleet billboards (the horizon-cull pass re-asserts next tick), but NEVER the
        // tracked plane's own fleet billboard — its tracked entity is the visual, so re-showing it
        // here would double-image the tracked plane when 3D is turned off mid-track.
        if (p._billboardCollection) for (const [icao, bb] of p._billboards) { if (icao !== p._trackedIcao) bb.show = true; }
      }
    }
    if ((params.models3dMode === 'proximity' || params.models3dMode === 'all') && params.models3dMode !== p._models3dMode) {
      // The next fleet tick re-derives the eligible set under the new cap and releases the overflow.
      p._models3dMode = params.models3dMode;
      if (p._cockpitContactMode) {
        p._refreshCockpitNearContacts();
        p._lastFleetTickMs = 0;
      }
    }
    if (typeof params.irBoost === 'boolean' && params.irBoost !== p._irBoost) {
      p._irBoost = params.irBoost;
      p._reloadModelsForIrBoost();
      // Sprites don't reload with the models — swap the TR-3B glyph between its
      // cold and thermal-reactive variants directly. Bounded by the operator's
      // own conversions, so this never touches the ordinary fleet.
      p._refreshTr3bForStyle();
    }
    if (Object.hasOwn(params, 'selectedFlightsTrackingId')) {
      const requested = p._normalizeTrackedIcao(params.selectedFlightsTrackingId);
      if (requested === p._trackedIcao) {
        p._pendingTrackingRestore = null;
      } else if (requested === null) {
        p._cancelPendingTrackingRestore();
        if (p._trackedIcao) _clearTracking(false, { origin });
      } else {
        const generation = ++p._trackingIntentGeneration;
        p._pendingTrackingRestore = { id: requested, generation, origin };
        if (p._trackedIcao) _clearTracking(false, { origin });
        p._applyPendingTrackingRestore();
      }
    }
    return true;
  },
  getParams() {
    return {
      models3d: p._models3dEnabled,
      models3dMode: p._models3dMode,
      irBoost: p._irBoost,
      selectedFlightsTrackingId: p._trackedIcao,
    };
  },

  /**
   * Re-render a contact whose TR-3B conversion just flipped (Easter egg).
   * Callers own the registry write; this only re-derives what renders.
   * @param {string} icao24 - ICAO 24-bit address.
   * @returns {boolean} True when this layer owns the contact.
   */
  refreshTr3b(icao24) { return _refreshTr3bContact(icao24); },

  /**
   * Return a subsample of currently visible aircraft for detection overlay
   * rendering (e.g. bounding boxes drawn on-screen by the CCTV detection layer).
   *
   * Uses a deterministic stride + seed to select a spatially distributed
   * subset without sorting or shuffling.
   *
   * @param {object}  [options]
   * @param {number}  [options.maxCount] - Maximum number of objects to return.
   * @param {number}  [options.seed]     - Deterministic offset into the stride pattern.
   * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean}>}
   */
  getDetectableObjects(options = {}) {
    if (!p._billboardCollection || !p._billboardCollection.show) return [];
    // Compute a stride that evenly samples the billboard map.
    // seed shifts the starting offset so successive calls can sample
    // different aircraft without shuffling the underlying Map order.
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : p._billboards.size;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    const stride = Math.max(1, Math.ceil(p._billboards.size / maxCount));
    const start = seed % stride;

    const result = [];
    let idx = 0;
    for (const [icao24, bb] of p._billboards) {
      const shouldTake = ((idx - start) % stride) === 0;
      idx++;
      if (!shouldTake) continue;
      if (p._cockpitContactMode && icao24.toLowerCase() === p._cockpitSubjectId) continue;
      const isTracked = icao24 === p._trackedIcao;
      // Keep planes rendered as a 3D model (billboard hidden) so the detection box
      // doesn't vanish on the 2D→3D handoff; bb.position stays current while hidden.
      const model = p._models.get(icao24);
      const modelOwnsVisual = p._modelOwnsVisual(icao24);
      if (!isTracked && !bb.show && !modelOwnsVisual) continue;
      const info = p._flightData.get(icao24);
      let object = _detectionObjects.get(icao24);
      if (!object) {
        object = { sourceId: icao24, type: 'AIR', _weldPos: new Cesium.Cartesian3() };
        _detectionObjects.set(icao24, object);
      }
      // WELD: anchor to whatever actually owns the visual. A model-owned contact is
      // read straight off the translation the fleet tick already wrote into its
      // modelMatrix, so bracket and label sit on the aircraft you can see instead of
      // on the buried billboard position, which for a grounded plane is ~100 m below
      // and rises only as the coarse ground-floor cell warms. Zero extra sampling and
      // no `p._modelDisplayPosition` call from postRender. Sprite-owned contacts keep
      // `bb.position` — sprite and bracket are co-located there, so association holds.
      const spec = modelOwnsVisual ? _modelSpec(info?.klass) : null;
      const pos = isTracked
        ? (p._trackedVisualCached() || bb.position)
        : (modelOwnsVisual
          ? modelVisualAnchor(
            model.modelMatrix,
            spec.visualCenterNative,
            Number.isFinite(model.computedScale) ? model.computedScale : spec.scale,
            object._weldPos || (object._weldPos = new Cesium.Cartesian3()),
          )
          : bb.position);
      if (!pos) continue;
      object.position = pos;
      object.skipLabel = isTracked;
      // Card text only — declutter/cohort identity is `object.sourceId` (icao24).
      const id = _contactLabel(icao24, info);
      if (object.id !== id) object.id = id;
      const altitude = info?.altitude;
      if (object._altitude !== altitude) {
        object._altitude = altitude;
        object.metric = formatFlightLevel(altitude); // altitude is metres
      }
      result.push(object);
      if (result.length >= maxCount) break;
    }
    if (_detectionObjects.size > p._billboards.size + 512) {
      for (const icao24 of _detectionObjects.keys()) {
        if (!p._billboards.has(icao24)) _detectionObjects.delete(icao24);
      }
    }
    return result;
  },

  /**
   * Find a single aircraft by free-text query.
   * Match priority: exact icao24 hex, exact callsign, callsign prefix,
   * then callsign substring (all case-insensitive, trimmed).
   * @param {string} query - ICAO24 hex or full/partial callsign.
   * @returns {{icao24: string, callsign: string|null, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
   *   Best match with a cloned, dead-reckoned position, or null if none.
   */
  findByQuery(query) {
    if (!p._flightData || p._flightData.size === 0) return null;
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;

    // Registration is searched alongside callsign because it is what the
    // operator SEES: a callsign-less contact reads as its tail number on the
    // card, in the analyst's answer, and in the Contacts list. Matching only
    // callsigns meant "follow 6606" — and the analyst → track_entity handoff
    // the tool instructions prescribe — answered "nothing matched" for the
    // very identity the app had just shown. Ranking is shared with the
    // military layer (contactMatch.js) so the two cannot disagree, and it is
    // strictly tiered so a registration can never out-rank a real callsign on
    // feed order alone.
    let best = null;
    for (const [icao24, info] of p._flightData) {
      const candidate = {
        tier: rankContactMatch({
          query: q,
          hex: icao24,
          callsign: info?.callsign,
          registration: info?.registration,
        }),
        id: icao24,
      };
      if (!contactMatchWins(candidate, best)) continue;
      best = candidate;
      if (candidate.tier === CONTACT_MATCH_TIER.HEX_EXACT) break;
    }
    return best ? _describeFlight(best.id) : null;
  },

  /**
   * Find aircraft near a given ECEF position, sorted ascending by distance.
   * Return shape mirrors militaryFlightsLayer.getNearby (id/icao24/position/distance).
   * @param {Cesium.Cartesian3} center - Reference position in ECEF coordinates.
   * @param {number} range - Maximum distance in meters (Infinity if not finite).
   * @param {number} [maxCount=50] - Maximum number of results to return.
   * @param {object} [options] Query membership options.
   * @param {boolean} [options.includeHidden=false] Include loaded horizon-hidden aircraft.
   * @returns {Array<{id: string, icao24: string, callsign: string|null, position: Cesium.Cartesian3, distance: number, aircraftClass: string|null, altitudeM: number|null, velocityMps: number|null, track: number|null}>}
   */
  getNearby(center, range, maxCount = 50, { includeHidden = false } = {}) {
    if (!center || !p._billboardCollection || !p._billboardCollection.show) return [];

    const limit = Number.isFinite(maxCount)
      ? Math.max(1, Math.floor(maxCount))
      : 50;
    const maxRange = Number.isFinite(range) && range > 0 ? range : Number.POSITIVE_INFINITY;

    const nearby = [];

    for (const [icao24, bb] of p._billboards) {
      const isTracked = icao24 === p._trackedIcao;
      // Keep planes rendered as a 3D model (billboard hidden) so proximity counts
      // don't drop to zero on the 2D→3D handoff; bb.position stays current while hidden.
      if (!aircraftIncludedInNearby({
        isTracked,
        billboardShown: bb.show,
        modelRendering: p._modelOwnsVisual(icao24),
        includeHidden,
      })) continue;

      const trackedPos = isTracked ? p._trackedDisplayCached() : null; // cached, no recompute (anti-jitter)
      const pos = trackedPos || bb.position;
      if (!pos) continue;

      const distance = Cesium.Cartesian3.distance(center, pos);
      if (distance > maxRange) continue;

      const info = p._flightData.get(icao24);
      const callsign = info?.callsign?.trim() || null;
      nearby.push({
        // Label. Callers that need identity read `icao24` (Context cohorts do).
        id: _contactLabel(icao24, info),
        icao24,
        callsign,
        position: pos,
        distance,
        // Filter surface: the cockpit next/previous path matches on THIS field
        // (militaryAwareness.aircraftClassMatchesFilter), so a converted contact
        // has to report the class it renders as or a `tr3b` filter skips it.
        aircraftClass: tr3bAircraftClass(icao24, String(info?.klass || '').trim().toLowerCase() || null),
        altitudeM: info?.altitude ?? null,
        velocityMps: info?.velocity ?? null,
        track: info?.true_track ?? null,
      });
    }

    nearby.sort((a, b) => a.distance - b.distance);
    return nearby.slice(0, limit);
  },

  /**
   * Return id/label/position for up to maxCount currently rendered aircraft.
   * Cheap snapshot for voice-tool framing — billboard positions only, no
   * dead reckoning and no cloning.
   * @param {number} [maxCount=500] - Maximum number of entries to return.
   * @returns {Array<{id: string, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number}>}
   */
  /**
   * Whether this layer still carries a contact, in O(1).
   *
   * Presence consumers must not infer absence from `getAllPositions`: it stops
   * at its cap, and this layer routinely carries ~11k contacts against a
   * 1,000-row cap, so "not in the returned rows" is not "gone". Id matching
   * mirrors trackById: exact key first, then lowercase.
   * A disabled layer keeps its records but hides the collection, so it must
   * decline rather than answer from data the user can no longer see —
   * otherwise a preserved subject reads as fresh off stale hidden state.
   * @param {string} icao24 Contact identifier.
   * @returns {boolean|null} Presence, or null when the layer is disabled or
   *   holds no data and therefore cannot answer.
   */
  hasContact(icao24) {
    if (!p._billboardCollection || !p._billboardCollection.show || p._billboards.size === 0) return null;
    if (!icao24) return false;
    const id = String(icao24).trim();
    return p._billboards.has(id) || p._billboards.has(id.toLowerCase());
  },

  getAllPositions(maxCount = 500) {
    if (!p._billboardCollection || p._billboards.size === 0) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 500;

    const result = [];
    for (const [icao24, bb] of p._billboards) {
      const pos = bb.position;
      if (!pos) continue;
      const carto = Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, _scratchCarto);
      if (!carto) continue;
      const info = p._flightData.get(icao24);
      result.push({
        id: icao24, // identity (trackById resolves this)
        label: _contactLabel(icao24, info),
        position: pos,
        latitude: Cesium.Math.toDegrees(carto.latitude),
        longitude: Cesium.Math.toDegrees(carto.longitude),
        altitudeM: carto.height,
        airline: info?.airline ?? null,
        typeName: info?.typeName ?? null,
        typeCode: info?.typeCode ?? null,
        registration: info?.registration ?? null,
        origin: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.origin.code : null,
        destination: info?.route && _routeIsPlausible(icao24, info.route) ? info.route.destination.code : null,
      });
      if (result.length >= limit) break;
    }
    return result;
  },

  /**
   * Snapshot the layer's in-memory records as plain JSON-safe objects for
   * the analyst query engine. On-demand only (called at most once per
   * spoken query) — zero per-frame cost, no listeners, no caching, no
   * enrichment fetches (cached adsbdb values only). Returns [] while the
   * layer is disabled or empty.
   * @param {number} [maxCount=2000] - Maximum records to return (truncation).
   * @returns {Array<object>} See mapAnalystRecord for the record shape.
   */
  getAnalystRecords(maxCount = 2000) {
    if (!p._billboardCollection || !p._billboardCollection.show || p._flightData.size === 0) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
    const result = [];
    for (const [icao24, info] of p._flightData) {
      const routeOk = Boolean(info?.route) && _routeIsPlausible(icao24, info.route);
      result.push(mapAnalystRecord(icao24, info, { military: isMilitaryIcao(icao24), routeOk }));
      if (result.length >= limit) break;
    }
    return result;
  },

  /**
   * Start camera-tracking an aircraft by ICAO24 address.
   * @param {string} icao24 - ICAO 24-bit transponder address.
   * @returns {boolean} True if the aircraft exists and tracking started.
   */
  trackById(icao24, { origin = 'programmatic' } = {}) {
    if (!icao24) return false;
    let id = String(icao24).trim();
    if (!p._billboards.has(id)) id = id.toLowerCase();
    if (!p._billboards.has(id)) return false;
    if (p._isExplicitTrackingOrigin(origin)) p._cancelPendingTrackingRestore();
    if (p._trackedIcao === id) return _publishTrackedSelection(id, origin);
    _trackFlight(id, { origin });
    return true;
  },

  /** Resolve a shared Follow target only against the latest accepted refresh. */
  async resolveTrackingRestoreTarget(icao24, { signal = null, origin = 'share-restore' } = {}) {
    if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
    const id = p._normalizeTrackedIcao(icao24);
    if (!id) return { status: 'missing', reason: 'invalid-target' };
    const outcome = _lastTrackingRefreshOutcome;
    if (outcome.status !== 'accepted') {
      return {
        status: 'source-unavailable',
        reason: 'OpenSky snapshot unavailable',
        refreshEpoch: outcome.epoch,
        source: outcome.source,
        coverage: outcome.coverage,
      };
    }
    if (!outcome.ids.has(id)) {
      return {
        status: 'missing',
        reason: 'target-absent-from-snapshot',
        refreshEpoch: outcome.epoch,
        source: outcome.source,
        coverage: outcome.coverage,
      };
    }
    if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
    const followed = this.trackById(id, { origin });
    return followed
      ? {
          status: 'found',
          refreshEpoch: outcome.epoch,
          source: outcome.source,
          coverage: outcome.coverage,
        }
      : { status: 'source-unavailable', reason: 'target-not-renderable', refreshEpoch: outcome.epoch };
  },

  /** Reapply the canonical follow frame without recreating the selected flight. */
  refocusTrackedById(icao24, { origin = 'programmatic' } = {}) {
    if (!icao24 || p._cockpitContactMode || !p._viewer || !p._trackedEntity) return false;
    let id = String(icao24).trim();
    if (!p._billboards.has(id)) id = id.toLowerCase();
    if (
      id !== p._trackedIcao
      || !p._viewer.entities?.contains?.(p._trackedEntity)
      || p._viewer.trackedEntity !== p._trackedEntity
    ) return false;
    _trackedCameraFrameStop?.();
    p._viewer.camera.cancelFlight();
    p._viewer.trackedEntity = p._trackedEntity;
    _trackedCameraFrameStop = applyTrackedCameraFrame(
      p._viewer,
      p._trackedEntity,
      p._trackedEntity.viewFrom,
    ) || null;
    _publishTrackedSelection(id, origin);
    return true;
  },

  /**
   * Stop tracking the currently followed aircraft (no-op if none).
   * @returns {boolean} Always true.
   */
  stopTracking({ origin = 'programmatic' } = {}) {
    p._cancelPendingTrackingRestore();
    _clearTracking(false, { origin });
    return true;
  },

  cancelPendingTrackingRestore() {
    p._cancelPendingTrackingRestore();
  },

  /**
   * Describe the currently tracked aircraft at its dead-reckoned position.
   * @returns {{icao24: string, callsign: string|null, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
   *   Tracked aircraft info, or null when nothing is tracked.
   */
  getTrackedInfo() {
    if (!p._trackedIcao) return null;
    const described = _describeFlight(p._trackedIcao);
    if (!described) return null;
    const { position: _position, ...rest } = described;
    return rest;
  },

  /**
   * Return the current aircraft as a Context subject without changing
   * tracking or camera ownership.
   * @returns {{layerId: string, id: string, label: string, position: Cesium.Cartesian3}|null}
   *   Detached subject descriptor, or null when no aircraft is tracked.
   */
  getTrackedSubject() {
    if (!p._trackedIcao) return null;
    const described = _describeFlight(p._trackedIcao);
    if (!described?.position) return null;
    return {
      layerId: 'flights',
      id: described.icao24,
      // Same label chain as getNearby/getDetectableObjects: a callsign-less
      // contact reads as its registration, never as the raw ICAO hex.
      label: described.callsign
        || p._toCleanText(described.registration)
        || described.icao24,
      position: Cesium.Cartesian3.clone(described.position),
    };
  },

  ...(FOCUS_EVIDENCE_DEV ? {
    __focusEvidence: Object.freeze({
      setAircraft: _setFocusEvidenceAircraft,
      moveAircraft: _moveFocusEvidenceAircraft,
      snapshot: _focusEvidenceSnapshot,
      setTuning({ focus = {}, horizon = {} } = {}) {
        return {
          focus: setFocusDeemphasisParams(focus),
          horizon: setAircraftRecessionParams(horizon),
        };
      },
      getTuning() {
        return {
          focus: { ...getFocusDeemphasisParams() },
          horizon: { ...getAircraftRecessionParams() },
        };
      },
      takeFrameClock(startMs = 1_000_000_000) {
        if (!p._viewer || !Number.isFinite(startMs)) return { ok: false, nowMs: null };
        p._viewer.useDefaultRenderLoop = false;
        setFocusEvidenceNowMs(startMs);
        p._lastFleetTickMs = startMs - FLEET_DR_INTERVAL_MS;
        // Cross a browser task boundary, then close Cesium's pending-loop
        // latch. Any already-queued callback still observes the false gate,
        // while manual evidence renders can begin without waiting on VSYNC.
        return new Promise((resolve) => setTimeout(() => {
          if (p._viewer?._cesiumWidget) p._viewer._cesiumWidget._renderLoopRunning = false;
          resolve({ ok: true, nowMs: startMs });
        }, 0));
      },
      advanceFrameClock(deltaMs = FLEET_DR_INTERVAL_MS) {
        return advanceFocusEvidenceNowMs(deltaMs);
      },
      releaseFrameClock() {
        setFocusEvidenceNowMs(null);
        if (p._viewer) p._viewer.useDefaultRenderLoop = true;
      },
    }),
  } : {}),

  /**
   * Return layer health/status for the HUD stats chip.
   * @returns {{count: number, lastUpdate: number|null, stale: boolean, error: string|null, status: number|null, retryInSec: number}}
   */
  getStats() {
    const retryInSec = _retryAt ? Math.max(0, Math.ceil((_retryAt - Date.now()) / 1000)) : 0;
    return {
      count: _count,
      lastUpdate: _lastUpdate,
      stale: _backoff,
      error: _lastError,
      status: _lastStatus,
      retryInSec,
      source: _lastSource,
      coverage: _lastCoverage,
    };
  },
};


/**
 * Install a LEFT_CLICK handler on the scene canvas for flight selection.
 *
 * Picking logic checks both `picked.primitive` and `picked.id` because
 * different CesiumJS versions surface BillboardCollection hits differently.
 * Also registers a global keydown listener for the Escape key.
 *
 * Idempotent — returns immediately if a handler is already installed.
 *
 * @param {Cesium.Viewer} viewer
 */
function _installClickHandler(viewer) {
  if (_clickHandler) return; // already installed

  // Cross-layer untrack: if ANOTHER layer (military, vessels, …) grabs the follow-camera, drop our
  // tracking so its model/entity/update-loop don't orphan — without touching viewer.trackedEntity
  // (the new owner controls it). Guarded so the intermediate untrack→retrack of OUR OWN switch
  // (viewer.trackedEntity briefly undefined) doesn't self-clear.
  if (!_trackedEntityChangedRemove) {
    _trackedEntityChangedRemove = viewer.trackedEntityChanged.addEventListener(() => {
      if (p._trackedIcao && p._viewer && p._viewer.trackedEntity && p._viewer.trackedEntity !== p._trackedEntity) {
        _clearTracking(true, {
          origin: p._viewer.trackedEntity?.gevSelectionOrigin || 'programmatic',
        });
      }
    });
  }

  _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  _clickPressClock = domEventPressClock(viewer.scene.canvas);
  bindTrackingClickGesture(_clickHandler, (click, gesture) => {
    // Camera drags never select or deselect, even if they finish over a plane.
    // Duration alone is allowed through so a stationary long press can still
    // select/switch contacts; the destructive empty-space branch below applies
    // the full travel + duration click classifier.
    if (!isTrackingSelectionGesture(gesture)) return;
    // Cockpit mode owns the camera and keeps the current aircraft as its
    // first-person reference. A globe click must not fall through to the
    // normal empty-space deselection path; cockpit has explicit exit controls.
    if (document.body.classList.contains('cockpit-mode')) return;
    const picked = viewer.scene.pick(click.position);

    if (picked) {
      // Clicking the tracked entity itself — ignore (don't deselect)
      if (picked.id === p._trackedEntity) return;

      // Clicking the plane we're ALREADY tracking (its standalone 3D model or
      // any pick carrying its icao) — same no-op as the 2D tracked-entity click
      // above. H1: the model used to have no pick id, so this fell through to
      // "empty space" and deselected the very plane being tracked.
      if (p._trackedIcao) {
        const rawPick = typeof picked.id === 'string' ? picked.id : picked.primitive?.id;
        if (picked.primitive === p._trackedModel || rawPick === p._trackedIcao) return;
      }

      // For BillboardCollection picks, the billboard may be at picked.primitive or picked.id
      const billboard = picked.primitive;
      if (billboard && billboard.id && p._billboards.has(billboard.id)) {
        p._cancelPendingTrackingRestore();
        _trackFlight(billboard.id, { origin: 'user' });
        return;
      }
      // Some CesiumJS versions surface the id as a string on picked.id instead
      if (picked.id && typeof picked.id === 'string' && p._billboards.has(picked.id)) {
        p._cancelPendingTrackingRestore();
        _trackFlight(picked.id, { origin: 'user' });
        return;
      }
    }

    // A pick that belongs to a sibling layer (military aircraft, satellite,
    // vessel, station, CCTV camera…) is not "empty space" — leave tracking
    // alone and let that layer handle it. resolvePickId String()-coerces the
    // heterogeneous pick ids (numeric NORAD ids, AIS record objects) so the
    // registry predicates can recognize them (H2).
    if (picked) {
      const pickedId = resolvePickId(picked);
      if (pickedId && isOwnedByOtherLayer('flights', pickedId)) return;
    }

    // Clicked empty space — deselect only for a clean, short click. A slow
    // stationary press may select above, but cannot release existing tracking.
    if (!isTrackingClickGesture(gesture)) return;
    if (p._trackedIcao) {
      p._cancelPendingTrackingRestore();
      _clearTracking(false, { origin: 'user' });
    }
  }, { now: _clickPressClock.now });

  document.addEventListener('keydown', p._onKeyDown);
}

// Batch 5 item 2: moved into the shared pipeline (flightsTracking.js); kept as
// exports here so the test-facing contract of this module is unchanged.
export const _setCockpitDetectionSubjectForTest = (active, subjectId = null) => p._setCockpitDetectionSubjectForTest(active, subjectId);
export const _trackedModelRegimeActiveForTest = () => p._trackedModelRegimeActiveForTest();
export const _updateTrackedModelForTest = () => p._updateTrackedModelForTest();
export const _trackedBillboardColorForTest = () => p._trackedBillboardColorForTest();
export const _driveFleetModelHandoffForTest = ({ icao24, position, course = 0 }) => p._driveFleetModelHandoffForTest({ icao24, position, course });
export const _ensureFleetModelForTest = (icao24) => p._ensureFleetModelForTest(icao24);

export default flightsLayer;
