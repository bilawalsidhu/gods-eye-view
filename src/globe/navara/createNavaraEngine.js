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
  CLOUD_COVER_INITIAL,
  CONTACT_SONAR_INITIAL,
  SHARPEN_INITIAL,
  STYLE_INITIAL,
  createEngineEvent,
  mergeBloom,
  mergeCloudCover,
  mergeContactSonar,
  mergeSharpen,
  mergeStyle,
} from '../contract.js';
import { cesiumFovy, intersectEllipsoid } from '../cameraMath.js';
import { createCameraModel } from './cameraModel.js';
import { createNavaraClock } from './clock.js';
import { createNavaraCredits } from './credits.js';
import { createNavaraInput } from './input.js';
import { createNavaraPicking } from './picking.js';
import { createFollowController } from '../follow.js';
import { createGroundPicks } from '../ground.js';
import { navaraFollowGestures } from './followGestures.js';
import { createNavaraMaps } from './maps.js';
import { createNavaraSurface } from './surface.js';
import { createGroundFloor } from './groundFloor.js';

const { cartesian3, math } = geo;
// Past the far side of the Earth: a ray from any camera to any tile.
const TILE_PICK_FAR_M = 2e7;

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
 *   hooks: { tileRoots: Function, isIdle: Function, retainTileGeometry: Function, dropOrphanFeatureChanges?: Function },
 *   imagery: (parts: { camera: object, size: Function, credits: object, photorealActive: () => boolean }) => { imagery: object, destroy: Function },
 *   container?: HTMLElement,
 *   fetch?: typeof fetch,
 *   clock?: object,
 *   appClock?: import('../../time/clock.js').AppClock,
 *   sharpen?: { set: (state: { enabled: boolean, amount: number }) => void, destroy: () => void },
 *   bloom?: { set: (state: { enabled: boolean, strength: number }) => void, destroy: () => void },
 *   clouds?: { set: (state: { coverage: number | null }) => void, destroy: () => void },
 *   sonar?: { set: (state: import('../contract.js').ContactSonar) => void, destroy: () => void },
 *   styles?: { names: readonly string[], uniformNames: (name: string) => string[], defaults: (name: string) => Record<string, number>, set: (name: string, state: { intensity: number, uniforms: Record<string, number> }) => void, destroy: () => void },
 * }} options `hooks` are internals.js; `container` defaults to the
 *   canvas's parent; `sharpen` draws render.setSharpen (sharpen.js; without
 *   it the engine only keeps the state) and the engine destroys it;
 *   `styles` draws render.setStyle (stylePasses.js; without it the engine
 *   has no visualStyles capability) and the engine destroys it; `bloom`
 *   draws render.setBloom (bloom.js; without it no bloom capability), also
 *   destroyed with the engine; `clouds` draws render.setCloudCover
 *   (cockpitClouds.js; without it, as on a look without clouds, no
 *   cloudCover capability), destroyed with the engine; `sonar` draws
 *   render.setContactSonar (sonar.js; without it no contactSonar
 *   capability), destroyed with the engine;
 *   `appClock` (the engine clock's time) defaults to the page's app clock;
 *   `movers` is engine.movers on the view's three runtime (movers/index.js;
 *   required), `lines` engine.lines (lines/index.js), `ground` engine.ground
 *   (ground/index.js), all
 *   destroyed with the engine; `imagery` makes engine.imagery from the
 *   engine's camera, size, credits and photoreal state (imagery/index.js;
 *   required), destroyed with the engine;
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
    movers: moversPort,
    lines: linesPort,
    ground: groundPort,
    imagery: imageryPort,
    meshes: meshesPort,
    sharpen: sharpenPort = null,
    styles: stylesPort = null,
    bloom: bloomPort = null,
    clouds: cloudsPort = null,
    sonar: sonarPort = null,
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
  const applyFovy = (radians) => {
    if (hooks.setCameraFovy) hooks.setCameraFovy(radians);
    else view.camera.fov = math.toDegrees(radians);
  };
  const matchFov = () => {
    const { width, height } = size();
    if (width > 0 && height > 0) applyFovy(cesiumFovy(width, height));
  };
  matchFov();

  const model = createCameraModel({
    port: {
      apply: (pose) => view.setCamera(pose),
      read: () => readCamera(view.camera.raw),
      fly: (pose, options) => view.flyTo(pose, options),
      // Navara 0.2.1 has no cancel call: any camera change interrupts a
      // flight, and an empty setCamera changes nothing else.
      stop: () => view.setCamera({}),
      size,
      requestFrame: () => view.forceUpdate(),
      setFovy: applyFovy,
      suspendCameraInputs: () => input.input.suspendCameraInputs(),
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
  // no user rotation or zoom, so the engine steps its own follow each frame.
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
  // Between the view's preRender and postRender: a change made then shows
  // in the frame being drawn and asks for no other.
  let drawing = false;
  // Navara clears its frame request after the frame it draws, so a
  // render.request made during one (preRender to the end of postRender) is
  // made again once that frame is done: the next frame follows, as on Cesium.
  let frameOpen = false;
  let requestedInFrame = false;
  const requestRender = () => {
    view.forceUpdate();
    if (frameOpen) requestedInFrame = true;
  };
  const handlers = {
    preUpdate: (time) => {
      // Before the view decides whether it is idle (internals.js).
      hooks.dropOrphanFeatureChanges?.();
      engineClock.beginFrame();
      frames.preUpdate.raiseEvent(time);
    },
    preRender: (time) => {
      drawing = true;
      frameOpen = true;
      queueMicrotask(() => {
        frameOpen = false;
        if (!requestedInFrame || destroyed) return;
        requestedInFrame = false;
        view.forceUpdate();
      });
      model.sync();
      // After the user's camera is read, before anything draws.
      followStep.raiseEvent();
      groundFloor?.update();
      frames.preRender.raiseEvent(time);
    },
    postRender: (time) => {
      drawing = false;
      model.afterFrame();
      frames.postRender.raiseEvent(time);
    },
    resize: () => {
      applyFovy(model.camera.pose().fovy);
    },
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
      horizonVisible: (position, options) =>
        model.horizonVisible(position, options),
    },
    camera: model.camera,
    movers: () => moversPort?.pickables?.() ?? [],
    lines: () => linesPort?.pickables?.() ?? [],
    resolveBatch: (batchId) => moversPort?.resolvePick?.(batchId) ?? null,
  });
  const input = createNavaraInput(view, { picker: picking });
  const credits = createNavaraCredits(view);
  const maps = createNavaraMaps(view, fetch ? { fetch } : {});
  const imagery =
    imageryPort?.({
      camera: model.camera,
      size,
      credits: credits.credits,
      photorealActive: () => maps.maps.photorealActive(),
    }) ?? null;
  const { surface } = createNavaraSurface(view, hooks, (positions) =>
    maps.sampleTerrain(positions),
  );
  // Navara's controller zooms through the ground; keep the camera above it.
  // With the camera inputs off or suspended nothing zooms, and the app places
  // the camera itself (the cockpit eye, 12 m up): the floor's 30 m would
  // fight it. A follow suspends them only to take drag and wheel itself.
  groundFloor = createGroundFloor({
    surface,
    position: () => model.camera.livePosition,
    isFree: () =>
      model.isFree() &&
      (input.input.cameraInputsEnabled() || Boolean(follow.following())),
    lift: (position) => model.lift(position),
    setMinimumZoomDistance: (distance) =>
      input.input.setCameraOptions({ minimumZoomDistance: distance }),
    ...(clock ? { now: () => clock.now() } : {}),
  });

  // Ground items are picked on the CPU at the visible surface under the pointer
  // (src/globe/ground.js), under every mover and line: the 3D tiles while
  // they show, else the globe. A CPU ray, not the depth read, which answers
  // with the near plane until a frame after Navara's pick of a click.
  const tilesUnder = (screen) => {
    if (!maps.maps.photorealActive()) return undefined;
    const ray = model.camera.pickRay(screen);
    return ray
      ? surface.raycast({
          origin: ray.origin,
          direction: ray.direction,
          far: TILE_PICK_FAR_M,
        })?.position
      : undefined;
  };
  const removeGroundPicks = picking.registerMeshPicker(
    createGroundPicks({
      pickGlobe: (screen) => tilesUnder(screen) ?? picker.pickGlobe(screen),
      camera: model.camera,
      size,
      sets: () => groundPort?.pickables?.() ?? [],
      surface: () => (maps.maps.photorealActive() ? 'tiles' : 'terrain'),
    }),
  );
  const picker = {
    // Navara mesh owners supply exact triangle hits for sync/hover/click picks.
    registerMeshPicker: (pick) => picking.registerMeshPicker(pick),
    // The CPU pick of movers and lines (picking.js); 3D tiles carry no ids.
    // Clicks with { pick } get Navara's GPU pick of the gesture instead.
    pick: (screen, width, height) => picking.pick(screen, width, height),
    drillPick: (screen, limit, width, height) =>
      picking.drillPick(screen, limit, width, height),
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
        const next = intersectEllipsoid(ray.origin, ray.direction, height);
        if (!next) break;
        const moved = cartesian3.distance(next, hit);
        hit = next;
        if (moved < 0.01) break;
      }
      return hit;
    },
  };

  const meshes = meshesPort?.({ camera: model.camera, picker }) ?? null;
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
  let maxTextureSize = null;
  // Movers on screen now: shown, not transparent, their anchor in the view
  // and over the horizon.
  const clip = geo.matrix4.create();
  const at = geo.cartesian3.create();
  const visibleContacts = () => {
    model.viewProjection(clip);
    let shown = 0;
    for (const { store } of moversPort?.pickables?.() ?? []) {
      const { positions, shows, colors, count } = store;
      for (let index = 0; index < count; index++) {
        if (shows[index] !== 1 || colors[index * 4 + 3] <= 0) continue;
        at.x = positions[index * 3];
        at.y = positions[index * 3 + 1];
        at.z = positions[index * 3 + 2];
        const w = clip[3] * at.x + clip[7] * at.y + clip[11] * at.z + clip[15];
        if (w <= 0) continue;
        const x =
          (clip[0] * at.x + clip[4] * at.y + clip[8] * at.z + clip[12]) / w;
        const y =
          (clip[1] * at.x + clip[5] * at.y + clip[9] * at.z + clip[13]) / w;
        if (Math.abs(x) > 1 || Math.abs(y) > 1) continue;
        if (model.horizonVisible(at)) shown++;
      }
    }
    return shown;
  };
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
  let cloudCover = { ...CLOUD_COVER_INITIAL };
  const cloudRender = cloudsPort
    ? {
        setCloudCover(options) {
          const next = mergeCloudCover(cloudCover, options);
          const changed = next.coverage !== cloudCover.coverage;
          cloudCover = next;
          if (!changed || destroyed) return;
          cloudsPort.set({ ...next });
          view.forceUpdate();
        },
        cloudCover: () => ({ ...cloudCover }),
      }
    : {};
  let contactSonar = { ...CONTACT_SONAR_INITIAL };
  const sonarRender = sonarPort
    ? {
        setContactSonar(options) {
          const next = mergeContactSonar(contactSonar, options);
          const changed = Object.keys(next).some(
            (key) => next[key] !== contactSonar[key],
          );
          contactSonar = next;
          if (!changed || destroyed) return;
          sonarPort.set({ ...next });
          if (!drawing) view.forceUpdate();
        },
        contactSonar: () => ({ ...contactSonar }),
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
      horizonVisible: (position, options) =>
        model.horizonVisible(position, options),
    },
    frames,
    render: {
      request: requestRender,
      setContinuous(enabled) {
        view.animation = Boolean(enabled);
      },
      isContinuous: () => view.animation === true,
      // The canvas's own context (getContext hands back the one the view
      // made); Navara has no public renderer to ask.
      maxTextureSize: () =>
        (maxTextureSize ??= (() => {
          const gl =
            canvas.getContext?.('webgl2') ?? canvas.getContext?.('webgl');
          return gl?.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0;
        })()),
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
      ...cloudRender,
      ...sonarRender,
    },
    surface,
    input: input.input,
    credits: credits.credits,
    maps: maps.maps,
    clock: engineClock.clock,
    movers: moversPort.movers,
    lines: linesPort.lines,
    ground: groundPort.ground,
    meshes: meshes.meshes,
    imagery: imagery.imagery,
    // Not in the contract, as Cesium's (src/cyberSonarEngine.js reads it):
    // the treatment runs in the movers' shaders; `contacts` is how many are
    // on screen, so an empty view lets the sonar go idle.
    contactSonarDiagnostics: () => ({
      supported: true,
      contacts: visibleContacts(),
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const [name, handler] of Object.entries(handlers))
        view.off(name, handler);
      follow.destroy();
      model.destroy();
      input.destroy();
      removeGroundPicks();
      picking.destroy();
      imagery?.destroy();
      credits.destroy();
      maps.destroy();
      sharpenPort?.destroy();
      stylesPort?.destroy();
      bloomPort?.destroy();
      cloudsPort?.destroy();
      sonarPort?.destroy();
      moversPort?.destroy();
      linesPort?.destroy();
      groundPort?.destroy();
      meshes?.destroy();
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
    // Navara only, not contract: what the ground pass holds (QA reads it).
    groundDiagnostics: () => groundPort?.diagnostics?.() ?? null,
  };
}
