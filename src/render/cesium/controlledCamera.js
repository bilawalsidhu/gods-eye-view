/**
 * @module render/cesium/controlledCamera
 * @description The Cesium renderer's camera port on a camera controller the
 * application hands in (`CameraControllerFactory`, the shared one a renderer
 * without a camera of its own is built on), in place of the port over
 * Cesium's own camera (`camera.js`).
 *
 * The controller does the poses, flights, `lookAt`, follows, events and the
 * user's drags, zooms and keys; it is given a native camera over Cesium's:
 * - `pose()` reads Cesium's camera in world coordinates, `setPose(eye)`
 *   writes it exactly (out of any `lookAt` transform), its vertical field
 *   of view as Cesium's `fov`, which spans the wider side of the canvas;
 * - `viewport()` is the canvas's CSS size, `pickPosition` and
 *   `sampleHeightNow` the query port's, `requestRender` the frame port's,
 *   `itemPosition` where the draw port draws an item it moves itself.
 *
 * Cesium's own camera controls are kept off for as long as the port lives
 * (a hold on its `ScreenSpaceCameraController`'s input, which Cesium's own
 * flights ending cannot lift), and so is its collision: the controller hears
 * the input port's pointer events and the page's keys. The input port's
 * camera holds are the controller's (`controls.suspend`), through
 * `suspendCamera`, which the renderer hands its input port.
 *
 * The renderer runs `before(tick)` before its `preUpdate` listeners and
 * `after(tick)` after them, each scene tick, drawn or not; what they throw
 * is reported, never left to stop Cesium's render loop.
 */
import * as Cesium from 'cesium';
import { acquireCameraInput } from './cameraInput.js';
import { sameEye } from './common.js';

/**
 * The input port's events for a controller made before the port: listeners
 * taken now, delivered once `attach` hands the port over.
 */
function inputRelay() {
  const wanted = [];
  let port = null;
  return {
    on(type, cb) {
      const entry = { type, cb, off: null, gone: false };
      wanted.push(entry);
      if (port) entry.off = port.on(type, cb);
      return () => {
        entry.gone = true;
        entry.off?.();
        entry.off = null;
      };
    },
    attach(input) {
      port = input;
      for (const entry of wanted)
        if (!entry.gone && !entry.off)
          entry.off = input.on(entry.type, entry.cb);
    },
  };
}

const plain = (v) => ({ x: v.x, y: v.y, z: v.z });

/**
 * @param {{
 *   scene: object,
 *   controller: import('../contract/camera').CameraControllerFactory,
 *   query: {pickPosition?: Function, sampleHeightNow?: Function},
 *   itemPosition?: (item: {set: string, id: string|number}, aheadMs?: number) => object|null,
 *   requestRender: (reason: string) => void,
 *   report: (error: unknown) => void,
 *   thresholds: boolean,
 *   followFrame: boolean,
 *   keyTarget?: EventTarget,
 * }} options
 * @returns {{
 *   port: import('../contract/camera').CameraPort,
 *   before: (tick: {now: number, time: number}) => void,
 *   after: (tick: {now: number, time: number}) => void,
 *   attachInput: (input: {on: Function}) => void,
 *   suspendCamera: (reason: string) => () => void,
 *   dispose: () => void,
 * }}
 */
export function createControlledCamera({
  scene,
  controller: factory,
  query,
  itemPosition,
  requestRender,
  report,
  thresholds,
  followFrame,
  keyTarget = globalThis.document,
}) {
  const camera = scene.camera;
  const canvas = scene.canvas;
  /** The eye last written, while Cesium's camera still stands there. */
  let written = null;
  /** The vertical field of view last written, and the aspect it was for. */
  let fovy = null;
  let fovAspect = null;
  /** Cesium's `fov` for vertical `fovy`: it spans the wider side. */
  function applyFov(frustum) {
    const aspect = frustum.aspectRatio;
    const fov = aspect > 1 ? 2 * Math.atan(Math.tan(fovy / 2) * aspect) : fovy;
    if (frustum.fov !== fov) frustum.fov = fov;
    fovAspect = aspect;
  }
  const native = {
    pose() {
      const frustum = camera.frustum;
      const world = {
        position: plain(camera.positionWC),
        direction: plain(camera.directionWC),
        up: plain(camera.upWC),
      };
      // Within rounding of the eye written, it is that eye; anything that
      // moved Cesium's camera since is read as it stands.
      const eye = written && sameEye(world, written) ? written : world;
      if (eye !== written) written = null;
      return {
        position: { ...eye.position },
        direction: { ...eye.direction },
        up: { ...eye.up },
        near: frustum.near,
        far: frustum.far,
      };
    },
    setPose(eye) {
      if (!Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY))
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      camera.position = new Cesium.Cartesian3(
        eye.position.x,
        eye.position.y,
        eye.position.z,
      );
      camera.direction = new Cesium.Cartesian3(
        eye.direction.x,
        eye.direction.y,
        eye.direction.z,
      );
      camera.up = new Cesium.Cartesian3(eye.up.x, eye.up.y, eye.up.z);
      camera.right = new Cesium.Cartesian3(
        eye.right.x,
        eye.right.y,
        eye.right.z,
      );
      const frustum = camera.frustum;
      if (Number.isFinite(eye.fovy) && 'fov' in frustum) {
        fovy = eye.fovy;
        applyFov(frustum);
      }
      written = {
        position: plain(eye.position),
        direction: plain(eye.direction),
        up: plain(eye.up),
      };
    },
    viewport: () => ({
      width: canvas.clientWidth || canvas.width,
      height: canvas.clientHeight || canvas.height,
    }),
    requestRender,
    ...(query.pickPosition
      ? { pickPosition: (x, y) => query.pickPosition(x, y) }
      : {}),
    ...(query.sampleHeightNow
      ? {
          sampleHeightNow: (point, options) =>
            query.sampleHeightNow(point, options),
        }
      : {}),
    ...(itemPosition ? { itemPosition } : {}),
  };
  const relay = inputRelay();
  const made = factory({
    native,
    input: relay,
    report,
    thresholds,
    ...(keyTarget ? { keyTarget } : {}),
  });
  const port = made.port;
  if (!followFrame) delete port.followFrame;

  // Cesium's own controls stay off while the controller drives the camera.
  const ownInput = acquireCameraInput(scene);
  ownInput.suspend('camera controller');
  // Its collision too, which runs every frame with input off and would lift
  // the eye under the controller's own (the controller keeps it above the
  // ground through `sampleHeightNow`).
  const own = scene.screenSpaceCameraController;
  const ownCollision = own?.enableCollisionDetection;
  if (own && ownCollision !== undefined) own.enableCollisionDetection = false;

  let disposed = false;
  return {
    port,
    before(tick) {
      if (disposed) return;
      try {
        // A canvas resized since: the same vertical field of view on it.
        const frustum = camera.frustum;
        if (fovy !== null && frustum.aspectRatio !== fovAspect)
          applyFov(frustum);
        made.frame.beforeUpdate(tick);
      } catch (error) {
        report(error);
      }
    },
    after(tick) {
      if (disposed) return;
      try {
        made.frame.afterUpdate(tick);
      } catch (error) {
        report(error);
      }
    },
    attachInput: (input) => relay.attach(input),
    suspendCamera: (reason) => port.controls.suspend(reason),
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        made.destroy();
      } finally {
        ownInput.release();
        if (own && ownCollision !== undefined && !scene.isDestroyed?.())
          own.enableCollisionDetection = ownCollision;
      }
    },
  };
}
