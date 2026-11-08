import { FlightRecords } from './records.js';
import { createFlightFeed } from './ingestion.js';
import { ENRICH_AMBIENT_BUDGET_CEIL } from './policy.js';

export function createFlightState({ source, services }) {
  const { createGroundSnap } = services.groundSnap;
  const flightState = { lifetime: new AbortController() };
  flightState.feed = createFlightFeed(source);
  flightState.records = new FlightRecords({
    ...services.geoid,
    ...services.groundFloor,
  });

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
  // keep last N positions per aircraft

  // ---------------------------------------------------------------------------
  // Module-level state: billboard collection and per-aircraft lookup maps
  // ---------------------------------------------------------------------------

  /** Every contact's icon item as drawn (`createContactIcons`, see icons.js);
   *  null outside a layer lifetime. */

  flightState._icons = null;

  /** Contacts whose latest poll put them on the ground. */

  flightState._grounded = new Set();

  /** Grounded contacts the floor currently lifts; their rows hold CPU positions. */

  flightState._floorPinned = new Set();

  /** Fleet ticks since start; far grounded rows take their floor turn by it. */

  flightState._floorTick = 0;

  /** Rows still away from full focus emphasis after the last focus pass. */

  flightState._iconFocusActive = 0;

  /** Stable lightweight records reused by the detection overlay between polls. */

  flightState._detectionObjects = new Map();

  /** DEV-only explicit-position contacts used by qa-focus-evidence.mjs. */

  flightState._focusEvidenceIds = new Set();

  /** @type {Map<string, Array<{time:object, position:{x: number, y: number, z: number}}>>} */

  flightState._positionHistory = new Map();

  // ---------------------------------------------------------------------------
  // Click-to-track state
  // ---------------------------------------------------------------------------

  /** @type {string|null} ICAO24 of the currently tracked aircraft */

  flightState._trackedIcao = null;

  flightState._pendingTrackingRestore = null;

  flightState._trackingIntentGeneration = 0;

  /** @type {object|null} The tracked aircraft's record holder (its entity record is what the app shows; the camera follows a target reading it) */

  flightState._trackedEntity = null;

  /** The FollowTarget the camera follows the tracked aircraft with. */
  flightState._followTarget = null;

  /** @type {import('../../data/modelRecord.js').ModelRecord|null} Standalone 3D model for the tracked aircraft. Deliberately NOT a
   *  graphic on _trackedEntity: a model graphic reports PENDING until its glTF loads, and the
   *  tracked entity must stay a plain, always-ready billboard. The model rides in its own draw set
   *  and is driven per-frame, fully decoupled from the camera, which follows its own target. */

  flightState._trackedModel = null;

  /** @type {(() => void)|null} Unsubscribes the scene click. */

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

  /** @type {(() => void)|null} militaryRegistry active-transition unsubscribe (M2 handoff sweep) */

  flightState._milActiveChangeUnsub = null;

  // ---------------------------------------------------------------------------
  // Scratch (reusable) variables — avoid per-frame heap allocation
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Per-frame cache for the tracked entity's dead-reckoned position.
  // The position, alignedAxis, and rotation CallbackProperties all fire each
  // render frame; caching avoids running _deadReckon three times.
  // ---------------------------------------------------------------------------

  /** @type {{x: number, y: number, z: number}|null} */

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

  /** @type {Map<string, {cell: {lat: number, lon: number}, effectiveM: number|null,
   *  in: {x: number, y: number, z: number}, out: {x: number, y: number, z: number}|null, heldM: number|null,
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

  /** @type {{x: number, y: number, z: number}} Scratch for the corridor's dead-reckon probe. */

  flightState._scratchCorridorPos = { x: 0, y: 0, z: 0 };

  /** IR hot-target mode (owner playtest 2026-08-16): the NVG/FLIR post-styles
   *  map LUMINANCE, so mid-gray textured models read cold and vanish into
   *  terrain. While a boost style is active every model renders flat white
   *  (hottest); per-spec color/tint restores on style exit. Driven by ui.js
   *  setStyle via the `irBoost` layer param. */

  flightState._irBoost = false;

  return flightState;
}
