import * as Cesium from 'cesium';
import { MAX_FOLLOW_TURN, turnFollowOffset } from '../follow.js';

const MAX_FRAMES = 120;

/**
 * Put the camera at a shared follow offset from `entity` once following it
 * has framed the camera. Cesium keeps the offset afterwards, as it keeps one
 * the user orbits to. The camera swings round the entity at most 60° a frame:
 * the follow's own guard treats a jump to the far side as the camera crossing
 * through the entity and puts it back. Returns a disposer.
 */
export function swingFollowOffset(viewer, entity, local, position) {
  let frames = 0;
  let remove = null;
  const stop = () => {
    remove?.();
    remove = null;
  };
  remove = viewer.scene.preUpdate.addEventListener(() => {
    if (viewer.isDestroyed() || viewer.trackedEntity !== entity) {
      stop();
      return;
    }
    frames += 1;
    const camera = viewer.camera;
    // Let the follow frame the camera first (its first frame), then move it.
    const framed =
      frames > 1 &&
      !Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY);
    const target = framed ? position() : null;
    if (!target) {
      if (frames >= MAX_FRAMES) stop();
      return;
    }
    // The offset is east/north/up at the entity; the follow's own frame may
    // differ, so place the camera in world space and re-express it there.
    const world = Cesium.Matrix4.multiplyByPoint(
      Cesium.Transforms.eastNorthUpToFixedFrame(target),
      new Cesium.Cartesian3(local.x, local.y, local.z),
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
    const done = !(angle > MAX_FOLLOW_TURN);
    const next = done
      ? goal
      : Cesium.Cartesian3.clone(turnFollowOffset(from, goal));
    camera.lookAtTransform(camera.transform, next);
    viewer.scene.requestRender();
    if (done) stop();
  });
  viewer.scene.requestRender();
  return stop;
}
