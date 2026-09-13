import * as Cesium from 'cesium';
import { api } from '../config/apiEndpoints.js';
import { aircraftIncludedInNearby } from './aircraftNearbyPolicy.js';
import { registerPickOwner, unregisterPickOwner, isOwnedByOtherLayer, resolvePickId } from './pickRegistry.js';
import { registerSpriteCollection, restoreSpriteOrder } from './spriteOrder.js';
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
import { classifyAircraft, CLASS_SCALE_2D, CLASS_SCALE_3D, CLASS_MODEL_REAL } from './aircraftClass.js';
import { modelVisualAnchor, trailAnchorForModel, trailHeadStart, visualCenterForModel } from './modelVisualAnchor.js';
import { aircraftIcon, TRACKED_ICON_PX } from './aircraftIcons.js';
import { isTr3b, tr3bAircraftClass, tr3bTypeLabel } from './tr3bRegistry.js';
import {
  applyTrackedCameraFrame,
  trackedModelScaleForPixelCap,
} from './trackedCamera.js';
import {
  courseBetweenCartesians, limitCourseStep, turnRateFromFixHistory,
  lerpAngleDeg, speedRamp, courseSlewCapDps, displayedKinematics, staleCoastLimitSeconds,
  liftRepeatedGroundFix, synthesizeForwardKinematicsFix, COURSE_HOLD_SPEED_MPS,
} from './motionModel.js';
import { setMilitaryLayerActive, registerMilitaryIcaos } from './militaryRegistry.js';
import { formatFlightLevel } from './detectionDraw.js';
import { pickRenderAltitudeM } from './renderAltitude.js';
import { cachedGroundFloor, floorAltitudeM, warmGroundFloor, resolveGroundFloorCellsBounded, GROUND_FLOOR_LIFT_M } from './groundFloor.js';
import { sampleMeshFloorCells } from './meshFloorSampler.js';
import { ensureGeoidReady, geoidHeight } from './geoid.js';
import {
  advanceProjectedSpriteFocus,
  clearFocusTarget,
  focusNowMs,
  getFocusTarget,
  nearFarScalarValueAtDistance,
  publishFocusTargetFromCachedPosition,
} from './focusDeemphasis.js';
import {
  applyAircraftBillboardTreatment,
  applyAircraftModelTreatment,
} from './aircraftRecession.js';
import { refreshTrackedReadout, trackedLabelModelFromText } from './trackedReadout.js';
import {
  clearTrackedSubjectContext,
  selectTrackedSubjectContext,
} from './contextStore.js';
import { CONTACT_MATCH_TIER, contactMatchWins, rankContactMatch } from './contactMatch.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { createFlightTrackingPipeline } from './flightsTracking.js';

/**
 * @module militaryFlights
 * @description Real-time military flight tracking layer powered by the adsb.lol API.
 *
 * Renders aircraft as amber chevron billboards in a single BillboardCollection
 * for GPU-efficient batch drawing. Supports click-to-track: selecting an aircraft
 * spawns an Entity the camera follows, whose position is driven by a
 * dead-reckoning CallbackProperty. The whole fleet renders at
 * now - p.RENDER_DELAY_SEC so positions interpolate BETWEEN two known fixes
 * instead of extrapolating ahead and snapping back when the next poll lands.
 *
 * Billboard orientation uses alignedAxis set to the WGS84 surface normal at each
 * position so that the rotation angle (heading/track) operates in the local tangent
 * plane where 0 deg = north; near nadir the icons switch to screen-aligned
 * rotation (camera.heading - track) with hysteresis.
 */


/** @constant {string} API endpoint proxied to adsb.lol military feed */
const API_URL = api.adsblol();
/** @constant {number} Milliseconds to wait before retrying after a transient error */
const ERROR_BACKOFF_INTERVAL = 20000;
/** @constant {number} Longer cooldown (ms) after a 429 rate-limit, mirroring flights.js */
const BACKOFF_INTERVAL = 45000;
/** @constant {number} Max position samples retained per aircraft for dead reckoning */
const POSITION_HISTORY_LIMIT = 5;
/** @constant {number} Base billboard display scale */
const BILLBOARD_SCALE = 0.7;

/** @constant {Cesium.Color} Default amber tint for untracked military billboards */
const MIL_ICON_COLOR = Cesium.Color.fromCssColorString('#FFB800');
/** @constant {Cesium.Color} Lighter amber tint applied to the actively tracked aircraft */
const TRACKED_ICON_COLOR = Cesium.Color.fromCssColorString('#FFD166');

// --- Ground traffic (product change 2026-07-03; mirror of flights.js) ---------------
// adsb.lol/readsb flags ground traffic with alt_baro === "ground" (no separate
// boolean). Such aircraft are RENDERED instead of floating at the 3 km altitude
// fallback: same silhouette + rotation pipeline, clickable/trackable/detectable,
// sticky metadata updating normally. The on-ground flip restyles the existing
// billboard IN PLACE (landing/takeoff transition, never a removal); ground planes
// draw no trails. In 3D mode they take model slots like airborne planes (owner
// decision 2026-07-03 — no air/ground distinction), placed by the one-shot
// ground snap (see p._modelDisplayPosition).
//
// TINT: full-strength amber, same as airborne (validated behavior 2026-07-03 field
// test: the day-1 slate-gray 50%-alpha muted tint was unreadable — "in NYC I can
// barely see them"). "On the ground" reads from the ×0.8 scale + missing trail;
// "feed-dropped, coasting" stays the 45%-alpha stale fade.
/** Ground billboards render slightly smaller so airport clutter stays visually minor. */
const GROUND_SCALE = 0.8;


// --- 3D model rendering (mirrors flights.js) -----------------------------------------
// When enabled, military aircraft render as 3D glTF jet models once the camera is below
// p.MODEL_ALT_CEIL_M (zoomed in); higher up they stay flat billboards. Eligibility is
// FRUSTUM-based (on-screen), and the slots go to either the nearest planes ('proximity')
// or every in-view plane ('all'), each backed by a hard cap so a draw-call explosion
// can't tank the frame (no instancing yet). Distinct asset + amber tint set this layer
// apart from the commercial flights layer.
const JET_MODEL_URL = '/models/jet.glb';
export const TRACKED_MODEL_MAX_PX = 200; // selected close-range tracked-target feel
const MODEL_NATIVE_RADIUS_M = 29.83;
// jet.glb is transform-applied at real-world scale — native bounding radius
// 29.83 m at scale 1. ×1 → ~22–43 m aircraft across CLASS_SCALE_3D, matching
// flights.js world sizes. At the old copied ×24, models rendered
// 600–1000 m across (invisible at the ~6 km follow range where minimumPixelSize
// dominates, but zoom under ~1 km put the camera INSIDE the plane). Locked by
// modelScale.test.mjs.
const MODEL_SCALE = 1;
// Per-mode caps + radii — mirror of flights.js. Modes differ by RADIUS (not just cap) so Proximity
// and All aren't identical when few planes are in range; on-screen planes win the cap (see flights.js).
const MODEL_MAX = 150;          // 'proximity' cap
const MODEL_MAX_ALL = 350;      // 'all' cap

// Cockpit keeps the standard Display radii but lowers the GLB budget. Contacts
// inside the selected band remain AIR silhouettes when they cannot own a model;
// contacts outside the band use compact dots.
const COCKPIT_MODEL_MAX = 60;         // max concurrent GLBs in cockpit (never raises the map cap)
const MODEL_HEADING_OFFSET_DEG = 180; // every aircraft GLB is exported nose -X in the shared transform-applied convention
// Preserve the layer's amber identity while reducing approved texture/livery
// contribution to a weak diffuse hint, matching civilian launch presentation.
const MODEL_COLOR_BLEND_AMOUNT = 0.94;
// airplane.glb (the shared 747) constants for this layer's heavy classes. The
// asset has its former 24× runtime calibration baked into transform-applied
// meter-scale geometry; these values mirror flights.js and are regression-pinned.
const PLANE_MODEL_URL = '/models/airplane.glb';
const PLANE_MODEL_SCALE = 1;
const PLANE_NATIVE_RADIUS_M = 34.41;
const PLANE_BELLY_OFFSET_NATIVE = 6.719;
/** Per-class model spec for THIS layer (2026-08-16, field test ask:
 *  military contacts should read as their WEIGHT CLASS, always in this layer's
 *  amber). Real Hangar GLBs serve the classes they cover (meters, nose −X →
 *  180° offset); airliner/quadjet/glider get the shared 747 silhouette
 *  (airplane.glb — C-5M/RC-135-style heavies stop rendering as bizjets);
 *  fastjet and unknown keep jet.glb with the same 180° offset. The MIX tint stays
 *  dominant everywhere — military is amber, tracked is TRACKED_ICON_COLOR,
 *  and the tint must dominate any livery. Specs are
 *  static per class — memoized (the fleet pass asks at 12 Hz per model). */
const _specCache = new Map();
function _modelSpec(klass) {
  let spec = _specCache.get(klass);
  if (spec) return spec;
  const real = CLASS_MODEL_REAL[klass];
  if (real) {
    spec = { url: real.url, scale: 1, nativeRadiusM: real.radiusM, bellyM: real.bellyM, headingOffsetDeg: 180, blendAmount: MODEL_COLOR_BLEND_AMOUNT, visualCenterNative: visualCenterForModel(real.url), trailAnchorNative: trailAnchorForModel(real.url) };
  } else if (klass === 'airliner' || klass === 'quadjet' || klass === 'glider') {
    const scale = PLANE_MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
    spec = { url: PLANE_MODEL_URL, scale, nativeRadiusM: PLANE_NATIVE_RADIUS_M, bellyM: PLANE_BELLY_OFFSET_NATIVE * scale, headingOffsetDeg: 180, blendAmount: MODEL_COLOR_BLEND_AMOUNT, visualCenterNative: visualCenterForModel(PLANE_MODEL_URL), trailAnchorNative: trailAnchorForModel(PLANE_MODEL_URL) };
  } else {
    const scale = MODEL_SCALE * (CLASS_SCALE_3D[klass] || 1);
    spec = { url: JET_MODEL_URL, scale, nativeRadiusM: MODEL_NATIVE_RADIUS_M, bellyM: MODEL_BELLY_OFFSET_NATIVE * scale, headingOffsetDeg: MODEL_HEADING_OFFSET_DEG, blendAmount: MODEL_COLOR_BLEND_AMOUNT, visualCenterNative: visualCenterForModel(JET_MODEL_URL), trailAnchorNative: trailAnchorForModel(JET_MODEL_URL) };
  }
  _specCache.set(klass, spec);
  return spec;
}
// Grounded-model belly offset: jet.glb's centred origin sits 5.631 native units (= meters — this
// asset is real-world scale) ABOVE its lowest vertex (glTF Y-up scene AABB with node
// transforms applied — same reader as modelScale.test.mjs, measured 2026-07-03).
// × MODEL_SCALE(1) × class multiplier ≈ 4.4–8.6 m of lift, so a ground-snapped model
// rests its lowest geometry (gear/belly) ON the sampled tile skin instead of sinking to
// the fuselage-centerline origin. Locked against the GLB by modelScale.test.mjs.
const MODEL_BELLY_OFFSET_NATIVE = 5.631;
let _lastModelCapWarnMs = 0; // throttle the "more planes in view than the cap" console notice
/** @type {Cesium.Model|null} retained preload that keeps the glTF cache warm */
let _preloadModel = null;
/** Amber fade target for the tracked billboard once the model takes over (mirrors flights.js CYAN_TRANSPARENT). */
const AMBER_TRANSPARENT = MIL_ICON_COLOR.withAlpha(0);
const _scratchModelHpr = new Cesium.HeadingPitchRoll(0, 0, 0);
const _scratchModelMtx = new Cesium.Matrix4();
const _scratchModelBS = new Cesium.BoundingSphere(new Cesium.Cartesian3(), 1.0); // frustum-visibility test

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Batch 5 item 2 (sub-unit b): the shared tracking/DR/billboard/cockpit/trail
// pipeline lives in flightsTracking.js; `p` is this layer's private instance.
// The config injects military's seams: uniform MIL_ICON_COLOR presentation,
// ground-floored trail fixes, speedMps/track INFO fields, and the built
// tracked label — everything else is the shared verbatim pipeline.
const p = createFlightTrackingPipeline({
  modelSpec: _modelSpec,
  refreshTr3bContact: _refreshTr3bContact,
  clearTracking: _clearTracking,
  trackFlight: _trackFlight,
  updateTrackedModel: _updateTrackedModel,
  contextSubjectMetadata: _contextSubjectMetadata,
  fleetBillboardColor: () => MIL_ICON_COLOR,
  fleetBillboardScale: _militaryBillboardScale,
  fleetFreshnessColor: (icao24, alpha) => MIL_ICON_COLOR.withAlpha(alpha),
  modelCap: _modelCap,
  modelColor: _modelColor,
  modelMatrix: _modelMatrix,
  normalBillboardScaleByDistance: _normalBillboardScaleByDistance,
  refreshTrailDisplay: _refreshTrailDisplay,
  trailFloorFix: _trailFloorPosition,
  trackedLabelText: (icao24) => _buildTrackedLabel(p._flightData.get(icao24), icao24),
  infoSpeed: (info) => info && info.speedMps,
  infoHeading: (info) => info && info.track,
  trackedModelMaxPx: TRACKED_MODEL_MAX_PX,
  trackedFocusScaleBase: BILLBOARD_SCALE,
  trackedLabelAccent: '#ffd166',
  unmodeledTrackedColor: AMBER_TRANSPARENT,
  modeledIconColor: TRACKED_ICON_COLOR,
});

/** Stable lightweight records reused by the detection overlay between polls. */
let _detectionObjects = new Map();
/** @type {number} Current number of visible aircraft */
let _count = 0;
/** @type {number|null} Epoch ms of last successful API update */
let _lastUpdate = null;
/** @type {boolean} True when in error-backoff mode */
let _backoff = false;
/** @type {number} Epoch ms after which the next retry is allowed */
let _retryAt = 0;
/** @type {string|null} Human-readable description of the last error */
let _lastError = null;

/** @type {number|null} HTTP status code from the last API response */
let _lastStatus = null;
/** @type {boolean} True once ensureGeoidReady() has resolved (awaited once at enable()). Mirror of flights.js. */
let _geoidReady = false;
/** @type {Map<string, number>} icao24 -> geoid undulation N (m), cached (negligible drift per-aircraft). */
const _geoidNCache = new Map();

let _trackingRefreshEpoch = 0;
let _lastTrackingRefreshOutcome = {
  epoch: 0,
  status: 'unavailable',
  ids: new Set(),
  source: 'adsb.lol',
};
/** Disposes the single active tracked-camera framing owner. */
let _trackedCameraFrameStop = null;
/** @type {Cesium.ScreenSpaceEventHandler|null} Click handler for selecting aircraft */
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
    layerId: 'military',
    id: icao24,
    label: p._toCleanText(info.callsign) || p._toCleanText(info.registration) || icao24,
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
  const info = p._flightData.get(icao24);
  const label = described.callsign || described.registration || icao24;
  return {
    id: icao24,
    layerId: 'military',
    layerName: 'Military Flights',
    source: 'adsb.lol',
    label,
    latitude: described.latitude,
    longitude: described.longitude,
    // Flat text only: the voice payload compacts properties through a
    // string cleaner that drops nested objects.
    properties: {
      name: label,
      operator: p._toCleanText(info?.operator) || '',
      callsign: described.callsign || '',
      registration: described.registration || '',
      // Converted contacts report their class as TR-3B — the same override
      // the readout and Contacts card show.
      type: tr3bTypeLabel(icao24, p._toCleanText(info?.type) || ''),
      altitude: described.onGround ? 'on ground' : _formatAltitude(info?.altitudeFt),
      speed: Number.isFinite(described.velocityMps)
        ? `${Math.round(described.velocityMps * 1.944)} kt`
        : '',
      heading: Number.isFinite(described.track) ? `${Math.round(described.track)}°` : '',
      icao24,
      // Honesty cue: the contact is coasting on dead reckoning, so the
      // narrated position/velocity are last-known rather than live.
      status: described.stale ? 'stale (missed polls)' : 'live',
    },
  };
}



function _normalBillboardScaleByDistance() {
  // Match commercial flights and preserve the established close-range 3×
  // default. Smaller user-visible scaling must be proposed separately.
  return new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5);
}


function _militaryBillboardScale(icao24) {
  const meta = p._flightData.get(icao24);
  return BILLBOARD_SCALE * (CLASS_SCALE_2D[meta?.klass] || 1) * (meta?.onGround ? GROUND_SCALE : 1);
}





// ---------------------------------------------------------------------------
// Track-history trail state (PRD WS-F F2/F4): a fading polyline behind the
// tracked aircraft. The accumulation array is intentionally SEPARATE from
// p._positionHistory (capped at POSITION_HISTORY_LIMIT=5 for dead reckoning)
// so the visible trail can grow to p.TRAIL_MAX_POINTS fixes.
// ---------------------------------------------------------------------------

/** @constant {string} Military trail hue (PRD F4, pinned). */
const TRAIL_COLOR = '#FFB800';
/** @type {number} Uniquifier for head-segment entity ids (Cesium requires unique ids). */
let _trailHeadSeq = 0;

// ---------------------------------------------------------------------------
// Render-behind smoothing (mirrors flights.js): the fleet renders at
// now - p.RENDER_DELAY_SEC so positions interpolate BETWEEN two known fixes
// instead of extrapolating ahead and snapping back when the next poll lands.
// Removing the delay reintroduces the back/forward oscillation and is a
// regression.
// ---------------------------------------------------------------------------

/** @constant {number} Polls an aircraft may miss before removal (transient adsb.lol dropouts). */
const MISSING_POLL_LIMIT = 3;
// --- Landed-plane fast cull (mirror of flights.js; field report
// 2026-07-02: "phantom" planes lingered ~2 min at airports after touchdown).
// The feed's ground flag lags the actual landing, so a landed plane's last
// airborne fixes show it low + slow on the runway; when it then drops out of
// the poll it has landed, not hit a transient gap — evict after ONE missed
// poll. Thresholds: below ~500 ft baro (≈150 m MSL — near-sea-level fields
// only; a high-elevation airport ghost falls back to the normal grace) AND
// below ~45 kts ground speed (≈23 m/s — rollout/taxi; nothing in normal
// FLIGHT is this slow, so cruise planes always keep the full grace).
/** @constant {number} Max baro altitude (ft, MSL) for the landed fast cull (~150 m). */
const LANDED_ALT_MAX_FT = 500;
/** @constant {number} Max ground speed (m/s) for the landed fast cull (~45 kts). */
const LANDED_SPEED_MAX_MPS = 23;
/** @constant {number} Missed-poll allowance for likely-landed planes (1 = removed on the first missed poll). */
const LANDED_MISSING_POLL_LIMIT = 1;
// Field-test fix (RS46, 2026-07-06): only contacts rendering below this
// ellipsoidal height get the below-ground floor clamp + a coarse floor-cell
// warm. Terrain outside the extreme Himalaya tops out well under this, so
// cruise traffic (which can never be below ground) costs zero terrain
// lookups; low pattern/heli work — the class that actually clips hillsides —
// gets the floor.
/** @constant {number} Max render altitude (m, ellipsoidal) eligible for the ground-floor clamp. */
const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;
/** @type {Map<string, number>} icao24 -> consecutive missed polls */
let _missingPolls = new Map();

// ---------------------------------------------------------------------------
// Nadir-stable icon orientation (mirrors flights.js): surface-normal alignment
// degenerates when the camera looks straight down (the normal is parallel to
// the view direction and the shader's screen-projected angle is 0/0). Near
// nadir we switch to screen-aligned billboards with
// rotation = camera.heading - track (screen-up points at azimuth
// camera.heading; a CW track t appears t-h from screen-up; billboard rotation
// is CCW-positive => r = h - t). Discrete switch with hysteresis; rotations
// are continuous at the boundary with this formula.
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

const _scratchCarto = new Cesium.Cartographic();
const _scratchRenderTime = new Cesium.JulianDate();
const _scratchFleetPos = new Cesium.Cartesian3();
const _scratchDrRaw = new Cesium.Cartesian3();
const _trackedPosHolder = new Cesium.Cartesian3();



// -- Tracked-display reconciliation (see flights.js for the rationale): absorb a raw
// position step (warm-up→interpolation handoff, feed glitch, backfill splice) into a
// correction offset that decays to zero over DR_CORRECTION_MS, so the tracked icon,
// camera, and trail head never visibly jump — with zero steady-state lag. --
const DR_CORRECTION_MS = 900;
const _drCorrection = new Cesium.Cartesian3(0, 0, 0);
let _drCorrectionStartMs = 0;
const _drPrevRaw = new Cesium.Cartesian3();
const _drPrevDisplay = new Cesium.Cartesian3();
let _drPrevMs = 0;

/**
 * Coerce a value to a finite number, returning null if not possible.
 * Handles both numeric and string inputs (e.g. API fields that may arrive as strings).
 * @param {*} value - Raw value from the API response
 * @returns {number|null} Finite number or null
 */
function _toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}


/**
 * Format an altitude value in feet for display, with fallback text.
 * @param {number|null|undefined} altitudeFt - Barometric altitude in feet
 * @returns {string} Formatted altitude string (e.g. "35000 ft" or "Alt unknown")
 */
function _formatAltitude(altitudeFt) {
  if (!Number.isFinite(altitudeFt)) return 'Alt unknown';
  return `${Math.round(altitudeFt)} ft`;
}

/**
 * True when the aircraft's latest metadata reads "on or about the runway"
 * (low + slow) — see the landed fast-cull rationale above. Both gates must
 * hold, so a plane missing either datum keeps the normal grace.
 * @param {string} icao24 - ICAO hex identifier of the aircraft
 * @returns {boolean}
 */
function _likelyLanded(icao24) {
  const info = p._flightData.get(icao24);
  if (!info) return false;
  // Round 7 (mirror of flights.js): fast cull only for contacts seen
  // AIRBORNE this session — parked contacts ride the normal grace so feed
  // flaps don't churn their identity/floor state.
  if (info.wasAirborne !== true) return false;
  if (info.onGround) return true;
  return Number.isFinite(info.altitudeFt) && info.altitudeFt < LANDED_ALT_MAX_FT
    && Number.isFinite(info.speedMps) && info.speedMps < LANDED_SPEED_MAX_MPS;
}

/**
 * Build the multi-line presentation text for the protected tracked host card.
 * Lines: callsign, type/registration, operator/altitude.
 * While the plane is in its missed-poll grace (coasting on dead reckoning
 * with sticky metadata) the first line carries a "· STALE" cue — the fleet's
 * 45%-alpha billboard fade doesn't apply to the tracked plane (its entity
 * owns the visual), so without this the readout would present last-known
 * altitude/speed as live.
 * @param {Object|null} info - Flight metadata from p._flightData
 * @param {string} icao24 - ICAO hex identifier (fallback display name)
 * @returns {string} Newline-separated label text
 */
function _buildTrackedLabel(info, icao24) {
  const stale = (_missingPolls.get(icao24) || _backoff) ? ' · STALE' : '';
  const callsign = (p._toCleanText(info?.callsign) || p._toCleanText(info?.registration) || icao24) + stale;
  // Converted contacts report their class as TR-3B — that override is exactly
  // what the Easter egg replaces the real type with.
  const type = tr3bTypeLabel(icao24, p._toCleanText(info?.type) || 'Type unknown');
  const registration = p._toCleanText(info?.registration) || 'Reg unknown';
  const operator = p._toCleanText(info?.operator) || 'Operator unknown';
  const altitude = _formatAltitude(info?.altitudeFt);
  const speedKt = info?.speedMps ? Math.round(info.speedMps * 1.944) : null;
  const tail = speedKt ? `${altitude} · ${speedKt} kt` : altitude;
  return [
    callsign,
    `${type} · ${registration}`,
    `${operator} · ${tail}`,
  ].join('\n');
}




/**
 * Re-render one contact after its TR-3B conversion (or the active IR style)
 * changed. Mirror of flights.js: converting drops any 3D model so the triangle
 * owns the visual, then the billboard, tracked entity, and card re-derive.
 * @param {string} icao24 - ICAO 24-bit address.
 * @returns {boolean} True when the layer owns this contact.
 */
function _refreshTr3bContact(icao24) {
  const id = String(icao24 || '').trim().toLowerCase();
  if (!id) return false;
  if (isTr3b(id)) {
    if (p._models.has(id) || p._modelPending.has(id)) p._releaseModel(id);
    const modelled = p._billboards.get(id);
    if (modelled && id !== p._trackedIcao) modelled.show = true; // horizon cull re-asserts next tick
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
 * the production military poll reconciler. Tests still call
 * `militaryFlightsLayer.update()` rather than invoking the writer directly.
 * @param {object} state
 * @param {string} state.icao24
 * @param {object} state.entity
 * @param {object} state.meta
 * @param {object} state.billboard
 * @param {object} state.billboardCollection
 * @param {object} state.viewer
 * @param {Array<Object>} [state.history=[]]
 * @param {boolean} [state.tracked=true]
 * @param {Iterable<[string, object]>} [state.models=[]] - Fleet 3D models keyed
 *   by icao24, for the billboard-hidden/model-shown handoff state.
 */
export function _setTrackedMilitaryRefreshStateForTest({
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
export function _setMilitaryTrackingRefreshOutcomeForTest({
  status = 'accepted',
  ids = [],
  source = 'adsb.lol',
} = {}) {
  const epoch = ++_trackingRefreshEpoch;
  _lastTrackingRefreshOutcome = {
    epoch,
    status,
    ids: new Set(ids.map((id) => String(id).trim().toLowerCase())),
    source,
  };
}

/** Add a cached contact so tests can model a target arriving on a later feed. */
export function _addMilitaryTrackingCandidateForTest({ icao24, meta, billboard, history = [] }) {
  p._billboards.set(icao24, billboard);
  p._flightData.set(icao24, meta);
  p._positionHistory.set(icao24, history);
}

/** Return the deferred restore target held by the production tracker. */
export function _pendingMilitaryTrackingRestoreForTest() {
  return p._pendingTrackingRestore?.id ?? null;
}

/** Exercise the production deferred-restore retry after a simulated feed refresh. */
export function _applyPendingMilitaryTrackingRestoreForTest() {
  return p._applyPendingTrackingRestore();
}







/**
 * Dead-reckon an aircraft's current position using ENU (East-North-Up) frame math.
 *
 * Renders one poll interval behind real time so positions interpolate between
 * two KNOWN fixes whenever possible (see p.RENDER_DELAY_SEC rationale). When the
 * newest fix is older than the delayed render time (stale position), projects
 * forward using the aircraft's ground speed and track through the freshest
 * source contact plus a bounded grace window.
 *
 * @param {string} icao24 - ICAO hex identifier of the aircraft
 * @param {Cesium.Cartesian3} [result] - Optional out-parameter to write into.
 * @returns {Cesium.Cartesian3|null} Estimated current ECEF position, or null if no history
 */
function _deadReckon(icao24, result) {
  const history = p._positionHistory.get(icao24);
  const info = p._flightData.get(icao24);
  if (!history || history.length === 0) {
    p._drCourseDeg = null; p._drSpeedMps = null; p._drCourseHold = false;
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
      const segSpeed = span > 0 ? chordLenM / span : ((info && info.speedMps) || 0);
      const fallbackTrack = (info && info.track) || 0;
      const trackFrom = Number.isFinite(a.track) ? a.track : fallbackTrack;
      const trackTo = Number.isFinite(b.track) ? b.track : trackFrom;
      const trackCourse = lerpAngleDeg(trackFrom, trackTo, t);
      const w = (info && info.klass === 'helicopter') ? 0 : speedRamp(segSpeed);
      const chordCourse = w > 0 ? courseBetweenCartesians(a.position, b.position) : null;
      p._drCourseDeg = chordCourse != null ? lerpAngleDeg(trackCourse, chordCourse, w) : trackCourse;
      p._drSpeedMps = segSpeed;
      p._drCourseHold = segSpeed < COURSE_HOLD_SPEED_MPS;
      return Cesium.Cartesian3.lerp(a.position, b.position, t, out);
    }
  }

  const newest = history[history.length - 1];
  const elapsedSec = Cesium.JulianDate.secondsDifference(renderTime, newest.time);
  if (elapsedSec <= 0) {
    // Warm-up: renderTime predates ALL history (freshly seen / just-started-tracking
    // aircraft, before p.RENDER_DELAY_SEC of history has accumulated, so no bracketing
    // pair exists yet). Render at the DELAYED renderTime — preserving the behind-real-time
    // invariant — by extrapolating the OLDEST fix BACKWARD to renderTime. As history
    // fills, renderTime advances toward the first fix and the icon glides FORWARD into
    // the bracketing interpolation above with NO freeze and NO backward snap. (Holding
    // the oldest fix froze the icon until enough history accrued, then jumped.)
    const oldest = history[0];
    const lookbackSec = Cesium.JulianDate.secondsDifference(oldest.time, renderTime); // ≥ 0
    return p._extrapolateFix(oldest, info, -Math.min(lookbackSec, 60), out, (info && info.turnRateDps) || 0);
  }

  // Continue through fresh adsb.lol contacts even when the position epoch has
  // not advanced, but keep an absolute stale-feed drift ceiling.
  const coastLimitSec = staleCoastLimitSeconds({
    // Captured at poll normalization so the fleet tick does not allocate a
    // Date for every aircraft twelve times per second.
    fixEpochMs: Number.isFinite(newest.epochMs)
      ? newest.epochMs
      : Cesium.JulianDate.toDate(newest.time).getTime(),
    lastContactEpochMs: info?.lastContactEpochMs,
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
    clearFocusTarget('militaryFlights', icao24);
    return null;
  }

  const nowMs = Date.now();
  const info = p._flightData.get(icao24);
  if (sameTrack) {
    const dtSec = Math.max(0.001, (nowMs - _drPrevMs) / 1000);
    const speed = (info && info.speedMps) || 0;
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
  const display = Cesium.Cartesian3.multiplyByScalar(_drCorrection, factor, _trackedPosHolder);
  Cesium.Cartesian3.add(raw, display, display);

  Cesium.Cartesian3.clone(raw, _drPrevRaw);
  Cesium.Cartesian3.clone(display, _drPrevDisplay);
  _drPrevMs = nowMs;
  p._drReconcileValid = true;
  p._cachedDRPosition = display;
  const focusSizePx = p._trackedFocusSizePx(icao24, p._cachedDRPosition);
  // Publish the exact frame cache shared by entity + follow camera. A second
  // DR sample here would advance reconciliation in a different frame phase
  // and visibly jitter the focus rectangle against the tracked aircraft.
  publishFocusTargetFromCachedPosition({
    ownerLayer: 'militaryFlights',
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







/** Model tint, mirroring the billboard color rules (amber instead of cyan/white). */
function _modelColor(icao24) {
  if (icao24 === p._trackedIcao) return TRACKED_ICON_COLOR;
  return MIL_ICON_COLOR;
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
    console.warn(
      `[Data:Military] tracked 3D model gave up after ${p._trackedModelFailCount} failed loads of ${url} — `
      + 'this contact stays 2D until another is selected',
      err,
    );
  }
}



/** Active model cap — the eligibility pre-pass AND p._ensureModel's admission checks must use the
 *  SAME value, else 'all' (MODEL_MAX_ALL) marks planes eligible that p._ensureModel refuses at the
 *  lower MODEL_MAX, silently degrading 'all' to 'proximity'. */
function _modelCap() {
  const mapCap = p._models3dMode === 'all' ? MODEL_MAX_ALL : MODEL_MAX;
  // `Math.min` on purpose: cockpit may only ever LOWER the GLB budget.
  return p._cockpitContactMode ? Math.min(COCKPIT_MODEL_MAX, mapCap) : mapCap;
}


/** World model matrix from a position + course heading (pitch/roll 0; ENU frame). Writes into
 *  `result` and returns it — pass each model's OWN `.modelMatrix` so models never share one mutable
 *  matrix object (see flights.js for the full rationale: sharing one scratch stacked every model on
 *  the last-written transform, and the per-frame tracked write made it flicker). */
function _modelMatrix(pos, headingDeg, result = _scratchModelMtx, offsetDeg = MODEL_HEADING_OFFSET_DEG) {
  _scratchModelHpr.heading = Cesium.Math.toRadians((headingDeg || 0) + offsetDeg);
  _scratchModelHpr.pitch = 0;
  _scratchModelHpr.roll = 0;
  return Cesium.Transforms.headingPitchRollToFixedFrame(
    pos, _scratchModelHpr, Cesium.Ellipsoid.WGS84, undefined, result,
  );
}













/** Per-frame driver for the standalone tracked model (see flights.js for the rationale). The
 *  tracked entity stays a pure billboard, so the follow-camera never stalls/freezes on 3D-toggle. */
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
      color: p._irBoost ? Cesium.Color.WHITE : TRACKED_ICON_COLOR,
      colorBlendMode: Cesium.ColorBlendMode.MIX,
      // near self-illuminated tint so planes read uniform near AND far; IR boost → flat UNLIT white (hot)
      colorBlendAmount: p._irBoost ? 1.0 : MODEL_COLOR_BLEND_AMOUNT,
      customShader: p._irBoost ? p._IR_UNLIT_SHADER : undefined,
      // Pick id (H1): without it, clicking the very plane being tracked read as
      // EMPTY SPACE (scene.pick → primitive with no id) → an unintended
      // deselect. With the icao, the click handler recognizes it as ours.
      id: p._trackedIcao,
    }).then((m) => {
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
        if (displayPos) {
          _modelMatrix(displayPos, p._trackedDisplayCourse(), m.modelMatrix, trackedSpec.headingOffsetDeg);
        }
      }
      p._trackedModel = m;
      p._trackedModelLoading = false;
      // A good load retires this selection's failure budget — a contact that
      // recovers after a transient blip is not one attempt from giving up.
      p._trackedModelFailIcao = null;
      p._trackedModelFailCount = 0;
      p._trackedModelRetryAtMs = 0;
      p._modelCollection.add(m);
      p._planeModelLoaded = true;
    }).catch((err) => {
      if (gen !== p._trackedModelGen) return; // superseded load — not this selection's failure
      p._trackedModelLoading = false;
      _noteTrackedModelLoadFailure(trackedSpec.url, err);
    });
    return;
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
    const spec = _modelSpec(p._flightData.get(p._trackedIcao)?.klass);
    _modelMatrix(displayPos, p._trackedDisplayCourse(), p._trackedModel.modelMatrix, spec.headingOffsetDeg);
    if (!p._trackedModel.ready) return;
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

/**
 * Per-preRender fleet pass at ~12Hz: dead-reckons every untracked billboard,
 * horizon-culls billboards beyond the limb (no far-side depth with the globe
 * hidden), and refreshes screen-projected icon rotations whenever the camera
 * pose changed (plus a 1s drift catch-up while idle). Driven by
 * scene.preRender — NOT camera.changed, whose granularity is globally
 * degraded by other layers mutating camera.percentageChanged.
 * @returns {void}
 */
function _fleetTick() {
  if (!p._viewer || !p._billboardCollection || !p._billboardCollection.show) return;
  const scene = p._viewer.scene;
  const camera = p._viewer.camera;
  const nowMs = focusNowMs(Date.now());

  // (The tracked trail head is now the per-frame p._trailHeadEntity segment — no 1 Hz
  // primitive rebuild here. The body rebuilds only when a real fix arrives.)

  if ((nowMs - p._lastFleetTickMs) < FLEET_DR_INTERVAL_MS) return;
  const tickDtSec = p._lastFleetTickMs
    ? Math.min(p.COURSE_SLEW_DT_MAX_SEC, (nowMs - p._lastFleetTickMs) / 1000)
    : 0.08;
  p._lastFleetTickMs = nowMs;

  p._drainIrReloadQueue(); // bounded per-tick slice of any pending boost-flip reload
  if (p._cockpitContactMode) p._refreshCockpitNearContacts();
  const poseSig = cameraPoseSignature(camera);
  // Only nearby Cockpit silhouettes need projected course; far dots remain
  // rotation-free through the per-contact gate below.
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

  // 3D-model eligibility: by DISTANCE (mode's add/keep band) with ON-SCREEN PRIORITY under the cap —
  // mirror of flights.js. FOUR visible-first passes: (1) KEEP on-screen modeled; (2) ADD on-screen
  // new in add radius; (3) KEEP off-screen modeled; (4) ADD off-screen new with leftover slots. KEEP
  // is split by frustum so an off-screen retained model can't starve an on-screen plane (review).
  let modelEligible = null;
  if (useModels) {
    const cap = _modelCap();
    const camPos = camera.positionWC;
    const addM = p._modelAddDistM();
    const addDistSq = addM * addM;
    const keepM = p._modelKeepDistM();
    const keepDistSq = keepM * keepM;
    const cull = camera.frustum.computeCullingVolume(camPos, camera.directionWC, camera.upWC);
    const cand = [];
    for (const [icao, bb] of p._billboards) {
      if (icao === p._trackedIcao) continue;
      // A converted TR-3B renders as a billboard and can never take a model, so
      // it must not occupy a CAP SLOT either (mirror of flights.js) — excluded
      // at selection time, not just at the handoff below.
      if (isTr3b(icao)) continue;
      // Ground planes compete for model slots like everyone else (product rule
      // 2026-07-03, mirror of flights.js — no air/ground distinction; grounded
      // placement is handled by the one-shot ground snap in p._modelDisplayPosition).
      const d2 = Cesium.Cartesian3.distanceSquared(camPos, bb.position);
      if (d2 > keepDistSq) continue; // beyond keep radius → never eligible
      Cesium.Cartesian3.clone(bb.position, _scratchModelBS.center);
      cand.push([icao, d2, cull.computeVisibility(_scratchModelBS) !== Cesium.Intersect.OUTSIDE]);
    }
    cand.sort((a, b) => a[1] - b[1]);
    if (cand.length > cap && (nowMs - _lastModelCapWarnMs) > 5000) {
      console.warn(`[Data:Military] ${cand.length} planes in 3D range; capped at ${cap} (${p._models3dMode}). On-screen prioritized.`);
      _lastModelCapWarnMs = nowMs;
    }
    modelEligible = new Set();
    for (const [icao, , inF] of cand) { if (modelEligible.size >= cap) break; if (inF && p._models.has(icao)) modelEligible.add(icao); } // 1. KEEP on-screen
    for (const [icao, d2, inF] of cand) { if (modelEligible.size >= cap) break; if (inF && d2 <= addDistSq && !modelEligible.has(icao)) modelEligible.add(icao); } // 2. ADD on-screen
    for (const [icao, , inF] of cand) { if (modelEligible.size >= cap) break; if (!inF && p._models.has(icao)) modelEligible.add(icao); } // 3. KEEP off-screen (can't starve visible)
    for (const [icao, d2, inF] of cand) { if (modelEligible.size >= cap) break; if (!inF && d2 <= addDistSq && !modelEligible.has(icao)) modelEligible.add(icao); } // 4. ADD off-screen leftover
    const toRelease = [];
    for (const icao of p._models.keys()) {
      if (icao !== p._trackedIcao && !modelEligible.has(icao)) toRelease.push(icao);
    }
    for (const icao of toRelease) p._releaseModel(icao);
  }

  for (const [icao24, bb] of p._billboards) {
    if (icao24 === p._trackedIcao) continue; // tracked entity owns its own motion

    const dr = _deadReckon(icao24, _scratchFleetPos);
    // Gate the write — assigning Billboard.position dirties the whole
    // collection's vertex buffer, so skip sub-meter moves.
    if (dr && Cesium.Cartesian3.distanceSquared(dr, bb.position) > 1.0) {
      bb.position = dr;
    }

    // Round 6: occlusion-test a LIFTED point for contacts at/below the
    // ellipsoid (mirror of flights.js — sub-ellipsoid points near the limb
    // read "beyond the horizon" and would hide low contacts awaiting floors).
    const beyondHorizon = !occluder.isPointVisible(p._flightData.get(icao24)?.cullPosition || bb.position);
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

    const info = p._flightData.get(icao24);

    // One sprite-owned write site composes freshness × focus × limb haze and
    // base class/ground scale × limb taper. The locked NearFarScalar remains
    // untouched and multiplicative; there is no cull or zero-alpha path.
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
    const treatment = applyAircraftBillboardTreatment({
      billboard: bb,
      baseScale: p._cockpitContactMode && !isCockpitNear ? 1 : _militaryBillboardScale(icao24),
      baseAlpha: _missingPolls.get(icao24) ? 0.45 : 1,
      baseColor: MIL_ICON_COLOR,
      focusFactor: focus.factor,
      cameraDistanceM,
      cameraHeightM: camera.positionCartographic?.height,
    });
    p._billboardLimbScale.set(bb, treatment.factors.scale);
    // Two-tier glyph raster — mirror of flights.js: swap 64/192 px rasters on
    // the billboard's ACTUAL on-screen size (post-treatment bb.scale, so
    // focus/limb recession counts) with hysteresis (atlas has no mips).
    if (!p._cockpitContactMode || isCockpitNear) {
      const glyphDevPx = (bb.width || 20) * (bb.scale || 1)
        * distanceScale * (globalThis.devicePixelRatio || 1);
      const wantLarge = bb._gevIconLarge ? glyphDevPx > 56 : glyphDevPx > 76;
      if (wantLarge !== Boolean(bb._gevIconLarge)) {
        bb._gevIconLarge = wantLarge;
        bb.image = aircraftIcon(p._iconKind(icao24, p._flightData.get(icao24)?.klass), wantLarge ? TRACKED_ICON_PX : undefined);
      }
    }

    // Smoothed display course: the path direction _deadReckon just reported
    // for THIS aircraft (nothing else calls _deadReckon in between), rate-
    // limited so segment-boundary course steps glide instead of snapping.
    // The slew cap eases toward COURSE_MIN_DPS at low speed, and a hovering
    // aircraft (hold flag) keeps its previous nose direction outright.
    const rawCourse = p._drCourseDeg != null ? p._drCourseDeg : ((info && info.track) || 0);
    const prevCourse = p._displayCourse.get(icao24);
    const course = (p._drCourseHold && prevCourse != null)
      ? prevCourse
      : limitCourseStep(
        prevCourse, rawCourse,
        courseSlewCapDps(p._drSpeedMps != null ? p._drSpeedMps : ((info && info.speedMps) ?? NaN), p.COURSE_MAX_DPS),
        tickDtSec,
      );
    p._displayCourse.set(icao24, course);

    // 3D model takes over from the billboard for in-view planes (modelEligible). GAP-PROOF: the
    // billboard stays shown until the model is actually READY to render, so a plane is never both
    // iconless AND modelless (the "planes vanish when 3D turns on" bug). Position the model every
    // tick regardless so it's framed the instant it becomes ready.
    // Converted TR-3Bs stay 2D on purpose (mirror of flights.js): the Easter
    // egg IS the triangle and there is no GLB for it, so the model handoff is
    // suppressed. The billboard keeps rendering, so the contact still satisfies
    // the getNearby/getDetectableObjects visibility guards.
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
            // IR boost must survive the per-tick treatment write; boosted
            // models also skip the recession fade (mirror of flights.js —
            // billboards keep their normal fade, hot MODELS stay full-strength).
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
 * @param {string} icao24 - ICAO hex identifier of the aircraft.
 * @returns {{icao24: string, callsign: string|null, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number, velocityMps: number|null, track: number|null}|null}
 *   Descriptor with a cloned position, or null if the aircraft is unknown.
 */
function _describeFlight(icao24) {
  const info = p._flightData.get(icao24);
  const bb = p._billboards.get(icao24);
  const basePos = _deadReckon(icao24) || (bb ? bb.position : null);
  if (!basePos) return null;
  const displayed = displayedKinematics({
    derivedSpeedMps: p._drSpeedMps,
    derivedTrackDeg: p._drCourseDeg,
    reportedSpeedMps: info?.speedMps,
    reportedTrackDeg: info?.track,
  });
  const carto = Cesium.Cartographic.fromCartesian(basePos, Cesium.Ellipsoid.WGS84, _scratchCarto);
  if (!carto) return null;
  return {
    icao24,
    callsign: p._toCleanText(info?.callsign) || null,
    // Additive: the label chain's middle link, trimmed like `callsign`, so
    // getTrackedSubject and the voice narration can read it straight off the
    // descriptor instead of reaching back into `p._flightData`.
    registration: p._toCleanText(info?.registration) || null,
    position: Cesium.Cartesian3.clone(basePos),
    latitude: Cesium.Math.toDegrees(carto.latitude),
    longitude: Cesium.Math.toDegrees(carto.longitude),
    // Keep the cockpit readout on the reported aviation altitude. Render
    // terrain height is a separate visual datum and may be below zero.
    altitudeM: Number.isFinite(info?.altitudeM) ? info.altitudeM : carto.height,
    renderAltitudeM: Number.isFinite(info?.renderAltitudeM) ? info.renderAltitudeM : carto.height,
    onGround: info?.onGround === true,
    velocityMps: displayed.speedMps,
    track: displayed.trackDeg,
    stale: Boolean(_missingPolls.get(icao24) || _backoff),
  };
}

/** @type {Cesium.Cartographic} Scratch for _trailFloorPosition (per-frame safe). */
const _scratchTrailCarto = new Cesium.Cartographic();

/**
 * Field-test round 2 (2026-07-06): floors a trail-bound position at the warm
 * coarse ground cell — a pure LIFT (above-floor positions pass through
 * untouched, unknown floors change nothing). Grounded military billboards
 * deliberately render at the pre-datum default height (T7 groundSnap
 * invariant), so every position entering the TRAIL subsystem (seed, append,
 * per-frame head) goes through this instead — the visible taxi history sits
 * on the surface without touching the billboard/model machinery.
 * @param {Cesium.Cartesian3} position - Owned position (mutated/replaced freely).
 * @returns {Cesium.Cartesian3} The same or a lifted position.
 */
function _trailFloorPosition(position) {
  const carto = Cesium.Cartographic.fromCartesian(position, Cesium.Ellipsoid.WGS84, _scratchTrailCarto);
  if (!carto) return position;
  const latDeg = Cesium.Math.toDegrees(carto.latitude);
  const lonDeg = Cesium.Math.toDegrees(carto.longitude);
  const floored = floorAltitudeM(carto.height, cachedGroundFloor(latDeg, lonDeg));
  if (floored == null || floored === carto.height) return position;
  return Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, floored);
}


/**
 * Renders the trail BODY — the accumulated fixes EXCLUDING the newest raw one. That
 * newest fix is at ~now, ~one poll interval AHEAD of the delayed icon (rendered at
 * now − p.RENDER_DELAY_SEC), so drawing it would push the trail in FRONT of the plane.
 * The cheap per-frame p._trailHeadEntity segment bridges the last body point to the
 * delayed dead-reckoned head, so this primitive only rebuilds on a real fix (poll
 * cadence), never at motion cadence.
 */
function _refreshTrailDisplay() {
  if (!p._trail) return;
  p._trail.setPositions(p._trailPositions.length > 1 ? p._trailPositions.slice(0, -1) : p._trailPositions);
}

/**
 * Start the trail for a newly tracked aircraft: seed it with the short
 * dead-reckoning history (chronological), render immediately, then
 * fire-and-forget an adsb.lol trace backfill (~24 h of real history).
 * @param {string} icao24 - ICAO hex identifier being tracked.
 */
function _startTrail(icao24) {
  p._trailBackfillToken += 1;
  p._trailPositions = [];
  const history = p._positionHistory.get(icao24) || [];
  // Seed only fixes at/behind the DELAYED display time (now − p.RENDER_DELAY_SEC). The
  // newest ~p.RENDER_DELAY_SEC of fixes are AHEAD of the displayed icon; including them
  // would draw the trail in front of the plane. They join via p._appendTrailFix as they age.
  const seedRenderTime = Cesium.JulianDate.addSeconds(
    Cesium.JulianDate.now(), -p.RENDER_DELAY_SEC, p._scratchWarmupTime
  );
  for (const fix of history) {
    if (Cesium.JulianDate.lessThanOrEquals(fix.time, seedRenderTime)) {
      // Floor grounded-history seeds (round 2): a grounded contact's stored
      // fixes carry the pre-datum default height — the trail copy sits on
      // the surface instead (pure lift; airborne fixes pass through).
      p._trailPositions.push(_trailFloorPosition(Cesium.Cartesian3.clone(fix.position)));
    }
  }
  if (!p._trail && p._viewer) {
    p._trail = createTrail(p._viewer, { color: TRAIL_COLOR, width: 2.5 });
  }
  p._trail?.setVisible(!p._cockpitContactMode);
  // Live head segment: last DISPLAYED body point → current dead-reckoned icon, updated
  // every frame via a CallbackProperty (Cesium updates entity-polyline positions cheaply,
  // unlike the trail primitive which fully rebuilds on setPositions). Keeps the head glued
  // to the 12 Hz icon instead of lagging ~1 s behind it.
  if (!p._trailHeadEntity && p._viewer) {
    p._trailHeadEntity = p._viewer.entities.add({
      // 'gev-trail' namespace (round 6): claimed by trailRenderer's pick
      // owner so a click on the head segment never reads as empty space.
      id: `gev-trail:mil-head-${++_trailHeadSeq}`,
      show: !p._cockpitContactMode,
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          // Need ≥2 accumulated points: the body draws all-but-newest, so the head must
          // start at the last DISPLAYED body point (index n−2). With a single fix that
          // point would be the sole raw fix — ~now, AHEAD of the delayed icon — so the
          // segment would draw IN FRONT of the plane. Likewise during warm-up the icon
          // predates all real history, so there is no valid body point behind it.
          if (!p._trackedIcao || p._trailPositions.length < 2 || p._isTrackWarmingUp()) return [];
          const head = p._trackedTrailCached() || _trackedDisplayPosition(p._trackedIcao);
          if (!head) return [];
          // body[n−2] (last displayed body point) → delayed head: runs FORWARD, never a
          // backward/reversing segment.
          const start = p._trailPositions[p._trailPositions.length - 2];
          // Floor the head too (round 2): a grounded tracked contact's DR
          // display height is the pre-datum default — without this the last
          // segment dives underground while taxiing.
          const end = _trailFloorPosition(Cesium.Cartesian3.clone(head));
          // On a contact that has not moved this segment runs from inside the
          // model out to its own anchor — a line through the fuselage. The END
          // never gives, so a moving trail still terminates on the tail; the
          // START is what slides, from nothing on a parked contact out to the
          // whole segment once it has cleared its own envelope. Measured against
          // the FLOORED endpoint, which is the one actually drawn.
          // See trailHeadStart.
          const from = trailHeadStart(
            start, end, p._trackedModelCenterWorld(), p._trackedModelEnvelopeM(), _scratchTrailHead,
          );
          if (!from) return [];
          return [from, end];
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
 * Fire-and-forget adsb.lol readsb trace backfill (PRD F2). Trace points are
 * stride-thinned to the remaining vertex budget, then spliced strictly older
 * than the oldest seeded fix AHEAD of the locally accumulated fine segment,
 * capped at p.TRAIL_MAX_POINTS (newest kept). Any failure (404/timeout/
 * malformed) silently keeps the local-only trail.
 * @param {string} icao24 - ICAO hex identifier being tracked.
 * @param {number} token - Backfill token captured at request time.
 * @param {number} oldestFixEpochSec - Epoch seconds of the oldest seeded fix.
 * @returns {Promise<void>}
 */
async function _backfillTrail(icao24, token, oldestFixEpochSec) {
  let baseEpochSec = null;
  let trace = null;
  try {
    const response = await fetch(api.adsblolTrace(icao24), {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return;
    const data = await response.json();
    baseEpochSec = Number(data?.timestamp);
    trace = Array.isArray(data?.trace) ? data.trace : null;
  } catch {
    return; // silent fallback to the accumulated trail
  }
  if (!trace || !Number.isFinite(baseEpochSec)) return;
  if (token !== p._trailBackfillToken || icao24 !== p._trackedIcao) return;

  // Height-datum fix (Task 7, mirror of flights.js Task 6 _backfillTrail): a
  // readsb trace point's altitude is barometric feet (same datum as the live
  // alt_baro, NOT geometric), so a trail waypoint's render height is the same
  // documented visual FALLBACK the live path uses — baroM + geoidHeight(lat,lon)
  // — geometrically approximate, not exact.
  await ensureGeoidReady();

  // readsb trace points: [secondsAfterTimestamp, lat, lon, alt_ft|'ground'|null, gs_kt, track, flags, ...]
  const parsed = [];
  for (const point of trace) {
    if (!Array.isArray(point)) continue;
    const t = baseEpochSec + Number(point[0]);
    const lat = Number(point[1]);
    const lon = Number(point[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!Number.isFinite(t) || t >= oldestFixEpochSec) continue;
    parsed.push({ lat, lon, altFt: point[3] });
  }
  if (!parsed.length) return;

  // Field-test fix (WAKE01 trail-underground, 2026-07-06): resolve the coarse
  // ellipsoidal ground along the trace and clamp every waypoint at it. A
  // 'ground'/null point sits ON the local surface — the old fixed 50 m
  // sentinel rendered ~1.5 km underground at Kirtland AFB (field ~1590 m
  // ellipsoidal) and dragged the whole pattern-work loop with it.
  // Round-2 fix: the
  // resolve is BOUNDED (≤1.2 s), not a blocking await — a cold Re:Earth
  // lookup across a long path could stall the paint for seconds-to-timeout.
  // Paint with whatever cells are warm; the resolve keeps filling the cache
  // in the background for the next paint/select.
  await resolveGroundFloorCellsBounded(parsed);
  // Re-check the backfill token after the await (same guard as post-fetch):
  // tracking may have moved on while the terrain race was in flight.
  if (token !== p._trailBackfillToken || icao24 !== p._trackedIcao) return;

  let older = [];
  let lastAltM = null; // carry-forward for ground points whose cell isn't warm yet
  for (const { lat, lon, altFt } of parsed) {
    const baroM = (altFt === 'ground' || altFt == null || !Number.isFinite(Number(altFt)))
      ? null
      : Number(altFt) * 0.3048 + geoidHeight(lat, lon);
    let altM = floorAltitudeM(baroM, cachedGroundFloor(lat, lon));
    // Ground/no-alt point with an unresolved floor: hold the previous
    // waypoint's altitude (continuity — never a dive to a made-up depth).
    // Leading points with nothing to carry keep the old low breadcrumb
    // sentinel (an arbitrary placeholder, never a reported altitude).
    if (altM == null) altM = lastAltM != null ? lastAltM : 50;
    lastAltM = altM;
    older.push(Cesium.Cartesian3.fromDegrees(lon, lat, altM));
  }

  // Stride-thin the backfill so it plus the live fine segment fit the cap.
  const budget = Math.max(1, p.TRAIL_MAX_POINTS - p._trailPositions.length);
  if (older.length > budget) {
    const stride = Math.ceil(older.length / budget);
    const thinned = [];
    for (let i = 0; i < older.length; i += stride) thinned.push(older[i]);
    older = thinned;
  }

  p._trailPositions = older.concat(p._trailPositions);
  if (p._trailPositions.length > p.TRAIL_MAX_POINTS) {
    p._trailPositions = p._trailPositions.slice(p._trailPositions.length - p.TRAIL_MAX_POINTS);
  }
  _refreshTrailDisplay();
}



/**
 * Stop tracking the current aircraft and clean up all tracking state.
 * Restores the original billboard, removes the tracked Entity, invalidates
 * the per-frame DR cache, and RELEASES the camera IN PLACE — no flyTo
 * (mirror of flights.js). Deselect used to fly an ~80 km pulled-back
 * overview; the owner field-ruled that wrong (2026-07-02: "it randomly zooms
 * way up and loses my context"). The camera stays at its current
 * position/orientation, immediately free to orbit/zoom. Applies to every
 * deselect path: click-empty-space, Escape, aged-out plane, layer disable,
 * and voice stopTracking.
 *
 * @param {boolean} [skipViewerUntrack=false] - ANOTHER layer just grabbed the
 *   follow-camera: tear down our own state but leave viewer.trackedEntity
 *   alone (the new owner controls it).
 * @param {object} [options] - Clear origin.
 * @param {boolean} [options.evicted=false] - The contact aged out of the feed
 *   rather than being deselected. Consumers that keep a readout on screen
 *   (the Cockpit Contact panel) hold last-known values for an eviction and
 *   only tear down on a deliberate clear.
 */
function _clearTracking(skipViewerUntrack = false, {
  evicted = false,
  origin = 'programmatic',
} = {}) {
  _trackedCameraFrameStop?.();
  _trackedCameraFrameStop = null;
  if (!p._trackedIcao) {
    clearFocusTarget('militaryFlights');
    return;
  }
  const clearedIcao = p._trackedIcao;
  clearFocusTarget('militaryFlights', clearedIcao);

  // Restore the original billboard appearance. The rotation is re-seeded from
  // the tracked entity's last rendered rotation and a rotation pass is forced
  // (p._lastCamPoseSig below): the fleet billboard otherwise reappears with the
  // STALE screen rotation it had when tracking began — up to a full
  // ROTATION_REFRESH_MS of a wrong (possibly reversed) nose on release.
  if (p._billboards.has(p._trackedIcao)) {
    const bb = p._billboards.get(p._trackedIcao);
    const meta = p._flightData.get(p._trackedIcao);
    bb.show = true;
    bb.width = 20;
    bb.height = 20;
    // Ground-aware restore (a plane untracked while taxiing comes back at
    // ground scale; tint is full amber on the ground and in the air).
    bb.scale = BILLBOARD_SCALE * (CLASS_SCALE_2D[meta?.klass] || 1) * (meta?.onGround ? GROUND_SCALE : 1);
    bb.color = MIL_ICON_COLOR;
    bb.rotation = p._lastTrackedRotation;
  }
  p._lastCamPoseSig = ''; // force a fleet rotation pass on the next tick

  // Stop tracking and remove the entity. skipViewerUntrack: another layer just grabbed the
  // follow-camera, so tear down our state but DON'T clear viewer.trackedEntity (they own it now).
  // Releasing trackedEntity does NOT move the camera: Cesium resets the lookAt transform in
  // place, so the view stays where the follow left it and the user can immediately orbit/zoom.
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
  clearTrackedSubjectContext('military');
  p._emitAwarenessEvent('gev:awareness-subject-cleared', {
    layerId: 'military',
    id: clearedIcao,
    origin,
    reason: evicted ? 'evicted' : 'deliberate',
  });
  // Invalidate the per-frame DR cache so a same-frame re-track cannot read
  // the previous aircraft's cached position.
  p._resetTrackedDisplay();
  p._clearTrail();
}


function _isUsableMilitaryAircraft(aircraft) {
  if (!aircraft || Array.isArray(aircraft) || typeof aircraft !== 'object') return false;
  if (typeof aircraft.hex !== 'string' || !p._normalizeTrackedIcao(aircraft.hex)) return false;
  return Number.isFinite(_toFiniteNumber(aircraft.lon))
    && Number.isFinite(_toFiniteNumber(aircraft.lat));
}



/**
 * Begin tracking a specific aircraft. Clears any previous tracking, hides the
 * billboard, creates a new Entity with dead-reckoning CallbackProperties for
 * smooth continuous motion, and sets the viewer's trackedEntity so the camera
 * follows.
 * @param {string} icao24 - ICAO hex identifier of the aircraft to track
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

  // Hide the billboard -- the tracked entity replaces it visually
  bb.show = false;

  // Helper: smoothed, per-frame-cached tracked position (see _trackedDisplayPosition —
  // one computation shared by the position/rotation/trail-head callbacks, with
  // discontinuity reconciliation). Falls back to the last billboard position when the
  // aircraft has no fix.
  const getTrackedPosition = () => _trackedDisplayPosition(icao24) || bb.position;

  // Dead-reckoning position property evaluated every render frame.
  // isConstant = false so CesiumJS re-evaluates each frame.
  const positionProperty = new Cesium.CallbackProperty(() => {
    return getTrackedPosition();
  }, false);

  // World-space orientation for the 3D model: nose along the course heading (ENU, pitch/roll 0).
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
  // The tracked entity is a PURE BILLBOARD — no label or model graphic. The tracked plane's 3D
  // model is the standalone primitive driven by _updateTrackedModel(); keeping it off the entity is
  // what makes the follow-camera's bounding sphere always ready (see p._trackedModel).
  p._trackedEntity = p._viewer.entities.add({
    position: positionProperty,
    // Keep Cesium's EntityView in the same ENU frame as the close-range
    // camera guard; AUTO may otherwise alternate with a velocity frame.
    trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
    billboard: {
      image: aircraftIcon(p._iconKind(p._trackedIcao, p._flightData.get(p._trackedIcao)?.klass), TRACKED_ICON_PX),
      width: 28,
      height: 28,
      scale: BILLBOARD_SCALE * (CLASS_SCALE_2D[p._flightData.get(p._trackedIcao)?.klass] || 1),
      // Solid amber when the billboard is the visual (zoomed out, 3D off, or model still loading);
      // transparent once the STANDALONE tracked model is actually up (ready + shown).
      color: new Cesium.CallbackProperty(() => (
        p._modelOwnsVisual(p._trackedIcao) ? AMBER_TRANSPARENT : TRACKED_ICON_COLOR
      ), false),
      sizeInMeters: false,
      scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5),
      alignedAxis: Cesium.Cartesian3.ZERO,
      // The tracked target must never vanish into tile geometry — tracking a
      // taxiing plane at street level would otherwise bury the amber icon inside
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
  p._trackedEntity.gevTrackedId = `military:${icao24}`;
  p._trackedEntity.gevLabelModel = trackedLabelModelFromText(
    _buildTrackedLabel(info, icao24),
    '#ffd166',
  );

  // A billboard has a ~zero bounding sphere, so Cesium's default follow distance is
  // far too tight (the user had to scroll out to read the plane). Give the entity a
  // calibrated viewFrom — behind + above, distance scaled to altitude — for a readable
  // initial frame with surrounding context. (ENU: east=+X, north=+Y, up=+Z.)
  const altM = info?.altitudeFt ? info.altitudeFt * 0.3048 : 1500;
  const followRange = Math.min(Math.max(altM * 1.1 + 2500, 3000), 30000);
  p._trackedEntity.viewFrom = new Cesium.Cartesian3(0, -followRange * 0.8, followRange * 0.55);

  // Cancel any in-progress camera flight first — otherwise Cesium won't apply the tracked
  // entity's viewFrom on the first frame, so voice-initiated tracking (which often fires
  // mid-fly_to_location) would follow the plane WITHOUT centering it like a click does.
  // Cross-module HUD consumers (tracked-target readout) read the camera's settled position, not a
  // postRender recompute, so the label doesn't jitter against the now-stable plane (mirror of flights).
  p._trackedEntity.gevDisplayPosition = p._trackedDisplayCached;
  // Separate accessor on purpose (mirror of flights.js): `gevDisplayPosition` keeps the
  // follow-camera anti-jitter contract; presentation that must weld to the aircraft you
  // can see reads `gevVisualPosition`.
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

  // Track-history trail (PRD F2): seed from local history + async backfill.
  // Ground traffic draws NO trail — if the plane takes off while tracked, the
  // ground→air transition in update() starts one.
  // Round 2 (owner): grounded contacts get trails too — a landed-but-taxiing
  // aircraft's history is retrievable on select. Trail positions are floored
  // at the surface (_trailFloorPosition), so ground legs drape, never dive.
  _startTrail(icao24);

  const callsign = p._toCleanText(info.callsign) || p._toCleanText(info.registration) || icao24;
  _publishTrackedSelection(icao24, origin);
  console.log(`[Data:Military] Tracking ${callsign} (${icao24})`);
}

/**
 * Map one military aircraft's internal poll record to a plain JSON-safe
 * analyst record (analyst query engine seam) — same shape as the flights
 * layer's mapAnalystRecord, with `military` always true. Pure — no Cesium
 * types, no fetches. Missing/unknown fields are null, never NaN/undefined.
 * adsb.lol carries no origin-country field and this layer has no route
 * enrichment, so originCountry/routeOrigin/routeDestination are always null.
 * @param {string} icao24 - ICAO hex identifier of the aircraft.
 * @param {Object|null|undefined} info - `p._flightData` record for this aircraft.
 * @returns {{id: string, icao24: string, callsign: string|null, lat: number|null,
 *   lon: number|null, altitudeM: number|null, speedMps: number|null,
 *   heading: number|null, verticalRateMps: number|null, onGround: boolean,
 *   military: boolean, aircraftClass: string|null, originCountry: null,
 *   operator: string|null, routeOrigin: null, routeDestination: null}}
 */
export function mapAnalystRecord(icao24, info) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const callsign = text(info?.callsign);
  return {
    id: callsign || text(info?.registration) || icao24,
    icao24,
    callsign,
    lat: num(info?.rawLat),
    lon: num(info?.rawLon),
    // altitudeFt is the sticky barometric/MSL aviation field — converted to
    // meters here for shape parity with the flights layer.
    altitudeM: Number.isFinite(info?.altitudeFt) ? info.altitudeFt * 0.3048 : null,
    speedMps: num(info?.speedMps),
    heading: num(info?.track),
    verticalRateMps: num(info?.verticalRateMps),
    onGround: info?.onGround === true,
    military: true,
    // A converted contact reports the class it RENDERS as (mirror of
    // flights.js), so an analyst filter/superlative agrees with the triangle.
    aircraftClass: tr3bAircraftClass(icao24, text(info?.klass)),
    originCountry: null,
    operator: text(info?.operator),
    routeOrigin: null,
    routeDestination: null,
  };
}

/**
 * Layer descriptor object for the military flights data layer.
 * Conforms to the layer manager contract: init, enable, disable, update, destroy,
 * plus optional getNearby, getDetectableObjects, and getStats accessors.
 * @type {Object}
 */
const militaryFlightsLayer = {
  id: 'military',
  name: 'Military Flights',
  icon: '🎖️',
  source: 'adsb.lol',
  /** @type {number} Polling interval in ms between API fetches */
  updateInterval: 15000,

  /**
   * Initialize the layer: create the billboard collection, reset all state,
   * and install the click-to-track handler.
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance
   */
  init(viewer) {
    clearFocusTarget('militaryFlights');
    p._viewer = viewer;
    p._billboardCollection = new Cesium.BillboardCollection();
    viewer.scene.primitives.add(p._billboardCollection);
    registerSpriteCollection('military', p._billboardCollection);
    p._modelCollection = new Cesium.PrimitiveCollection();
    viewer.scene.primitives.add(p._modelCollection);
    // Warm the glTF cache so the tracked plane's model instantiates instantly when first needed
    // (keeps the retained instance referenced; never rendered). Captured against this epoch so a
    // destroy/re-init mid-load doesn't flip the flag for a torn-down lifecycle.
    if (!_preloadModel) {
      const epoch = p._modelEpoch;
      Cesium.Model.fromGltfAsync({ url: JET_MODEL_URL, asynchronous: false })
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

    _installClickHandler(viewer);

    restoreSpriteOrder(viewer);

    console.log('[Data:Military] Initialized with billboard icons');
  },

  /**
   * Show the layer and re-install the click handler.
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance
   */
  enable(viewer) {
    if (p._billboardCollection) p._billboardCollection.show = true;
    holdContinuousRender('military'); // per-frame animator (perf wave 2)
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
    registerPickOwner('military', (pickedId) => p._billboards.has(pickedId));
    // The flights layer suppresses its military duplicates while we render them
    setMilitaryLayerActive(true);
    // Force a fresh rotation pass on the first tick after re-enable
    p._lastCamPoseSig = '';
    if (!_preRenderRemove && viewer?.scene) {
      _preRenderRemove = viewer.scene.preRender.addEventListener(_fleetTick);
    }
    if (!_trackedModelPreUpdateRemove && viewer?.scene) {
      _trackedModelPreUpdateRemove = viewer.scene.preUpdate.addEventListener(_updateTrackedModel);
    }
    if (!_moveEndRemove && viewer?.camera) {
      // Arrival polish (mirror of flights.js — see the comment there): a settled
      // camera move forces a full rotation pass on the very next frame, because
      // the pose-signature gate can eat the settle (final easing frames land
      // inside one quantization bucket) and leave stale noses for up to
      // ROTATION_REFRESH_MS. One extra pass per gesture — nothing per-frame.
      _moveEndRemove = viewer.camera.moveEnd.addEventListener(() => {
        p._lastCamPoseSig = '';
        p._lastFleetTickMs = 0;
      });
    }
    restoreSpriteOrder(viewer);
  },

  /**
   * Hide the layer, clear any active tracking, and remove input handlers
   * so clicks do not get intercepted while the layer is off.
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance
   */
  disable(_viewer) {
    p._abortActiveUpdates();
    p._cancelPendingTrackingRestore();
    if (p._billboardCollection) p._billboardCollection.show = false;
    releaseContinuousRender('military');
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
    unregisterPickOwner('military');
    // Flights layer takes over rendering known-military aircraft (amber)
    setMilitaryLayerActive(false);
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

  /** @deprecated Compatibility alias for {@link enable}. */
  show(viewer) {
    this.enable(viewer);
  },

  /** @deprecated Compatibility alias for {@link disable}. */
  hide(viewer) {
    this.disable(viewer);
  },

  /**
   * Fetch the latest military aircraft positions from adsb.lol and reconcile
   * with the billboard collection. Handles error backoff, feed-time-stamped
   * position history updates, and grace-period removal of absent aircraft.
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance
   * @returns {Promise<void>}
   */
  async update(viewer, { signal = null } = {}) {
    const nowMs = Date.now();
    const trackingRefreshEpoch = ++_trackingRefreshEpoch;
    _lastTrackingRefreshOutcome = {
      epoch: trackingRefreshEpoch,
      status: 'source-unavailable',
      ids: new Set(),
      source: 'adsb.lol',
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
      const response = await fetch(API_URL, { signal: updateSignal });
      _lastStatus = response.status;

      if (!response.ok) {
        _backoff = true;
        // Parity with flights.js: a 429 gets the LONGER cooldown + a friendly
        // rate-limit label instead of the generic transient backoff, so we don't
        // hammer the upstream and the UI reads honestly.
        if (response.status === 429) {
          _retryAt = nowMs + BACKOFF_INTERVAL;
          _lastError = 'adsb.lol rate limited';
          return;
        }
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        let detail = '';
        try {
          const body = await response.json();
          updateSignal.throwIfAborted();
          detail = p._toCleanText(body?.error || body?.message);
        } catch {
          detail = '';
        }
        _lastError = detail || `adsb.lol HTTP ${response.status}`;
        return;
      }

      // adsb.lol returns { ac: [...aircraft], msg: "...", ... }
      const data = await response.json();
      updateSignal.throwIfAborted();
      if (!data || !Array.isArray(data.ac)) {
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        _lastError = 'Malformed adsb.lol response';
        return;
      }

      const usableAircraft = data.ac.filter(_isUsableMilitaryAircraft);
      if (data.ac.length > 0 && usableAircraft.length === 0) {
        _backoff = true;
        _retryAt = nowMs + ERROR_BACKOFF_INTERVAL;
        _lastError = 'Malformed adsb.lol aircraft rows';
        return;
      }

      _backoff = false;
      _retryAt = 0;
      _lastError = null;
      const currentIcaos = new Set();
      const receiptNowMs = Date.now();
      // Field-test fix (RS46): coarse floor cells to warm for the below-ground
      // clamp — collected during the loop (low airborne contacts only),
      // batch-resolved once after it. Never a fetch inside the loop.
      const _floorWarmPoints = [];

      // -- Parse each aircraft record from the adsb.lol response --
      // Fields used: hex (ICAO), lon, lat, alt_baro (ft, barometric/MSL),
      // alt_geom (ft, geometric/WGS84 ellipsoidal — probed live 2026-07-05:
      // present on ~45% of records; readsb omits it when the aircraft hasn't
      // reported a geometric altitude this cycle), track (deg true), gs
      // (ground speed in knots), seen_pos (age of last position, seconds),
      // flight (callsign), t (type), r (registration), ownOp (operator).
      for (const aircraft of usableAircraft) {
        const icao24 = p._toCleanText(aircraft?.hex).toLowerCase();
        const lon = _toFiniteNumber(aircraft?.lon);
        const lat = _toFiniteNumber(aircraft?.lat);

        currentIcaos.add(icao24);
        _missingPolls.delete(icao24);

        const prevMeta = p._flightData.get(icao24);
        // adsb.lol/readsb reports GROUND traffic as alt_baro === "ground" (no
        // separate boolean). Grounded planes fall back to their last known
        // altitude (field elevation is unknowable here), else 0 m — never the
        // 3 km airborne default (a parked plane must not float).
        const rawAltBaro = aircraft?.alt_baro;
        const onGround = typeof rawAltBaro === 'string' && rawAltBaro.trim().toLowerCase() === 'ground';
        const altitudeFt = _toFiniteNumber(rawAltBaro);
        const altitudeM = Number.isFinite(altitudeFt)
          ? altitudeFt * 0.3048
          : (onGround
            ? (Number.isFinite(prevMeta?.altitudeFt) ? prevMeta.altitudeFt * 0.3048 : 0)
            : 3048);
        const track = _toFiniteNumber(aircraft?.track) || 0;
        // Convert ground speed from knots to meters/sec for dead reckoning
        const speedKt = _toFiniteNumber(aircraft?.gs);
        const speedMps = Number.isFinite(speedKt) ? speedKt * 0.514444 : 0;
        // Analyst seam (additive): readsb baro_rate is ft/min; keep m/s.
        const baroRateFtMin = _toFiniteNumber(aircraft?.baro_rate);
        const verticalRateMps = Number.isFinite(baroRateFtMin) ? baroRateFtMin * 0.00508 : null;

        const callsign = p._toCleanText(aircraft?.flight);
        const type = p._toCleanText(aircraft?.t);
        const registration = p._toCleanText(aircraft?.r);
        const operator = p._toCleanText(aircraft?.ownOp);
        const seenSec = _toFiniteNumber(aircraft?.seen);

        // Height-datum fix (Task 7, mirror of flights.js Task 6): `altitudeM`
        // (above) stays the AVIATION field — the sticky barometric/MSL altitude
        // read by labels (FL/altitude readout) and the landed-fast-cull
        // heuristic. It is NEVER overwritten or renamed. Where the aircraft
        // actually RENDERS on the ellipsoidal globe (billboard path only — a
        // ground-snapped 3D MODEL uses groundSnap.js's own tileset sample and
        // ignores this value entirely) is a SEPARATE value, renderAltitudeM:
        // alt_geom when readsb reports it (already WGS84 ellipsoidal), else
        // alt_baro+geoid as a visual fallback, else ground surface when parked.
        const altGeomFt = _toFiniteNumber(aircraft?.alt_geom);
        const geoAltitudeM = Number.isFinite(altGeomFt) ? altGeomFt * 0.3048 : null;
        const baroAltitudeM = Number.isFinite(altitudeFt) ? altitudeFt * 0.3048 : null;

        // geoid undulation N: cached per-aircraft (negligible drift — see
        // task brief) once the geoid grid has loaded; unavailable pre-load
        // just means the baro fallback branch below adds N=0 for a beat.
        let geoidN = _geoidNCache.get(icao24);
        if (geoidN === undefined && _geoidReady) {
          geoidN = geoidHeight(lat, lon);
          _geoidNCache.set(icao24, geoidN);
        }

        // GROUND-SNAP INTERPLAY (brief item 3 — "don't double-correct"): a
        // grounded plane's MODEL already rides groundSnap.js's one-shot tileset
        // sample (p._modelDisplayPosition), which is the visual on the ground, and
        // its billboard is depth-test-free (p._groundDepthDistance) so its exact
        // height is cosmetic. Deliberately pass surfaceM=null so
        // pickRenderAltitudeM's on-ground surface branch never fires here:
        //  1. It would be the SECOND correction of the same grounded plane
        //     (model tileset-snap is the first) — the exact double-correct the
        //     brief forbids.
        //  2. Military ground rows carry NO baro ("alt_baro":"ground"), so the
        //     grounded billboard sits at 0 m until a surface value warms; letting
        //     surfaceM then jump it 0 -> ~surface (often ~100 m) BETWEEN polls
        //     drags the model's ground-snap input past groundSnap's 50 m
        //     move-invalidation threshold and forces a re-sample every time the
        //     cache warms — breaking the ONE-SHOT-per-(camera,regime) invariant
        //     the track regression locks (qa: sampleHeight count must stay flat).
        // Grounded planes therefore keep the pre-existing `altitudeM` default
        // (last-known baro / 0). The datum fix (alt_geom -> baro+geoidN) is what
        // matters for AIRBORNE military planes — the actual "renders at MSL" bug.
        const pickedAltM = pickRenderAltitudeM({
          geoAltM: geoAltitudeM,
          baroAltM: baroAltitudeM,
          onGround,
          surfaceM: null,
          geoidN,
        });
        // pickRenderAltitudeM returns the sentinel `null` only when NEITHER
        // alt_geom nor alt_baro was ever reported for this aircraft (not even
        // stickily) — fall back to the SAME existing default policy `altitudeM`
        // already uses (which also carries the on-ground 0 m / last-known-baro
        // case), so the two never disagree on the "no data yet" case.
        let renderAltitudeM = pickedAltM != null ? pickedAltM : altitudeM;
        // Field-test fix (RS46 heli-in-hillside, 2026-07-06): a baro-only
        // AIRBORNE contact near steep terrain can compute a render height
        // BELOW the local surface (no alt_geom; baro+N carries QNH error
        // larger than the height above ground). Floor it at the coarse-grid
        // ellipsoidal ground (warm-cache read only — the batch warm below
        // fills cells for later polls). Grounded contacts are deliberately
        // NOT touched: their model rides groundSnap's tileset sample and
        // their billboard is depth-test-free (see the surfaceM:null block
        // above — same one-shot-invariant reasoning).
        if (!onGround && renderAltitudeM < GROUND_FLOOR_WARM_MAX_ALT_M) {
          renderAltitudeM = floorAltitudeM(renderAltitudeM, cachedGroundFloor(lat, lon));
          _floorWarmPoints.push({ lat, lon });
        } else if (onGround) {
          // Grounded contacts: warm the floor cell, and — round 4 — when NO
          // 3D model owns this contact's visual, lift the billboard itself
          // onto the floor (mesh-first): the R20053 heli sat "straight up in
          // the ground" because grounded rows render at the legacy ~0 m.
          // With a model present the billboard stays put (it hides behind
          // the tileset-snapped model, and moving it would drag groundSnap's
          // input past its move-invalidation threshold — the T7 one-shot
          // invariant the track regression locks).
          _floorWarmPoints.push({ lat, lon });
          const modelOwnsVisual = p._modelOwnsVisual(icao24);
          if (!modelOwnsVisual) {
            const floor = cachedGroundFloor(lat, lon);
            if (Number.isFinite(floor)) {
              renderAltitudeM = floorAltitudeM(renderAltitudeM, floor);
            }
          }
        }

        const position = Cesium.Cartesian3.fromDegrees(lon, lat, renderAltitudeM);
        // Landing/takeoff transition: the ground flip restyles IN PLACE.
        const groundFlipped = Boolean(prevMeta) && (prevMeta.onGround === true) !== onGround;
        // Either flip direction retires the model's ground snap: a departing plane
        // flies free of it, a landing plane earns a fresh sample where it rolls out.
        if (groundFlipped) p._groundSnap.forget(icao24);

        // Sticky merge — adsb.lol intermittently drops flight/t/r/ownOp; hold
        // last-known-good (bounded by the layer's eviction, which deletes the entry).
        const stickyType = stickyText(type, prevMeta?.type);
        const meta = {
          callsign: stickyText(callsign, prevMeta?.callsign),
          type: stickyType,
          // Type outranks category automatically inside classifyAircraft.
          klass: classifyAircraft({ typeCode: stickyType, category: aircraft?.category }),
          registration: stickyText(registration, prevMeta?.registration),
          operator: stickyText(operator, prevMeta?.operator),
          altitudeFt: stickyNumber(altitudeFt, prevMeta?.altitudeFt, null),
          // geoAltitudeM/renderAltitudeM are ADDITIVE fields alongside the
          // untouched aviation `altitudeFt` — never rename/replace it (labels,
          // the FL readout, and the landed-fast-cull heuristic all still read
          // altitudeFt/baro).
          geoAltitudeM,
          renderAltitudeM,
          speedMps: stickyNumber(speedMps, prevMeta?.speedMps, null),
          track: stickyNumber(track, prevMeta?.track, null),
          // Analyst seam (additive): sticky like the other kinematics.
          verticalRateMps: stickyNumber(verticalRateMps, prevMeta?.verticalRateMps, null),
          lastContactEpochMs: stickyNumber(
            Number.isFinite(seenSec) ? receiptNowMs - seenSec * 1000 : null,
            prevMeta?.lastContactEpochMs,
            null,
          ),
          turnRateDps: prevMeta?.turnRateDps || 0,
          onGround,
          // Round 7: sticky airborne history (see _likelyLanded).
          wasAirborne: prevMeta?.wasAirborne === true || !onGround,
          // Round 6: lifted occlusion-test point for at/below-ellipsoid
          // renders (mirror of flights.js).
          cullPosition: renderAltitudeM < 10 ? Cesium.Cartesian3.fromDegrees(lon, lat, 12) : null,
          // Raw poll-fix coords (pre-dead-reckon) — the stale-grounded
          // re-floor sweep keys floors off these (mirror of flights.js).
          rawLat: lat,
          rawLon: lon,
        };
        p._flightData.set(icao24, meta);

        const isTracked = icao24 === p._trackedIcao;

        // Append to position history stamped with the FEED's fix epoch.
        // adsb.lol's seen_pos is the AGE in seconds of the last position
        // report, so the fix epoch is receipt time minus that age. Only
        // append when the fix actually advances, so stale repeats don't
        // create zero-dt segments.
        const seenPos = _toFiniteNumber(aircraft?.seen_pos);
        const fixEpochMs = receiptNowMs - (Number.isFinite(seenPos) ? seenPos * 1000 : 0);
        const fixTime = Cesium.JulianDate.fromDate(new Date(fixEpochMs));
        if (!p._positionHistory.has(icao24)) {
          p._positionHistory.set(icao24, []);
        }
        const history = p._positionHistory.get(icao24);
        const newest = history[history.length - 1];
        if (!newest || Cesium.JulianDate.greaterThan(fixTime, newest.time)) {
          // Per-fix kinematics: the fix's own velocity/track ride along so the
          // extrapolation paths use the values that BELONG to the fix they
          // extend, not whatever the latest poll reported.
          history.push({
            time: fixTime,
            epochMs: fixEpochMs,
            position: position.clone(),
            velocity: meta.speedMps,
            track: meta.track,
          });
          if (history.length > POSITION_HISTORY_LIMIT) {
            history.shift();
          }
          // Turn rate from the fix-track history — computed once per new fix
          // (≤5 samples), consumed by the extrapolation paths at tick rate.
          meta.turnRateDps = turnRateFromFixHistory(history);
          // Trail accumulation is separate from the 5-fix DR history (PRD F2)
          // so the visible trail keeps growing while tracked. Round 2
          // (owner): ground traffic appends too — taxi history stays live
          // after touchdown; p._appendTrailFix floors grounded positions at
          // the surface so the ground leg drapes instead of diving.
          if (isTracked) p._appendTrailFix(position.clone());
        } else {
          const modelOwnsGroundVisual = p._modelOwnsVisual(icao24);
          if (!modelOwnsGroundVisual) {
            liftRepeatedGroundFix(newest, position, meta.onGround);
          }
          const kinematicsChanged = newest.velocity !== meta.speedMps
            || newest.track !== meta.track;
          if (kinematicsChanged) {
            const synthetic = synthesizeForwardKinematicsFix(newest, {
              epochMs: Date.now(),
              velocity: meta.speedMps,
              track: meta.track,
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
          // Position AND rotation are owned by the fleet pass (_fleetTick);
          // course changes land on the next rotation pass (forced below).
          // Ground flips (landing/takeoff) restyle this SAME billboard in
          // place — the transition is never a removal.
          if (prevMeta?.klass !== meta.klass || groundFlipped || p._cockpitContactMode) {
            p._applyFleetBillboardPresentation(icao24, bb);
          }
          // Per-class GLBs: a class change can mean a different asset OR scale —
          // resync the live model, any in-flight load, and the tracked
          // standalone (mirror of flights.js).
          if (prevMeta?.klass !== meta.klass) p._syncModelToClass(icao24);
          // Round 5: depth policy is uniform (always depth-test-free, see
          // p._groundDepthDistance) — nothing to flip on landing/takeoff.
        } else {
          const bb = p._billboardCollection.add({
            position,
            image: aircraftIcon(p._iconKind(icao24, meta.klass)),
            width: isTracked ? 24 : 20,
            height: isTracked ? 24 : 20,
            scale: BILLBOARD_SCALE * (CLASS_SCALE_2D[meta.klass] || 1) * (meta.onGround ? GROUND_SCALE : 1),
            // Screen-projected rotation lands on the next fleet tick.
            rotation: 0,
            alignedAxis: Cesium.Cartesian3.ZERO,
            color: isTracked ? TRACKED_ICON_COLOR : MIL_ICON_COLOR,
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

      // Field-test fix (RS46): one batch warm of the low-airborne floor cells
      // collected above — fire-and-forget, single-flight, results read
      // synchronously by NEXT poll's clamp (same contract as flights.js's
      // grounded-surface warm).
      warmGroundFloor(_floorWarmPoints);
      // Round 6: re-floor STALE grounded contacts (mirror of flights.js) —
      // a parked contact whose feed went quiet froze at its pre-warm height.
      // The model-ownership gate matches the live grounded-clamp path (a
      // tileset-snapped model owns its visual; moving its billboard would
      // disturb groundSnap's input — the T7 one-shot invariant).
      for (const [icao24, info] of p._flightData) {
        if (!info?.onGround || currentIcaos.has(icao24)) continue;
        if (p._modelOwnsVisual(icao24)) continue;
        if (!Number.isFinite(info.rawLat) || !Number.isFinite(info.rawLon)) continue;
        const floor = cachedGroundFloor(info.rawLat, info.rawLon);
        if (!Number.isFinite(floor)) continue;
        const lifted = floor + GROUND_FLOOR_LIFT_M;
        if (Number.isFinite(info.renderAltitudeM) && info.renderAltitudeM >= floor - 1) continue;
        info.renderAltitudeM = lifted;
        info.cullPosition = null;
        const liftedPos = Cesium.Cartesian3.fromDegrees(info.rawLon, info.rawLat, lifted);
        const hist = p._positionHistory.get(icao24);
        const newest = hist?.[hist.length - 1];
        if (newest) newest.position = Cesium.Cartesian3.clone(liftedPos, newest.position);
        const bbStale = p._billboards.get(icao24);
        if (bbStale) bbStale.position = liftedPos;
      }
      // Round 4: sample the RENDERED mesh for those cells (one-shot per cell,
      // budget-capped, viewer-proximate, google-3d regime only), excluding
      // this layer's own billboards/models from the probe.
      {
        const viewerCarto = p._viewer?.camera?.positionCartographic || null;
        sampleMeshFloorCells(p._viewer?.scene, _floorWarmPoints, {
          excludeObjects: [...p._billboards.values(), ...p._models.values(), p._trackedModel].filter(Boolean),
          viewerLat: viewerCarto ? Cesium.Math.toDegrees(viewerCarto.latitude) : undefined,
          viewerLon: viewerCarto ? Cesium.Math.toDegrees(viewerCarto.longitude) : undefined,
        });
      }

      // Remove aircraft only after MISSING_POLL_LIMIT consecutive absences.
      // adsb.lol routinely drops aircraft for a single poll; immediate removal
      // made icons blink and yanked the camera off actively tracked flights.
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
            // in _missingPolls, _buildTrackedLabel appends the STALE cue so
            // last-known altitude/speed aren't presented as live.
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
      }

      // Fresh courses arrived — force a rotation pass on the next fleet tick
      p._lastCamPoseSig = '';

      // Feed the shared registry so the flights layer can classify/suppress
      registerMilitaryIcaos(currentIcaos);

      _count = p._billboards.size;
      _lastUpdate = Date.now();
      _lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'accepted',
        ids: currentIcaos,
        source: 'adsb.lol',
      };
      console.log(`[Data:Military] Updated: ${_count} aircraft`);
      p._applyPendingTrackingRestore();

    } catch (e) {
      if (updateSignal.aborted || e?.name === 'AbortError') {
        throw new DOMException('Military update aborted', 'AbortError');
      }
      console.warn('[Data:Military] Fetch error:', e);
      _backoff = true;
      _retryAt = Date.now() + ERROR_BACKOFF_INTERVAL;
      _lastError = 'adsb.lol network error';
    } finally {
      p._activeUpdateControllers.delete(resourceController);
    }
  },

  /**
   * Tear down the layer: clear tracking, remove handlers, remove the billboard
   * collection from the scene, and release all state.
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance
   */
  destroy(viewer) {
    p._abortActiveUpdates();
    releaseContinuousRender('military'); // direct-destroy path (perf wave 2 fix)
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
    document.removeEventListener('keydown', p._onKeyDown);
    if (_cockpitModeListener) {
      window.removeEventListener('gev:cockpit-mode-changed', _cockpitModeListener);
      _cockpitModeListener = null;
    }
    unregisterPickOwner('military');
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
    _missingPolls.clear();
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
      source: 'adsb.lol',
    };
    p._resetTrackedSelectionState(); // next lifecycle re-evaluates against the ENTER ceiling
    p._viewer = null;
  },

  /**
   * Live layer params.
   * `models3d` toggles 3D glTF jet-model rendering for the FLEET (altitude-gated): when on,
   * surrounding military aircraft become 3D models once the camera is zoomed in past
   * p.MODEL_ALT_CEIL_M. The TRACKED contact is NOT gated by this — it takes its 3D model by
   * camera distance regardless (see `p._trackedModelRegimeActive` / trackedModelRegime.js).
   * `models3dMode` is 'proximity' (nearest MODEL_MAX in view) or 'all' (every in-view plane).
   * @param {{models3d?: boolean, models3dMode?: 'proximity'|'all', selectedMilitaryTrackingId?: string|null}} params
   */
  setParams(params = {}, { origin = 'programmatic' } = {}) {
    if (isExplicitLayerStateOrigin(origin)
        && !Object.hasOwn(params, 'selectedMilitaryTrackingId')) {
      p._cancelPendingTrackingRestore();
    }
    if (typeof params.models3d === 'boolean' && params.models3d !== p._models3dEnabled) {
      p._models3dEnabled = params.models3d;
      if (!p._models3dEnabled) {
        p._releaseModels();
        p._syncTracked2dRotation();
        // Restore fleet billboards (horizon-cull re-asserts next tick), but NEVER the tracked
        // plane's own fleet billboard — its tracked entity is the visual (avoids a double-image).
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
      // cold and thermal-reactive variants directly (mirror of flights.js).
      p._refreshTr3bForStyle();
    }
    if (Object.hasOwn(params, 'selectedMilitaryTrackingId')) {
      const requested = p._normalizeTrackedIcao(params.selectedMilitaryTrackingId);
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
      selectedMilitaryTrackingId: p._trackedIcao,
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
   * Find military aircraft near a given ECEF position, sorted by distance.
   * Used by proximity-based features (e.g. detection overlay, spatial queries).
   * @param {Cesium.Cartesian3} center - Reference position in ECEF coordinates
   * @param {number} range - Maximum distance in meters (Infinity if not specified)
   * @param {number} [maxCount=50] - Maximum number of results to return
   * @param {object} [options] Query membership options.
   * @param {boolean} [options.includeHidden=false] Include loaded horizon-hidden aircraft.
   * @returns {Array<Object>} Sorted array of nearby aircraft descriptors
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
      nearby.push({
        id: info?.callsign?.trim() || info?.registration?.trim() || icao24,
        icao24,
        position: pos,
        distance,
        // Filter surface (mirror of flights.js): the cockpit next/previous path
        // matches on this field, so it follows the conversion.
        aircraftClass: tr3bAircraftClass(icao24, String(info?.klass || info?.type || '').trim().toLowerCase() || null),
        track: info?.track ?? null,
        // Display type — converted too, so a Contacts row can't still name the
        // airframe the triangle replaced (the filter matcher reads this as a
        // fallback candidate as well).
        type: tr3bTypeLabel(icao24, info?.type || null),
        registration: info?.registration || null,
        operator: info?.operator || null,
        altitudeFt: info?.altitudeFt ?? null,
      });
    }

    nearby.sort((a, b) => a.distance - b.distance);
    return nearby.slice(0, limit);
  },

  /**
   * Return a subset of aircraft suitable for the detection overlay system.
   * Uses a deterministic stride-based sampling to keep the count manageable
   * while distributing selections evenly across the collection.
   * @param {Object} [options={}] - Options
   * @param {number} [options.maxCount] - Maximum objects to return (defaults to all)
   * @param {number} [options.seed] - Seed offset for stride sampling (for frame variation)
   * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string, skipLabel: boolean}>}
   */
  getDetectableObjects(options = {}) {
    if (!p._billboardCollection || !p._billboardCollection.show) return [];
    const maxCount = Number.isFinite(options.maxCount)
      ? Math.max(1, Math.floor(options.maxCount))
      : p._billboards.size;
    const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) : 0;
    // Deterministic stride: evenly space selections across the billboard map
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
      const callsign = info?.callsign?.trim();
      const registration = info?.registration?.trim();
      let object = _detectionObjects.get(icao24);
      if (!object) {
        object = {
          sourceId: icao24, type: 'AIR', tier: 'military', _weldPos: new Cesium.Cartesian3(),
        };
        _detectionObjects.set(icao24, object);
      }
      // WELD (mirror of flights.js): anchor to whatever owns the visual. Model-owned
      // contacts read the translation the fleet tick already wrote into their
      // modelMatrix; sprite-owned contacts keep `bb.position`, where sprite and bracket
      // are co-located anyway.
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
      const id = callsign || registration || icao24;
      if (object.id !== id) object.id = id;
      // Card surface: detectionDraw composes its secondary line from
      // `[src.klass, src.metric]`, so a converted contact's card must name the
      // TR-3B, not the airframe underneath it.
      const klass = tr3bTypeLabel(icao24, info?.type || 'MIL');
      if (object.klass !== klass) object.klass = klass;
      const altitudeFt = info?.altitudeFt ?? 0;
      if (object._altitudeFt !== altitudeFt) {
        object._altitudeFt = altitudeFt;
        // military metadata stores altitudeFt (feet); the helper takes metres
        object.metric = formatFlightLevel(altitudeFt * 0.3048);
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
   * @param {string} query - ICAO hex or full/partial callsign.
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
    // very identity the app had just shown (field session 2026-08-21,
    // 23:48: three failed track_entity retries before a fallback stuck).
    // Ranking is shared with the flights layer (contactMatch.js) so the two
    // cannot disagree, and it is strictly tiered so a registration can never
    // out-rank a real callsign on feed order alone.
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
   * Return id/label/position for up to maxCount currently rendered aircraft.
   * Cheap snapshot for voice-tool framing — billboard positions only, no
   * dead reckoning and no cloning.
   * @param {number} [maxCount=500] - Maximum number of entries to return.
   * @returns {Array<{id: string, label: string, position: Cesium.Cartesian3, latitude: number, longitude: number, altitudeM: number}>}
   */
  /**
   * Whether this layer still carries a contact, in O(1).
   *
   * Mirror of `flights.hasContact`: presence consumers must not infer absence
   * from the capped `getAllPositions` rows. Id matching follows trackById —
   * exact key first, then lowercase.
   * A disabled layer keeps its records but hides the collection, so it must
   * decline rather than answer from data the user can no longer see.
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
        id: icao24, // identity (trackById/Context resolve this)
        // Last surface still reading as the raw hex for a callsign-less
        // contact — same chain as getNearby/getDetectableObjects/getTrackedSubject.
        label: p._toCleanText(info?.callsign) || p._toCleanText(info?.registration) || icao24,
        position: pos,
        latitude: Cesium.Math.toDegrees(carto.latitude),
        longitude: Cesium.Math.toDegrees(carto.longitude),
        altitudeM: carto.height,
      });
      if (result.length >= limit) break;
    }
    return result;
  },

  /**
   * Snapshot the layer's in-memory records as plain JSON-safe objects for
   * the analyst query engine. On-demand only (called at most once per
   * spoken query) — zero per-frame cost, no listeners, no caching. Returns
   * [] while the layer is disabled or empty.
   * @param {number} [maxCount=2000] - Maximum records to return (truncation).
   * @returns {Array<Object>} See mapAnalystRecord for the record shape.
   */
  getAnalystRecords(maxCount = 2000) {
    if (!p._billboardCollection || !p._billboardCollection.show || p._flightData.size === 0) return [];
    const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
    const result = [];
    for (const [icao24, info] of p._flightData) {
      result.push(mapAnalystRecord(icao24, info));
      if (result.length >= limit) break;
    }
    return result;
  },

  /**
   * Start camera-tracking an aircraft by ICAO hex identifier.
   * @param {string} icao24 - ICAO hex identifier of the aircraft.
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
    const id = String(icao24 ?? '').trim().toLowerCase();
    if (!id) return { status: 'missing', reason: 'invalid-target' };
    const outcome = _lastTrackingRefreshOutcome;
    if (outcome.status !== 'accepted') {
      return {
        status: 'source-unavailable',
        reason: 'adsb.lol snapshot unavailable',
        refreshEpoch: outcome.epoch,
        source: outcome.source,
      };
    }
    if (!outcome.ids.has(id)) {
      return {
        status: 'missing',
        reason: 'target-absent-from-snapshot',
        refreshEpoch: outcome.epoch,
        source: outcome.source,
      };
    }
    if (signal?.aborted) return { status: 'cancelled', reason: String(signal.reason || 'aborted') };
    const followed = this.trackById(id, { origin });
    return followed
      ? { status: 'found', refreshEpoch: outcome.epoch, source: outcome.source }
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
      layerId: 'military',
      id: described.icao24,
      // Same label chain as getNearby/getDetectableObjects: a callsign-less
      // contact reads as its registration, never as the raw ICAO hex.
      label: described.callsign || described.registration || described.icao24,
      position: Cesium.Cartesian3.clone(described.position),
    };
  },

  /**
   * Return current layer health/status for the HUD status chip.
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
      source: 'adsb.lol',
      fallback: false,
    };
  },
};


/**
 * Install a left-click handler on the scene canvas for aircraft selection.
 * Clicking a military billboard starts tracking that aircraft; clicking empty
 * space or a non-military object deselects. Also attaches the Escape key
 * listener via {@link p._onKeyDown}. Idempotent -- no-ops if already installed.
 * @param {Cesium.Viewer} viewer - The Cesium viewer instance
 */
function _installClickHandler(viewer) {
  if (_clickHandler) return; // already installed

  // Cross-layer untrack (mirror of flights): if another layer grabs the follow-camera, drop our
  // tracking without touching viewer.trackedEntity (the new owner controls it).
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
    // first-person reference. Empty globe clicks are inert until the user
    // exits with C, Escape, or the dedicated button.
    if (document.body.classList.contains('cockpit-mode')) return;
    const picked = viewer.scene.pick(click.position);

    if (picked) {
      // Clicking the tracked entity itself -- ignore (don't deselect)
      if (picked.id === p._trackedEntity) return;

      // Clicking the plane we're ALREADY tracking (its standalone 3D model or
      // any pick carrying its icao) — same no-op as the 2D tracked-entity click
      // above. H1: the model used to have no pick id, so this fell through to
      // "empty space" and deselected the very plane being tracked.
      if (p._trackedIcao) {
        const rawPick = typeof picked.id === 'string' ? picked.id : picked.primitive?.id;
        if (picked.primitive === p._trackedModel || rawPick === p._trackedIcao) return;
      }

      // BillboardCollection picks: CesiumJS may expose the billboard as
      // picked.primitive (with .id = icao24) or directly as picked.id
      const billboard = picked.primitive;
      if (billboard && billboard.id && p._billboards.has(billboard.id)) {
        p._cancelPendingTrackingRestore();
        _trackFlight(billboard.id, { origin: 'user' });
        return;
      }
      // Fallback: some CesiumJS versions surface the id string at picked.id
      if (picked.id && typeof picked.id === 'string' && p._billboards.has(picked.id)) {
        p._cancelPendingTrackingRestore();
        _trackFlight(picked.id, { origin: 'user' });
        return;
      }
    }

    // A pick that belongs to a sibling layer (commercial flight, satellite,
    // vessel, station, CCTV camera…) is not "empty space" — leave tracking
    // alone and let that layer handle it. resolvePickId String()-coerces the
    // heterogeneous pick ids (numeric NORAD ids, AIS record objects) so the
    // registry predicates can recognize them (H2).
    if (picked) {
      const pickedId = resolvePickId(picked);
      if (pickedId && isOwnedByOtherLayer('military', pickedId)) return;
    }

    // Clicked empty space -- deselect only for a clean, short click. A slow
    // stationary press may select above, but cannot release existing tracking.
    if (!isTrackingClickGesture(gesture)) return;
    if (p._trackedIcao) {
      p._cancelPendingTrackingRestore();
      _clearTracking(false, { origin: 'user' });
    }
  }, { now: _clickPressClock.now });

  document.addEventListener('keydown', p._onKeyDown);
}


// Moved to the shared pipeline (flightsTracking.js); re-exported for the
// test surface. Signatures are verbatim from the pre-extraction copies.
export const _setCockpitDetectionSubjectForTest = (active, subjectId = null) => p._setCockpitDetectionSubjectForTest(active, subjectId);
export const _trackedModelRegimeActiveForTest = () => p._trackedModelRegimeActiveForTest();
export const _updateTrackedModelForTest = () => p._updateTrackedModelForTest();
export const _trackedBillboardColorForTest = () => p._trackedBillboardColorForTest();
export const _driveFleetModelHandoffForTest = ({ icao24, position, course = 0 }) => p._driveFleetModelHandoffForTest({ icao24, position, course });
export const _ensureFleetModelForTest = async (icao24) => p._ensureFleetModelForTest(icao24);

export default militaryFlightsLayer;
