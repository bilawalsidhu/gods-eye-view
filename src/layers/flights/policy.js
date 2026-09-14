import * as Cesium from 'cesium';

export const FOCUS_EVIDENCE_DEV = import.meta.env?.DEV === true;

/** Amber tint for known-military aircraft rendered by this layer (matches the military layer's icon color). */

export const MIL_TINT = Cesium.Color.fromCssColorString('#FFB800');

// --- Ground traffic (owner reversal 2026-07-03: "absolutely we should see planes
// taxiing and landing") -----------------------------------------------------------
// Present-but-grounded planes are RENDERED instead of being skipped: same class
// silhouette + rotation pipeline, clickable/trackable/detectable, sticky metadata
// updating normally. Landing/takeoff is a TRANSITION — the on_ground flip restyles
// the existing billboard in place, never a removal. Ground planes draw no trails
// and are excluded from the ambient enrichment sweep (click-to-enrich still
// works). In 3D mode they take model slots like airborne planes (owner decision
// 2026-07-03 — no air/ground distinction), placed by the one-shot ground snap
// (see _modelDisplayPosition).
//
// TINT: full-strength, same pipeline as airborne (white / amber-military /
// cyan-tracked). Day 1 shipped a slate-gray 50%-alpha "muted" ground tint; the
// owner killed it the same day ("just leave them as white, dude … in NYC I can
// barely see them, extremely grayed out"). "On the ground" reads from the ×0.8
// scale + missing trail; "feed-dropped, coasting" stays the 45%-alpha stale
// fade — a full-alpha ground icon can never be confused with it.
/** Ground billboards render slightly smaller so airport clutter stays visually minor. */

export const GROUND_SCALE = 0.8;

// --- 3D model rendering (B3) ---------------------------------------------------------
// When enabled, aircraft render as 3D glTF models once the camera is below MODEL_ALT_CEIL_M
// (zoomed in); higher up they stay flat billboards. Eligibility is FRUSTUM-based (on-screen), and
// the slots go to either the nearest planes ('proximity') or every in-view plane ('all'), each
// backed by a hard cap so a draw-call explosion can't tank the frame (no instancing yet).

export const PLANE_MODEL_URL = '/models/airplane.glb';

export const MODEL_ALT_CEIL_M = 800000;
// m: below this camera altitude, draw 3D models (raised so it's easy to trigger)

export const MODEL_MIN_PX = 24;
// floor so distant models stay visible WITHOUT ballooning into a giant
// min-pixel blob (was 54 — far planes at the All radius became white
// star-bursts); ~matches the 2D icon size so the model↔billboard read is consistent

export const TRACKED_MODEL_MIN_PX = 40;
// keep the glTF silhouette comparable to the selected 2D glyph at handoff

export const TRACKED_MODEL_MAX_PX = 200;
// owner-selected close-range tracked-target feel

export const MODEL_NATIVE_RADIUS_M = 34.41;

export const MODEL_SCALE = 1;
// airplane.glb is transform-applied and baked to real-world meters
// Per-mode caps. Each model is its own draw call (no instancing yet), so these bound the frame cost.

export const MODEL_MAX = 150;
// 'proximity' cap (the planes immediately around you)

export const MODEL_MAX_ALL = 350;
// 'all' cap (everything out to ~the horizon)
// Per-mode ADD / KEEP radii. The two modes differ by RADIUS, not just cap — otherwise they look
// IDENTICAL whenever fewer than a cap's worth of planes are in range (field bug: Proximity and All
// rendered the same). 'proximity' = a tight ring; 'all' = roughly to the horizon (state-scale). Each
// band has hysteresis (KEEP > ADD) so a plane doesn't release+reload its model when it straddles the
// add edge (the zoom/pan flicker). Beyond ADD a model would force-clamp to minimumPixelSize into a
// giant floating blob (the old 422 km airport-cluster bug), so far planes stay 2D dots; the cap +
// on-screen priority then spend the model slots on planes you can actually see.

export const MODEL_PROX_ADD_M = 150000;
// proximity: model NEW planes within 150 km

export const MODEL_PROX_KEEP_M = 185000;
// proximity: KEEP modeled planes out to 185 km

export const COCKPIT_MODEL_MAX = 60;
// max concurrent GLBs in cockpit (never raises the map cap)

export const MODEL_ALL_ADD_M = 400000;
// all: model NEW planes within 400 km (~to the horizon)

export const MODEL_ALL_KEEP_M = 450000;
// all: KEEP modeled planes out to 450 km

export const MODEL_HEADING_OFFSET_DEG = 180;
// airplane.glb nose is opposite Cesium heading-0
// Owner launch-polish direction: models should read as clean light silhouettes,
// with only a weak diffuse contribution from the existing approved textures.

export const MODEL_COLOR_BLEND_AMOUNT = 0.94;

// Grounded-model belly offset: airplane.glb's centred origin sits 6.719 m ABOVE its
// lowest vertex (glTF Y-up scene AABB with node transforms applied — same reader as
// modelScale.test.mjs, measured after its 24× transform bake). × class multiplier ≈ 5.0–9.7 m
// of lift, so a ground-snapped model rests its lowest geometry (gear/belly) ON the sampled
// tile skin instead of sinking to the fuselage-centerline origin. Locked against the GLB
// by modelScale.test.mjs.

export const MODEL_BELLY_OFFSET_NATIVE = 6.719;

export const CYAN_TRANSPARENT = Cesium.Color.CYAN.withAlpha(0);

/** @constant {number} ERROR_BACKOFF_INTERVAL - Cooldown (ms) after transient errors */

export const ERROR_BACKOFF_INTERVAL = 20000;
// transient error retry
/** @constant {number} POSITION_HISTORY_LIMIT - Max position samples kept per aircraft for dead reckoning */

export const POSITION_HISTORY_LIMIT = 5;

export const COCKPIT_CONTACT_SIZE_PX = 6;

export const COCKPIT_CIVILIAN_COLOR =
  Cesium.Color.fromCssColorString('#DCEEFF');

export const TRACKED_BILLBOARD_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  1000,
  3.0,
  8000000,
  0.5,
);

// ---------------------------------------------------------------------------
// Track-history trail state (PRD WS-F F1/F4): a fading polyline behind the
// tracked aircraft. The accumulation array is intentionally SEPARATE from
// _positionHistory (capped at POSITION_HISTORY_LIMIT=5 for dead reckoning)
// so the visible trail can grow to TRAIL_MAX_POINTS fixes.
// ---------------------------------------------------------------------------

/** @constant {string} Civilian trail hue (PRD F4, pinned). */

export const TRAIL_COLOR = '#00d4ff';

/** @constant {number} Combined cap on trail vertices (backfill + live accumulation). */

export const TRAIL_MAX_POINTS = 400;

// ---------------------------------------------------------------------------
// Render-behind smoothing (PRD WS-C C2 — approved product decision):
// the fleet renders at now - RENDER_DELAY_SEC so positions interpolate
// BETWEEN two known fixes instead of extrapolating ahead and snapping back
// when the next poll lands. All consumers (labels, HUD, detection,
// frame_overhead) share this delayed clock; removing the delay reintroduces
// the back/forward oscillation and is a regression.
// ---------------------------------------------------------------------------

/** @constant {number} Display latency in seconds (= one poll interval). */

export const RENDER_DELAY_SEC = 30;

/** @constant {number} Polls an aircraft may miss before removal (transient OpenSky dropouts). */

export const MISSING_POLL_LIMIT = 3;

// --- Landed-plane fast cull (owner field report 2026-07-02: "phantom" planes
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

export const LANDED_ALT_MAX_M = 150;

/** @constant {number} Max ground speed (m/s) for the landed fast cull (~45 kts). */

export const LANDED_SPEED_MAX_MPS = 23;

/** @constant {number} Missed-poll allowance for likely-landed planes (1 = removed on the first missed poll). */

export const LANDED_MISSING_POLL_LIMIT = 1;

// Field-test rounds 1+3 (2026-07-06): below-ground floor clamp scope. Only
// contacts rendering below the alt ceiling are ever clamped/warmed (terrain
// tops out well under it outside the extreme Himalaya; cruise traffic can't
// be below ground and costs zero lookups). The radius bounds the FLEET clamp
// to viewer-visible traffic — clamping thousands of global contacts would
// need unbounded terrain resolution (the tracked contact clamps regardless).
/** @constant {number} Max render altitude (m, ellipsoidal) eligible for the ground-floor clamp. */

export const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;

/** @constant {number} Max viewer distance (km) for the fleet ground-floor clamp. */

export const GROUND_FLOOR_CLAMP_RADIUS_KM = 150;

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

export const FLEET_DR_INTERVAL_MS = 80;

/** @constant {number} Max ms between rotation passes while the camera is idle. */

export const ROTATION_REFRESH_MS = 1000;

/** Max course slew (deg/s) — well above real turns (≤4°/s), hides fix-boundary
 *  steps. Scaled down toward COURSE_MIN_DPS at low speed (courseSlewCapDps). */

export const COURSE_MAX_DPS = 60;

/** Never spend a long render stall's full elapsed time in one visible course step. */

export const COURSE_SLEW_DT_MAX_SEC = 0.25;

// ---------------------------------------------------------------------------
// adsbdb enrichment (best-effort, fail-silent). Bounded fan-out: max 4
// concurrent requests, dispatches dripped ≥ENRICH_DISPATCH_GAP_MS apart
// (≤5/s — adsbdb is a free community API; the dev-server proxy additionally
// caches per-key on disk forever, negative results included, so repeat
// sessions never re-hit adsbdb). Each key is requested at most once per
// session. Priority jobs (tracked plane, model-eligible planes) jump the
// queue; the ambient fleet sweep (below) fills the back at poll cadence.
// ---------------------------------------------------------------------------

export const ENRICH_MAX_INFLIGHT = 4;

/** Min ms between request dispatches — the drip that bounds the fan-out to ≤5/s. */

export const ENRICH_DISPATCH_GAP_MS = 200;

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

export const ENRICH_AMBIENT_BUDGET_CEIL = 300;

/** Tokens added back per refill window. */

export const ENRICH_AMBIENT_REFILL_TOKENS = 150;

/** Refill window length (ms). */

export const ENRICH_AMBIENT_REFILL_WINDOW_MS = 5 * 60 * 1000;

/** Max new ambient enqueues per poll sweep (≈ rate × poll interval). */

export const ENRICH_AMBIENT_PER_SWEEP = 150;

// ---------------------------------------------------------------------------
// Tracked-display reconciliation. _deadReckon gives the RAW position from real
// fixes; at the warm-up→interpolation handoff (and on feed glitches / backfill
// splices) that raw value can step discontinuously. We absorb a step into a
// correction offset that decays to zero over DR_CORRECTION_MS, so the tracked
// icon, camera, and trail head never visibly jump — with ZERO steady-state lag
// (the correction stays ~0 whenever motion is already continuous).
// ---------------------------------------------------------------------------

export const DR_CORRECTION_MS = 900;

/** Bounded on-demand loading for the tracked model. The tracked regime is
 *  DEFAULT-ON and its driver runs every `scene.preUpdate`, so a missing or
 *  corrupt GLB — or a dead network — would otherwise spin load→reject at frame
 *  rate for as long as the contact stays selected. Failures are counted PER
 *  SELECTION: a short backoff absorbs a transient blip, then the layer stops
 *  asking until the operator selects something else. The billboard is the
 *  visual throughout (the handoff only fades it once a model actually renders),
 *  so a latched failure degrades to exactly the pre-3D presentation. */

export const TRACKED_MODEL_MAX_LOAD_FAILS = 3;

export const TRACKED_MODEL_RETRY_BACKOFF_MS = 1500;

/** @constant {number} Cap on NEW cells the display corridors may add to one
 *  poll's warm/sample batch — a view full of ground traffic must not balloon
 *  it. Cells the poll already collected are free (deduped before budgeting). */

export const DISPLAY_CORRIDOR_CELL_BUDGET = 64;

/** @constant {number} Cells any single contact may claim in the first pass, so
 *  one long corridor cannot spend the whole budget while other contacts get
 *  nothing. Leftovers are handed out in a second pass. */

export const DISPLAY_CORRIDOR_FAIR_SHARE = 4;

/** @constant {number} How far ahead a COASTING contact's corridor reaches:
 *  two poll intervals, so the ground it covers before the next batch lands is
 *  already warm. */

export const DISPLAY_CORRIDOR_LOOKAHEAD_SEC = RENDER_DELAY_SEC * 2;

/** @constant {number} Corridors are only collected this close to the viewer:
 *  the mesh sampler ignores anything past 15 km, and a far contact's exact
 *  datum is subpixel. */

export const DISPLAY_CORRIDOR_RADIUS_KM = 25;

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

export const HELD_FLOOR_MAX_DRIFT_KM = 1;

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

export const NEIGHBOR_FLOOR_PROBE_MS = 500;

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

export const FLOOR_EASE_TAU_MS = 360;

/** @constant {number} Hard ceiling on the fraction of the remaining gap ONE
 *  tick may close, whatever its dt. The exponential alone is timing-dependent:
 *  it closes 19.9% at the 80 ms fleet cadence but 28.4% at 120 ms and 75% after
 *  a 500 ms stall (a hidden tab, a long frame, a GC pause), which would turn a
 *  delayed tick back into the snap this approach exists to prevent. Clamping
 *  the fraction rather than dt keeps the never-snap property a property of the
 *  code instead of a property of the schedule; a stalled tick simply resumes
 *  the approach at full rate rather than jumping most of the way. */

export const FLOOR_EASE_MAX_STEP = 0.22;

/** @constant {number} Distance from the target at which the ease finishes
 *  exactly, so a parked contact stops rebuilding its position. Two orders of
 *  magnitude under GROUND_FLOOR_LIFT_M — invisible. */

export const FLOOR_EASE_EPSILON_M = 0.02;

/** @constant {number} How long a retired hold stays usable as a rehydration
 *  seed — three poll intervals.
 *
 *  Deleting the state outright was the first cut, and an owner sighting found
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

export const FLOOR_SEED_GRACE_MS = 90_000;

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

export const IR_RELOAD_BATCH = 40;
