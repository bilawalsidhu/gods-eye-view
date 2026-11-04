import * as Cesium from 'cesium';
import {
  COURSE_HOLD_SPEED_MPS,
  courseSlewCapDps,
  norm180,
} from './motionModel.js';
import {
  createIconSet,
  ICON_CULL_LIFT,
  ICON_RECEDES,
  ICON_ROTATES,
} from './iconSet.js';
import {
  segmentCourse,
  writeArcSegment,
  writeCourseGlide,
  writeHoldSegment,
  writeLerpSegment,
} from './iconSegment.js';
import { IconSetPrimitive } from './iconSetPrimitive.js';
import { iconAtlas } from './iconAtlas.js';
import {
  aircraftIcon,
  FLEET_ICON_PX,
  TRACKED_ICON_PX,
} from './aircraftIcons.js';
import { cockpitContactDotImage } from './cockpitContactDot.js';
import { horizonOccluder } from './iconOrientation.js';

/** Raster size of the cockpit contact pip (cockpitContactDot.js draws 16 px). */
const COCKPIT_DOT_PX = 16;
/** Fleet glyphs keep the established close-range 3× scale. */
const NORMAL_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  1000,
  3.0,
  8000000,
  0.5,
);
const COCKPIT_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(
  1000,
  1.15,
  8000000,
  0.65,
);
/** Contacts drawn below this height (m) are judged for the horizon a little
 *  above the ellipsoid (ICON_CULL_LIFT). */
const CULL_LIFT_BELOW_M = 10;

/**
 * An aircraft layer's contacts as one icon set: each row's motion segment
 * mirrors the layer's dead reckoning for the delayed display time, so the GPU
 * moves every untracked contact between polls with no per-frame CPU pass.
 *
 * The layer's state supplies `_icons`, `_iconPrimitive`, `_scratchIconRenderTime`,
 * `_iconFocusActive`, `_positionHistory`, `_displayCourse`, `_groundSnap`,
 * `_models`, `_trackedIcao`, `_viewer`, `_cockpitContactMode`,
 * `_cockpitNearContacts` and `records` (`data`, `missingPolls`, `forget`).
 * `parts.motion._motionRegime` picks the motion; `parts.rendering` supplies
 * the icon kind, scale, colours and distance scalars, and `_releaseModel`.
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
  const scratchTime = new Cesium.JulianDate();
  const scratchPosition = new Cesium.Cartesian3();
  const scratchCull = new Cesium.Cartesian3();
  const scratchScaleByDistance = new Cesium.NearFarScalar();

  /** The delayed instant every untracked contact is drawn at. */
  function _displayTime(result = scratchTime) {
    return Cesium.JulianDate.addSeconds(
      Cesium.JulianDate.now(result),
      -renderDelaySec,
      result,
    );
  }

  function _displayTau() {
    return state._icons.seconds(_displayTime());
  }

  /** Create the set and its primitive for one layer lifetime. */
  function _createIcons(viewer) {
    state._icons = createIconSet({ epoch: _displayTime() });
    state._iconPrimitive = new IconSetPrimitive({
      set: state._icons,
      renderTime: () => _displayTime(state._scratchIconRenderTime),
    });
    viewer.scene.primitives.add(state._iconPrimitive);
    return state._iconPrimitive;
  }

  /** Where a contact is drawn right now, or null when it has no row. */
  function _iconPosition(icao24, result = new Cesium.Cartesian3()) {
    const set = state._icons;
    const row = set?.row(icao24) ?? -1;
    return row < 0 ? null : set.position(row, _displayTau(), result);
  }

  /** The nose direction a contact is drawn with right now. */
  function _iconCourse(icao24) {
    const set = state._icons;
    const row = set?.row(icao24) ?? -1;
    return row < 0 ? null : set.course(row, _displayTau());
  }

  /** Whether the layer draws this contact's icon (not tracked, not model-owned). */
  function _iconShown(icao24) {
    const set = state._icons;
    const row = set?.row(icao24) ?? -1;
    return row >= 0 && set.shown(row);
  }

  /** The camera's horizon test, or null when there is no placed camera. */
  function _occluder() {
    const camera = state._viewer?.camera;
    return camera?.positionWC ? horizonOccluder(camera) : null;
  }

  /** Whether a drawn row at `position` clears the camera's horizon, judged
   *  exactly as the icon shader judges it. No camera, no horizon. */
  function _aboveHorizon(row, position, occluder) {
    return (
      !occluder ||
      occluder.isPointVisible(
        state._icons.cullPoint(row, position, scratchCull),
      )
    );
  }

  /**
   * Write the segment the layer's dead reckoning would follow from now on:
   * interpolation between the bracketing fixes, the warm-up arc back from the
   * oldest fix, or the coast arc past the newest. The displayed nose glides
   * from where it is onto the new course at the fleet's slew cap; a hovering
   * contact keeps its nose. The row expires when the regime would change.
   * @param {string} icao24
   * @param {{fromCourseDeg?: number|null}} [options] Nose to glide from when
   *   the row's own segment is not what was on screen (tracking handoff).
   */
  function _planIcon(icao24, { fromCourseDeg } = {}) {
    const set = state._icons;
    const row = set?.row(icao24) ?? -1;
    if (row < 0 || holdsPlan(icao24)) return;
    const history = state._positionHistory.get(icao24);
    if (!history?.length) return;
    const info = state.records.data.get(icao24);
    const renderTime = _displayTime();
    const tau = set.seconds(renderTime);
    const seg = set.segments;
    const shownCourse =
      fromCourseDeg ??
      (set.expires(row) === -Infinity ? null : set.course(row, tau));

    const regime = parts.motion._motionRegime(history, info, renderTime);
    let speed;
    let expiresAt = Infinity;
    if (regime.kind === 'between') {
      const { a, b, span, trackFrom, trackTo, chordCourse } = regime;
      speed = regime.speed;
      const blend = chordCourse == null ? 0 : regime.blend;
      if (span > 0) {
        writeLerpSegment(seg, row, {
          from: a.position,
          to: b.position,
          t0: set.seconds(a.time),
          t1: set.seconds(b.time),
          course0Deg:
            trackFrom + blend * norm180((chordCourse ?? 0) - trackFrom),
          courseSlopeDeg: norm180(trackTo - trackFrom) * (1 - blend),
        });
      } else {
        writeHoldSegment(
          seg,
          row,
          b.position,
          trackTo + blend * norm180((chordCourse ?? 0) - trackTo),
        );
      }
      expiresAt = set.seconds(b.time);
    } else {
      const { fix, heading } = regime;
      speed = regime.speed;
      const t0 = set.seconds(fix.time);
      if (speed === 0) {
        writeHoldSegment(seg, row, fix.position, heading);
      } else {
        writeArcSegment(seg, row, {
          fix: fix.position,
          t0,
          minDt: regime.minDt,
          maxDt: regime.maxDt,
          speedMps: speed,
          trackDeg: heading,
          turnRateDps: regime.turnRateDps,
        });
      }
      // A warm-up's arc ends at its fix; a coast's runs to its limit.
      if (regime.maxDt === 0) expiresAt = t0;
    }
    // Below hover speed the nose holds what is on screen (or, for a new row,
    // where this segment starts); above it, it glides on at the slew cap.
    const hold = speed < COURSE_HOLD_SPEED_MPS;
    if (hold || shownCourse != null) {
      writeCourseGlide(
        seg,
        row,
        shownCourse ?? segmentCourse(seg, row, tau),
        tau,
        hold ? 0 : courseSlewCapDps(speed, courseMaxDps),
      );
    }
    set.segmentWritten(row, expiresAt);
  }

  /** Re-plan every row whose regime ended before `tau`. */
  function _replanExpired(tau) {
    const set = state._icons;
    const due = [];
    for (let row = 0; row < set.count; row++)
      if (set.expires(row) <= tau) due.push(set.idAt(row));
    for (const icao24 of due) _planIcon(icao24);
  }

  /**
   * Advance focus de-emphasis for every drawn row (and every row a fleet model
   * draws for, whose alpha reads it), only while a focus target exists or some
   * row is still relaxing back to full emphasis.
   */
  function _focusIcons(tau, scene, camera, nowMs, target) {
    if (!focusPassIsNeeded(target, state._iconFocusActive)) return;
    const { advanceProjectedSpriteFocus, nearFarScalarValueAtDistance } =
      services.focus;
    const set = state._icons;
    let active = 0;
    for (let row = 0; row < set.count; row++) {
      if (!set.shown(row) && !state._models.has(set.idAt(row))) continue;
      const position = set.position(row, tau, scratchPosition);
      const distanceScale = nearFarScalarValueAtDistance(
        set.scaleByDistance(row, scratchScaleByDistance),
        Cesium.Cartesian3.distance(camera.positionWC, position),
      );
      const half = set.scale(row) * distanceScale * 0.5;
      const focus = advanceProjectedSpriteFocus(
        set.metaAt(row),
        position,
        scene,
        camera,
        nowMs,
        target,
        undefined,
        set.width(row) * half,
        set.height(row) * half,
      );
      set.setFocus(row, focus.factor);
      if (focus.active || focus.transitioning) active++;
    }
    state._iconFocusActive = active;
  }

  /** Image, size, scale, tint and freshness for one row under the current
   *  normal/cockpit contract. Motion and rotation stay with the segment. */
  function _applyIconPresentation(icao24) {
    const set = state._icons;
    const row = set?.row(icao24) ?? -1;
    if (row < 0) return;
    const rendering = parts.rendering;
    const info = state.records.data.get(icao24);
    const tracked = icao24 === state._trackedIcao;
    const cockpitDot =
      state._cockpitContactMode &&
      !tracked &&
      !state._cockpitNearContacts.has(icao24);
    if (cockpitDot) {
      const dot = iconAtlas.slot(cockpitContactDotImage(), COCKPIT_DOT_PX);
      set.setImage(row, dot, dot);
      set.setSize(row, cockpitContactSizePx, cockpitContactSizePx);
      set.setScale(row, 1);
      set.setScaleByDistance(row, COCKPIT_SCALE_BY_DISTANCE);
      set.setColor(row, rendering._cockpitContactColor(icao24, info));
      set.setFlag(row, ICON_ROTATES, false);
    } else {
      set.setImage(
        row,
        iconAtlas.slot(
          aircraftIcon(rendering._iconKind(icao24, info?.klass)),
          FLEET_ICON_PX,
        ),
        iconAtlas.slot(
          aircraftIcon(
            rendering._iconKind(icao24, info?.klass),
            TRACKED_ICON_PX,
          ),
          TRACKED_ICON_PX,
        ),
      );
      const size = tracked ? 24 : 20;
      set.setSize(row, size, size);
      set.setScale(row, rendering._fleetBillboardScale(icao24, info?.klass));
      set.setScaleByDistance(row, NORMAL_SCALE_BY_DISTANCE);
      set.setColor(row, rendering._fleetBillboardColor(icao24, info));
      set.setFlag(row, ICON_ROTATES, true);
    }
    set.setFlag(row, ICON_RECEDES, true);
    set.setFlag(
      row,
      ICON_CULL_LIFT,
      Number.isFinite(info?.renderAltitudeM) &&
        info.renderAltitudeM < CULL_LIFT_BELOW_M,
    );
    set.setAlpha(row, state.records.missingPolls.get(icao24) ? 0.45 : 1);
  }

  /** Add a row for a new contact, hidden while it is the tracked one. */
  function _addIcon(icao24) {
    const set = state._icons;
    const row = set.add(icao24, { layer: layerId, id: icao24 });
    _applyIconPresentation(icao24);
    _settleIcon(icao24);
    set.setShown(row, icao24 !== state._trackedIcao);
    return row;
  }

  /**
   * Plan a row afresh, with the layer's own settle work on either side, and
   * let a dimmed row relax: one that sat out the focus pass (tracked) may come
   * back dimmed after the pass went idle, so it is counted to run the pass.
   * @param {string} icao24
   * @param {{fromCourseDeg?: number}} [options] The course on screen to glide from.
   */
  function _settleIcon(icao24, options) {
    const set = state._icons;
    const row = set?.row(icao24) ?? -1;
    if (row < 0) return;
    beforeSettle(icao24);
    if (set.focus(row) < 1) state._iconFocusActive += 1;
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
    const set = state._icons;
    const ids = new Array(set?.count ?? 0);
    for (let row = 0; row < ids.length; row++) ids[row] = set.idAt(row);
    return ids;
  }

  return {
    _displayTime,
    _displayTau,
    _createIcons,
    _iconPosition,
    _iconCourse,
    _iconShown,
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
 * Test seams over an aircraft layer's icon rows, shared by the flights and
 * military `testing` parts.
 * @param {object} state The layer state holding `_icons`.
 * @param {{icons: ReturnType<typeof createAircraftIcons>}} parts Read at call time.
 * @param {string} layerId
 */
export function aircraftIconTestSeams(state, parts, layerId) {
  /** Give a test contact an icon row held at `billboard.position`, shown as
   *  `billboard.show` says (hidden by default while tracked). */
  function _seedIconForTest(icao24, billboard, tracked) {
    const set = state._icons;
    const row = set.add(icao24, { layer: layerId, id: icao24 });
    if (billboard?.position)
      writeHoldSegment(set.segments, row, billboard.position, 0);
    set.segmentWritten(row);
    set.setShown(row, billboard?.show ?? !tracked);
    return row;
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
    const set = state._icons;
    const row = set?.row(icao24) ?? -1;
    if (row < 0) return;
    if (shown !== undefined) set.setShown(row, shown);
    if (position) {
      writeHoldSegment(set.segments, row, position, 0);
      set.segmentWritten(row);
    }
  }

  return { _seedIconForTest, _iconForTest, _setIconForTest };
}
