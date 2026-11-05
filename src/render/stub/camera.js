/**
 * @module render/stub/camera
 * @description The stub renderer's camera: exact poses for every camera
 * command of the contract, flights on the stub's clock, follows, holds and
 * events. It keeps the eye in a frame (the world, or a `lookAt` target's
 * east-north-up frame) the way the default renderer does, so commands made
 * in a target's frame behave the same.
 */
import {
  EPSILON10,
  IDENTITY,
  PI_OVER_TWO,
  TWO_PI,
  acosClamped,
  add,
  clone,
  cross,
  distance,
  dot,
  eastNorthUp,
  fromRadians,
  framePoint,
  frameVector,
  geodeticSurfaceNormal,
  headingOf,
  headingPitchRollColumns,
  inverseFramePoint,
  inverseFrameVector,
  isIdentity,
  negativePiToPi,
  magnitude,
  negate,
  normalize,
  offsetFromHeadingPitchRange,
  pitchOf,
  rollOf,
  rotate,
  scale,
  sub,
  toCartographicRadians,
  toDegrees,
  toEcef,
  toRadians,
  vec,
  zeroToTwoPi,
} from './math.js';
import { geodesicAt } from './geodesic.js';

const DEFAULT_FOV = Math.PI / 3;
const MOVE_END_WAIT_MS = 500;
const MINIMUM_ZOOM = 100;
const DEFAULT_SPHERE_OFFSET = Object.freeze({
  heading: 0,
  pitch: -Math.PI / 4,
  range: 0,
});

const EASINGS = {
  linear: (t) => t,
  quadraticInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  quinticInOut: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
  cubicOut: (t) => (t - 1) ** 3 + 1,
};

/** Above this height, a descending flight eases out rather than in and out. */
const DESCENT_EASE_HEIGHT = 11500;
const ONE_DEGREE = Math.PI / 180;

/**
 * @param {object} options
 * @param {() => {width: number, height: number}} options.viewport CSS size.
 * @param {() => number} options.now The stub's clock, ms.
 * @param {() => number} options.sceneTime Scene time, epoch ms.
 * @param {(reason: string) => void} options.requestRender
 * @param {(error: Error) => void} options.report
 */
export function createStubCamera({
  viewport,
  now,
  sceneTime,
  requestRender,
  report,
  drawnPosition = () => null,
}) {
  // Local frame values; world values are `frame` applied to them.
  let frame = IDENTITY;
  let position = vec(0, 0, 0);
  let direction = vec(0, 0, -1);
  let up = vec(0, 1, 0);
  let right = vec(1, 0, 0);
  let fovy = null;
  let fov = DEFAULT_FOV;
  const near = 1;
  const far = 5e8;

  const listeners = {
    changed: [],
    moveStart: [],
    moveEnd: [],
    followChanged: [],
    flightEnd: [],
  };
  const commandHooks = [];
  const holds = new Map();
  let holdSeq = 0;
  let flight = null;
  let followed = null;
  let followFramed = false;
  let lastPose = null;
  let moving = false;
  let lastMovedAt = 0;

  let coast = Object.freeze({ drag: 0.4, zoom: 0.2 });
  const controls = {
    get enabled() {
      return holds.size === 0;
    },
    suspend(reason) {
      const key = ++holdSeq;
      holds.set(key, reason);
      return () => holds.delete(key);
    },
    enableTilt: true,
    enableRotate: true,
    enableZoom: true,
    minDistance: 1,
    maxDistance: Infinity,
    // The default renderer's inertia as decay times: its speed falls as
    // exp(-25 (1 - c) t), so c = 0.9 (spin, which drags and tilts in 3D)
    // is 0.4 s and c = 0.8 (zoom) 0.2 s. Back: c = coast > 0 ? 1 - 1 / (25 coast) : 1.
    get coast() {
      return coast;
    },
    set coast(value) {
      for (const key of ['drag', 'zoom'])
        if (!(Number.isFinite(value?.[key]) && value[key] >= 0))
          throw new TypeError(`coast.${key} must be seconds, 0 or more`);
      coast = Object.freeze({ drag: value.drag, zoom: value.zoom });
    },
    collision: 'none',
    zoomFactor: 5,
    pitchRange: [-Math.PI / 2, 0],
    zoomInputs: ['wheel', 'pinch', 'rightDrag'],
  };

  function aspectRatio() {
    const { width, height } = viewport();
    return width / height;
  }

  function verticalFov() {
    if (fovy !== null) return fovy;
    const aspect = aspectRatio();
    return aspect <= 1 ? fov : 2 * Math.atan(Math.tan(fov * 0.5) / aspect);
  }

  const positionWC = () => framePoint(frame, position);
  const directionWC = () => normalize(frameVector(frame, direction));
  const upWC = () => normalize(frameVector(frame, up));
  const rightWC = () => normalize(frameVector(frame, right));

  /** Move into a new frame, keeping the world pose. */
  function setFrame(next) {
    const p = positionWC();
    const d = directionWC();
    const u = upWC();
    frame = next;
    position = inverseFramePoint(frame, p);
    direction = inverseFrameVector(frame, d);
    up = inverseFrameVector(frame, u);
    right = cross(direction, up);
  }

  /** Heading, pitch and roll in the east-north-up frame at the eye. */
  function eyeAngles() {
    return directionUpToAngles(positionWC(), {
      direction: directionWC(),
      up: upWC(),
    });
  }

  function pose() {
    const p = positionWC();
    const c = toCartographicRadians(p) ?? { lon: 0, lat: 0, height: 0 };
    const a = eyeAngles();
    return {
      lon: toDegrees(c.lon),
      lat: toDegrees(c.lat),
      height: c.height,
      heading: a.heading,
      pitch: a.pitch,
      roll: a.roll,
      position: p,
      direction: directionWC(),
      up: upWC(),
      right: rightWC(),
      fovy: verticalFov(),
      aspectRatio: aspectRatio(),
      near,
      far,
      frameIsIdentity: isIdentity(frame),
    };
  }

  function command(kind) {
    for (const hook of commandHooks.slice()) {
      if (!commandHooks.includes(hook)) continue;
      try {
        hook({ kind });
      } catch (error) {
        report(error);
      }
    }
  }

  /** Place the eye at `destination` (world) with `orientation` in its east-north-up frame. */
  function placeAt(destination, hpr) {
    const kept = frame;
    const enu = eastNorthUp(destination);
    frame = enu;
    position = vec(0, 0, 0);
    const columns = headingPitchRollColumns(hpr.heading, hpr.pitch, hpr.roll);
    direction = columns.direction;
    up = columns.up;
    right = cross(direction, up);
    setFrame(kept);
  }

  /** Orientation given as direction and up, as angles at `destination`. */
  function directionUpToAngles(destination, orientation) {
    const enu = eastNorthUp(destination);
    const d = inverseFrameVector(enu, orientation.direction);
    const u = inverseFrameVector(enu, orientation.up);
    const r = cross(d, u);
    return {
      heading: headingOf(d, u),
      pitch: pitchOf(d),
      roll: rollOf(d, u, r),
    };
  }

  function resolveOrientation(destination, orientation = {}) {
    if (orientation && 'direction' in orientation)
      return directionUpToAngles(destination, orientation);
    return {
      heading: orientation?.heading ?? 0,
      pitch: orientation?.pitch ?? -PI_OVER_TWO,
      roll: orientation?.roll ?? 0,
    };
  }

  /**
   * The eye over a rectangle that keeps all of it in view, as the default
   * renderer frames one: over the geodesic midpoint of its central meridian,
   * far enough for its corners, edge centres and (across the equator) its
   * equator points.
   */
  function rectangleDestination(rect) {
    const { north, south, west } = {
      north: toRadians(rect.north),
      south: toRadians(rect.south),
      west: toRadians(rect.west),
    };
    let east = toRadians(rect.east);
    if (west > east) east += TWO_PI;
    const lon = (west + east) * 0.5;
    const lat =
      south < -PI_OVER_TWO + ONE_DEGREE && north > PI_OVER_TWO - ONE_DEGREE
        ? 0
        : geodesicAt(lon, north, lon, south, 0.5).lat;
    const center = fromRadians(lon, lat, 0);
    const dir = negate(geodeticSurfaceNormal(center));
    const r = normalize(cross(dir, vec(0, 0, 1)));
    const u = cross(r, dir);
    const tanPhi = Math.tan(verticalFov() * 0.5);
    const tanTheta = aspectRatio() * tanPhi;
    const points = [
      [west, north],
      [east, south],
      [east, north],
      [west, south],
      [lon, north],
      [lon, south],
    ];
    if (south < 0 && north > 0) points.push([west, 0], [east, 0]);
    let d = -Infinity;
    for (const [pointLon, pointLat] of points) {
      const corner = sub(fromRadians(pointLon, pointLat, 0), center);
      d = Math.max(
        d,
        Math.abs(dot(u, corner)) / tanPhi - dot(dir, corner),
        Math.abs(dot(r, corner)) / tanTheta - dot(dir, corner),
      );
    }
    return add(center, scale(dir, -d));
  }

  function resolveDestination(destination, orientation) {
    const target =
      destination && 'rect' in destination
        ? rectangleDestination(destination.rect)
        : destination
          ? toEcef(destination)
          : positionWC();
    return {
      destination: target,
      angles: resolveOrientation(target, orientation),
    };
  }

  function setView({ destination, orientation } = {}) {
    command('setView');
    const resolved = resolveDestination(destination, orientation);
    placeAt(resolved.destination, resolved.angles);
    requestRender('camera');
  }

  function lookAtFrame(targetFrame, offset) {
    setFrame(targetFrame);
    position = offset;
    direction = normalize(negate(position));
    right = cross(direction, vec(0, 0, 1));
    if (dot(right, right) < EPSILON10) right = vec(1, 0, 0);
    right = normalize(right);
    up = normalize(cross(right, direction));
  }

  function lookAt(target, offset) {
    command('lookAt');
    lookAtFrame(
      eastNorthUp(target),
      offsetFromHeadingPitchRange(offset.heading, offset.pitch, offset.range),
    );
    requestRender('camera');
  }

  function release() {
    command('release');
    setFrame(IDENTITY);
    requestRender('camera');
  }

  function finishFlight(outcome) {
    const f = flight;
    if (!f) return;
    flight = null;
    f.releaseHold();
    const cb = outcome === 'complete' ? f.onComplete : f.onCancel;
    try {
      cb?.();
    } catch (error) {
      report(error);
    }
    f.resolve(outcome);
    emit('flightEnd');
  }

  /**
   * Whether the eye already stands at `destination` with `target` angles;
   * like the reference camera, by its position in its current frame.
   */
  function alreadyThere(destination, target) {
    const p = position;
    const a = eyeAngles();
    const close = (x, y) =>
      Math.abs(x - y) <= EPSILON10 * Math.max(1, Math.abs(x), Math.abs(y));
    const sameAngle = (x, y) => close(negativePiToPi(x), negativePiToPi(y));
    return (
      close(p.x, destination.x) &&
      close(p.y, destination.y) &&
      close(p.z, destination.z) &&
      sameAngle(a.heading, target.heading) &&
      sameAngle(a.pitch, target.pitch) &&
      sameAngle(a.roll, target.roll)
    );
  }

  /**
   * A flight that ends inside the call, as the reference camera's does: a
   * duration of 0 or less lands at once, and one already at its destination
   * completes without moving.
   */
  function instantFlight(destination, angles, durationS, options) {
    if (durationS !== undefined && durationS <= 0) {
      placeAt(destination, angles);
      requestRender('camera');
    } else if (!alreadyThere(destination, angles)) return null;
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const handle = { done, cancel: () => {} };
    flight = {
      handle,
      releaseHold: () => {},
      onComplete: options?.onComplete,
      resolve,
    };
    finishFlight('complete');
    return handle;
  }

  function startFlight(destination, angles, durationS, options) {
    if (flight) finishFlight('cancelled');
    if (options?.endFrame === 'world') setFrame(IDENTITY);
    const instant = instantFlight(destination, angles, durationS, options);
    if (instant) return instant;
    const startPos = positionWC();
    const duration =
      durationS ??
      Math.min(3, Math.ceil(distance(position, destination) / 1e6) + 2);
    const start = { pos: startPos, angles: eyeAngles() };
    const path = flightPath(destination, angles, options ?? {});
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const handle = {
      done,
      cancel: () => {
        if (flight?.handle === handle) finishFlight('cancelled');
      },
    };
    flight = {
      handle,
      start,
      destination,
      angles,
      durationMs: duration * 1000,
      startedAt: null,
      path,
      easing:
        EASINGS[options?.easing] ??
        (path.startHeight > path.endHeight &&
        path.startHeight > DESCENT_EASE_HEIGHT
          ? EASINGS.cubicOut
          : EASINGS.quinticInOut),
      onComplete: options?.onComplete,
      onCancel: options?.onCancel,
      releaseHold: controls.suspend('flight'),
      resolve,
    };
    requestRender('flight');
    return handle;
  }

  function flyTo(destination, options = {}) {
    command('flyTo');
    const resolved = resolveDestination(destination, options.orientation);
    return startFlight(
      resolved.destination,
      resolved.angles,
      options.durationS,
      options,
    );
  }

  function flyToBounds(sphere, options = {}) {
    command('flyToBounds');
    setFrame(IDENTITY);
    const offset = { ...DEFAULT_SPHERE_OFFSET, ...(options.offset ?? {}) };
    if (!offset.range) {
      const tanPhi = Math.tan(verticalFov() * 0.5);
      const tanTheta = aspectRatio() * tanPhi;
      offset.range =
        sphere.radius === 0
          ? MINIMUM_ZOOM
          : Math.max(sphere.radius / tanTheta, sphere.radius / tanPhi);
      offset.range = Math.min(
        controls.maxDistance,
        Math.max(controls.minDistance, offset.range),
      );
    }
    const enu = eastNorthUp(sphere.center);
    const eye = framePoint(
      enu,
      offsetFromHeadingPitchRange(offset.heading, offset.pitch, offset.range),
    );
    const dir = normalize(sub(sphere.center, eye));
    let u = enu.z;
    if (1 - Math.abs(dot(dir, u)) < 1e-6)
      u = rotate(enu.y, dir, offset.heading);
    const r = cross(dir, u);
    u = normalize(cross(r, dir));
    return startFlight(
      eye,
      directionUpToAngles(eye, { direction: dir, up: u }),
      options.durationS,
      options,
    );
  }

  /** One frame of the flight in progress. */
  function stepFlight() {
    if (!flight) return;
    const t = now();
    if (flight.startedAt === null) {
      flight.startedAt = t;
      if (flight.durationMs > 0) return;
    }
    const elapsed = t - flight.startedAt;
    if (elapsed >= flight.durationMs) {
      placeAt(flight.destination, flight.angles);
      finishFlight('complete');
      return;
    }
    const s = flight.easing(elapsed / flight.durationMs);
    const { path } = flight;
    placeAt(
      fromRadians(
        path.startLon + (path.endLon - path.startLon) * s,
        path.startLat + (path.endLat - path.startLat) * s,
        path.height(s),
      ),
      {
        heading:
          path.startHeading + (flight.angles.heading - path.startHeading) * s,
        pitch: path.pitch(s),
        roll: path.startRoll + (flight.angles.roll - path.startRoll) * s,
      },
    );
    requestRender('flight');
  }

  /**
   * The reference flight path, fixed when the flight starts: longitude and
   * latitude linear in eased time the short way round; height on an arc
   * over the higher end when the two ends are far apart on screen (or
   * below `maxHeight`); pitch linear, or straight down mid-flight when the
   * arc tops `pitchAdjustHeight`.
   */
  function flightPath(destination, angles, options) {
    const from = toCartographicRadians(positionWC());
    const to = toCartographicRadians(destination);
    let startLon = zeroToTwoPi(from.lon);
    let endLon = zeroToTwoPi(to.lon);
    if (startLon - endLon < -Math.PI) startLon += TWO_PI;
    else if (startLon - endLon > Math.PI) endLon += TWO_PI;
    const now = eyeAngles();
    const height = heightCurve(
      destination,
      from.height,
      to.height,
      options.maxHeight,
    );
    return {
      startLon,
      endLon,
      startLat: from.lat,
      endLat: to.lat,
      startHeight: from.height,
      endHeight: to.height,
      height,
      pitch: pitchCurve(
        now.pitch,
        angles.pitch,
        height,
        options.pitchAdjustHeight,
      ),
      startHeading: forLerp(now.heading, angles.heading),
      startRoll: forLerp(now.roll, angles.roll),
    };
  }

  function heightCurve(destination, startHeight, endHeight, maxHeight) {
    let altitude = maxHeight;
    if (altitude === undefined) {
      const diff = sub(position, destination);
      const vertical = Math.abs(dot(diff, up));
      const horizontal = Math.abs(dot(diff, right));
      const tanHalf = Math.tan(0.5 * verticalFov());
      altitude = Math.min(
        Math.max(vertical / (aspectRatio() * tanHalf), horizontal / tanHalf) *
          0.2,
        1e9,
      );
    }
    if (Math.max(startHeight, endHeight) < altitude) {
      const power = 8;
      const factor = 1e6;
      const s = -(((altitude - startHeight) * factor) ** (1 / power));
      const e = ((altitude - endHeight) * factor) ** (1 / power);
      return (t) => -((t * (e - s) + s) ** power) / factor + altitude;
    }
    return (t) => startHeight + (endHeight - startHeight) * t;
  }

  function pitchCurve(startPitch, endPitch, height, adjustHeight) {
    if (adjustHeight !== undefined && height(0.5) > adjustHeight) {
      const h0 = height(0);
      const h1 = height(1);
      const mid = height(0.5);
      return (t) => {
        const h = height(t);
        if (t <= 0.5)
          return (
            startPitch + (-Math.PI / 2 - startPitch) * ((h - h0) / (mid - h0))
          );
        return (
          -Math.PI / 2 + (endPitch + Math.PI / 2) * (1 - (h - h1) / (mid - h1))
        );
      };
    }
    return (t) => startPitch + (endPitch - startPitch) * t;
  }

  /** The start angle moved by a turn so a straight blend takes the short way. */
  function forLerp(start, end) {
    let a = Math.abs(start - TWO_PI) <= 1e-11 ? 0 : start;
    if (end > a + Math.PI) a += TWO_PI;
    else if (end < a - Math.PI) a -= TWO_PI;
    return a;
  }

  function cancelFlight() {
    command('cancelFlight');
    finishFlight('cancelled');
  }

  function move(dir, metres) {
    const axis = {
      forward: direction,
      back: negate(direction),
      right,
      left: negate(right),
      up,
      down: negate(up),
    }[dir];
    position = add(position, scale(axis, metres));
    requestRender('camera');
  }

  function look(dir, radians) {
    const [axis, sign] = {
      left: [up, -1],
      right: [up, 1],
      up: [right, -1],
      down: [right, 1],
    }[dir];
    const a = clone(axis);
    const angle = -(sign * radians);
    direction = rotate(direction, a, angle);
    up = rotate(up, a, angle);
    right = rotate(right, a, angle);
    requestRender('camera');
  }

  function rotateAround(axis, radians) {
    const a = normalize(axis);
    position = rotate(position, a, -radians);
    direction = rotate(direction, a, -radians);
    up = rotate(up, a, -radians);
    right = cross(direction, up);
    up = cross(right, direction);
    requestRender('camera');
  }

  function zoom(metres) {
    move('forward', metres);
  }

  // --- Follow ----------------------------------------------------------------

  /** Where the target is drawn, for a drawn item; otherwise its own answer. */
  const targetAt = (target, t, aheadMs = 0) =>
    (target.item && drawnPosition(target.item, aheadMs)) ||
    target.position(t + aheadMs);

  function followFrame(target, t) {
    const at = targetAt(target, t);
    if (!at) return null;
    if (target.frame === 'autodetect') {
      const ahead = targetAt(target, t, 1000);
      const enu = eastNorthUp(at);
      if (ahead && distance(ahead, at) > 0.01) {
        const along = normalize(sub(ahead, at));
        const upAxis = enu.z;
        const forward = normalize(
          sub(along, scale(upAxis, dot(along, upAxis))),
        );
        const side = cross(forward, upAxis);
        return { x: side, y: forward, z: upAxis, origin: at };
      }
      return enu;
    }
    return eastNorthUp(at);
  }

  function follow(target) {
    command('follow');
    followed = target;
    followFramed = false;
    if (!target) setFrame(IDENTITY);
    emit('followChanged');
    requestRender('follow');
  }

  function stepFollow() {
    if (!followed) return;
    const t = sceneTime();
    const targetFrame = followFrame(followed, t);
    if (!targetFrame) return;
    if (!followFramed) {
      const viewFrom =
        typeof followed.viewFrom === 'function'
          ? followed.viewFrom(t)
          : followed.viewFrom;
      let offset = clone(viewFrom);
      const range = magnitude(offset);
      const minRange = Math.max(
        followed.minRange ?? 0,
        followed.boundingRadius ?? 0,
      );
      if (range < minRange && range > 0)
        offset = scale(offset, minRange / range);
      lookAtFrame(targetFrame, offset);
      followFramed = true;
      return;
    }
    // Keep the eye's local offset in the moving frame.
    const keptPosition = position;
    const keptDirection = direction;
    const keptUp = up;
    frame = targetFrame;
    position = keptPosition;
    direction = keptDirection;
    up = keptUp;
    right = cross(direction, up);
  }

  // --- Events ----------------------------------------------------------------

  function emit(event) {
    for (const entry of listeners[event].slice()) {
      if (!entry.live) continue;
      try {
        entry.cb();
      } catch (error) {
        report(error);
      }
    }
  }

  function on(event, cb, options = {}) {
    const entry = {
      cb,
      live: true,
      threshold: options.threshold ?? 0.5,
      ref: null,
    };
    listeners[event].push(entry);
    return () => {
      entry.live = false;
      const list = listeners[event];
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** How far the view moved from a listener's reference, as a fraction. */
  const angleDelta = (a, b) => {
    const d = Math.abs(a - b) % TWO_PI;
    return (d > Math.PI ? TWO_PI - d : d) / Math.PI;
  };

  /**
   * Per listener, the reference camera's formula: heading and roll each
   * against their own last reported value, then direction and position
   * against the last reported view. Each can report in the same frame.
   */
  function stepChanged() {
    const list = listeners.changed;
    if (!list.length) return;
    const current = pose();
    for (const entry of list.slice()) {
      if (!entry.live) continue;
      const t = entry.threshold;
      entry.heading ??= current.heading;
      entry.roll ??= current.roll;
      const headingF = angleDelta(entry.heading, current.heading);
      const rollF = angleDelta(entry.roll, current.roll);
      if (headingF > t) entry.heading = current.heading;
      if (rollF > t) entry.roll = current.roll;
      if (headingF > t || rollF > t) deliver(entry);
      if (!entry.view) {
        entry.view = {
          position: current.position,
          direction: current.direction,
        };
        continue;
      }
      const dirF =
        acosClamped(dot(current.direction, entry.view.direction)) /
        (current.fovy * 0.5);
      const heightF =
        distance(current.position, entry.view.position) / current.height;
      if (dirF > t || heightF > t) {
        entry.view = {
          position: current.position,
          direction: current.direction,
        };
        deliver(entry);
      }
    }
  }

  function deliver(entry) {
    if (!entry.live) return;
    try {
      entry.cb();
    } catch (error) {
      report(error);
    }
  }

  function sameView(a, b) {
    return (
      a &&
      b &&
      distance(a.position, b.position) === 0 &&
      dot(a.direction, b.direction) === dot(a.direction, a.direction) &&
      dot(a.up, b.up) === dot(a.up, a.up)
    );
  }

  function stepMoveDetection() {
    const current = {
      position: positionWC(),
      direction: directionWC(),
      up: upWC(),
    };
    const changed = lastPose && !sameView(lastPose, current);
    lastPose = current;
    const t = now();
    if (changed) {
      lastMovedAt = t;
      if (!moving) {
        moving = true;
        emit('moveStart');
      }
    } else if (moving && !followed && t - lastMovedAt >= MOVE_END_WAIT_MS) {
      moving = false;
      emit('moveEnd');
    }
  }

  function matrices() {
    const p = positionWC();
    const d = directionWC();
    const u = upWC();
    const r = rightWC();
    // Column-major view matrix: rows are right, up and -direction.
    const view = new Float64Array([
      r.x,
      u.x,
      -d.x,
      0,
      r.y,
      u.y,
      -d.y,
      0,
      r.z,
      u.z,
      -d.z,
      0,
      -dot(r, p),
      -dot(u, p),
      dot(d, p),
      1,
    ]);
    const top = near * Math.tan(verticalFov() * 0.5);
    const rightEdge = aspectRatio() * top;
    const projection = new Float64Array([
      near / rightEdge,
      0,
      0,
      0,
      0,
      near / top,
      0,
      0,
      0,
      0,
      -(far + near) / (far - near),
      -1,
      0,
      0,
      (-2 * far * near) / (far - near),
      0,
    ]);
    return { view, projection };
  }

  const followOffset = {
    get: () => (followed ? clone(position) : null),
    set: (offset) => {
      if (!followed) return;
      lookAtFrame(frame, clone(offset));
      requestRender('follow');
    },
  };

  const port = {
    pose,
    setView,
    setFov({ vertical }) {
      fovy = vertical;
      requestRender('camera');
    },
    viewRectangle: () => null,
    flyTo,
    flyToBounds,
    cancelFlight,
    get flying() {
      return flight !== null;
    },
    lookAt,
    release,
    move,
    look,
    rotateAround,
    zoom,
    follow,
    get followed() {
      return followed;
    },
    get followFramed() {
      return followFramed;
    },
    followOffset,
    controls,
    on,
    onCommand(cb) {
      commandHooks.push(cb);
      return () => {
        const i = commandHooks.indexOf(cb);
        if (i >= 0) commandHooks.splice(i, 1);
      };
    },
    matrices,
  };

  return {
    port,
    /** Ends a flight in progress as cancelled, without announcing a command. */
    endFlight: () => finishFlight('cancelled'),
    /** Advance camera steps of one frame, in the contract's order. */
    steps: { stepFlight, stepChanged, stepFollow, stepMoveDetection },
    eye: () => ({
      position: positionWC(),
      direction: directionWC(),
      up: upWC(),
      right: rightWC(),
      fovy: verticalFov(),
      aspectRatio: aspectRatio(),
      near,
    }),
    holds: () => [...holds.values()],
    setViewRectangle(fn) {
      port.viewRectangle = fn;
    },
  };
}
