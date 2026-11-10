import { createExclusivePointer } from '../exclusivePointer.js';
// A GlobeEngine built on src/geo alone, for tests of shell modules. It keeps a
// controllable perspective camera on the WGS84 ellipsoid, projects and picks
// against it, records every contract call and lets tests emit events, drive
// input, advance frames and script pick/height/projection results through
// `engine.fake`. It passes src/globe/testing/contractSuite.mjs.
//
// Simplifications against Cesium, which shell tests must not rely on:
// - a flight interpolates the position linearly (eased) through space and
//   snaps the orientation at the end; Cesium arcs over the globe and turns
//   gradually. A flight without a duration lasts 3 s of fake frame time.
// - moveStart/changed/moveEnd are detected once per `fake.frame()`, and
//   moveEnd fires after one frame without movement; Cesium waits 500 ms
//   (scene.cameraEventWaitTime) of wall time.
// - nothing occludes picks or projection except where the contract says so
//   (horizonVisible); there is no terrain or scene geometry unless scripted.
// - a rectangle destination looks at the rectangle's centre from where its
//   wider side fills the view; Cesium fits the corners.
// - zoom distances are Cesium's defaults (1 m to unbounded).

import * as geo from '../../geo/index.js';
import {
  INPUT_TYPES,
  MODIFIERS,
  normalizeInputOptions,
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
import { createAppClock } from '../../time/clock.js';
import {
  cesiumFovy,
  headingPitchRoll,
  horizonVisible,
  lookAtFrame,
  orientationVectors,
  pickEllipsoid,
  pickRay,
  projectToWindow,
  rectangleViewPosition,
  sphereRange,
  viewProjection,
  viewRectangle,
} from '../cameraMath.js';
import { createGroundPicks, createGroundRegistry } from '../ground.js';
import { createMeshRegistry, meshRayDistance } from '../meshes.js';
import { createImageryRegistry } from '../imagery.js';
import { createLineRegistry } from '../lines.js';
import { createMoverRegistry, createMoverRetry } from '../movers.js';
import { createCpuPicker } from '../cpuPicks.js';
import { createFollowController } from '../follow.js';
import { normalizeSurfaceOptions } from '../surfaceDetail.js';

const { cartesian2, cartesian3, cartographic, ellipsoid, math, matrix4 } = geo;
const WGS84 = ellipsoid.WGS84;
// Where the fake wall clock starts: 2026-01-01T00:00:00Z.
const FAKE_EPOCH_MS = Date.UTC(2026, 0, 1);
// The terrain kinds the engines build themselves (src/maps/registry.js).
const TERRAIN_KINDS = Object.freeze(['ellipsoid', 'keyless', 'world']);
const DEFAULT_FLIGHT_SECONDS = 3;
const DEFAULT_ZOOM_AMOUNT = 100000; // Cesium's camera.defaultZoomAmount
const SCRIPTABLE = new Set([
  'pick',
  'drillPick',
  'pickPosition',
  'pickGlobe',
  'pickEllipsoid',
  'viewRectangle',
  'sampleHeight',
  'sampleHeightDetailed',
  'terrainHeight',
  'sampleTerrainMostDetailed',
  'clampToHeight',
  'tilesLoaded',
  'worldToWindow',
  'moverFailed',
]);
const EASINGS = {
  linear: (t) => t,
  cubicInOut: (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  sinusoidalInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
};

const copy3 = (value) => cartesian3.create(value.x, value.y, value.z);
const scaled = (vector, scalar) =>
  cartesian3.multiplyByScalar(vector, scalar, cartesian3.create());
const sum = (...vectors) =>
  vectors.reduce(
    (total, vector) => cartesian3.add(total, vector, total),
    cartesian3.create(),
  );
const unit = (vector) => cartesian3.normalize(vector, cartesian3.create());
const cross = (left, right) =>
  cartesian3.cross(left, right, cartesian3.create());

// render.setContactSonar/contactSonar when asked; nothing otherwise.
function fakeContactSonar(enabled, record) {
  if (!enabled) return {};
  let sonar = { ...CONTACT_SONAR_INITIAL };
  return {
    setContactSonar(options) {
      record('render.setContactSonar', [options]);
      sonar = mergeContactSonar(sonar, options);
    },
    contactSonar: () => ({ ...sonar }),
  };
}

// render.setCloudCover/cloudCover when asked; nothing otherwise.
function fakeCloudCover(enabled, record) {
  if (!enabled) return {};
  let cover = { ...CLOUD_COVER_INITIAL };
  return {
    setCloudCover(options) {
      record('render.setCloudCover', [options]);
      cover = mergeCloudCover(cover, options);
    },
    cloudCover: () => ({ ...cover }),
  };
}

// render.setBloom/bloom when asked; nothing otherwise.
function fakeBloom(enabled, record) {
  if (!enabled) return {};
  let bloom = { ...BLOOM_INITIAL };
  return {
    setBloom(options) {
      record('render.setBloom', [options]);
      bloom = mergeBloom(bloom, options);
    },
    bloom: () => ({ ...bloom }),
  };
}

// render.visualStyles/setStyle/style for `visualStyles` ({ name: uniform
// names }); nothing without it.
function fakeStyles(visualStyles, record) {
  if (!visualStyles) return {};
  const states = new Map(
    Object.entries(visualStyles).map(([name, uniforms]) => [
      name,
      {
        ...STYLE_INITIAL,
        uniforms: Object.fromEntries(uniforms.map((uniform) => [uniform, 0])),
      },
    ]),
  );
  const known = (name) => {
    if (!states.has(name)) throw new TypeError(`Unknown visual style: ${name}`);
    return states.get(name);
  };
  return {
    visualStyles: Object.freeze(Object.keys(visualStyles)),
    setStyle(name, options) {
      record('render.setStyle', [name, options]);
      states.set(name, mergeStyle(known(name), options, visualStyles[name]));
    },
    style(name) {
      const { intensity, uniforms } = known(name);
      return { intensity, uniforms: { ...uniforms } };
    },
  };
}

/**
 * @param {{ kind?: 'cesium'|'navara', width?: number, height?: number, fovy?: number,
 *   longitude?: number, latitude?: number, altitude?: number,
 *   container?: object, canvas?: object, nowMs?: number,
 *   appClock?: import('../../time/clock.js').AppClock,
 *   visualStyles?: Record<string, string[]>, bloom?: boolean,
 *   cloudCover?: boolean, contactSonar?: boolean }} [options]
 *   Canvas size in CSS px, angles in radians; `container`/`canvas` stand in
 *   for the host elements (DOM mocks for shell tests). The initial pose looks straight
 *   down from `altitude` metres (10 000 km). The engine clock reads
 *   `appClock`, by default an app clock on a fake wall clock that starts at
 *   `nowMs` (2026-01-01T00:00Z) and moves only with `fake.frame(dt)` and
 *   `fake.advanceTime(ms)` (a given appClock keeps its own wall clock).
 *   `visualStyles` ({ style: its uniform names }) adds the optional
 *   visualStyles capability (render.setStyle), each uniform starting at 0;
 *   `bloom: true` the optional bloom capability (render.setBloom);
 *   `cloudCover: true` the optional cloudCover one (render.setCloudCover);
 *   `contactSonar: true` the contactSonar one (render.setContactSonar).
 * @returns {import('../contract.js').GlobeEngine & { fake: object }}
 */
export function createFakeEngine(options = {}) {
  let width = options.width ?? 1024;
  let height = options.height ?? 768;
  // Cesium's default: 60 degrees across the wider canvas dimension.
  let fovy = options.fovy ?? cesiumFovy(width, height);
  const state = {
    position: cartesian3.create(),
    direction: cartesian3.create(),
    up: cartesian3.create(),
  };
  const events = {
    'maps.errors': createEngineEvent(),
    'camera.changed': createEngineEvent(),
    'camera.moveStart': createEngineEvent(),
    'camera.moveEnd': createEngineEvent(),
    'camera.commanded': createEngineEvent(),
    'frames.preUpdate': createEngineEvent(),
    'frames.preRender': createEngineEvent(),
    'frames.postRender': createEngineEvent(),
    // The follow steps here, before preRender (as on Navara).
    followStep: createEngineEvent(),
  };
  let wallMs = options.nowMs ?? FAKE_EPOCH_MS;
  const appClock = options.appClock ?? createAppClock({ now: () => wallMs });
  const ownsWall = !options.appClock;
  // Lines keep what they were given; each change counts as a render request.
  const fakeLines = new Map();
  const lineRegistry = createLineRegistry((options) => {
    const state = {
      options,
      positions: new Float64Array(0),
      color: [...options.color],
      modelMatrix: options.modelMatrix,
      shown: true,
    };
    fakeLines.set(options.id, state);
    const changed = () => {
      fake.renderRequests++;
    };
    return {
      setPositions(flat) {
        state.positions = flat;
        changed();
      },
      setSegments(items) {
        state.items = items;
        changed();
      },
      setColor(rgba) {
        state.color = rgba;
        changed();
      },
      setModelMatrix(matrix) {
        state.modelMatrix = matrix;
        changed();
      },
      show(visible) {
        state.shown = visible;
        changed();
      },
      destroy() {
        fakeLines.delete(options.id);
      },
    };
  });
  // Movers keep their store for tests; commit counts as a render request.
  const moverRegistry = createMoverRegistry((options, store) => {
    const loads = new Map();
    const ensure = (index) => {
      const pickId = store.pickIds[index];
      let entry = loads.get(index);
      if (entry && entry.pickId === pickId) return entry;
      entry?.retry.destroy();
      entry = { pickId, ready: false, retry: null };
      entry.retry = createMoverRetry(options.retryAfterMs, (attempt) => {
        // A script can fail the first N attempts: (id, index, attempt) => attempt <= N.
        if (scripted('moverFailed', [options.id, index, attempt], () => false))
          entry.retry.fail();
        else {
          entry.ready = true;
          entry.retry.succeed();
        }
        fake.renderRequests++;
      });
      loads.set(index, entry);
      entry.retry.start();
      return entry;
    };
    if (options.kind === 'sprite') ensure(undefined);
    const current = (index) => {
      const entry = loads.get(options.kind === 'sprite' ? undefined : index);
      return options.kind === 'sprite' || entry?.pickId === store.pickIds[index]
        ? entry
        : null;
    };
    const part = {
      commits: 0,
      commit() {
        if (options.kind === 'model')
          for (let index = 0; index < store.count; index++) ensure(index);
        part.commits++;
        fake.renderRequests++;
      },
      ready(index) {
        if (options.kind === 'point') return true;
        if (options.kind === 'sprite') return current(index).ready;
        if (index !== undefined) return current(index)?.ready === true;
        for (let at = 0; at < store.count; at++)
          if (!current(at)?.ready) return false;
        return true;
      },
      failed(index) {
        if (options.kind === 'point') return false;
        if (options.kind === 'sprite') return current(index).retry.failed();
        if (index !== undefined) return current(index)?.retry.failed() === true;
        for (let at = 0; at < store.count; at++)
          if (current(at)?.retry.failed()) return true;
        return false;
      },
      destroy() {
        for (const entry of loads.values()) entry.retry.destroy();
        loads.clear();
      },
    };
    return part;
  });
  // Ground sets keep their items for tests; commit counts as a render
  // request, and so does every frame while a shown set animates.
  const meshRegistry = createMeshRegistry(() => ({
    update() {},
    destroy() {},
  }));
  const groundRegistry = createGroundRegistry(() => ({
    reveal() {
      fake.renderRequests++;
    },
    commit() {
      fake.renderRequests++;
    },
    show() {
      fake.renderRequests++;
    },
    destroy() {},
  }));
  // Imagery layers keep their state for tests; every change is a render
  // request. They drape on the globe, or on tiles while photoreal shows. A
  // staged source or a detail is drawn on the next microtask, unless a
  // newer one or a destroy came first.
  const imageryRegistry = createImageryRegistry(
    () => ({
      source() {
        fake.renderRequests++;
      },
      credit() {
        fake.renderRequests++;
      },
      stage(_source, finish) {
        queueMicrotask(() => {
          fake.renderRequests++;
          finish(true);
        });
      },
      detail(detail, finish) {
        fake.renderRequests++;
        if (detail) queueMicrotask(() => finish(true));
      },
      look() {
        fake.renderRequests++;
      },
      destroy() {
        fake.renderRequests++;
      },
    }),
    {
      splitPosition() {
        fake.renderRequests++;
      },
      surface: () => (fake.maps.photoreal != null ? 'tiles' : 'globe'),
    },
  );
  const inputs = new Map(INPUT_TYPES.map((type) => [type, new Set()]));
  const livePosition = cartesian3.create();
  let lastBaseImagery = null;
  const removeMapErrors = { tile: null, terrain: null };
  function watchMapErrors(source, kind) {
    removeMapErrors[kind]?.();
    removeMapErrors[kind] = source?.provider?.errorEvent?.addEventListener(
      (error) => {
        events['maps.errors'].raiseEvent({
          source,
          kind,
          status:
            error?.error?.statusCode ?? error?.statusCode ?? error?.status,
        });
      },
    );
  }
  const scripts = new Map();
  let transform = [...matrix4.IDENTITY];
  let percentageChanged = 0.5;
  let continuous = false;
  let sharpen = { ...SHARPEN_INITIAL };
  let flight = null;
  let lookAtTarget = null;
  let clock = 0;
  let moving = false;
  let lastFramePose = null;
  let lastChangedPose = null;
  let cameraSuspensions = 0;

  const fake = {
    calls: [],
    renderRequests: 0,
    cameraInputsEnabled: true,
    credits: [],
    maps: {
      imagery: undefined,
      terrain: undefined,
      photoreal: null,
      terrainRevision: 0,
    },
    // render.maxTextureSize: a common WebGL2 limit; tests set a smaller one.
    maxTextureSize: 4096,
    destroyed: false,
  };
  const record = (method, args) => fake.calls.push({ method, args });
  // A camera command: recorded, then announced before it runs.
  const command = (method, args) => {
    record(method, args);
    events['camera.commanded'].raiseEvent();
  };

  const aspect = () => width / height;
  const right = () => unit(cross(state.direction, state.up));
  const poseAngles = () =>
    headingPitchRoll(state.position, state.direction, state.up);
  // The camera as cameraMath takes it.
  const cameraView = () => ({
    position: state.position,
    direction: state.direction,
    up: state.up,
    fovy,
    width,
    height,
  });

  // The pose for a destination and orientation; missing angles use `fallback`.
  function viewFor(destination, orientation, fallback) {
    const position =
      'west' in destination
        ? rectangleViewPosition(destination, fovy, aspect())
        : destination;
    if (orientation && 'direction' in orientation)
      return {
        position: copy3(position),
        direction: unit(orientation.direction),
        up: unit(orientation.up),
      };
    const vectors = orientationVectors(
      position,
      orientation?.heading ?? fallback.heading,
      orientation?.pitch ?? fallback.pitch,
      orientation?.roll ?? fallback.roll,
    );
    return { position: copy3(position), ...vectors };
  }
  // Cesium's setView/flyTo defaults for missing angles.
  const CESIUM_DEFAULTS = { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 };

  function apply(view) {
    state.position = copy3(view.position);
    state.direction = copy3(view.direction);
    state.up = copy3(view.up);
  }

  function setTransform(next, target) {
    transform = [...next];
    lookAtTarget = target ? copy3(target) : null;
  }

  function cancelCurrentFlight() {
    const current = flight;
    flight = null;
    current?.cancel?.();
  }

  // Ends a flight: the end transform first, then the target pose.
  function land(flightOptions, target) {
    if (flightOptions.endTransform) setTransform(flightOptions.endTransform);
    apply(target);
  }

  function startFlight(flightOptions, target) {
    cancelCurrentFlight();
    const duration = flightOptions.duration ?? DEFAULT_FLIGHT_SECONDS;
    if (duration <= 0) {
      land(flightOptions, target);
      flightOptions.complete?.();
      return;
    }
    flight = {
      start: copy3(state.position),
      target,
      duration: duration * 1000,
      elapsed: 0,
      ease: EASINGS[flightOptions.easing] ?? EASINGS.cubicInOut,
      endTransform: flightOptions.endTransform,
      complete: flightOptions.complete,
      cancel: flightOptions.cancel,
    };
  }

  function advanceFlight(dt) {
    if (!flight) return;
    flight.elapsed += dt;
    const t = Math.min(1, flight.elapsed / flight.duration);
    if (t < 1) {
      cartesian3.lerp(
        flight.start,
        flight.target.position,
        flight.ease(t),
        state.position,
      );
      return;
    }
    const current = flight;
    flight = null;
    land(current, current.target);
    current.complete?.();
  }

  function cameraEvents() {
    const pose = {
      position: copy3(state.position),
      direction: copy3(state.direction),
      up: copy3(state.up),
    };
    const differs = (a, b) =>
      !b ||
      !cartesian3.equalsEpsilon(a.position, b.position, 0, 1e-9) ||
      !cartesian3.equalsEpsilon(a.direction, b.direction, 0, 1e-12) ||
      !cartesian3.equalsEpsilon(a.up, b.up, 0, 1e-12);
    if (differs(pose, lastFramePose)) {
      if (!moving) {
        moving = true;
        events['camera.moveStart'].raiseEvent();
      }
    } else if (moving) {
      moving = false;
      events['camera.moveEnd'].raiseEvent();
    }
    lastFramePose = pose;
    if (!lastChangedPose) {
      lastChangedPose = pose;
      return;
    }
    const turn =
      Math.acos(
        math.clamp(
          cartesian3.dot(pose.direction, lastChangedPose.direction),
          -1,
          1,
        ),
      ) / Math.PI;
    const altitude = Math.max(
      1,
      cartographic.fromCartesian(pose.position, WGS84).height,
    );
    const shift =
      cartesian3.distance(pose.position, lastChangedPose.position) / altitude;
    const roll =
      Math.acos(
        math.clamp(cartesian3.dot(pose.up, lastChangedPose.up), -1, 1),
      ) / Math.PI;
    const amount = Math.max(turn, roll, shift);
    if (amount > percentageChanged) {
      lastChangedPose = pose;
      events['camera.changed'].raiseEvent(amount);
    }
  }

  function scripted(name, args, fallback) {
    if (!scripts.has(name)) return fallback();
    const value = scripts.get(name);
    return typeof value === 'function' ? value(...args) : value;
  }

  const camera = {
    setFovy(radians) {
      if (!Number.isFinite(radians) || radians <= 0 || radians >= Math.PI)
        throw new RangeError('Field of view must be between 0 and PI');
      record('camera.setFovy', [radians]);
      fovy = radians;
      engine.render.request('camera-fov');
    },
    pose() {
      const angles = poseAngles();
      return {
        position: copy3(state.position),
        cartographic: cartographic.fromCartesian(state.position, WGS84),
        heading: angles.heading,
        pitch: angles.pitch,
        roll: angles.roll,
        direction: copy3(state.direction),
        up: copy3(state.up),
        right: right(),
        fovy,
        aspectRatio: aspect(),
      };
    },
    get livePosition() {
      return cartesian3.clone(state.position, livePosition);
    },
    height: () => cartographic.fromCartesian(state.position, WGS84).height,
    setView(view) {
      command('camera.setView', [view]);
      if (!view?.destination)
        throw new TypeError('setView needs a destination');
      cancelCurrentFlight();
      apply(viewFor(view.destination, view.orientation, CESIUM_DEFAULTS));
    },
    flyTo(flightOptions) {
      command('camera.flyTo', [flightOptions]);
      if (!flightOptions?.destination)
        throw new TypeError('flyTo needs a destination');
      startFlight(
        flightOptions,
        viewFor(
          flightOptions.destination,
          flightOptions.orientation,
          CESIUM_DEFAULTS,
        ),
      );
    },
    flyToSphere(sphere, sphereOptions = {}) {
      command('camera.flyToSphere', [sphere, sphereOptions]);
      setTransform(matrix4.IDENTITY);
      const range =
        sphereOptions.range || sphereRange(sphere.radius, fovy, aspect());
      const frame = geo.transforms.eastNorthUpToFixedFrame(
        sphere.center,
        WGS84,
      );
      startFlight(
        sphereOptions,
        lookAtFrame(frame, {
          heading: sphereOptions.heading ?? 0,
          pitch: sphereOptions.pitch ?? -Math.PI / 4,
          range,
        }),
      );
    },
    flightActive: () => flight != null,
    lookAt(target, offset) {
      command('camera.lookAt', [target, offset]);
      const frame = geo.transforms.eastNorthUpToFixedFrame(target, WGS84);
      setTransform(frame, target);
      apply(lookAtFrame(frame, offset));
    },
    lookAtTransform(frame, offset) {
      record('camera.lookAtTransform', [frame, offset]);
      setTransform(frame, cartesian3.create(frame[12], frame[13], frame[14]));
      if (offset) apply(lookAtFrame(frame, offset));
    },
    transform: () => [...transform],
    release() {
      record('camera.release', []);
      setTransform(matrix4.IDENTITY);
    },
    cancelFlight() {
      command('camera.cancelFlight', []);
      cancelCurrentFlight();
    },
    completeFlight() {
      const current = flight;
      if (!current) return record('camera.completeFlight', []);
      flight = null;
      command('camera.completeFlight', []);
      land(current, current.target);
      current.complete?.();
    },
    zoomIn(amount = DEFAULT_ZOOM_AMOUNT) {
      record('camera.zoomIn', [amount]);
      state.position = sum(state.position, scaled(state.direction, amount));
    },
    zoomOut(amount = DEFAULT_ZOOM_AMOUNT) {
      record('camera.zoomOut', [amount]);
      state.position = sum(state.position, scaled(state.direction, -amount));
    },
    viewRectangle() {
      record('camera.viewRectangle', []);
      return scripted('viewRectangle', [], () => viewRectangle(cameraView()));
    },
    pickEllipsoid(screen) {
      return scripted('pickEllipsoid', [screen], () =>
        pickEllipsoid(cameraView(), screen),
      );
    },
    pickRay(screen) {
      return pickRay(cameraView(), screen);
    },
    changed: events['camera.changed'],
    moveStart: events['camera.moveStart'],
    moveEnd: events['camera.moveEnd'],
    commanded: events['camera.commanded'],
    follow: (options) => follow.follow(options),
    following: () => follow.following(),
    get followChanged() {
      return follow.followChanged;
    },
    get percentageChanged() {
      return percentageChanged;
    },
    set percentageChanged(value) {
      percentageChanged = value;
    },
  };

  const host = {
    container: options.container ?? { kind: 'fake-container' },
    canvas: options.canvas ?? { kind: 'fake-canvas' },
    size: () => ({ width, height }),
  };

  // Unscripted picks find the fake's own movers, lines and ground items, as
  // Navara's CPU pick does (src/globe/cpuPicks.js, src/globe/ground.js).
  const cpuPick = createCpuPicker({
    projector: {
      worldToWindow: (position, result) =>
        engine.projector.worldToWindow(position, result),
      horizonVisible: (position) => engine.projector.horizonVisible(position),
    },
    camera: {
      get livePosition() {
        return engine.camera.livePosition;
      },
    },
    movers: () =>
      [...moverRegistry.sets.values()].map(({ options, store }) => ({
        options,
        store,
      })),
    lines: () =>
      [...fakeLines.values()]
        .filter((state) => state.shown)
        .flatMap((state) =>
          state.options.segments
            ? (state.items ?? []).map((item) => ({
                options: {
                  ...state.options,
                  widthPx: item.widthPx,
                  pickId: item.pickId,
                },
                flat: item.positions,
                modelMatrix: null,
              }))
            : [
                {
                  options: state.options,
                  flat: state.positions,
                  modelMatrix: state.modelMatrix,
                },
              ],
        ),
    // Ground items under the picked globe point (src/globe/ground.js).
    meshes: (at) => {
      const ray = engine.camera.pickRay(at);
      const surface =
        engine.picker.pickPosition(at) ?? engine.picker.pickGlobe(at);
      const distance =
        surface && ray ? cartesian3.distance(ray.origin, surface) : Infinity;
      const hits = [];
      for (const { state } of meshRegistry.live.values()) {
        if (!state.show || state.pickId == null) continue;
        const depth = meshRayDistance(state, ray);
        if (
          !Number.isFinite(depth) ||
          (state.depthTest !== 'always' && depth > distance + 0.1)
        )
          continue;
        hits.push({
          onTop: state.depthTest === 'always' ? 1 : 0,
          order: 0,
          depth,
          result: { id: state.pickId, owner: state.id },
        });
      }
      return [...hits, ...groundPicks(at)];
    },
  });
  const groundPicks = createGroundPicks({
    surface: () => (fake.maps.photoreal != null ? 'tiles' : 'terrain'),
    pickGlobe: (screen) => engine.picker.pickGlobe(screen),
    camera: {
      get livePosition() {
        return engine.camera.livePosition;
      },
      pose: () => engine.camera.pose(),
    },
    size: () => ({ width, height }),
    sets: () => [...groundRegistry.live.values()],
  });
  // camera.follow on the fake's frames (src/globe/follow.js), as Navara.
  const follow = createFollowController({
    camera: {
      pose: () => engine.camera.pose(),
      commanded: events['camera.commanded'],
    },
    aim: (pose) => apply(pose),
    frame: events.followStep,
    requestRender: () => {
      fake.renderRequests++;
    },
  });
  const pointer = createExclusivePointer();
  const engine = {
    kind: options.kind ?? 'cesium',
    host,
    camera,
    picker: {
      pick(screen, w, h) {
        record('picker.pick', [screen, w, h]);
        return scripted(
          'pick',
          [screen, w, h],
          () => cpuPick(screen, 1, { width: w, height: h })[0],
        );
      },
      drillPick(screen, limit, w, h) {
        record('picker.drillPick', [screen, limit, w, h]);
        return scripted('drillPick', [screen, limit, w, h], () =>
          cpuPick(screen, limit ?? Infinity, { width: w, height: h }),
        );
      },
      pickPosition(screen) {
        record('picker.pickPosition', [screen]);
        return scripted('pickPosition', [screen], () =>
          camera.pickEllipsoid(screen),
        );
      },
      pickPositionSupported: true,
      pickGlobe(screen) {
        record('picker.pickGlobe', [screen]);
        return scripted('pickGlobe', [screen], () =>
          camera.pickEllipsoid(screen),
        );
      },
    },
    projector: {
      worldToWindow(position, result) {
        const value = scripted('worldToWindow', [position, result], () =>
          projectToWindow(cameraView(), position, result),
        );
        if (value && result && value !== result)
          return cartesian2.clone(value, result);
        return value;
      },
      viewProjection: (result) => viewProjection(cameraView(), result),
      horizonVisible: (position, options) =>
        horizonVisible(state.position, position, options),
    },
    movers: moverRegistry.movers,
    lines: lineRegistry.lines,
    meshes: meshRegistry.meshes,
    ground: groundRegistry.ground,
    imagery: imageryRegistry.imagery,
    clock: {
      now: () => appClock.now(),
      frameTime: () => appClock.frameTime(),
    },
    frames: {
      preUpdate: events['frames.preUpdate'],
      preRender: events['frames.preRender'],
      postRender: events['frames.postRender'],
    },
    render: {
      request(reason) {
        record('render.request', reason === undefined ? [] : [reason]);
        fake.renderRequests++;
      },
      setContinuous(enabled) {
        record('render.setContinuous', [enabled]);
        continuous = Boolean(enabled);
      },
      isContinuous: () => continuous,
      maxTextureSize: () => fake.maxTextureSize,
      setSharpen(options) {
        record('render.setSharpen', [options]);
        sharpen = mergeSharpen(sharpen, options);
      },
      sharpen: () => ({ ...sharpen }),
      ...fakeStyles(options.visualStyles, record),
      ...fakeBloom(options.bloom, record),
      ...fakeCloudCover(options.cloudCover, record),
      ...fakeContactSonar(options.contactSonar, record),
    },
    surface: {
      raycast(ray) {
        record('surface.raycast', [ray]);
        return scripted('raycast', [ray], () => undefined);
      },
      sampleHeight(position, exclude) {
        record('surface.sampleHeight', [position, exclude]);
        return scripted('sampleHeight', [position, exclude], () => undefined);
      },
      // Scripted as 'sampleHeightDetailed', else from the scripted
      // sampleHeight (tiles, no size) and terrainHeight.
      sampleHeightDetailed(position, surfaceOptions) {
        const { exclude } = normalizeSurfaceOptions(surfaceOptions);
        record('surface.sampleHeightDetailed', [position, { exclude }]);
        return scripted('sampleHeightDetailed', [position, { exclude }], () => {
          const height = scripted(
            'sampleHeight',
            [position, exclude],
            () => undefined,
          );
          if (Number.isFinite(height)) return { height, source: 'tiles' };
          const terrain = scripted('terrainHeight', [position], () => 0);
          return Number.isFinite(terrain)
            ? { height: terrain, source: 'terrain' }
            : undefined;
        });
      },
      supported: true,
      terrainHeight(position) {
        record('surface.terrainHeight', [position]);
        return scripted('terrainHeight', [position], () => 0);
      },
      terrainHeightSupported: true,
      async sampleTerrainMostDetailed(positions) {
        record('surface.sampleTerrainMostDetailed', [positions]);
        return scripted('sampleTerrainMostDetailed', [positions], () =>
          positions.map((position) =>
            scripted('terrainHeight', [position], () => 0),
          ),
        );
      },
      clampToHeight(position, exclude) {
        record('surface.clampToHeight', [position, exclude]);
        return scripted('clampToHeight', [position, exclude], () => undefined);
      },
      clampToHeightSupported: true,
      tilesLoaded: () => scripted('tilesLoaded', [], () => true),
    },
    input: {
      acquirePointer: () => pointer.acquire(),
      on(type, listener, inputOptions = {}) {
        record('input.on', [type, inputOptions]);
        const { modifier, pick, drill, pickWindow } = normalizeInputOptions(
          type,
          inputOptions,
        );
        const listeners = inputs.get(type);
        const entry = {
          listener,
          modifier,
          pick,
          drill,
          pickWindow,
          pointer: inputOptions.pointer,
        };
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
      suspendCameraInputs() {
        record('input.suspendCameraInputs', []);
        cameraSuspensions++;
        fake.cameraInputsEnabled = false;
        let resumed = false;
        return () => {
          if (resumed) return;
          resumed = true;
          record('input.resumeCameraInputs', []);
          cameraSuspensions--;
          fake.cameraInputsEnabled = !cameraSuspensions;
        };
      },
      cameraInputsEnabled: () => fake.cameraInputsEnabled,
    },
    credits: {
      addStatic(html, creditOptions = {}) {
        record('credits.addStatic', [html, creditOptions]);
        const credit = { html, onScreen: Boolean(creditOptions.onScreen) };
        fake.credits.push(credit);
        return () => {
          const index = fake.credits.indexOf(credit);
          if (index >= 0) fake.credits.splice(index, 1);
        };
      },
    },
    // The contract's switch order: a call shows its source when made (the
    // fake builds nothing), so the call made last decides what shows.
    maps: {
      errors: events['maps.errors'],
      async setBaseImagery(source) {
        record('maps.setBaseImagery', [source]);
        fake.maps.imagery = source;
        lastBaseImagery = source;
        watchMapErrors(source, 'tile');
      },
      async setTerrain(source) {
        record('maps.setTerrain', [source]);
        // As the real engines: a prebuilt source or a known kind.
        const kind = source?.kind ?? source?.id;
        if (
          typeof source?.create !== 'function' &&
          !TERRAIN_KINDS.includes(kind)
        )
          throw new TypeError(`Unknown terrain source: ${kind}`);
        fake.maps.terrain = source;
        fake.maps.terrainRevision++;
        watchMapErrors(source, 'terrain');
      },
      async setPhotorealTiles(source) {
        record('maps.setPhotorealTiles', [source]);
        if (source == null) {
          fake.maps.photoreal = null;
          fake.maps.imagery = lastBaseImagery;
          watchMapErrors(lastBaseImagery, 'tile');
          return;
        }
        fake.maps.photoreal = source;
        fake.maps.imagery = null;
        watchMapErrors(null, 'tile');
      },
      releasePhotorealTiles(source) {
        record('maps.releasePhotorealTiles', [source]);
        if (fake.maps.photoreal === source) fake.maps.photoreal = null;
      },
      photorealActive: () => fake.maps.photoreal != null,
      current: () => ({
        baseImagery: fake.maps.imagery ?? null,
        photoreal: fake.maps.photoreal,
      }),
      terrainRevision: () => fake.maps.terrainRevision,
    },
    destroy() {
      record('destroy', []);
      for (const remove of Object.values(removeMapErrors)) remove?.();
      follow.destroy();
      cancelCurrentFlight();
      moverRegistry.destroyAll();
      lineRegistry.destroyAll();
      pointer.destroy();
      meshRegistry.destroy();
      groundRegistry.destroyAll();
      imageryRegistry.destroyAll();
      fake.destroyed = true;
    },
    isDestroyed: () => fake.destroyed,
    fake,
  };

  Object.assign(fake, {
    /** Places the camera; angles in radians, missing ones keep the current value. */
    setPose(pose) {
      const position =
        pose.position ??
        cartesian3.fromRadians(
          pose.longitude ?? 0,
          pose.latitude ?? 0,
          pose.height ?? 1e7,
          WGS84,
        );
      apply(
        viewFor(
          position,
          pose.direction ? { direction: pose.direction, up: pose.up } : pose,
          poseAngles(),
        ),
      );
    },
    setSize(nextWidth, nextHeight) {
      const fov =
        width > height
          ? 2 * Math.atan((Math.tan(fovy / 2) * width) / height)
          : fovy;
      width = nextWidth;
      height = nextHeight;
      fovy =
        width > height
          ? 2 * Math.atan((Math.tan(fov / 2) * height) / width)
          : fov;
    },
    callsOf: (method) => fake.calls.filter((call) => call.method === method),
    resetCalls() {
      fake.calls.length = 0;
      fake.renderRequests = 0;
    },
    /** Raises an engine event by path, e.g. 'camera.changed' or 'frames.preRender'. */
    emit(name, ...args) {
      const event = events[name];
      if (!event) throw new TypeError(`Unknown engine event: ${name}`);
      event.raiseEvent(...args);
    },
    /**
     * Delivers input to `engine.input.on(type)` subscribers registered for
     * `modifier` (none by default), as Cesium's ScreenSpaceEventHandler does.
     */
    input(type, event, modifier) {
      const listeners = inputs.get(type);
      if (!listeners) throw new TypeError(`Unknown input type: ${type}`);
      const accepts = pointer.delivery();
      for (const entry of [...listeners]) {
        if (!listeners.has(entry) || !accepts(entry)) continue;
        if (entry.modifier !== modifier) continue;
        if (!entry.pick) {
          entry.listener(event);
          continue;
        }
        // As the engines: the pick under the position (a move's end).
        const at = event.position ?? event.endPosition;
        entry.listener({
          ...event,
          picked: engine.picker.pick(
            at,
            entry.pickWindow?.width,
            entry.pickWindow?.height,
          ),
          ...(entry.drill
            ? {
                drilled: engine.picker.drillPick(
                  at,
                  entry.drill,
                  entry.pickWindow?.width,
                  entry.pickWindow?.height,
                ),
              }
            : {}),
        });
      }
    },
    /** Replaces a result with a value or a function of the call's arguments. */
    script(name, valueOrFunction) {
      if (!SCRIPTABLE.has(name))
        throw new TypeError(`Unknown scripted result: ${name}`);
      scripts.set(name, valueOrFunction);
    },
    unscript(name) {
      scripts.delete(name);
    },
    lookAtTarget: () => (lookAtTarget ? copy3(lookAtTarget) : undefined),
    /** A live line's options, positions, colour, matrix and visibility, by id. */
    line: (id) => fakeLines.get(id),
    /** A live mover set's options, store and commit count, by id. */
    groundSet: (id) => groundRegistry.live.get(id),
    groundPulse(id) {
      return groundRegistry.pulses.get(id);
    },
    moverSet(id) {
      const entry = moverRegistry.sets.get(id);
      return entry
        ? {
            options: entry.options,
            store: entry.store,
            commits: entry.part.commits,
          }
        : undefined;
    },
    /**
     * A live imagery layer's state, by id: { options, source, alpha, shown,
     * split, raise, detail, staging }; `layers()` all of them in draw order.
     */
    mesh: (id) => meshRegistry.live.get(id)?.state,
    imageryLayer(id) {
      const state = imageryRegistry.live.get(id);
      return state
        ? {
            options: state.options,
            source: state.source,
            alpha: state.alpha,
            shown: state.shown,
            split: state.split,
            raise: state.options.raise,
            detail: state.detail,
            staging: state.layer.staging(),
          }
        : undefined;
    },
    imageryLayers: () =>
      imageryRegistry.ordered().map(({ options }) => options.id),
    /** The app clock the engine clock reads (freeze/offset/rate for tests). */
    appClock,
    /** Moves the fake wall clock without a frame (own app clock only). */
    advanceTime(ms) {
      if (ownsWall) wallMs += ms;
    },
    /** Runs one frame: the clock's frame time, preUpdate, flight progress, preRender, camera events, postRender. */
    frame(dt = 16) {
      clock += dt;
      if (ownsWall) wallMs += dt;
      appClock.beginFrame();
      events['frames.preUpdate'].raiseEvent(clock);
      advanceFlight(dt);
      events.followStep.raiseEvent();
      events['frames.preRender'].raiseEvent(clock);
      cameraEvents();
      events['frames.postRender'].raiseEvent(clock);
      // A shown ground set with a pulse or a dash asks for the next frame.
      if (groundRegistry.animating()) fake.renderRequests++;
    },
    frames(count = 1, dt = 16) {
      for (let index = 0; index < count; index++) fake.frame(dt);
    },
  });

  apply(
    viewFor(
      cartesian3.fromRadians(
        options.longitude ?? 0,
        options.latitude ?? 0,
        options.altitude ?? 1e7,
        WGS84,
      ),
      CESIUM_DEFAULTS,
      CESIUM_DEFAULTS,
    ),
  );
  lastFramePose = {
    position: copy3(state.position),
    direction: copy3(state.direction),
    up: copy3(state.up),
  };
  return engine;
}
