import * as Cesium from 'cesium';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import { FOCUS_EVIDENCE_DEV } from './policy.js';

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
    if (
      !FOCUS_EVIDENCE_DEV ||
      !flightState._billboardCollection ||
      !flightState._viewer
    )
      return { ok: false, count: 0 };
    if (flightState._trackedIcao) parts.tracking._clearTracking();
    parts.rendering._releaseModels();
    for (const bb of flightState._billboards.values())
      flightState._billboardCollection.remove(bb);
    flightState._billboards.clear();
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
      flightState._cullPositions.delete(id);
      flightState._focusEvidenceIds.add(id);
      const bb = flightState._billboardCollection.add({
        position,
        image: aircraftIcon(parts.rendering._iconKind(id, klass)),
        width: 20,
        height: 20,
        scale: parts.rendering._fleetBillboardScale(id, klass),
        rotation: 0,
        alignedAxis: Cesium.Cartesian3.ZERO,
        color: parts.rendering._fleetBillboardColor(id),
        sizeInMeters: false,
        scaleByDistance: parts.rendering._normalBillboardScaleByDistance(),
        disableDepthTestDistance: parts.rendering._groundDepthDistance(),
        id,
        show: true,
      });
      flightState._billboards.set(id, bb);
    }
    flightState.feed._count = flightState._billboards.size;
    flightState._lastFleetTickMs = 0;
    flightState._viewer.scene.requestRender?.();
    return { ok: true, count: flightState.feed._count };
  }

  /** Update explicit evidence positions without rebuilding billboards. */

  function _moveFocusEvidenceAircraft(records = []) {
    if (!FOCUS_EVIDENCE_DEV) return { ok: false, moved: 0 };
    let moved = 0;
    for (const record of Array.isArray(records) ? records : []) {
      const id = String(record?.id || '')
        .trim()
        .toLowerCase();
      if (!flightState._focusEvidenceIds.has(id)) continue;
      const position = _focusEvidencePosition(record);
      const bb = flightState._billboards.get(id);
      if (!position || !bb) continue;
      bb.position = position;
      const meta = flightState.records.data.get(id);
      if (meta) {
        if (Number.isFinite(record.trackDeg)) meta.true_track = record.trackDeg;
        if (Number.isFinite(record.velocityMps))
          meta.velocity = record.velocityMps;
      }
      moved += 1;
    }
    flightState._lastFleetTickMs = 0;
    flightState._viewer?.scene?.requestRender?.();
    return { ok: true, moved };
  }

  /** JSON-safe visual snapshot for the evidence report. */

  function _focusEvidenceSnapshot() {
    if (!FOCUS_EVIDENCE_DEV || !flightState._viewer) return [];
    return [...flightState._focusEvidenceIds].map((id) => {
      const bb = flightState._billboards.get(id);
      const screen = bb?.position
        ? Cesium.SceneTransforms.worldToWindowCoordinates(
            flightState._viewer.scene,
            bb.position,
          )
        : null;
      return {
        id,
        show: bb?.show === true,
        scale: bb?.scale ?? null,
        alpha: bb?.color?.alpha ?? null,
        x: screen?.x ?? null,
        y: screen?.y ?? null,
        cameraDistanceM: bb?.position
          ? Cesium.Cartesian3.distance(
              flightState._viewer.camera.positionWC,
              bb.position,
            )
          : null,
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
