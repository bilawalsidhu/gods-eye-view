import * as Cesium from 'cesium';
import {
  lerpAngleDeg,
  speedRamp,
  courseBetweenCartesians,
  COURSE_HOLD_SPEED_MPS,
  staleCoastLimitSeconds,
  arcOffsetEnu,
  courseSlewCapDps,
  limitCourseStep,
} from '../../data/motionModel.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import {
  modelVisualAnchor,
  modelAnchorWorld,
} from '../../data/modelVisualAnchor.js';
import {
  RENDER_DELAY_SEC,
  TRACKED_MODEL_MAX_PX,
  TRACKED_MODEL_MIN_PX,
  BILLBOARD_SCALE,
  TRACKED_BILLBOARD_SCALE_BY_DISTANCE,
  DR_CORRECTION_MS,
  COURSE_SLEW_DT_MAX_SEC,
  COURSE_MAX_DPS,
} from './policy.js';

export function createMotion({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const { trackedModelScaleForPixelCap } = services.camera;
  const {
    nearFarScalarValueAtDistance,
    clearFocusTarget,
    publishFocusTargetFromCachedPosition,
  } = services.focus;

  /**
   * Dead-reckon an aircraft's current position using ENU (East-North-Up) frame math.
   *
   * Renders one poll interval behind real time so positions interpolate between
   * two KNOWN fixes whenever possible (see RENDER_DELAY_SEC rationale). When the
   * newest fix is older than the delayed render time (stale position), projects
   * forward using the aircraft's ground speed and track through the freshest
   * source contact plus a bounded grace window.
   *
   * @param {string} icao24 - ICAO hex identifier of the aircraft
   * @param {Cesium.Cartesian3} [result] - Optional out-parameter to write into.
   * @returns {Cesium.Cartesian3|null} Estimated current ECEF position, or null if no history
   */

  function _deadReckon(icao24, result) {
    const history = flightState._positionHistory.get(icao24);
    const info = flightState.records.data.get(icao24);
    if (!history || history.length === 0) {
      flightState._drCourseDeg = null;
      flightState._drSpeedMps = null;
      flightState._drCourseHold = false;
      return null;
    }

    const out = result || new Cesium.Cartesian3();
    // Render one poll interval behind real time so we interpolate between
    // two KNOWN fixes whenever possible (see RENDER_DELAY_SEC rationale).
    const renderTime = Cesium.JulianDate.addSeconds(
      Cesium.JulianDate.now(),
      -RENDER_DELAY_SEC,
      flightState._scratchRenderTime,
    );

    // Bracketing pair: interpolate — no extrapolation error, no snap-back.
    for (let i = history.length - 1; i >= 1; i--) {
      const a = history[i - 1];
      const b = history[i];
      if (
        Cesium.JulianDate.lessThanOrEquals(a.time, renderTime) &&
        Cesium.JulianDate.lessThanOrEquals(renderTime, b.time)
      ) {
        const span = Cesium.JulianDate.secondsDifference(b.time, a.time);
        const t =
          span > 0
            ? Cesium.JulianDate.secondsDifference(renderTime, a.time) / span
            : 1.0;
        // Course of the DISPLAYED motion. The chord is only trustworthy when the
        // segment covers real ground (at hover its direction is GPS jitter; on a
        // slow tight turn it STEPS the whole per-segment turn at each boundary),
        // so it is blended against the reported per-fix track by displayed
        // ground speed — and the track is TIME-INTERPOLATED between the fixes so
        // a slow turner's nose advances continuously through the segment instead
        // of snapping once per poll. Helicopters always use the reported track
        // (rotorcraft chords are noise-dominated at their typical speeds).
        const chordLenM = Cesium.Cartesian3.distance(a.position, b.position);
        const segSpeed =
          span > 0 ? chordLenM / span : (info && info.speedMps) || 0;
        const fallbackTrack = (info && info.track) || 0;
        const trackFrom = Number.isFinite(a.track) ? a.track : fallbackTrack;
        const trackTo = Number.isFinite(b.track) ? b.track : trackFrom;
        const trackCourse = lerpAngleDeg(trackFrom, trackTo, t);
        const w = info && info.klass === 'helicopter' ? 0 : speedRamp(segSpeed);
        const chordCourse =
          w > 0 ? courseBetweenCartesians(a.position, b.position) : null;
        flightState._drCourseDeg =
          chordCourse != null
            ? lerpAngleDeg(trackCourse, chordCourse, w)
            : trackCourse;
        flightState._drSpeedMps = segSpeed;
        flightState._drCourseHold = segSpeed < COURSE_HOLD_SPEED_MPS;
        return Cesium.Cartesian3.lerp(a.position, b.position, t, out);
      }
    }

    const newest = history[history.length - 1];
    const elapsedSec = Cesium.JulianDate.secondsDifference(
      renderTime,
      newest.time,
    );
    if (elapsedSec <= 0) {
      // Warm-up: renderTime predates ALL history (freshly seen / just-started-tracking
      // aircraft, before RENDER_DELAY_SEC of history has accumulated, so no bracketing
      // pair exists yet). Render at the DELAYED renderTime — preserving the behind-real-time
      // invariant — by extrapolating the OLDEST fix BACKWARD to renderTime. As history
      // fills, renderTime advances toward the first fix and the icon glides FORWARD into
      // the bracketing interpolation above with NO freeze and NO backward snap. (Holding
      // the oldest fix froze the icon until enough history accrued, then jumped.)
      const oldest = history[0];
      const lookbackSec = Cesium.JulianDate.secondsDifference(
        oldest.time,
        renderTime,
      ); // ≥ 0
      return _extrapolateFix(
        oldest,
        info,
        -Math.min(lookbackSec, 60),
        out,
        (info && info.turnRateDps) || 0,
      );
    }

    // Continue through fresh adsb.lol contacts even when the position epoch has
    // not advanced, but keep an absolute stale-feed drift ceiling.
    const coastLimitSec = staleCoastLimitSeconds({
      // Captured at poll normalization so the fleet tick does not allocate a
      // Date for every aircraft twelve times per second.
      fixEpochMs: Number.isFinite(newest.epochMs)
        ? newest.epochMs
        : Cesium.JulianDate.toDate(newest.time).getTime(),
      lastContactEpochMs: info?.lastContactEpochMs,
    });
    return _extrapolateFix(
      newest,
      info,
      Math.min(elapsedSec, coastLimitSec),
      out,
      (info && info.turnRateDps) || 0,
    );
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
    const speed = Number.isFinite(fix.velocity)
      ? fix.velocity
      : (info && info.speedMps) || 0;
    const heading = Number.isFinite(fix.track)
      ? fix.track
      : (info && info.track) || 0;
    flightState._drSpeedMps = speed;
    flightState._drCourseHold = speed < COURSE_HOLD_SPEED_MPS;
    if (speed === 0 || dt === 0) {
      flightState._drCourseDeg = heading;
      return Cesium.Cartesian3.clone(fix.position, out);
    }
    // Constant-rate-turn arc (straight line when turnRateDps ≈ 0) — a plane in a
    // standard-rate turn is ~90° of arc wrong per 30 s if extrapolated straight.
    arcOffsetEnu(speed, heading, turnRateDps, dt, flightState._scratchArc);
    flightState._drCourseDeg = flightState._scratchArc.endCourseDeg;
    Cesium.Cartesian3.fromElements(
      flightState._scratchArc.east,
      flightState._scratchArc.north,
      0,
      flightState._scratchOffset,
    );
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
      fix.position,
      Cesium.Ellipsoid.WGS84,
      flightState._scratchEnu,
    );
    return Cesium.Matrix4.multiplyByPoint(enu, flightState._scratchOffset, out);
  }

  /**
   * True while the tracked aircraft's delayed display time (now − RENDER_DELAY_SEC)
   * predates its oldest real fix — _deadReckon is extrapolating backward with no real
   * history yet behind the displayed icon, so the trail must draw nothing.
   * @returns {boolean}
   */

  function _isTrackWarmingUp() {
    if (!flightState._trackedIcao) return false;
    const history = flightState._positionHistory.get(flightState._trackedIcao);
    if (!history || history.length === 0) return true;
    const renderTime = Cesium.JulianDate.addSeconds(
      Cesium.JulianDate.now(),
      -RENDER_DELAY_SEC,
      flightState._scratchWarmupTime,
    );
    return Cesium.JulianDate.lessThan(renderTime, history[0].time);
  }

  /** Resolve the selected aircraft's actual rendered square extent this frame. */

  function _trackedFocusSizePx(icao24, position) {
    const camera = flightState._viewer?.camera;
    const scene = flightState._viewer?.scene;
    if (!camera?.positionWC || !position || !scene) return 28;
    const rangeM = Cesium.Cartesian3.distance(camera.positionWC, position);
    if (parts.rendering._modelOwnsVisual(icao24)) {
      const spec = parts.rendering._modelSpec(
        flightState.records.data.get(icao24)?.klass,
      );
      const scale = trackedModelScaleForPixelCap({
        baseScale: spec.scale,
        nativeRadiusM: spec.nativeRadiusM,
        rangeM,
        viewportHeightPx: scene.canvas.clientHeight,
        fovyRad: camera.frustum.fovy,
        maximumPixelSize: TRACKED_MODEL_MAX_PX,
      });
      const focalLengthPx =
        scene.canvas.clientHeight / (2 * Math.tan(camera.frustum.fovy / 2));
      const projectedDiameterPx =
        (2 * spec.nativeRadiusM * scale * focalLengthPx) / rangeM;
      return Math.max(
        TRACKED_MODEL_MIN_PX,
        Math.min(TRACKED_MODEL_MAX_PX, projectedDiameterPx),
      );
    }

    const billboard = flightState._trackedEntity?.billboard;
    const time = flightState._viewer.clock.currentTime;
    const width = billboard?.width?.getValue(time) ?? 28;
    const height = billboard?.height?.getValue(time) ?? 28;
    const scale =
      billboard?.scale?.getValue(time) ??
      BILLBOARD_SCALE *
        (CLASS_SCALE_2D[flightState.records.data.get(icao24)?.klass] || 1);
    const scaleByDistance =
      billboard?.scaleByDistance?.getValue(time) ??
      TRACKED_BILLBOARD_SCALE_BY_DISTANCE;
    const distanceScale = nearFarScalarValueAtDistance(scaleByDistance, rangeM);
    return Math.max(width, height) * scale * distanceScale;
  }

  /**
   * Per-frame-cached, discontinuity-smoothed tracked DISPLAY position. Cached by Cesium
   * frame number so the position / rotation / trail-head callbacks share ONE computation
   * (and one reconciliation-state update) per frame. Returns a stable module holder, or
   * null when the aircraft has no fix.
   * @param {string} icao24
   * @returns {Cesium.Cartesian3|null}
   */

  function _trackedDisplayPosition(icao24) {
    const frame = flightState._viewer?.scene?.frameState?.frameNumber ?? -1;
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
    const info = flightState.records.data.get(icao24);
    if (sameTrack) {
      const dtSec = Math.max(0.001, (nowMs - flightState._drPrevMs) / 1000);
      const speed = (info && info.speedMps) || 0;
      // Plausible single-frame motion (m): real velocity × frame Δt, ×4 slack + 25 m base.
      const plausible = speed * dtSec * 4 + 25;
      if (Cesium.Cartesian3.distance(raw, flightState._drPrevRaw) > plausible) {
        // Discontinuity — re-anchor so the DISPLAYED position stays continuous, then decay.
        Cesium.Cartesian3.subtract(
          flightState._drPrevDisplay,
          raw,
          flightState._drCorrection,
        );
        flightState._drCorrectionStartMs = nowMs;
      }
    } else {
      Cesium.Cartesian3.fromElements(0, 0, 0, flightState._drCorrection);
      flightState._drCorrectionStartMs = nowMs - DR_CORRECTION_MS; // fully decayed
    }

    const elapsed = nowMs - flightState._drCorrectionStartMs;
    const factor =
      elapsed >= DR_CORRECTION_MS ? 0 : 1 - elapsed / DR_CORRECTION_MS;
    const display = Cesium.Cartesian3.multiplyByScalar(
      flightState._drCorrection,
      factor,
      flightState._trackedPosHolder,
    );
    Cesium.Cartesian3.add(raw, display, display);

    Cesium.Cartesian3.clone(raw, flightState._drPrevRaw);
    Cesium.Cartesian3.clone(display, flightState._drPrevDisplay);
    flightState._drPrevMs = nowMs;
    flightState._drReconcileValid = true;
    flightState._cachedDRPosition = display;
    const focusSizePx = _trackedFocusSizePx(
      icao24,
      flightState._cachedDRPosition,
    );
    // Publish the exact frame cache shared by entity + follow camera. A second
    // DR sample here would advance reconciliation in a different frame phase
    // and visibly jitter the focus rectangle against the tracked aircraft.
    publishFocusTargetFromCachedPosition({
      ownerLayer: 'militaryFlights',
      id: icao24,
      scene: flightState._viewer?.scene,
      camera: flightState._viewer?.camera,
      displayPosition: flightState._cachedDRPosition,
      widthPx: focusSizePx,
      heightPx: focusSizePx,
    });
    return display;
  }

  /** The tracked plane's display position WITHOUT recomputing — the value the follow-camera already
   *  settled on this frame. Mirror of flights.js: getDetectableObjects + the readout run in postRender at
   *  a later frameNumber, so recomputing _trackedDisplayPosition there jitters the label against the
   *  now-stable plane. Null when no valid fix (callers fall back to the billboard position). */

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
   * Reads the modelMatrix the tracked-model update already wrote this frame: no sampling,
   * no `_modelDisplayPosition` from postRender, and `gevDisplayPosition` keeps its
   * follow-camera anti-jitter contract untouched.
   */

  function _trackedVisualCached() {
    if (
      flightState._trackedIcao &&
      parts.rendering._modelOwnsVisual(flightState._trackedIcao)
    ) {
      const spec = parts.rendering._modelSpec(
        flightState.records.data.get(flightState._trackedIcao)?.klass,
      );
      return modelVisualAnchor(
        flightState._trackedModel.modelMatrix,
        spec.visualCenterNative,
        Number.isFinite(flightState._trackedModel.computedScale)
          ? flightState._trackedModel.computedScale
          : spec.scale,
        flightState._trackedVisualPos,
      );
    }
    return _trackedDisplayCached();
  }

  /** The tracked model's rendered bounding radius (m), or 0 when no model of this
   *  contact is drawing. Carries Cesium's effective `computedScale`, which may be
   *  above `scale` to satisfy minimumPixelSize — the trail head has to be judged
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
    return Cesium.Matrix4.getTranslation(
      flightState._trackedModel.modelMatrix,
      flightState._scratchTrailClip,
    );
  }

  function _trackedModelEnvelopeM() {
    if (
      !flightState._trackedIcao ||
      !flightState._trackedModel ||
      !parts.rendering._modelOwnsVisual(flightState._trackedIcao)
    )
      return 0;
    const spec = parts.rendering._modelSpec(
      flightState.records.data.get(flightState._trackedIcao)?.klass,
    );
    const scale = Number.isFinite(flightState._trackedModel.computedScale)
      ? flightState._trackedModel.computedScale
      : spec.scale;
    return spec.nativeRadiusM * scale;
  }

  /** Trail endpoint for the rendered tracked owner. Brackets/readouts stay on
   * the visual centre; only the trail moves to the model's aft-belly hardpoint. */

  function _trackedTrailCached() {
    if (
      flightState._trackedIcao &&
      parts.rendering._modelOwnsVisual(flightState._trackedIcao)
    ) {
      const spec = parts.rendering._modelSpec(
        flightState.records.data.get(flightState._trackedIcao)?.klass,
      );
      // Through the model's OWN render chain (modelVisualAnchor's hand-rolled
      // half-correction put this offset on the lateral axis — see
      // modelAnchorWorld).
      return modelAnchorWorld(
        flightState._trackedModel,
        spec.trailAnchorNative,
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
  return {
    _deadReckon,
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
