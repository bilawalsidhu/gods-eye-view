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

import * as geo from '../../geo/index.js';
import { INPUT_TYPES, MODIFIERS, createEngineEvent } from '../contract.js';

const { cartesian2, cartesian3, cartographic, ellipsoid, math, matrix4 } = geo;
const WGS84 = ellipsoid.WGS84;
const RADII = WGS84.radii;
const MAXIMUM_RADIUS = Math.max(RADII.x, RADII.y, RADII.z);
const DEFAULT_FLIGHT_SECONDS = 3;
const DEFAULT_ZOOM_AMOUNT = 100000; // Cesium's camera.defaultZoomAmount
const MINIMUM_SPHERE_RANGE = 100;
const NEAR = 1;
const FAR = 1e9;
const SCRIPTABLE = new Set([
  'pick',
  'drillPick',
  'pickPosition',
  'pickEllipsoid',
  'viewRectangle',
  'sampleHeight',
  'terrainHeight',
  'clampToHeight',
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

// An angle in [0, 2π), as Cesium's camera reports it.
function wrapAngle(angle) {
  const value = math.zeroToTwoPi(angle);
  return value < 1e-12 || math.TWO_PI - value < 1e-12 ? 0 : value;
}

// The local east/north/up axes at a position, in Earth-fixed coordinates.
function localAxes(position) {
  const frame = geo.transforms.eastNorthUpToFixedFrame(position, WGS84);
  return {
    east: cartesian3.create(frame[0], frame[1], frame[2]),
    north: cartesian3.create(frame[4], frame[5], frame[6]),
    up: cartesian3.create(frame[8], frame[9], frame[10]),
  };
}

const combine = (axes, e, n, u) =>
  sum(scaled(axes.east, e), scaled(axes.north, n), scaled(axes.up, u));
const toLocal = (axes, vector) => ({
  e: cartesian3.dot(vector, axes.east),
  n: cartesian3.dot(vector, axes.north),
  u: cartesian3.dot(vector, axes.up),
});

// Direction and up for a heading/pitch/roll in the local frame at position,
// as Cesium's setView builds them: heading 0 looks north, positive pitch looks
// up, positive roll tilts `up` toward the camera's right.
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
  const levelUp = cross(levelRight, direction);
  const up = sum(
    scaled(levelUp, Math.cos(roll)),
    scaled(levelRight, Math.sin(roll)),
  );
  return { direction: unit(direction), up: unit(up) };
}

// Cesium's Camera heading/pitch/roll getters, in the local frame at position.
function headingPitchRoll(position, direction, up) {
  const axes = localAxes(position);
  const d = toLocal(axes, direction);
  const u = toLocal(axes, up);
  const r = toLocal(axes, cross(direction, up));
  const vertical = Math.abs(Math.abs(d.u) - 1) <= 1e-3;
  const raw = vertical
    ? Math.atan2(u.n, u.e) - math.PI_OVER_TWO
    : Math.atan2(d.n, d.e) - math.PI_OVER_TWO;
  return {
    heading: wrapAngle(math.TWO_PI - math.zeroToTwoPi(raw)),
    pitch: math.PI_OVER_TWO - Math.acos(math.clamp(d.u, -1, 1)),
    roll: vertical ? 0 : wrapAngle(Math.atan2(-r.u, u.u)),
  };
}

// Camera offset from a target for a HeadingPitchRange, in the target's frame.
function offsetFromHeadingPitchRange(heading, pitch, range) {
  const p = math.clamp(pitch, -math.PI_OVER_TWO, math.PI_OVER_TWO);
  const cosPitch = Math.cos(p);
  return cartesian3.create(
    -Math.sin(heading) * cosPitch * range,
    -Math.cos(heading) * cosPitch * range,
    -Math.sin(p) * range,
  );
}

// Nearest intersection of a ray with the WGS84 ellipsoid, if any.
function intersectEllipsoid(origin, direction) {
  const o = [origin.x / RADII.x, origin.y / RADII.y, origin.z / RADII.z];
  const d = [
    direction.x / RADII.x,
    direction.y / RADII.y,
    direction.z / RADII.z,
  ];
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const b = 2 * (o[0] * d[0] + o[1] * d[1] + o[2] * d[2]);
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;
  const root = Math.sqrt(discriminant);
  const near = (-b - root) / (2 * a);
  const t = near > 0 ? near : (-b + root) / (2 * a);
  if (!(t > 0)) return undefined;
  return sum(origin, scaled(direction, t));
}

// Cesium's computeHorizonQuad: four limb points around the camera's nadir.
function horizonQuad(position) {
  const q = cartesian3.create(
    position.x / RADII.x,
    position.y / RADII.y,
    position.z / RADII.z,
  );
  const qMagnitude = cartesian3.magnitude(q);
  const qUnit = unit(q);
  let east;
  let north;
  if (cartesian3.equalsEpsilon(qUnit, cartesian3.UNIT_Z, math.EPSILON10)) {
    east = cartesian3.create(0, 1, 0);
    north = cartesian3.create(0, 0, 1);
  } else {
    east = unit(cross(cartesian3.UNIT_Z, qUnit));
    north = unit(cross(qUnit, east));
  }
  const center = scaled(qUnit, 1 / qMagnitude);
  const offset =
    Math.sqrt(Math.max(0, cartesian3.magnitudeSquared(q) - 1)) / qMagnitude;
  const point = (n, e) => {
    const p = sum(center, scaled(north, n * offset), scaled(east, e * offset));
    return cartesian3.create(p.x * RADII.x, p.y * RADII.y, p.z * RADII.z);
  };
  // Same order as the corner picks: upper-left, lower-left, lower-right, upper-right.
  return [point(1, -1), point(-1, -1), point(-1, 1), point(1, 1)];
}

// Cesium's Rectangle.fromCartographicArray, including the antimeridian case.
function rectangleFromCartographics(points) {
  let west = Infinity;
  let east = -Infinity;
  let westOverIDL = Infinity;
  let eastOverIDL = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const { longitude, latitude } of points) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
    const adjusted = longitude >= 0 ? longitude : longitude + math.TWO_PI;
    westOverIDL = Math.min(westOverIDL, adjusted);
    eastOverIDL = Math.max(eastOverIDL, adjusted);
  }
  if (east - west > eastOverIDL - westOverIDL) {
    west = westOverIDL > Math.PI ? westOverIDL - math.TWO_PI : westOverIDL;
    east = eastOverIDL > Math.PI ? eastOverIDL - math.TWO_PI : eastOverIDL;
  }
  return { west, south, east, north };
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
  let transform = [...matrix4.IDENTITY];
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

  const aspect = () => width / height;
  const right = () => unit(cross(state.direction, state.up));
  const poseAngles = () =>
    headingPitchRoll(state.position, state.direction, state.up);

  // The pose for a destination and orientation; missing angles use `fallback`.
  function viewFor(position, orientation, fallback) {
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

  function lookAtFrame(frame, offset) {
    const local =
      offset && 'heading' in offset
        ? offsetFromHeadingPitchRange(
            offset.heading,
            offset.pitch,
            offset.range,
          )
        : copy3(offset);
    const localDirection = unit(cartesian3.negate(local, cartesian3.create()));
    let localRight = cross(localDirection, cartesian3.UNIT_Z);
    if (cartesian3.magnitudeSquared(localRight) < math.EPSILON10)
      localRight = copy3(cartesian3.UNIT_X);
    localRight = unit(localRight);
    const localUp = unit(cross(localRight, localDirection));
    const vector = (value) =>
      unit(matrix4.multiplyByPointAsVector(frame, value, cartesian3.create()));
    apply({
      position: matrix4.multiplyByPoint(frame, local, cartesian3.create()),
      direction: vector(localDirection),
      up: vector(localUp),
    });
  }

  function cancelCurrentFlight() {
    const current = flight;
    flight = null;
    current?.cancel?.();
  }

  function startFlight(flightOptions, target) {
    cancelCurrentFlight();
    const duration = flightOptions.duration ?? DEFAULT_FLIGHT_SECONDS;
    if (duration <= 0) {
      apply(target);
      flightOptions.complete?.();
      return;
    }
    flight = {
      start: copy3(state.position),
      target,
      duration: duration * 1000,
      elapsed: 0,
      ease: EASINGS[flightOptions.easing] ?? EASINGS.cubicInOut,
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
    apply(current.target);
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
    const ndcX = cartesian3.dot(offset, right()) / (depth * tangent * aspect());
    const ndcY = cartesian3.dot(offset, state.up) / (depth * tangent);
    const x = ((ndcX + 1) / 2) * width;
    const y = ((1 - ndcY) / 2) * height;
    if (!result) return cartesian2.create(x, y);
    result.x = x;
    result.y = y;
    return result;
  }

  function viewProjection(result = matrix4.create()) {
    const f = 1 / Math.tan(fovy / 2);
    const rows = [
      [right(), f / aspect()],
      [state.up, f],
    ];
    const D = state.direction;
    const P = state.position;
    for (const [row, [axis, scale]] of rows.entries()) {
      result[row] = axis.x * scale;
      result[4 + row] = axis.y * scale;
      result[8 + row] = axis.z * scale;
      result[12 + row] = -cartesian3.dot(axis, P) * scale;
    }
    // Eye z is −direction·(p − position); clip.w = −z_eye.
    const A = (FAR + NEAR) / (NEAR - FAR);
    const B = (2 * FAR * NEAR) / (NEAR - FAR);
    result[2] = -D.x * A;
    result[6] = -D.y * A;
    result[10] = -D.z * A;
    result[14] = cartesian3.dot(D, P) * A + B;
    result[3] = D.x;
    result[7] = D.y;
    result[11] = D.z;
    result[15] = -cartesian3.dot(D, P);
    return result;
  }

  // Cesium's EllipsoidalOccluder.isPointVisible.
  function horizonVisible(position) {
    const camera = cartesian3.create(
      state.position.x / RADII.x,
      state.position.y / RADII.y,
      state.position.z / RADII.z,
    );
    const limbSquared = cartesian3.magnitudeSquared(camera) - 1;
    const target = cartesian3.create(
      position.x / RADII.x,
      position.y / RADII.y,
      position.z / RADII.z,
    );
    const vt = cartesian3.subtract(target, camera, cartesian3.create());
    const vtDotVc = -cartesian3.dot(vt, camera);
    const occluded =
      limbSquared < 0
        ? vtDotVc > 0
        : vtDotVc > limbSquared &&
          (vtDotVc * vtDotVc) / cartesian3.magnitudeSquared(vt) > limbSquared;
    return !occluded;
  }

  function ray(screen) {
    const tangent = Math.tan(fovy / 2);
    const ndcX = (2 * screen.x) / width - 1;
    const ndcY = 1 - (2 * screen.y) / height;
    const direction = sum(
      state.direction,
      scaled(right(), ndcX * tangent * aspect()),
      scaled(state.up, ndcY * tangent),
    );
    return { origin: copy3(state.position), direction: unit(direction) };
  }

  // Whether the sphere around the Earth is fully outside the view frustum.
  function globeOutsideFrustum() {
    const toCentre = cartesian3.negate(state.position, cartesian3.create());
    const D = state.direction;
    const tanY = Math.tan(fovy / 2);
    const tanX = tanY * aspect();
    const R = right();
    const U = state.up;
    const planes = [
      [D, NEAR],
      [unit(sum(scaled(R, -1), scaled(D, tanX))), 0],
      [unit(sum(R, scaled(D, tanX))), 0],
      [unit(sum(scaled(U, -1), scaled(D, tanY))), 0],
      [unit(sum(U, scaled(D, tanY))), 0],
    ];
    return planes.some(
      ([normal, offset]) =>
        cartesian3.dot(normal, toCentre) - offset < -MAXIMUM_RADIUS,
    );
  }

  // Cesium's Camera.computeViewRectangle.
  function computedViewRectangle() {
    if (globeOutsideFrustum()) return undefined;
    const horizon = horizonQuad(state.position);
    let hits = 0;
    const points = [
      [0, 0],
      [0, height],
      [width, height],
      [width, 0],
    ].map(([x, y], index) => {
      const hit = intersectEllipsoid(
        state.position,
        ray(cartesian2.create(x, y)).direction,
      );
      if (hit) hits++;
      return cartographic.fromCartesian(hit ?? horizon[index], WGS84);
    });
    if (hits < 2)
      return {
        west: -Math.PI,
        south: -math.PI_OVER_TWO,
        east: Math.PI,
        north: math.PI_OVER_TWO,
      };
    const rectangle = rectangleFromCartographics(points);
    let travelled = 0;
    let last = points[3].longitude;
    for (const { longitude } of points) {
      const step = Math.abs(longitude - last);
      travelled += step > Math.PI ? math.TWO_PI - step : step;
      last = longitude;
    }
    if (math.equalsEpsilon(Math.abs(travelled), math.TWO_PI, 1e-9)) {
      rectangle.west = -Math.PI;
      rectangle.east = Math.PI;
      if (points[0].latitude >= 0) rectangle.north = math.PI_OVER_TWO;
      else rectangle.south = -math.PI_OVER_TWO;
    }
    return rectangle;
  }

  function scripted(name, args, fallback) {
    if (!scripts.has(name)) return fallback();
    const value = scripts.get(name);
    return typeof value === 'function' ? value(...args) : value;
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
      apply(viewFor(view.destination, view.orientation, CESIUM_DEFAULTS));
    },
    flyTo(flightOptions) {
      record('camera.flyTo', [flightOptions]);
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
      record('camera.flyToSphere', [sphere, sphereOptions]);
      setTransform(matrix4.IDENTITY);
      let range = sphereOptions.range;
      if (!range) {
        const tanPhi = Math.tan(fovy / 2);
        const tanTheta = aspect() * tanPhi;
        range = Math.max(
          MINIMUM_SPHERE_RANGE,
          Math.max(sphere.radius / tanTheta, sphere.radius / tanPhi),
        );
      }
      const frame = geo.transforms.eastNorthUpToFixedFrame(
        sphere.center,
        WGS84,
      );
      const saved = {
        position: state.position,
        direction: state.direction,
        up: state.up,
      };
      lookAtFrame(frame, {
        heading: sphereOptions.heading ?? 0,
        pitch: sphereOptions.pitch ?? -Math.PI / 4,
        range,
      });
      const target = {
        position: state.position,
        direction: state.direction,
        up: state.up,
      };
      apply(saved);
      startFlight(sphereOptions, target);
    },
    flightActive: () => flight != null,
    lookAt(target, offset) {
      record('camera.lookAt', [target, offset]);
      const frame = geo.transforms.eastNorthUpToFixedFrame(target, WGS84);
      setTransform(frame, target);
      lookAtFrame(frame, offset);
    },
    lookAtTransform(frame, offset) {
      record('camera.lookAtTransform', [frame, offset]);
      setTransform(frame, cartesian3.create(frame[12], frame[13], frame[14]));
      if (offset) lookAtFrame(frame, offset);
    },
    transform: () => [...transform],
    release() {
      record('camera.release', []);
      setTransform(matrix4.IDENTITY);
    },
    cancelFlight() {
      record('camera.cancelFlight', []);
      cancelCurrentFlight();
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
      viewProjection,
      horizonVisible,
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
      terrainHeight(position) {
        record('surface.terrainHeight', [position]);
        return scripted('terrainHeight', [position], () => 0);
      },
      terrainHeightSupported: true,
      clampToHeight(position, exclude) {
        record('surface.clampToHeight', [position, exclude]);
        return scripted('clampToHeight', [position, exclude], () => undefined);
      },
      clampToHeightSupported: true,
      tilesLoaded: () => scripted('tilesLoaded', [], () => true),
    },
    input: {
      on(type, listener, inputOptions = {}) {
        record('input.on', [type, inputOptions]);
        const listeners = inputs.get(type);
        if (!listeners) throw new TypeError(`Unknown input type: ${type}`);
        const modifier = inputOptions.modifier;
        if (modifier !== undefined && !MODIFIERS.includes(modifier))
          throw new TypeError(`Unknown input modifier: ${modifier}`);
        const entry = { listener, modifier };
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
      apply(
        viewFor(
          position,
          pose.direction ? { direction: pose.direction, up: pose.up } : pose,
          poseAngles(),
        ),
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
    /**
     * Delivers input to `engine.input.on(type)` subscribers registered for
     * `modifier` (none by default), as Cesium's ScreenSpaceEventHandler does.
     */
    input(type, event, modifier) {
      const listeners = inputs.get(type);
      if (!listeners) throw new TypeError(`Unknown input type: ${type}`);
      for (const entry of [...listeners])
        if (entry.modifier === modifier) entry.listener(event);
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
  };
  return engine;
}
