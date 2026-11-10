/** Camera placement, ground acquisition and motion correction for the Cockpit controller. */
import * as Cesium from 'cesium';
import {
  cockpitAnchorCorrectionStep,
  cockpitGroundSafeHeight,
  cockpitSurfaceWaitExpired,
  cockpitUiUpdateDue,
  slewHeading,
} from '../cockpitMath.js';
import {
  VESSEL_DEAD_RECKON_MAX_S,
  VESSEL_WATERLINE_REFRESH_MS,
  deadReckonVesselFix,
  vesselCameraProfile,
  vesselWaterlineM,
  waterlineProbePoints,
} from '../cockpitSubjects.js';
import { easeLook } from '../cockpitLook.js';
import {
  COCKPIT_HEADING_SLEW_DPS,
  COCKPIT_FORWARD_OFFSET_M,
  COCKPIT_UP_OFFSET_M,
  COCKPIT_MIN_GROUND_CLEARANCE_M,
  COCKPIT_VIEW_PITCH_DEG,
  COCKPIT_CAMERA_UPDATE_MS,
  COCKPIT_HUD_UPDATE_MS,
  COCKPIT_GROUND_PROBE_MS,
  COCKPIT_GROUND_WAIT_TIMEOUT_MS,
} from './cockpitPresentation.js';

/** The aircraft eye: just ahead of and above the reported position. */
const AIRCRAFT_CAMERA_PROFILE = Object.freeze({
  forwardM: COCKPIT_FORWARD_OFFSET_M,
  upM: COCKPIT_UP_OFFSET_M,
  pitchDeg: COCKPIT_VIEW_PITCH_DEG,
  minClearanceM: COCKPIT_MIN_GROUND_CLEARANCE_M,
});

export function update() {
  if (this.destroyed) return false;
  if (!this.active) {
    // Entry availability changes on a human timescale (tracking start/stop,
    // info arriving after a poll) — polling it every rendered frame ran
    // readAircraftInfo() + DOM pokes at display rate in plain map mode.
    // 250 ms keeps the chip imperceptibly fresh; trackedEntityChanged still
    // fires syncEntry immediately on the events that matter. (perf item 9)
    const nowMs = performance.now();
    if (nowMs - (this._lastEntrySyncMs || 0) >= 250) {
      this._lastEntrySyncMs = nowMs;
      this.syncEntry();
    }
    return;
  }

  const nowMs = performance.now();
  if (this.subjectKind === 'vessel') {
    updateVessel.call(this, nowMs);
    return;
  }
  if (this.subjectKind === 'satellite') {
    this.updateOrbital(nowMs);
    return;
  }
  const info = this.readAircraftInfo();

  // Adopt a newly selected track before the camera cadence gate. A context
  // NEXT/PREV selection can otherwise spend one frame driving the old
  // aircraft with the new aircraft's metadata.
  this._adoptTrackedEntity(nowMs, info);
  if (
    !info ||
    !this.trackedEntity ||
    !this.viewer.entities.contains(this.trackedEntity)
  ) {
    if (nowMs < this.contextNavigationDeadlineMs) return;
    this.exit({ restoreTracking: false });
    return;
  }
  if (
    !cockpitUiUpdateDue(
      nowMs,
      this.lastCameraUpdateMs,
      COCKPIT_CAMERA_UPDATE_MS,
    )
  )
    return;
  this.lastCameraUpdateMs = nowMs;

  const target = this.trackedEntity.position.getValue(
    this.viewer.clock.currentTime,
    this.scratchTarget,
  );
  if (!target) return;
  const dtSec = Math.min(0.1, Math.max(0, (nowMs - this.lastFrameMs) / 1000));
  this.lastFrameMs = nowMs;
  if (Number.isFinite(info.track)) {
    this.heading = slewHeading(
      this.heading ?? info.track,
      info.track,
      COCKPIT_HEADING_SLEW_DPS * dtSec,
    );
  }
  placeCamera.call(this, target, info, nowMs, dtSec, AIRCRAFT_CAMERA_PROFILE);
}

/**
 * The surface the ridden ship floats on: the layer's geoid sea surface, or
 * the water read off the rendered scene when that sits higher (a river or
 * lake above sea level). The read runs in the background every
 * VESSEL_WATERLINE_REFRESH_MS. The full-detail read can take many seconds
 * from cold tiles, so a new ship's first read starts from the tiles already
 * on screen; until any read lands the sea surface stands. Only one
 * full-detail read runs at a time (each is nine picks Cesium traverses
 * every frame until it settles): while one is still running, a refresh
 * reads the loaded tiles instead, and the slow read applies whenever it
 * lands. Once a full-detail read has answered, only full-detail reads
 * change the height; before then a loaded-tile read may find raised water
 * but never takes a raised height back to the sea. One coarse probe cannot
 * drop a river bridge to the sea, and a read that sampled nothing keeps
 * the height it had.
 * @param {{latitude: number, longitude: number}} [at] Where to read the
 *   water: the dead-reckoned position the camera rides.
 * @returns {number} Ellipsoidal metres.
 */
function vesselSurfaceM(info, nowMs, at = info) {
  const seaM = Number.isFinite(info.seaSurfaceHeightM)
    ? info.seaSurfaceHeightM
    : 0;
  const scene = this.viewer.scene;
  let read =
    this.vesselWaterline?.mmsi === info.mmsi ? this.vesselWaterline : null;
  if (
    typeof scene?.sampleHeightMostDetailed === 'function' &&
    (!read || nowMs - read.sampledMs >= VESSEL_WATERLINE_REFRESH_MS)
  ) {
    const probes = waterlineProbePoints(at.latitude, at.longitude).map(
      ({ lat, lon }) => Cesium.Cartographic.fromDegrees(lon, lat),
    );
    if (!read) {
      read = {
        mmsi: info.mmsi,
        heightM: loadedWaterlineM(scene, probes, seaM),
        sampledMs: nowMs,
        // Whether a full-detail read has answered for this ship.
        landed: false,
        inFlight: false,
      };
      this.vesselWaterline = read;
    } else {
      read.sampledMs = nowMs;
      if (read.inFlight && !read.landed) {
        const loadedM = loadedWaterlineM(scene, probes, seaM);
        // Taking a river back to the sea is the full-detail read's to say.
        const lowers =
          Number.isFinite(read.heightM) &&
          read.heightM > seaM &&
          !(loadedM > seaM);
        if (Number.isFinite(loadedM) && !lowers) read.heightM = loadedM;
      }
    }
    if (!read.inFlight) readWaterline.call(this, read, scene, probes, seaM);
  }
  return read && Number.isFinite(read.heightM)
    ? Math.max(seaM, read.heightM)
    : seaM;
}

/** Start one full-detail water read for `read`; its answer lands on it. */
function readWaterline(read, scene, probes, seaM) {
  read.inFlight = true;
  Promise.resolve()
    .then(() => scene.sampleHeightMostDetailed(probes))
    .then(
      (samples) => {
        if (this.vesselWaterline !== read) return;
        read.inFlight = false;
        // However late it lands, it applies; one that sampled nothing (tiles
        // not loaded yet) is no answer and keeps the height already read.
        const heights = (samples || []).map((sample) => sample?.height);
        if (!heights.some(Number.isFinite)) return;
        read.landed = true;
        read.heightM = vesselWaterlineM(seaM, heights);
      },
      () => {
        if (this.vesselWaterline === read) read.inFlight = false;
      },
    );
}

/**
 * The waterline from the tiles already loaded, read at once: a first answer
 * while the full-detail read loads. Null when the scene cannot sample or no
 * probe met loaded geometry: nothing sampled is no answer, not the sea, so it
 * never undoes a river height a full read set.
 */
function loadedWaterlineM(scene, probes, seaM) {
  if (typeof scene.sampleHeight !== 'function') return null;
  if (scene.sampleHeightSupported === false) return null;
  try {
    const heights = probes.map((probe) => scene.sampleHeight(probe));
    if (!heights.some(Number.isFinite)) return null;
    return vesselWaterlineM(seaM, heights);
  } catch {
    return null;
  }
}

/**
 * Drive the bridge camera from the selected vessel. The vessel layer redraws
 * a ship only when its feed refreshes, so the target is the last fix advanced
 * along course over ground; the shared anchor smoothing then absorbs the
 * correction each new fix brings.
 */
function updateVessel(nowMs) {
  // Tracking an aircraft from the bridge clears the vessel selection; end the
  // bridge and leave Cesium tracking with that aircraft.
  if (this.viewer.trackedEntity?.position) {
    this.exit({ restoreTracking: false });
    return;
  }
  const info = this.readVesselInfo();
  if (!info || info.mmsi !== this.subjectId) {
    this.exit({ restoreTracking: false });
    return;
  }
  if (
    !cockpitUiUpdateDue(
      nowMs,
      this.lastCameraUpdateMs,
      COCKPIT_CAMERA_UPDATE_MS,
    )
  )
    return;
  this.lastCameraUpdateMs = nowMs;

  const fix = deadReckonVesselFix(
    {
      latitude: info.latitude,
      longitude: info.longitude,
      courseDeg: info.motionCourse,
      speedMps: info.velocityMps,
      fixEpochMs: info.fixEpochMs,
      receivedAtMs: info.receivedAtMs,
      feedEpochMs: info.feedEpochMs,
    },
    Date.now(),
  );
  // The radar centres here too, so it agrees with the view out the window.
  this.vesselFix = fix;
  const target = Cesium.Cartesian3.fromDegrees(
    fix.longitude,
    fix.latitude,
    // Read the water where the ship is now, not at its last report.
    vesselSurfaceM.call(this, info, nowMs, fix),
    Cesium.Ellipsoid.WGS84,
    this.scratchTarget,
  );
  // The target advances in wall-clock time, so the anchor must too: the
  // aircraft path's 0.1 s step cap would leave a slow-frame or hitching bridge
  // falling ever further behind its own ship.
  const dtSec = Math.min(
    VESSEL_DEAD_RECKON_MAX_S,
    Math.max(0, (nowMs - this.lastFrameMs) / 1000),
  );
  this.lastFrameMs = nowMs;
  if (Number.isFinite(info.track)) {
    this.heading = slewHeading(
      this.heading ?? info.track,
      info.track,
      COCKPIT_HEADING_SLEW_DPS * dtSec,
    );
  }
  // Past the projection limit the target stops advancing; hold on it rather
  // than let the inertial anchor sail on alone.
  const projectionExpired =
    Number.isFinite(fix.ageSec) && fix.ageSec > VESSEL_DEAD_RECKON_MAX_S;
  // The look eases on its own clock: the anchor's step is capped differently.
  this.lookView = easeLook(
    this.lookView,
    this.lookTarget,
    nowMs - (this.lookLastMs || nowMs),
  );
  this.lookLastMs = nowMs;
  // A ship reporting neither course nor heading has no direction to move
  // in: its anchor stays on the fix, as the dead reckoning does.
  const ridden = Number.isFinite(info.motionCourse)
    ? info
    : { ...info, velocityMps: 0 };
  placeCamera.call(
    this,
    target,
    projectionExpired ? { ...ridden, stale: true } : ridden,
    nowMs,
    dtSec,
    vesselCameraProfile(info),
    this.lookView,
  );
}

/**
 * Place the camera for one update: advance the inertial anchor, clamp it and
 * the eye against the rendered surface, and look along the slewed heading.
 * @param {Cesium.Cartesian3} target Authoritative subject position.
 * @param {object} info Subject info; `motionCourse` (when present) is the
 *   direction the subject moves, otherwise it moves where it faces.
 * @param {number} nowMs Frame time.
 * @param {number} dtSec Seconds since the previous camera update.
 * @param {{forwardM: number, upM: number, pitchDeg: number,
 *   minClearanceM: number}} profile Eye offsets for the subject kind.
 * @param {?{yawDeg: number, pitchDeg: number}} [look] A bridge view turned
 *   off the bow: yaw relative to the heading and absolute pitch. It turns
 *   only the view; the eye and its motion keep the heading and course.
 *   Aircraft pass none and look along the heading at the profile pitch.
 */
function placeCamera(target, info, nowMs, dtSec, profile, look = null) {
  if (!this.cockpitAnchorValid) {
    Cesium.Cartesian3.clone(target, this.cockpitAnchor);
    this.cockpitAnchorValid = true;
  }

  // First-person motion cannot use the delayed feed correction as a raw
  // camera destination: a harmless icon re-anchor becomes a whole-world
  // surge/reversal in cockpit view. Advance the camera anchor inertially
  // from the reported course/speed and converge on the authoritative layer
  // display position at a bounded rate. This preserves the layer's required
  // 15/30-second interpolation and per-frame cache without exposing its
  // sample-boundary corrections to the camera.
  const headingRad = Cesium.Math.toRadians(this.heading ?? 0);
  const courseRad = Number.isFinite(info.motionCourse)
    ? Cesium.Math.toRadians(info.motionCourse)
    : headingRad;
  const pitchRad = Cesium.Math.toRadians(
    look ? look.pitchDeg : profile.pitchDeg,
  );
  const viewHeadingRad = look
    ? Cesium.Math.toRadians((this.heading ?? 0) + look.yawDeg)
    : headingRad;
  const speedMps = Number.isFinite(info.velocityMps)
    ? Math.max(0, info.velocityMps)
    : 0;

  if (info.stale) {
    // A feed backoff has no authoritative velocity epoch to advance from.
    // Hold the cockpit on the exact layer-rendered position so the camera
    // cannot coast away while the icon correctly remains fixed.
    Cesium.Cartesian3.clone(target, this.cockpitAnchor);
  } else {
    Cesium.Transforms.eastNorthUpToFixedFrame(
      this.cockpitAnchor,
      Cesium.Ellipsoid.WGS84,
      this.scratchEnu,
    );
    this.scratchLocal.x = Math.sin(courseRad);
    this.scratchLocal.y = Math.cos(courseRad);
    this.scratchLocal.z = 0;
    Cesium.Matrix4.multiplyByPointAsVector(
      this.scratchEnu,
      this.scratchLocal,
      this.scratchHorizontal,
    );
    Cesium.Cartesian3.normalize(this.scratchHorizontal, this.scratchHorizontal);
    Cesium.Cartesian3.multiplyByScalar(
      this.scratchHorizontal,
      speedMps * dtSec,
      this.scratchAdvance,
    );
    Cesium.Cartesian3.add(
      this.cockpitAnchor,
      this.scratchAdvance,
      this.cockpitAnchor,
    );
    Cesium.Cartesian3.subtract(
      target,
      this.cockpitAnchor,
      this.scratchCorrection,
    );
    const correctionDistanceM = Cesium.Cartesian3.magnitude(
      this.scratchCorrection,
    );
    const correctionStepM = cockpitAnchorCorrectionStep(
      correctionDistanceM,
      speedMps,
      dtSec,
    );
    if (correctionStepM > 0 && correctionDistanceM > 0) {
      Cesium.Cartesian3.multiplyByScalar(
        this.scratchCorrection,
        correctionStepM / correctionDistanceM,
        this.scratchCorrection,
      );
      Cesium.Cartesian3.add(
        this.cockpitAnchor,
        this.scratchCorrection,
        this.cockpitAnchor,
      );
    }
  }

  // The inertial anchor is independent of the layer's render-floor clamp and
  // can otherwise coast into a photoreal mesh while a landing contact is
  // between fixes. Clamp it against the same mesh-first shared floor used by
  // aircraft rendering. For a slow contact whose floor cell is still cold,
  // its already-clamped render position is a conservative temporary floor.
  const anchorCartographic = Cesium.Cartographic.fromCartesian(
    this.cockpitAnchor,
    Cesium.Ellipsoid.WGS84,
    this.scratchAnchorCartographic,
  );
  const targetCartographic = Cesium.Cartographic.fromCartesian(
    target,
    Cesium.Ellipsoid.WGS84,
    this.scratchTargetCartographic,
  );
  // A bridge's target is its fix dead-reckoned up to minutes ahead: read
  // the floor where the ship is now, as its water is.
  const floorAt =
    info.kind === 'vessel'
      ? {
          latitude: Cesium.Math.toDegrees(targetCartographic.latitude),
          longitude: Cesium.Math.toDegrees(targetCartographic.longitude),
        }
      : info;
  let cockpitFloorM = this.services.cachedGroundFloor(
    floorAt.latitude,
    floorAt.longitude,
  );
  if (info.onGround === true) {
    const groundPoint = [{ lat: info.latitude, lon: info.longitude }];
    this.services.warmGroundFloor(groundPoint);
    const meshFloorM = this.services.cachedMeshFloor(
      info.latitude,
      info.longitude,
    );
    if (this.services.meshFloorPreferred() && !Number.isFinite(meshFloorM)) {
      if (
        cockpitUiUpdateDue(
          nowMs,
          this.lastGroundProbeMs,
          COCKPIT_GROUND_PROBE_MS,
        )
      ) {
        this.lastGroundProbeMs = nowMs;
        const viewerCartographic = this.viewer.camera.positionCartographic;
        this.services.sampleMeshFloorCells(this.viewer.scene, groundPoint, {
          excludeObjects: [this.trackedEntity],
          viewerLat: Cesium.Math.toDegrees(viewerCartographic.latitude),
          viewerLon: Cesium.Math.toDegrees(viewerCartographic.longitude),
        });
      }
      cockpitFloorM = this.services.cachedMeshFloor(
        info.latitude,
        info.longitude,
      );
      if (!Number.isFinite(cockpitFloorM)) {
        if (!this.surfaceWaitStartedMs) this.surfaceWaitStartedMs = nowMs;
        if (
          !cockpitSurfaceWaitExpired(
            nowMs,
            this.surfaceWaitStartedMs,
            COCKPIT_GROUND_WAIT_TIMEOUT_MS,
          )
        ) {
          // Keep the already-safe map camera in place while the photoreal
          // surface under a parked aircraft is acquired. The bounded wait
          // prevents a permanently cold mesh cell from freezing cockpit.
          this.surfaceAcquiring = true;
          this.surfaceFallback = false;
          if (
            cockpitUiUpdateDue(
              nowMs,
              this.lastHudUpdateMs,
              COCKPIT_HUD_UPDATE_MS,
            )
          ) {
            this.lastHudUpdateMs = nowMs;
            this.updateHud(info, nowMs);
          }
          return;
        }
        this.surfaceAcquiring = false;
        this.surfaceFallback = true;
      } else {
        this.surfaceWaitStartedMs = 0;
        this.surfaceAcquiring = false;
        this.surfaceFallback = false;
      }
    }
  } else {
    this.surfaceWaitStartedMs = 0;
    this.surfaceAcquiring = false;
    this.surfaceFallback = false;
  }
  if (
    !Number.isFinite(cockpitFloorM) &&
    speedMps < 90 &&
    Number.isFinite(targetCartographic?.height)
  ) {
    cockpitFloorM =
      targetCartographic.height - this.services.GROUND_FLOOR_LIFT_M;
  }
  if (anchorCartographic && Number.isFinite(cockpitFloorM)) {
    const minimumAnchorHeightM = cockpitGroundSafeHeight(
      anchorCartographic.height,
      cockpitFloorM,
      profile.minClearanceM - profile.upM,
    );
    if (minimumAnchorHeightM !== anchorCartographic.height) {
      anchorCartographic.height = minimumAnchorHeightM;
      Cesium.Ellipsoid.WGS84.cartographicToCartesian(
        anchorCartographic,
        this.cockpitAnchor,
      );
    }
  }

  // Rebuild the local frame at the stabilized anchor after advancing it.
  Cesium.Transforms.eastNorthUpToFixedFrame(
    this.cockpitAnchor,
    Cesium.Ellipsoid.WGS84,
    this.scratchEnu,
  );
  this.scratchLocal.x = Math.sin(headingRad);
  this.scratchLocal.y = Math.cos(headingRad);
  this.scratchLocal.z = 0;
  Cesium.Matrix4.multiplyByPointAsVector(
    this.scratchEnu,
    this.scratchLocal,
    this.scratchHorizontal,
  );
  Cesium.Cartesian3.normalize(this.scratchHorizontal, this.scratchHorizontal);

  this.scratchLocal.x = Math.sin(viewHeadingRad) * Math.cos(pitchRad);
  this.scratchLocal.y = Math.cos(viewHeadingRad) * Math.cos(pitchRad);
  this.scratchLocal.z = Math.sin(pitchRad);
  Cesium.Matrix4.multiplyByPointAsVector(
    this.scratchEnu,
    this.scratchLocal,
    this.scratchForward,
  );
  Cesium.Cartesian3.normalize(this.scratchForward, this.scratchForward);

  this.scratchLocal.x = -Math.sin(viewHeadingRad) * Math.sin(pitchRad);
  this.scratchLocal.y = -Math.cos(viewHeadingRad) * Math.sin(pitchRad);
  this.scratchLocal.z = Math.cos(pitchRad);
  Cesium.Matrix4.multiplyByPointAsVector(
    this.scratchEnu,
    this.scratchLocal,
    this.scratchUp,
  );
  Cesium.Cartesian3.normalize(this.scratchUp, this.scratchUp);

  Cesium.Cartesian3.multiplyByScalar(
    this.scratchHorizontal,
    profile.forwardM,
    this.scratchCamera,
  );
  Cesium.Cartesian3.add(
    this.cockpitAnchor,
    this.scratchCamera,
    this.scratchCamera,
  );
  Cesium.Matrix4.getTranslation(this.scratchEnu, this.scratchTarget);
  Cesium.Cartesian3.normalize(this.scratchTarget, this.scratchTarget);
  Cesium.Cartesian3.multiplyByScalar(
    this.scratchTarget,
    profile.upM,
    this.scratchTarget,
  );
  Cesium.Cartesian3.add(
    this.scratchCamera,
    this.scratchTarget,
    this.scratchCamera,
  );

  // Recheck at the final forward-offset camera coordinate because a taxiing
  // aircraft can cross into an adjacent coarse floor cell between updates.
  const cameraCartographic = Cesium.Cartographic.fromCartesian(
    this.scratchCamera,
    Cesium.Ellipsoid.WGS84,
    this.scratchCameraCartographic,
  );
  if (cameraCartographic) {
    const cameraLat = Cesium.Math.toDegrees(cameraCartographic.latitude);
    const cameraLon = Cesium.Math.toDegrees(cameraCartographic.longitude);
    const cameraFloorM = this.services.cachedGroundFloor(cameraLat, cameraLon);
    if (Number.isFinite(cameraFloorM)) {
      cockpitFloorM = Math.max(
        cockpitFloorM ?? Number.NEGATIVE_INFINITY,
        cameraFloorM,
      );
    }
    const safeHeightM = cockpitGroundSafeHeight(
      cameraCartographic.height,
      cockpitFloorM,
      profile.minClearanceM,
    );
    if (safeHeightM !== cameraCartographic.height) {
      cameraCartographic.height = safeHeightM;
      Cesium.Ellipsoid.WGS84.cartographicToCartesian(
        cameraCartographic,
        this.scratchCamera,
      );
    }
  }

  this.viewer.camera.setView({
    destination: this.scratchCamera,
    orientation: { direction: this.scratchForward, up: this.scratchUp },
  });
  if (cockpitUiUpdateDue(nowMs, this.lastHudUpdateMs, COCKPIT_HUD_UPDATE_MS)) {
    this.lastHudUpdateMs = nowMs;
    this.updateHud(info, nowMs);
  }
}
