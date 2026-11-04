/**
 * @module render/conformance
 * @description The renderer conformance suite. It runs every check against
 * a renderer through the contract alone, in Node or in a browser page, and
 * reports each as passed, failed or skipped.
 *
 * A harness says how to make the renderer under test and drive its clock:
 *
 * ```js
 * const report = await runConformance({
 *   name: 'stub',
 *   create: ({ viewport, capabilities }) => makeRenderer(...),
 *   frame: (r) => advanceOneFrame(r),   // 1/60 s on a virtual clock
 *   now: (r) => clockMs(r),
 *   toEcef: ({ lon, lat, height }) => ecef,
 *   tolerance: DEFAULT_TOLERANCE,
 *   flightPaths: 'trace',               // or 'endpoints'
 * });
 * ```
 *
 * Optional harness members widen what is checked: `pointer(r, type, x, y)`
 * (synthetic input), `scriptHeights(r, fn)` (heights from a function),
 * `wallTime(r)` (the wall clock a `live` motion clock reads),
 * `assets.model` (a glTF URL). `create` may return null when it cannot
 * make a renderer with fewer capabilities; those checks are then skipped.
 */
import { cameraChecks } from './checks/camera.js';
import { portChecks } from './checks/ports.js';

/**
 * @typedef {object} ConformanceTolerance
 * @property {number} metres Positions and heights.
 * @property {number} unit Unit vectors (direction, up, right).
 * @property {number} radians Heading, pitch and roll.
 * @property {number} pixels Screen positions.
 * @property {number} changedCount `changed` events per script.
 */

/**
 * @typedef {object} ConformanceHarness
 * @property {string} name
 * @property {(options: {viewport: {width: number, height: number}, capabilities?: string[]}) => Promise<import('../contract/renderer').Renderer|null>} create
 * @property {(r: import('../contract/renderer').Renderer) => void|Promise<void>} frame
 * @property {(r: import('../contract/renderer').Renderer) => number} now
 * @property {(p: {lon: number, lat: number, height?: number}) => {x: number, y: number, z: number}} toEcef
 * @property {ConformanceTolerance} tolerance
 * @property {'trace'|'endpoints'} flightPaths Whether flight paths are compared frame by frame, or only where flights end.
 * @property {(r: object, type: string, x: number, y: number, extra?: object) => void|Promise<void>} [pointer]
 * @property {(r: object, fn: (point: {lon: number, lat: number}, against?: string) => number|null) => void} [scriptHeights]
 * @property {(r: object) => number} [wallTime] Epoch ms the renderer's `live` motion clock reads.
 * @property {{model?: string}} [assets]
 */

/**
 * Tolerances a renderer that reproduces the reference camera meets: under a
 * millimetre at city scale, well under a pixel on screen.
 * @type {Readonly<ConformanceTolerance>}
 */
export const DEFAULT_TOLERANCE = Object.freeze({
  metres: 1e-3,
  unit: 1e-9,
  radians: 1e-9,
  pixels: 1e-3,
  changedCount: 0,
});

/** Every check, in run order. */
export function conformanceChecks() {
  return [...portChecks(), ...cameraChecks()];
}

/**
 * @param {ConformanceHarness} harness
 * @param {{only?: (id: string) => boolean}} [options]
 * @returns {Promise<{harness: string, passed: number, failed: number, skipped: number,
 *   results: Array<{id: string, port: string, title: string, status: 'pass'|'fail'|'skip', detail?: string, ms: number}>}>}
 */
export async function runConformance(harness, options = {}) {
  const results = [];
  for (const c of conformanceChecks()) {
    if (options.only && !options.only(c.id)) continue;
    const start = Date.now();
    let status = 'pass';
    let detail;
    try {
      const outcome = await c.run(harness);
      if (outcome?.skip) {
        status = 'skip';
        detail = outcome.skip;
      }
    } catch (error) {
      status = 'fail';
      detail = error?.message ?? String(error);
    }
    results.push({
      id: c.id,
      port: c.port,
      title: c.title,
      status,
      ...(detail ? { detail } : {}),
      ms: Date.now() - start,
    });
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    harness: harness.name,
    passed: count('pass'),
    failed: count('fail'),
    skipped: count('skip'),
    results,
  };
}

export { CAMERA_SCRIPTS, SCRIPT_VIEWPORT } from './cameraScripts.js';
export { CALIBRATION_PATH, REFERENCE_SCENES, sceneSupport } from './scenes.js';
export {
  VISUAL_TOLERANCE,
  compareImages,
  drawScene,
  referenceName,
} from './visual.js';
export { contractDriver, runCameraScript, tracePose } from './cameraRunner.js';
export * as expect from './expect.js';
