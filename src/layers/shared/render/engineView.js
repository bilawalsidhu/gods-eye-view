// An engine-contract view shared by layer renderers and the celestial HUD:
// `camera` camera-shaped and `scene`
// scene-shaped adapters over engine.camera.pose() (refreshed once per frame,
// and whenever the camera moved), the scene carrying the engine's projector
// so the shared helpers (iconOrientation, focus) project through it; the
// frame number, frustum and horizon tests, the window projection and the
// frame/camera events. No three, no Cesium.

import * as geo from '../../../geo/index.js';

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ layerId: string, wrap?: (run: () => any) => any,
 *   isDestroyed?: () => boolean }} options `wrap` runs each event listener
 *   (the renderer's frame commit scope).
 * @returns {{ view: object, freshCamera: () => object, destroy: () => void }}
 */
export function createEngineLayerView(
  engine,
  { layerId, wrap = (run) => run(), isDestroyed = () => false },
) {
  const removers = [];
  let frameNumber = 0;
  removers.push(
    engine.frames.preUpdate.addEventListener(() => {
      frameNumber++;
    }),
  );
  const camera = {
    positionWC: geo.cartesian3.create(),
    positionCartographic: geo.cartographic.create(),
    directionWC: geo.cartesian3.create(),
    upWC: geo.cartesian3.create(),
    rightWC: geo.cartesian3.create(),
    heading: 0,
    pitch: 0,
    roll: 0,
    frustum: { fovy: 1, aspectRatio: 1 },
    // The ellipsoid under a window point (the vessels' view-area request).
    pickEllipsoid: (screen) => engine.camera.pickEllipsoid(screen),
  };
  let poseFrame = -1;
  const lastPosition = geo.cartesian3.create(Number.NaN, 0, 0);
  // The camera as of now: refreshed once per frame, and whenever it moved.
  const freshCamera = () => {
    const live = engine.camera.livePosition;
    if (
      poseFrame === frameNumber &&
      live.x === lastPosition.x &&
      live.y === lastPosition.y &&
      live.z === lastPosition.z
    )
      return camera;
    const pose = engine.camera.pose();
    geo.cartesian3.clone(pose.position, camera.positionWC);
    geo.cartographic.clone(pose.cartographic, camera.positionCartographic);
    geo.cartesian3.clone(pose.direction, camera.directionWC);
    geo.cartesian3.clone(pose.up, camera.upWC);
    geo.cartesian3.clone(pose.right, camera.rightWC);
    camera.heading = pose.heading;
    camera.pitch = pose.pitch;
    camera.roll = pose.roll;
    camera.frustum.fovy = pose.fovy;
    camera.frustum.aspectRatio = pose.aspectRatio ?? 1;
    geo.cartesian3.clone(live, lastPosition);
    poseFrame = frameNumber;
    return camera;
  };
  const cameraView = new Proxy(camera, {
    get: (target, key) => freshCamera()[key],
  });
  const scene = {
    get camera() {
      return cameraView;
    },
    canvas: {
      get clientWidth() {
        return engine.host.size().width;
      },
      get clientHeight() {
        return engine.host.size().height;
      },
    },
    frameState: {
      get frameNumber() {
        return frameNumber;
      },
    },
    // What the shared helpers project through.
    projector: engine.projector,
  };
  const horizon = {
    isPointVisible: (position) => engine.projector.horizonVisible(position),
  };
  const scratchDelta = geo.cartesian3.create();
  let frustum = null;
  const inFrustum = (position) => {
    const { origin, direction, right, up, tanX, tanY } = frustum;
    geo.cartesian3.subtract(position, origin, scratchDelta);
    const z = geo.cartesian3.dot(scratchDelta, direction);
    if (z <= -1) return false;
    const x = Math.abs(geo.cartesian3.dot(scratchDelta, right));
    const y = Math.abs(geo.cartesian3.dot(scratchDelta, up));
    return x <= z * tanX + 1 && y <= z * tanY + 1;
  };
  const view = {
    get camera() {
      return cameraView;
    },
    scene,
    engine,
    frameNumber: () => frameNumber,
    canvasSize: () => engine.host.size(),
    viewportHeightPx: () => engine.host.size().height,
    frustumTester() {
      const cam = freshCamera();
      const tanY = Math.tan(cam.frustum.fovy / 2);
      const { width, height } = engine.host.size();
      frustum = {
        origin: cam.positionWC,
        direction: cam.directionWC,
        right: cam.rightWC,
        up: cam.upWC,
        tanY,
        tanX: tanY * (height > 0 ? width / height : 1),
      };
      return inFrustum;
    },
    horizon: () => horizon,
    worldToWindow: (position, result) =>
      engine.projector.worldToWindow(position, result),
    requestRender: () => engine.render.request(layerId),
    on(event, listener) {
      const source =
        event === 'moveEnd'
          ? engine.camera.moveEnd
          : event === 'preRender'
            ? engine.frames.preRender
            : event === 'preUpdate'
              ? engine.frames.preUpdate
              : null;
      if (!source) return null;
      return source.addEventListener((...args) =>
        wrap(() => listener(...args)),
      );
    },
    isDestroyed: () => isDestroyed() || engine.isDestroyed?.() === true,
  };

  return {
    view,
    freshCamera,
    destroy() {
      for (const remove of removers.splice(0)) remove?.();
    },
  };
}
