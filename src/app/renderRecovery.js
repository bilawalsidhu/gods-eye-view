/**
 * Keeps one bad frame from stopping the globe for good.
 *
 * Cesium's render loop stops itself on the first error a frame throws and
 * leaves an error panel over the canvas; nothing restarts it short of a
 * reload. Two things here:
 *
 * 1. `guardDegenerateRotation` removes one such error at its cause. Zooming
 *    with the wheel above 1,000 km, Cesium turns the globe from the point under
 *    the screen centre towards the point under the pointer
 *    (`ScreenSpaceCameraController` `handleZoom`): it normalizes both points,
 *    takes their dot product, and rotates about their cross product when the
 *    dot product is below 1. With the pointer on the centre pixel the two
 *    points are the same, but a unit vector's dot product with itself often
 *    rounds to 0.9999999999999999, so the check passes and the cross product is
 *    the zero vector. `Camera.rotate` then normalizes it and throws
 *    "normalized result is not a number" from `Scene.initializeFrame`, which
 *    runs outside the scene's own error handling. Builds without Cesium's
 *    debug checks would write NaN into the camera instead.
 *
 * 2. `installRenderRecovery` restarts the loop after any error that stops it,
 *    from the last pose a frame was drawn with, a bounded number of times.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';

/** Restarts allowed within RECOVERY_WINDOW_MS before the error is left to stand. */
export const RECOVERY_LIMIT = 3;
/** An error that keeps coming back this fast is not one a restart gets past. */
export const RECOVERY_WINDOW_MS = 10_000;

/**
 * Make `camera.rotate` ignore an axis it cannot normalize (zero or not finite)
 * and an angle that is not finite. There is nothing to rotate about, so the
 * camera stays where it is and the caller carries on; Cesium's wheel zoom
 * still moves the camera in after the skipped turn.
 * @param {Cesium.Camera} camera
 * @returns {() => void} Restore the camera's own rotate.
 */
export function guardDegenerateRotation(camera) {
  const own = Object.hasOwn(camera, 'rotate');
  const rotate = camera.rotate;
  const guarded = function (axis, angle) {
    if (axis) {
      const magnitudeSquared = Cesium.Cartesian3.magnitudeSquared(axis);
      if (
        !(magnitudeSquared > 0) ||
        !Number.isFinite(magnitudeSquared) ||
        (angle !== undefined && !Number.isFinite(angle))
      )
        return;
    }
    return rotate.call(this, axis, angle);
  };
  camera.rotate = guarded;
  return () => {
    if (camera.rotate !== guarded) return;
    if (own) camera.rotate = rotate;
    else delete camera.rotate;
  };
}

function finite(cartesian) {
  return (
    Number.isFinite(cartesian?.x) &&
    Number.isFinite(cartesian?.y) &&
    Number.isFinite(cartesian?.z)
  );
}

/**
 * Restart Cesium's render loop when an error stops it.
 *
 * Cesium reports a stopped loop only through `showErrorPanel`: errors thrown
 * while a frame is prepared (camera input, in `Scene.initializeFrame`) never
 * reach `scene.renderError`, so that event alone would miss them. The panel
 * call is the one place both kinds of stop pass through, after the loop is
 * already off.
 *
 * On a stop this puts the camera back on the last pose a frame was drawn
 * with, discards the input that was being applied (Cesium skips its own reset
 * when the frame throws, so the same gesture would otherwise run again), and
 * turns the loop back on. After RECOVERY_LIMIT restarts inside
 * RECOVERY_WINDOW_MS the error is shown as before and rendering stays stopped.
 * @param {Cesium.Viewer} viewer
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {(reason: string) => void} [options.requestRender]
 * @returns {() => void} Idempotent disposer.
 */
export function installRenderRecovery(
  viewer,
  { now = () => performance.now(), requestRender = governorRequestRender } = {},
) {
  const widget = viewer?.cesiumWidget;
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  if (!widget?.showErrorPanel || !scene?.postRender || !camera)
    throw new TypeError('A complete Cesium viewer is required');

  // The pose of the last frame that drew: three vector copies a frame.
  const position = new Cesium.Cartesian3();
  const direction = new Cesium.Cartesian3();
  const up = new Cesium.Cartesian3();
  let hasPose = false;
  const removePostRender = scene.postRender.addEventListener(() => {
    if (!finite(camera.position) || !finite(camera.direction)) return;
    Cesium.Cartesian3.clone(camera.position, position);
    Cesium.Cartesian3.clone(camera.direction, direction);
    Cesium.Cartesian3.clone(camera.up, up);
    hasPose = true;
  });

  const recoveredAt = [];
  const own = Object.hasOwn(widget, 'showErrorPanel');
  const showErrorPanel = widget.showErrorPanel;
  const recovering = function (title, message, error) {
    const at = now();
    while (recoveredAt.length && at - recoveredAt[0] > RECOVERY_WINDOW_MS)
      recoveredAt.shift();
    // Only a stopped loop is restarted; other panels (a failed start-up, a
    // caller's own message) are shown as they are.
    if (
      viewer.useDefaultRenderLoop !== false ||
      recoveredAt.length >= RECOVERY_LIMIT
    )
      return showErrorPanel.call(this, title, message, error);
    recoveredAt.push(at);
    console.error(
      `[viewer] render loop stopped by an error; restarting (${recoveredAt.length} of ${RECOVERY_LIMIT})`,
      error,
    );
    if (hasPose) {
      Cesium.Cartesian3.clone(position, camera.position);
      Cesium.Cartesian3.clone(direction, camera.direction);
      Cesium.Cartesian3.clone(up, camera.up);
      Cesium.Cartesian3.cross(camera.direction, camera.up, camera.right);
    }
    // Cesium has no public way to drop the input a failed frame left queued.
    scene.screenSpaceCameraController?._aggregator?.reset?.();
    viewer.useDefaultRenderLoop = true;
    requestRender('render-recovery');
  };
  widget.showErrorPanel = recovering;

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    removePostRender?.();
    if (widget.showErrorPanel !== recovering) return;
    if (own) widget.showErrorPanel = showErrorPanel;
    else delete widget.showErrorPanel;
  };
}
