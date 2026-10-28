import * as Cesium from 'cesium';
import { trackedDisplayPositionForCamera } from '../data/trackedCamera.js';
import {
  SHARE_VIEW_ENTITY_KINDS,
  followOffsetFromEnu,
  followOffsetToEnu,
} from '../share/follow.js';

/**
 * The bridge between the camera following an entity and a share link's thing
 * view: what the camera follows now, in the share format's terms, and the
 * stored follow offset applied to an entity the camera has started to follow.
 */

const KIND_BY_LAYER = new Map(
  SHARE_VIEW_ENTITY_KINDS.map((entry) => [entry.layerId, entry.kind]),
);
const MAX_FRAMES = 120;

/** `position`'s local east/north/up offset from `origin`, in metres. */
function enuOffset(origin, position) {
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const local = Cesium.Matrix4.multiplyByPoint(
    Cesium.Matrix4.inverseTransformation(frame, new Cesium.Matrix4()),
    position,
    new Cesium.Cartesian3(),
  );
  return { east: local.x, north: local.y, up: local.z };
}

/**
 * The entity the camera follows as `{ kind, id, offset, lastKnown }`, with
 * the camera's offset from it and its displayed position as of `nowMs`; null
 * when the camera follows nothing a share link can name. A selected vessel is
 * not followed (the camera stays where the user puts it), so a link made then
 * keeps its own camera.
 */
export function readShareFollowSubject({ viewer, nowMs = Date.now() }) {
  const cameraPosition = viewer?.camera?.positionWC;
  if (!cameraPosition) return null;
  const tracked = viewer.trackedEntity;
  const trackedId = String(tracked?.gevTrackedId || '');
  const separator = trackedId.indexOf(':');
  if (separator <= 0) return null;
  const kind = KIND_BY_LAYER.get(trackedId.slice(0, separator));
  const id = trackedId.slice(separator + 1);
  const target = kind
    ? trackedDisplayPositionForCamera(
        tracked,
        viewer.clock.currentTime,
        new Cesium.Cartesian3(),
      )
    : null;
  if (!kind || !id || !target) return null;
  const offset = followOffsetFromEnu(enuOffset(target, cameraPosition));
  const fix = Cesium.Cartographic.fromCartesian(target);
  if (!offset || !fix) return null;
  return {
    kind,
    id,
    offset,
    lastKnown: {
      lat: Cesium.Math.toDegrees(fix.latitude),
      lon: Cesium.Math.toDegrees(fix.longitude),
      alt: fix.height,
      observedAtMs: nowMs,
    },
  };
}

/** Largest turn, in radians, the camera makes around the entity per frame. */
const MAX_TURN_PER_FRAME = Math.PI / 3;

/**
 * Put the camera at a shared follow offset from `entity` once following it
 * has framed the camera. Cesium keeps the offset afterwards, as it keeps one
 * the user orbits to. The camera swings round the entity at most 60° a frame:
 * the follow's own guard treats a jump to the far side as the camera crossing
 * through the entity and puts it back. Returns a disposer.
 */
export function applyShareFollowOffset(viewer, entity, offset) {
  if (!viewer?.scene?.preUpdate || !entity || !(offset?.range > 0))
    return () => {};
  const local = followOffsetToEnu(offset);
  let frames = 0;
  let remove = null;
  const stop = () => {
    remove?.();
    remove = null;
  };
  remove = viewer.scene.preUpdate.addEventListener(() => {
    if (viewer.isDestroyed?.() || viewer.trackedEntity !== entity) {
      stop();
      return;
    }
    frames += 1;
    const camera = viewer.camera;
    // Let the follow frame the camera first (its first frame), then move it.
    const framed =
      frames > 1 &&
      !Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY);
    const target = framed
      ? trackedDisplayPositionForCamera(
          entity,
          viewer.clock.currentTime,
          new Cesium.Cartesian3(),
        )
      : null;
    if (!target) {
      if (frames >= MAX_FRAMES) stop();
      return;
    }
    // The offset is east/north/up at the entity; the follow's own frame may
    // differ, so place the camera in world space and re-express it there.
    const world = Cesium.Matrix4.multiplyByPoint(
      Cesium.Transforms.eastNorthUpToFixedFrame(target),
      new Cesium.Cartesian3(local.east, local.north, local.up),
      new Cesium.Cartesian3(),
    );
    const goal = Cesium.Matrix4.multiplyByPoint(
      Cesium.Matrix4.inverseTransformation(
        camera.transform,
        new Cesium.Matrix4(),
      ),
      world,
      new Cesium.Cartesian3(),
    );
    const from = Cesium.Cartesian3.clone(
      camera.position,
      new Cesium.Cartesian3(),
    );
    const angle =
      Cesium.Cartesian3.magnitude(from) > 0
        ? Cesium.Cartesian3.angleBetween(from, goal)
        : 0;
    const done = !(angle > MAX_TURN_PER_FRAME);
    const next = done ? goal : turnToward(from, goal, MAX_TURN_PER_FRAME);
    camera.lookAtTransform(camera.transform, next);
    viewer.scene.requestRender?.();
    if (done) stop();
  });
  return stop;
}

/**
 * `from` turned `step` radians toward `to`, with its length moved the same
 * fraction of the way: one frame of the swing round the entity.
 */
function turnToward(from, to, step) {
  const angle = Cesium.Cartesian3.angleBetween(from, to);
  const unitFrom = Cesium.Cartesian3.normalize(from, new Cesium.Cartesian3());
  // The direction perpendicular to `from` in the plane toward `to` (or any
  // perpendicular when they are opposite).
  let toward = Cesium.Cartesian3.subtract(
    Cesium.Cartesian3.normalize(to, new Cesium.Cartesian3()),
    Cesium.Cartesian3.multiplyByScalar(
      unitFrom,
      Math.cos(angle),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  if (Cesium.Cartesian3.magnitude(toward) < 1e-9)
    toward = Cesium.Cartesian3.cross(
      unitFrom,
      Math.abs(unitFrom.z) < 0.9
        ? Cesium.Cartesian3.UNIT_Z
        : Cesium.Cartesian3.UNIT_X,
      new Cesium.Cartesian3(),
    );
  Cesium.Cartesian3.normalize(toward, toward);
  const length =
    Cesium.Cartesian3.magnitude(from) +
    (Cesium.Cartesian3.magnitude(to) - Cesium.Cartesian3.magnitude(from)) *
      (step / angle);
  const direction = Cesium.Cartesian3.add(
    Cesium.Cartesian3.multiplyByScalar(
      unitFrom,
      Math.cos(step),
      new Cesium.Cartesian3(),
    ),
    Cesium.Cartesian3.multiplyByScalar(
      toward,
      Math.sin(step),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  return Cesium.Cartesian3.multiplyByScalar(direction, length, direction);
}
