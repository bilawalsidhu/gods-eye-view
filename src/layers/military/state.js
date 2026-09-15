import { MilitaryFlightRecords } from './records.js';
import { createMilitaryFeed } from './ingestion.js';
import * as Cesium from 'cesium';

export function createFlightState({ source, services }) {
  const { createGroundSnap } = services.groundSnap;
  const flightState = { lifetime: new AbortController() };
  flightState.feed = createMilitaryFeed(source);
  flightState.records = new MilitaryFlightRecords({
    ...services.geoid,
    ...services.groundFloor,
  });
  flightState._cullPositions = new Map();

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

  flightState._scratchGroundCarto = new Cesium.Cartographic();

  flightState._scratchGroundPos = new Cesium.Cartesian3();

  /** @type {Cesium.PrimitiveCollection|null} */

  flightState._modelCollection = null;

  /** @type {Map<string, Cesium.Model>} icao24 → model */

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
  // The tracked entity's billboard goes transparent (rather than hidden) once the model takes
  // over, so it keeps supplying a bounding sphere for follow-camera framing. We only drop its
  // alpha after the GLB is preloaded so the model is ready to render the instant the billboard
  // fades — no gap, no double-image. Preloaded once at init; the instance is retained (not
  // destroyed) purely to keep Cesium's glTF cache warm for fast tracked-model instantiation.

  flightState._planeModelLoaded = false;

  /** @type {Cesium.Model|null} retained preload that keeps the glTF cache warm */

  flightState._preloadModel = null;

  flightState._scratchModelHpr = new Cesium.HeadingPitchRoll(0, 0, 0);

  flightState._scratchModelMtx = new Cesium.Matrix4();

  flightState._scratchModelBS = new Cesium.BoundingSphere(
    new Cesium.Cartesian3(),
    1.0,
  );
  // frustum-visibility test
  /** Last limb taper per billboard, retained across class/ground/cockpit repaints. */

  flightState._billboardLimbScale = new WeakMap();

  // ---------------------------------------------------------------------------
  // Module-level state
  // ---------------------------------------------------------------------------

  /** @type {Cesium.BillboardCollection|null} Single GPU-batched collection for all aircraft */

  flightState._billboardCollection = null;

  /** @type {Map<string, Cesium.Billboard>} ICAO hex -> billboard primitive */

  flightState._billboards = new Map();

  /** Stable lightweight records reused by the detection overlay between polls. */

  flightState._detectionObjects = new Map();

  /** @type {Map<string, Array<{time: Cesium.JulianDate, position: Cesium.Cartesian3}>>} ICAO hex -> recent position samples for dead reckoning */

  flightState._positionHistory = new Map();

  // -- Click-to-track state --
  /** @type {string|null} ICAO hex of the currently tracked aircraft */

  flightState._trackedIcao = null;

  flightState._pendingTrackingRestore = null;

  flightState._trackingIntentGeneration = 0;

  /** @type {Cesium.Entity|null} Entity created for the tracked aircraft (camera follows this) */

  flightState._trackedEntity = null;

  /** Disposes the single active tracked-camera framing owner. */

  flightState._trackedCameraFrameStop = null;

  /** @type {Cesium.Model|null} Standalone 3D model for the tracked aircraft — NOT a graphic on
   *  _trackedEntity, so viewer.trackedEntity's follow-camera always has a ready bounding sphere
   *  (a model graphic reports PENDING until loaded, which freezes the centering on 3D-toggle). */

  flightState._trackedModel = null;

  flightState._trackedModelGen = 0;

  flightState._trackedModelLoading = false;

  /** @type {Cesium.ScreenSpaceEventHandler|null} Click handler for selecting aircraft */

  flightState._clickHandler = null;

  /** @type {Cesium.Viewer|null} Cached viewer reference */

  flightState._viewer = null;

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

  /** @type {Cesium.Entity|null} Per-frame head segment: last body point → live icon */

  flightState._trailHeadEntity = null;

  /** @type {number} Uniquifier for head-segment entity ids (Cesium requires unique ids). */

  flightState._trailHeadSeq = 0;

  /** @type {Cesium.Cartesian3[]} Chronological tracked-aircraft fixes (oldest first) */

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

  /** @type {Cesium.Event.RemoveCallback|null} preRender listener disposer */

  flightState._preRenderRemove = null;

  flightState._trackedModelPreUpdateRemove = null;

  /** @type {Cesium.Event.RemoveCallback|null} camera.moveEnd listener disposer (arrival rotation pass) */

  flightState._moveEndRemove = null;

  /** @type {Cesium.Event.RemoveCallback|null} trackedEntityChanged listener disposer (cross-layer untrack) */

  flightState._trackedEntityChangedRemove = null;

  // -- Scratch variables (reused each frame to avoid GC pressure) --

  flightState._scratchOffset = new Cesium.Cartesian3();

  flightState._scratchCarto = new Cesium.Cartographic();

  flightState._scratchEnu = new Cesium.Matrix4();

  flightState._scratchArc = { east: 0, north: 0, endCourseDeg: 0 };

  flightState._scratchRenderTime = new Cesium.JulianDate();

  flightState._scratchFleetPos = new Cesium.Cartesian3();

  flightState._scratchDrRaw = new Cesium.Cartesian3();

  flightState._scratchWarmupTime = new Cesium.JulianDate();

  flightState._trackedPosHolder = new Cesium.Cartesian3();

  // -- Per-frame dead-reckoning cache for the tracked entity --
  /** @type {Cesium.Cartesian3|null} Cached DR position for the current render frame */

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

  flightState._drCorrection = new Cesium.Cartesian3(0, 0, 0);

  flightState._drCorrectionStartMs = 0;

  flightState._drPrevRaw = new Cesium.Cartesian3();

  flightState._drPrevDisplay = new Cesium.Cartesian3();

  flightState._drPrevMs = 0;

  flightState._drReconcileValid = false;

  /** @type {string|null} icao the reconciliation state currently belongs to */

  flightState._drReconcileIcao = null;

  /** @type {Cesium.Cartesian3} Scratch for the tracked model's rendered translation. */

  flightState._trackedVisualPos = new Cesium.Cartesian3();

  flightState._trackedTrailPos = new Cesium.Cartesian3();

  /** Scratch for the tracked model's world-space origin (the envelope centre). */

  flightState._scratchTrailClip = new Cesium.Cartesian3();

  /** Scratch for the shortened trail-head start. Owned by the head-segment
   *  callback alone, so nothing else can overwrite it mid-frame. */

  flightState._scratchTrailHead = new Cesium.Cartesian3();

  /** Hysteresis latch for the tracked contact's zoom regime, plus the selection it
   *  belongs to. Scoped per selection so a NEW target re-evaluates against the ENTER
   *  ceiling instead of inheriting the previous target's looser EXIT band. */

  flightState._trackedZoomLatched = false;

  flightState._trackedZoomLatchIcao = null;

  flightState._trackedModelFailIcao = null;

  flightState._trackedModelFailCount = 0;

  flightState._trackedModelRetryAtMs = 0;

  /** IR hot-target mode — mirror of flights.js: under the luminance-mapped
   *  NVG/FLIR post-styles every model renders flat white (hottest); the dominant
   *  amber/tracked tint restores on style exit. */

  flightState._irBoost = false;

  /** Boosted models render UNLIT — mirror of flights.js (owner cockpit-FLIR
   *  field rounds): material-stage tint still sun-shades, so side-on planes
   *  read near-black under a high sun; UNLIT emits flat white regardless.
   *  customShader on a READY model is a silent no-op (field-verified), so the
   *  boost flips by release-and-reload — creation-time options carry it. */

  flightState._IR_UNLIT_SHADER = new Cesium.CustomShader({
    lightingModel: Cesium.LightingModel.UNLIT,
  });

  flightState._irReloadQueue = null;

  /** @type {Cesium.Cartographic} Scratch for _trailFloorPosition (per-frame safe). */

  flightState._scratchTrailCarto = new Cesium.Cartographic();
  return flightState;
}
