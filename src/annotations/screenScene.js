// What the screen-space annotation board (screenAnnotationRenderer.js) needs
// from the globe under it: the camera, the window projection, the horizon
// test, surface heights, one callback per drawn frame and the followed
// subject. A Cesium viewer provides it through screenSceneFromViewer (in the
// renderer); a globe engine through screenSceneFromEngine here. No Cesium.

import * as geo from '../geo/index.js';

const SCREEN_SCENE = Symbol('gev.annotations.screenScene');

/** Whether `value` is a screen scene (rather than a Cesium viewer). */
export const isScreenScene = (value) =>
  value != null && value[SCREEN_SCENE] === true;

/** Mark an object as a screen scene. */
export function screenScene(members) {
  Object.defineProperty(members, SCREEN_SCENE, { value: true });
  return members;
}

/**
 * A globe engine as the board's screen scene: its projector, its camera read
 * once per board frame, its rendered surface and its follow.
 * @param {import('../globe/contract.js').GlobeEngine} engine
 */
export function screenSceneFromEngine(engine) {
  const position = geo.cartesian3.create();
  const direction = geo.cartesian3.create();
  let height = undefined;
  const refresh = () => {
    const pose = engine.camera.pose();
    geo.cartesian3.clone(pose.position, position);
    geo.cartesian3.clone(pose.direction, direction);
    height = pose.cartographic?.height;
  };
  refresh();
  return screenScene({
    onFrame: (listener) => engine.frames.postRender.addEventListener(listener),
    beginFrame: refresh,
    cameraPosition: () => position,
    cameraDirection: () => direction,
    cameraHeight: () => height,
    horizonVisible: (world) => engine.projector.horizonVisible(world),
    worldToWindow: (world, result) =>
      engine.projector.worldToWindow(world, result),
    size: () => engine.host.size(),
    clampToHeightSupported: () =>
      engine.surface.clampToHeightSupported === true,
    clampToHeight: (world) => engine.surface.clampToHeight(world),
    // The followed subject: its card is the overlay host's painted
    // rectangle, its sprite a mover of the default billboard size.
    trackedSubject() {
      const world = engine.camera.following()?.target?.();
      return world ? { world, billboard: { width: 28, height: 28 } } : null;
    },
  });
}
