// A GlobeEngine built on src/geo alone, for tests of shell modules. It keeps a
// controllable perspective camera on the WGS84 ellipsoid, projects and picks
// against it, records every contract call and lets tests emit events, drive
// input, advance frames and script pick/height/projection results through
// `engine.fake`. It passes src/globe/testing/contractSuite.mjs.

import * as geo from '../../geo/index.js';
import { INPUT_TYPES, createEngineEvent } from '../contract.js';

const { cartesian2, cartesian3, cartographic, ellipsoid, math, matrix4 } = geo;
const WGS84 = ellipsoid.WGS84;
const SCRIPTABLE = new Set([
  'pick',
  'drillPick',
  'pickPosition',
  'pickEllipsoid',
  'viewRectangle',
  'sampleHeight',
  'tilesLoaded',
  'worldToWindow',
]);
const EASINGS = {
  linear: (t) => t,
  cubicInOut: (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  sinusoidalInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
};

const copy3 = (value) => cartesian3.create(value.x, value.y, value.z);

// The local east/north/up axes at a position, in Earth-fixed coordinates.
function localAxes(position) {
  const frame = matrix4.create();
  geo.transforms.eastNorthUpToFixedFrame(position, WGS84, frame);
  return {
    east: cartesian3.create(frame[0], frame[1], frame[2]),
    north: cartesian3.create(frame[4], frame[5], frame[6]),
    up: cartesian3.create(frame[8], frame[9], frame[10]),
  };
}

const combine = (axes, e, n, u) =>
  cartesian3.create(
    axes.east.x * e + axes.north.x * n + axes.up.x * u,
    axes.east.y * e + axes.north.y * n + axes.up.y * u,
    axes.east.z * e + axes.north.z * n + axes.up.z * u,
  );

// Direction and up for a heading/pitch/roll in the local frame at position.
// Heading 0 looks north, positive pitch looks up, as in Cesium.
function orientationVectors(position, heading, pitch, roll) {
  const axes = localAxes(position);
  const cosPitch = Math.cos(pitch);
  const direction = combine(
    axes,
    Math.sin(heading) * cosPitch,
    Math.cos(heading) * cosPitch,
    Math.sin(pitch),
  );
  const levelRight = combine(axes, Math.cos(heading), -Math.sin(heading), 0);
  const levelUp = cartesian3.cross(levelRight, direction, cartesian3.create());
  const up = cartesian3.create();
  cartesian3.add(
    cartesian3.multiplyByScalar(levelUp, Math.cos(roll), cartesian3.create()),
    cartesian3.multiplyByScalar(
      levelRight,
      -Math.sin(roll),
      cartesian3.create(),
    ),
    up,
  );
  return { direction, up: cartesian3.normalize(up, up) };
}

function headingPitchRoll(position, direction, up) {
  const axes = localAxes(position);
  const e = cartesian3.dot(direction, axes.east);
  const n = cartesian3.dot(direction, axes.north);
  const u = cartesian3.dot(direction, axes.up);
  const pitch = Math.asin(math.clamp(u, -1, 1));
  // Looking straight up or down, heading follows the camera's up vector.
  const heading =
    Math.hypot(e, n) > 1e-9
      ? math.zeroToTwoPi(Math.atan2(e, n))
      : math.zeroToTwoPi(
          Math.atan2(
            cartesian3.dot(up, axes.east) * -Math.sign(u),
            cartesian3.dot(up, axes.north) * -Math.sign(u),
          ),
        );
  const level = orientationVectors(position, heading, pitch, 0);
  const levelRight = cartesian3.cross(
    level.direction,
    level.up,
    cartesian3.create(),
  );
  const roll = Math.atan2(
    -cartesian3.dot(up, levelRight),
    cartesian3.dot(up, level.up),
  );
  return { heading, pitch, roll: Math.abs(roll) < 1e-12 ? 0 : roll };
}

// Nearest intersection of a ray with the WGS84 ellipsoid, if any.
function intersectEllipsoid(origin, direction) {
  const r = WGS84.radii;
  const o = [origin.x / r.x, origin.y / r.y, origin.z / r.z];
  const d = [direction.x / r.x, direction.y / r.y, direction.z / r.z];
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
 * @param {{ kind?: 'cesium'|'navara', width?: number, height?: number, fovy?: number,
 *   longitude?: number, latitude?: number, altitude?: number }} [options]
 *   Canvas size in CSS px, angles in radians. The initial pose looks straight
 *   down from `altitude` metres (10 000 km).
 * @returns {import('../contract.js').GlobeEngine & { fake: object }}
 */
export function createFakeEngine(options = {}) {
  let width = options.width ?? 1024;
  let height = options.height ?? 768;
  // Cesium's default: 60 degrees across the wider canvas dimension.
  const fovy =
    options.fovy ??
    (width > height
      ? 2 * Math.atan(Math.tan(Math.PI / 6) * (height / width))
      : Math.PI / 3);
  const state = {
    position: cartesian3.create(),
    direction: cartesian3.create(),
    up: cartesian3.create(),
  };
  const events = {
    'camera.changed': createEngineEvent(),
    'camera.moveStart': createEngineEvent(),
    'camera.moveEnd': createEngineEvent(),
    'frames.preUpdate': createEngineEvent(),
    'frames.preRender': createEngineEvent(),
    'frames.postRender': createEngineEvent(),
  };
  const inputs = new Map(INPUT_TYPES.map((type) => [type, new Set()]));
  const scripts = new Map();
  let percentageChanged = 0.5;
  let continuous = false;
  let flight = null;
  let lookAtTarget = null;
  let clock = 0;
  let moving = false;
  let lastFramePose = null;
  let lastChangedPose = null;

  const fake = {
    calls: [],
    renderRequests: 0,
    cameraInputsEnabled: true,
    credits: [],
    maps: { imagery: undefined, terrain: undefined, photoreal: null },
    destroyed: false,
  };
  const record = (method, args) => fake.calls.push({ method, args });

  function setOrientation(position, orientation) {
    if (orientation && 'direction' in orientation) {
      state.position = copy3(position);
      state.direction = cartesian3.normalize(
        orientation.direction,
        cartesian3.create(),
      );
      state.up = cartesian3.normalize(orientation.up, cartesian3.create());
      return;
    }
    // Missing angles keep the current ones, measured where the camera is now.
    const current = poseAngles();
    state.position = copy3(position);
    const vectors = orientationVectors(
      state.position,
      orientation?.heading ?? current.heading,
      orientation?.pitch ?? current.pitch,
      orientation?.roll ?? current.roll,
    );
    state.direction = vectors.direction;
    state.up = vectors.up;
  }

  function poseAngles() {
    if (cartesian3.magnitudeSquared(state.direction) === 0)
      return { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 };
    return headingPitchRoll(state.position, state.direction, state.up);
  }

  function right() {
    const result = cartesian3.cross(
      state.direction,
      state.up,
      cartesian3.create(),
    );
    return cartesian3.normalize(result, result);
  }

  // Camera placed at `range` from target, looking at it, with heading/pitch
  // measured in the target's local frame (Cesium's HeadingPitchRange).
  function offsetView(target, heading, pitch, range) {
    const toTarget = orientationVectors(target, heading, pitch, 0);
    const position = cartesian3.subtract(
      target,
      cartesian3.multiplyByScalar(
        toTarget.direction,
        range,
        cartesian3.create(),
      ),
      cartesian3.create(),
    );
    return { position, direction: toTarget.direction, up: toTarget.up };
  }

  function scripted(name, args, fallback) {
    if (!scripts.has(name)) return fallback();
    const value = scripts.get(name);
    return typeof value === 'function' ? value(...args) : value;
  }

  function startFlight(options, target) {
    if (flight) cancelCurrentFlight();
    const duration = Math.max(0, options.duration ?? 3);
    flight = {
      start: copy3(state.position),
      target,
      duration: duration * 1000,
      elapsed: 0,
      ease: EASINGS[options.easing] ?? EASINGS.cubicInOut,
      complete: options.complete,
      cancel: options.cancel,
    };
    if (duration === 0) applyFlightTarget(flight.target);
  }

  function applyFlightTarget(target) {
    state.position = copy3(target.position);
    state.direction = copy3(target.direction);
    state.up = copy3(target.up);
  }

  function cancelCurrentFlight() {
    const current = flight;
    flight = null;
    current?.cancel?.();
  }

  function advanceFlight(dt) {
    if (!flight) return;
    flight.elapsed += dt;
    const t = flight.duration
      ? Math.min(1, flight.elapsed / flight.duration)
      : 1;
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
    applyFlightTarget(current.target);
    current.complete?.();
  }

  function cameraEvents() {
    const pose = {
      position: copy3(state.position),
      direction: copy3(state.direction),
    };
    const differs = (a, b) =>
      !b ||
      !cartesian3.equalsEpsilon(a.position, b.position, 0, 1e-9) ||
      !cartesian3.equalsEpsilon(a.direction, b.direction, 0, 1e-12);
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
    const amount = Math.max(turn, shift);
    if (amount > percentageChanged) {
      lastChangedPose = pose;
      events['camera.changed'].raiseEvent(amount);
    }
  }

  function project(position, result) {
    const offset = cartesian3.subtract(
      position,
      state.position,
      cartesian3.create(),
    );
    const depth = cartesian3.dot(offset, state.direction);
    if (!(depth > 0)) return undefined;
    const tangent = Math.tan(fovy / 2);
    const ndcX =
      cartesian3.dot(offset, right()) / (depth * tangent * (width / height));
    const ndcY = cartesian3.dot(offset, state.up) / (depth * tangent);
    const x = ((ndcX + 1) / 2) * width;
    const y = ((1 - ndcY) / 2) * height;
    if (!result) return cartesian2.create(x, y);
    result.x = x;
    result.y = y;
    return result;
  }

  function ray(screen) {
    const tangent = Math.tan(fovy / 2);
    const ndcX = (2 * screen.x) / width - 1;
    const ndcY = 1 - (2 * screen.y) / height;
    const direction = combine(
      { east: right(), north: state.up, up: state.direction },
      ndcX * tangent * (width / height),
      ndcY * tangent,
      1,
    );
    return {
      origin: copy3(state.position),
      direction: cartesian3.normalize(direction, direction),
    };
  }

  function computedViewRectangle() {
    const corners = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
      [width / 2, 0],
      [width / 2, height],
      [0, height / 2],
      [width, height / 2],
    ].map(([x, y]) =>
      intersectEllipsoid(
        state.position,
        ray(cartesian2.create(x, y)).direction,
      ),
    );
    if (corners.some((corner) => !corner)) return undefined;
    const points = corners.map((corner) =>
      cartographic.fromCartesian(corner, WGS84),
    );
    return {
      west: Math.min(...points.map((point) => point.longitude)),
      south: Math.min(...points.map((point) => point.latitude)),
      east: Math.max(...points.map((point) => point.longitude)),
      north: Math.max(...points.map((point) => point.latitude)),
    };
  }

  const camera = {
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
      };
    },
    setView(view) {
      record('camera.setView', [view]);
      if (!view?.destination)
        throw new TypeError('setView needs a destination');
      setOrientation(view.destination, view.orientation);
    },
    flyTo(flightOptions) {
      record('camera.flyTo', [flightOptions]);
      if (!flightOptions?.destination)
        throw new TypeError('flyTo needs a destination');
      const saved = {
        position: state.position,
        direction: state.direction,
        up: state.up,
      };
      setOrientation(flightOptions.destination, flightOptions.orientation);
      const target = {
        position: state.position,
        direction: state.direction,
        up: state.up,
      };
      Object.assign(state, saved);
      startFlight(flightOptions, target);
    },
    flyToSphere(sphere, sphereOptions = {}) {
      record('camera.flyToSphere', [sphere, sphereOptions]);
      const range =
        sphereOptions.range ??
        Math.max(sphere.radius / Math.sin(fovy / 2), 100);
      const target = offsetView(
        sphere.center,
        sphereOptions.heading ?? 0,
        sphereOptions.pitch ?? -0.5,
        range,
      );
      startFlight(sphereOptions, target);
    },
    lookAt(target, offset) {
      record('camera.lookAt', [target, offset]);
      lookAtTarget = copy3(target);
      applyFlightTarget(
        offsetView(target, offset.heading, offset.pitch, offset.range),
      );
    },
    release() {
      record('camera.release', []);
      lookAtTarget = null;
    },
    cancelFlight() {
      record('camera.cancelFlight', []);
      cancelCurrentFlight();
    },
    viewRectangle() {
      record('camera.viewRectangle', []);
      return scripted('viewRectangle', [], computedViewRectangle);
    },
    pickEllipsoid(screen) {
      return scripted('pickEllipsoid', [screen], () =>
        intersectEllipsoid(state.position, ray(screen).direction),
      );
    },
    pickRay(screen) {
      return ray(screen);
    },
    changed: events['camera.changed'],
    moveStart: events['camera.moveStart'],
    moveEnd: events['camera.moveEnd'],
    get percentageChanged() {
      return percentageChanged;
    },
    set percentageChanged(value) {
      percentageChanged = value;
    },
  };

  const host = {
    container: { kind: 'fake-container' },
    canvas: { kind: 'fake-canvas' },
    size: () => ({ width, height }),
  };

  const engine = {
    kind: options.kind ?? 'cesium',
    host,
    camera,
    picker: {
      pick(screen, w, h) {
        record('picker.pick', [screen, w, h]);
        return scripted('pick', [screen, w, h], () => undefined);
      },
      drillPick(screen, limit) {
        record('picker.drillPick', [screen, limit]);
        return scripted('drillPick', [screen, limit], () => []);
      },
      pickPosition(screen) {
        record('picker.pickPosition', [screen]);
        return scripted('pickPosition', [screen], () =>
          camera.pickEllipsoid(screen),
        );
      },
      pickPositionSupported: true,
    },
    projector: {
      worldToWindow(position, result) {
        const value = scripted('worldToWindow', [position, result], () =>
          project(position, result),
        );
        if (value && result && value !== result)
          return cartesian2.clone(value, result);
        return value;
      },
    },
    frames: {
      preUpdate: events['frames.preUpdate'],
      preRender: events['frames.preRender'],
      postRender: events['frames.postRender'],
    },
    render: {
      request() {
        record('render.request', []);
        fake.renderRequests++;
      },
      setContinuous(enabled) {
        record('render.setContinuous', [enabled]);
        continuous = Boolean(enabled);
      },
      isContinuous: () => continuous,
    },
    surface: {
      sampleHeight(position, exclude) {
        record('surface.sampleHeight', [position, exclude]);
        return scripted('sampleHeight', [position, exclude], () => undefined);
      },
      supported: true,
      tilesLoaded: () => scripted('tilesLoaded', [], () => true),
    },
    input: {
      on(type, listener) {
        record('input.on', [type]);
        const listeners = inputs.get(type);
        if (!listeners) throw new TypeError(`Unknown input type: ${type}`);
        const entry = (event) => listener(event);
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
      setCameraInputs(enabled) {
        record('input.setCameraInputs', [enabled]);
        fake.cameraInputsEnabled = Boolean(enabled);
      },
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
    maps: {
      setBaseImagery(source) {
        record('maps.setBaseImagery', [source]);
        fake.maps.imagery = source;
      },
      setTerrain(source) {
        record('maps.setTerrain', [source]);
        fake.maps.terrain = source;
      },
      setPhotorealTiles(source) {
        record('maps.setPhotorealTiles', [source]);
        fake.maps.photoreal = source ?? null;
      },
      photorealActive: () => fake.maps.photoreal != null,
    },
    destroy() {
      record('destroy', []);
      cancelCurrentFlight();
      fake.destroyed = true;
    },
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
      setOrientation(
        position,
        pose.direction
          ? { direction: pose.direction, up: pose.up }
          : { heading: pose.heading, pitch: pose.pitch, roll: pose.roll },
      );
    },
    setSize(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
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
    /** Delivers an input event to `engine.input.on(type)` subscribers. */
    input(type, event) {
      const listeners = inputs.get(type);
      if (!listeners) throw new TypeError(`Unknown input type: ${type}`);
      for (const listener of [...listeners]) listener(event);
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
    flying: () => flight != null,
    lookAtTarget: () => (lookAtTarget ? copy3(lookAtTarget) : undefined),
    /** Runs one frame: preUpdate, flight progress, preRender, camera events, postRender. */
    frame(dt = 16) {
      clock += dt;
      events['frames.preUpdate'].raiseEvent(clock);
      advanceFlight(dt);
      events['frames.preRender'].raiseEvent(clock);
      cameraEvents();
      events['frames.postRender'].raiseEvent(clock);
    },
    frames(count = 1, dt = 16) {
      for (let index = 0; index < count; index++) fake.frame(dt);
    },
  });

  fake.setPose({
    longitude: options.longitude ?? 0,
    latitude: options.latitude ?? 0,
    height: options.altitude ?? 1e7,
    heading: 0,
    pitch: -math.PI_OVER_TWO,
    roll: 0,
  });
  lastFramePose = {
    position: copy3(state.position),
    direction: copy3(state.direction),
  };
  return engine;
}
