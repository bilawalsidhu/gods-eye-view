import { EMERGENCY_TINT_CSS } from '../../data/aircraftEmergency.js';
import { cssColor } from '../../render/color.js';

/** A CSS colour as frozen `[r, g, b, a]`, 0..1 (the renderer's `Color`). */
const rgba = (css, alpha) =>
  Object.freeze(
    alpha === undefined ? cssColor(css) : [...cssColor(css).slice(0, 3), alpha],
  );

/**
 * @module militaryFlights
 * @description Real-time military flight tracking layer powered by the adsb.lol API.
 *
 * Renders aircraft as amber chevrons in one GPU icon set (iconSet.js), whose
 * shader dead-reckons and orients every row. Supports click-to-track: selecting an aircraft
 * spawns an Entity the camera follows, whose position is driven by a
 * dead-reckoning CallbackProperty. The whole fleet renders at now − the
 * display delay so positions run BETWEEN two known fixes instead of
 * extrapolating ahead and snapping back when the next poll lands.
 */

/** @constant {number} Milliseconds to wait before retrying after a transient error */

/** @constant {number} Max position samples retained per aircraft for dead reckoning */

/** @constant {number} Base icon display scale */

export const BILLBOARD_SCALE = 0.7;

/** @constant {number[]} Default amber tint for untracked military icons */

export const MIL_ICON_COLOR = rgba('#FFB800');

/** @constant {number[]} Lighter amber tint applied to the actively tracked aircraft */

export const TRACKED_ICON_COLOR = rgba('#FFD166');

/** @constant {number[]} Red tint for aircraft broadcasting an emergency (mirror of flights) */

export const EMERGENCY_ICON_COLOR = rgba(EMERGENCY_TINT_CSS);

/** A model's colour where it draws its mesh's own (`aircraftModelBlend`). */
export const MODEL_WHITE = rgba('#FFFFFF');

// --- Ground traffic (owner reversal 2026-07-03; mirror of flights.js) ---------------
// adsb.lol/readsb flags ground traffic with alt_baro === "ground" (no separate
// boolean). Such aircraft are RENDERED instead of floating at the 3 km altitude
// fallback: same silhouette + rotation pipeline, clickable/trackable/detectable,
// sticky metadata updating normally. The on-ground flip restyles the existing
// icon IN PLACE (landing/takeoff transition, never a removal); ground planes
// draw no trails. In 3D mode they take model slots like airborne planes (owner
// decision 2026-07-03 — no air/ground distinction), placed by the one-shot
// ground snap (see _modelDisplayPosition).
//
// TINT: full-strength amber, same as airborne (owner verdict 2026-07-03 field
// test: the day-1 slate-gray 50%-alpha muted tint was unreadable — "in NYC I can
// barely see them"). "On the ground" reads from the ×0.8 scale + missing trail;
// "feed-dropped, coasting" stays the 45%-alpha stale fade.
/** Ground icons render slightly smaller so airport clutter stays visually minor. */

export const GROUND_SCALE = 0.8;

// --- 3D model rendering (mirrors flights.js) -----------------------------------------
// When enabled, military aircraft render as 3D glTF models once the camera is below
// MODEL_ALT_CEIL_M (zoomed in); higher up they stay flat billboards. Eligibility is
// FRUSTUM-based (on-screen), and the slots go to either the nearest planes ('proximity')
// or every in-view plane ('all'), each backed by a hard cap so a draw-call explosion
// can't tank the frame (no instancing yet). Each aircraft draws the fleet model of its
// type, as the flights layer does; the amber tint sets this layer apart.

export const MODEL_ALT_CEIL_M = 800000;
// m: below this camera altitude, draw 3D models (raised so it's easy to trigger)

export const MODEL_MIN_PX = 24;
// floor so distant models stay visible without ballooning into a min-pixel blob (mirror of flights.js)

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
// every fleet model is nose -X: opposite Cesium heading 0

/** Amber fade target for the tracked billboard once the model takes over (mirrors flights.js CYAN_TRANSPARENT). */

export const AMBER_TRANSPARENT = rgba('#FFB800', 0);

export const COCKPIT_CONTACT_SIZE_PX = 6;

/** The tracked billboard's size by eye distance (the renderer's `NearFar`). */
export const TRACKED_BILLBOARD_SCALE_BY_DISTANCE = Object.freeze({
  near: 1000,
  nearValue: 3.0,
  far: 8000000,
  farValue: 0.5,
});

// ---------------------------------------------------------------------------
// Track-history trail state (PRD WS-F F2/F4): a fading polyline behind the
// tracked aircraft. The accumulation array is intentionally SEPARATE from
// _positionHistory (capped at POSITION_HISTORY_LIMIT for drawing)
// so the visible trail can grow to TRAIL_MAX_POINTS fixes.
// ---------------------------------------------------------------------------

/** @constant {string} Military trail hue (PRD F4, pinned). */

export const TRAIL_COLOR = '#FFB800';

/** @constant {number} Combined cap on trail vertices (backfill + live accumulation). */

export const TRAIL_MAX_POINTS = 2000;

// ---------------------------------------------------------------------------
// Render-behind smoothing (mirrors flights): the fleet renders at now − the
// display delay so positions run BETWEEN two known fixes instead of
// extrapolating ahead and snapping back when the next poll lands. The delay
// follows how late the feed really is (data/displayDelay.js), never under
// RENDER_DELAY_SEC, and every consumer shares it. Removing the delay
// reintroduces the back/forward oscillation and is a regression.
// ---------------------------------------------------------------------------

/** @constant {number} The shortest display delay in seconds (one poll interval). */

export const RENDER_DELAY_SEC = 15;

/** @constant {number} How often the feed is polled (ms). */

export const POLL_INTERVAL_MS = 15_000;

/** Whether the layer shows the world clock's time instead of the live feed:
 *  its source declares a timeline and the clock is away from live. */
export const followsClock = (state) => state.timeline?.active() === true;

/** How far behind the time contacts are drawn (ms): the feed's display
 *  delay live, none following the clock, whose snapshots are loaded ahead
 *  of the time. */
export const displayDelayMs = (state) =>
  followsClock(state)
    ? 0
    : (state._displayDelay?.currentMs ?? RENDER_DELAY_SEC * 1000);

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

/** @constant {number} Fleet dead-reckoning tick interval (ms) — ~12Hz, not per-frame. */

export const FLEET_DR_INTERVAL_MS = 80;

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

/** Bounded loading for the tracked model. Its driver runs every frame, so a
 *  missing or corrupt GLB, or a dead network, would otherwise ask for the
 *  model again for as long as the contact stays selected. Failures (the
 *  model set's `loadFailed`) are counted PER SELECTION: a short backoff
 *  absorbs a transient blip, then the layer stops asking until the operator
 *  selects something else. The icon is the visual throughout (the handoff
 *  only fades it once a model actually renders), so a latched failure
 *  degrades to exactly the pre-3D presentation. */

export const TRACKED_MODEL_MAX_LOAD_FAILS = 3;

export const TRACKED_MODEL_RETRY_BACKOFF_MS = 1500;

/** Alpha of a contact that has missed an update or lost its signal: the stale fade, for the fleet and the tracked aircraft alike. */
export const STALE_ALPHA = 0.45;
