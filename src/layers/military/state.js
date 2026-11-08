import { MilitaryFlightRecords } from './records.js';
import { createMilitaryFeed } from './ingestion.js';

export function createFlightState({ source, services }) {
  const { createGroundSnap } = services.groundSnap;
  const flightState = { lifetime: new AbortController() };
  flightState.feed = createMilitaryFeed(source);
  flightState.records = new MilitaryFlightRecords({
    ...services.geoid,
    ...services.groundFloor,
  });

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

  /** The fleet and tracked model draw sets of this layer lifetime
   *  (`_createModelSets`), or null. */

  flightState._modelSets = null;

  /** @type {Map<string, import('../../data/modelRecord.js').ModelRecord>}
   *  icao24 → the fleet model admitted for it (loading or drawn). */

  flightState._models = new Map();

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

  // ---------------------------------------------------------------------------
  // Module-level state
  // ---------------------------------------------------------------------------

  /** Every contact's icon item as drawn (`createContactIcons`, see icons.js);
   *  null outside a layer lifetime. */

  flightState._icons = null;

  /** Rows still away from full focus emphasis after the last focus pass. */

  flightState._iconFocusActive = 0;

  /** Stable lightweight records reused by the detection overlay between polls. */

  flightState._detectionObjects = new Map();

  /** @type {Map<string, Array<{time: object, position: {x: number, y: number, z: number}}>>} ICAO hex -> recent position samples for dead reckoning */

  flightState._positionHistory = new Map();

  // -- Click-to-track state --
  /** @type {string|null} ICAO hex of the currently tracked aircraft */

  flightState._trackedIcao = null;

  flightState._pendingTrackingRestore = null;

  flightState._trackingIntentGeneration = 0;

  /** @type {object|null} The tracked aircraft's record holder (its entity record is what the app shows; the camera follows a target reading it) */

  flightState._trackedEntity = null;

  /** The FollowTarget the camera follows the tracked aircraft with. */
  flightState._followTarget = null;

  /** @type {import('../../data/modelRecord.js').ModelRecord|null} Standalone 3D model for the tracked aircraft — NOT a graphic on
   *  _trackedEntity, which stays a plain, always-ready billboard (a model graphic reports PENDING
   *  until loaded); the camera follows its own target. */

  flightState._trackedModel = null;

  /** @type {(() => void)|null} Unsubscribes the aircraft-selection click. */

  flightState._clickSubscription = null;

  /** @type {object|null} Cached viewer reference */

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

  /** @type {(() => void)|null} Stops the per-frame live head (last body point → live
   *  icon), drawn as the trail's head line so the head stays glued to the 12 Hz icon
   *  without rebuilding the 400-point trail body every frame. */

  flightState._trailHeadOff = null;

  /** @type {{x: number, y: number, z: number}[]} Chronological tracked-aircraft fixes (oldest first) */

  flightState._trailPositions = [];

  /** @type {number} Monotonic token — invalidates in-flight backfill responses */

  flightState._trailBackfillToken = 0;

  /** @type {number} Epoch ms of the last fleet dead-reckoning pass */

  flightState._lastFleetTickMs = 0;

  /** @type {number} Last computed rotation for the tracked entity (radians) */

  flightState._lastTrackedRotation = 0;

  /** @type {() => void|null} preRender listener disposer */

  flightState._preRenderRemove = null;

  flightState._trackedModelPreUpdateRemove = null;

  /** @type {() => void|null} camera.moveEnd listener disposer (arrival rotation pass) */

  flightState._moveEndRemove = null;

  /** @type {() => void|null} trackedEntityChanged listener disposer (cross-layer untrack) */

  flightState._trackedEntityChangedRemove = null;

  // -- Scratch variables (reused each frame to avoid GC pressure) --

  flightState._scratchOffset = { x: 0, y: 0, z: 0 };

  flightState._scratchArc = { east: 0, north: 0, endCourseDeg: 0 };

  flightState._scratchRenderTime = { dayNumber: 0, secondsOfDay: 0 };

  flightState._scratchFleetRenderTime = { dayNumber: 0, secondsOfDay: 0 };

  flightState._scratchFleetPos = { x: 0, y: 0, z: 0 };

  flightState._scratchCockpitPos = { x: 0, y: 0, z: 0 };

  flightState._scratchNearbyPos = { x: 0, y: 0, z: 0 };

  flightState._scratchSonarScreen = { x: 0, y: 0 };

  flightState._scratchDrRaw = { x: 0, y: 0, z: 0 };

  flightState._scratchWarmupTime = { dayNumber: 0, secondsOfDay: 0 };

  flightState._trackedPosHolder = { x: 0, y: 0, z: 0 };

  // -- Per-frame dead-reckoning cache for the tracked entity --
  /** @type {{x: number, y: number, z: number}|null} Cached DR position for the current render frame */

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

  flightState._drCorrection = { x: 0, y: 0, z: 0 };

  flightState._drCorrectionStartMs = 0;

  flightState._drPrevRaw = { x: 0, y: 0, z: 0 };

  flightState._drPrevDisplay = { x: 0, y: 0, z: 0 };

  flightState._drPrevMs = 0;

  flightState._drReconcileValid = false;

  /** @type {string|null} icao the reconciliation state currently belongs to */

  flightState._drReconcileIcao = null;

  /** @type {{x: number, y: number, z: number}} Scratch for the tracked model's rendered translation. */

  flightState._trackedVisualPos = { x: 0, y: 0, z: 0 };

  flightState._trackedTrailPos = { x: 0, y: 0, z: 0 };

  /** Scratch for the tracked model's world-space origin (the envelope centre). */

  flightState._scratchTrailClip = { x: 0, y: 0, z: 0 };

  /** Scratch for the shortened trail-head start. Owned by the head-segment
   *  callback alone, so nothing else can overwrite it mid-frame. */

  flightState._scratchTrailHead = { x: 0, y: 0, z: 0 };

  /** Hysteresis latch for the tracked contact's zoom regime, plus the selection it
   *  belongs to. Scoped per selection so a NEW target re-evaluates against the ENTER
   *  ceiling instead of inheriting the previous target's looser EXIT band. */

  flightState._trackedZoomLatched = false;

  flightState._trackedZoomLatchIcao = null;

  /** The tracked-model load-failure budget: the selection it counts for,
   *  its failures, and when it may load again (`TRACKED_MODEL_*`). */

  flightState._trackedModelFailIcao = null;

  flightState._trackedModelFailCount = 0;

  flightState._trackedModelRetryAtMs = 0;

  /** IR hot-target mode — mirror of flights.js: under the luminance-mapped
   *  NVG/FLIR post-styles every model renders flat white (hottest); the dominant
   *  amber/tracked tint restores on style exit. */

  flightState._irBoost = false;

  return flightState;
}
