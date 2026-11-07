import { COURSE_HOLD_SPEED_MPS, courseSlewCapDps } from './motionModel.js';
import { norm180, distance, clone, copyInto } from '../geo/vector.js';
import { horizonFrom, liftedForHorizon } from '../geo/horizon.js';
import { createIconBook } from '../render/motion/iconBook.js';
import { motionCourse } from '../render/motion/iconMotion.js';
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

/** Raster size of the cockpit contact pip (cockpitContactDot.js draws 16 px). */
const COCKPIT_DOT_PX = 16;
/** Fleet glyphs keep the established close-range 3× scale. */
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
    shown: (id) => book.item(id)?.show !== false,
    focus: (id) => book.focus(id),
    alpha: (id) => book.item(id)?.alpha ?? 1,
    scale: (id) => book.item(id)?.scale ?? 1,
    /** Draw an item as given (see `iconBook.put`). */
    put(item, options) {
      book.put(item, options);
      removed.delete(item.id);
      pending.set(item.id, item);
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
    setFocus: (id, factor) => icons.update(id, { focus: factor }),
    remove(id) {
      if (!book.has(id)) return;
      book.remove(id);
      pending.delete(id);
      if (sent.has(id)) {
        removed.add(id);
        schedule();
      }
    },
    clear() {
      for (const id of book.ids()) book.remove(id);
      pending.clear();
      removed.clear();
      sent.clear();
      if (drawSet && !disposed) drawSet.clear();
    },
    /** Write what is waiting now. */
    flush,
    dispose() {
      for (const id of book.ids()) book.remove(id);
      pending.clear();
      removed.clear();
      sent.clear();
      disposed = true;
      drawSet?.dispose();
    },
  };
  return icons;
}

let instances = 0;

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
 * @param {number} options.renderDelaySec How far behind real time contacts draw.
 * @param {number} options.courseMaxDps The fleet's course slew cap.
 * @param {number} options.cockpitContactSizePx Cockpit far-contact pip size.
 * @param {(icao24: string) => boolean} [options.holdsPlan] True while something
 *   else writes this row's segment (it is not planned).
 * @param {(icao24: string) => void} [options.beforeSettle] Runs before a row is
 *   planned afresh.
 * @param {(icao24: string) => void} [options.afterSettle] Runs after it.
 * @param {(icao24: string) => void} [options.onForget] Drops the layer's own
 *   per-contact state when a contact goes.
 */
export function createAircraftIcons({
  state,
  services,
  parts,
  layerId,
  renderDelaySec,
  courseMaxDps,
  cockpitContactSizePx,
  holdsPlan = () => false,
  beforeSettle = () => {},
  afterSettle = () => {},
  onForget = () => {},
}) {
  const { focusPassIsNeeded } = services.focus;
  const delayMs = renderDelaySec * 1000;
  // The near-image switch the rows were last written with (CSS px).
  let switchPx = nearImageSwitchPx(1);

  /** The delayed instant (epoch ms) every untracked contact is drawn at. */
  const _displayMs = () => Date.now() - delayMs;

  /**
   * Create the draw set for one layer lifetime, drawn over depth and culled
   * at the horizon on the delayed live clock.
   * @returns {string} The set's id, for the sprite order.
   */
  function _createIcons(viewer) {
    const set = drawOf(viewer).icons({
      id: `${layerId}-icons:${++instances}`,
      horizonCull: true,
      motionClock: { kind: 'live', delayMs },
    });
    // Columns of no rows put the set's host in the scene now, where the
    // sprite order finds it, rather than with its first contact.
    set.setColumns?.({ ids: [] });
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
   * @param {string} icao24
   * @param {{fromCourseDeg?: number|null}} [options] Nose to glide from when
   *   the row's own motion is not what was on screen (tracking handoff).
   */
  function _planIcon(icao24, { fromCourseDeg } = {}) {
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

    const regime = parts.motion._motionRegime(history, info, renderTime);
    let speed;
    let motion;
    let pos;
    let course;
    let expiresAt = Infinity;
    if (regime.kind === 'between') {
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
    } else {
      const { fix, heading } = regime;
      speed = regime.speed;
      const t0 = fixMs(fix);
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
      // A warm-up's arc ends at its fix; a coast's runs to its limit.
      if (regime.maxDt === 0) expiresAt = t0;
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
  }

  /** Re-plan every row whose regime ended by `t` (epoch ms). */
  function _replanExpired(t) {
    for (const icao24 of state._icons.due(t)) _planIcon(icao24);
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
      if (focusAlphaNeedsWrite(current, focus.factor))
        icons.setFocus(id, focus.factor);
    }
    state._iconFocusActive = active;
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
          image: aircraftIcon(
            rendering._iconKind(icao24, info?.klass),
            FLEET_ICON_PX,
          ),
          imageLod: {
            near: aircraftIcon(
              rendering._iconKind(icao24, info?.klass),
              TRACKED_ICON_PX,
            ),
            switchPx,
          },
          size: tracked ? [24, 24] : [20, 20],
          scale: rendering._fleetBillboardScale(icao24, info?.klass),
          scaleByDistance: NORMAL_SCALE_BY_DISTANCE,
          color: rgba(rendering._fleetBillboardColor(icao24, info)),
          rotationMode: 'course',
        };
    look.alpha = state.records.missingPolls.get(icao24) ? 0.45 : 1;
    icons.update(icao24, look);
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
    parts.rendering._releaseModel(icao24);
    state.records.forget(icao24);
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
    _addIcon,
    _forgetContact,
    _iconIds,
  };
}

/**
 * A contact's icon item before it is styled or planned: held at the origin
 * (as a fresh row of the icon set was), always drawn over depth, receding
 * toward the limb, picked as `{layer, id}`. Its image comes with its style
 * (`_applyIconPresentation`), before the item is first written.
 */
function baseContactItem(layerId, icao24, show) {
  return {
    id: icao24,
    pos: { x: 0, y: 0, z: 0 },
    motion: { kind: 'hold', courseDeg: 0 },
    course: 0,
    size: [20, 20],
    rotationMode: 'course',
    recede: true,
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
