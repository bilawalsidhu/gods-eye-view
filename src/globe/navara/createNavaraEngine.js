// The GlobeEngine on an initialised Navara ThreeView (index.js builds one).
// The engine keeps the camera pose and Navara draws it (cameraModel.js);
// projection and picks against the ellipsoid are src/geo math on that pose,
// and Navara's own fov is kept on Cesium's (60° across the wider side) so
// both agree with what is drawn. Navara internals reach this module only
// through `hooks` (internals.js), so it runs in Node tests on a fake view.
// destroy() removes everything the engine added; the view stays the caller's.

import * as geo from '../../geo/index.js';
import {
  BLOOM_INITIAL,
  SHARPEN_INITIAL,
  STYLE_INITIAL,
  createEngineEvent,
  mergeBloom,
  mergeSharpen,
  mergeStyle,
} from '../contract.js';
import { cesiumFovy } from './cameraMath.js';
import { createCameraModel } from './cameraModel.js';
import { createNavaraClock } from './clock.js';
import { createNavaraCredits } from './credits.js';
import { createNavaraInput } from './input.js';
import { createNavaraPicking } from './picking.js';
import { createFollowController } from '../follow.js';
import { navaraFollowGestures } from './followGestures.js';
import { createNavaraMaps } from './maps.js';
import { createNavaraSurface } from './surface.js';
import { createGroundFloor, GROUND_FLOOR } from './groundFloor.js';

const { cartesian3, math } = geo;

// engine.movers without the view's three runtime (Node tests of the engine).
const NO_MOVERS = Object.freeze({
  createSet() {
    throw new Error("Navara movers need the view's three runtime (movers/)");
  },
  list: () => [],
});
const NO_LINES = Object.freeze({
  createLine() {
    throw new Error("Navara lines need the view's three runtime (lines/)");
  },
  list: () => [],
});

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

// Nearest hit of a ray with the WGS84 ellipsoid raised by `height` metres
// (each radius grown by it), or undefined.
function rayRaisedEllipsoid({ origin, direction }, height) {
  const radii = geo.ellipsoid.WGS84.radii;
  const rx = radii.x + height;
  const ry = radii.y + height;
  const rz = radii.z + height;
  const o = [origin.x / rx, origin.y / ry, origin.z / rz];
  const d = [direction.x / rx, direction.y / ry, direction.z / rz];
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const b = 2 * (o[0] * d[0] + o[1] * d[1] + o[2] * d[2]);
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;
  const root = Math.sqrt(discriminant);
  const near = (-b - root) / (2 * a);
  const t = near > 0 ? near : (-b + root) / (2 * a);
  if (!(t > 0)) return undefined;
  return cartesian3.add(
    origin,
    cartesian3.multiplyByScalar(direction, t, cartesian3.create()),
    cartesian3.create(),
  );
}

/**
 * @param {object} view An initialised Navara ThreeView.
 * @param {{
 *   hooks: { tileRoots: Function, isIdle: Function, retainTileGeometry: Function },
 *   container?: HTMLElement,
 *   fetch?: typeof fetch,
 *   clock?: object,
 *   appClock?: import('../../time/clock.js').AppClock,
 *   sharpen?: { set: (state: { enabled: boolean, amount: number }) => void, destroy: () => void },
 *   bloom?: { set: (state: { enabled: boolean, strength: number }) => void, destroy: () => void },
 *   styles?: { names: readonly string[], uniformNames: (name: string) => string[], defaults: (name: string) => Record<string, number>, set: (name: string, state: { intensity: number, uniforms: Record<string, number> }) => void, destroy: () => void },
 * }} options `hooks` are internals.js; `container` defaults to the
 *   canvas's parent; `sharpen` draws render.setSharpen (sharpen.js; without
 *   it the engine only keeps the state) and the engine destroys it;
 *   `styles` draws render.setStyle (stylePasses.js; without it the engine
 *   has no visualStyles capability) and the engine destroys it; `bloom`
 *   draws render.setBloom (bloom.js; without it no bloom capability), also
 *   destroyed with the engine;
 *   `appClock` (the engine clock's time) defaults to the page's app clock;
 *   `movers` is engine.movers on the view's three runtime (movers/index.js;
 *   without it createSet throws), `lines` engine.lines (lines/index.js;
 *   likewise), both destroyed with the engine;
 *   `fetch` and `clock` (the camera model's timers) are test seams.
 * @returns {import('../contract.js').GlobeEngine}
 */
export function createNavaraEngine(
  view,
  {
    hooks,
    container,
    fetch,
    clock,
    appClock,
    movers: moversPort = null,
    lines: linesPort = null,
    sharpen: sharpenPort = null,
    styles: stylesPort = null,
    bloom: bloomPort = null,
  } = {},
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
  const engineClock = createNavaraClock(appClock ? { appClock } : {});
  // camera.follow (src/globe/follow.js): Navara's own cameraFollow takes
  // no user rotation or zoom (phase 3 Task 5 probe), so the engine steps
  // its own follow each frame.
  const followStep = createEngineEvent();
  const follow = createFollowController({
    camera: model.camera,
    aim: (pose) => model.aim(pose),
    frame: followStep,
    requestRender: () => view.forceUpdate(),
    // Drag orbits and wheel scales the follow's offset (followGestures.js).
    gestures: (handlers) =>
      navaraFollowGestures(view.canvas, () =>
        input.input.suspendCameraInputs(),
      )(handlers),
  });
  Object.assign(model.camera, {
    follow: (options) => follow.follow(options),
    following: () => follow.following(),
    followChanged: follow.followChanged,
  });
  // Defined below, with the surface and input it needs.
  let groundFloor = null;
  const handlers = {
    preUpdate: (time) => {
      engineClock.beginFrame();
      frames.preUpdate.raiseEvent(time);
    },
    preRender: (time) => {
      model.sync();
      // After the user's camera is read, before anything draws.
      followStep.raiseEvent();
      groundFloor?.update();
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

  // Picks over the movers and lines (picking.js); the input answers
  // listeners with { pick, drill } from it.
  const picking = createNavaraPicking({
    view,
    projector: {
      worldToWindow: (position, result) =>
        model.worldToWindow(position, result),
      horizonVisible: (position) => model.horizonVisible(position),
    },
    camera: model.camera,
    movers: () => moversPort?.pickables?.() ?? [],
    lines: () => linesPort?.pickables?.() ?? [],
    resolveBatch: (batchId) => moversPort?.resolvePick?.(batchId) ?? null,
  });
  const input = createNavaraInput(view, {
    // A gesture is the user, not a new camera owner: no camera.commanded.
    onCameraInput: () => model.stopFlight(),
    picker: picking,
  });
  const credits = createNavaraCredits(view);
  const maps = createNavaraMaps(view, fetch ? { fetch } : {});
  const { surface } = createNavaraSurface(view, hooks);
  // Navara's controller zooms through the ground; keep the camera above it.
  groundFloor = createGroundFloor({
    surface,
    position: () => model.camera.livePosition,
    isFree: () => model.isFree(),
    lift: (position) => model.lift(position),
    setMinimumZoomDistance: (distance) =>
      input.input.setCameraOptions({ minimumZoomDistance: distance }),
    ...(clock ? { now: () => clock.now() } : {}),
  });

  const picker = {
    // Navara mesh owners supply exact triangle hits for sync/hover/click picks.
    registerMeshPicker: (pick) => picking.registerMeshPicker(pick),
    // The CPU pick of movers and lines (picking.js); 3D tiles carry no ids.
    // Clicks with { pick } get Navara's GPU pick of the gesture instead.
    pick: (screen) => picking.pick(screen),
    drillPick: (screen, limit) => picking.drillPick(screen, limit),
    // Navara-only diagnostics: how clicks with { pick } were answered.
    clickStats: () => picking.clickStats(),
    pickPosition(screen) {
      const rect = canvas.getBoundingClientRect();
      const hit = view.pickDepthPosition(
        rect.left + screen.x,
        rect.top + screen.y,
      );
      return hit ? cartesian3.create(hit.x, hit.y, hit.z) : undefined;
    },
    pickPositionSupported: true,
    // The globe under a window position: the pick ray's ellipsoid hit, moved
    // onto Navara's terrain (a few fixed-point steps; terrain varies slowly
    // over the distance the hit moves).
    pickGlobe(screen) {
      let hit = model.camera.pickEllipsoid(screen);
      if (!hit) return undefined;
      const ray = model.camera.pickRay(screen);
      for (let step = 0; step < 4; step++) {
        const height = surface.terrainHeight(
          geo.cartographic.fromCartesian(hit, geo.ellipsoid.WGS84),
        );
        if (!Number.isFinite(height)) break;
        const next = rayRaisedEllipsoid(ray, height);
        if (!next) break;
        const moved = cartesian3.distance(next, hit);
        hit = next;
        if (moved < 0.01) break;
      }
      return hit;
    },
  };

  let sharpen = { ...SHARPEN_INITIAL };
  let destroyed = false;
  // render.visualStyles/setStyle/style, with a styles port only.
  const styleStates = new Map(
    (stylesPort?.names ?? []).map((name) => [
      name,
      { ...STYLE_INITIAL, uniforms: stylesPort.defaults(name) },
    ]),
  );
  const knownStyle = (name) => {
    if (!styleStates.has(name))
      throw new TypeError(`Unknown visual style: ${name}`);
    return styleStates.get(name);
  };
  const styleRender = stylesPort
    ? {
        visualStyles: Object.freeze([...stylesPort.names]),
        setStyle(name, options) {
          const current = knownStyle(name);
          const next = mergeStyle(
            current,
            options,
            stylesPort.uniformNames(name),
          );
          const changed =
            next.intensity !== current.intensity ||
            Object.entries(next.uniforms).some(
              ([key, value]) => current.uniforms[key] !== value,
            );
          styleStates.set(name, next);
          if (!changed || destroyed) return;
          stylesPort.set(name, {
            intensity: next.intensity,
            uniforms: { ...next.uniforms },
          });
          view.forceUpdate();
        },
        style(name) {
          const { intensity, uniforms } = knownStyle(name);
          return { intensity, uniforms: { ...uniforms } };
        },
      }
    : {};
  let bloom = { ...BLOOM_INITIAL };
  const bloomRender = bloomPort
    ? {
        setBloom(options) {
          const next = mergeBloom(bloom, options);
          const changed =
            next.enabled !== bloom.enabled || next.strength !== bloom.strength;
          bloom = next;
          if (!changed || destroyed) return;
          bloomPort.set({ ...next });
          view.forceUpdate();
        },
        bloom: () => ({ ...bloom }),
      }
    : {};
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
      setSharpen(options) {
        const next = mergeSharpen(sharpen, options);
        const changed =
          next.enabled !== sharpen.enabled || next.amount !== sharpen.amount;
        sharpen = next;
        if (!changed || destroyed) return;
        sharpenPort?.set({ ...next });
        view.forceUpdate();
      },
      sharpen: () => ({ ...sharpen }),
      ...styleRender,
      ...bloomRender,
    },
    surface,
    input: input.input,
    credits: credits.credits,
    maps: maps.maps,
    clock: engineClock.clock,
    movers: moversPort?.movers ?? NO_MOVERS,
    lines: linesPort?.lines ?? NO_LINES,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const [name, handler] of Object.entries(handlers))
        view.off(name, handler);
      follow.destroy();
      model.destroy();
      input.destroy();
      picking.destroy();
      credits.destroy();
      maps.destroy();
      sharpenPort?.destroy();
      stylesPort?.destroy();
      bloomPort?.destroy();
      moversPort?.destroy();
      linesPort?.destroy();
    },
    isDestroyed: () => destroyed,
    // Navara only, not contract: the post pipeline as QA reads it (the
    // passes in draw order, whether the styles pass shows).
    pipeline: () => {
      const styles = stylesPort?.diagnostics?.();
      const glow = bloomPort?.diagnostics?.();
      if (!styles && !glow) return null;
      return {
        shown: styles?.shown ?? false,
        bloomShown: glow?.shown ?? false,
        passes: styles?.passes ?? glow?.passes ?? null,
      };
    },
    // Navara only, not contract: the ground the floor last sampled under
    // the camera and the margin it keeps above it (QA measures against it).
    groundFloor: {
      ground: () => groundFloor.ground(),
      margin: GROUND_FLOOR.MIN_ABOVE,
    },
  };
}
