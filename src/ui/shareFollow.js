import * as geo from '../geo/index.js';
import { enuOffset } from '../globe/follow.js';
import {
  SHARE_VIEW_ENTITY_KINDS,
  followOffsetFromEnu,
  followOffsetToEnu,
} from '../share/follow.js';

const KIND_BY_LAYER = new Map(
  SHARE_VIEW_ENTITY_KINDS.map((entry) => [entry.layerId, entry.kind]),
);

/** The followed subject, camera offset and displayed fix in share format. */
export function readShareFollowSubject({ engine, nowMs = Date.now() }) {
  const handle = engine?.camera.following();
  const trackedId = String(
    handle?.label?.id || handle?.native?.gevTrackedId || '',
  );
  const separator = trackedId.indexOf(':');
  if (separator <= 0) return null;
  const kind = KIND_BY_LAYER.get(trackedId.slice(0, separator));
  const id = trackedId.slice(separator + 1);
  const target = kind ? (handle.label?.position?.() ?? handle.target()) : null;
  if (!kind || !id || !target) return null;
  const local = enuOffset(target, engine.camera.pose().position);
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
