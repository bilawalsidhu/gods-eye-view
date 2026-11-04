import * as Cesium from 'cesium';
import { FOCUS_EVIDENCE_DEV } from './policy.js';
import { writeHoldSegment } from '../../data/iconSegment.js';
import {
  aircraftRecessionFactors,
  aircraftTreatmentAlpha,
} from '../../data/aircraftRecession.js';
import { horizonOccluder } from '../../data/iconOrientation.js';

export function createEvidence({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  /** Resolve a JSON-safe evidence position into ECEF. DEV-only caller. */

  function _focusEvidencePosition(record) {
    const cartesian = record?.cartesian;
    if (
      Array.isArray(cartesian) &&
      cartesian.length >= 3 &&
      cartesian.slice(0, 3).every(Number.isFinite)
    ) {
      return Cesium.Cartesian3.fromElements(
        cartesian[0],
        cartesian[1],
        cartesian[2],
      );
    }
    if (
      !Number.isFinite(record?.longitude) ||
      !Number.isFinite(record?.latitude)
    )
      return null;
    return Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      Number.isFinite(record.altitudeM) ? record.altitudeM : 3_000,
    );
  }

  /** Replace the real fleet with deterministic explicit-position contacts. */

  function _setFocusEvidenceAircraft(records = []) {
    if (!FOCUS_EVIDENCE_DEV || !flightState._icons || !flightState._viewer)
      return { ok: false, count: 0 };
    if (flightState._trackedIcao) parts.tracking._clearTracking();
    parts.rendering._releaseModels();
    const icons = flightState._icons;
    icons.clear();
    flightState._grounded.clear();
    flightState._floorPinned.clear();
    flightState.records.data.clear();
    flightState._positionHistory.clear();
    flightState._displayCourse.clear();
    flightState.records.missingPolls.clear();
    flightState._focusEvidenceIds.clear();

    for (const record of Array.isArray(records) ? records : []) {
      const id = String(record?.id || '')
        .trim()
        .toLowerCase();
      const position = _focusEvidencePosition(record);
      if (!id || !position) continue;
      const klass = record.klass || 'airliner';
      const altitudeM = Number.isFinite(record.altitudeM)
        ? record.altitudeM
        : Cesium.Cartographic.fromCartesian(position)?.height || 3_000;
      const meta = {
        callsign: String(record.callsign || id).toUpperCase(),
        altitude: altitudeM,
        renderAltitudeM: altitudeM,
        velocity: Number.isFinite(record.velocityMps) ? record.velocityMps : 0,
        true_track: Number.isFinite(record.trackDeg) ? record.trackDeg : 90,
        klass,
        onGround: false,
        wasAirborne: true,
        turnRateDps: 0,
        lastContactEpochMs: Date.now(),
        rawLat: record.latitude ?? null,
        rawLon: record.longitude ?? null,
      };
      flightState.records.data.set(id, meta);
      flightState._focusEvidenceIds.add(id);
      parts.icons._addIcon(id);
      const row = icons.row(id);
      writeHoldSegment(icons.segments, row, position, meta.true_track);
      icons.segmentWritten(row);
    }
    flightState.feed._count = icons.count;
    flightState._lastFleetTickMs = 0;
    flightState._viewer.scene.requestRender?.();
    return { ok: true, count: flightState.feed._count };
  }

  /** Update explicit evidence positions without rebuilding rows. */

  function _moveFocusEvidenceAircraft(records = []) {
    if (!FOCUS_EVIDENCE_DEV) return { ok: false, moved: 0 };
    let moved = 0;
    for (const record of Array.isArray(records) ? records : []) {
      const id = String(record?.id || '')
        .trim()
        .toLowerCase();
      if (!flightState._focusEvidenceIds.has(id)) continue;
      const position = _focusEvidencePosition(record);
      const row = flightState._icons?.row(id) ?? -1;
      if (!position || row < 0) continue;
      const meta = flightState.records.data.get(id);
      if (meta) {
        if (Number.isFinite(record.trackDeg)) meta.true_track = record.trackDeg;
        if (Number.isFinite(record.velocityMps))
          meta.velocity = record.velocityMps;
      }
      writeHoldSegment(
        flightState._icons.segments,
        row,
        position,
        meta?.true_track ?? 0,
      );
      flightState._icons.segmentWritten(row);
      moved += 1;
    }
    flightState._lastFleetTickMs = 0;
    flightState._viewer?.scene?.requestRender?.();
    return { ok: true, moved };
  }

  /** JSON-safe visual snapshot for the evidence report. */

  function _focusEvidenceSnapshot() {
    if (!FOCUS_EVIDENCE_DEV || !flightState._viewer) return [];
    const icons = flightState._icons;
    const { scene, camera } = flightState._viewer;
    const occluder = horizonOccluder(camera);
    const cameraHeightM = camera.positionCartographic?.height;
    return [...flightState._focusEvidenceIds].map((id) => {
      const row = icons?.row(id) ?? -1;
      const position = row < 0 ? null : parts.icons._iconPosition(id);
      const cameraDistanceM = position
        ? Cesium.Cartesian3.distance(camera.positionWC, position)
        : null;
      const screen = position
        ? Cesium.SceneTransforms.worldToWindowCoordinates(scene, position)
        : null;
      // What the icon shader composes: base scale × limb taper, and base
      // alpha × max(floor, focus × limb haze).
      const factors = position
        ? aircraftRecessionFactors({ cameraDistanceM, cameraHeightM })
        : null;
      return {
        id,
        show:
          !!position &&
          icons.shown(row) &&
          parts.icons._aboveHorizon(row, position, occluder),
        scale: factors ? icons.scale(row) * factors.scale : null,
        alpha: position
          ? aircraftTreatmentAlpha({
              baseAlpha: icons.alpha(row),
              focusFactor: icons.focus(row),
              cameraDistanceM,
              cameraHeightM,
            })
          : null,
        x: screen?.x ?? null,
        y: screen?.y ?? null,
        cameraDistanceM,
      };
    });
  }
  return {
    _focusEvidencePosition,
    _setFocusEvidenceAircraft,
    _moveFocusEvidenceAircraft,
    _focusEvidenceSnapshot,
  };
}
