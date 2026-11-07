/**
 * Renderer ports over a Cesium-shaped viewer double, for tests of layers
 * that reach the camera, projection, frame loop and drawing through the
 * renderer: everything reads the double live, as the Cesium ports read
 * their scene.
 *
 * - camera: `pose()` from the double's camera (`viewer.camera`, else
 *   `viewer.scene.camera`): `positionWC`, `directionWC` and
 *   `positionCartographic`; `viewRectangle()` from its
 *   `computeViewRectangle()`, in degrees; events from its own `moveEnd`,
 *   `moveStart` and `changed`.
 * - query: `project` through `Cesium.SceneTransforms.worldToWindowCoordinates`
 *   (which a test may stub), `isOccluded` against the ellipsoid's horizon
 *   from the camera's `positionWC` (never occluded without one).
 * - frame: phases from the scene's own `preUpdate`, `preRender` and
 *   `postRender` events.
 * - draw: a fake draw port (`fakeDrawPort.mjs`) unless one is given.
 */
import * as Cesium from 'cesium';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeDrawPort } from './fakeDrawPort.mjs';

const toCartesian = (p) => new Cesium.Cartesian3(p.x, p.y, p.z);
const plain = (c) => ({ x: c.x, y: c.y, z: c.z });

/** Subscribe to a Cesium-style event, if the double has it. */
function listen(source, cb) {
  const off = source?.addEventListener?.(cb);
  if (typeof off === 'function') return off;
  return () => source?.removeEventListener?.(cb);
}

/**
 * Bind the ports to `viewer`.
 * @param {object} viewer
 * @param {{draw?: object}} [options]
 * @returns {{draw: object, camera: object, query: object, frame: object, unbind: () => void}}
 */
export function bindFakeCesiumScene(viewer, { draw = fakeDrawPort() } = {}) {
  const cam = () =>
    viewer.camera?.positionWC || !viewer.scene?.camera
      ? viewer.camera
      : viewer.scene.camera;
  const camera = {
    pose() {
      const c = cam();
      const carto = c?.positionCartographic;
      const deg = (r) =>
        Number.isFinite(r) ? Cesium.Math.toDegrees(r) : Number.NaN;
      return {
        lon: deg(carto?.longitude),
        lat: deg(carto?.latitude),
        height: carto?.height ?? Number.NaN,
        heading: c?.heading ?? 0,
        pitch: c?.pitch ?? -Math.PI / 2,
        roll: c?.roll ?? 0,
        position: c?.positionWC ? plain(c.positionWC) : { x: 0, y: 0, z: 0 },
        direction: c?.directionWC
          ? plain(c.directionWC)
          : { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
        right: { x: 1, y: 0, z: 0 },
        fovy: Math.PI / 3,
        aspectRatio: 1,
        near: 1,
        far: 5e8,
        frameIsIdentity: true,
      };
    },
    viewRectangle() {
      const rect = cam()?.computeViewRectangle?.();
      if (!rect) return null;
      const deg = Cesium.Math.toDegrees;
      return {
        west: deg(rect.west),
        south: deg(rect.south),
        east: deg(rect.east),
        north: deg(rect.north),
      };
    },
    on: (event, cb) => listen(cam()?.[event], cb),
  };
  const query = {
    project(position) {
      // The position itself, so a stub can tell positions apart by identity.
      const s = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        position,
      );
      return s ? { x: s.x, y: s.y } : null;
    },
    isOccluded(position) {
      const eye = cam()?.positionWC;
      if (!eye) return false;
      return !new Cesium.EllipsoidalOccluder(
        Cesium.Ellipsoid.WGS84,
        eye,
      ).isPointVisible(toCartesian(position));
    },
  };
  const frame = {
    on: (phase, cb) => listen(viewer.scene?.[phase], cb),
    requestRender: () => viewer.scene?.requestRender?.(),
  };
  const unbind = bindRenderer(viewer, { draw, camera, query, frame });
  return { draw, camera, query, frame, unbind };
}
