import * as geo from '../geo/index.js';
import { enuOffset } from '../globe/follow.js';
import {
  SHARE_VIEW_ENTITY_KINDS,
  SHARE_VIEW_FOLLOW_RANGE_MAX_M,
  followOffsetFor,
  followOffsetFromEnu,
  followOffsetToEnu,
} from '../share/follow.js';

const KIND_BY_LAYER = new Map(
  SHARE_VIEW_ENTITY_KINDS.map((entry) => [entry.layerId, entry.kind]),
);

/** Degrees to the share format's 10⁻⁴-degree coordinate precision. */
const toCoordinate = (radians) =>
  Math.round(geo.math.toDegrees(radians) * 1e4) / 1e4;

/**
 * The selected vessel as a thing view's subject: its drawn position as the
 * last-known fix, and the follow offset that puts the derived camera
 * (followCameraFor) where the camera is now. The offset is computed from the
 * fix at the format's precision, so the opened link's camera matches this
 * one to within the offset's whole metres and degrees. Null when the offset
 * cannot carry the camera (it is not above the vessel's horizon, or its range
 * is outside 1 m to SHARE_VIEW_FOLLOW_RANGE_MAX_M): the link is then a place
 * view.
 */
function selectedVesselSubject(cameraPosition, vessel, nowMs) {
  const id = String(vessel?.id || '');
  if (!id || !vessel.position) return null;
  const fixAt = geo.cartographic.fromCartesian(vessel.position);
  const cameraAt = geo.cartographic.fromCartesian(cameraPosition);
  if (!fixAt || !cameraAt) return null;
  const lastKnown = {
    lat: toCoordinate(fixAt.latitude),
    lon: toCoordinate(fixAt.longitude),
    alt: Math.round(fixAt.height),
    observedAtMs: Number.isFinite(vessel.observedAtMs)
      ? vessel.observedAtMs
      : nowMs,
  };
  const offset = followOffsetFor(lastKnown, {
    lat: geo.math.toDegrees(cameraAt.latitude),
    lon: geo.math.toDegrees(cameraAt.longitude),
    alt: cameraAt.height,
  });
  if (
    !offset ||
    !(offset.range >= 1 && offset.range <= SHARE_VIEW_FOLLOW_RANGE_MAX_M)
  )
    return null;
  return { kind: 'vessel', id, offset, lastKnown };
}

/**
 * The entity a share link made now names, as `{ kind, id, offset, lastKnown }`:
 * the entity the camera follows, with the camera's offset from it and its
 * displayed position as of `nowMs`; else, while the camera follows nothing,
 * the selected vessel (`readSelectedVessel()`, the vessel layer's
 * `getSelectedFix()`). A selected vessel is not followed (the camera stays
 * where the user puts it), so its offset is the one that derives the camera
 * where it is now. Null when there is nothing a share link can name.
 */
export function readShareFollowSubject({
  engine,
  nowMs = Date.now(),
  readSelectedVessel = null,
}) {
  const cameraPosition = engine?.camera.pose().position;
  if (!cameraPosition) return null;
  const handle = engine.camera.following();
  if (!handle) {
    const vessel = readSelectedVessel?.() ?? null;
    return vessel ? selectedVesselSubject(cameraPosition, vessel, nowMs) : null;
  }
  const trackedId = String(
    handle.label?.id || handle.native?.gevTrackedId || '',
  );
  const separator = trackedId.indexOf(':');
  if (separator <= 0) return null;
  const kind = KIND_BY_LAYER.get(trackedId.slice(0, separator));
  const id = trackedId.slice(separator + 1);
  const target = kind ? (handle.label?.position?.() ?? handle.target()) : null;
  if (!kind || !id || !target) return null;
  const local = enuOffset(target, cameraPosition);
  const offset = followOffsetFromEnu({
    east: local.x,
    north: local.y,
    up: local.z,
  });
  const fix = geo.cartographic.fromCartesian(target);
  if (!offset || !fix) return null;
  return {
    kind,
    id,
    offset,
    lastKnown: {
      lat: geo.math.toDegrees(fix.latitude),
      lon: geo.math.toDegrees(fix.longitude),
      alt: fix.height,
      observedAtMs: nowMs,
    },
  };
}

/** Swing the current follow to a shared ENU offset; return its cancellation. */
export function applyShareFollowOffset(engine, handle, offset) {
  if (!handle || engine?.camera.following() !== handle || !(offset?.range > 0))
    return () => {};
  const local = followOffsetToEnu(offset);
  handle.retarget({ swingTo: { x: local.east, y: local.north, z: local.up } });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (engine.camera.following() === handle)
      handle.retarget({ swingTo: null });
  };
}
