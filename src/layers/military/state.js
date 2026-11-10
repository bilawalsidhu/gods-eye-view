import { MilitaryFlightRecords } from './records.js';
import { createMilitaryFeed } from './ingestion.js';
import * as geo from '../../geo/index.js';
import { worldTimeFor } from '../../time/worldClock.js';

export function createFlightState({ source, services }) {
  const { createGroundSnap } = services.groundSnap;
  const flightState = { lifetime: new AbortController(), enabled: false };
  flightState.feed = createMilitaryFeed(source);
  flightState.records = new MilitaryFlightRecords({
    ...services.geoid,
    ...services.groundFloor,
  });
  flightState._cullPositions = new Map();
  /** The time contacts are drawn behind by the render delay, in epoch ms. */
  flightState.now = worldTimeFor('military');

  /** Per-class model spec for THIS layer (2026-08-16, owner playtest ask:
   *  military contacts should read as their WEIGHT CLASS, always in this layer's
   *  amber). Real Hangar GLBs serve the classes they cover (meters, nose −X →
   *  180° offset); airliner/quadjet/glider get the shared 747 silhouette
   *  (airplane.glb — C-5M/RC-135-style heavies stop rendering as bizjets);
   *  fastjet and unknown keep jet.glb with the same 180° offset. The MIX tint stays
   *  dominant everywhere — military is amber, tracked is TRACKED_ICON_COLOR,
   *  and the tint must dominate any livery (owner: "stays yellow"). Specs are
   *  static per class — memoized (the fleet pass asks at 12 Hz per model). */

  flightState._specCache = new Map();

  /** One-shot cached tile-skin heights for MODELED grounded planes (see groundSnap.js). */

  flightState._groundSnap = createGroundSnap();

  flightState._scratchGroundCarto = geo.cartographic.create();

  flightState._scratchGroundPos = geo.cartesian3.create();

  /** @type {import('../aircraft/render/contract.js').AircraftRenderer|null}
   *  The engine's aircraft renderer for this lifecycle (render/display.js,
   *  on every engine): the fleet sprites, the models, the tracked visual,
   *  the trail, the follow camera and the view reads. */

  flightState._renderer = null;

  /** @type {Map<string, object>} icao24 → model handle */

  flightState._models = new Map();

  /** @type {Set<string>} icao24 currently loading (async) */

  flightState._modelPending = new Set();

  /** @type {Map<string, number>} icao24 → load generation; bumped on release to invalidate
   *  an in-flight load (so a track/untrack/remove during fromGltfAsync can't add a stale model). */

  flightState._modelGen = new Map();

  /** Lifecycle epoch; bumped on destroy so an in-flight load from a PREVIOUS init can't settle
   *  against a new lifecycle's globals (which destroy cleared). Captured by _ensureModel. */

  flightState._modelEpoch = 0;

  /** DEFAULT-ON in PROXIMITY (owner directive 2026-08-22). A fresh boot never runs
   *  layer-state restoration, so this initializer — not the codec — is what the app
   *  actually starts with; it must stay in lockstep with the `models3d` default in
   *  `layerState.js` and `this._models3dEnabled` in ui.js, or the DISPLAY rail would
   *  light a button the layer has not armed. */

  flightState._models3dEnabled = true;

  flightState._models3dMode = 'proximity';
  // 'proximity' = nearest MODEL_MAX in view; 'all' = every in-view plane (≤ MODEL_MAX_ALL)

  flightState._lastModelCapWarnMs = 0;
  // throttle the "more planes in view than the cap" console notice
  /** Last limb taper per billboard, retained across class/ground/cockpit repaints. */

  flightState._billboardLimbScale = new WeakMap();

  // ---------------------------------------------------------------------------
  // Module-level state
  // ---------------------------------------------------------------------------

  /** @type {Map<string, object>} ICAO hex -> fleet sprite handle (the
   *  renderer's single GPU-batched fleet) */

  flightState._billboards = new Map();

  /** Stable lightweight records reused by the detection overlay between polls. */

  flightState._detectionObjects = new Map();

  /** @type {Map<string, Array<{timeMs: number, epochMs: number, position: object}>>} ICAO hex -> recent position samples for dead reckoning (timeMs: whole ms since the epoch, the app clock's unit) */

  flightState._positionHistory = new Map();

  // -- Click-to-track state --
  /** @type {string|null} ICAO hex of the currently tracked aircraft */

  flightState._trackedIcao = null;

  flightState._pendingTrackingRestore = null;

  flightState._trackingIntentGeneration = 0;

  /** @type {object|null} The renderer's tracked handle (the follow target) */

  flightState._trackedEntity = null;

  /** @type {object|null} Standalone 3D model for the tracked aircraft — NOT a graphic on
   *  _trackedEntity, so viewer.trackedEntity's follow-camera always has a ready bounding sphere
   *  (a model graphic reports PENDING until loaded, which freezes the centering on 3D-toggle). */

  flightState._trackedModel = null;

  flightState._trackedModelGen = 0;

  flightState._trackedModelLoading = false;

  /** @type {(() => void)|null} Unregisters this layer from the engine's
   *  selection dispatcher (clicks and Escape). */

  flightState._selectionRemove = null;

  /** Cockpit presentation switches ambient AIR contacts between near aircraft and far dots. */

  flightState._cockpitContactMode = false;

  /** AIR contacts inside the selected Display range; independent from model admission/load/cap. */

  flightState._cockpitNearContacts = new Set();

  /** Normalized ICAO24 of the active Cockpit subject, omitted from detection candidates. */

  flightState._cockpitSubjectId = null;

  /** @type {((event: CustomEvent) => void)|null} */

  flightState._cockpitModeListener = null;

  /** @type {{setPositions: Function, clear: Function, destroy: Function}|null} Shared fading-trail renderer */

  flightState._trail = null;

  /** @type {object|null} Per-frame head segment: last body point → live icon */

  flightState._trailHeadEntity = null;

  /** @type {number} Uniquifier for head-segment entity ids (Cesium requires unique ids). */

  flightState._trailHeadSeq = 0;

  /** @type {object[]} Chronological tracked-aircraft fixes (oldest first) */

  flightState._trailPositions = [];

  /** @type {number} Monotonic token — invalidates in-flight backfill responses */

  flightState._trailBackfillToken = 0;

  /** @type {number} Epoch ms of the last fleet dead-reckoning pass */

  flightState._lastFleetTickMs = 0;

  /** @type {string} Camera pose signature at the last rotation pass */

  flightState._lastCamPoseSig = '';

  /** @type {number} Epoch ms of the last full rotation pass */

  flightState._lastRotPassMs = 0;

  /** @type {number} Last computed rotation for the tracked entity (radians) */

  flightState._lastTrackedRotation = 0;

  /** @type {(() => void)|null} preRender listener disposer */

  flightState._preRenderRemove = null;

  flightState._trackedModelPreUpdateRemove = null;

  /** @type {(() => void)|null} camera.moveEnd listener disposer (arrival rotation pass) */

  flightState._moveEndRemove = null;

  /** @type {(() => void)|null} follow-change listener disposer (cross-layer untrack) */

  flightState._trackedEntityChangedRemove = null;

  // -- Scratch variables (reused each frame to avoid GC pressure) --

  flightState._scratchOffset = geo.cartesian3.create();

  flightState._scratchCarto = geo.cartographic.create();

  flightState._scratchEnu = geo.matrix4.create();

  flightState._scratchArc = { east: 0, north: 0, endCourseDeg: 0 };

  flightState._scratchFleetPos = geo.cartesian3.create();

  flightState._scratchSonarScreen = geo.cartesian2.create();

  flightState._scratchDrRaw = geo.cartesian3.create();

  flightState._trackedPosHolder = geo.cartesian3.create();

  // -- Per-frame dead-reckoning cache for the tracked entity --
  /** @type {object|null} Cached DR position for the current render frame */

  flightState._cachedDRPosition = null;

  /** @type {number} Frame number the cache was last populated for */

  flightState._cachedDRFrame = -1;

  /** Course (deg) of the position `_deadReckon` most recently returned — set on
   *  every branch of `_deadReckon`, read IMMEDIATELY by the caller (same
   *  synchronous flow; module-scratch idiom, like the Cartesian scratches). */

  flightState._drCourseDeg = null;

  /** Sibling scratches of _drCourseDeg: the displayed ground speed of the motion
   *  `_deadReckon` just returned, and whether that motion is too slow for ANY
   *  course source to be trusted (hover/GPS drift — consumers HOLD their
   *  previous display course instead of chasing noise). */

  flightState._drSpeedMps = null;

  flightState._drCourseHold = false;

  /** Frame-cached course for the tracked aircraft (sibling of _cachedDRPosition). */

  flightState._cachedDRCourse = null;

  /** Frame-cached siblings of _cachedDRCourse (same discipline). */

  flightState._cachedDRSpeedMps = null;

  flightState._cachedDRHold = false;

  /** Wall-clock of the tracked course limiter's last advance (dt source only —
   *  the course VALUE lives in the shared per-icao _displayCourse map below). */

  flightState._trackedCourseMs = 0;

  /** Per-aircraft smoothed display course — the SINGLE source of truth for the
   *  nose direction an aircraft displays (mirror of flights.js, 2026-07-03
   *  field fix). The fleet pass reads/writes it at tick cadence for untracked
   *  planes; _trackedDisplayCourse reads/writes the SAME entry per frame for
   *  the tracked plane (the fleet pass skips the tracked icao, so exactly one
   *  writer owns an entry at a time). Sharing the entry — including its slew
   *  state — keeps the tracked↔fleet handoff seamless (separate states froze
   *  the fleet entry while tracked → nose flip on click / click-away). */

  flightState._displayCourse = new Map();

  flightState._drCorrection = geo.cartesian3.create(0, 0, 0);

  flightState._drCorrectionStartMs = 0;

  flightState._drPrevRaw = geo.cartesian3.create();

  flightState._drPrevDisplay = geo.cartesian3.create();

  flightState._drPrevMs = 0;

  flightState._drReconcileValid = false;

  /** @type {string|null} icao the reconciliation state currently belongs to */

  flightState._drReconcileIcao = null;

  /** @type {object} Scratch for the tracked model's rendered translation. */

  flightState._trackedVisualPos = geo.cartesian3.create();

  flightState._trackedTrailPos = geo.cartesian3.create();

  /** Scratch for the tracked model's world-space origin (the envelope centre). */

  flightState._scratchTrailClip = geo.cartesian3.create();

  /** Scratch for the shortened trail-head start. Owned by the head-segment
   *  callback alone, so nothing else can overwrite it mid-frame. */

  flightState._scratchTrailHead = geo.cartesian3.create();

  /** Hysteresis latch for the tracked contact's zoom regime, plus the selection it
   *  belongs to. Scoped per selection so a NEW target re-evaluates against the ENTER
   *  ceiling instead of inheriting the previous target's looser EXIT band. */

  flightState._trackedZoomLatched = false;

  flightState._trackedZoomLatchIcao = null;

  flightState._trackedModelFailIcao = null;

  flightState._trackedModelFailCount = 0;

  flightState._trackedModelRetryAtMs = 0;

  /** IR hot-target mode — mirror of flights.js: under the luminance-mapped
   *  NVG/FLIR post-styles every model renders flat white (hottest) and UNLIT
   *  (`unlit` in the model spec: material-stage tint still sun-shades, so
   *  side-on planes read near-black under a high sun); the dominant
   *  amber/tracked tint restores on style exit. The shader is baked at
   *  creation (assigning it to a ready Cesium model is a silent no-op), so the
   *  boost flips by release-and-reload. */

  flightState._irBoost = false;

  flightState._irReloadQueue = null;

  /** @type {object} Scratch (Cartographic) for _trailFloorPosition (per-frame safe). */

  flightState._scratchTrailCarto = geo.cartographic.create();
  return flightState;
}
