/**
 * @module render/conformance/cameraRunner
 * @description Runs a camera script ({@link module:render/conformance/cameraScripts})
 * on a driver and collects what it records, in step order. A driver is
 * either a renderer through the contract ({@link contractDriver}) or the
 * reference recorder's own.
 */
import { wheelLines } from '../input/wheel.js';
import {
  eyeMoved,
  eyeRotatedAbout,
  eyeTurned,
  eyeZoomed,
} from '../../geo/eyeMoves.js';

const NO_MODIFIERS = Object.freeze({
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
});

/**
 * @typedef {object} CameraDriver
 * @property {(name: string, args: unknown[]) => import('../contract/camera').Flight|void} command
 * @property {() => void|Promise<void>} frame One frame, 1/60 s on the script's clock.
 * @property {(threshold: number) => () => number} listen Counts `changed`; returns a reader.
 * @property {() => object} pose
 * @property {(position: object) => object|null} project
 * @property {(screen: {x: number, y: number}) => object|null} pickEllipsoid
 * @property {(screen: {x: number, y: number}) => object} pickRay
 * @property {(position: object) => boolean} occluded
 * @property {() => boolean} flying
 * @property {(position: object) => object} toEcef
 * @property {(ev: ScriptPointer) => void|Promise<void>} [pointer] For scripts with `input` steps.
 */

/**
 * A script's pointer event: `position` is where it happened (for a move,
 * where the pointer was) and `endPosition` where a move went; a wheel has
 * the DOM's `deltaY` and `deltaMode`.
 * @typedef {object} ScriptPointer
 * @property {'down'|'move'|'up'|'wheel'} type
 * @property {{x: number, y: number}} position
 * @property {{x: number, y: number}} [endPosition]
 * @property {0|1|2} button
 * @property {{shift: boolean, ctrl: boolean, alt: boolean, meta: boolean}} modifiers
 * @property {{deltaY: number, deltaMode: number}} [wheel]
 */

/** The parts of a pose a trace keeps. */
export function tracePose(pose) {
  return {
    position: pick3(pose.position),
    direction: pick3(pose.direction),
    up: pick3(pose.up),
    right: pick3(pose.right),
    heading: pose.heading,
    pitch: pose.pitch,
    roll: pose.roll,
    height: pose.height,
    frameIsIdentity: pose.frameIsIdentity,
  };
}

const pick3 = (v) => (v ? { x: v.x, y: v.y, z: v.z } : null);

/**
 * @param {CameraDriver} driver
 * @param {{name: string, steps: object[]}} script
 * @returns {Promise<{records: object[], flights: object[]}>}
 */
export async function runCameraScript(driver, script) {
  const records = [];
  const flights = [];
  const listeners = [];
  let frame = 0;
  // Where the pointer is, for the next move's start, and the button held
  // since the last press (a move carries it, as an input port reports it).
  // Only a press or a move puts the pointer somewhere, as in the reference:
  // a wheel or a release elsewhere leaves the next move starting where the
  // pointer last went.
  let pointerAt = null;
  let held = null;
  for (const [index, step] of script.steps.entries()) {
    if (step.input) {
      const at = { x: step.x, y: step.y };
      const ev = {
        type: step.input,
        position: step.input === 'move' ? (pointerAt ?? at) : at,
        ...(step.input === 'move' ? { endPosition: at } : {}),
        button: step.button ?? (step.input === 'move' ? held : null) ?? 0,
        modifiers: { ...NO_MODIFIERS, ...(step.modifiers ?? {}) },
        ...(step.input === 'wheel'
          ? { wheel: { deltaY: step.deltaY, deltaMode: step.deltaMode ?? 0 } }
          : {}),
      };
      if (step.input === 'down' || step.input === 'move') pointerAt = at;
      if (step.input === 'down') held = ev.button;
      else if (step.input === 'up') held = null;
      if (!driver.pointer)
        throw new Error('this driver takes no pointer input');
      await driver.pointer(ev);
    } else if (step.do === 'frames') {
      for (let i = 0; i < step.count; i++) {
        frame += 1;
        await driver.frame();
      }
    } else if (step.do === 'listen') {
      listeners.push({
        threshold: step.threshold,
        read: driver.listen(step.threshold),
      });
    } else if (step.do) {
      const args = resolveArgs(driver, step.do, step.args ?? []);
      const flight = driver.command(step.do, args);
      if (flight && typeof flight.done?.then === 'function') {
        const entry = {
          step: index,
          startFrame: frame,
          outcome: null,
          frames: null,
        };
        flights.push(entry);
        flight.done.then((outcome) => {
          entry.outcome = outcome;
          entry.frames = frame - entry.startFrame;
        });
      }
    } else if (step.record) {
      // Let flight outcomes that settled this frame land first.
      await Promise.resolve();
      records.push({
        step: index,
        kind: step.record,
        value: record(driver, step),
      });
    }
  }
  await Promise.resolve();
  return { records, flights: flights.map(({ startFrame, ...rest }) => rest) };

  function record(d, step) {
    switch (step.record) {
      case 'pose':
        return tracePose(d.pose());
      case 'project':
        return step.points.map((p) => d.project(d.toEcef(p)));
      case 'pickEllipsoid':
        return step.screen.map((s) => pick3(d.pickEllipsoid(s)));
      case 'pickRay':
        return step.screen.map((s) => {
          const ray = d.pickRay(s);
          return { origin: pick3(ray.origin), direction: pick3(ray.direction) };
        });
      case 'occluded':
        return step.points.map((p) => d.occluded(d.toEcef(p)));
      case 'changed':
        return listeners.map((l) => ({
          threshold: l.threshold,
          count: l.read(),
        }));
      case 'flying':
        return { flying: d.flying(), pose: tracePose(d.pose()) };
      case 'viewRectangle':
        return d.viewRectangle();
      case 'matrices': {
        const m = d.matrices();
        const { near, far } = d.pose();
        return {
          view: [...m.view],
          projection: [...m.projection],
          near,
          // JSON has no Infinity: an infinite far plane is null. Anything
          // else that is not a number stays as it is, to fail the check.
          far: far === Infinity ? null : far,
        };
      }
      default:
        throw new Error(`unknown record ${step.record}`);
    }
  }
}

/** Geodetic positions in arguments become ECEF where the command takes ECEF. */
function resolveArgs(driver, name, args) {
  if (name === 'lookAt') return [driver.toEcef(args[0]), args[1]];
  if (name === 'flyToBounds')
    return [
      { ...args[0], center: driver.toEcef(args[0].center) },
      ...args.slice(1),
    ];
  return args;
}

/**
 * Script steps that are the app's own sums over the pose, not port verbs: the
 * contract driver turns them into `setView`, where the reference recorder
 * runs Cesium's matching camera functions.
 */
const EYE_STEPS = {
  move: eyeMoved,
  look: eyeTurned,
  rotateAround: eyeRotatedAbout,
  zoom: eyeZoomed,
};

/**
 * A driver over a renderer, through the contract only.
 * @param {import('../contract/renderer').Renderer} renderer
 * `hooks.pointer(type, x, y, extra)` sends a pointer event the way a
 * harness's `pointer` does; a wheel goes as the input port's lines.
 * @param {{frame: () => void|Promise<void>, toEcef: (p: object) => object,
 *   pointer?: (type: string, x: number, y: number, extra: object) => void|Promise<void>}} hooks
 * @returns {CameraDriver}
 */
export function contractDriver(renderer, hooks) {
  const camera = renderer.camera;
  return {
    command(name, args) {
      if (Object.hasOwn(EYE_STEPS, name))
        return camera.setView(EYE_STEPS[name](camera.pose(), ...args));
      return camera[name](...args);
    },
    frame: hooks.frame,
    listen(threshold) {
      let count = 0;
      camera.on('changed', () => (count += 1), { threshold });
      return () => count;
    },
    pose: () => camera.pose(),
    project: (p) => renderer.query.project(p),
    pickEllipsoid: (s) => renderer.query.pickEllipsoid(s.x, s.y),
    pickRay: (s) => renderer.query.pickRay(s.x, s.y),
    occluded: (p) => renderer.query.isOccluded(p),
    flying: () => camera.flying,
    matrices: () => camera.matrices(),
    viewRectangle: () => camera.viewRectangle(),
    toEcef: hooks.toEcef,
    ...(hooks.pointer
      ? {
          pointer: (ev) =>
            hooks.pointer(ev.type, ev.position.x, ev.position.y, {
              button: ev.button,
              modifiers: ev.modifiers,
              ...(ev.endPosition ? { endPosition: ev.endPosition } : {}),
              ...(ev.wheel ? { delta: wheelLines(ev.wheel) } : {}),
            }),
        }
      : {}),
  };
}
