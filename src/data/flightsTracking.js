// Shared flight tracking pipeline — the per-layer tracking, dead-reckoning,
// billboard/model presentation, cockpit-contact and trail machinery extracted
// verbatim from src/data/flights.js (Batch 5 item 2, sub-unit a). Both
// flights.js and militaryFlights.js instantiate it via
// createFlightTrackingPipeline(config); the config injects the genuinely
// per-layer pieces (model spec tables, billboard color/scale, tracking
// seams) while the closure below owns the shared state and behavior.

import * as Cesium from 'cesium';

import { CLASS_SCALE_2D } from './aircraftClass.js';
import { aircraftIcon, TRACKED_ICON_PX } from './aircraftIcons.js';
import { cockpitContactDotImage } from './cockpitContactDot.js';
import { nextCockpitNearContacts } from './cockpitAirLod.js';
import { refreshTrackedSubjectContext } from './contextStore.js';
import { nearFarScalarValueAtDistance } from './focusDeemphasis.js';
import { createGroundSnap } from './groundSnap.js';
import { screenProjectedRotation, stabilizeScreenRotation } from './iconOrientation.js';
import { modelAnchorWorld, modelVisualAnchor } from './modelVisualAnchor.js';
import { arcOffsetEnu, COURSE_HOLD_SPEED_MPS, courseSlewCapDps, limitCourseStep } from './motionModel.js';
import { isTr3b, tr3bConvertedIds, tr3bIconKind } from './tr3bRegistry.js';
import { trackedModelScaleForPixelCap } from './trackedCamera.js';
import { trackedModelZoomActive } from './trackedModelRegime.js';
import { refreshTrackedReadout, trackedLabelModelFromText } from './trackedReadout.js';

/**
 * Build one layer's private tracking pipeline — the per-icao billboard,
 * dead-reckoning, 3D-model, cockpit-contact and fading-trail machinery shared
 * verbatim by flights.js and militaryFlights.js.
 *
 * The returned `p` carries every shared field and behavior; `config` injects
 * only the genuinely per-layer pieces (model spec tables, palette, pixel caps,
 * feed-shape accessors, tracking seams). The two layers therefore differ by
 * presentation and record shape, never by behavior.
 *
 * @param {object} config - Per-layer seams and presentation constants.
 * @param {Function} config.modelSpec - `klass -> {url, scale, blendAmount, bellyM,
 *   nativeRadiusM, visualCenterNative, trailAnchorNative}` GLB spec lookup.
 * @param {Function} config.refreshTr3bContact - Re-renders one converted (TR-3B) contact.
 * @param {Function} config.clearTracking - Deselects the tracked subject, `(notify, {origin})`.
 * @param {Function} config.trackFlight - Selects a contact as the tracked subject,
 *   `(icao24, {origin})`.
 * @param {Function} config.updateTrackedModel - One frame of the tracked-model driver
 *   (normally a `scene.preUpdate` listener).
 * @param {Function} config.contextSubjectMetadata - Builds the context-slot metadata for one icao.
 * @param {Function} config.fleetBillboardColor - Ambient billboard `Cesium.Color` for one icao.
 * @param {Function} config.fleetBillboardScale - Ambient billboard scale for one icao/class.
 * @param {Function} config.modelCap - Concurrent 3D-model budget (count).
 * @param {Function} config.modelColor - glTF creation tint for one icao.
 * @param {Function} config.modelMatrix - Writes a display position + course into a model
 *   matrix, `(position, courseDeg, result)`.
 * @param {Function} config.normalBillboardScaleByDistance - Ambient `Cesium.NearFarScalar` ramp.
 * @param {Function} config.refreshTrailDisplay - Repaints the fading trail from accumulated fixes.
 * @param {Function} [config.trailFloorFix] - Floors a trail fix to sampled ground; flights
 *   pushes raw fixes and omits the seam.
 * @param {Function} [config.requestTypeEnrichment] - Flags one icao's type metadata as wanted;
 *   charged against the ambient token bucket (see flights._requestModelTypeEnrichment);
 *   military runs no ambient enrichment and omits the seam.
 * @param {Function} config.trackedLabelText - Readout label text for one icao.
 * @param {Function} config.fleetFreshnessColor - Cockpit-dot freshness tint, `(icao24, alpha)`.
 * @param {Function} config.infoSpeed - Ground speed (m/s) from a feed's INFO fallback record.
 * @param {Function} config.infoHeading - True course (deg) from a feed's INFO fallback record.
 * @param {number} config.trackedModelMaxPx - Pixel cap on the tracked model silhouette.
 * @param {number} config.trackedFocusScaleBase - Base billboard scale for focus sizing.
 * @param {string} config.trackedLabelAccent - Accent color for the tracked readout.
 * @param {Cesium.Color} config.unmodeledTrackedColor - Tracked billboard color while 2D.
 * @param {Cesium.Color} config.modeledIconColor - glTF tint while a model owns the visual.
 * @returns {object} The `p` pipeline instance, assigned onto the owning layer via `Object.assign`.
 */
export function createFlightTrackingPipeline(config) {
  const p = {};

  // ── Shared state (was module state in flights.js) ──

/** Flip the whole 3D fleet's boost state by dropping models so the eligibility
 *  pass reloads them with creation-time boost options (both directions — a
 *  boosted model must not stay flat white back in Normal). Destroying 350
 *  GPU-backed models synchronously inside the style handler stalls the render
 *  thread (review P1; same failure the cockpit path documents), so the release
 *  is BATCHED through the fleet tick: each tick drops a bounded slice, showing
 *  each plane's billboard first (gap-proof per plane, no double-image window).
 *  Models are tagged with the boost state they loaded under, so queue entries
 *  whose model already matches the current state (rapid style cycling, or a
 *  reload that already happened) are skipped. In-flight loads are invalidated
 *  immediately (cheap gen bumps); the tracked model is a single primitive and
 *  reloads synchronously. */
p.IR_RELOAD_BATCH = 40;

p.MODEL_ALL_ADD_M = 400000;  // all: model NEW planes within 400 km (~to the horizon)

p.MODEL_ALL_KEEP_M = 450000;  // all: KEEP modeled planes out to 450 km

p.MODEL_ALT_CEIL_M = 800000; // m: below this camera altitude, draw 3D models (raised so it's easy to trigger)

// Per-mode ADD / KEEP radii. The two modes differ by RADIUS, not just cap — otherwise they look
// IDENTICAL whenever fewer than a cap's worth of planes are in range (field bug: Proximity and All
// rendered the same). 'proximity' = a tight ring; 'all' = roughly to the horizon (state-scale). Each
// band has hysteresis (KEEP > ADD) so a plane doesn't release+reload its model when it straddles the
// add edge (the zoom/pan flicker). Beyond ADD a model would force-clamp to minimumPixelSize into a
// giant floating blob (the old 422 km airport-cluster bug), so far planes stay 2D dots; the cap +
// on-screen priority then spend the model slots on planes you can actually see.
p.MODEL_PROX_ADD_M = 150000;  // proximity: model NEW planes within 150 km

p.MODEL_PROX_KEEP_M = 185000;  // proximity: KEEP modeled planes out to 185 km

/** @constant {number} Display latency in seconds (= one poll interval). */
p.RENDER_DELAY_SEC = 30;

/** Bounded on-demand loading for the tracked model. The tracked regime is
 *  DEFAULT-ON and its driver runs every `scene.preUpdate`, so a missing or
 *  corrupt GLB — or a dead network — would otherwise spin load→reject at frame
 *  rate for as long as the contact stays selected. Failures are counted PER
 *  SELECTION: a short backoff absorbs a transient blip, then the layer stops
 *  asking until the operator selects something else. The billboard is the
 *  visual throughout (the handoff only fades it once a model actually renders),
 *  so a latched failure degrades to exactly the pre-3D presentation. */
p.TRACKED_MODEL_MAX_LOAD_FAILS = 3;

p._activeUpdateControllers = new Set();

/** @type {Cesium.BillboardCollection|null} */
p._billboardCollection = null;

/** @type {Map<string, Cesium.Billboard>} icao24 -> billboard primitive */
p._billboards = new Map();

/** Frame-cached course for the tracked aircraft (sibling of _cachedDRPosition). */
p._cachedDRCourse = null;

/** @type {number} Frame number for which _cachedDRPosition is valid */
p._cachedDRFrame = -1;

p._cachedDRHold = false;

/** @type {Cesium.Cartesian3|null} */
p._cachedDRPosition = null;

/** Frame-cached siblings of _cachedDRCourse (same discipline). */
p._cachedDRSpeedMps = null;

/** Cockpit presentation switches ambient AIR contacts between near aircraft and far dots. */
p._cockpitContactMode = false;

/** AIR contacts inside the selected Display range; independent from model admission/load/cap. */
p._cockpitNearContacts = new Set();

/** Normalized ICAO24 of the active Cockpit subject, omitted from detection candidates. */
p._cockpitSubjectId = null;

/** @type {string|null} icao the reconciliation state currently belongs to */
p._drReconcileIcao = null;

p._drReconcileValid = false;

/** @type {Map<string, {callsign:string, altitude:number, velocity:number, true_track:number}>} */
p._flightData = new Map();

/** One-shot cached tile-skin heights for MODELED grounded planes (see groundSnap.js). */
p._groundSnap = createGroundSnap();

/** Sprite kind for one contact's billboard. Identity for every aircraft except
 *  the ones the operator converted into a TR-3B (Easter egg), which draw the
 *  black-triangle glyph — its thermal-reactive variant while an IR style owns
 *  the scene. Routing EVERY `aircraftIcon()` call through this is what makes a
 *  conversion survive the poll reconciler and the two-tier raster swap.
 * @param {string} icao24 - Normalized ICAO 24-bit address of the contact.
 * @param {string} klass - Aircraft class key from the feed's metadata.
 * @returns {string} Icon kind: `klass` unchanged, or a TR-3B glyph kind when converted. */
p._iconKind = (icao24, klass) => tr3bIconKind(icao24, klass, { hot: p._irBoost });

/** IR hot-target mode (field test 2026-08-16): the NVG/FLIR post-styles
 *  map LUMINANCE, so mid-gray textured models read cold and vanish into
 *  terrain. While a boost style is active every model renders flat white
 *  (hottest); per-spec color/tint restores on style exit. Driven by ui.js
 *  setStyle via the `irBoost` layer param. */
p._irBoost = false;

p._irReloadQueue = null;

/** @type {string} Camera pose signature at the last rotation pass */
p._lastCamPoseSig = '';

/** @type {number} Last computed rotation for the tracked entity (radians) */
p._lastTrackedRotation = 0;

/** @type {Cesium.PrimitiveCollection|null} */
p._modelCollection = null;

/** @type {Map<string, number>} icao24 → load generation; bumped on release to invalidate
 *  an in-flight load (so a track/untrack/remove during fromGltfAsync can't add a stale model). */
p._modelGen = new Map();

/** @type {Set<string>} icao24 currently loading (async) */
p._modelPending = new Set();

/** @type {Map<string, Cesium.Model>} icao24 → model */
p._models = new Map();

/** DEFAULT-ON in PROXIMITY (product invariant 2026-08-22). A fresh boot never runs
 *  layer-state restoration, so this initializer — not the codec — is what the app
 *  actually starts with; it must stay in lockstep with the `models3d` default in
 *  `layerState.js` and `this._models3dEnabled` in ui.js, or the DISPLAY rail would
 *  light a button the layer has not armed. */
p._models3dEnabled = true;

p._models3dMode = 'proximity'; // 'proximity' = nearest MODEL_MAX in view; 'all' = every in-view plane (≤ MODEL_MAX_ALL)

p._pendingTrackingRestore = null;

/** @type {Map<string, Array<{time:Cesium.JulianDate, position:Cesium.Cartesian3}>>} */
p._positionHistory = new Map();

p._scratchGroundCarto = new Cesium.Cartographic();

/** Scratch for the tracked model's world-space origin (the envelope centre). */
p._scratchTrailClip = new Cesium.Cartesian3();

p._scratchWarmupTime = new Cesium.JulianDate();

/** Spec identity for a LOADED model: URL and scale together (same-URL classes
 *  differ by scale — airliner vs quadjet both ship airplane.glb).
 * @param {string} klass - Aircraft class key from the feed's metadata.
 * @returns {string} `"<url>@<scale>"` identity compared against `model._gevSpecKey`. */
p._specKeyFor = (klass) => {
  const spec = p._modelSpec(klass);
  return `${spec.url}@${spec.scale}`;
};

/** Wall-clock of the tracked course limiter's last advance (dt source only —
 *  the course VALUE lives in the shared per-icao _displayCourse map below). */
p._trackedCourseMs = 0;

/** @type {Cesium.Entity|null} Entity used for camera tracking */
p._trackedEntity = null;

/** @type {string|null} ICAO24 of the currently tracked aircraft */
p._trackedIcao = null;

/** @type {Cesium.Model|null} Standalone 3D model for the tracked aircraft. Deliberately NOT a
 *  graphic on _trackedEntity: viewer.trackedEntity derives the follow-camera from the entity's
 *  bounding sphere, and a model graphic reports PENDING until its glTF loads — which stalls (or, on
 *  3D-toggle, freezes) the centering. A pure-billboard entity always supplies a ready sphere; the
 *  model rides in _modelCollection and is driven per-frame, fully decoupled from the camera. */
p._trackedModel = null;

p._trackedModelFailCount = 0;

p._trackedModelFailIcao = null;

/** Bumped on untrack/teardown so an in-flight tracked-model load resolves into a no-op. */
p._trackedModelGen = 0;

p._trackedModelLoading = false;

p._trackedModelRetryAtMs = 0;

p._trackedTrailPos = new Cesium.Cartesian3();

/** @type {Cesium.Cartesian3} Scratch for the tracked model's rendered translation. */
p._trackedVisualPos = new Cesium.Cartesian3();

p._trackedZoomLatchIcao = null;

/** Hysteresis latch for the tracked contact's zoom regime, plus the selection it
 *  belongs to. Scoped per selection so a NEW target re-evaluates against the ENTER
 *  ceiling instead of inheriting the previous target's looser EXIT band. */
p._trackedZoomLatched = false;

p._trackingIntentGeneration = 0;

/** @type {{setPositions: Function, clear: Function, destroy: Function}|null} Shared fading-trail renderer */
p._trail = null;

/** @type {number} Monotonic token — invalidates in-flight backfill responses */
p._trailBackfillToken = 0;

/** @type {Cesium.Entity|null} Cheap 2-point head segment bridging the last fix to the LIVE
 *  dead-reckoned icon, updated per frame via a CallbackProperty — so the trail head stays
 *  glued to the 12 Hz icon without rebuilding the 400-point trail primitive every frame. */
p._trailHeadEntity = null;

/** @type {Cesium.Cartesian3[]} Chronological tracked-aircraft fixes (oldest first) */
p._trailPositions = [];

/** @type {Cesium.Viewer|null} Cached viewer reference */
p._viewer = null;

p.COCKPIT_CONTACT_SIZE_PX = 6;

/** Max course slew (deg/s) — well above real turns (≤4°/s), hides fix-boundary
 *  steps. Scaled down toward COURSE_MIN_DPS at low speed (courseSlewCapDps). */
p.COURSE_MAX_DPS = 60;

/** Never spend a long render stall's full elapsed time in one visible course step. */
p.COURSE_SLEW_DT_MAX_SEC = 0.25;

p.MODEL_MIN_PX = 24;        // floor so distant models stay visible WITHOUT ballooning into a giant

p.TRACKED_BILLBOARD_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  1000, 3.0, 8000000, 0.5,
);

                                // min-pixel blob (was 54 — far planes at the All radius became white
                                // star-bursts); ~matches the 2D icon size so the model↔billboard read is consistent
p.TRACKED_MODEL_MIN_PX = 40; // keep the glTF silhouette comparable to the selected 2D glyph at handoff

/** @constant {number} Combined cap on trail vertices (backfill + live accumulation). */
p.TRAIL_MAX_POINTS = 400;

/** Boosted models render UNLIT (owner cockpit-FLIR field rounds, 2026-08-16):
 *  the white tint alone is applied to the MATERIAL, so Cesium still
 *  sun-shades it — near-horizon viewing shows a plane's SIDE, ~90° to a high
 *  sun, so it rendered near-BLACK in FLIR/NVG while sun-lit neighbors glowed.
 *  LightingModel.UNLIT emits the flat white directly, orientation be damned.
 *  CRITICAL (field-verified via scene.pick): assigning customShader to an
 *  already-READY model is a silent no-op — the property sets but the shader
 *  program never rebuilds. The boost therefore flips by RELEASE-AND-RELOAD
 *  (see setParams), so every boosted model gets the shader AT CREATION.
 *  One shared shader instance — stateless, safe across models. */
p._IR_UNLIT_SHADER = new Cesium.CustomShader({ lightingModel: Cesium.LightingModel.UNLIT });

/** Last limb taper per billboard, retained across class/ground/cockpit repaints. */
p._billboardLimbScale = new WeakMap();

/** Per-aircraft smoothed display course — the SINGLE source of truth for the
 *  nose direction an aircraft displays. The fleet pass reads/writes it at
 *  tick cadence for untracked planes; _trackedDisplayCourse reads/writes the
 *  SAME entry per frame for the tracked plane (the fleet pass skips the
 *  tracked icao, so exactly one writer owns an entry at a time). Sharing the
 *  entry — including its slew state — is what makes the tracked↔fleet
 *  handoff seamless (2026-07-03 field fix: separate states froze the fleet
 *  entry while tracked, so clicking / un-clicking a 65 kt helicopter FLIPPED
 *  its nose — "looks like it's going in reverse"). */
p._displayCourse = new Map();

/** Course (deg) of the position `_deadReckon` most recently returned — set on
 *  every branch of `_deadReckon`, read IMMEDIATELY by the caller (same
 *  synchronous flow; module-scratch idiom, like the Cartesian scratches). */
p._drCourseDeg = null;

p._drCourseHold = false;

/** Sibling scratches of _drCourseDeg: the displayed ground speed of the motion
 *  `_deadReckon` just returned, and whether that motion is too slow for ANY
 *  course source to be trusted (hover/GPS drift — consumers HOLD their
 *  previous display course instead of chasing noise). */
p._drSpeedMps = null;

/** @type {number} Epoch ms of the last fleet dead-reckoning pass */
p._lastFleetTickMs = 0;

/** Lifecycle epoch; bumped on destroy so an in-flight load from a PREVIOUS init can't settle
 *  against a new lifecycle's globals (which destroy cleared). Captured by _ensureModel. */
p._modelEpoch = 0;

// The tracked entity's billboard goes transparent (rather than hidden) once the model takes
// over, so it keeps supplying a bounding sphere for follow-camera framing. We only drop its
// alpha after the GLB is preloaded so the model is ready to render the instant the billboard
// fades — no gap, no double-image. Preloaded once at init; the instance is retained (not
// destroyed) purely to keep Cesium's glTF cache warm for fast tracked-model instantiation.
p._planeModelLoaded = false;

p._scratchArc = { east: 0, north: 0, endCourseDeg: 0 };

p._scratchEnu = new Cesium.Matrix4();

p._scratchGroundPos = new Cesium.Cartesian3();

p._scratchOffset = new Cesium.Cartesian3();

  // ── Per-layer hooks injected by the owning layer ──

  p._modelSpec = config.modelSpec;
  p._refreshTr3bContact = config.refreshTr3bContact;
  p._clearTracking = config.clearTracking;
  p._trackFlight = config.trackFlight;
  p._updateTrackedModel = config.updateTrackedModel;
  p._contextSubjectMetadata = config.contextSubjectMetadata;
  p._fleetBillboardColor = config.fleetBillboardColor;
  p._fleetBillboardScale = config.fleetBillboardScale;
  p._modelCap = config.modelCap;
  p._modelColor = config.modelColor;
  p._modelMatrix = config.modelMatrix;
  p._normalBillboardScaleByDistance = config.normalBillboardScaleByDistance;
  p._refreshTrailDisplay = config.refreshTrailDisplay;
  p._requestTypeEnrichment = config.requestTypeEnrichment;
  p._trackedLabelText = config.trackedLabelText;
  // Cockpit-dot freshness tint: flights tints by registry (military vs civilian),
  // military paints every contact in its uniform icon color.
  p._fleetFreshnessColor = config.fleetFreshnessColor;

  // Layer-owned presentation constants — the shared bodies read these through
  // p so each layer injects its own palette and pixel caps.
  p.TRACKED_MODEL_MAX_PX = config.trackedModelMaxPx;
  p.TRACKED_FOCUS_SCALE_BASE = config.trackedFocusScaleBase;
  p.TRACKED_LABEL_ACCENT = config.trackedLabelAccent;
  p.UNMODELED_TRACKED_COLOR = config.unmodeledTrackedColor;
  p.MODELED_ICON_COLOR = config.modeledIconColor;

  // Kinematics-field accessors: the two feeds agree on fix.velocity/fix.track
  // but disagree on the INFO fallback field names (flights: velocity|true_track,
  // military: speedMps|track).
  p._infoSpeed = config.infoSpeed;
  p._infoHeading = config.infoHeading;

  // military floors trail fixes to sampled ground; flights pushes raw fixes.
  p._trailFloorFix = config.trailFloorFix;

  // Sibling scratch: whether the position `_deadReckon` just returned came from
  // EXTRAPOLATION (coasting past the newest fix, or the pre-history warm-up)
  // rather than interpolation between two known fixes. The display-floor
  // corridor needs it — an interpolating contact is walking TOWARD its newest
  // fix, a coasting one is walking AWAY from it along its course, and warming
  // the wrong end leaves a coaster permanently ahead of its floor data.
  p._drExtrapolating = false;

  // ── Shared pipeline functions (verbatim from flights.js) ──

/** Abort every in-flight data fetch this layer owns (refresh/disable/teardown). */
function _abortActiveUpdates() {
  for (const controller of p._activeUpdateControllers) controller.abort();
  p._activeUpdateControllers.clear();
}

/** Normalize a Cockpit event's payload and run the presentation switch it implies.
 *  A missing or falsy `active` means Cockpit is leaving, not just subject-less.
 * @param {{active?: boolean, subjectId?: string}} [detail] - Cockpit state payload. */
function _applyCockpitState(detail = {}) {
  const active = detail?.active === true;
  p._cockpitSubjectId = active
    ? String(detail?.subjectId || '').trim().toLowerCase() || null
    : null;
  p._setCockpitContactMode(active);
}

/** Re-run a tracking intent that had to be deferred — the billboard collection or
 *  the contact's billboard was not ready when the click landed. The stored
 *  generation makes the intent self-expiring: any later cancel/re-track bumps it
 *  and this restores nothing.
 * @returns {boolean} True when a deferred intent was consumed and tracking re-applied. */
function _applyPendingTrackingRestore() {
  const pending = p._pendingTrackingRestore;
  if (!pending || pending.generation !== p._trackingIntentGeneration) return false;
  if (!p._billboardCollection?.show || !p._billboards.has(pending.id)) return false;
  p._pendingTrackingRestore = null;
  p._trackFlight(pending.id, { origin: pending.origin });
  return true;
}

/** Drop any deferred tracking intent and invalidate the ones already queued. */
function _cancelPendingTrackingRestore() {
  p._trackingIntentGeneration += 1;
  p._pendingTrackingRestore = null;
}

/** Drop an icao's generation entry once nothing references it (no live model, no in-flight
 *  load) — keeps _modelGen bounded. Shared by _releaseModel + both _ensureModel exit paths.
 * @param {string} icao24 - Normalized ICAO 24-bit address whose generation entry is reaped. */
function _cleanupModelGen(icao24) {
  if (!p._modelPending.has(icao24) && !p._models.has(icao24)) p._modelGen.delete(icao24);
}

/**
 * Clear the rendered trail and accumulation; invalidate pending backfills.
 */
function _clearTrail() {
  p._trailBackfillToken += 1;
  p._trailPositions = [];
  if (p._trail) p._trail.clear();
  if (p._trailHeadEntity && p._viewer && !p._viewer.isDestroyed()) {
    try { p._viewer.entities.remove(p._trailHeadEntity); } catch { /* already gone */ }
  }
  p._trailHeadEntity = null;
}

/** Cockpit pips keep a flatter ramp than the ambient icons — the pip is a fixed-size
 *  dot whose legibility must survive the full camera range, not a silhouette to scale.
 * @returns {Cesium.NearFarScalar} Near/far scale ramp applied to cockpit contact pips. */
function _cockpitBillboardScaleByDistance() {
  return new Cesium.NearFarScalar(1000, 1.15, 8000000, 0.65);
}

/**
 * Destroy the trail primitive entirely (layer disable/teardown).
 */
function _destroyTrail() {
  p._clearTrail();
  if (p._trail) {
    p._trail.destroy();
    p._trail = null;
  }
}

/** Drain one bounded slice of the boost-flip reload queue (see `p.IR_RELOAD_BATCH`).
 *  Called per fleet tick; the queue self-annihilates once empty, and entries whose
 *  model already matches the current boost state are skipped without a release. */
function _drainIrReloadQueue() {
  if (!p._irReloadQueue) return;
  const batch = p._irReloadQueue.splice(0, p.IR_RELOAD_BATCH);
  for (const icao of batch) {
    const model = p._models.get(icao);
    if (!model || model._gevIrBoost === p._irBoost) continue; // already right state
    const bb = p._billboards.get(icao);
    if (bb && icao !== p._trackedIcao) bb.show = true;
    p._releaseModel(icao);
  }
  if (p._irReloadQueue.length === 0) p._irReloadQueue = null;
}

/** Drive the exact fleet billboard-to-model handoff used by `_fleetTick`.
 * @param {object} root0 - Handoff request.
 * @param {string} root0.icao24 - Normalized ICAO 24-bit address of the contact to hand off.
 * @param {Cesium.Cartesian3} root0.position - Dead-reckoned world position feeding the model matrix.
 * @param {number} [root0.course=0] - Display course (degrees) baked into the model matrix.
 * @returns {boolean} True when the model took the visual, false when the billboard kept it. */
function _driveFleetModelHandoffForTest({ icao24, position, course = 0 }) {
  return p._driveFleetModelHandoff(
    icao24,
    p._models.get(icao24),
    p._billboards.get(icao24),
    position,
    course,
  );
}

/** Publish a layer-lifecycle/awareness `CustomEvent` on `window`. Silently a
 *  no-op outside a browser realm (SSR, workers, unit-test node context).
 * @param {string} type - Event name, e.g. the layer's awareness topic.
 * @param {object} detail - Payload carried on the event's `detail` property. */
function _emitAwarenessEvent(type, detail) {
  if (typeof window === 'undefined' || !window.dispatchEvent || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

/** Exercise the exact asynchronous fleet loader and return its admitted model.
 * @param {string} icao24 - Normalized ICAO 24-bit address to load a model for.
 * @returns {Promise<Cesium.Model|null>} The admitted model, or null when the load was
 *   rejected (cap, stale generation, regime off) or failed. */
async function _ensureFleetModelForTest(icao24) {
  await p._ensureModel(icao24);
  return p._models.get(icao24) || null;
}

/** Depth-test policy for aircraft billboards. Round 5 (product invariant
 *  2026-07-06: "I just want the planes and their lines to ALWAYS be
 *  visible... evenly applied"): EVERY contact renders depth-test-free at
 *  every distance — grounded, low, and airborne alike. The photoreal mesh
 *  writes depth and residual baro/floor error will always leave some sprite
 *  geometry at or below it; a uniform rule beats the grounded-only /
 *  low-AGL-only conditions that kept leaving classes of contacts buried
 *  (2026-07-03 Van Nuys grounded case; 2026-07-06 Austin QNH-below-field
 *  case). Far-side planes are still removed by the fleet tick's horizon
 *  occluder, which never depended on depth. Kept as a function so the
 *  callers' restyle sites stay diff-stable.
 * @returns {number} `Infinity` — Cesium's "never depth-test this billboard" sentinel. */
function _groundDepthDistance() {
  return Number.POSITIVE_INFINITY;
}

/** Everything scene.sampleHeight must NOT hit when snapping a grounded model: the
 *  vertical pick ray at a plane's own lat/lon otherwise lands on its (or a parked
 *  neighbor's) billboard/model instead of the tile skin. Cesium's ray-pick exclusion
 *  matches picked-object IDs, and every billboard AND model in this layer carries its
 *  icao as `id`, so the icao strings cover both; the tracked entity is excluded as the
 *  object itself. Built lazily — only when a sample actually fires (one-shot).
 * @returns {Array<string|Cesium.Entity>} Pick IDs to exclude from the ground-sample ray. */
function _groundSampleExclusions() {
  const out = [...p._billboards.keys()];
  if (p._trackedEntity) out.push(p._trackedEntity);
  return out;
}

/** A user/voice/tool-initiated selection — the class of origin that may open the
 *  cockpit or force a track, as opposed to a programmatic reconcile.
 * @param {string} origin - Tracking-origin tag carried on a track/clear call.
 * @returns {boolean} True for `user`, `voice`, or `tool`. */
function _isExplicitTrackingOrigin(origin) {
  return origin === 'user' || origin === 'voice' || origin === 'tool';
}

/**
 * True while the tracked aircraft's delayed display time (now − RENDER_DELAY_SEC)
 * predates its oldest real fix — i.e. _deadReckon is extrapolating backward, with no
 * real history yet sitting BEHIND the displayed icon. The trail must draw nothing in
 * this window (every accumulated point is ahead of the icon).
 * @returns {boolean} True while the tracked contact has no fix behind its display time.
 */
function _isTrackWarmingUp() {
  if (!p._trackedIcao) return false;
  const history = p._positionHistory.get(p._trackedIcao);
  if (!history || history.length === 0) return true;
  const renderTime = Cesium.JulianDate.addSeconds(
    Cesium.JulianDate.now(), -p.RENDER_DELAY_SEC, p._scratchWarmupTime
  );
  return Cesium.JulianDate.lessThan(renderTime, history[0].time);
}

/** Active ADD radius (m) — new planes inside this range get a model. Mode-aware: 'all' reaches far.
 * @returns {number} Admission radius in metres for the current 3D mode. */
function _modelAddDistM() {
  return p._models3dMode === 'all' ? p.MODEL_ALL_ADD_M : p.MODEL_PROX_ADD_M;
}

/** Position a 3D MODEL renders at. Airborne planes use their dead-reckoned position
 *  verbatim. GROUNDED planes' meta altitude is last-known baro or 0 m — nowhere near
 *  the photoreal tile skin in ellipsoid heights (buried ~100+ m at inland airports,
 *  hovering ~30 m at sea-level ones), and unlike the ground billboards a depth-tested
 *  model can't hide behind disableDepthTestDistance. So a modeled grounded plane rides
 *  a ONE-SHOT cached scene.sampleHeight of the skin at its lat/lon (groundSnap.js,
 *  CCTV-B9b discipline: never per-frame; taxiing >50 m retires the cached value to a
 *  bounded last-known and resamples), plus
 *  the belly offset so it sits on its gear rather than sinking to the model-origin
 *  fuselage centerline. Until the FIRST sample lands (tiles streaming / sample miss)
 *  there is no safe depth-tested placement at all: this returns null, the caller
 *  keeps the 2D billboard visible and the model hidden, and it retries later. Once
 *  a contact has resolved once, a later outage holds that measurement inside
 *  groundSnap's drift bound instead — a taxiing aircraft does not pop back to 2D
 *  because a resample is mid-backoff.
 * @param {string} icao24 - Normalized ICAO 24-bit address (ground-snap cache key).
 * @param {Cesium.Cartesian3} pos - Dead-reckoned world position of the contact.
 * @param {Cesium.Cartesian3} [result] - Cartesian to reuse for the snapped position.
 * @returns {Cesium.Cartesian3|null} `pos` verbatim when airborne, the skin-snapped
 *   position (plus belly offset) when grounded, or null while placement is unresolved. */
function _modelDisplayPosition(icao24, pos, result) {
  const meta = p._flightData.get(icao24);
  if (!meta || !meta.onGround) return pos;
  const h = p._groundSnap.heightFor(p._viewer, icao24, pos, p._groundSampleExclusions);
  if (h == null) return null;
  const carto = Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, p._scratchGroundCarto);
  carto.height = h + p._modelSpec(meta.klass).bellyM;
  return Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height, Cesium.Ellipsoid.WGS84, result);
}

/** A model is the visual only once it actually draws — loaded AND shown.
 *
 * `show` is sufficient evidence of a safe placement because only ONE site ever
 * sets it true for a fleet model (`_driveFleetModelHandoff`, after the matrix is
 * committed) and one for the tracked model (`_updateTrackedModel`, likewise);
 * everything else — admission, an unresolved ground, a not-yet-ready glTF, the
 * limb cull, a regime exit — only ever clears it.
 * @param {Cesium.Model|null} model - Model primitive to test, or null when none is loaded.
 * @returns {boolean} True when the model is loaded AND currently the drawn visual. */
function _modelIsRendering(model) {
  return Boolean(model) && model.ready === true && model.show === true;
}

/** Active KEEP radius (m) — a modeled plane keeps its model out to here (hysteresis vs ADD).
 * @returns {number} Release radius in metres for the current 3D mode. */
function _modelKeepDistM() {
  return p._models3dMode === 'all' ? p.MODEL_ALL_KEEP_M : p.MODEL_PROX_KEEP_M;
}

/**
 * Whether a 3D model — not the billboard — is what the user actually SEES for
 * this contact, and therefore whether the display floor should stand aside.
 *
 * Model EXISTENCE is not ownership. A fleet model that is still loading, or has
 * no resolved ground to stand on, stays hidden while `bb.show` stays true (the
 * gap-proof handoff: "hand off ONLY once the model renders"), and a tracked model
 * is retained but hidden whenever the model regime is off — 3D disabled, camera
 * zoomed past the ceiling, or cockpit mode. Gating on `has()`/existence therefore
 * suppressed the clamp in exactly the states where the BILLBOARD is the visual,
 * putting the burial straight back.
 *
 * Cesium's own default `show === true` is the reason admission clears it
 * explicitly: a fleet model registered in `_models` the instant its glTF resolves
 * would otherwise claim ownership — at the identity matrix — for the frames
 * between admission and the next fleet tick, while the BILLBOARD was still the
 * visual. Ownership means actually rendering, and every site that sets `show`
 * true does so only after committing a matrix.
 *
 * The two halves:
 *  - Fleet: the rendering test alone. Safe for the ground snap either way,
 *    because a fleet model is positioned from the RAW dead-reckon, not from
 *    the billboard.
 *  - Tracked: the rendering test AND `_trackedModelRegimeActive()`. The tracked
 *    model is fed from `_trackedDisplayPosition`, so once it is live the clamp
 *    must stand aside: two different chains would otherwise be deciding one
 *    contact's ground, and the billboard's is the one the operator is not
 *    looking at (T7). The regime check is what makes a regime
 *    flip take effect on the same frame rather than waiting for
 *    `_updateTrackedModel` to clear `show`; the rendering test is what keeps a
 *    null or still-loading tracked model from claiming a visual it is not
 *    drawing yet.
 * @param {string} icao24 - Normalized ICAO 24-bit address of the contact in question.
 * @returns {boolean} True when a 3D model is what the operator is looking at for this contact.
 */
function _modelOwnsVisual(icao24) {
  if (icao24 === p._trackedIcao) {
    return p._trackedModelRegimeActive() && p._modelIsRendering(p._trackedModel);
  }
  return p._modelIsRendering(p._models.get(icao24));
}

/** The FLEET's 3D-model regime: models3d enabled AND the camera zoomed in past the altitude
 *  ceiling. Since 2026-08-22 the toggle DEFAULTS ON in `proximity`, which is itself the
 *  budget: models only appear below MODEL_ALT_CEIL_M and only for the nearest MODEL_MAX in
 *  view. The toggle still OWNS the fleet — an operator who wants every in-view plane arms
 *  `all`, and one who wants none turns 3D off — this predicate is unchanged. The TRACKED
 *  contact does not route through here: it is one model, it is what the camera is aimed at,
 *  and it takes its own default-on, hysteretic zoom regime
 *  (`_trackedModelRegimeActive`).
 * @returns {boolean} True when fleet contacts are eligible for 3D models this frame. */
function _modelRegimeActive() {
  if (!p._models3dEnabled) return false;
  const h = p._viewer?.camera?.positionCartographic?.height ?? Infinity;
  return h < p.MODEL_ALT_CEIL_M;
}

/** Canonicalize a candidate contact id to this layer's icao key form.
 * @param {*} candidate - Raw id from an event payload, selection, or feed record.
 * @returns {string|null} Trimmed lowercase id, or null when the candidate is empty. */
function _normalizeTrackedIcao(candidate) {
  const normalized = String(candidate ?? '').trim().toLowerCase();
  return normalized || null;
}

/**
 * Global keydown handler — Escape deselects the tracked flight.
 * @param {KeyboardEvent} e - Browser key event; only the Escape key is acted on.
 */
function _onKeyDown(e) {
  if (e.key === 'Escape' && p._trackedIcao) {
    p._cancelPendingTrackingRestore();
    p._clearTracking(false, { origin: 'user' });
  }
}

/**
 * Refresh the Cockpit AIR near/far band without consulting model state.
 * Near contacts keep their 2D aircraft silhouette when 3D is off, loading, or
 * capped; only a ready admitted model may take that silhouette over later.
 */
function _refreshCockpitNearContacts() {
  if (!p._cockpitContactMode || !p._viewer?.camera?.positionWC) {
    if (p._cockpitNearContacts.size) p._cockpitNearContacts = new Set();
    return;
  }
  const previous = p._cockpitNearContacts;
  const distancesSquared = [];
  for (const [icao24, bb] of p._billboards) {
    if (icao24 === p._trackedIcao || !bb?.position) continue;
    distancesSquared.push([
      icao24,
      Cesium.Cartesian3.distanceSquared(p._viewer.camera.positionWC, bb.position),
    ]);
  }
  const next = nextCockpitNearContacts(
    previous,
    distancesSquared,
    p._modelAddDistM(),
    p._modelKeepDistM(),
  );
  p._cockpitNearContacts = next;
  let presentationChanged = false;
  for (const [icao24, bb] of p._billboards) {
    if (previous.has(icao24) === next.has(icao24)) continue;
    p._applyFleetBillboardPresentation(icao24, bb);
    presentationChanged = true;
  }
  if (presentationChanged) p._lastCamPoseSig = '';
}

/** Re-image every converted contact this layer owns (IR style flip). */
function _refreshTr3bForStyle() {
  for (const id of tr3bConvertedIds()) {
    if (p._billboards.has(id) || id === p._trackedIcao) p._refreshTr3bContact(id);
  }
}

/** Remove the 3D model for ONE aircraft (removal / military-suppression / track handoff).
 *  Bumps the load generation so any in-flight load for this icao is rejected on completion.
 * @param {string} icao24 - Normalized ICAO 24-bit address whose model is released. */
function _releaseModel(icao24) {
  const m = p._models.get(icao24);
  const pending = p._modelPending.has(icao24);
  // Only bump the generation when there's something to invalidate (an in-flight load or a
  // live model) — so removing never-modeled aircraft doesn't grow p._modelGen.
  if (m || pending) {
    p._modelGen.set(icao24, (p._modelGen.get(icao24) || 0) + 1);
  }
  if (m) {
    if (p._modelCollection && !p._modelCollection.isDestroyed()) { try { p._modelCollection.remove(m); } catch { /* gone */ } }
    p._models.delete(icao24);
  }
  // Do NOT clear p._modelPending here — the in-flight load's OWN post-await removes it. Keeping
  // it (a) prevents a duplicate load from starting and (b) keeps the bumped gen entry alive so
  // the resolving load's gen-check still rejects it.
  p._cleanupModelGen(icao24);
}

/** Remove all live models (toggle-off / zoom-out); billboards take back over next tick. */
function _releaseModels() {
  p._irReloadQueue = null; // a full release supersedes any pending boost-flip drain
  // Invalidate in-flight loads so a completion after this bulk release can't add a model.
  for (const icao of p._modelPending) p._modelGen.set(icao, (p._modelGen.get(icao) || 0) + 1);
  if (p._modelCollection && !p._modelCollection.isDestroyed()) {
    for (const m of p._models.values()) { try { p._modelCollection.remove(m); } catch { /* gone */ } }
  }
  p._models.clear();
}

/** Destroy the standalone tracked-aircraft model and invalidate any in-flight load. */
function _releaseTrackedModel() {
  p._trackedModelGen++;
  p._trackedModelLoading = false;
  if (p._trackedModel) {
    if (p._modelCollection && !p._modelCollection.isDestroyed()) { try { p._modelCollection.remove(p._trackedModel); } catch { /* gone */ } }
    p._trackedModel = null;
  }
}

/** Queue every live model for the boost-state reload and drop the tracked model so
 *  both presentation paths come back with the shader/tint they were created under. */
function _reloadModelsForIrBoost() {
  p._irReloadQueue = [...p._models.keys()];
  for (const icao of p._modelPending) {
    if (!p._models.has(icao)) p._modelGen.set(icao, (p._modelGen.get(icao) || 0) + 1);
  }
  p._releaseTrackedModel();
}

/** Reset reconciliation + per-frame cache when tracking stops or switches
 *  target. Deliberately does NOT touch _displayCourse: the smoothed course
 *  entry belongs to the AIRCRAFT (not to the tracked session) and must
 *  survive the handoff back to the fleet pass. */
function _resetTrackedDisplay() {
  p._drReconcileValid = false;
  p._drReconcileIcao = null;
  p._cachedDRFrame = -1;
  p._cachedDRPosition = null;
  p._cachedDRCourse = null;
  p._cachedDRSpeedMps = null;
  p._cachedDRHold = false;
  p._trackedCourseMs = 0;
}

/** Clear every per-SELECTION tracked-model latch: the zoom hysteresis band and
 *  the load-failure bound. Called from each path that changes which contact is
 *  selected — deselect, re-track, cross-layer handoff, init, destroy.
 *
 *  This must live in the production lifecycle, not only in the predicate's
 *  icao-change guard: a deselect followed by a same-turn re-track of the SAME
 *  icao (Contacts re-entry, a cross-layer round trip back to the original
 *  layer) never makes `_trackedIcao` *observably* change, so the guard never
 *  fires. Without the reset, a contact dropped inside the hysteresis band comes
 *  back as a MODEL above the ENTER ceiling, and a contact whose GLB had already
 *  failed out would never get its retries back. */
function _resetTrackedSelectionState() {
  p._trackedZoomLatched = false;
  p._trackedZoomLatchIcao = null;
  p._trackedModelFailIcao = null;
  p._trackedModelFailCount = 0;
  p._trackedModelRetryAtMs = 0;
}

/** Set the exact Cockpit subject through the production state transition for focused tests.
 * @param {boolean} active - True to enter Cockpit contact mode, false to leave it.
 * @param {string|null} [subjectId=null] - ICAO 24-bit address of the Cockpit subject; ignored
 *   when `active` is false. */
function _setCockpitDetectionSubjectForTest(active, subjectId = null) {
  p._applyCockpitState({ active, subjectId });
}

/** Class-change model sync (enrichment AND poll-path klass updates): when the
 *  aircraft's live model or in-flight load no longer matches its class's spec,
 *  drop it so the eligibility pass reloads the right asset at the right scale.
 *  Gap-proof: the fleet billboard is re-shown BEFORE the release so the
 *  contact never goes invisible for the tick gap; _releaseModel's generation
 *  bump also invalidates any pending load. The tracked standalone model gets
 *  the same rule (its billboard entity is always the fallback visual).
 * @param {string} icao24 - Normalized ICAO 24-bit address whose model spec is re-checked. */
function _syncModelToClass(icao24) {
  const key = p._specKeyFor(p._flightData.get(icao24)?.klass);
  const current = p._models.get(icao24);
  if ((current && current._gevSpecKey !== key) || (!current && p._modelPending.has(icao24))) {
    const bb = p._billboards.get(icao24);
    if (bb && icao24 !== p._trackedIcao) bb.show = true;
    p._releaseModel(icao24);
  }
  if (icao24 === p._trackedIcao && p._trackedModel && p._trackedModel._gevSpecKey !== key) {
    p._releaseTrackedModel();
  }
}

/** Seed the tracked billboard's 2D orientation before a 3D→2D handoff. */
function _syncTracked2dRotation() {
  if (!p._trackedIcao || !p._viewer) return;
  const pos = p._trackedDisplayCached() || p._billboards.get(p._trackedIcao)?.position;
  if (!pos) return;
  const projected = screenProjectedRotation(
    p._viewer.scene,
    pos,
    p._trackedDisplayCourse(),
    p._lastTrackedRotation,
  );
  const rotation = stabilizeScreenRotation(p._lastTrackedRotation, projected, 0);
  if (rotation !== null) p._lastTrackedRotation = rotation;
}

/** Re-image the tracked entity's billboard from the current class/conversion. */
function _syncTrackedBillboardImage() {
  if (!p._trackedIcao || !p._trackedEntity?.billboard) return;
  p._trackedEntity.billboard.image = aircraftIcon(
    p._iconKind(p._trackedIcao, p._flightData.get(p._trackedIcao)?.klass),
    TRACKED_ICON_PX,
  );
}

/**
 * Normalize a value to a trimmed string. A whitespace-only field ("   ") is
 * truthy, so every label chain must trim FIRST and then fall through.
 * @param {*} value - Any value (typically a metadata string or null).
 * @returns {string} Trimmed string, or '' if falsy.
 */
function _toCleanText(value) {
  return String(value || '').trim();
}

/** The tracked plane's current display position WITHOUT recomputing — the exact value the
 *  follow-camera already settled on this frame (in the Viewer _onTick). getDetectableObjects + the
 *  readout run in postRender at a LATER frameNumber, so calling _trackedDisplayPosition there would
 *  re-run the dead-reckon on a fresh sample and double-advance the reconciliation → the label jitters
 *  against the now-stable plane (the model's jitter fix, resurfacing in the labels). Returns null when
 *  there's no valid fix for the tracked aircraft, so callers fall back to the billboard position.
 * @returns {Cesium.Cartesian3|null} This frame's already-computed tracked position, or null. */
function _trackedDisplayCached() {
  return (p._drReconcileValid && p._drReconcileIcao === p._trackedIcao) ? p._cachedDRPosition : null;
}

/** Trail endpoint for the rendered tracked owner. Brackets/readouts stay on
 * the visual centre; only the trail moves to the model's lower-centre hardpoint. */
/** The tracked model's rendered bounding radius (m), or 0 when no model of this
 *  contact is drawing. Carries Cesium's effective `computedScale`, which may be
 *  above `scale` to satisfy minimumPixelSize — the trail head has to be judged
 *  against the size the operator SEES, not the nominal one. */
/** World-space origin of the tracked model, or null when no model of this
 *  contact is drawing. This is the centre the rendered bounding sphere is
 *  measured from, so the trail clip and the envelope agree on one frame.
 * @returns {Cesium.Cartesian3|null} Model origin in world space, or null when no model draws. */
function _trackedModelCenterWorld() {
  if (!p._trackedIcao || !p._trackedModel || !p._modelOwnsVisual(p._trackedIcao)) return null;
  return Cesium.Matrix4.getTranslation(p._trackedModel.modelMatrix, p._scratchTrailClip);
}

/** Radius (m) of the tracked model as actually rendered this frame — the class
 *  spec's native radius scaled by Cesium's effective `computedScale`, which may
 *  exceed the nominal spec scale to satisfy minimumPixelSize.
 * @returns {number} Rendered bounding radius in metres, 0 when no model draws. */
function _trackedModelEnvelopeM() {
  if (!p._trackedIcao || !p._trackedModel || !p._modelOwnsVisual(p._trackedIcao)) return 0;
  const spec = p._modelSpec(p._flightData.get(p._trackedIcao)?.klass);
  const scale = Number.isFinite(p._trackedModel.computedScale)
    ? p._trackedModel.computedScale
    : spec.scale;
  return spec.nativeRadiusM * scale;
}

/** Whether the driver may start another tracked-model load this frame.
 * @param {number} [nowMs=Date.now()] - Current wall clock (ms); injected for determinism.
 * @returns {boolean} True while the per-selection failure bound and retry backoff allow it. */
function _trackedModelLoadAllowed(nowMs = Date.now()) {
  if (p._trackedModelFailIcao !== p._trackedIcao) return true; // untried selection
  if (p._trackedModelFailCount >= p.TRACKED_MODEL_MAX_LOAD_FAILS) return false;
  return nowMs >= p._trackedModelRetryAtMs;
}

/** Evaluate the TRACKED contact's zoom regime through the production predicate.
 *  The decision is latch-bearing (default-on, hysteretic, cockpit/TR-3B-suppressed)
 *  and otherwise only observable through a live scene, so tests drive it here.
 * @returns {boolean} The tracked contact's current zoom-regime decision. */
function _trackedModelRegimeActiveForTest() {
  return p._trackedModelRegimeActive();
}

/** Trail endpoint for the rendered tracked owner: the model's trail hardpoint when a
 *  model owns the visual, otherwise the cached dead-reckoned display position.
 * @returns {Cesium.Cartesian3|null} World-space trail head, or null with no valid fix. */
function _trackedTrailCached() {
  if (p._trackedIcao && p._modelOwnsVisual(p._trackedIcao)) {
    const spec = p._modelSpec(p._flightData.get(p._trackedIcao)?.klass);
    // Through the model's OWN render chain (modelVisualAnchor's hand-rolled
    // half-correction put this offset on the lateral axis — see
    // modelAnchorWorld).
    return modelAnchorWorld(p._trackedModel, spec.trailAnchorNative, p._trackedTrailPos);
  }
  return p._trackedDisplayCached();
}

/**
 * The position the tracked aircraft is VISUALLY at this frame — the translation its
 * 3D model is actually rendering with when the model owns the visual, otherwise the
 * cached dead-reckoned position the billboard uses.
 *
 * This exists because a grounded plane's model rides a one-shot ground snap while its
 * billboard deliberately stays at the reported (buried) altitude — a ~100 m vertical
 * split at an inland airport. Anything anchored to the display position while the model
 * is what you can see drifts below the aircraft and only converges as the coarse floor
 * cell warms ("the buoy"), sometimes never.
 *
 * It reads `modelMatrix`, which `_updateTrackedModel` already wrote this frame — no
 * sampling, no `_modelDisplayPosition` call from postRender, and no new dead reckoning,
 * so the follow-camera anti-jitter contract on `gevDisplayPosition` is untouched.
 * @returns {Cesium.Cartesian3|null} The tracked contact's visual position this frame.
 */
function _trackedVisualCached() {
  if (p._trackedIcao && p._modelOwnsVisual(p._trackedIcao)) {
    const spec = p._modelSpec(p._flightData.get(p._trackedIcao)?.klass);
    return modelVisualAnchor(
      p._trackedModel.modelMatrix,
      spec.visualCenterNative,
      Number.isFinite(p._trackedModel.computedScale) ? p._trackedModel.computedScale : spec.scale,
      p._trackedVisualPos,
    );
  }
  return p._trackedDisplayCached();
}

/** Run one frame of the production tracked-model driver (normally a
 *  `scene.preUpdate` listener) so tests can pin its bounded load retries.
 * @returns {*} Whatever the injected driver returned for that frame. */
function _updateTrackedModelForTest() {
  return p._updateTrackedModel();
}

/**
 * Append one fix to the tracked aircraft's trail accumulation and refresh
 * the rendered trail. Caller passes an owned (cloned) Cartesian3.
 * @param {Cesium.Cartesian3} position - New fix position, appended at the head.
 */
function _appendTrailFix(position) {
  p._trailPositions.push(p._trailFloorFix ? p._trailFloorFix(position) : position);
  if (p._trailPositions.length > p.TRAIL_MAX_POINTS) p._trailPositions.shift();
  p._refreshTrailDisplay();
}

/** Apply the current normal/cockpit visual contract to one owned fleet billboard.
 * @param {string} icao24 - Normalized ICAO 24-bit address the billboard belongs to.
 * @param {Cesium.Billboard} [bb] - Billboard primitive to restyle; a no-op when absent. */
function _applyFleetBillboardPresentation(icao24, bb) {
  if (!bb) return;
  const limbScale = p._billboardLimbScale.get(bb) ?? 1;
  const isCockpitContact = p._cockpitContactMode && icao24 !== p._trackedIcao;
  const isCockpitNear = isCockpitContact && p._cockpitNearContacts.has(icao24);
  if (isCockpitContact && !isCockpitNear) {
    const freshnessAlpha = bb.color?.alpha ?? 1;
    bb.image = cockpitContactDotImage();
    bb.width = p.COCKPIT_CONTACT_SIZE_PX;
    bb.height = p.COCKPIT_CONTACT_SIZE_PX;
    bb.scale = limbScale;
    bb.scaleByDistance = p._cockpitBillboardScaleByDistance();
    bb.color = p._fleetFreshnessColor(icao24, freshnessAlpha);
    bb.rotation = 0;
    return;
  }

  const meta = p._flightData.get(icao24);
  bb.image = aircraftIcon(p._iconKind(icao24, meta?.klass), bb._gevIconLarge ? TRACKED_ICON_PX : undefined);
  bb.width = icao24 === p._trackedIcao ? 24 : 20;
  bb.height = icao24 === p._trackedIcao ? 24 : 20;
  bb.scale = p._fleetBillboardScale(icao24, meta?.klass) * limbScale;
  bb.scaleByDistance = p._normalBillboardScaleByDistance();
  bb.color = p._fleetBillboardColor(icao24).withAlpha(bb.color?.alpha ?? 1);
}

/** Atomically hand one fleet contact from its billboard to a safely placed,
 * ready 3D model. Missing/loading models and unresolved terrain always leave
 * the billboard owning the visual, so no render frame can hide both.
 * `beforeShow` runs only on the committing path — the per-tick model treatment
 * belongs to a model that is about to draw, not to one still waiting.
 * @param {string} icao24 - Normalized ICAO 24-bit address being handed off.
 * @param {Cesium.Model|null} model - Admitted model primitive, or null when none is loaded.
 * @param {Cesium.Billboard} bb - The 2D billboard currently owning the visual.
 * @param {Cesium.Cartesian3} pos - Dead-reckoned world position for the model matrix.
 * @param {number} course - Display course (degrees) baked into the model matrix.
 * @param {Function} [beforeShow] - Ran once immediately before the model is shown.
 * @returns {boolean} True when the model now owns the visual, false when the billboard
 *   kept it (nothing loaded, or no safe placement). */
function _driveFleetModelHandoff(icao24, model, bb, pos, course, beforeShow) {
  if (!model) {
    bb.show = true;
    return false;
  }
  const displayPos = p._modelDisplayPosition(icao24, pos, p._scratchGroundPos);
  if (!displayPos) {
    model.show = false; // no ground evidence → nothing safe to place a depth-tested model at
    bb.show = true;
    return false;
  }
  // The matrix is written BEFORE the readiness test on purpose: a model can flip
  // `ready` during scene update after this tick, and a first rendered frame on a
  // stale load-start matrix is the one-frame jump this ordering prevents.
  p._modelMatrix(displayPos, course, model.modelMatrix);
  if (!model.ready) {
    model.show = false; // not loaded yet → keep the 2D icon, no half-model flash
    bb.show = true;
    return false;
  }
  beforeShow?.();
  if (!model.show) model.show = true;
  if (bb.show) bb.show = false; // hand off ONLY once the model renders
  return true;
}

/** Lazily create the glTF model for an aircraft (fire-and-forget; billboard shows until ready).
 * @param {string} icao24 - Normalized ICAO 24-bit address to admit into the model set. */
async function _ensureModel(icao24) {
  // Never model the TRACKED aircraft — it owns a separate entity billboard, and the fleet
  // tick skips it, so a model here would be orphaned + double-rendered.
  if (icao24 === p._trackedIcao) return;
  // model-eligible: about to render in 3D — front of the enrichment queue,
  // charged against the ambient bucket (military runs no ambient enrichment,
  // so its config omits the seam)
  p._requestTypeEnrichment?.(icao24);
  if (p._models.has(icao24) || p._modelPending.has(icao24)) return;
  // Count PENDING loads in the cap so a zoomed-in tick can't fire 100s of concurrent loads
  // (the cap is rechecked post-await too, before the add). Mode-aware so 'all' can reach MAX_ALL.
  if ((p._models.size + p._modelPending.size) >= p._modelCap()) return;
  const epoch = p._modelEpoch;             // lifecycle token: if destroy() bumps it, this load is dead
  const gen = p._modelGen.get(icao24) || 0; // capture; if it changes during the load, we're stale
  p._modelPending.add(icao24);
  let model = null;
  // Spec identity captured at load START — if enrichment reclassifies the
  // aircraft mid-load, the post-await admission below rejects the stale asset.
  // Boost state likewise: the creation options bake it in, so a mid-load
  // toggle must reject too (the reload queue only covers ADMITTED models).
  const specKey = p._specKeyFor(p._flightData.get(icao24)?.klass);
  const loadIrBoost = p._irBoost;
  try {
    const spec = p._modelSpec(p._flightData.get(icao24)?.klass);
    model = await Cesium.Model.fromGltfAsync({
      url: spec.url,
      asynchronous: false,
      minimumPixelSize: p.MODEL_MIN_PX,
      scale: spec.scale,
      color: p._irBoost ? Cesium.Color.WHITE : p._modelColor(icao24),
      colorBlendMode: Cesium.ColorBlendMode.MIX,
      // Launch presentation keeps the code-side tint dominant for every approved
      // model; IR boost removes the remaining diffuse hint with flat UNLIT white.
      colorBlendAmount: p._irBoost ? 1.0 : spec.blendAmount,
      customShader: p._irBoost ? p._IR_UNLIT_SHADER : undefined,
      id: icao24, // so scene.pick returns the icao for click-to-track
    });
  } catch {
    // asset/decode fail — stay billboard. Only touch this lifecycle's state if still current
    // (a destroy/re-init may have swapped the globals while this load was in flight).
    if (epoch === p._modelEpoch) { p._modelPending.delete(icao24); p._cleanupModelGen(icao24); }
    return;
  }
  // A load from a PREVIOUS lifecycle (destroy→init happened mid-load) must NOT mutate the new
  // epoch's p._modelPending/p._modelGen or add to the new collection — just drop its model.
  if (epoch !== p._modelEpoch) { try { model.destroy(); } catch { /* gone */ } return; }
  p._modelPending.delete(icao24);
  // Post-await admission: reject (and DESTROY the loaded model) if anything changed during the
  // load — a release bumped the generation (track/untrack/remove), the layer toggled off / was
  // torn down, the aircraft is gone or now tracked, a model already exists, or the cap filled.
  // Recheck the shared Display 3D toggle and altitude ceiling after the async
  // load. Cockpit uses the same OFF / Proximity / All contract as map Display.
  const stale = (p._modelGen.get(icao24) || 0) !== gen
    || !p._modelRegimeActive() || !p._modelCollection || p._modelCollection.isDestroyed()
    || !p._flightData.has(icao24) || icao24 === p._trackedIcao
    || p._models.has(icao24) || p._models.size >= p._modelCap()
    // Class reclassified mid-load → this GLB/scale is for the OLD class.
    || p._specKeyFor(p._flightData.get(icao24)?.klass) !== specKey
    // IR boost flipped mid-load → this model baked the wrong shader/tint.
    || p._irBoost !== loadIrBoost;
  if (stale) {
    try { model.destroy(); } catch { /* already gone */ }
    p._cleanupModelGen(icao24); // bound the map
    return;
  }
  // Keep the pick identity explicit on the resolved primitive. This also
  // protects injected/custom loaders that do not copy the creation option.
  model.id = icao24;
  model._gevSpecKey = specKey; // class-change sync compares against this
  model._gevIrBoost = loadIrBoost; // boost-flip reload queue compares against this
  // Admitted, not yet the visual. Cesium's default is show=true, which would let
  // an unplaced primitive claim ownership from the billboard for the frames
  // between admission and the next fleet tick (and draw at the identity matrix,
  // i.e. the Earth's centre). The handoff turns it on once it has a matrix.
  model.show = false;
  p._modelCollection.add(model);
  p._models.set(icao24, model);
  p._planeModelLoaded = true; // GLB is cached now — the tracked entity's model can fade in its billboard
}

/**
 * Dead-reckon a fix along its own velocity/track by `dt` seconds, integrating a
 * constant-rate-turn arc when `turnRateDps` is significant (straight line
 * otherwise). Positive `dt` projects FORWARD (after the fix); negative `dt`
 * projects BACKWARD (before the fix) — used for warm-up, estimating where the
 * aircraft was before its first observed fix. ENU frame: east = +X, north = +Y,
 * up = +Z; heading 0 deg = north, 90 deg = east. Sets `_drCourseDeg` to the
 * arc's instantaneous end course on every path.
 * Arc math adapted from skylight (https://github.com/cpaczek/skylight, MIT).
 * @param {{position: Cesium.Cartesian3, velocity: number, track: number}} fix - The feed fix
 *   to project; its own velocity/track win over the INFO fallback.
 * @param {object|null} info - The feed's enrichment record consulted when `fix` lacks
 *   kinematics (field names are layer-specific via the injected accessors).
 * @param {number} dt - Seconds to project; positive forward, negative backward.
 * @param {Cesium.Cartesian3} out - Cartesian to receive the projected position.
 * @param {number} [turnRateDps=0] - Observed turn rate (deg/s); a straight line when ≈0.
 * @returns {Cesium.Cartesian3} `out`, holding the projected world position.
 */
function _extrapolateFix(fix, info, dt, out, turnRateDps = 0) {
  const speed = Number.isFinite(fix.velocity) ? fix.velocity : (p._infoSpeed(info) || 0);
  const heading = Number.isFinite(fix.track) ? fix.track : (p._infoHeading(info) || 0);
  p._drSpeedMps = speed;
  p._drCourseHold = speed < COURSE_HOLD_SPEED_MPS;
  p._drExtrapolating = true;
  if (speed === 0 || dt === 0) {
    p._drCourseDeg = heading;
    return Cesium.Cartesian3.clone(fix.position, out);
  }
  // Constant-rate-turn arc (straight line when turnRateDps ≈ 0) — a plane in a
  // standard-rate turn is ~90° of arc wrong per 30 s if extrapolated straight.
  arcOffsetEnu(speed, heading, turnRateDps, dt, p._scratchArc);
  p._drCourseDeg = p._scratchArc.endCourseDeg;
  Cesium.Cartesian3.fromElements(p._scratchArc.east, p._scratchArc.north, 0, p._scratchOffset);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(fix.position, Cesium.Ellipsoid.WGS84, p._scratchEnu);
  return Cesium.Matrix4.multiplyByPoint(enu, p._scratchOffset, out);
}

/** Switch all current and future ambient contacts between silhouettes and cockpit pips.
 * @param {boolean} active - True to enter Cockpit contact mode, false to restore the
 *   normal silhouette presentation. */
function _setCockpitContactMode(active) {
  const next = active === true;
  if (p._cockpitContactMode === next) return;
  p._cockpitContactMode = next;
  if (next) p._refreshCockpitNearContacts();
  else p._cockpitNearContacts = new Set();
  // The collection stays visible in cockpit. Near AIR contacts retain their
  // aircraft silhouette until a ready model takes over; far contacts are pips.
  // Never destroy on entry: tearing down hundreds of live glTF instances
  // synchronously blocked Chrome's renderer into Page Unresponsive.
  if (p._modelCollection) p._modelCollection.show = true;
  p._trail?.setVisible(!next);
  if (p._trailHeadEntity) p._trailHeadEntity.show = !next;
  for (const [icao24, bb] of p._billboards) p._applyFleetBillboardPresentation(icao24, bb);
  p._lastCamPoseSig = '';
  p._lastFleetTickMs = 0;
}

/** Evaluate the production tracked-billboard handoff colour for focused tests.
 * @returns {Cesium.Color} The color the tracked billboard should carry this frame. */
function _trackedBillboardColorForTest() {
  return p._modelOwnsVisual(p._trackedIcao) ? p.UNMODELED_TRACKED_COLOR : p.MODELED_ICON_COLOR;
}

/** Smoothed world course for the tracked aircraft this frame. Reads the
 *  frame-cached course (set by _trackedDisplayPosition — the follow-camera's
 *  own computation), NEVER re-runs _deadReckon. Safe to call more than once
 *  per frame: the second call sees dt≈0 and the limiter is a no-op.
 *
 *  The smoothed value lives in the SHARED per-icao _displayCourse entry (see
 *  its declaration): on click the limiter continues from whatever nose the
 *  fleet pass was displaying, and on untrack the fleet pass continues from
 *  whatever nose this path last wrote — the tracked and fleet consumers of
 *  the same aircraft can never disagree across the handoff.
 * @returns {number} Smoothed display course (degrees, 0–360), hover-held when the
 *   displayed speed is too low for any course source to be trusted. */
function _trackedDisplayCourse() {
  const info = p._flightData.get(p._trackedIcao);
  const fallback = p._infoHeading(info) || 0;
  const cacheValid = p._drReconcileValid && p._drReconcileIcao === p._trackedIcao && p._cachedDRCourse != null;
  const raw = cacheValid ? p._cachedDRCourse : fallback;
  const nowMs = Date.now();
  const dt = p._trackedCourseMs
    ? Math.min(p.COURSE_SLEW_DT_MAX_SEC, (nowMs - p._trackedCourseMs) / 1000)
    : 0;
  p._trackedCourseMs = nowMs;
  const prev = p._displayCourse.get(p._trackedIcao);
  // Hover hold: at near-zero displayed speed both the chord and the reported
  // track are noise — keep the last stable nose direction instead of chasing.
  if (cacheValid && p._cachedDRHold && prev != null) return prev;
  const cap = courseSlewCapDps(cacheValid ? p._cachedDRSpeedMps : (p._infoSpeed(info) ?? Number.NaN), p.COURSE_MAX_DPS);
  const course = limitCourseStep(prev, raw, cap, dt);
  p._displayCourse.set(p._trackedIcao, course);
  return course;
}

/** Resolve the selected aircraft's actual rendered square extent this frame.
 * @param {string} icao24 - Normalized ICAO 24-bit address of the selected contact.
 * @param {Cesium.Cartesian3} position - World position the contact renders at this frame.
 * @returns {number} Projected on-screen size in pixels, clamped to the model/billboard caps. */
function _trackedFocusSizePx(icao24, position) {
  const camera = p._viewer?.camera;
  const scene = p._viewer?.scene;
  if (!camera?.positionWC || !position || !scene) return 28;
  const rangeM = Cesium.Cartesian3.distance(camera.positionWC, position);
  if (p._modelOwnsVisual(icao24)) {
    const spec = p._modelSpec(p._flightData.get(icao24)?.klass);
    const scale = trackedModelScaleForPixelCap({
      baseScale: spec.scale,
      nativeRadiusM: spec.nativeRadiusM,
      rangeM,
      viewportHeightPx: scene.canvas.clientHeight,
      fovyRad: camera.frustum.fovy,
      maximumPixelSize: p.TRACKED_MODEL_MAX_PX,
    });
    const focalLengthPx = scene.canvas.clientHeight / (2 * Math.tan(camera.frustum.fovy / 2));
    const projectedDiameterPx = (2 * spec.nativeRadiusM * scale * focalLengthPx) / rangeM;
    return Math.max(p.TRACKED_MODEL_MIN_PX, Math.min(p.TRACKED_MODEL_MAX_PX, projectedDiameterPx));
  }

  const billboard = p._trackedEntity?.billboard;
  const time = p._viewer.clock.currentTime;
  const width = billboard?.width?.getValue(time) ?? 28;
  const height = billboard?.height?.getValue(time) ?? 28;
  const scale = billboard?.scale?.getValue(time)
    ?? (p.TRACKED_FOCUS_SCALE_BASE * (CLASS_SCALE_2D[p._flightData.get(icao24)?.klass] || 1));
  const scaleByDistance = billboard?.scaleByDistance?.getValue(time)
    ?? p.TRACKED_BILLBOARD_SCALE_BY_DISTANCE;
  const distanceScale = nearFarScalarValueAtDistance(scaleByDistance, rangeM);
  return Math.max(width, height) * scale * distanceScale;
}

/**
 * The TRACKED aircraft's own model regime — DEFAULT-ON, camera-distance driven
 * (product invariant 2026-08-19). Unlike the fleet, this does NOT consult the
 * DISPLAY-rail `models3d` toggle: the selected contact is a single model, it is
 * what the camera is pointed at, and zooming in on a target should resolve it
 * into an aircraft without the operator arming anything. The toggle keeps
 * owning the FLEET (`_modelRegimeActive`), which is the draw-call budget.
 *
 * Thresholds + hysteresis live in trackedModelRegime.js: enter at
 * TRACKED_MODEL_ENTER_ALT_M (150_000 m — the playtested swap distance,
 * deliberately NEARER than the fleet's 800 km ceiling this used to inherit),
 * hand back only above TRACKED_MODEL_EXIT_ALT_M, so orbiting AT the boundary
 * cannot flap billboard↔model. See that module's header for why the tracked
 * contact now goes 3D closer in than the fleet does.
 *
 * In cockpit you are sitting 7 m behind and 2.6 m above your own aircraft's
 * origin, so its ~26 m airframe would fill the visor. First-person means your
 * own airframe is not drawn.
 * @returns {boolean} True when the selected contact should resolve into a 3D model.
 */
function _trackedModelRegimeActive() {
  if (p._trackedZoomLatchIcao !== p._trackedIcao) {
    p._trackedZoomLatchIcao = p._trackedIcao;
    p._trackedZoomLatched = false;
  }
  // A converted TR-3B has no 3D asset — suppressing the regime keeps its
  // tracked billboard fully opaque (the colour callback reads this too), so
  // the triangle stays the visual all the way in.
  if (!p._trackedIcao || p._cockpitContactMode || isTr3b(p._trackedIcao)) {
    p._trackedZoomLatched = false;
    return false;
  }
  p._trackedZoomLatched = trackedModelZoomActive(
    p._viewer?.camera?.positionCartographic?.height,
    p._trackedZoomLatched,
  );
  return p._trackedZoomLatched;
}

/** Write the explicit tracked presentation model and refresh its host entry.
 * @param {string} icao24 - Normalized ICAO 24-bit address of the tracked contact; a
 *   mismatch with the live selection is a stale call and is ignored. */
function _updateTrackedLabelModel(icao24) {
  if (!p._trackedEntity || icao24 !== p._trackedIcao) return;
  p._trackedEntity.gevLabelModel = trackedLabelModelFromText(
    p._trackedLabelText(icao24),
    p.TRACKED_LABEL_ACCENT,
  );
  refreshTrackedReadout(p._trackedEntity);
  // The readout and the context slot describe the same contact — refresh them
  // together so voice never narrates a fix the card has already replaced.
  refreshTrackedSubjectContext(p._contextSubjectMetadata(icao24));
}

  Object.assign(p, {
    _abortActiveUpdates,
    _applyCockpitState,
    _applyPendingTrackingRestore,
    _cancelPendingTrackingRestore,
    _cleanupModelGen,
    _clearTrail,
    _cockpitBillboardScaleByDistance,
    _destroyTrail,
    _drainIrReloadQueue,
    _driveFleetModelHandoffForTest,
    _emitAwarenessEvent,
    _ensureFleetModelForTest,
    _groundDepthDistance,
    _groundSampleExclusions,
    _isExplicitTrackingOrigin,
    _isTrackWarmingUp,
    _modelAddDistM,
    _modelDisplayPosition,
    _modelIsRendering,
    _modelKeepDistM,
    _modelOwnsVisual,
    _modelRegimeActive,
    _normalizeTrackedIcao,
    _onKeyDown,
    _refreshCockpitNearContacts,
    _refreshTr3bForStyle,
    _releaseModel,
    _releaseModels,
    _releaseTrackedModel,
    _reloadModelsForIrBoost,
    _resetTrackedDisplay,
    _resetTrackedSelectionState,
    _setCockpitDetectionSubjectForTest,
    _syncModelToClass,
    _syncTracked2dRotation,
    _syncTrackedBillboardImage,
    _toCleanText,
    _trackedDisplayCached,
    _trackedModelCenterWorld,
    _trackedModelEnvelopeM,
    _trackedModelLoadAllowed,
    _trackedModelRegimeActiveForTest,
    _trackedTrailCached,
    _trackedVisualCached,
    _updateTrackedModelForTest,
    _appendTrailFix,
    _applyFleetBillboardPresentation,
    _driveFleetModelHandoff,
    _ensureModel,
    _extrapolateFix,
    _setCockpitContactMode,
    _trackedBillboardColorForTest,
    _trackedDisplayCourse,
    _trackedFocusSizePx,
    _trackedModelRegimeActive,
    _updateTrackedLabelModel,
  });

  return p;
}
