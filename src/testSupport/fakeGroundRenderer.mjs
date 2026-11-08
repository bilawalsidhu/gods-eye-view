/**
 * A renderer double for layers that draw on the ground and size what they
 * draw to the camera: a fake draw port (`fakeDrawPort.mjs`), a frame port
 * whose `preRender` the test raises, a camera whose eye the test moves and
 * whose `moveEnd` it raises, a query port answering the ellipsoid's
 * horizon and scripted heights, and a globe whose visibility and terrain
 * loading the test sets. Bound to `viewer`, as the application binds its
 * renderer, so `drawOf`, `cameraOf` and the rest find it.
 */
import { bindRenderer } from '../render/rendererOf.js';
import { fakeDrawPort } from './fakeDrawPort.mjs';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';

/** An event a test raises: listeners added, removed and counted. */
export class FakeEvent {
  constructor() {
    this.listeners = new Set();
    this.addCount = 0;
    this.removeCount = 0;
  }

  on(listener) {
    this.addCount++;
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.removeCount++;
      this.listeners.delete(listener);
    };
  }

  raise(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

const WGS84_RADII = { x: 6378137, y: 6378137, z: 6356752.3142451793 };

/**
 * Whether the ellipsoid hides `point` from `eye`, by the horizon-plane test
 * the default renderer's occluder makes.
 */
function occluded(eye, point) {
  const scaled = (p) => ({
    x: p.x / WGS84_RADII.x,
    y: p.y / WGS84_RADII.y,
    z: p.z / WGS84_RADII.z,
  });
  const v = scaled(eye);
  const vhMagnitudeSquared = v.x * v.x + v.y * v.y + v.z * v.z - 1;
  const t = scaled(point);
  const vt = { x: t.x - v.x, y: t.y - v.y, z: t.z - v.z };
  const vtDotVc = -(vt.x * v.x + vt.y * v.y + vt.z * v.z);
  if (vhMagnitudeSquared < 0) return vtDotVc > 0;
  return (
    vtDotVc > vhMagnitudeSquared &&
    (vtDotVc * vtDotVc) / (vt.x * vt.x + vt.y * vt.y + vt.z * vt.z) >
      vhMagnitudeSquared
  );
}

/**
 * @param {object} viewer The scene object to bind it to.
 * @param {object} [options]
 * @param {boolean} [options.sampleHeight] The `sampleHeight` capability.
 * @param {(point: {lon: number, lat: number}) => number|null} [options.surface]
 *   Surface heights; default: none loaded.
 * @param {{lon: number, lat: number, height: number}} [options.eye]
 * @param {{width: number, height: number}} [options.canvas]
 */
export function bindFakeGroundRenderer(
  viewer,
  {
    sampleHeight = false,
    surface = () => null,
    eye = { lon: 0, lat: 0, height: 1000 },
    canvas = { width: 800, height: 600 },
  } = {},
) {
  const draw = fakeDrawPort();
  const preRender = new FakeEvent();
  const moveEnd = new FakeEvent();
  const capabilities = new Set(sampleHeight ? ['sampleHeight'] : []);
  const flights = [];
  /** What the camera has been told to follow, in order; the last is followed. */
  const follows = [];
  /** The camera's view shape, which a test may change. */
  const view = { fovy: Math.PI / 3, aspectRatio: 1 };
  /** What a pick answers at a window position; default: nothing drawn. */
  let pickAt = () => null;
  const renders = [];
  let position = fromDegrees(eye.lon, eye.lat, eye.height);
  let surfaceHeight = surface;
  const sampleCalls = { count: 0 };
  /** The globe: shown, its terrain loaded, and the terrain's heights. */
  const globe = {
    show: true,
    tilesLoaded: true,
    terrain: () => null,
  };
  const element = {
    clientWidth: canvas.width,
    clientHeight: canvas.height,
    width: canvas.width,
    height: canvas.height,
  };
  const renderer = {
    capabilities,
    canvas: element,
    draw,
    frame: {
      on: (phase, cb) => (phase === 'preRender' ? preRender.on(cb) : () => {}),
      requestRender: (reason) => renders.push(reason),
    },
    camera: {
      pose() {
        const at = toLonLatH(position);
        return {
          ...at,
          position: { ...position },
          ...view,
        };
      },
      on: (event, cb) => (event === 'moveEnd' ? moveEnd.on(cb) : () => {}),
      flyTo(destination, options) {
        flights.push({ destination, options });
        return { done: Promise.resolve('complete'), cancel() {} };
      },
      flyToBounds(sphere, options) {
        flights.push({ sphere, options });
        return { done: Promise.resolve('complete'), cancel() {} };
      },
      follow(target) {
        follows.push(target);
      },
      get followed() {
        return follows.at(-1) ?? null;
      },
      controls: { minDistance: 1, maxDistance: Infinity },
    },
    query: {
      pick: (x, y) => pickAt(x, y),
      project: () => ({ x: canvas.width / 2, y: canvas.height / 2 }),
      isOccluded: (point) => occluded(position, point),
      sampleHeightNow(point, options = {}) {
        if (options.against === 'terrain')
          return globe.show ? globe.terrain(point) : null;
        if (!capabilities.has('sampleHeight')) return null;
        sampleCalls.count += 1;
        return surfaceHeight(point);
      },
    },
    globe: {
      isGlobeVisible: () => globe.show,
      isSettled: (kind) =>
        kind !== 'terrain' || !globe.show || globe.tilesLoaded !== false,
    },
  };
  const unbind = bindRenderer(viewer, renderer);
  return {
    renderer,
    draw,
    preRender,
    moveEnd,
    globe,
    flights,
    follows,
    view,
    renders,
    sampleCalls,
    capabilities,
    unbind,
    /** The live set whose id ends with `:${role}`. */
    set: (role) =>
      [...draw.sets.values()].find(
        (record) => !record.disposed && record.spec.id.endsWith(`:${role}`),
      ),
    /** Every set not yet disposed. */
    liveSets: () =>
      [...draw.sets.values()].filter((record) => !record.disposed),
    /** Move the eye. */
    setEye(lon, lat, height) {
      position = fromDegrees(lon, lat, height);
    },
    setEyePosition(next) {
      position = { ...next };
    },
    eyePosition: () => ({ ...position }),
    /** Change what a pick answers at a window position. */
    setPick(next) {
      pickAt = next;
    },
    /** Change what surface samples answer. */
    setSurface(next) {
      surfaceHeight = next;
    },
  };
}
