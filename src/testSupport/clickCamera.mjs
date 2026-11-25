/**
 * A camera port that records what a click asks of it, for the tests of the
 * click rule (src/data/clickSelect.js) across the layers: every flight
 * (`flights`), every follow (`follows`) and what is followed now, over a
 * pose looking straight down at a place. `drag` moves the eye as a drag on
 * the map does (the pose changes and the port says so), with no camera
 * command. Bind it to a viewer double before `fakeInput`, so the input port
 * the dispatcher builds is the double's own.
 */
import { eastNorthUp, fromDegrees, scale, toLonLatH } from '../geo/index.js';
import { bindRenderer } from '../render/rendererOf.js';

function poseAt({ lon, lat, height, heading = 0 }) {
  const enu = eastNorthUp(fromDegrees(lon, lat, 0));
  return {
    lon,
    lat,
    height,
    heading,
    pitch: -Math.PI / 2,
    roll: 0,
    position: fromDegrees(lon, lat, height),
    direction: scale(enu.z, -1),
    up: enu.y,
    right: enu.x,
    fovy: Math.PI / 3,
    aspectRatio: 1,
    near: 1,
    far: 5e8,
    frameIsIdentity: true,
  };
}

/**
 * @param {object} viewer The viewer double to bind the port to.
 * @param {{lon?: number, lat?: number, height?: number, pose?: object|null}} [at]
 *   `pose`: an eye of the test's own (`position`, `direction`, `up`) in
 *   place of the one looking straight down.
 */
export function bindClickCamera(
  viewer,
  { lon = -97.74, lat = 30.27, height = 20_000, pose: own = null } = {},
) {
  let pose = poseAt({ lon, lat, height });
  if (own) {
    const at = toLonLatH(own.position);
    pose = { ...pose, ...own, lon: at.lon, lat: at.lat, height: at.height };
  }
  let followed = null;
  const flights = [];
  const follows = [];
  const views = [];
  const listeners = new Map();
  const emit = (event) => {
    for (const cb of [...(listeners.get(event) ?? [])]) cb();
  };
  const port = {
    pose: () => ({ ...pose }),
    viewRectangle: () => null,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    flyTo(destination, options = {}) {
      flights.push({ destination, options });
      return { done: Promise.resolve('complete'), cancel() {} };
    },
    flyToBounds(sphere, options = {}) {
      flights.push({ sphere, options });
      return { done: Promise.resolve('complete'), cancel() {} };
    },
    cancelFlight() {},
    release() {},
    flying: false,
    setView(spec) {
      views.push(spec);
    },
    get followed() {
      return followed;
    },
    follow(target) {
      follows.push(target);
      if (target === followed) return;
      followed = target;
      emit('followChanged');
    },
  };
  const unbind = bindRenderer(viewer, { camera: port });
  return {
    port,
    flights,
    follows,
    /** What `setView` was asked: a correction of the view. */
    views,
    /** What the camera follows now. */
    get followed() {
      return followed;
    },
    /** Move the eye as a drag on the map does: no camera command. */
    drag({ dLon = 0.2, dLat = 0.1, height } = {}) {
      pose = poseAt({
        lon: pose.lon + dLon,
        lat: pose.lat + dLat,
        height: height ?? pose.height,
      });
      emit('moveStart');
      emit('changed');
      emit('moveEnd');
    },
    /** Land the latest flight: the eye is where it asked, then moveEnd. */
    land() {
      const { destination, options } = flights.at(-1);
      const at = toLonLatH(destination);
      pose = {
        ...pose,
        lon: at.lon,
        lat: at.lat,
        height: at.height,
        position: { ...destination },
        direction: { ...options.orientation.direction },
        up: { ...options.orientation.up },
      };
      emit('moveEnd');
    },
    unbind,
  };
}

/**
 * A drag on the map through `fake` (fakeInput): press, move far, release.
 * The dispatcher measures it as a drag, so no layer reads it as a click.
 */
export function dragOnMap(
  fake,
  from = { x: 10, y: 10 },
  to = { x: 240, y: 180 },
) {
  fake.down(from);
  fake.move(to, from);
  fake.up(to);
}
