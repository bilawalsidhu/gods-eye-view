import * as Cesium from 'cesium';
import {
  COURSE_HOLD_SPEED_MPS,
  courseBetweenCartesians,
  courseSlewCapDps,
  norm180,
  speedRamp,
  staleCoastLimitSeconds,
} from '../../data/motionModel.js';
import {
  createIconSet,
  ICON_CULL_LIFT,
  ICON_RECEDES,
  ICON_ROTATES,
} from '../../data/iconSet.js';
import {
  segmentCourse,
  segmentTargetCourse,
  writeArcSegment,
  writeCourseGlide,
  writeHoldSegment,
  writeLerpSegment,
} from '../../data/iconSegment.js';
import { IconSetPrimitive } from '../../data/iconSetPrimitive.js';
import { iconAtlas } from '../../data/iconAtlas.js';
import {
  aircraftIcon,
  FLEET_ICON_PX,
  TRACKED_ICON_PX,
} from '../../data/aircraftIcons.js';
import { cockpitContactDotImage } from '../../data/cockpitContactDot.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
import {
  COCKPIT_CONTACT_SIZE_PX,
  COURSE_MAX_DPS,
  FLOOR_FAR_EVERY_TICKS,
  FLOOR_NEAR_M,
  RENDER_DELAY_SEC,
} from './policy.js';

/** Raster size of the cockpit contact pip (cockpitContactDot.js draws 16 px). */
const COCKPIT_DOT_PX = 16;
/** Pinned grounded rows rewrite only past this displayed move (m²) or turn (°). */
const PIN_MOVE_SQ_M = 1;
const PIN_TURN_DEG = 0.1;

/**
 * The flights layer's contacts as one icon set: each row's motion segment
 * mirrors `_deadReckon`'s regime for the delayed display time, so the GPU
 * moves every untracked contact between polls with no per-frame CPU pass.
 */
export function createIcons({ flightState, services, parts }) {
  const { focusPassIsNeeded } = services.focus;
  const scratchTime = new Cesium.JulianDate();
  const scratchPosition = new Cesium.Cartesian3();
  const scratchCull = new Cesium.Cartesian3();
  const scratchScaleByDistance = new Cesium.NearFarScalar();
  let normalScaleByDistance = null;
  let cockpitScaleByDistance = null;

  /** The delayed instant every untracked contact is drawn at. */
  function _displayTime(result = scratchTime) {
    return Cesium.JulianDate.addSeconds(
      Cesium.JulianDate.now(result),
      -RENDER_DELAY_SEC,
      result,
    );
  }

  function _displayTau() {
    return flightState._icons.seconds(_displayTime());
  }

  /** Create the set and its primitive for one layer lifetime. */
  function _createIcons(viewer) {
    flightState._icons = createIconSet({ epoch: _displayTime() });
    flightState._iconPrimitive = new IconSetPrimitive({
      set: flightState._icons,
      renderTime: () => _displayTime(flightState._scratchIconRenderTime),
    });
    viewer.scene.primitives.add(flightState._iconPrimitive);
    return flightState._iconPrimitive;
  }

  /** Where a contact is drawn right now, or null when it has no row. */
  function _iconPosition(icao24, result = new Cesium.Cartesian3()) {
    const set = flightState._icons;
    const row = set.row(icao24);
    return row < 0 ? null : set.position(row, _displayTau(), result);
  }

  /** The nose direction a contact is drawn with right now. */
  function _iconCourse(icao24) {
    const set = flightState._icons;
    const row = set.row(icao24);
    return row < 0 ? null : set.course(row, _displayTau());
  }

  /** Whether the layer draws this contact's icon (not tracked, not model-owned). */
  function _iconShown(icao24) {
    const set = flightState._icons;
    const row = set.row(icao24);
    return row >= 0 && set.shown(row);
  }

  /** The camera's horizon test, or null when there is no placed camera. */
  function _occluder() {
    const camera = flightState._viewer?.camera;
    return camera?.positionWC ? horizonOccluder(camera) : null;
  }

  /** Whether a drawn row at `position` clears the camera's horizon, judged
   *  exactly as the icon shader judges it. No camera, no horizon. */
  function _aboveHorizon(row, position, occluder) {
    return (
      !occluder ||
      occluder.isPointVisible(
        flightState._icons.cullPoint(row, position, scratchCull),
      )
    );
  }

  /**
   * Write the segment `_deadReckon` would follow from now on: interpolation
   * between the bracketing fixes, the warm-up arc back from the oldest fix, or
   * the coast arc past the newest. The displayed nose glides from where it is
   * onto the new course at the fleet's slew cap; a hovering contact keeps its
   * nose. The row expires when the regime would change.
   * @param {string} icao24
   * @param {{fromCourseDeg?: number|null}} [options] Nose to glide from when
   *   the row's own segment is not what was on screen (tracking handoff).
   */
  function _planIcon(icao24, { fromCourseDeg } = {}) {
    const set = flightState._icons;
    const row = set.row(icao24);
    if (row < 0) return;
    if (flightState._focusEvidenceIds.has(icao24)) return;
    if (flightState._floorPinned.has(icao24)) return;
    const history = flightState._positionHistory.get(icao24);
    if (!history?.length) return;
    const info = flightState.records.data.get(icao24);
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
      const t0 = set.seconds(a.time);
      if (span > 0) {
        writeLerpSegment(seg, row, {
          from: a.position,
          to: b.position,
          t0,
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
        hold ? 0 : courseSlewCapDps(speed, COURSE_MAX_DPS),
      );
    }
    set.segmentWritten(row, expiresAt);
  }

  /** Re-plan every row whose regime ended before `tau`. */
  function _replanExpired(tau) {
    const set = flightState._icons;
    const due = [];
    for (let row = 0; row < set.count; row++)
      if (set.expires(row) <= tau) due.push(set.idAt(row));
    for (const icao24 of due) _planIcon(icao24);
  }

  /**
   * Grounded contacts stand on the floor under where they are DRAWN, which the
   * GPU cannot sample. While the floor lifts one, the CPU pins its row to a
   * hold at the floored dead-reckoned position each tick (rewritten only when
   * it moved); once nothing lifts it the row goes back to its planned segment.
   */
  function _floorGroundedIcons(renderTime, tau, nowMs, cameraPosition) {
    const set = flightState._icons;
    // Past FLOOR_NEAR_M a taxiing contact moves well under a pixel per tick,
    // so far rows take turns: each refreshes every FLOOR_FAR_EVERY_TICKS. Their
    // eases onto a lower floor advance per call, so they run that much slower
    // out there too — sub-pixel at that range, and full rate once near.
    const turn = flightState._floorTick++ % FLOOR_FAR_EVERY_TICKS;
    const nearSq = FLOOR_NEAR_M * FLOOR_NEAR_M;
    for (const icao24 of flightState._grounded) {
      if (icao24 === flightState._trackedIcao) continue;
      const row = set.row(icao24);
      if (row < 0) continue;
      if (
        row % FLOOR_FAR_EVERY_TICKS !== turn &&
        cameraPosition &&
        Cesium.Cartesian3.distanceSquared(
          cameraPosition,
          set.position(row, tau, scratchPosition),
        ) > nearSq
      )
        continue;
      _floorIcon(icao24, renderTime, tau, nowMs);
    }
  }

  /** One grounded contact's floor pass (see `_floorGroundedIcons`). */
  function _floorIcon(icao24, renderTime, tau, nowMs) {
    const set = flightState._icons;
    const row = set.row(icao24);
    if (row < 0) return;
    const info = flightState.records.data.get(icao24);
    const raw = parts.motion._deadReckon(
      icao24,
      flightState._scratchFleetPos,
      renderTime,
    );
    const rawCourse =
      flightState._drCourseDeg ?? (info && info.true_track) ?? 0;
    const hold = flightState._drCourseHold;
    const speed = flightState._drSpeedMps ?? info?.velocity ?? NaN;
    const display = parts.motion._floorGroundedDisplayPosition(
      icao24,
      info,
      raw,
      parts.rendering._modelOwnsVisual(icao24),
      nowMs,
    );
    if (!display || display === raw) {
      if (flightState._floorPinned.delete(icao24))
        _planIcon(icao24, { fromCourseDeg: set.course(row, tau) });
      return;
    }
    const planned = set.expires(row) !== -Infinity;
    const prev = planned ? set.course(row, tau) : null;
    // The pin holds the position; the GPU glides the course onto the target,
    // so the rate stays exact however seldom the pin is rewritten.
    const target = hold && prev != null ? prev : rawCourse;
    if (
      flightState._floorPinned.has(icao24) &&
      Cesium.Cartesian3.distanceSquared(
        display,
        set.position(row, tau, scratchPosition),
      ) <= PIN_MOVE_SQ_M &&
      Math.abs(norm180(target - segmentTargetCourse(set.segments, row, tau))) <=
        PIN_TURN_DEG
    )
      return;
    flightState._floorPinned.add(icao24);
    writeHoldSegment(set.segments, row, display, target);
    if (prev != null)
      writeCourseGlide(
        set.segments,
        row,
        prev,
        tau,
        courseSlewCapDps(speed, COURSE_MAX_DPS),
      );
    set.segmentWritten(row);
  }

  /**
   * Advance focus de-emphasis for every drawn row (and every row a fleet model
   * draws for, whose alpha reads it), only while a focus target exists or some
   * row is still relaxing back to full emphasis.
   */
  function _focusIcons(tau, scene, camera, nowMs, target) {
    if (!focusPassIsNeeded(target, flightState._iconFocusActive)) return;
    const { advanceProjectedSpriteFocus, nearFarScalarValueAtDistance } =
      services.focus;
    const set = flightState._icons;
    let active = 0;
    for (let row = 0; row < set.count; row++) {
      if (!set.shown(row) && !flightState._models.has(set.idAt(row))) continue;
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
    flightState._iconFocusActive = active;
  }

  /** Image, size, scale, tint and freshness for one row under the current
   *  normal/cockpit contract. Motion and rotation stay with the segment. */
  function _applyIconPresentation(icao24) {
    const set = flightState._icons;
    const row = set.row(icao24);
    if (row < 0) return;
    const info = flightState.records.data.get(icao24);
    const tracked = icao24 === flightState._trackedIcao;
    const cockpitDot =
      flightState._cockpitContactMode &&
      !tracked &&
      !flightState._cockpitNearContacts.has(icao24);
    if (cockpitDot) {
      const dot = iconAtlas.slot(cockpitContactDotImage(), COCKPIT_DOT_PX);
      set.setImage(row, dot, dot);
      set.setSize(row, COCKPIT_CONTACT_SIZE_PX, COCKPIT_CONTACT_SIZE_PX);
      set.setScale(row, 1);
      cockpitScaleByDistance ??=
        parts.rendering._cockpitBillboardScaleByDistance();
      set.setScaleByDistance(row, cockpitScaleByDistance);
      set.setColor(row, parts.rendering._cockpitContactColor(icao24, info));
      set.setFlag(row, ICON_ROTATES, false);
    } else {
      set.setImage(
        row,
        iconAtlas.slot(
          aircraftIcon(parts.rendering._iconKind(icao24, info?.klass)),
          FLEET_ICON_PX,
        ),
        iconAtlas.slot(
          aircraftIcon(
            parts.rendering._iconKind(icao24, info?.klass),
            TRACKED_ICON_PX,
          ),
          TRACKED_ICON_PX,
        ),
      );
      const size = tracked ? 24 : 20;
      set.setSize(row, size, size);
      set.setScale(
        row,
        parts.rendering._fleetBillboardScale(icao24, info?.klass),
      );
      normalScaleByDistance ??=
        parts.rendering._normalBillboardScaleByDistance();
      set.setScaleByDistance(row, normalScaleByDistance);
      set.setColor(row, parts.rendering._fleetBillboardColor(icao24, info));
      set.setFlag(row, ICON_ROTATES, true);
    }
    set.setFlag(row, ICON_RECEDES, true);
    set.setFlag(
      row,
      ICON_CULL_LIFT,
      Number.isFinite(info?.renderAltitudeM) && info.renderAltitudeM < 10,
    );
    set.setAlpha(row, flightState.records.missingPolls.get(icao24) ? 0.45 : 1);
  }

  /** Add a row for a new contact, hidden while it is the tracked one. */
  function _addIcon(icao24) {
    const set = flightState._icons;
    const row = set.add(icao24, { layer: 'flights', id: icao24 });
    _applyIconPresentation(icao24);
    _settleIcon(icao24);
    set.setShown(row, icao24 !== flightState._trackedIcao);
    return row;
  }

  /**
   * Plan a row afresh, dropping any floor pin (a pin stops at the last floor
   * pass, which skips a tracked contact), and let a dimmed row relax. A grounded contact goes straight onto
   * the floor under where it is drawn, not its fix's floor until the next fleet
   * tick raises it.
   * @param {string} icao24
   * @param {{fromCourseDeg?: number}} [options] The course on screen to glide from.
   */
  function _settleIcon(icao24, options) {
    const set = flightState._icons;
    flightState._floorPinned.delete(icao24);
    // A row that sat out the focus pass (tracked) may come back dimmed after
    // the pass went idle; count it so the pass runs and relaxes it.
    if (set.focus(set.row(icao24)) < 1) flightState._iconFocusActive += 1;
    _planIcon(icao24, options);
    if (flightState._grounded.has(icao24)) {
      const renderTime = _displayTime();
      _floorIcon(icao24, renderTime, set.seconds(renderTime), Date.now());
    }
  }

  /** Drop a contact and everything the layer keeps for it. */
  function _forgetContact(icao24) {
    flightState._icons?.remove(icao24);
    parts.rendering._releaseModel(icao24);
    flightState.records.forget(icao24);
    flightState._positionHistory.delete(icao24);
    flightState._displayCourse.delete(icao24);
    flightState._groundSnap.forget(icao24);
    flightState._displayFloorState.delete(icao24);
    flightState._grounded.delete(icao24);
    flightState._floorPinned.delete(icao24);
  }

  /** Icon ids, so ray samples never land on an aircraft instead of the ground. */
  function _iconIds() {
    const set = flightState._icons;
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
    _floorGroundedIcons,
    _focusIcons,
    _applyIconPresentation,
    _addIcon,
    _forgetContact,
    _iconIds,
  };
}
