import * as Cesium from 'cesium';
import {
  COURSE_HOLD_SPEED_MPS,
  lerpAngleDeg,
  speedRamp,
  courseBetweenCartesians,
  staleCoastLimitSeconds,
  arcOffsetEnu,
  courseSlewCapDps,
  limitCourseStep,
  corridorPathLatLon,
} from '../../data/motionModel.js';
import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import {
  modelVisualAnchor,
  modelAnchorWorld,
} from '../../data/modelVisualAnchor.js';
import {
  FOCUS_EVIDENCE_DEV,
  RENDER_DELAY_SEC,
  TRACKED_MODEL_MAX_PX,
  TRACKED_MODEL_MIN_PX,
  TRACKED_BILLBOARD_SCALE_BY_DISTANCE,
  DR_CORRECTION_MS,
  COURSE_SLEW_DT_MAX_SEC,
  COURSE_MAX_DPS,
  HELD_FLOOR_MAX_DRIFT_KM,
  NEIGHBOR_FLOOR_PROBE_MS,
  FLOOR_SEED_GRACE_MS,
  FLOOR_EASE_MAX_STEP,
  FLOOR_EASE_TAU_MS,
  FLOOR_EASE_EPSILON_M,
  DISPLAY_CORRIDOR_RADIUS_KM,
  DISPLAY_CORRIDOR_LOOKAHEAD_SEC,
  DISPLAY_CORRIDOR_CELL_BUDGET,
  DISPLAY_CORRIDOR_FAIR_SHARE,
} from './policy.js';

export function createMotion({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  const {
    cachedGroundFloor,
    GROUND_FLOOR_LIFT_M,
    neighborFloorM,
    stickyFloorCell,
    displayFloorHeightM,
    coarseFloorCoord,
    corridorFloorCells,
    allocateCorridorCells,
  } = services.groundFloor;
  const { trackedModelScaleForPixelCap } = services.camera;
  const {
    nearFarScalarValueAtDistance,
    clearFocusTarget,
    publishFocusTargetFromCachedPosition,
  } = services.focus;

  // Round 5: the old `_warmGroundedAircraftSurfaceCache` (global exact-5-decimal
  // warm for every grounded contact on Earth) is GONE. Parked-aircraft GPS
  // jitter minted fresh keys every poll → thousands of upstream points per
  // minute → Re:Earth proxy failures → geoid-fallback POISON cached at
  // sea-level heights → sunken sprites/trails and rejected mesh samples. The
  // coarse ~111 m floor cells (viewer-proximate, collected in the poll loop)
  // are the only DEM warm the layer needs.

  /**
   * Round 6: lifts STALE grounded contacts onto floors that warmed after
   * their last feed fix. A parked plane whose transponder went quiet keeps
   * coasting on its final meta — if that fix predated the floor warm, it sat
   * frozen underground forever. Runs once per poll over the (bounded) flight
   * map; touches only grounded, feed-absent, demonstrably-below-floor
   * contacts, and patches the stored fix + billboard in place (zero-velocity
   * DR renders the patched fix verbatim).
   * @param {Set<string>} currentIcaos - Contacts present in THIS poll (already
   *   floored by the live path — skipped here).
   */

  function _refloorStaleGroundedContacts(currentIcaos) {
    for (const [icao24, info] of flightState.records.data) {
      if (!info?.onGround || currentIcaos.has(icao24)) continue;
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
      info.renderAltitudeM = lifted;
      flightState._cullPositions.delete(icao24); // above the ellipsoid now (or floors say otherwise next poll)
      const position = Cesium.Cartesian3.fromDegrees(
        info.rawLon,
        info.rawLat,
        lifted,
      );
      const history = flightState._positionHistory.get(icao24);
      const newest = history?.[history.length - 1];
      if (newest)
        newest.position = Cesium.Cartesian3.clone(position, newest.position);
      const bb = flightState._billboards.get(icao24);
      if (bb) bb.position = position;
    }
  }

  /**
   * Dead-reckon an aircraft's current position using ENU (East-North-Up) frame math.
   *
   * Projects forward from the last known API fix using the aircraft's ground
   * velocity and true_track heading.  The ENU transform avoids repeated lat/lon
   * trig, keeping the per-frame cost low.
   *
   * If this aircraft is the tracked target and a lerp is in progress (new API
   * fix just arrived), the function first blends from the old dead-reckoned
   * position toward the corrected fix before projecting forward.
   *
   * @param {string} icao24 - ICAO 24-bit transponder address of the aircraft.
   * @returns {Cesium.Cartesian3|null} Estimated ECEF position, or null if no history exists.
   */

  function _deadReckon(icao24, result) {
    const info = flightState.records.data.get(icao24);
    if (FOCUS_EVIDENCE_DEV && flightState._focusEvidenceIds.has(icao24)) {
      const position = flightState._billboards.get(icao24)?.position;
      flightState._drCourseDeg = info?.true_track || 0;
      flightState._drSpeedMps = info?.velocity || 0;
      flightState._drCourseHold =
        flightState._drSpeedMps < COURSE_HOLD_SPEED_MPS;
      flightState._drExtrapolating = false;
      return position
        ? Cesium.Cartesian3.clone(position, result || new Cesium.Cartesian3())
        : null;
    }
    const history = flightState._positionHistory.get(icao24);
    if (!history || history.length === 0) {
      flightState._drCourseDeg = null;
      flightState._drSpeedMps = null;
      flightState._drCourseHold = false;
      flightState._drExtrapolating = false;
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
          span > 0 ? chordLenM / span : (info && info.velocity) || 0;
        const fallbackTrack = (info && info.true_track) || 0;
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
        flightState._drExtrapolating = false;
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
      // pair exists yet). Render at the DELAYED renderTime — preserving the 30s-behind
      // invariant — by extrapolating the OLDEST fix BACKWARD to renderTime. As history
      // fills, renderTime advances toward the first fix and the icon glides FORWARD into
      // the bracketing interpolation above with NO freeze and NO backward snap. (Holding
      // the oldest fix froze the icon; extrapolating the NEWEST fix to wall-clock now made
      // the icon jump back ~one poll interval the instant interpolation took over.)
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

    // Newest POSITION is older than renderTime. OpenSky can still be receiving
    // fresh contact/kinematic messages for that aircraft; freezing at a hard
    // 60 s-after-position boundary produced the visible stop → catch-up → stop
    // cadence. Coast through the latest real contact plus a bounded grace
    // window, with an absolute cap so a stale cached feed cannot drift forever.
    const coastLimitSec = staleCoastLimitSeconds({
      // `epochMs` is captured once when the poll is normalized. Avoid allocating
      // a Date per aircraft on every 12 Hz fleet tick.
      fixEpochMs: Number.isFinite(newest.epochMs)
        ? newest.epochMs
        : Cesium.JulianDate.toDate(newest.time).getTime(),
      lastContactEpochMs: info?.lastContactEpochMs,
      // Permit one minute of contact grace but cap any cached-feed drift at
      // five minutes. Source backoff is exposed separately as a STALE cue.
      minimumSec: 60,
      maximumSec: 300,
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
   * up = +Z; heading 0 deg = north, 90 deg = east. Sets `_drCourseDeg` to the
   * arc's instantaneous end course on every path.
   * Arc math adapted from skylight (https://github.com/cpaczek/skylight, MIT).
   */

  function _extrapolateFix(fix, info, dt, out, turnRateDps = 0) {
    const speed = Number.isFinite(fix.velocity)
      ? fix.velocity
      : (info && info.velocity) || 0;
    const heading = Number.isFinite(fix.track)
      ? fix.track
      : (info && info.true_track) || 0;
    flightState._drSpeedMps = speed;
    flightState._drCourseHold = speed < COURSE_HOLD_SPEED_MPS;
    flightState._drExtrapolating = true;
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
   * predates its oldest real fix — i.e. _deadReckon is extrapolating backward, with no
   * real history yet sitting BEHIND the displayed icon. The trail must draw nothing in
   * this window (every accumulated point is ahead of the icon).
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
      clearFocusTarget('flights', icao24);
      return null;
    }

    const nowMs = Date.now();
    const info = flightState.records.data.get(icao24);
    if (sameTrack) {
      const dtSec = Math.max(0.001, (nowMs - flightState._drPrevMs) / 1000);
      const speed = (info && info.velocity) || 0;
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
    let display = Cesium.Cartesian3.multiplyByScalar(
      flightState._drCorrection,
      factor,
      flightState._trackedPosHolder,
    );
    Cesium.Cartesian3.add(raw, display, display);
    // Same display floor the fleet pass applies — otherwise selecting a correctly
    // floored grounded billboard swapped it for an unfloored tracked entity and
    // dropped the cyan target back under the mesh. Applied HERE, at the single
    // point every VISUAL consumer's per-frame position is computed, so the
    // readout anchor, detection bracket, trail head and follow-camera all read
    // the one floored value (the anti-jitter contract forbids recomputing per
    // consumer). NOT the single point for DATA: `_describeFlight` deliberately
    // reports sensor truth — see the note there. Skipped while a tracked 3D model
    // owns the visual: it rides groundSnap's one-shot sample and moving its input
    // would force a re-sample (T7).
    display = _floorGroundedDisplayPosition(
      icao24,
      info,
      display,
      parts.rendering._modelOwnsVisual(icao24),
      nowMs,
    );

    Cesium.Cartesian3.clone(raw, flightState._drPrevRaw);
    Cesium.Cartesian3.clone(display, flightState._drPrevDisplay);
    flightState._drPrevMs = nowMs;
    flightState._drReconcileValid = true;
    flightState._cachedDRPosition = display;
    const focusSizePx = _trackedFocusSizePx(
      icao24,
      flightState._cachedDRPosition,
    );
    // Publish only the exact per-frame display cache the tracked entity/camera
    // consumes. Re-running DR from a later frame phase recreates the historical
    // target-vs-camera jitter bug.
    publishFocusTargetFromCachedPosition({
      ownerLayer: 'flights',
      id: icao24,
      scene: flightState._viewer?.scene,
      camera: flightState._viewer?.camera,
      displayPosition: flightState._cachedDRPosition,
      widthPx: focusSizePx,
      heightPx: focusSizePx,
    });
    return display;
  }

  /** The tracked plane's current display position WITHOUT recomputing — the exact value the
   *  follow-camera already settled on this frame (in the Viewer _onTick). getDetectableObjects + the
   *  readout run in postRender at a LATER frameNumber, so calling _trackedDisplayPosition there would
   *  re-run the dead-reckon on a fresh sample and double-advance the reconciliation → the label jitters
   *  against the now-stable plane (the model's jitter fix, resurfacing in the labels). Returns null when
   *  there's no valid fix for the tracked aircraft, so callers fall back to the billboard position. */

  function _trackedDisplayCached() {
    return flightState._drReconcileValid &&
      flightState._drReconcileIcao === flightState._trackedIcao
      ? flightState._cachedDRPosition
      : null;
  }

  /**
   * The position the tracked aircraft is VISUALLY at this frame — the translation its
   * 3D model is actually rendering with when the model owns the visual, otherwise the
   * cached dead-reckoned position the billboard uses.
   *
   * This exists because a grounded plane's model rides a one-shot ground snap while its
   * billboard deliberately stays at the reported (buried) altitude — a ~100 m vertical
   * split at an inland airport. Anything anchored to the display position while the model
   * is what you can see drifts below the aircraft and only converges as the coarse floor
   * cell warms ("the buoy"), sometimes never.
   *
   * It reads `modelMatrix`, which `_updateTrackedModel` already wrote this frame — no
   * sampling, no `_modelDisplayPosition` call from postRender, and no new dead reckoning,
   * so the follow-camera anti-jitter contract on `gevDisplayPosition` is untouched.
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

  /** Trail endpoint for the rendered tracked owner. Brackets/readouts stay on
   * the visual centre; only the trail moves to the model's lower-centre hardpoint. */
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
   *  whatever nose this path last wrote — the tracked and fleet consumers of
   *  the same aircraft can never disagree across the handoff. */

  function _trackedDisplayCourse() {
    const info = flightState.records.data.get(flightState._trackedIcao);
    const fallback = (info && info.true_track) || 0;
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
        : ((info && info.velocity) ?? NaN),
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

  /**
   * The floor to stand a grounded contact on while its own cell is unresolved.
   *
   * Owner directive (2026-08-21, after a Re:Earth outage buried a parked contact
   * at a Texas field): "hold the last known altitude until a fresh one comes in.
   * Never render otherwise." Two tiers, strongest first:
   *  own — a floor this contact's OWN cell resolved to while it stood there.
   *        Nothing weaker can improve on it, and its cell warming again is picked
   *        up by the live read, not here. Valid only within
   *        HELD_FLOOR_MAX_DRIFT_KM of where it was measured.
   *  neighbor — the LOWEST of at least two resolved ADJACENT cells (~111 m away,
   *        the same apron). Two at least, because one reading cannot be checked
   *        against anything, and the LOWEST because a high reading beside a cold
   *        cell is as likely to be a terminal roof as ground — see neighborFloorM.
   *
   * BOTH are validated measurements out of the shared floor cache. A third tier
   * that read the rendered mesh directly, where no DEM existed to check it, was
   * built and then REMOVED: run against a real GPU with the proxy down it
   * recorded a coarse-LOD 20.6 m for ground that is really ~122 m (see the note
   * in meshFloorSampler.js). Nothing in this chain is a guess.
   *
   * A neighbour hold keeps re-probing at the throttle so it can UPGRADE: a parked
   * contact that first answered from one neighbour would otherwise keep it after
   * a better one warmed. A held value is never dropped for nothing — a failed
   * probe leaves the previous answer standing — and a re-probe that lands LOWER
   * eases rather than steps (see the ease note in the clamp below).
   *
   * A REHYDRATED SEED is the one exception to the tier order. A floor parked by
   * `_retireDisplayFloorState` and picked back up on a later re-ground was
   * measured while the contact stood somewhere it no longer necessarily is: it is
   * a memory, not a reading, and it outranks nothing. So `seeded` demotes an
   * `own` floor below the neighbour tier — when two fresh adjacent cells can
   * answer, they answer, and the seed is discarded. It serves only while nothing
   * fresh contradicts it, which is exactly the flap case it exists for (a rotation
   * outruns its own cells, so nothing nearby is warm either). Without this a
   * contact that re-grounded 0.5 km away kept a 200 m floor while its new
   * neighbourhood read 100 m and 105 m, and rendered 100 m in the air.
   *
   * @param {object} state - The contact's `_displayFloorState` entry (mutated).
   * @param {{lat: number, lon: number}} cell - Cell the display is reading now.
   * @param {number} nowMs - Tick clock.
   * @returns {number|null} Floor to use, or null when nothing anywhere can answer.
   */

  function _heldDisplayFloorM(state, cell, nowMs) {
    if (
      state.heldTier &&
      !(
        Number.isFinite(state.heldM) &&
        state.heldCell &&
        parts.queries._approxDistanceKm(
          cell.lat,
          cell.lon,
          state.heldCell.lat,
          state.heldCell.lon,
        ) <= HELD_FLOOR_MAX_DRIFT_KM
      )
    ) {
      // Out of range: the held value is no longer a measurement of anywhere this
      // contact has been. Drop it rather than stretch it.
      _dropHeldFloor(state);
    }
    if (state.heldTier === 'own' && !state.seeded) return state.heldM;
    if (
      state.probeMs != null &&
      nowMs - state.probeMs < NEIGHBOR_FLOOR_PROBE_MS
    )
      return state.heldM;
    state.probeMs = nowMs;
    const near = neighborFloorM(cell);
    if (near != null) return _adoptHeldFloorM(state, near, cell, 'neighbor');
    return state.heldM;
  }

  /** Records a held floor and the tier it came from; returns it. Every caller
   *  passes a floor measured for the cell the contact is reading NOW, so an
   *  adoption always clears the seed flag: live evidence has arrived. */

  function _adoptHeldFloorM(state, floorM, cell, tier) {
    state.heldM = floorM;
    state.heldCell = cell;
    state.heldTier = tier;
    state.seeded = false;
    return floorM;
  }

  /** Forgets the held floor and everything that describes where it came from,
   *  leaving the rest of the contact's display state alone. */

  function _dropHeldFloor(state) {
    state.heldM = null;
    state.heldCell = null;
    state.heldTier = null;
    state.seeded = false;
  }

  /** Whether a parked seed has been away longer than the grace window.
   *
   *  ONE judgement, asked from BOTH sides of the park, because neither side sees
   *  the whole story on its own. While the contact keeps reporting, the retire
   *  path asks it and drops the entry. But a contact can be parked and then make
   *  no calls at all — off the poll for a long-haul cruise, out of the corridor
   *  radius, tab hidden — and then re-ground; nothing ran in between, so an
   *  expiry checked only on the retire path never fires and an arbitrarily old
   *  measurement walks back in (measured: parked 198 s, still reused). The
   *  rehydration side therefore asks the same question against the wall clock
   *  before it clears `retiredMs`.
   *  @param {object} state @param {number} nowMs - Tick clock. */

  function _seedExpired(state, nowMs) {
    return (
      state.retiredMs != null && nowMs - state.retiredMs > FLOOR_SEED_GRACE_MS
    );
  }

  /** Retires a contact's display-floor state. Called the moment it stops being a
   *  grounded billboard — airborne, model-owned, or gone.
   *
   *  The floor itself is kept as a rehydration seed for FLOOR_SEED_GRACE_MS (see
   *  above) and MARKED as one; everything that describes the contact's CURRENT
   *  rendering is cleared, so a re-ground recomputes from scratch and cannot be
   *  mistaken for a hold release. Nothing visual is touched, so the T7
   *  model-ownership gate is unaffected.
   *  @param {string} icao24 @param {number} nowMs - Tick clock. */

  function _retireDisplayFloorState(icao24, nowMs) {
    const state = flightState._displayFloorState.get(icao24);
    if (!state) return;
    if (state.retiredMs == null) {
      state.retiredMs = nowMs;
      state.seeded = true; // what it answers with next is a memory, not a reading
      state.heldActive = false; // a later landing is an arrival, not a release
      state.easedM = null;
      state.easeMs = null;
      state.probeMs = null; // re-ground may probe immediately
      state.out = null;
      state.effectiveM = null;
      Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO, state.in); // invalidate the memo
    } else if (_seedExpired(state, nowMs)) {
      flightState._displayFloorState.delete(icao24); // airborne long enough to be anywhere
    }
  }

  /**
   * Floors a GROUNDED contact's DISPLAYED position onto the local ground.
   *
   * `renderAltitudeM` is chosen once per poll from the floor of the FIX's coarse
   * cell. The position that renders is the dead-reckoned one, which drifts away
   * from that fix for the whole segment — and for up to 300 s / several hundred
   * metres while a ground contact coasts through its stale-feed grace. Across a
   * graded apron (KAUS spans ~119–140 m ellipsoidal) that drift buries the
   * sprite under the mesh it is now over; `scripts/qa-floor-verify.mjs` measured
   * −15.5 m. A second, smaller share comes from the fix-time floor itself: a
   * taxiing contact whose current cell is still cold falls back to the PREVIOUS
   * fix's cell (see the grounded `surfaceM` chain) and nothing revisits that
   * height once the cell warms — the stale re-floor sweep deliberately skips
   * contacts present in the poll. Both are cured by reading the floor at the
   * coordinate actually being displayed.
   *
   * Discipline:
   *  - READ-ONLY against the shared floor cache. No latch, no heal, no sampling.
   *    Keeping cold cells rare is `_collectDisplayCorridorCells`'s job, not this
   *    one's. A cold cell used to mean NO clamp at all, which was only safe while
   *    the un-clamped height was a real reading — and for a grounded contact with
   *    no altitude data it is not: the poll path's last resort is the geoid, tens
   *    of metres under the mesh at an inland field. When the cell cannot answer,
   *    `_heldDisplayFloorM` holds the last floor that DID (owner, 2026-08-21).
   *    Still never an invented surface: every tier is a measurement, and when
   *    none exists the position passes through as before.
   *  - Grounded contacts only. Airborne heights are the fix-time clamp's job.
   *  - NEVER when a 3D model owns the visual (T7): the model rides groundSnap's
   *    one-shot tileset sample and the billboard hides behind it, so clamping the
   *    hidden billboard would put a SECOND ground chain on one contact — and the
   *    one the operator is not looking at. (The original rationale was narrower:
   *    lifting the datum dragged groundSnap's input past its 50 m
   *    move-invalidation and forced a re-sample every frame. groundSnap now
   *    measures that distance on the ellipsoid, so a purely vertical change costs
   *    nothing; the gate stays for the reason above.) Same gate the military
   *    layer's grounded billboard lift uses.
   *
   * @param {string} icao24 - Contact key (owns one `_displayFloorState` entry).
   * @param {object|null|undefined} info - `_flightData` record for this contact.
   * @param {Cesium.Cartesian3|null} pos - Dead-reckoned display position.
   * @param {boolean} modelOwnsVisual - Whether a 3D model is drawing this contact.
   * @param {number} [nowMs] - Tick clock, passed by both callers so the release
   *   ease advances on the same clock the rest of the tick uses.
   * @returns {Cesium.Cartesian3|null} `pos` itself when nothing moves (the common
   *   case — no allocation, no rebuild), otherwise the lifted position.
   */

  function _floorGroundedDisplayPosition(
    icao24,
    info,
    pos,
    modelOwnsVisual,
    nowMs = Date.now(),
  ) {
    if (!pos || !info?.onGround || modelOwnsVisual) {
      _retireDisplayFloorState(icao24, nowMs);
      return pos;
    }
    const state = flightState._displayFloorState.get(icao24);
    const carto = Cesium.Cartographic.fromCartesian(
      pos,
      Cesium.Ellipsoid.WGS84,
      flightState._scratchDisplayCarto,
    );
    // Boundary hysteresis: a position jittering across a cell edge would flip
    // floors at fleet-tick rate (see stickyFloorCell).
    const cell = stickyFloorCell(
      Cesium.Math.toDegrees(carto.latitude),
      Cesium.Math.toDegrees(carto.longitude),
      state?.cell,
    );
    const floor = cachedGroundFloor(cell.lat, cell.lon);
    const next = state || {
      cell,
      in: new Cesium.Cartesian3(),
      out: null,
      effectiveM: null,
      heldM: null,
      heldCell: null,
      heldTier: null,
      heldActive: false,
      seeded: false,
      probeMs: null,
      easedM: null,
      easeMs: null,
      retiredMs: null,
    };
    // Back on the ground. Judge the seed's AGE here, before `retiredMs` is
    // cleared: a contact that made no calls while it was away never reached the
    // retire path's own expiry branch, so this is the only place that can tell an
    // hour-old measurement from a three-poll-old one.
    if (_seedExpired(next, nowMs)) _dropHeldFloor(next);
    // The seed (if any survived) is live again, and the drift bound plus the
    // neighbour tier in the hold chain decide whether it still describes ground
    // this contact is on.
    next.retiredMs = null;
    // The floor to clamp against: this cell when it has one, otherwise the last
    // one that resolved for this contact (never the geoid the poll path fell to).
    // Snapshot what the contact was standing on BEFORE the chain overwrites it —
    // the ease decision below needs the previous value, and `_heldDisplayFloorM`
    // adopts into the same fields.
    const wasHeld = next.heldActive;
    const stoodOnM = next.heldM;
    let effective = floor;
    if (Number.isFinite(effective)) {
      _adoptHeldFloorM(next, effective, cell, 'own');
      next.heldActive = false;
    } else {
      effective = _heldDisplayFloorM(next, cell, nowMs);
      next.heldActive = Number.isFinite(effective);
    }
    // The floor moved DOWN under a contact that was standing on a BORROWED one.
    // Dropping it by that difference in a single tick is the snap the owner asked
    // not to have, so approach it instead. Two ways in, and both need it:
    //  - the real floor arrives below the hold (releasing the hold);
    //  - a re-probe finds a LOWER neighbour than the one being held, which the
    //    12 m spread bound can make a large step on a mesa edge (200 m held, a
    //    120 m neighbour warms, the bounded answer is 132 m) — and can happen
    //    AGAIN while the first approach is still running.
    // Scoped to a borrowed floor on purpose: an ordinary cell-to-cell change
    // between two resolved floors is the existing path and keeps its timing.
    if (
      next.easedM == null &&
      wasHeld &&
      Number.isFinite(stoodOnM) &&
      Number.isFinite(effective) &&
      effective < stoodOnM
    ) {
      next.easedM = stoodOnM; // start from where the contact is actually drawn
      next.easeMs = nowMs;
    }
    if (next.easedM != null) {
      if (!Number.isFinite(effective) || effective >= next.easedM) {
        // Nothing to approach, or the floor rose: take it whole and stop.
        next.easedM = null;
        next.easeMs = null;
      } else {
        // Exponential approach from the DISPLAYED value. The target may have
        // moved since last tick; that changes only where this is heading, never
        // where it is, so there is no seam to jump across.
        const dtMs = Math.max(0, nowMs - next.easeMs);
        next.easeMs = nowMs;
        const closed = Math.min(
          FLOOR_EASE_MAX_STEP,
          1 - Math.exp(-dtMs / FLOOR_EASE_TAU_MS),
        );
        let value = next.easedM + (effective - next.easedM) * closed;
        if (Math.abs(value - effective) <= FLOOR_EASE_EPSILON_M) {
          value = effective; // arrive exactly, so a parked contact stops rebuilding
          next.easedM = null;
          next.easeMs = null;
        } else {
          next.easedM = value;
        }
        effective = value;
      }
    }
    // Same input position AND the same EFFECTIVE floor ⇒ the same answer as last
    // tick, so skip the rebuild. A clamped stationary contact (parked, coasting
    // on a zero-velocity fix) hits this every tick; without it the identical
    // Cartesian was rebuilt at ~12 Hz forever. The test is deliberately on the
    // OUTPUT of the hold chain, not on its inputs: keying it to the raw cell
    // floor let a parked contact whose cell never warmed return a memoized
    // unresolved answer forever, so an adjacent-cell floor warming later was
    // never adopted. One owned entry per grounded
    // contact — O(grounded), dropped on eviction, on destroy, and the moment the
    // contact stops being a grounded billboard.
    if (
      state &&
      state.effectiveM === effective &&
      Cesium.Cartesian3.equals(pos, state.in)
    ) {
      return state.out || pos;
    }
    const lifted = displayFloorHeightM(carto.height, effective);
    next.cell = cell;
    next.effectiveM = effective;
    Cesium.Cartesian3.clone(pos, next.in);
    if (lifted == null) {
      next.out = null;
    } else {
      // The cache OWNS its output: returning a shared scratch would let the next
      // contact in the fleet loop overwrite a position already handed out.
      next.out = Cesium.Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        lifted,
        Cesium.Ellipsoid.WGS84,
        next.out || new Cesium.Cartesian3(),
      );
    }
    if (!state) flightState._displayFloorState.set(icao24, next);
    return next.out || pos;
  }

  /**
   * Adds the cells each grounded contact's DISPLAY is about to render over to
   * this poll's floor warm/sample batch.
   *
   * The poll loop otherwise collects FIX cells only, so the clamp above has data
   * exactly where the contact ISN'T. A contact taxiing at 10 m/s crosses a
   * ~111 m cell every ~11 s while the batch runs once per 30 s poll, so it stays
   * permanently ahead of its own floor data (the "taxiing cache" failure mode, at
   * cell granularity) and the clamp silently passes.
   *
   * The corridor therefore follows the direction the display is actually MOVING,
   * which is not always toward the fix:
   *  - INTERPOLATING between two fixes — the display is walking to the newest
   *    fix, so that fix is the endpoint (exact, no projection error).
   *  - EXTRAPOLATING — coasting past the newest fix on a stale feed, or the
   *    pre-history warm-up — the display travels along its course AWAY from that
   *    fix. Aiming at the fix here warms the BACKTRAIL while the contact stays
   *    one sampling cycle ahead and buried, so the endpoint is the position its
   *    own kinematics put it at two poll intervals from now.
   *
   * Runs EVERY poll, warm cells included, for the same reason the fix cells do:
   * `warmGroundFloor` skips cells that already have a real DEM, but the mesh
   * sampler needs to see a cell again AFTER its DEM prior lands, since a sample
   * without that prior is rejected. Offering a cell once would leave it DEM-only
   * for the session — at fields where the photogrammetric mesh sits well above
   * bare earth that is still metres of burial.
   *
   * Budgeting is need-ranked and dedupe-first: cells this poll already collected
   * cost NOTHING (a parked contact's corridor is its own fix cell, so it never
   * competes), candidates are ordered by how many of their cells are actually
   * cold, and each takes at most DISPLAY_CORRIDOR_FAIR_SHARE before anyone takes
   * seconds. Insertion-order spending starved the contacts that needed it most.
   *
   * Purely additive to the existing batch: same fire-and-forget DEM resolve, same
   * one-shot DEM-validated mesh sampler. No latch, no heal.
   *
   * @param {Array<{lat: number, lon: number}>} out - This poll's warm points.
   * @param {number|null} viewerLat @param {number|null} viewerLon - Viewer subpoint.
   */

  function _collectDisplayCorridorCells(out, viewerLat, viewerLon) {
    if (viewerLat == null || viewerLon == null) return;
    // Cells the poll already collected (grounded + low-airborne fix cells).
    const seen = new Set();
    for (const p of out) {
      const c = coarseFloorCoord(p.lat, p.lon);
      seen.add(`${c.lat},${c.lon}`);
    }

    const candidates = [];
    for (const [icao24, info] of flightState.records.data) {
      if (!info?.onGround) continue;
      // T7: a contact whose 3D model is the visual never reads a display floor.
      if (parts.rendering._modelOwnsVisual(icao24)) continue;
      if (!Number.isFinite(info.rawLat) || !Number.isFinite(info.rawLon))
        continue;
      if (
        parts.queries._approxDistanceKm(
          viewerLat,
          viewerLon,
          info.rawLat,
          info.rawLon,
        ) > DISPLAY_CORRIDOR_RADIUS_KM
      )
        continue;
      const dr = _deadReckon(icao24, flightState._scratchCorridorPos);
      if (!dr) continue;
      // Read the sibling scratches IMMEDIATELY, before any other _deadReckon call.
      const extrapolating = flightState._drExtrapolating;
      const speedMps = Number.isFinite(flightState._drSpeedMps)
        ? flightState._drSpeedMps
        : info.velocity || 0;
      const courseDeg =
        flightState._drCourseDeg != null
          ? flightState._drCourseDeg
          : info.true_track || 0;
      const c = Cesium.Cartographic.fromCartesian(
        dr,
        Cesium.Ellipsoid.WGS84,
        flightState._scratchCorridorCarto,
      );
      const lat = Cesium.Math.toDegrees(c.latitude);
      const lon = Cesium.Math.toDegrees(c.longitude);
      const cells = corridorFloorCells(
        corridorPathLatLon({
          extrapolating,
          displayLat: lat,
          displayLon: lon,
          courseDeg,
          speedMps,
          // Same turn the dead-reckon integrates — a sustained-turn taxi leaves a
          // straight tangent within a few hundred metres.
          turnRateDps: info.turnRateDps || 0,
          fixLat: info.rawLat,
          fixLon: info.rawLon,
          lookaheadSec: DISPLAY_CORRIDOR_LOOKAHEAD_SEC,
        }),
      );
      let cold = 0;
      for (const cell of cells) {
        if (cachedGroundFloor(cell.lat, cell.lon) == null) cold += 1;
      }
      candidates.push({ cells, cold, speedMps });
    }
    flightState._corridorEpoch += 1;
    for (const cell of allocateCorridorCells(
      candidates,
      seen,
      DISPLAY_CORRIDOR_CELL_BUDGET,
      DISPLAY_CORRIDOR_FAIR_SHARE,
      flightState._corridorEpoch,
    )) {
      out.push(cell);
    }
  }
  return {
    _refloorStaleGroundedContacts,
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
    _heldDisplayFloorM,
    _adoptHeldFloorM,
    _dropHeldFloor,
    _seedExpired,
    _retireDisplayFloorState,
    _floorGroundedDisplayPosition,
    _collectDisplayCorridorCells,
  };
}
