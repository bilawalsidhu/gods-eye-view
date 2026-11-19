import { courseSlewCapDps } from '../../data/motionModel.js';
import { createAircraftIcons } from '../../data/aircraftIconLayer.js';
import { placeAircraftAt } from './placed.js';
import { motionCourse } from '../../render/motion/iconMotion.js';
import { distanceSquared, norm180 } from '../../geo/vector.js';
import {
  COCKPIT_CONTACT_SIZE_PX,
  COURSE_MAX_DPS,
  FLOOR_FAR_EVERY_TICKS,
  FLOOR_NEAR_M,
  STALE_ALPHA,
  followsClock,
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
  const icons = createAircraftIcons({
    state: flightState,
    services,
    parts,
    layerId: 'flights',
    displayDelay: flightState._displayDelay,
    followsClock: () => followsClock(flightState),
    staleAlpha: STALE_ALPHA,
    courseMaxDps: COURSE_MAX_DPS,
    cockpitContactSizePx: COCKPIT_CONTACT_SIZE_PX,
    // A host-supplied placement, if any, draws a live contact where it places it.
    placeAt: services.placement
      ? (icao24, wallMs, info, history, out) =>
          placeAircraftAt(
            services.placement,
            icao24,
            wallMs,
            info,
            history,
            out,
          )
      : null,
    holdsPlan: (icao24) =>
      flightState._focusEvidenceIds.has(icao24) ||
      flightState._floorPinned.has(icao24),
    // A pin stops at the last floor pass, which skips a tracked contact.
    beforeSettle: (icao24) => flightState._floorPinned.delete(icao24),
    // Straight onto the floor under where it is drawn, not its fix's floor
    // until the next fleet tick raises it.
    afterSettle(icao24) {
      if (!flightState._grounded.has(icao24)) return;
      const t = icons._displayMs();
      _floorIcon(icao24, parts.motion._displayTimeAt(t), t, Date.now());
    },
    onForget(icao24) {
      flightState._displayFloorState.delete(icao24);
      flightState._grounded.delete(icao24);
      flightState._floorPinned.delete(icao24);
    },
  });

  /**
   * Grounded contacts stand on the floor under where they are DRAWN, which the
   * renderer cannot sample. While the floor lifts one, the CPU pins its item
   * to a hold at the floored dead-reckoned position each tick (rewritten only
   * when it moved); once nothing lifts it the item goes back to its planned
   * motion.
   * @param {object} renderTime The display instant (the motion part's `_displayTimeAt`).
   * @param {number} t The same instant, epoch ms.
   * @param {number} nowMs
   * @param {{x: number, y: number, z: number}|null} cameraPosition The eye.
   */
  function _floorGroundedIcons(renderTime, t, nowMs, cameraPosition) {
    const set = flightState._icons;
    // Past FLOOR_NEAR_M a taxiing contact moves well under a pixel per tick,
    // so far rows take turns: each refreshes every FLOOR_FAR_EVERY_TICKS. Their
    // eases onto a lower floor advance per call, so they run that much slower
    // out there too — sub-pixel at that range, and full rate once near.
    const turn = flightState._floorTick++ % FLOOR_FAR_EVERY_TICKS;
    const nearSq = FLOOR_NEAR_M * FLOOR_NEAR_M;
    let index = -1;
    for (const icao24 of flightState._grounded) {
      if (icao24 === flightState._trackedIcao) continue;
      if (!set.has(icao24)) continue;
      index += 1;
      if (
        index % FLOOR_FAR_EVERY_TICKS !== turn &&
        cameraPosition &&
        distanceSquared(cameraPosition, set.position(icao24, t)) > nearSq
      )
        continue;
      _floorIcon(icao24, renderTime, t, nowMs);
    }
  }

  /** One grounded contact's floor pass (see `_floorGroundedIcons`). */
  function _floorIcon(icao24, renderTime, t, nowMs) {
    const set = flightState._icons;
    if (!set?.has(icao24)) return;
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
        icons._planIcon(icao24, { fromCourseDeg: set.course(icao24, t) });
      return;
    }
    // Following the clock, not drawn at a time before it was there.
    set.setUnseen(icao24, flightState._drUnseen);
    const planned = set.expires(icao24) !== -Infinity;
    const prev = planned ? set.course(icao24, t) : null;
    // The pin holds the position; the renderer glides the course onto the
    // target, so the rate stays exact however seldom the pin is rewritten.
    const target = hold && prev != null ? prev : rawCourse;
    const item = set.item(icao24);
    if (
      flightState._floorPinned.has(icao24) &&
      distanceSquared(display, set.position(icao24, t)) <= PIN_MOVE_SQ_M &&
      Math.abs(norm180(target - motionCourse(item.motion, item.course, t))) <=
        PIN_TURN_DEG
    )
      return;
    flightState._floorPinned.add(icao24);
    set.update(
      icao24,
      {
        pos: { x: display.x, y: display.y, z: display.z },
        course: target,
        motion: { kind: 'hold', courseDeg: target },
        courseGlide:
          prev == null
            ? undefined
            : {
                fromCourseDeg: prev,
                t0: t,
                rateDps: courseSlewCapDps(speed, COURSE_MAX_DPS),
              },
      },
      { expiresAt: Infinity },
    );
  }

  return { ...icons, _floorGroundedIcons };
}
