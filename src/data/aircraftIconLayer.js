import {
  COAST_FLOOR_LIFT_M,
  COURSE_HOLD_SPEED_MPS,
  courseSlewCapDps,
  RECOVER_MIN_M,
  RECOVER_SNAP_M,
  recoveryMs,
} from './motionModel.js';
import { straightSegment } from './fixCurve.js';
import {
  norm180,
  distance,
  distanceSquared,
  clone,
  copyInto,
  toDegrees,
  vec,
} from '../geo/vector.js';
import { fromRadians, toCartographicRadians } from '../geo/ellipsoid.js';
import { horizonFrom, liftedForHorizon } from '../geo/horizon.js';
import { createIconBook } from '../render/motion/iconBook.js';
import { motionCourse, motionPosition } from '../render/motion/iconMotion.js';
import {
  drawOf,
  findCamera,
  findQuery,
  rendererOf,
} from '../render/rendererOf.js';
import { nearImageSwitchPx } from './iconAtlas.js';
import {
  aircraftIcon,
  FLEET_ICON_PX,
  TRACKED_ICON_PX,
} from './aircraftIcons.js';
import { cockpitContactDotImage } from './cockpitContactDot.js';
import { rotorFrame, rotorTurns } from './rotorFrames.js';
import { aircraftRecedeSpec } from './aircraftRecession.js';
import { TIMELINE_UNSEEN_MS } from '../time/timelineFixes.js';

/** Raster size of the cockpit contact pip (cockpitContactDot.js draws 16 px). */
const COCKPIT_DOT_PX = 16;
/** Fleet glyphs keep the established close-range 3× scale. */
/** A contact icon's size before its scale, CSS px. */
const FLEET_ICON_SIZE_PX = 20;
const NORMAL_SCALE_BY_DISTANCE = Object.freeze({
  near: 1000,
  nearValue: 3.0,
  far: 8000000,
  farValue: 0.5,
});
const COCKPIT_SCALE_BY_DISTANCE = Object.freeze({
  near: 1000,
  nearValue: 1.15,
  far: 8000000,
  farValue: 0.65,
});

let cockpitDot = null;
/**
 * The cockpit pip as an SVG of its own 16 px size around its PNG, so the
 * draw port rasterises it at 16 px (as the icon set did) rather than at its
 * few-pixel drawn size.
 */
function cockpitDotImage() {
  if (cockpitDot) return cockpitDot;
  const png = cockpitContactDotImage();
  const px = COCKPIT_DOT_PX;
  cockpitDot = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}"><image width="${px}" height="${px}" href="${png}"/></svg>`,
  )}`;
  return cockpitDot;
}

/** A colour as the draw contract's `[r, g, b, a]`, from `{red, green, blue, alpha}`. */
function rgba(color) {
  if (!color || typeof color === 'string' || Array.isArray(color)) return color;
  return [color.red, color.green, color.blue, color.alpha ?? 1];
}

/** Whether two plain values are the same, nested ones included. */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!same(a[key], b[key])) return false;
  return true;
}

/**
 * An aircraft layer's contact icons as it last drew them, over one icon
 * draw set: each contact's icon item by its id, until when its motion holds
 * (`render/motion/iconBook`), read back where it is drawn now. Writes go to
 * the draw set together once the current task ends, so restyling and
 * replanning a contact in one pass writes its item once.
 * @param {import('../render/contract/draw').DrawSet<object>|null} [drawSet]
 *   Where the icons are drawn; none keeps them only here (tests).
 * @param {{capabilities?: ReadonlySet<string>|null}} [options]
 */
export function createContactIcons(drawSet = null, { capabilities } = {}) {
  const book = createIconBook(null, { capabilities });
  const pending = new Map();
  const removed = new Set();
  // Ids not drawn whatever their item says: following the clock, the time
  // drawn is before the contact was there (`setUnseen`).
  const unseen = new Set();
  /** The item as the draw set takes it: hidden while unseen. */
  const drawnItem = (item) =>
    unseen.has(item.id) && item.show !== false
      ? { ...item, show: false }
      : item;
  // The ids the draw set holds.
  const sent = new Set();
  let queued = false;
  let disposed = false;
  let shown = true;

  function flush() {
    queued = false;
    if (!drawSet || disposed) return;
    if (pending.size) {
      const items = [...pending.values()];
      pending.clear();
      // A write the set refuses throws here; what it holds stays as it was.
      drawSet.upsert(items);
      for (const item of items) sent.add(item.id);
    }
    if (removed.size) {
      const ids = [...removed];
      removed.clear();
      for (const id of ids) sent.delete(id);
      drawSet.remove(ids);
    }
  }

  function schedule() {
    if (!drawSet || queued || disposed) return;
    queued = true;
    queueMicrotask(flush);
  }

  const icons = {
    /** The draw set's id, or null. */
    setId: drawSet?.id ?? null,
    get count() {
      return book.size;
    },
    get show() {
      return drawSet ? drawSet.show : shown;
    },
    set show(value) {
      if (drawSet) drawSet.show = value;
      else shown = value;
    },
    has: (id) => book.has(id),
    /** The drawn ids, in the order first drawn. */
    ids: () => book.ids(),
    item: (id) => book.item(id),
    /**
     * Until when (epoch ms on the display clock) an id's motion holds:
     * Infinity when planned to hold, -Infinity while never planned.
     */
    expires: (id) => book.expiresAt(id),
    /** The ids whose motion ran out by `t`, to plan afresh. */
    due: (t) => book.due(t),
    /** Where an id is drawn at `t` (into `result` when given), or null. */
    position(id, t, result) {
      const p = book.position(id, t);
      return p && result ? copyInto(p, result) : p;
    },
    course: (id, t) => book.course(id, t),
    shown: (id) => book.item(id)?.show !== false && !unseen.has(id),
    focus: (id) => book.focus(id),
    alpha: (id) => book.item(id)?.alpha ?? 1,
    scale: (id) => book.item(id)?.scale ?? 1,
    /** Draw an item as given (see `iconBook.put`). */
    put(item, options) {
      book.put(item, options);
      removed.delete(item.id);
      pending.set(item.id, drawnItem(item));
      schedule();
    },
    /**
     * Change some of an id's item; nothing is written when it already is
     * so (and `expiresAt`, when given, is what it has).
     * @returns {boolean} Whether anything was written.
     */
    update(id, patch, options = {}) {
      const item = book.item(id);
      if (!item) return false;
      let changed =
        options.expiresAt !== undefined &&
        options.expiresAt !== book.expiresAt(id);
      if (!changed)
        for (const key of Object.keys(patch))
          if (!same(item[key], patch[key])) {
            changed = true;
            break;
          }
      if (!changed) return false;
      icons.put({ ...item, ...patch }, options);
      return true;
    },
    setShown: (id, value) => icons.update(id, { show: value !== false }),
    /**
     * Keep an id from being drawn (true) whatever its item's `show` says, or
     * draw it as its item says again (false).
     */
    setUnseen(id, value) {
      const item = book.item(id);
      if (!item || unseen.has(id) === Boolean(value)) return;
      if (value) unseen.add(id);
      else unseen.delete(id);
      pending.set(id, drawnItem(item));
      schedule();
    },
    /** Whether an id is kept from being drawn (`setUnseen`). */
    unseen: (id) => unseen.has(id),
    setFocus: (id, factor) => icons.update(id, { focus: factor }),
    remove(id) {
      if (!book.has(id)) return;
      book.remove(id);
      unseen.delete(id);
      pending.delete(id);
      if (sent.has(id)) {
        removed.add(id);
        schedule();
      }
    },
    clear() {
      for (const id of book.ids()) book.remove(id);
      unseen.clear();
      pending.clear();
      removed.clear();
      sent.clear();
      if (drawSet && !disposed) drawSet.clear();
    },
    /** Write what is waiting now. */
    flush,
    dispose() {
      for (const id of book.ids()) book.remove(id);
      unseen.clear();
      pending.clear();
      removed.clear();
      sent.clear();
      disposed = true;
      drawSet?.dispose();
    },
  };
  return icons;
}

/** How far ahead (ms) a coast's ground is read each time it is planned. */
export const COAST_FLOOR_LOOKAHEAD_MS = 10_000;
/** How far apart (ms) the ground under a coast is read, and how long each
 *  piece of a coast the ground lifts runs. */
export const COAST_FLOOR_STEP_MS = 1_000;
/** A coast from above this height (m) never meets the ground: no terrain
 *  is this high, and a level coast only rises off the ellipsoid. */
const COAST_ABOVE_TERRAIN_M = 9_000;

/**
 * How far the ground lifts an icon at `position`: metres to raise it to
 * COAST_FLOOR_LIFT_M over the ground (0 or less: none), or null where the
 * ground is not known.
 */
function floorLift(position, cachedGroundFloor) {
  const carto = toCartographicRadians(position);
  if (!carto) return null;
  const ground = cachedGroundFloor(toDegrees(carto.lat), toDegrees(carto.lon));
  if (!Number.isFinite(ground)) return null;
  return ground + COAST_FLOOR_LIFT_M - carto.height;
}

/** `position` raised by `lift` metres (a copy). */
function raised(position, lift) {
  if (!(lift > 0)) return clone(position);
  const carto = toCartographicRadians(position);
  return fromRadians(carto.lon, carto.lat, carto.height + lift);
}

/**
 * A coast arc kept above the ground, as the CPU dead reckoning keeps it
 * (`floorCoastedPosition`): past its fix an icon never draws lower than
 * COAST_FLOOR_LIFT_M over the ground the layer's floor cache knows. The
 * renderer cannot read that ground, so the coast is planned in pieces from
 * the ground read along it:
 * - clear of the ground for the lookahead, the arc as it is, planned again
 *   when the lookahead runs out (or never, with the ground known to the
 *   coast's end);
 * - meeting the ground further on, the arc until a step before it;
 * - where the ground lifts it within a step, a piece of the same arc from
 *   where it is drawn now, lifted, climbing to where the ground puts it a
 *   step on;
 * - with the coast over, held where it stopped, lifted.
 * Before its fix (a warm-up), an arc runs as it is until the fix.
 * @param {object} arc The coast's `arc` motion segment.
 * @param {number} t The display instant, epoch ms on the set's motion clock.
 * @param {(latDeg: number, lonDeg: number) => number|null} cachedGroundFloor
 * @returns {{motion?: object, pos?: object, course?: number, expiresAt: number}|null}
 *   A replacement motion where the ground lifts the icon, and until when the
 *   plan holds; null when the ground never matters to this arc.
 */
export function floorCoastArc(arc, t, cachedGroundFloor) {
  if (!(arc.maxDtS > 0) || typeof cachedGroundFloor !== 'function') return null;
  const fixCarto = toCartographicRadians(arc.fix);
  if (
    fixCarto &&
    fixCarto.height > COAST_ABOVE_TERRAIN_M &&
    !((arc.climbMps ?? 0) < 0)
  )
    return null;
  const end = arc.t0 + arc.maxDtS * 1000;
  if (t >= end) {
    // The coast is over: it holds where it stopped.
    const stopped = motionPosition(arc, null, end);
    const lift = floorLift(stopped, cachedGroundFloor);
    if (lift === null) return { expiresAt: t + COAST_FLOOR_LOOKAHEAD_MS };
    if (!(lift > 0)) return { expiresAt: Infinity };
    const courseDeg = motionCourse(arc, undefined, end);
    return {
      motion: { kind: 'hold', courseDeg },
      pos: raised(stopped, lift),
      course: courseDeg,
      expiresAt: Infinity,
    };
  }
  const start = Math.max(t, arc.t0);
  const horizon = Math.min(end, start + COAST_FLOOR_LOOKAHEAD_MS);
  let unknown = false;
  let belowAt = null;
  for (let at = start; ; at = Math.min(at + COAST_FLOOR_STEP_MS, horizon)) {
    const lift = floorLift(motionPosition(arc, null, at), cachedGroundFloor);
    if (lift === null) unknown = true;
    else if (lift > 0) {
      belowAt = at;
      break;
    }
    if (at >= horizon) break;
  }
  if (belowAt === null)
    return {
      expiresAt:
        horizon < end || unknown ? start + COAST_FLOOR_LOOKAHEAD_MS : Infinity,
    };
  // A warm-up runs to its fix as it is; the coast is read again from there.
  if (t < arc.t0)
    return { expiresAt: Math.max(arc.t0, belowAt - COAST_FLOOR_STEP_MS) };
  if (belowAt - COAST_FLOOR_STEP_MS > t)
    return { expiresAt: belowAt - COAST_FLOOR_STEP_MS };
  // The ground lifts it within a step: a piece from here to a step on.
  const next = Math.min(t + COAST_FLOOR_STEP_MS, end);
  const here = motionPosition(arc, null, t);
  const there = motionPosition(arc, null, next);
  const from = raised(here, floorLift(here, cachedGroundFloor) ?? 0);
  const to = raised(there, floorLift(there, cachedGroundFloor) ?? 0);
  const seconds = (next - t) / 1000;
  const climbMps =
    seconds > 0
      ? (toCartographicRadians(to).height -
          toCartographicRadians(from).height) /
        seconds
      : 0;
  const courseDeg = motionCourse(arc, undefined, t);
  return {
    motion: {
      kind: 'arc',
      fix: from,
      t0: t,
      minDtS: 0,
      // On to the coast's end, should the next piece come late.
      maxDtS: (end - t) / 1000,
      speedMps: arc.speedMps,
      trackDeg: courseDeg,
      turnRateDps: arc.turnRateDps,
      climbMps,
    },
    pos: from,
    course: courseDeg,
    expiresAt: next,
  };
}

let instances = 0;

/** A plan that ran out longer ago than this (ms) is not eased away from. */
const RECOVER_STALE_PLAN_MS = 1_000;

/** How far ahead (ms) a placed contact's segment runs before it is asked
 *  again, in view and near the eye. */
const PLACED_PLAN_MS = 1000;
/** The same out of view, or farther than PLACED_NEAR_M from the eye: off
 *  screen a contact's path is not seen, and that far a straight segment
 *  over this long (half as long again at most, as spread) is well under a
 *  pixel off it. Asking for each contact every second would rewrite the
 *  whole fleet every second. */
const PLACED_FAR_PLAN_MS = 4000;
/** Nearer the eye than this (m), a placed contact in view is planned every
 *  PLACED_PLAN_MS. */
const PLACED_NEAR_M = 300_000;

/**
 * Each contact's plans run between 1/2 and 3/2 of their length, by its id,
 * so the fleet's plans run out spread over the passes, not together in one
 * (contacts first planned in the same pass would otherwise stay in step).
 */
export function placedPlanSpread(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 0.5 + ((hash >>> 0) % 1024) / 1024;
}

/** A display delay that never changes (ms). */
function fixedDelay(ms) {
  return { currentMs: ms, step: () => ms };
}

/**
 * An aircraft layer's contacts as one icon draw set: each item's motion
 * segment mirrors the layer's dead reckoning for the delayed display time,
 * so the renderer moves every untracked contact between polls with no
 * per-frame CPU pass. The layer keeps what it drew in `state._icons`
 * (`createContactIcons`) and reads positions, courses, focus and expiry back
 * from there.
 *
 * The layer's state supplies `_icons`, `_iconFocusActive`,
 * `_positionHistory`, `_displayCourse`, `_groundSnap`, `_models`,
 * `_trackedIcao`, `_viewer`, `_cockpitContactMode`, `_cockpitNearContacts`
 * and `records` (`data`, `missingPolls`, `forget`). `parts.motion` supplies
 * `_motionRegime`, `_displayTimeAt` and `_fixEpochMs`; `parts.rendering`
 * the icon kind, scale, colours, and `_releaseModel`.
 *
 * @param {object} options
 * @param {object} options.state The layer's mutable state.
 * @param {object} options.services The layer's services (`focus`).
 * @param {object} options.parts The layer's parts (`motion`, `rendering`).
 * @param {string} options.layerId Pick and focus owner id.
 * @param {{currentMs: number, step: (nowMs: number) => number}} [options.displayDelay]
 *   How far behind real time contacts draw (`data/displayDelay`), stepped
 *   once a frame; the renderer's motion clock follows it.
 * @param {number} [options.renderDelaySec] A fixed delay instead.
 * @param {() => boolean} [options.followsClock] True while the layer follows
 *   the world clock: contacts draw at the world's time (`state.now()`, the
 *   scene's time) with no delay.
 * @param {number} [options.staleAlpha] A contact's alpha after a missed update.
 * @param {number} options.courseMaxDps The fleet's course slew cap.
 * @param {number} options.cockpitContactSizePx Cockpit far-contact pip size.
 * @param {(icao24: string) => boolean} [options.holdsPlan] True while something
 *   else writes this row's segment (it is not planned).
 * @param {(icao24: string) => void} [options.beforeSettle] Runs before a row is
 *   planned afresh.
 * @param {(icao24: string) => void} [options.afterSettle] Runs after it.
 * @param {(icao24: string) => void} [options.onForget] Drops the layer's own
 *   per-contact state when a contact goes.
 * @param {((icao24: string, wallMs: number, info: object|undefined,
 *   history: object[], out: {x: number, y: number, z: number}) =>
 *   {courseDeg: number, speedMps: number}|null)|null} [options.placeAt]
 *   Where a host-supplied placement draws a live contact at a wall time,
 *   written into `out` (`placeAircraftAt`), or null when it does not place
 *   it; none without a placement.
 */
export function createAircraftIcons({
  state,
  services,
  parts,
  layerId,
  renderDelaySec = 0,
  displayDelay = fixedDelay(renderDelaySec * 1000),
  followsClock = () => false,
  staleAlpha = 0.45,
  courseMaxDps,
  cockpitContactSizePx,
  holdsPlan = () => false,
  beforeSettle = () => {},
  afterSettle = () => {},
  onForget = () => {},
  placeAt = null,
}) {
  const { focusPassIsNeeded } = services.focus;
  // The near-image switch the rows were last written with (CSS px).
  let switchPx = nearImageSwitchPx(1);
  /**
   * Airborne helicopters drawn as their glyph, whose rotor turns: the rotor
   * frame each was last drawn at, and the frame it was last judged at
   * (`_turnRotors`), so one out of view is judged again only once its frame
   * has stepped on.
   * @type {Map<string, {drawn: number, checked: number}>}
   */
  const rotors = new Map();
  /** When a rotor in view was last given a new frame (wall ms). */
  let rotorDrawnAtMs = -Infinity;

  /** The delayed instant (epoch ms) every untracked contact is drawn at. */
  const _displayMs = () =>
    followsClock() ? state.now() : Date.now() - displayDelay.currentMs;
  /** The live draw set, whether its motion clock is the scene's, and the
   *  delay its live clock was last given. */
  let liveSet = null;
  let sceneClock = false;
  let sentDelayMs = NaN;
  // The `recede` the set was last sent.
  let sentRecede = null;
  /**
   * From when (display ms) each planned row's motion holds: a row whose
   * motion starts after the time drawn is planned again when the time moves
   * back before it (`_replanExpired`).
   */
  const planFrom = new Map();
  /** When each placed contact's running ease ends (epoch ms): a new answer
   *  while it runs eases on from where it is drawn instead of cutting it. */
  const easeEnds = new Map();
  /** The display time the rows were last checked against. */
  let replannedAt = -Infinity;

  /** The motion clock for whether the layer follows the world clock. */
  const motionClock = (scene) =>
    scene
      ? { kind: 'scene' }
      : // The layer's pace asks for the frames its moving rows need.
        { kind: 'live', delayMs: displayDelay.currentMs, frames: 'owner' };

  /**
   * Once a frame: move the display delay on, and put the set's motion on
   * the scene's clock (the world's time) while the layer follows the world
   * clock, on the delayed live clock otherwise, with the delay as it is now.
   */
  function _syncMotionClock() {
    const scene = followsClock();
    if (!scene) displayDelay.step(Date.now());
    if (!liveSet) return;
    if (
      scene === sceneClock &&
      (scene || sentDelayMs === displayDelay.currentMs)
    )
      return;
    sceneClock = scene;
    sentDelayMs = scene ? NaN : displayDelay.currentMs;
    liveSet.setOptions({ motionClock: motionClock(scene) });
  }

  /** The set recedes by the aircraft tuning: sent again when it changes. */
  function _syncRecede() {
    if (!liveSet) return;
    const recede = aircraftRecedeSpec();
    if (recede === sentRecede) return;
    sentRecede = recede;
    liveSet.setOptions({ recede });
  }

  /**
   * Create the draw set for one layer lifetime, drawn over depth, culled at
   * the horizon and receding toward the limb on the delayed live clock,
   * stacked by the sprite order.
   * @returns {string} The set's id.
   */
  function _createIcons(viewer) {
    sentRecede = aircraftRecedeSpec();
    const set = drawOf(viewer).icons({
      id: `${layerId}-icons:${++instances}`,
      horizonCull: true,
      recede: sentRecede,
      motionClock: motionClock(followsClock()),
      drawOrder: services.sprites?.spriteDrawOrder?.(layerId) ?? 0,
    });
    // Columns of no rows put the set's host in the scene now, rather than
    // with its first contact.
    set.setColumns?.({ ids: [] });
    liveSet = set;
    sceneClock = followsClock();
    sentDelayMs = sceneClock ? NaN : displayDelay.currentMs;
    switchPx = _imageSwitchPx(viewer);
    state._icons = createContactIcons(set, {
      capabilities: rendererOf(viewer)?.capabilities ?? null,
    });
    return set.id;
  }

  /** Let the draw set go (the layer is destroyed). */
  function _disposeIcons() {
    state._icons?.dispose();
    state._icons = null;
    liveSet = null;
    rotors.clear();
    planFrom.clear();
    easeEnds.clear();
    placedPlans.clear();
    replannedAt = -Infinity;
  }

  /** The near-image switch in CSS px for the scene's pixel ratio. */
  function _imageSwitchPx(viewer = state._viewer) {
    return nearImageSwitchPx(
      rendererOf(viewer)?.quality?.get?.()?.pixelRatio ?? 1,
    );
  }

  /** Rewrite every row's image switch when the scene's pixel ratio moved. */
  function _syncImageSwitch() {
    const next = _imageSwitchPx();
    if (next === switchPx || !state._icons) return;
    switchPx = next;
    for (const id of state._icons.ids()) _applyIconPresentation(id);
  }

  /** Where a contact is drawn right now (into `result`), or null. */
  function _iconPosition(icao24, result) {
    return state._icons?.position(icao24, _displayMs(), result) ?? null;
  }

  /** The nose direction a contact is drawn with right now. */
  function _iconCourse(icao24) {
    return state._icons?.course(icao24, _displayMs()) ?? null;
  }

  /** Whether the layer draws this contact's icon (not tracked, not model-owned). */
  function _iconShown(icao24) {
    const icons = state._icons;
    return Boolean(icons?.has(icao24) && icons.shown(icao24));
  }

  /** Show or hide a contact's icon. */
  function _setIconShown(icao24, shown) {
    state._icons?.setShown(icao24, shown);
  }

  /** The ellipsoid's horizon from the eye, or null with no placed camera. */
  function _occluder() {
    const pose = state._viewer ? findCamera(state._viewer)?.pose() : null;
    return pose?.position ? horizonFrom(pose.position) : null;
  }

  /**
   * Whether an icon drawn at `position` clears the camera's horizon, judged
   * as the draw port's horizon cull judges it (lifted to the cull height
   * when drawn below it). No camera, no horizon.
   */
  function _aboveHorizon(position, occluder) {
    return !occluder || occluder.isPointVisible(liftedForHorizon(position));
  }

  /**
   * Write the motion the layer's dead reckoning would follow from now on:
   * interpolation between the bracketing fixes, the warm-up arc back from the
   * oldest fix, or the coast arc past the newest. The displayed nose glides
   * from where it is onto the new course at the fleet's slew cap; a hovering
   * contact keeps its nose. The item expires when the regime would change.
   * Following the clock, a contact not there yet at the time drawn
   * (`regime.unseen`) is not drawn until its warm-up begins.
   * @param {string} icao24
   * @param {{fromCourseDeg?: number|null, rewound?: boolean,
   *   handover?: boolean}} [options]
   *   `fromCourseDeg`: nose to glide from when the row's own motion is not
   *   what was on screen (tracking handoff). `rewound`: the time drawn moved
   *   back before the row's motion; it is drawn where it was then, with no
   *   easing from where it is drawn now. `handover`: the clock came back to
   *   live and this is the contact's first live fix: it eases from where it
   *   is drawn onto its live path, however its last plan ran out.
   */
  function _planIcon(
    icao24,
    { fromCourseDeg, rewound = false, handover = false } = {},
  ) {
    const icons = state._icons;
    if (!icons?.has(icao24) || holdsPlan(icao24)) return;
    const history = state._positionHistory.get(icao24);
    if (!history?.length) return;
    const info = state.records.data.get(icao24);
    const t = _displayMs();
    const renderTime = parts.motion._displayTimeAt(t);
    const fixMs = parts.motion._fixEpochMs;
    const shownCourse =
      fromCourseDeg ??
      (icons.expires(icao24) === -Infinity ? null : icons.course(icao24, t));

    // A host-supplied placement decides where a live contact is drawn; with
    // none, or no answer for this contact, the layer's own motion below does.
    if (_planPlaced(icao24, info, history, t, handover)) return;

    const regime = parts.motion._motionRegime(history, info, renderTime);
    if (regime.unseen) {
      // Held at its first fix, not drawn, until its warm-up begins.
      const course = regime.heading;
      icons.setUnseen(icao24, true);
      icons.update(
        icao24,
        {
          pos: clone(regime.fix.position),
          course,
          motion: { kind: 'hold', courseDeg: course },
          courseGlide: undefined,
        },
        { expiresAt: fixMs(regime.fix) - TIMELINE_UNSEEN_MS },
      );
      planFrom.set(icao24, -Infinity);
      return;
    }
    icons.setUnseen(icao24, false);
    let speed;
    let motion;
    let pos;
    let course;
    let expiresAt = Infinity;
    // From when the motion holds: before it, the time drawn has moved back.
    let validFrom = t;
    if (regime.kind === 'between' && regime.piece) {
      // Along the curve between the two reports, a piece at a time.
      const segment = regime.piece.segment;
      speed = segment.speedMps;
      motion = { ...segment, fix: clone(segment.fix) };
      pos = clone(segment.fix);
      course = motionCourse(motion, undefined, t);
      expiresAt = regime.piece.t1;
      validFrom = regime.piece.t0;
    } else if (regime.kind === 'between') {
      const { a, b, span, trackFrom, trackTo, chordCourse } = regime;
      speed = regime.speed;
      const blend = chordCourse == null ? 0 : regime.blend;
      pos = clone(b.position);
      if (span > 0) {
        course = trackFrom + blend * norm180((chordCourse ?? 0) - trackFrom);
        motion = {
          kind: 'lerp',
          from: clone(a.position),
          to: pos,
          t0: fixMs(a),
          t1: fixMs(b),
          course0Deg: course,
          courseSlopeDeg: norm180(trackTo - trackFrom) * (1 - blend),
        };
      } else {
        course = trackTo + blend * norm180((chordCourse ?? 0) - trackTo);
        motion = { kind: 'hold', courseDeg: course };
      }
      expiresAt = fixMs(b);
      validFrom = fixMs(a);
    } else {
      const { fix, heading } = regime;
      speed = regime.speed;
      const t0 = fixMs(fix);
      // A warm-up runs back to its start (a contact following the clock on
      // its own fixes is unseen before that); a coast holds from its fix.
      validFrom =
        regime.maxDt === 0 && t0 > t
          ? history[0].timeline === true
            ? t0 - TIMELINE_UNSEEN_MS
            : -Infinity
          : t0;
      pos = clone(fix.position);
      course = heading;
      motion =
        speed === 0
          ? { kind: 'hold', courseDeg: heading }
          : {
              kind: 'arc',
              fix: pos,
              t0,
              minDtS: regime.minDt,
              maxDtS: regime.maxDt,
              speedMps: speed,
              trackDeg: heading,
              turnRateDps: regime.turnRateDps,
            };
      // A warm-up's arc ends at its fix, still ahead; a coast's runs to its
      // limit, and a report that holds stays put until the next one.
      if (regime.maxDt === 0 && t0 > t) expiresAt = t0;
      // Past its fix a coast never goes below the ground.
      if (motion.kind === 'arc') {
        const floored = floorCoastArc(
          motion,
          t,
          services.groundFloor?.cachedGroundFloor,
        );
        if (floored) {
          if (floored.motion) {
            motion = floored.motion;
            pos = floored.pos;
            course = floored.course;
            validFrom = t;
          }
          expiresAt = Math.min(expiresAt, floored.expiresAt);
        }
      }
    }
    // A new report that puts a moving contact somewhere else than it is
    // drawn now (it was coasting past its newest report): it eases from
    // where it is onto the new path instead of jumping, unless that is
    // farther than a jump would be anyway.
    // Only a row on screen whose plan is still running (a hidden row, or one
    // whose motion ran out long ago, is simply drawn where it is now).
    if (
      fromCourseDeg == null &&
      !rewound &&
      icons.shown(icao24) &&
      (handover || icons.expires(icao24) > t - RECOVER_STALE_PLAN_MS)
    ) {
      const prev = icons.item(icao24);
      const drawn = motionPosition(prev.motion, prev.pos, t);
      const next = motionPosition(motion, pos, t);
      const errorM = distance(drawn, next);
      if (
        errorM > RECOVER_MIN_M &&
        errorM < RECOVER_SNAP_M &&
        speed >= COURSE_HOLD_SPEED_MPS &&
        !same(prev.motion, motion)
      ) {
        const end = t + recoveryMs(errorM, speed);
        // Where the new path has it by then, past this plan if need be.
        const target = parts.motion._deadReckon(
          icao24,
          vec(),
          parts.motion._displayTimeAt(end),
        );
        motion = straightSegment(drawn, t, end, target ?? next);
        pos = clone(drawn);
        course = motionCourse(motion, undefined, t);
        expiresAt = end;
        validFrom = t;
      }
    }
    // Below hover speed the nose holds what is on screen (or, for a new row,
    // where this motion starts); above it, it glides on at the slew cap.
    const hold = speed < COURSE_HOLD_SPEED_MPS;
    let courseGlide;
    if (hold || shownCourse != null) {
      const rateDps = hold ? 0 : courseSlewCapDps(speed, courseMaxDps);
      const prev = icons.item(icao24);
      // The same motion at the same rate: the glide under way goes on, as
      // one started now from the course on screen would.
      courseGlide =
        fromCourseDeg == null &&
        prev?.courseGlide?.rateDps === rateDps &&
        same(prev.motion, motion)
          ? prev.courseGlide
          : {
              fromCourseDeg: shownCourse ?? motionCourse(motion, course, t),
              t0: t,
              rateDps,
            };
    }
    icons.update(icao24, { pos, course, motion, courseGlide }, { expiresAt });
    planFrom.set(icao24, validFrom);
  }

  /** Each placed contact's last placed plan or ease: when it ends (display
   *  ms), the wall time that stands for, and where it ends. */
  const placedPlans = new Map();

  /** The camera, while the fleet pass re-plans the rows that ran out:
   *  `{eye, inView(position)}` (null: every plan is a near one). */
  let planView = null;

  /** How long a placed contact at `position` is planned for (ms). */
  function _placedPlanMs(icao24, position) {
    const near =
      !planView ||
      (distanceSquared(planView.eye, position) <
        PLACED_NEAR_M * PLACED_NEAR_M &&
        planView.inView(position));
    return (
      (near ? PLACED_PLAN_MS : PLACED_FAR_PLAN_MS) * placedPlanSpread(icao24)
    );
  }

  /**
   * Whether a new report moved where a placed contact's last placed plan
   * ends: the placement asked again for that plan's end (the same wall time)
   * puts it more than a recovery's least from where the plan ends. Only
   * while that plan is still the row's (its end unchanged).
   */
  function _placementMoved(icao24, info, history) {
    const plan = placedPlans.get(icao24);
    if (!plan || state._icons.expires(icao24) !== plan.expiresAt) return false;
    const now = vec();
    if (!placeAt(icao24, plan.wallMs, info, history, now)) return false;
    return distance(now, plan.at) > RECOVER_MIN_M;
  }

  /**
   * Plan a live contact a host-supplied placement places: from where it
   * places it at `t` (display ms, the live clock's delayed time) to where it
   * places it a plan's length on (`_placedPlanMs`), asked again when that
   * runs out. Display time is wall time less the display delay, so the
   * placement is asked at the wall times the segment's ends stand for.
   * @returns {boolean} False when there is no placement, the layer follows
   *   the world clock, or it has no answer for this contact.
   */
  function _planPlaced(icao24, info, history, t, handover = false) {
    if (!placeAt || followsClock()) return false;
    const leadMs = displayDelay.currentMs;
    const from = vec();
    const start = placeAt(icao24, t + leadMs, info, history, from);
    if (!start) return false;
    const { courseDeg: course } = start;
    // Back at live, while an ease runs, or when a new report moved where its
    // last placed plan has it, it eases on from where it is drawn: a
    // correction is never drawn as a jump. Its first placed plan draws it
    // where it is placed.
    const easing = easeEnds.get(icao24) > t;
    const moved =
      !handover && !easing && _placementMoved(icao24, info, history);
    if (
      (handover || easing || moved) &&
      _easePlaced(icao24, info, history, t, from, start)
    )
      return true;
    easeEnds.delete(icao24);
    const t1 = t + _placedPlanMs(icao24, from);
    const to = vec();
    const end = placeAt(icao24, t1 + leadMs, info, history, to);
    // Shown and going on from its last placed plan, nothing moved, it starts
    // where that is drawn: the pass came a little after it ended, or the
    // display delay moved since it was asked, and either is taken up over
    // this plan, never drawn as a step. It still ends where it is placed. (A
    // hidden row, or one with no end to go to, is drawn where it is placed.)
    const last = placedPlans.get(icao24);
    if (
      end &&
      !moved &&
      last &&
      state._icons.expires(icao24) === last.expiresAt &&
      state._icons.shown(icao24)
    ) {
      const prev = state._icons.item(icao24);
      const drawn = prev && motionPosition(prev.motion, prev.pos, t);
      if (drawn && distance(drawn, from) < RECOVER_SNAP_M)
        copyInto(drawn, from);
    }
    const motion = end
      ? {
          kind: 'lerp',
          from,
          to,
          t0: t,
          t1,
          course0Deg: course,
          courseSlopeDeg: norm180(end.courseDeg - course),
        }
      : { kind: 'hold', courseDeg: course };
    state._icons.setUnseen(icao24, false);
    state._icons.update(
      icao24,
      { pos: clone(from), course, motion, courseGlide: undefined },
      { expiresAt: t1 },
    );
    planFrom.set(icao24, t);
    if (end)
      placedPlans.set(icao24, {
        expiresAt: t1,
        wallMs: t1 + leadMs,
        at: clone(to),
      });
    else placedPlans.delete(icao24);
    return true;
  }

  /**
   * Back at live, a placed contact still on screen eases from where it is
   * drawn onto where it is placed, as the layer's own motion recovers (and a
   * new answer while that ease runs eases on from where it is then): along
   * the straight line to where the placement has it when the ease ends, nose
   * along that line, unless it is nearer than a recovery or farther than a
   * jump would be.
   * @returns {boolean} Whether the contact was planned to ease.
   */
  function _easePlaced(icao24, info, history, t, placed, start) {
    const icons = state._icons;
    if (!icons.shown(icao24)) return false;
    const prev = icons.item(icao24);
    const drawn = motionPosition(prev.motion, prev.pos, t);
    const errorM = distance(drawn, placed);
    if (!(errorM > RECOVER_MIN_M && errorM < RECOVER_SNAP_M)) return false;
    const speed = start.speedMps ?? info?.velocity ?? 0;
    const end = t + recoveryMs(errorM, speed);
    const target = vec();
    if (!placeAt(icao24, end + displayDelay.currentMs, info, history, target))
      return false;
    const motion = straightSegment(drawn, t, end, target);
    const course = motionCourse(motion, undefined, t);
    icons.setUnseen(icao24, false);
    icons.update(
      icao24,
      { pos: clone(drawn), course, motion, courseGlide: undefined },
      { expiresAt: end },
    );
    planFrom.set(icao24, t);
    easeEnds.set(icao24, end);
    placedPlans.set(icao24, {
      expiresAt: end,
      wallMs: end + displayDelay.currentMs,
      at: clone(target),
    });
    return true;
  }

  /**
   * Re-plan every row whose regime ended by `t` (epoch ms), and, following
   * the clock, every row whose motion starts after `t` once the time drawn
   * moved back (a seek, or the clock run backward): it is drawn where it was
   * then, as it is when the time moves on.
   */
  function _replanExpired(t, view = null) {
    planView = view;
    try {
      if (followsClock() && t < replannedAt)
        for (const [icao24, from] of planFrom)
          if (from > t) _planIcon(icao24, { rewound: true });
      replannedAt = t;
      for (const icao24 of state._icons.due(t)) _planIcon(icao24);
    } finally {
      planView = null;
    }
  }

  /**
   * Advance focus de-emphasis for every drawn row (and every row a fleet model
   * draws for, whose alpha reads it), only while a focus target exists or some
   * row is still relaxing back to full emphasis. Each row whose emphasis moved
   * is written as its item.
   */
  function _focusIcons(t, nowMs, target) {
    if (!focusPassIsNeeded(target, state._iconFocusActive)) return;
    const {
      advanceSpriteFocus,
      focusAlphaNeedsWrite,
      nearFarScalarValueAtDistance,
      spriteFocusAtRest,
    } = services.focus;
    const icons = state._icons;
    const viewer = state._viewer;
    const query = viewer ? findQuery(viewer) : null;
    const eye = viewer ? findCamera(viewer)?.pose()?.position : null;
    let active = 0;
    let fading = 0;
    for (const id of icons.ids()) {
      if (!icons.shown(id) && !state._models.has(id)) continue;
      const item = icons.item(id);
      const current = item.focus ?? 1;
      // Nothing tracked and nothing pending: it stays at full emphasis.
      if (!target && current === 1 && spriteFocusAtRest(item.meta)) continue;
      const position = icons.position(id, t);
      const cameraDistance = eye ? distance(eye, position) : Number.NaN;
      const distanceScale = nearFarScalarValueAtDistance(
        item.scaleByDistance,
        cameraDistance,
      );
      const half = (item.scale ?? 1) * distanceScale * 0.5;
      const focus = advanceSpriteFocus(item.meta, {
        screenPosition: query?.project(position) ?? null,
        cameraDistance,
        nowMs,
        target,
        spriteHalfWidthPx: item.size[0] * half,
        spriteHalfHeightPx: item.size[1] * half,
      });
      if (focus.active || focus.transitioning) active++;
      if (focus.transitioning) fading++;
      if (focusAlphaNeedsWrite(current, focus.factor))
        icons.setFocus(id, focus.factor);
    }
    state._iconFocusActive = active;
    // Rows still fading in or out, for the layer's pace.
    state._iconFocusFading = fading;
  }

  /**
   * How a contact's icon is drawn outside Cockpit: its image (and the sharper
   * one it switches to up close), size, scale and scale by distance. The
   * tracked contact's own icon is drawn with this too, so selecting a contact
   * changes its colour and nothing else.
   * @param {string} icao24
   * @param {object} [info] Its record.
   * @returns {{image: string, imageLod: {near: string, switchPx: number},
   *   size: [number, number], scale: number, scaleByDistance: object}}
   */
  function _fleetLook(
    icao24,
    info = state.records.data.get(icao24),
    frame = _rotorFrameOf(icao24, info, Date.now()),
  ) {
    const rendering = parts.rendering;
    return {
      image: aircraftIcon(
        rendering._iconKind(icao24, info?.klass),
        FLEET_ICON_PX,
        frame,
      ),
      imageLod: {
        near: aircraftIcon(
          rendering._iconKind(icao24, info?.klass),
          TRACKED_ICON_PX,
          frame,
        ),
        switchPx,
      },
      size: [FLEET_ICON_SIZE_PX, FLEET_ICON_SIZE_PX],
      scale: rendering._fleetBillboardScale(icao24),
      scaleByDistance: NORMAL_SCALE_BY_DISTANCE,
    };
  }

  /**
   * The rotor frame a contact draws at `nowMs` (`rotorFrames.js`): a
   * helicopter's, which holds still on the ground unless it taxis; undefined
   * for every other kind.
   */
  function _rotorFrameOf(icao24, info, nowMs) {
    if (parts.rendering._iconKind(icao24, info?.klass) !== 'helicopter')
      return undefined;
    return rotorFrame(icao24, nowMs, _rotorState(info));
  }

  /** What turns a contact's rotor: whether it is grounded, and its speed (m/s). */
  function _rotorState(info) {
    const speed = info?.velocity ?? info?.speedMps;
    return {
      onGround: info?.onGround === true,
      speedMps: Number.isFinite(speed) ? speed : null,
    };
  }

  /**
   * Turn the rotors of the airborne helicopters in view: each one's images
   * are written again only when its rotor frame changed (`ROTOR_FPS`, run
   * from the fleet pass). One out of view, below the horizon, or hidden for
   * its 3D model keeps its frame. The tracked one is drawn by the tracked
   * icon, which is given its new images. With no airborne helicopter drawn
   * this does nothing.
   * @param {number} nowMs Epoch ms the frame is chosen at.
   * @param {number} t The display instant, epoch ms (where icons are drawn).
   * @param {((position: {x: number, y: number, z: number}) => boolean)|null}
   *   [inView] Whether a position is in the camera's view; none: all are.
   */
  function _turnRotors(nowMs, t, inView = null) {
    const icons = state._icons;
    if (!rotors.size || !icons) return;
    let occluder;
    for (const [id, rotor] of rotors) {
      const frame = rotorFrame(id, nowMs);
      // Drawn at this frame, or already judged at it: nothing to do.
      if (frame === rotor.drawn || frame === rotor.checked) continue;
      rotor.checked = frame;
      const tracked = id === state._trackedIcao;
      if (!icons.has(id) || (!tracked && !icons.shown(id))) continue;
      const position = icons.position(id, t);
      if (!position) continue;
      if (occluder === undefined) occluder = _occluder();
      if (!_aboveHorizon(position, occluder)) continue;
      if (inView && !inView(position)) continue;
      rotor.drawn = frame;
      rotorDrawnAtMs = nowMs;
      if (tracked) {
        parts.tracking?._syncTrackedBillboardImage?.();
        continue;
      }
      const { image, imageLod } = _fleetLook(
        id,
        state.records.data.get(id),
        frame,
      );
      icons.update(id, { image, imageLod });
    }
  }

  /** Image, size, scale, tint and freshness for one row under the current
   *  normal/cockpit contract. Motion and course stay with `_planIcon`. */
  function _applyIconPresentation(icao24) {
    const icons = state._icons;
    if (!icons?.has(icao24)) return;
    const rendering = parts.rendering;
    const info = state.records.data.get(icao24);
    const tracked = icao24 === state._trackedIcao;
    const cockpitDot =
      state._cockpitContactMode &&
      !tracked &&
      !state._cockpitNearContacts.has(icao24);
    const look = cockpitDot
      ? {
          image: cockpitDotImage(),
          imageLod: undefined,
          size: [cockpitContactSizePx, cockpitContactSizePx],
          scale: 1,
          scaleByDistance: COCKPIT_SCALE_BY_DISTANCE,
          color: rgba(rendering._cockpitContactColor(icao24, info)),
          rotationMode: 'screen',
        }
      : {
          ..._fleetLook(icao24, info),
          color: rgba(rendering._fleetBillboardColor(icao24, info)),
          rotationMode: 'course',
        };
    // A ground station's mast stands upright.
    if (!cockpitDot && info?.klass === 'station') {
      look.rotationMode = 'screen';
      look.rotation = 0;
    }
    look.alpha = state.records.missingPolls.get(icao24) ? staleAlpha : 1;
    icons.update(icao24, look);
    // An airborne helicopter drawn as its glyph turns its rotor.
    const frame = cockpitDot
      ? undefined
      : _rotorFrameOf(icao24, info, Date.now());
    if (frame === undefined || !rotorTurns(_rotorState(info))) {
      // A tracked helicopter that lands shows the still frame at once.
      if (rotors.delete(icao24) && tracked)
        parts.tracking?._syncTrackedBillboardImage?.();
    } else rotors.set(icao24, { drawn: frame, checked: frame });
  }

  /** Whether any airborne helicopter's rotor turns (`_turnRotors` has work). */
  function _rotorsTurning() {
    return rotors.size > 0;
  }

  /** When a rotor in view was last given a new frame (wall ms), for the pace. */
  function _rotorDrawnAtMs() {
    return rotorDrawnAtMs;
  }

  /** Add a row for a new contact, hidden while it is the tracked one. */
  function _addIcon(icao24) {
    state._icons.put(_baseItem(icao24, icao24 !== state._trackedIcao), {
      expiresAt: -Infinity,
    });
    _applyIconPresentation(icao24);
    _settleIcon(icao24);
  }

  /** A new contact's item before it is styled or planned: at the origin. */
  function _baseItem(icao24, show) {
    return baseContactItem(layerId, icao24, show);
  }

  /**
   * Plan a row afresh, with the layer's own settle work on either side, and
   * let a dimmed row relax: one that sat out the focus pass (tracked) may come
   * back dimmed after the pass went idle, so it is counted to run the pass.
   * @param {string} icao24
   * @param {{fromCourseDeg?: number}} [options] The course on screen to glide from.
   */
  function _settleIcon(icao24, options) {
    const icons = state._icons;
    if (!icons?.has(icao24)) return;
    beforeSettle(icao24);
    if (icons.focus(icao24) < 1) state._iconFocusActive += 1;
    _planIcon(icao24, options);
    afterSettle(icao24);
  }

  /** Drop a contact and everything the layer keeps for it. */
  function _forgetContact(icao24) {
    state._icons?.remove(icao24);
    rotors.delete(icao24);
    planFrom.delete(icao24);
    easeEnds.delete(icao24);
    placedPlans.delete(icao24);
    parts.rendering._releaseModel(icao24);
    state.records.forget(icao24);
    // The host-supplied placement, if any, forgets it as well.
    services.placement?.forget(icao24);
    state._positionHistory.delete(icao24);
    state._displayCourse.delete(icao24);
    state._groundSnap.forget(icao24);
    onForget(icao24);
  }

  /** Icon ids, so ray samples never land on an aircraft instead of the ground. */
  function _iconIds() {
    return state._icons?.ids() ?? [];
  }

  return {
    _displayMs,
    _syncMotionClock,
    _syncRecede,
    _createIcons,
    _disposeIcons,
    _syncImageSwitch,
    _iconPosition,
    _iconCourse,
    _iconShown,
    _setIconShown,
    _occluder,
    _aboveHorizon,
    _planIcon,
    _settleIcon,
    _replanExpired,
    _focusIcons,
    _applyIconPresentation,
    _fleetLook,
    _turnRotors,
    _rotorsTurning,
    _rotorDrawnAtMs,
    _addIcon,
    _forgetContact,
    _iconIds,
  };
}

/**
 * A contact's icon item before it is styled or planned: held at the origin
 * (as a fresh row of the icon set was), always drawn over depth (receding
 * toward the limb, as its set does), picked as `{layer, id}`. Its image comes with its style
 * (`_applyIconPresentation`), before the item is first written.
 */
function baseContactItem(layerId, icao24, show) {
  return {
    id: icao24,
    pos: { x: 0, y: 0, z: 0 },
    motion: { kind: 'hold', courseDeg: 0 },
    course: 0,
    size: [FLEET_ICON_SIZE_PX, FLEET_ICON_SIZE_PX],
    rotationMode: 'course',
    disableDepthTest: Infinity,
    focus: 1,
    show,
    meta: { layer: layerId, id: icao24 },
  };
}

/**
 * Test seams over an aircraft layer's icon rows, shared by the flights and
 * military `testing` parts.
 * @param {object} state The layer state holding `_icons`.
 * @param {{icons: ReturnType<typeof createAircraftIcons>}} parts Read at call time.
 * @param {string} layerId
 */
export function aircraftIconTestSeams(state, parts, layerId) {
  /** A hold at `position` on course 0, planned to hold. */
  const held = (position) => ({
    pos: clone(position),
    motion: { kind: 'hold', courseDeg: 0 },
    course: 0,
    courseGlide: undefined,
  });

  /** Give a test contact an icon row held at `icon.position`, shown as
   *  `icon.show` says (hidden by default while tracked). */
  function _seedIconForTest(icao24, icon, tracked) {
    state._icons.put(
      {
        ...baseContactItem(layerId, icao24, icon?.show ?? !tracked),
        ...(icon?.position ? held(icon.position) : null),
      },
      { expiresAt: Infinity },
    );
  }

  /** Where a contact's icon is drawn now and whether the layer shows it. */
  function _iconForTest(icao24) {
    const position = parts.icons._iconPosition(icao24);
    return position
      ? {
          position,
          shown: parts.icons._iconShown(icao24),
          course: parts.icons._iconCourse(icao24),
        }
      : null;
  }

  /** Show or hide a contact's icon as a handoff would, or hold it somewhere. */
  function _setIconForTest(icao24, { shown, position } = {}) {
    const icons = state._icons;
    if (!icons?.has(icao24)) return;
    if (shown !== undefined) icons.setShown(icao24, shown);
    if (position) icons.update(icao24, held(position), { expiresAt: Infinity });
  }

  return { _seedIconForTest, _iconForTest, _setIconForTest };
}
