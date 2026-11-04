/** Camera placement, ground acquisition and motion correction for the Cockpit controller. */
import * as geo from '../geo/index.js';
import {
  cockpitAnchorCorrectionStep,
  cockpitGroundSafeHeight,
  cockpitSurfaceWaitExpired,
  cockpitUiUpdateDue,
  slewHeading,
} from '../cockpitMath.js';
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
  const info = this.readAircraftInfo();

  // Adopt a newly selected track before the camera cadence gate. A context
  // NEXT/PREV selection can otherwise spend one frame driving the old
  // aircraft with the new aircraft's metadata.
  this._adoptTrackedEntity(nowMs, info);
  if (!info || !this.trackedEntity || !this.host.contains(this.trackedEntity)) {
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

  const target = this.host.position(this.trackedEntity, this.scratchTarget);
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

  if (!this.cockpitAnchorValid) {
    geo.cartesian3.clone(target, this.cockpitAnchor);
    this.cockpitAnchorValid = true;
  }

  // First-person motion cannot use the delayed feed correction as a raw
  // camera destination: a harmless icon re-anchor becomes a whole-world
  // surge/reversal in cockpit view. Advance the camera anchor inertially
  // from the reported course/speed and converge on the authoritative layer
  // display position at a bounded rate. This preserves the layer's required
  // 15/30-second interpolation and per-frame cache without exposing its
  // sample-boundary corrections to the camera.
  const headingRad = geo.math.toRadians(this.heading ?? 0);
  const pitchRad = geo.math.toRadians(COCKPIT_VIEW_PITCH_DEG);
  const speedMps = Number.isFinite(info.velocityMps)
    ? Math.max(0, info.velocityMps)
    : 0;

  if (info.stale) {
    // A feed backoff has no authoritative velocity epoch to advance from.
    // Hold the cockpit on the exact layer-rendered position so the camera
    // cannot coast away while the icon correctly remains fixed.
    geo.cartesian3.clone(target, this.cockpitAnchor);
  } else {
    geo.transforms.eastNorthUpToFixedFrame(
      this.cockpitAnchor,
      geo.ellipsoid.WGS84,
      this.scratchEnu,
    );
    this.scratchLocal.x = Math.sin(headingRad);
    this.scratchLocal.y = Math.cos(headingRad);
    this.scratchLocal.z = 0;
    geo.matrix4.multiplyByPointAsVector(
      this.scratchEnu,
      this.scratchLocal,
      this.scratchHorizontal,
    );
    geo.cartesian3.normalize(this.scratchHorizontal, this.scratchHorizontal);
    geo.cartesian3.multiplyByScalar(
      this.scratchHorizontal,
      speedMps * dtSec,
      this.scratchAdvance,
    );
    geo.cartesian3.add(
      this.cockpitAnchor,
      this.scratchAdvance,
      this.cockpitAnchor,
    );
    geo.cartesian3.subtract(target, this.cockpitAnchor, this.scratchCorrection);
    const correctionDistanceM = geo.cartesian3.magnitude(
      this.scratchCorrection,
    );
    const correctionStepM = cockpitAnchorCorrectionStep(
      correctionDistanceM,
      speedMps,
      dtSec,
    );
    if (correctionStepM > 0 && correctionDistanceM > 0) {
      geo.cartesian3.multiplyByScalar(
        this.scratchCorrection,
        correctionStepM / correctionDistanceM,
        this.scratchCorrection,
      );
      geo.cartesian3.add(
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
  const anchorCartographic = geo.cartographic.fromCartesian(
    this.cockpitAnchor,
    geo.ellipsoid.WGS84,
    this.scratchAnchorCartographic,
  );
  const targetCartographic = geo.cartographic.fromCartesian(
    target,
    geo.ellipsoid.WGS84,
    this.scratchTargetCartographic,
  );
  let cockpitFloorM = this.services.cachedGroundFloor(
    info.latitude,
    info.longitude,
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
        const viewerCartographic = this.host.cartographic();
        this.services.sampleMeshFloorCells(this.host.surface, groundPoint, {
          excludeObjects: [this.trackedEntity],
          viewerLat: geo.math.toDegrees(viewerCartographic.latitude),
          viewerLon: geo.math.toDegrees(viewerCartographic.longitude),
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
      COCKPIT_MIN_GROUND_CLEARANCE_M - COCKPIT_UP_OFFSET_M,
    );
    if (minimumAnchorHeightM !== anchorCartographic.height) {
      anchorCartographic.height = minimumAnchorHeightM;
      geo.ellipsoid.WGS84.cartographicToCartesian(
        anchorCartographic,
        this.cockpitAnchor,
      );
    }
  }

  // Rebuild the local frame at the stabilized anchor after advancing it.
  geo.transforms.eastNorthUpToFixedFrame(
    this.cockpitAnchor,
    geo.ellipsoid.WGS84,
    this.scratchEnu,
  );
  this.scratchLocal.x = Math.sin(headingRad);
  this.scratchLocal.y = Math.cos(headingRad);
  this.scratchLocal.z = 0;
  geo.matrix4.multiplyByPointAsVector(
    this.scratchEnu,
    this.scratchLocal,
    this.scratchHorizontal,
  );
  geo.cartesian3.normalize(this.scratchHorizontal, this.scratchHorizontal);

  this.scratchLocal.x = Math.sin(headingRad) * Math.cos(pitchRad);
  this.scratchLocal.y = Math.cos(headingRad) * Math.cos(pitchRad);
  this.scratchLocal.z = Math.sin(pitchRad);
  geo.matrix4.multiplyByPointAsVector(
    this.scratchEnu,
    this.scratchLocal,
    this.scratchForward,
  );
  geo.cartesian3.normalize(this.scratchForward, this.scratchForward);

  this.scratchLocal.x = -Math.sin(headingRad) * Math.sin(pitchRad);
  this.scratchLocal.y = -Math.cos(headingRad) * Math.sin(pitchRad);
  this.scratchLocal.z = Math.cos(pitchRad);
  geo.matrix4.multiplyByPointAsVector(
    this.scratchEnu,
    this.scratchLocal,
    this.scratchUp,
  );
  geo.cartesian3.normalize(this.scratchUp, this.scratchUp);

  geo.cartesian3.multiplyByScalar(
    this.scratchHorizontal,
    COCKPIT_FORWARD_OFFSET_M,
    this.scratchCamera,
  );
  geo.cartesian3.add(
    this.cockpitAnchor,
    this.scratchCamera,
    this.scratchCamera,
  );
  geo.matrix4.getTranslation(this.scratchEnu, this.scratchTarget);
  geo.cartesian3.normalize(this.scratchTarget, this.scratchTarget);
  geo.cartesian3.multiplyByScalar(
    this.scratchTarget,
    COCKPIT_UP_OFFSET_M,
    this.scratchTarget,
  );
  geo.cartesian3.add(
    this.scratchCamera,
    this.scratchTarget,
    this.scratchCamera,
  );

  // Recheck at the final forward-offset camera coordinate because a taxiing
  // aircraft can cross into an adjacent coarse floor cell between updates.
  const cameraCartographic = geo.cartographic.fromCartesian(
    this.scratchCamera,
    geo.ellipsoid.WGS84,
    this.scratchCameraCartographic,
  );
  if (cameraCartographic) {
    const cameraLat = geo.math.toDegrees(cameraCartographic.latitude);
    const cameraLon = geo.math.toDegrees(cameraCartographic.longitude);
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
      COCKPIT_MIN_GROUND_CLEARANCE_M,
    );
    if (safeHeightM !== cameraCartographic.height) {
      cameraCartographic.height = safeHeightM;
      geo.ellipsoid.WGS84.cartographicToCartesian(
        cameraCartographic,
        this.scratchCamera,
      );
    }
  }

  this.host.camera.setView({
    destination: this.scratchCamera,
    orientation: { direction: this.scratchForward, up: this.scratchUp },
  });
  if (cockpitUiUpdateDue(nowMs, this.lastHudUpdateMs, COCKPIT_HUD_UPDATE_MS)) {
    this.lastHudUpdateMs = nowMs;
    this.updateHud(info, nowMs);
  }
}
