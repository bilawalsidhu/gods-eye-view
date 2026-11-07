/**
 * @module render/cesium/frame
 * @description A frame port (`src/render/contract/frame.d.ts`) over a Cesium
 * viewer with no renderer bound, built when code first
 * asks `findFrame` for one (`rendererOf.js`). The renderer's own frame port
 * (`ports.js`) runs the loop on demand; this one leaves the viewer's loop as
 * its owner set it up and only listens to it, asks it for frames and holds
 * it drawing: its `mode` is the viewer's, and `requestRender` and holds draw
 * a frame however the viewer's loop runs. `setTime`, `suspend` and
 * `setTargetFps` are the viewer's own clock, loop and rate.
 *
 * A `preUpdate` FrameTime's `rendering` says, when read, whether the tick
 * draws by the scene's own test so far (`willDraw`, which the renderer's
 * frame port makes too) or a hold, and once the tick has drawn or not,
 * which it did. `suspend` stops and resumes the viewer's default loop;
 * resumed, the loop is as its owner had it.
 */
import * as Cesium from 'cesium';
import { provideUnboundFrame } from '../rendererOf.js';
import { listenerList, uncaught } from './common.js';
import {
  atEndOfTick,
  lastRenderTime,
  lastSeenCamera,
  renderPending,
} from './internals.js';

const PHASES = ['preUpdate', 'preRender', 'postRender'];

const scratchPosition0 = new Cesium.Cartesian3();
const scratchPosition1 = new Cesium.Cartesian3();

/** Cesium's own test (`View.js`) for whether the camera moved. */
function cameraEqual(camera0, camera1, epsilon) {
  const maximumPositionComponent = Math.max(
    Cesium.Cartesian3.maximumComponent(
      Cesium.Cartesian3.abs(camera0.position, scratchPosition0),
    ),
    Cesium.Cartesian3.maximumComponent(
      Cesium.Cartesian3.abs(camera1.position, scratchPosition1),
    ),
  );
  const scalar = 1 / Math.max(1, maximumPositionComponent);
  Cesium.Cartesian3.multiplyByScalar(
    camera0.position,
    scalar,
    scratchPosition0,
  );
  Cesium.Cartesian3.multiplyByScalar(
    camera1.position,
    scalar,
    scratchPosition1,
  );
  return (
    Cesium.Cartesian3.equalsEpsilon(
      scratchPosition0,
      scratchPosition1,
      epsilon,
    ) &&
    Cesium.Cartesian3.equalsEpsilon(
      camera0.direction,
      camera1.direction,
      epsilon,
    ) &&
    Cesium.Cartesian3.equalsEpsilon(camera0.up, camera1.up, epsilon) &&
    Cesium.Cartesian3.equalsEpsilon(camera0.right, camera1.right, epsilon) &&
    Cesium.Matrix4.equalsEpsilon(
      camera0.transform,
      camera1.transform,
      epsilon,
    ) &&
    camera0.frustum.equalsEpsilon(camera1.frustum, epsilon)
  );
}

/**
 * Whether the scene's tick draws: the test `Scene.render` makes just after
 * `preUpdate`, made here so `preUpdate` can say. Not seen: a request made
 * in between, by a `camera.moveEnd` listener (Cesium raises it there); no
 * listener of the app's does that, and the answer is corrected at preRender.
 * @param {object} scene Cesium Scene.
 * @param {object} [time] The tick's scene time, a Cesium JulianDate.
 * @returns {boolean}
 */
export function willDraw(scene, time) {
  if (!scene.requestRenderMode || renderPending(scene)) return true;
  if (scene.mode === Cesium.SceneMode.MORPHING) return true;
  const seen = lastSeenCamera(scene);
  if (!seen || !cameraEqual(scene.camera, seen, Cesium.Math.EPSILON15))
    return true;
  const last = lastRenderTime(scene);
  const max = scene.maximumRenderTimeChange;
  return (
    last !== undefined &&
    max !== undefined &&
    Math.abs(
      Cesium.JulianDate.secondsDifference(
        last,
        time ?? Cesium.JulianDate.now(),
      ),
    ) > max
  );
}

/**
 * @param {object} viewer A Cesium `Viewer` or `CesiumWidget`.
 * @returns {{port: import('../contract/frame').FramePort,
 *   dispose: () => void}}
 */
export function createSceneFrame(viewer) {
  const scene = viewer.scene;
  const listeners = Object.fromEntries(
    PHASES.map((phase) => [phase, listenerList(uncaught)]),
  );
  let frames = 0;
  let rendered = 0;
  let tickNow = performance.now();
  let dt = 0;
  // Reasons asked for since the last drawn frame; those a drawing frame
  // answers are the first `answering`.
  const pendingReasons = [];
  let answering = 0;
  let disposed = false;
  let suspended = false;
  // Whether the viewer ran Cesium's own loop, for `suspend` to give back.
  const ownLoop = viewer.useDefaultRenderLoop !== false;
  // The preUpdate FrameTime of the tick under way, until it settles.
  let liveTick = null;
  const settleTick = (drawn) => {
    if (liveTick)
      Object.defineProperty(liveTick, 'rendering', {
        value: drawn,
        enumerable: true,
      });
    liveTick = null;
  };
  const holds = new Map();
  const pendingRenders = new Set();
  const gone = () => disposed || scene.isDestroyed?.();
  const sceneTime = (time) =>
    Cesium.JulianDate.toDate(
      time ?? viewer.clock?.currentTime ?? Cesium.JulianDate.now(),
    ).getTime();

  const onPhase = (phase) => (_scene, time) => {
    if (phase === 'preUpdate') {
      settleTick(false);
      // A tick that does not draw settles at its end; one that does, at
      // preRender.
      atEndOfTick(scene, () => void settleTick(false));
      const now = performance.now();
      dt = (now - tickNow) / 1000;
      tickNow = now;
      frames += 1;
    }
    if (phase === 'preRender') {
      settleTick(true);
      answering = pendingReasons.length;
    }
    if (phase === 'postRender') {
      rendered += 1;
      pendingReasons.splice(0, answering);
      answering = 0;
      // Held: the next frame is asked for as this one ends.
      if (holds.size) scene.requestRender();
    }
    if (listeners[phase].size === 0) return;
    const t = {
      frame: frames,
      time: sceneTime(time),
      now: tickNow,
      dt,
      rendering: true,
    };
    // Read as it is asked: what earlier listeners asked for counts.
    if (phase === 'preUpdate') {
      Object.defineProperty(t, 'rendering', {
        enumerable: true,
        configurable: true,
        get: () => holds.size > 0 || willDraw(scene, time),
      });
      liveTick = t;
    }
    listeners[phase].fire(t);
  };
  const removers = PHASES.map((phase) =>
    scene[phase].addEventListener(onPhase(phase)),
  );

  const port = {
    on(phase, cb) {
      const list = listeners[phase];
      if (!list) throw new TypeError(`Unknown frame phase: ${phase}`);
      return list.on(cb);
    },
    requestRender(reason = 'unspecified') {
      if (gone()) return;
      // During a draw the reasons it answers are spoken for.
      if (!pendingReasons.includes(reason, answering))
        pendingReasons.push(reason);
      scene.requestRender();
    },
    holdContinuous(reason) {
      if (disposed) return () => {};
      holds.set(reason, (holds.get(reason) ?? 0) + 1);
      if (!gone()) scene.requestRender();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = holds.get(reason) - 1;
        if (left > 0) holds.set(reason, left);
        else holds.delete(reason);
        // What changed in the last held frame still gets drawn.
        if (!gone()) scene.requestRender();
      };
    },
    mode: () => (scene.requestRenderMode ? 'demand' : 'continuous'),
    diagnostics: () => ({
      mode: port.mode(),
      frames,
      rendered,
      pendingReasons: [...pendingReasons],
      holds: [...holds].flatMap(([reason, n]) => Array(n).fill(reason)),
      suspended,
      targetFps: viewer.targetFrameRate > 0 ? viewer.targetFrameRate : 0,
    }),
    suspend(hidden) {
      if (Boolean(hidden) === suspended) return;
      suspended = Boolean(hidden);
      // Resumed, the loop runs as its owner had it (perhaps their own).
      viewer.useDefaultRenderLoop = suspended ? false : ownLoop;
      if (!suspended && !gone()) scene.requestRender();
    },
    renderNow: () => scene.forceRender(viewer.clock?.currentTime),
    renderOnce({ timeoutMs } = {}) {
      if (gone()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let timer;
        const settle = (error) => {
          off();
          clearTimeout(timer);
          pendingRenders.delete(done);
          if (error) reject(error);
          else resolve();
        };
        const done = () => settle();
        const off = scene.postRender.addEventListener(done);
        pendingRenders.add(done);
        if (timeoutMs !== undefined)
          timer = setTimeout(
            () => settle(new Error('renderOnce timed out')),
            timeoutMs,
          );
        scene.requestRender();
      });
    },
    setTargetFps(fps) {
      viewer.targetFrameRate = fps > 0 ? fps : undefined;
    },
    setTime(ms) {
      viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(ms));
      port.requestRender('time');
    },
    time: () => sceneTime(),
  };

  return {
    port,
    dispose() {
      disposed = true;
      settleTick(false);
      for (const off of removers.splice(0)) off();
      for (const list of Object.values(listeners)) list.clear();
      holds.clear();
      // Waits settle rather than stay attached to a scene gone quiet.
      for (const done of [...pendingRenders]) done();
    },
  };
}

// A Cesium viewer with no renderer bound to it gets a
// frame port over its scene when code first asks `findFrame` for one.
provideUnboundFrame((viewer) => {
  const scene = viewer.scene;
  // By shape, not `instanceof`: the viewer may come from another
  // copy of Cesium.
  if (
    PHASES.some(
      (phase) => typeof scene?.[phase]?.addEventListener !== 'function',
    ) ||
    typeof scene.requestRender !== 'function' ||
    typeof scene.forceRender !== 'function' ||
    !viewer.clock
  )
    return null;
  return createSceneFrame(viewer);
});
