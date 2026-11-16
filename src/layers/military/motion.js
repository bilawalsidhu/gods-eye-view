import { canvasOf, findCamera } from '../../render/rendererOf.js';
import { renderedFrames } from '../../data/renderedFrames.js';
import { liftGroundedHistory } from '../../data/timelineHistory.js';
import {
  motionCourse,
  motionPosition,
} from '../../render/motion/iconMotion.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { eastNorthUp, framePoint } from '../../geo/frames.js';
import {
  addSeconds,
  julianLessThan,
  julianFromEpochMs,
  julianToEpochMs,
  secondsDifference,
} from '../../geo/julian.js';
import {
  add,
  clamp,
  copyInto,
  distance,
  lerpInto,
  scale,
  sub,
  vec,
} from '../../geo/vector.js';
import {
  lerpAngleDeg,
  COURSE_HOLD_SPEED_MPS,
  floorCoastedPosition,
  staleHoldsForFix,
  arcOffsetEnu,
  courseSlewCapDps,
  RECOVER_SNAP_M,
  recoveryMs,
  limitCourseStep,
} from '../../data/motionModel.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import { placeLiveAircraft } from '../flights/placed.js';
import {
  modelVisualAnchor,
  modelAnchorWorld,
} from '../../data/modelVisualAnchor.js';
import {
  displayDelayMs,
  followsClock,
  MODEL_MIN_PX,
  BILLBOARD_SCALE,
  TRACKED_BILLBOARD_SCALE_BY_DISTANCE,
  DR_CORRECTION_MS,
  COURSE_SLEW_DT_MAX_SEC,
  COURSE_MAX_DPS,
} from './policy.js';
import { readEntityRecord } from '../../data/entityRecords.js';
import {
  aircraftMotionRegime,
  createMotionRegime,
  fixEpochMs,
  fixPosition,
  copyPosition,
  historyFix,
  julianAt,
  fixSpeedMps,
  fixTrackDeg,
  staleCoastSeconds,
  rawPositionJumped,
  rawStepSpeedMps,
} from '../../data/aircraftMotionRegime.js';

/** Where a military record carries its reported speed and track. */
const RECORD_FIELDS = { speed: 'speedMps', track: 'track' };

/** Whether two ECEF points are the same point, component for component. */
const samePoint = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

export function createMotion({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const {
    nearFarScalarValueAtDistance,
    clearFocusTarget,
    publishFocusTargetAt,
  } = services.focus;
  /** `_motionRegime`'s reused result. */
  const regime = createMotionRegime();

  /** The camera's pose, or null without a camera to ask. */
  function _pose() {
    const viewer = flightState._viewer;
    try {
      return (viewer && findCamera(viewer)?.pose()) ?? null;
    } catch {
      return null;
    }
  }

  /** The renderer canvas's CSS height (the viewer's own canvas when no
   *  renderer is bound), or 0 without either. */
  function _viewportHeightPx() {
    const viewer = flightState._viewer;
    const canvas = canvasOf(viewer);
    return Number(canvas?.clientHeight) || 0;
  }

  // Fixes leave the cache with their history; a corrected position
  // invalidates the local frame even when the fix's point is changed in place.
  const fixFrames = new WeakMap();

  /**
   * Dead-reckon an aircraft's current position using ENU (East-North-Up) frame math.
   *
   * Renders behind real time, as late as the feed is (displayDelayMs), so
   * positions interpolate between two KNOWN fixes whenever possible. When the
   * newest fix is older than the delayed render time (stale position), projects
   * forward using the aircraft's ground speed and track through the freshest
   * source contact plus a bounded grace window.
   *
   * @param {string} icao24 - ICAO hex identifier of the aircraft
   * @param {{x: number, y: number, z: number}} [result] - Optional out-parameter to write into.
   * @returns {{x: number, y: number, z: number}|null} Estimated current ECEF position, or null if no history
   */

  function _deadReckon(icao24, result, sampledRenderTime) {
    flightState._drUnseen = false;
    const history = flightState._positionHistory.get(icao24);
    const info = flightState.records.data.get(icao24);
    if (!history || history.length === 0) {
      flightState._drCourseDeg = null;
      flightState._drSpeedMps = null;
      flightState._drCourseHold = false;
      return null;
    }

    const out = result || vec();
    // A host-supplied placement decides where a live contact is drawn; with
    // none, or no answer for this contact, the layer's own motion below does.
    if (
      placeLiveAircraft(
        flightState,
        services.placement,
        icao24,
        info,
        history,
        out,
      )
    )
      return out;
    // Render behind real time, as late as the feed is (displayDelayMs), so we
    // interpolate between two KNOWN fixes whenever possible.
    const renderTime =
      sampledRenderTime ??
      addSeconds(
        julianFromEpochMs(flightState.now()),
        -displayDelayMs(flightState) / 1000,
        flightState._scratchRenderTime,
      );

    const regime = _motionRegime(history, info, renderTime);
    // Following the clock, a time well before its first fix is before it
    // was there: it is not drawn.
    flightState._drUnseen = regime.unseen;
    if (regime.kind === 'between' && regime.piece) {
      // Along the curve between the two reports, as the icon and the trail.
      const ms = julianToEpochMs(renderTime);
      const segment = regime.piece.segment;
      flightState._drCourseDeg = motionCourse(segment, undefined, ms);
      flightState._drSpeedMps = segment.speedMps;
      flightState._drCourseHold = segment.speedMps < COURSE_HOLD_SPEED_MPS;
      return copyInto(motionPosition(segment, null, ms), out);
    }
    if (regime.kind === 'between') {
      const { a, b, span } = regime;
      const t = span > 0 ? secondsDifference(renderTime, a.time) / span : 1.0;
      const trackCourse = lerpAngleDeg(regime.trackFrom, regime.trackTo, t);
      flightState._drCourseDeg =
        regime.chordCourse != null
          ? lerpAngleDeg(trackCourse, regime.chordCourse, regime.blend)
          : trackCourse;
      flightState._drSpeedMps = regime.speed;
      flightState._drCourseHold = regime.speed < COURSE_HOLD_SPEED_MPS;
      return lerpInto(a.position, b.position, t, out);
    }
    const dt = clamp(
      secondsDifference(renderTime, regime.fix.time),
      regime.minDt,
      regime.maxDt,
    );
    _extrapolateFix(regime.fix, info, dt, out, regime.turnRateDps);
    // A coast never goes below the ground.
    return dt > 0
      ? floorCoastedPosition(out, services.groundFloor?.cachedGroundFloor)
      : out;
  }

  /**
   * Which motion a contact's history gives at `renderTime` — the one choice
   * `_deadReckon` (CPU) and the icon planner (GPU segment) both draw from
   * (`aircraftMotionRegime`). The result is a reused scratch: read it before
   * the next call.
   */
  function _motionRegime(history, info, renderTime) {
    return aircraftMotionRegime(
      history,
      info,
      renderTime,
      RECORD_FIELDS,
      regime,
      { cachedGroundFloor: services.groundFloor?.cachedGroundFloor },
    );
  }

  /**
   * Whether a contact has stopped where its coast ended (or held at its last
   * report) with no newer report, and since when it has had none.
   * @param {string} icao24
   * @returns {{reportEpochMs: number, holds: boolean}|null} Null while a
   *   report is ahead of the display time or the contact is still coasting.
   */
  function _signalLost(icao24) {
    const newest = flightState._positionHistory.get(icao24)?.at(-1);
    if (!newest) return null;
    const newestMs = fixEpochMs(newest);
    const elapsedSec =
      (flightState.now() - displayDelayMs(flightState) - newestMs) / 1000;
    if (!(elapsedSec > 0)) return null;
    const info = flightState.records.data.get(icao24);
    const cachedGroundFloor = services.groundFloor?.cachedGroundFloor;
    const coastSec = staleCoastSeconds(newest, info, cachedGroundFloor);
    if (!(elapsedSec > coastSec)) return null;
    return {
      reportEpochMs: Number.isFinite(newest.reportEpochMs)
        ? newest.reportEpochMs
        : newestMs,
      holds: staleHoldsForFix(newest, {
        onGround: info?.onGround,
        cachedGroundFloor,
      }),
    };
  }

  /**
   * Dead-reckon a fix along its own velocity/track by `dt` seconds, integrating a
   * constant-rate-turn arc when `turnRateDps` is significant (straight line
   * otherwise). Positive `dt` projects FORWARD (after the fix); negative `dt`
   * projects BACKWARD (before the fix) — used for warm-up, estimating where the
   * aircraft was before its first observed fix. ENU frame: east = +X, north = +Y,
   * up = +Z; heading 0 deg = north, 90 deg = east (clockwise from north). Sets
   * `_drCourseDeg` to the arc's instantaneous end course on every path.
   * Arc math adapted from skylight (https://github.com/cpaczek/skylight, MIT).
   */

  function _extrapolateFix(fix, info, dt, out, turnRateDps = 0) {
    const speed = fixSpeedMps(fix, info, RECORD_FIELDS);
    const heading = fixTrackDeg(fix, info, RECORD_FIELDS);
    flightState._drSpeedMps = speed;
    flightState._drCourseHold = speed < COURSE_HOLD_SPEED_MPS;
    if (speed === 0 || dt === 0) {
      flightState._drCourseDeg = heading;
      return copyInto(fix.position, out);
    }
    // Constant-rate-turn arc (straight line when turnRateDps ≈ 0) — a plane in a
    // standard-rate turn is ~90° of arc wrong per 30 s if extrapolated straight.
    arcOffsetEnu(speed, heading, turnRateDps, dt, flightState._scratchArc);
    flightState._drCourseDeg = flightState._scratchArc.endCourseDeg;
    const offset = flightState._scratchOffset;
    offset.x = flightState._scratchArc.east;
    offset.y = flightState._scratchArc.north;
    offset.z = 0;
    let frame = fixFrames.get(fix);
    if (!frame) {
      frame = { position: vec(), enu: null };
      fixFrames.set(fix, frame);
    }
    if (!frame.enu || !samePoint(frame.position, fix.position)) {
      frame.enu = eastNorthUp(fix.position);
      copyInto(fix.position, frame.position);
    }
    return copyInto(framePoint(frame.enu, offset), out);
  }

  /**
   * True while the tracked aircraft's delayed display time (now − displayDelayMs)
   * predates its oldest real fix — _deadReckon is extrapolating backward with no real
   * history yet behind the displayed icon, so the trail must draw nothing.
   * @returns {boolean}
   */

  function _isTrackWarmingUp() {
    if (!flightState._trackedIcao) return false;
    const history = flightState._positionHistory.get(flightState._trackedIcao);
    if (!history || history.length === 0) return true;
    const renderTime = addSeconds(
      julianFromEpochMs(flightState.now()),
      -displayDelayMs(flightState) / 1000,
      flightState._scratchWarmupTime,
    );
    return julianLessThan(renderTime, history[0].time);
  }

  /** Resolve the selected aircraft's actual rendered square extent this frame. */

  function _trackedFocusSizePx(icao24, position) {
    const pose = _pose();
    if (!pose || !position) return 28;
    const rangeM = distance(pose.position, position);
    const viewportHeightPx = _viewportHeightPx();
    if (parts.rendering._modelOwnsVisual(icao24)) {
      const spec = parts.rendering._modelSpec(
        flightState.records.data.get(icao24),
      );
      // Drawn as the fleet draws it: its own size, never under MODEL_MIN_PX.
      const focalLengthPx = viewportHeightPx / (2 * Math.tan(pose.fovy / 2));
      const projectedDiameterPx =
        (2 * spec.nativeRadiusM * spec.scale * focalLengthPx) / rangeM;
      return Math.max(MODEL_MIN_PX, projectedDiameterPx);
    }

    const sprite = readEntityRecord(flightState._trackedEntity)?.sprite;
    const width = sprite?.width ?? 28;
    const height = sprite?.height ?? 28;
    const scale =
      sprite?.scale ??
      BILLBOARD_SCALE *
        (CLASS_SCALE_2D[flightState.records.data.get(icao24)?.klass] || 1);
    const scaleByDistance =
      sprite?.scaleByDistance ?? TRACKED_BILLBOARD_SCALE_BY_DISTANCE;
    const distanceScale = nearFarScalarValueAtDistance(scaleByDistance, rangeM);
    return Math.max(width, height) * scale * distanceScale;
  }

  /**
   * Per-frame-cached, discontinuity-smoothed tracked DISPLAY position. Cached by drawn
   * frame (see renderedFrames.js) so the position / rotation / trail-head callbacks share ONE computation
   * (and one reconciliation-state update) per frame. Returns a stable module holder, or
   * null when the aircraft has no fix.
   * @param {string} icao24
   * @returns {{x: number, y: number, z: number}|null}
   */

  function _trackedDisplayPosition(icao24) {
    const frame = renderedFrames(flightState._viewer);
    if (
      frame === flightState._cachedDRFrame &&
      icao24 === flightState._drReconcileIcao
    )
      return flightState._cachedDRPosition;

    // Does the reconciliation state belong to THIS aircraft? (Capture before overwriting
    // _drReconcileIcao, so a track switch doesn't inherit the old plane's _drPrevRaw.)
    const sameTrack =
      flightState._drReconcileValid && flightState._drReconcileIcao === icao24;
    const raw = _deadReckon(icao24, flightState._scratchDrRaw);
    flightState._cachedDRCourse = flightState._drCourseDeg;
    flightState._cachedDRSpeedMps = flightState._drSpeedMps;
    flightState._cachedDRHold = flightState._drCourseHold;
    flightState._cachedDRFrame = frame;
    flightState._drReconcileIcao = icao24;
    if (!raw) {
      flightState._cachedDRPosition = null;
      flightState._drReconcileValid = false;
      clearFocusTarget('militaryFlights', icao24);
      return null;
    }

    const nowMs = Date.now();
    // How far the contact may move between frames goes by the world's time,
    // which plays faster than the wall clock when following it at a rate.
    const worldMs = followsClock(flightState) ? flightState.now() : nowMs;
    const info = flightState.records.data.get(icao24);
    const dtSec = Math.max(
      0.001,
      (worldMs - flightState._drPrevWorldMs) / 1000,
    );
    let snapped = false;
    let jumpedThisFrame = false;
    if (sameTrack) {
      const speed = (info && info.speedMps) || 0;
      // A jump: a new report moved the path the raw position is on.
      const jumped = rawPositionJumped(
        raw,
        flightState._drPrevRaw,
        flightState._drPrevRawStep,
        flightState._drPrevRawStepSec,
        dtSec,
      );
      if (jumped) {
        // Discontinuity — re-anchor so the DISPLAYED position stays continuous,
        // then ease onto the new path no faster than a little over its speed;
        // farther off than RECOVER_SNAP_M it is a break, and it jumps.
        // From where the icon would be this frame had it carried on as it
        // was moving, not from where it was last frame: it never stands
        // still for a frame.
        const anchor =
          flightState._drPrevStepSec > 0
            ? add(
                flightState._drPrevDisplay,
                scale(
                  flightState._drPrevStep,
                  dtSec / flightState._drPrevStepSec,
                ),
              )
            : flightState._drPrevDisplay;
        const errorM = distance(anchor, raw);
        jumpedThisFrame = true;
        snapped = errorM >= RECOVER_SNAP_M;
        copyInto(snapped ? vec() : sub(anchor, raw), flightState._drCorrection);
        flightState._drCorrectionStartMs = nowMs;
        flightState._drCorrectionMs = Math.max(
          DR_CORRECTION_MS,
          // As fast as the path it was drawn on moves: the newest report's
          // speed can be stale or 0 minutes ahead of it.
          recoveryMs(
            errorM,
            rawStepSpeedMps(
              flightState._drPrevRawStep,
              flightState._drPrevRawStepSec,
              speed,
            ),
          ),
        );
      }
    } else {
      copyInto(vec(), flightState._drCorrection);
      flightState._drCorrectionStartMs = nowMs - DR_CORRECTION_MS; // fully decayed
      flightState._drCorrectionMs = DR_CORRECTION_MS;
    }

    const elapsed = nowMs - flightState._drCorrectionStartMs;
    const easeMs = flightState._drCorrectionMs ?? DR_CORRECTION_MS;
    const factor = elapsed >= easeMs ? 0 : 1 - elapsed / easeMs;
    const display = copyInto(
      add(raw, scale(flightState._drCorrection, factor)),
      flightState._trackedPosHolder,
    );

    // How the icon moved this frame, to carry it on through a re-anchor.
    if (sameTrack && !snapped) {
      copyInto(
        sub(display, flightState._drPrevDisplay),
        flightState._drPrevStep,
      );
      flightState._drPrevStepSec = dtSec;
    } else flightState._drPrevStepSec = 0;
    // The raw step, to judge the next frame by; none after a jump (its
    // step is the jump) or a track switch.
    if (sameTrack && !jumpedThisFrame) {
      copyInto(sub(raw, flightState._drPrevRaw), flightState._drPrevRawStep);
      flightState._drPrevRawStepSec = dtSec;
    } else flightState._drPrevRawStepSec = 0;
    copyInto(raw, flightState._drPrevRaw);
    copyInto(display, flightState._drPrevDisplay);
    flightState._drPrevMs = nowMs;
    flightState._drPrevWorldMs = worldMs;
    flightState._drReconcileValid = true;
    flightState._cachedDRPosition = display;
    const focusSizePx = _trackedFocusSizePx(
      icao24,
      flightState._cachedDRPosition,
    );
    // Publish the exact frame cache shared by billboard + follow camera. A second
    // DR sample here would advance reconciliation in a different frame phase
    // and visibly jitter the focus rectangle against the tracked aircraft.
    publishFocusTargetAt({
      ownerLayer: 'militaryFlights',
      id: icao24,
      viewer: flightState._viewer,
      displayPosition: flightState._cachedDRPosition,
      widthPx: focusSizePx,
      heightPx: focusSizePx,
    });
    return display;
  }

  /** The tracked plane's display position WITHOUT recomputing — the value the follow-camera already
   *  settled on this frame. Mirror of flights.js: getDetectableObjects + the readout run in postRender,
   *  later in the frame, so recomputing _trackedDisplayPosition there jitters the label against the
   *  now-stable plane. Null when no valid fix (callers fall back to the icon position). */

  function _trackedDisplayCached() {
    return flightState._drReconcileValid &&
      flightState._drReconcileIcao === flightState._trackedIcao
      ? flightState._cachedDRPosition
      : null;
  }

  /**
   * The position the tracked aircraft is VISUALLY at this frame — the translation its 3D
   * model is actually rendering with when the model owns the visual, otherwise the cached
   * dead-reckoned position. Mirror of flights.js; see that copy for the full rationale.
   * Reads the placement the tracked-model update already recorded this frame: no sampling,
   * no `_modelDisplayPosition` from postRender, and the entity record's `displayPosition` keeps its
   * follow-camera anti-jitter contract untouched.
   */

  function _trackedVisualCached() {
    if (
      flightState._trackedIcao &&
      parts.rendering._modelOwnsVisual(flightState._trackedIcao)
    ) {
      const spec = parts.rendering._modelSpec(
        flightState.records.data.get(flightState._trackedIcao),
      );
      return modelVisualAnchor(
        flightState._trackedModel.matrix,
        spec.visualCenterNative,
        parts.rendering._modelDrawnScale(flightState._trackedModel, spec),
        flightState._trackedVisualPos,
      );
    }
    return _trackedDisplayCached();
  }

  /** The tracked model's rendered bounding radius (m), or 0 when no model of this
   *  contact is drawing. Carries the scale it is drawn at, which may be
   *  above `scale` to satisfy its pixel floor — the trail head has to be judged
   *  against the size the operator SEES, not the nominal one. */
  /** World-space origin of the tracked model, or null when no model of this
   *  contact is drawing. This is the centre the rendered bounding sphere is
   *  measured from, so the trail clip and the envelope agree on one frame. */

  function _trackedModelCenterWorld() {
    if (
      !flightState._trackedIcao ||
      !flightState._trackedModel ||
      !parts.rendering._modelOwnsVisual(flightState._trackedIcao)
    )
      return null;
    const m = flightState._trackedModel.matrix;
    const out = flightState._scratchTrailClip;
    out.x = m[12];
    out.y = m[13];
    out.z = m[14];
    return out;
  }

  function _trackedModelEnvelopeM() {
    if (
      !flightState._trackedIcao ||
      !flightState._trackedModel ||
      !parts.rendering._modelOwnsVisual(flightState._trackedIcao)
    )
      return 0;
    const spec = parts.rendering._modelSpec(
      flightState.records.data.get(flightState._trackedIcao),
    );
    return (
      spec.nativeRadiusM *
      parts.rendering._modelDrawnScale(flightState._trackedModel, spec)
    );
  }

  /** Trail endpoint for the rendered tracked owner. Brackets/readouts stay on
   * the visual centre; only the trail moves to the model's aft-belly hardpoint. */

  function _trackedTrailCached() {
    if (
      flightState._trackedIcao &&
      parts.rendering._modelOwnsVisual(flightState._trackedIcao)
    ) {
      const spec = parts.rendering._modelSpec(
        flightState.records.data.get(flightState._trackedIcao),
      );
      // Through the model's OWN render chain (modelVisualAnchor's hand-rolled
      // half-correction put this offset on the lateral axis — see
      // modelAnchorWorld).
      return modelAnchorWorld(
        flightState._trackedModel.matrix,
        spec.trailAnchorNative,
        parts.rendering._modelDrawnScale(flightState._trackedModel, spec),
        flightState._trackedTrailPos,
      );
    }
    return _trackedDisplayCached();
  }

  /** Smoothed world course for the tracked aircraft this frame. Reads the
   *  frame-cached course (set by _trackedDisplayPosition — the follow-camera's
   *  own computation), NEVER re-runs _deadReckon. Safe to call more than once
   *  per frame: the second call sees dt≈0 and the limiter is a no-op.
   *
   *  The smoothed value lives in the SHARED per-icao _displayCourse entry (see
   *  its declaration): on click the limiter continues from whatever nose the
   *  fleet pass was displaying, and on untrack the fleet pass continues from
   *  whatever nose this path last wrote — tracked and fleet consumers of the
   *  same aircraft can never disagree across the handoff (mirror of flights.js). */

  function _trackedDisplayCourse() {
    const info = flightState.records.data.get(flightState._trackedIcao);
    const fallback = (info && info.track) || 0;
    const cacheValid =
      flightState._drReconcileValid &&
      flightState._drReconcileIcao === flightState._trackedIcao &&
      flightState._cachedDRCourse != null;
    const raw = cacheValid ? flightState._cachedDRCourse : fallback;
    const nowMs = Date.now();
    const dt = flightState._trackedCourseMs
      ? Math.min(
          COURSE_SLEW_DT_MAX_SEC,
          (nowMs - flightState._trackedCourseMs) / 1000,
        )
      : 0;
    flightState._trackedCourseMs = nowMs;
    const prev = flightState._displayCourse.get(flightState._trackedIcao);
    // Hover hold: at near-zero displayed speed both the chord and the reported
    // track are noise — keep the last stable nose direction instead of chasing.
    if (cacheValid && flightState._cachedDRHold && prev != null) return prev;
    const cap = courseSlewCapDps(
      cacheValid
        ? flightState._cachedDRSpeedMps
        : ((info && info.speedMps) ?? NaN),
      COURSE_MAX_DPS,
    );
    const course = limitCourseStep(prev, raw, cap, dt);
    flightState._displayCourse.set(flightState._trackedIcao, course);
    return course;
  }

  /** Reset reconciliation + per-frame cache when tracking stops or switches
   *  target. Deliberately does NOT touch _displayCourse: the smoothed course
   *  entry belongs to the AIRCRAFT (not to the tracked session) and must
   *  survive the handoff back to the fleet pass. */

  function _resetTrackedDisplay() {
    flightState._drReconcileValid = false;
    flightState._drReconcileIcao = null;
    flightState._cachedDRFrame = -1;
    flightState._cachedDRPosition = null;
    flightState._cachedDRCourse = null;
    flightState._cachedDRSpeedMps = null;
    flightState._cachedDRHold = false;
    flightState._trackedCourseMs = 0;
  }
  /** The display instant `epochMs` as a Julian date, for `_motionRegime`. */
  const _displayTimeAt = (epochMs, result) => julianAt(epochMs, result);

  /**
   * Re-floor STALE grounded contacts (mirror of the flights layer): a parked
   * contact whose feed went quiet froze at its pre-warm height. The
   * model-ownership gate matches the live grounded-clamp path (a
   * tileset-snapped model owns its visual; moving its icon would disturb
   * groundSnap's input, the one-shot invariant).
   */
  function _refloorStaleGroundedContacts(currentIcaos) {
    const { cachedGroundFloor, GROUND_FLOOR_LIFT_M } = services.groundFloor;
    for (const [icao24, info] of flightState.records.data) {
      if (!info?.onGround || currentIcaos.has(icao24)) continue;
      if (parts.rendering._modelOwnsVisual(icao24)) continue;
      if (!Number.isFinite(info.rawLat) || !Number.isFinite(info.rawLon))
        continue;
      const floor = cachedGroundFloor(info.rawLat, info.rawLon);
      if (!Number.isFinite(floor)) continue;
      const lifted = floor + GROUND_FLOOR_LIFT_M;
      if (
        Number.isFinite(info.renderAltitudeM) &&
        info.renderAltitudeM >= floor - 1
      )
        continue;
      const drawnM = info.renderAltitudeM;
      info.renderAltitudeM = lifted;
      liftGroundedHistory(
        flightState._positionHistory.get(icao24),
        fromDegrees(info.rawLon, info.rawLat, lifted),
        drawnM,
        lifted,
      );
      if (flightState._icons.has(icao24)) {
        parts.icons._applyIconPresentation(icao24);
        parts.icons._planIcon(icao24);
      }
    }
  }

  /**
   * Sample the rendered mesh under the collected floor cells (see
   * meshFloorSampler.js), leaving this layer's own icon and model sets out
   * of the probe so it cannot land on an aircraft instead of the pavement.
   */
  function _sampleMeshFloor(points, viewerLat, viewerLon) {
    services.meshFloor.sampleMeshFloorCells(flightState._viewer, points, {
      sets: parts.rendering._groundSampleExclusions().sets,
      viewerLat,
      viewerLon,
    });
  }

  return {
    _deadReckon,
    _fixPosition: fixPosition,
    _copyPosition: copyPosition,
    _historyFix: historyFix,
    _refloorStaleGroundedContacts,
    _sampleMeshFloor,
    _motionRegime,
    _displayTimeAt,
    _fixEpochMs: fixEpochMs,
    _signalLost,
    _extrapolateFix,
    _isTrackWarmingUp,
    _trackedFocusSizePx,
    _trackedDisplayPosition,
    _trackedDisplayCached,
    _trackedVisualCached,
    _trackedModelCenterWorld,
    _trackedModelEnvelopeM,
    _trackedTrailCached,
    _trackedDisplayCourse,
    _resetTrackedDisplay,
  };
}
