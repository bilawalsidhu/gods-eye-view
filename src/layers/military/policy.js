export {
  GROUND_FLOOR_WARM_MAX_ALT_M,
  POSITION_HISTORY_LIMIT,
  LANDED_MISSING_POLL_LIMIT,
  MISSING_POLL_LIMIT,
  ERROR_BACKOFF_INTERVAL,
  MILITARY_SCENE_RADIUS_NM,
  MILITARY_REGIONAL_VIEW_MAX_HEIGHT_M,
} from './recordPolicy.js';
import * as Cesium from 'cesium';

/**
 * @module militaryFlights
 * @description Real-time military flight tracking layer powered by the adsb.lol API.
 *
 * Renders aircraft as amber chevron billboards in a single BillboardCollection
 * for GPU-efficient batch drawing. Supports click-to-track: selecting an aircraft
 * spawns an Entity the camera follows, whose position is driven by a
 * dead-reckoning CallbackProperty. The whole fleet renders at
 * now - RENDER_DELAY_SEC so positions interpolate BETWEEN two known fixes
 * instead of extrapolating ahead and snapping back when the next poll lands.
 *
 * Billboard orientation uses alignedAxis set to the WGS84 surface normal at each
 * position so that the rotation angle (heading/track) operates in the local tangent
 * plane where 0 deg = north; near nadir the icons switch to screen-aligned
 * rotation (camera.heading - track) with hysteresis.
 */

/** @constant {number} Milliseconds to wait before retrying after a transient error */

/** @constant {number} Max position samples retained per aircraft for dead reckoning */

/** @constant {number} Base billboard display scale */

export const BILLBOARD_SCALE = 0.7;

/** @constant {Cesium.Color} Default amber tint for untracked military billboards */

export const MIL_ICON_COLOR = Cesium.Color.fromCssColorString('#FFB800');

/** @constant {Cesium.Color} Lighter amber tint applied to the actively tracked aircraft */

export const TRACKED_ICON_COLOR = Cesium.Color.fromCssColorString('#FFD166');

// --- Ground traffic (owner reversal 2026-07-03; mirror of flights.js) ---------------
// adsb.lol/readsb flags ground traffic with alt_baro === "ground" (no separate
// boolean). Such aircraft are RENDERED instead of floating at the 3 km altitude
// fallback: same silhouette + rotation pipeline, clickable/trackable/detectable,
// sticky metadata updating normally. The on-ground flip restyles the existing
// billboard IN PLACE (landing/takeoff transition, never a removal); ground planes
// draw no trails. In 3D mode they take model slots like airborne planes (owner
// decision 2026-07-03 — no air/ground distinction), placed by the one-shot
// ground snap (see _modelDisplayPosition).
//
// TINT: full-strength amber, same as airborne (owner verdict 2026-07-03 field
// test: the day-1 slate-gray 50%-alpha muted tint was unreadable — "in NYC I can
// barely see them"). "On the ground" reads from the ×0.8 scale + missing trail;
// "feed-dropped, coasting" stays the 45%-alpha stale fade.
/** Ground billboards render slightly smaller so airport clutter stays visually minor. */

export const GROUND_SCALE = 0.8;

// --- 3D model rendering (mirrors flights.js) -----------------------------------------
// When enabled, military aircraft render as 3D glTF jet models once the camera is below
// MODEL_ALT_CEIL_M (zoomed in); higher up they stay flat billboards. Eligibility is
// FRUSTUM-based (on-screen), and the slots go to either the nearest planes ('proximity')
// or every in-view plane ('all'), each backed by a hard cap so a draw-call explosion
// can't tank the frame (no instancing yet). Distinct asset + amber tint set this layer
// apart from the commercial flights layer.

export const JET_MODEL_URL = '/models/jet.glb';

export const MODEL_ALT_CEIL_M = 800000;
// m: below this camera altitude, draw 3D models (raised so it's easy to trigger)

export const MODEL_MIN_PX = 24;
// floor so distant models stay visible without ballooning into a min-pixel blob (mirror of flights.js, whose models now share this layer's ~30 m world size)

export const TRACKED_MODEL_MIN_PX = 40;
// keep the glTF silhouette comparable to the selected 2D glyph at handoff

export const TRACKED_MODEL_MAX_PX = 200;
// owner-selected close-range tracked-target feel

export const MODEL_NATIVE_RADIUS_M = 29.83;

// jet.glb is transform-applied at real-world scale — native bounding radius
// 29.83 m at scale 1. ×1 → ~22–43 m aircraft across CLASS_SCALE_3D, matching
// flights.js world sizes. At the old copied ×24, models rendered
// 600–1000 m across (invisible at the ~6 km follow range where minimumPixelSize
// dominates, but zoom under ~1 km put the camera INSIDE the plane). Locked by
// modelScale.test.mjs.

export const MODEL_SCALE = 1;

// Per-mode caps + radii — mirror of flights.js. Modes differ by RADIUS (not just cap) so Proximity
// and All aren't identical when few planes are in range; on-screen planes win the cap (see flights.js).

export const MODEL_MAX = 150;
// 'proximity' cap

export const MODEL_MAX_ALL = 350;
// 'all' cap

export const MODEL_PROX_ADD_M = 150000;
// proximity: model NEW planes within 150 km

export const MODEL_PROX_KEEP_M = 185000;
// proximity: KEEP modeled planes out to 185 km

// Cockpit keeps the standard Display radii but lowers the GLB budget. Contacts
// inside the selected band remain AIR silhouettes when they cannot own a model;
// contacts outside the band use compact dots.

export const COCKPIT_MODEL_MAX = 60;
// max concurrent GLBs in cockpit (never raises the map cap)

export const MODEL_ALL_ADD_M = 400000;
// all: model NEW planes within 400 km (~to the horizon)

export const MODEL_ALL_KEEP_M = 450000;
// all: KEEP modeled planes out to 450 km

export const MODEL_HEADING_OFFSET_DEG = 180;
// every aircraft GLB is exported nose -X in the shared transform-applied convention
// Preserve the layer's amber identity while reducing approved texture/livery
// contribution to a weak diffuse hint, matching civilian launch presentation.

export const MODEL_COLOR_BLEND_AMOUNT = 0.94;

// airplane.glb (the shared 747) constants for this layer's heavy classes. The
// asset has its former 24× runtime calibration baked into transform-applied
// meter-scale geometry; these values mirror flights.js and are regression-pinned.

export const PLANE_MODEL_URL = '/models/airplane.glb';

export const PLANE_MODEL_SCALE = 1;

export const PLANE_NATIVE_RADIUS_M = 34.41;

export const PLANE_BELLY_OFFSET_NATIVE = 6.719;

// Grounded-model belly offset: jet.glb's centred origin sits 5.631 native units (= meters — this
// asset is real-world scale) ABOVE its lowest vertex (glTF Y-up scene AABB with node
// transforms applied — same reader as modelScale.test.mjs, measured 2026-07-03).
// × MODEL_SCALE(1) × class multiplier ≈ 4.4–8.6 m of lift, so a ground-snapped model
// rests its lowest geometry (gear/belly) ON the sampled tile skin instead of sinking to
// the fuselage-centerline origin. Locked against the GLB by modelScale.test.mjs.

export const MODEL_BELLY_OFFSET_NATIVE = 5.631;

/** Amber fade target for the tracked billboard once the model takes over (mirrors flights.js CYAN_TRANSPARENT). */

export const AMBER_TRANSPARENT = MIL_ICON_COLOR.withAlpha(0);

export const COCKPIT_CONTACT_SIZE_PX = 6;

export const TRACKED_BILLBOARD_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  1000,
  3.0,
  8000000,
  0.5,
);

// ---------------------------------------------------------------------------
// Track-history trail state (PRD WS-F F2/F4): a fading polyline behind the
// tracked aircraft. The accumulation array is intentionally SEPARATE from
// _positionHistory (capped at POSITION_HISTORY_LIMIT=5 for dead reckoning)
// so the visible trail can grow to TRAIL_MAX_POINTS fixes.
// ---------------------------------------------------------------------------

/** @constant {string} Military trail hue (PRD F4, pinned). */

export const TRAIL_COLOR = '#FFB800';

/** @constant {number} Combined cap on trail vertices (backfill + live accumulation). */

export const TRAIL_MAX_POINTS = 400;

// ---------------------------------------------------------------------------
// Render-behind smoothing (mirrors flights.js): the fleet renders at
// now - RENDER_DELAY_SEC so positions interpolate BETWEEN two known fixes
// instead of extrapolating ahead and snapping back when the next poll lands.
// Removing the delay reintroduces the back/forward oscillation and is a
// regression.
// ---------------------------------------------------------------------------

/** @constant {number} Display latency in seconds (= one poll interval). */

export const RENDER_DELAY_SEC = 15;

/** @constant {number} Polls an aircraft may miss before removal (transient adsb.lol dropouts). */

// --- Landed-plane fast cull (mirror of flights.js; owner field report
// 2026-07-02: "phantom" planes lingered ~2 min at airports after touchdown).
// The feed's ground flag lags the actual landing, so a landed plane's last
// airborne fixes show it low + slow on the runway; when it then drops out of
// the poll it has landed, not hit a transient gap — evict after ONE missed
// poll. Thresholds: below ~500 ft baro (≈150 m MSL — near-sea-level fields
// only; a high-elevation airport ghost falls back to the normal grace) AND
// below ~45 kts ground speed (≈23 m/s — rollout/taxi; nothing in normal
// FLIGHT is this slow, so cruise planes always keep the full grace).
/** @constant {number} Max baro altitude (ft, MSL) for the landed fast cull (~150 m). */

export const LANDED_ALT_MAX_FT = 500;

/** @constant {number} Max ground speed (m/s) for the landed fast cull (~45 kts). */

export const LANDED_SPEED_MAX_MPS = 23;

/** @constant {number} Missed-poll allowance for likely-landed planes (1 = removed on the first missed poll). */

// Field-test fix (RS46, 2026-07-06): only contacts rendering below this
// ellipsoidal height get the below-ground floor clamp + a coarse floor-cell
// warm. Terrain outside the extreme Himalaya tops out well under this, so
// cruise traffic (which can never be below ground) costs zero terrain
// lookups; low pattern/heli work — the class that actually clips hillsides —
// gets the floor.
/** @constant {number} Max render altitude (m, ellipsoidal) eligible for the ground-floor clamp. */

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

export const FLEET_DR_INTERVAL_MS = 80;

/** @constant {number} Max ms between rotation passes while the camera is idle. */

export const ROTATION_REFRESH_MS = 1000;

/** Max course slew (deg/s) — well above real turns (≤4°/s), hides fix-boundary
 *  steps. Scaled down toward COURSE_MIN_DPS at low speed (courseSlewCapDps). */

export const COURSE_MAX_DPS = 60;

/** Never spend a long render stall's full elapsed time in one visible course step. */

export const COURSE_SLEW_DT_MAX_SEC = 0.25;

// -- Tracked-display reconciliation (see flights.js for the rationale): absorb a raw
// position step (warm-up→interpolation handoff, feed glitch, backfill splice) into a
// correction offset that decays to zero over DR_CORRECTION_MS, so the tracked icon,
// camera, and trail head never visibly jump — with zero steady-state lag. --

export const DR_CORRECTION_MS = 900;

/** Bounded on-demand loading for the tracked model (mirror of flights.js). The
 *  tracked regime is DEFAULT-ON and its driver runs every `scene.preUpdate`, so
 *  a missing or corrupt GLB — or a dead network — would otherwise spin
 *  load→reject at frame rate for as long as the contact stays selected.
 *  Failures are counted PER SELECTION: a short backoff absorbs a transient
 *  blip, then the layer stops asking until the operator selects something else.
 *  The billboard is the visual throughout (the handoff only fades it once a
 *  model actually renders), so a latched failure degrades to exactly the
 *  pre-3D presentation. */

export const TRACKED_MODEL_MAX_LOAD_FAILS = 3;

export const TRACKED_MODEL_RETRY_BACKOFF_MS = 1500;

/** Boost flip = BATCHED release through the fleet tick (mirror of flights.js —
 *  destroying the whole fleet synchronously in the style handler stalls the
 *  render thread). Models tagged with their load-time boost state; stale queue
 *  entries skip; in-flight loads invalidated immediately; tracked reloads
 *  synchronously (single primitive). */

export const IR_RELOAD_BATCH = 40;
