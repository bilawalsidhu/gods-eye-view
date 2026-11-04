import * as Cesium from 'cesium';
import { courseSlewCapDps, norm180 } from '../../data/motionModel.js';
import {
  segmentTargetCourse,
  writeCourseGlide,
  writeHoldSegment,
} from '../../data/iconSegment.js';
import { createAircraftIcons } from '../../data/aircraftIconLayer.js';
import {
  COCKPIT_CONTACT_SIZE_PX,
  COURSE_MAX_DPS,
  FLOOR_FAR_EVERY_TICKS,
  FLOOR_NEAR_M,
  RENDER_DELAY_SEC,
} from './policy.js';

/** Pinned grounded rows rewrite only past this displayed move (m²) or turn (°). */
const PIN_MOVE_SQ_M = 1;
const PIN_TURN_DEG = 0.1;

/**
 * The flights layer's contacts as one icon set (`createAircraftIcons`), plus
 * the grounded floor: a floor-pinned row holds a CPU position, so it is not
 * planned, and settling a grounded contact puts it straight onto the floor.
 */
export function createIcons({ flightState, services, parts }) {
  const scratchPosition = new Cesium.Cartesian3();
  const icons = createAircraftIcons({
    state: flightState,
    services,
    parts,
    layerId: 'flights',
    renderDelaySec: RENDER_DELAY_SEC,
    courseMaxDps: COURSE_MAX_DPS,
    cockpitContactSizePx: COCKPIT_CONTACT_SIZE_PX,
    holdsPlan: (icao24) =>
      flightState._focusEvidenceIds.has(icao24) ||
      flightState._floorPinned.has(icao24),
    // A pin stops at the last floor pass, which skips a tracked contact.
    beforeSettle: (icao24) => flightState._floorPinned.delete(icao24),
    // Straight onto the floor under where it is drawn, not its fix's floor
    // until the next fleet tick raises it.
    afterSettle(icao24) {
      if (!flightState._grounded.has(icao24)) return;
      const renderTime = icons._displayTime();
      _floorIcon(
        icao24,
        renderTime,
        flightState._icons.seconds(renderTime),
        Date.now(),
      );
    },
    onForget(icao24) {
      flightState._displayFloorState.delete(icao24);
      flightState._grounded.delete(icao24);
      flightState._floorPinned.delete(icao24);
    },
  });

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
        icons._planIcon(icao24, { fromCourseDeg: set.course(row, tau) });
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

  return { ...icons, _floorGroundedIcons };
}
