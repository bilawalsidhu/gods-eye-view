/** Camera placement, ground acquisition and motion correction for the Cockpit controller. */
import { cameraOf, findFrame } from '../render/rendererOf.js';
import { followedPosition } from '../data/followed.js';
import { readEntityRecord } from '../data/entityRecords.js';
import { trackedEntityDrawn } from './cockpitTrackingController.js';
import {
  add,
  clone,
  eastNorthUp,
  frameVector,
  fromRadians,
  magnitude,
  normalize,
  scale,
  sub,
  toCartographicRadians,
  toDegrees,
  toRadians,
  vec,
} from '../geo/index.js';
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

/**
 * Where the aircraft Cockpit flies is now: its follow target's position at
 * scene time (what the drawn entity's position reads), or, for a target
 * with none, where it is shown.
 */
export function trackedPositionNow(viewer, followed) {
  if (typeof followed?.position === 'function')
    return followed.position(findFrame(viewer)?.time() ?? Date.now());
  return followedPosition(viewer, followed);
}

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
  const info = this.readAircraftInfo();

  // Adopt a newly selected track before the camera cadence gate. A context
  // NEXT/PREV selection can otherwise spend one frame driving the old
  // aircraft with the new aircraft's metadata.
  this._adoptTrackedEntity(nowMs, info);
  if (
    !info ||
    !this.trackedEntity ||
    !trackedEntityDrawn.call(this, this.trackedEntity)
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

  const target = trackedPositionNow(this.viewer, this.trackedFollow);
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
 * Place the camera for one update: advance the inertial anchor, clamp it and
 * the eye against the rendered surface, and look along the slewed heading.
 * @param {{x: number, y: number, z: number}} target Authoritative subject position.
 * @param {object} info Subject info.
 * @param {number} nowMs Frame time.
 * @param {number} dtSec Seconds since the previous camera update.
 * @param {{forwardM: number, upM: number, pitchDeg: number,
 *   minClearanceM: number}} profile Eye offsets for the subject kind.
 */
function placeCamera(target, info, nowMs, dtSec, profile) {
  if (!this.cockpitAnchorValid) {
    this.cockpitAnchor = clone(target);
    this.cockpitAnchorValid = true;
  }

  // First-person motion cannot use the delayed feed correction as a raw
  // camera destination: a harmless icon re-anchor becomes a whole-world
  // surge/reversal in cockpit view. Advance the camera anchor inertially
  // from the reported course/speed and converge on the authoritative layer
  // display position at a bounded rate. This preserves the layer's required
  // 15/30-second interpolation and per-frame cache without exposing its
  // sample-boundary corrections to the camera.
  const headingRad = toRadians(this.heading ?? 0);
  const pitchRad = toRadians(profile.pitchDeg);
  const speedMps = Number.isFinite(info.velocityMps)
    ? Math.max(0, info.velocityMps)
    : 0;

  if (info.stale) {
    // A feed backoff has no authoritative velocity epoch to advance from.
    // Hold the cockpit on the exact layer-rendered position so the camera
    // cannot coast away while the icon correctly remains fixed.
    this.cockpitAnchor = clone(target);
  } else {
    const horizontal = normalize(
      frameVector(
        eastNorthUp(this.cockpitAnchor),
        vec(Math.sin(headingRad), Math.cos(headingRad), 0),
      ),
    );
    this.cockpitAnchor = add(
      this.cockpitAnchor,
      scale(horizontal, speedMps * dtSec),
    );
    const correction = sub(target, this.cockpitAnchor);
    const correctionDistanceM = magnitude(correction);
    const correctionStepM = cockpitAnchorCorrectionStep(
      correctionDistanceM,
      speedMps,
      dtSec,
    );
    if (correctionStepM > 0 && correctionDistanceM > 0) {
      this.cockpitAnchor = add(
        this.cockpitAnchor,
        scale(correction, correctionStepM / correctionDistanceM),
      );
    }
  }

  // The inertial anchor is independent of the layer's render-floor clamp and
  // can otherwise coast into a photoreal mesh while a landing contact is
  // between fixes. Clamp it against the same mesh-first shared floor used by
  // aircraft rendering. For a slow contact whose floor cell is still cold,
  // its already-clamped render position is a conservative temporary floor.
  const anchorCartographic = toCartographicRadians(this.cockpitAnchor);
  const targetCartographic = toCartographicRadians(target);
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
        const eye = cameraOf(this.viewer).pose();
        this.services.sampleMeshFloorCells(this.viewer, groundPoint, {
          sets: readEntityRecord(this.trackedEntity)?.groundSets?.() ?? [],
          viewerLat: eye.lat,
          viewerLon: eye.lon,
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
      this.cockpitAnchor = fromRadians(
        anchorCartographic.lon,
        anchorCartographic.lat,
        minimumAnchorHeightM,
      );
    }
  }

  // Rebuild the local frame at the stabilized anchor after advancing it.
  const enu = eastNorthUp(this.cockpitAnchor);
  const horizontal = normalize(
    frameVector(enu, vec(Math.sin(headingRad), Math.cos(headingRad), 0)),
  );
  const forward = normalize(
    frameVector(
      enu,
      vec(
        Math.sin(headingRad) * Math.cos(pitchRad),
        Math.cos(headingRad) * Math.cos(pitchRad),
        Math.sin(pitchRad),
      ),
    ),
  );
  const up = normalize(
    frameVector(
      enu,
      vec(
        -Math.sin(headingRad) * Math.sin(pitchRad),
        -Math.cos(headingRad) * Math.sin(pitchRad),
        Math.cos(pitchRad),
      ),
    ),
  );
  let eye = add(
    add(this.cockpitAnchor, scale(horizontal, profile.forwardM)),
    scale(normalize(enu.origin), profile.upM),
  );

  // Recheck at the final forward-offset camera coordinate because a taxiing
  // aircraft can cross into an adjacent coarse floor cell between updates.
  const cameraCartographic = toCartographicRadians(eye);
  if (cameraCartographic) {
    const cameraLat = toDegrees(cameraCartographic.lat);
    const cameraLon = toDegrees(cameraCartographic.lon);
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
      eye = fromRadians(
        cameraCartographic.lon,
        cameraCartographic.lat,
        safeHeightM,
      );
    }
  }

  cameraOf(this.viewer).setView({
    destination: eye,
    orientation: { direction: forward, up },
  });
  if (cockpitUiUpdateDue(nowMs, this.lastHudUpdateMs, COCKPIT_HUD_UPDATE_MS)) {
    this.lastHudUpdateMs = nowMs;
    this.updateHud(info, nowMs);
  }
}
