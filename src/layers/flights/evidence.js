import { findCamera, findFrame, findQuery } from '../../render/rendererOf.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { distance, vec } from '../../geo/vector.js';
import { FOCUS_EVIDENCE_DEV } from './policy.js';
import {
  aircraftRecessionFactors,
  aircraftTreatmentAlpha,
} from '../../data/aircraftRecession.js';

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
      return vec(cartesian[0], cartesian[1], cartesian[2]);
    }
    if (
      !Number.isFinite(record?.longitude) ||
      !Number.isFinite(record?.latitude)
    )
      return null;
    return fromDegrees(
      record.longitude,
      record.latitude,
      Number.isFinite(record.altitudeM) ? record.altitudeM : 3_000,
    );
  }

  /** An icon item's motion held at `position` on `courseDeg`. */
  function _heldAt(position, courseDeg) {
    return {
      pos: { x: position.x, y: position.y, z: position.z },
      course: courseDeg,
      motion: { kind: 'hold', courseDeg },
      courseGlide: undefined,
    };
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
        : toLonLatH(position)?.height || 3_000;
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
      icons.update(id, _heldAt(position, meta.true_track), {
        expiresAt: Infinity,
      });
    }
    flightState.feed._count = icons.count;
    flightState._lastFleetTickMs = 0;
    findFrame(flightState._viewer)?.requestRender('flights: focus evidence');
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
      if (!position || !flightState._icons?.has(id)) continue;
      const meta = flightState.records.data.get(id);
      if (meta) {
        if (Number.isFinite(record.trackDeg)) meta.true_track = record.trackDeg;
        if (Number.isFinite(record.velocityMps))
          meta.velocity = record.velocityMps;
      }
      flightState._icons.update(id, _heldAt(position, meta?.true_track ?? 0), {
        expiresAt: Infinity,
      });
      moved += 1;
    }
    flightState._lastFleetTickMs = 0;
    if (flightState._viewer)
      findFrame(flightState._viewer)?.requestRender('flights: focus evidence');
    return { ok: true, moved };
  }

  /** JSON-safe visual snapshot for the evidence report. */

  function _focusEvidenceSnapshot() {
    if (!FOCUS_EVIDENCE_DEV || !flightState._viewer) return [];
    const icons = flightState._icons;
    const pose = findCamera(flightState._viewer)?.pose();
    const query = findQuery(flightState._viewer);
    if (!pose || !query) return [];
    const occluder = parts.icons._occluder();
    const cameraHeightM = pose.height;
    return [...flightState._focusEvidenceIds].map((id) => {
      const position = icons?.has(id)
        ? parts.icons._iconPosition(id, vec())
        : null;
      const cameraDistanceM = position
        ? distance(pose.position, position)
        : null;
      const screen = position ? query.project(position) : null;
      // What the icon shader composes: base scale × limb taper, and base
      // alpha × max(floor, focus × limb haze).
      const factors = position
        ? aircraftRecessionFactors({ cameraDistanceM, cameraHeightM })
        : null;
      return {
        id,
        show:
          !!position &&
          icons.shown(id) &&
          parts.icons._aboveHorizon(position, occluder),
        scale: factors ? icons.scale(id) * factors.scale : null,
        alpha: position
          ? aircraftTreatmentAlpha({
              baseAlpha: icons.alpha(id),
              focusFactor: icons.focus(id),
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
