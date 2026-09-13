import * as Cesium from 'cesium';
import { ENRICH_AMBIENT_BUDGET_CEIL } from './policy.js';

export function createFlightState({ source, services }) {
  const { createGroundSnap } = services.groundSnap;
  const flightState = { lifetime: new AbortController() };

  flightState._source = source;

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
  // keep last N positions per aircraft

  // ---------------------------------------------------------------------------
  // Module-level state: billboard collection and per-aircraft lookup maps
  // ---------------------------------------------------------------------------

  /** @type {Cesium.BillboardCollection|null} */

  flightState._billboardCollection = null;

  /** @type {Map<string, Cesium.Billboard>} icao24 -> billboard primitive */

  flightState._billboards = new Map();

  /** Stable lightweight records reused by the detection overlay between polls. */

  flightState._detectionObjects = new Map();

  /** @type {Map<string, {callsign:string, altitude:number, velocity:number, true_track:number}>} */

  flightState._flightData = new Map();

  /** DEV-only explicit-position contacts used by qa-focus-evidence.mjs. */

  flightState._focusEvidenceIds = new Set();

  /** @type {Map<string, Array<{time:Cesium.JulianDate, position:Cesium.Cartesian3}>>} */

  flightState._positionHistory = new Map();

  /** @type {boolean} True once ensureGeoidReady() has resolved (awaited once at enable()) */

  flightState._geoidReady = false;

  /** @type {Map<string, number>} icao24 -> geoid undulation N (m), cached (negligible drift per-aircraft). */

  flightState._geoidNCache = new Map();

  /** @type {number} Current number of visible aircraft */

  flightState._count = 0;

  /** @type {number|null} Epoch ms of last successful API update */

  flightState._lastUpdate = null;

  /** @type {boolean} True while in a backoff/cooldown window */

  flightState._backoff = false;

  /** @type {number} Epoch ms — earliest time the next fetch is allowed */

  flightState._retryAt = 0;

  /** @type {string|null} Human-readable error string shown in stats chip */

  flightState._lastError = null;

  flightState._activeUpdateControllers = new Set();

  /** @type {number|null} HTTP status of the most recent API response */

  flightState._lastStatus = null;

  /** @type {string} Source used by the latest successful snapshot. */

  flightState._lastSource = source?.label || 'Aircraft';

  /** @type {string} Completeness boundary for the latest successful snapshot. */

  flightState._lastCoverage = 'worldwide upstream snapshot';

  // ---------------------------------------------------------------------------
  // Click-to-track state
  // ---------------------------------------------------------------------------

  /** @type {string|null} ICAO24 of the currently tracked aircraft */

  flightState._trackedIcao = null;

  flightState._pendingTrackingRestore = null;

  flightState._trackingIntentGeneration = 0;

  flightState._trackingRefreshEpoch = 0;

  flightState._lastTrackingRefreshOutcome = {
    epoch: 0,
    status: 'unavailable',
    ids: new Set(),
    source: flightState._lastSource,
    coverage: null,
  };

  /** @type {Cesium.Entity|null} Entity used for camera tracking */

  flightState._trackedEntity = null;

  /** Disposes the single active tracked-camera framing owner. */

  flightState._trackedCameraFrameStop = null;

  /** @type {Cesium.Model|null} Standalone 3D model for the tracked aircraft. Deliberately NOT a
   *  graphic on _trackedEntity: viewer.trackedEntity derives the follow-camera from the entity's
   *  bounding sphere, and a model graphic reports PENDING until its glTF loads — which stalls (or, on
   *  3D-toggle, freezes) the centering. A pure-billboard entity always supplies a ready sphere; the
   *  model rides in _modelCollection and is driven per-frame, fully decoupled from the camera. */

  flightState._trackedModel = null;

  /** Bumped on untrack/teardown so an in-flight tracked-model load resolves into a no-op. */

  flightState._trackedModelGen = 0;

  flightState._trackedModelLoading = false;

  /** @type {Cesium.ScreenSpaceEventHandler|null} Click handler on the scene canvas */

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

  /** @type {Cesium.Entity|null} Cheap 2-point head segment bridging the last fix to the LIVE
   *  dead-reckoned icon, updated per frame via a CallbackProperty — so the trail head stays
   *  glued to the 12 Hz icon without rebuilding the 400-point trail primitive every frame. */

  flightState._trailHeadEntity = null;

  /** @type {number} Uniquifier for head-segment entity ids (Cesium requires unique ids). */

  flightState._trailHeadSeq = 0;

  /** @type {Cesium.Cartesian3[]} Chronological tracked-aircraft fixes (oldest first) */

  flightState._trailPositions = [];

  /** @type {number} Monotonic token — invalidates in-flight backfill responses */

  flightState._trailBackfillToken = 0;

  /** @type {Map<string, number>} icao24 -> consecutive missed polls */

  flightState._missingPolls = new Map();

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

  /** @type {(() => void)|null} militaryRegistry active-transition unsubscribe (M2 handoff sweep) */

  flightState._milActiveChangeUnsub = null;

  // ---------------------------------------------------------------------------
  // Scratch (reusable) variables — avoid per-frame heap allocation
  // ---------------------------------------------------------------------------

  flightState._scratchOffset = new Cesium.Cartesian3();

  flightState._scratchCarto = new Cesium.Cartographic();

  flightState._scratchEnu = new Cesium.Matrix4();

  flightState._scratchArc = { east: 0, north: 0, endCourseDeg: 0 };

  flightState._scratchRenderTime = new Cesium.JulianDate();

  flightState._scratchFleetPos = new Cesium.Cartesian3();

  flightState._scratchDrRaw = new Cesium.Cartesian3();

  flightState._scratchWarmupTime = new Cesium.JulianDate();

  flightState._trackedPosHolder = new Cesium.Cartesian3();

  // ---------------------------------------------------------------------------
  // Per-frame cache for the tracked entity's dead-reckoned position.
  // The position, alignedAxis, and rotation CallbackProperties all fire each
  // render frame; caching avoids running _deadReckon three times.
  // ---------------------------------------------------------------------------

  /** @type {Cesium.Cartesian3|null} */

  flightState._cachedDRPosition = null;

  /** @type {number} Frame number for which _cachedDRPosition is valid */

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

  /** Sibling scratch: whether the position `_deadReckon` just returned came from
   *  EXTRAPOLATION (coasting past the newest fix, or the pre-history warm-up)
   *  rather than interpolation between two known fixes. The display-floor
   *  corridor needs it — an interpolating contact is walking TOWARD its newest
   *  fix, a coasting one is walking AWAY from it along its course, and warming
   *  the wrong end leaves a coaster permanently ahead of its floor data. */

  flightState._drExtrapolating = false;

  /** Frame-cached course for the tracked aircraft (sibling of _cachedDRPosition). */

  flightState._cachedDRCourse = null;

  /** Frame-cached siblings of _cachedDRCourse (same discipline). */

  flightState._cachedDRSpeedMps = null;

  flightState._cachedDRHold = false;

  /** Wall-clock of the tracked course limiter's last advance (dt source only —
   *  the course VALUE lives in the shared per-icao _displayCourse map below). */

  flightState._trackedCourseMs = 0;

  /** Per-aircraft smoothed display course — the SINGLE source of truth for the
   *  nose direction an aircraft displays. The fleet pass reads/writes it at
   *  tick cadence for untracked planes; _trackedDisplayCourse reads/writes the
   *  SAME entry per frame for the tracked plane (the fleet pass skips the
   *  tracked icao, so exactly one writer owns an entry at a time). Sharing the
   *  entry — including its slew state — is what makes the tracked↔fleet
   *  handoff seamless (2026-07-03 field fix: separate states froze the fleet
   *  entry while tracked, so clicking / un-clicking a 65 kt helicopter FLIPPED
   *  its nose — "looks like it's going in reverse"). */

  flightState._displayCourse = new Map();

  flightState._enrichActive = 0;

  flightState._enrichLastDispatchMs = 0;

  /** @type {ReturnType<typeof setTimeout>|null} pending drip wake-up */

  flightState._enrichDripTimer = null;

  flightState._enrichQueue = [];

  flightState._enrichSeen = new Set();

  flightState._enrichAmbientBudget = ENRICH_AMBIENT_BUDGET_CEIL;

  /** Epoch ms the bucket last accounted a refill window from (0 = unset). */

  flightState._enrichAmbientRefillAnchorMs = 0;

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

  /** @type {Cesium.Cartographic} Scratch for the grounded display-floor read. */

  flightState._scratchDisplayCarto = new Cesium.Cartographic();

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

  flightState._displayFloorState = new Map();

  /** @type {number} Poll counter handed to the corridor allocator: it rotates
   *  runs of EQUALLY needy contacts so a tie larger than the budget cycles across
   *  polls instead of the same prefix winning forever. */

  flightState._corridorEpoch = 0;

  /** @type {Cesium.Cartographic} Scratch for the corridor's display-end read. */

  flightState._scratchCorridorCarto = new Cesium.Cartographic();

  /** @type {Cesium.Cartesian3} Scratch for the corridor's dead-reckon probe. */

  flightState._scratchCorridorPos = new Cesium.Cartesian3();

  /** IR hot-target mode (owner playtest 2026-08-16): the NVG/FLIR post-styles
   *  map LUMINANCE, so mid-gray textured models read cold and vanish into
   *  terrain. While a boost style is active every model renders flat white
   *  (hottest); per-spec color/tint restores on style exit. Driven by ui.js
   *  setStyle via the `irBoost` layer param. */

  flightState._irBoost = false;

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

  flightState._IR_UNLIT_SHADER = new Cesium.CustomShader({
    lightingModel: Cesium.LightingModel.UNLIT,
  });

  flightState._irReloadQueue = null;
  return flightState;
}
