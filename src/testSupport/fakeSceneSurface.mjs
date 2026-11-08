/**
 * Renderer ports over a scene double, for tests of code that reads the
 * surface through the query, globe, camera and frame ports: they answer
 * from the double's Cesium-shaped members, read when asked, so a test that
 * changes its scene is seen.
 *
 * - query: `sampleHeightNow` (terrain from `globe.getHeight`, else the
 *   scene's `sampleHeight` where `sampleHeightSupported`), `project`
 *   (`SceneTransforms.worldToWindowCoordinates`, which a test may mock),
 *   `pickPosition` (the scene's), and null for every other pick.
 * - globe: `isGlobeVisible` from `globe.show`.
 * - camera (`withCamera`): `pose().position` from `camera.positionCartographic`,
 *   `matrices()` from `camera.viewMatrix` and `frustum.projectionMatrix`
 *   (undefined without them).
 * - frame: `on('postRender')` on the scene's `postRender`, when it has one.
 * - capabilities: `sampleHeight` while the scene is `sampleHeightSupported`.
 */
import * as Cesium from 'cesium';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeDrawPort } from './fakeDrawPort.mjs';

const carto = ({ lon, lat }) => Cesium.Cartographic.fromDegrees(lon, lat);
const ecef = (p) => (p ? { x: p.x, y: p.y, z: p.z } : null);

/** The surface ports over `viewer.scene`. */
export function sceneSurfacePorts(viewer, { withCamera = false } = {}) {
  const scene = () => viewer.scene ?? {};
  const query = {
    sampleHeightNow(point, { against } = {}) {
      const s = scene();
      if (against === 'terrain')
        return s.globe?.getHeight?.(carto(point)) ?? null;
      return s.sampleHeightSupported
        ? (s.sampleHeight?.(carto(point)) ?? null)
        : null;
    },
    project(position) {
      const at = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene(),
        new Cesium.Cartesian3(position.x, position.y, position.z),
        new Cesium.Cartesian2(),
      );
      return at ? { x: at.x, y: at.y } : null;
    },
    pickPosition(x, y) {
      const s = scene();
      if (!s.pickPositionSupported) return null;
      return ecef(s.pickPosition?.(new Cesium.Cartesian2(x, y)));
    },
    pickEllipsoid: () => null,
    pickRay: () => null,
    pick: () => null,
    drillPick: () => [],
    isOccluded: () => false,
  };
  const ports = {
    query,
    globe: { isGlobeVisible: () => Boolean(scene().globe?.show) },
    frame: {
      on(phase, cb) {
        const event = phase === 'postRender' ? scene().postRender : null;
        return event?.addEventListener?.(cb) ?? (() => {});
      },
      requestRender() {},
    },
    get capabilities() {
      return new Set(scene().sampleHeightSupported ? ['sampleHeight'] : []);
    },
    get canvas() {
      return scene().canvas;
    },
  };
  if (withCamera)
    ports.camera = {
      pose() {
        const c = scene().camera?.positionCartographic;
        return {
          position: c
            ? ecef(
                Cesium.Cartesian3.fromRadians(
                  c.longitude,
                  c.latitude,
                  c.height,
                ),
              )
            : null,
        };
      },
      matrices() {
        const camera = scene().camera;
        if (!camera?.viewMatrix || !camera.frustum?.projectionMatrix)
          return undefined;
        return {
          view: Float64Array.from(Cesium.Matrix4.toArray(camera.viewMatrix)),
          projection: Float64Array.from(
            Cesium.Matrix4.toArray(camera.frustum.projectionMatrix),
          ),
        };
      },
    };
  return ports;
}

/**
 * A viewer over `scene` bound to the surface ports, its camera and a fake
 * draw port.
 * @returns {{scene: object}}
 */
export function surfaceViewer(scene) {
  const viewer = { scene };
  bindRenderer(viewer, {
    ...sceneSurfacePorts(viewer, { withCamera: true }),
    draw: fakeDrawPort(),
  });
  return viewer;
}
