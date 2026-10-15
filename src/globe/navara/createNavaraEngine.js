// The GlobeEngine on an initialised Navara ThreeView (index.js builds one).
// The engine keeps the camera pose and Navara draws it (cameraModel.js);
// projection and picks against the ellipsoid are src/geo math on that pose,
// and Navara's own fov is kept on Cesium's (60° across the wider side) so
// both agree with what is drawn. Navara internals reach this module only
// through `hooks` (internals.js), so it runs in Node tests on a fake view.
// destroy() removes everything the engine added; the view stays the caller's.

import * as geo from '../../geo/index.js';
import { createEngineEvent } from '../contract.js';
import { cesiumFovy } from './cameraMath.js';
import { createCameraModel } from './cameraModel.js';
import { createNavaraCredits } from './credits.js';
import { createNavaraInput } from './input.js';
import { createNavaraMaps } from './maps.js';
import { createNavaraSurface } from './surface.js';

const { cartesian3, math } = geo;

// Navara's drawn camera (view.camera.raw, a three PerspectiveCamera in
// Earth-fixed metres): matrixWorld columns are right, up, back, position.
function readCamera(raw) {
  raw.updateMatrixWorld();
  const e = raw.matrixWorld.elements;
  const unit = (x, y, z) =>
    cartesian3.normalize(cartesian3.create(x, y, z), cartesian3.create());
  return {
    position: cartesian3.create(e[12], e[13], e[14]),
    direction: unit(-e[8], -e[9], -e[10]),
    up: unit(e[4], e[5], e[6]),
  };
}

/**
 * @param {object} view An initialised Navara ThreeView.
 * @param {{
 *   hooks: { tileRoots: Function, isIdle: Function, retainTileGeometry: Function },
 *   container?: HTMLElement,
 *   fetch?: typeof fetch,
 *   clock?: object,
 * }} options `hooks` are internals.js; `container` defaults to the
 *   canvas's parent; `fetch` and `clock` are test seams.
 * @returns {import('../contract.js').GlobeEngine}
 */
export function createNavaraEngine(
  view,
  { hooks, container, fetch, clock } = {},
) {
  if (!view?.camera?.raw)
    throw new TypeError('createNavaraEngine needs a view');
  if (!hooks) throw new TypeError('createNavaraEngine needs Navara hooks');
  const { canvas } = view;
  const size = () => ({
    width: canvas.clientWidth,
    height: canvas.clientHeight,
  });
  const matchFov = () => {
    const { width, height } = size();
    if (width > 0 && height > 0)
      view.camera.fov = math.toDegrees(cesiumFovy(width, height));
  };
  matchFov();

  const model = createCameraModel({
    port: {
      apply: (pose) => view.setCamera(pose),
      read: () => readCamera(view.camera.raw),
      fly: (pose, options) => view.flyTo(pose, options),
      // Navara 0.2.1 has no cancel call: any camera change interrupts a
      // flight, and an empty setCamera changes nothing else (S4).
      stop: () => view.setCamera({}),
      size,
      requestFrame: () => view.forceUpdate(),
    },
    ...(clock ? { clock } : {}),
  });
  const frames = {
    preUpdate: createEngineEvent(),
    preRender: createEngineEvent(),
    postRender: createEngineEvent(),
  };
  const handlers = {
    preUpdate: (time) => frames.preUpdate.raiseEvent(time),
    preRender: (time) => {
      model.sync();
      frames.preRender.raiseEvent(time);
    },
    postRender: (time) => {
      model.afterFrame();
      frames.postRender.raiseEvent(time);
    },
    resize: () => matchFov(),
  };
  for (const [name, handler] of Object.entries(handlers))
    view.on(name, handler);

  const input = createNavaraInput(view, {
    onCameraInput: () => model.camera.cancelFlight(),
  });
  const credits = createNavaraCredits(view);
  const maps = createNavaraMaps(view, fetch ? { fetch } : {});
  const { surface } = createNavaraSurface(view, hooks);

  const picker = {
    // Navara picks its own meshes only on click gestures (featureClick); there
    // is no synchronous pick, and 3D tiles carry no ids. No layers yet.
    pick: () => undefined,
    drillPick: () => [],
    pickPosition(screen) {
      const rect = canvas.getBoundingClientRect();
      const hit = view.pickDepthPosition(
        rect.left + screen.x,
        rect.top + screen.y,
      );
      return hit ? cartesian3.create(hit.x, hit.y, hit.z) : undefined;
    },
    pickPositionSupported: true,
  };

  let destroyed = false;
  return {
    kind: 'navara',
    host: { container: container ?? canvas.parentElement, canvas, size },
    camera: model.camera,
    picker,
    projector: {
      worldToWindow: (position, result) =>
        model.worldToWindow(position, result),
      viewProjection: (result) => model.viewProjection(result),
      horizonVisible: (position) => model.horizonVisible(position),
    },
    frames,
    render: {
      request: () => view.forceUpdate(),
      setContinuous(enabled) {
        view.animation = Boolean(enabled);
      },
      isContinuous: () => view.animation === true,
    },
    surface,
    input: input.input,
    credits: credits.credits,
    maps: maps.maps,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const [name, handler] of Object.entries(handlers))
        view.off(name, handler);
      model.destroy();
      input.destroy();
      credits.destroy();
      maps.destroy();
    },
  };
}
