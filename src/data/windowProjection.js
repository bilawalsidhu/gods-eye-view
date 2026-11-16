import * as Cesium from 'cesium';

/**
 * A projector from world positions to window coordinates for one pass over
 * many positions under one camera, giving what
 * `Cesium.SceneTransforms.worldToWindowCoordinates` gives: in a 3D scene with
 * a perspective camera it runs the same arithmetic in the same order once the
 * camera's matrices and the canvas size are read, so the results are the same
 * numbers; otherwise it asks Cesium for each.
 *
 * Read the camera again (a new projector) whenever it may have moved.
 * @param {Cesium.Scene} scene
 * @returns {(position: Cesium.Cartesian3, result: Cesium.Cartesian2) =>
 *   Cesium.Cartesian2|undefined} The window position in `result`, or
 *   undefined behind the camera.
 */
export function createWindowProjector(scene) {
  const camera = scene?.camera;
  const frustum = camera?.frustum;
  if (
    scene?.frameState?.mode !== Cesium.SceneMode.SCENE3D ||
    !camera ||
    frustum instanceof Cesium.OrthographicFrustum ||
    frustum instanceof Cesium.OrthographicOffCenterFrustum
  )
    return (position, result) =>
      Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, result);
  const v = camera.viewMatrix;
  const p = frustum.projectionMatrix;
  const width = scene.canvas.clientWidth;
  const height = scene.canvas.clientHeight;
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  return (position, result) => {
    if (!position)
      return Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        position,
        result,
      );
    const { x, y, z } = position;
    // Eye coordinates, as Matrix4.multiplyByVector computes them (w = 1).
    const ex = v[0] * x + v[4] * y + v[8] * z + v[12];
    const ey = v[1] * x + v[5] * y + v[9] * z + v[13];
    const ez = v[2] * x + v[6] * y + v[10] * z + v[14];
    const ew = v[3] * x + v[7] * y + v[11] * z + v[15];
    // At the eye itself Cesium's own steps have no direction to take.
    if (ex === 0 && ey === 0 && ez === 0)
      return Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        position,
        result,
      );
    // Clip coordinates.
    const cx = p[0] * ex + p[4] * ey + p[8] * ez + p[12] * ew;
    const cy = p[1] * ex + p[5] * ey + p[9] * ez + p[13] * ew;
    const cz = p[2] * ex + p[6] * ey + p[10] * ez + p[14] * ew;
    const cw = p[3] * ex + p[7] * ey + p[11] * ez + p[15] * ew;
    if (cz < 0) return undefined;
    // The viewport transform of the canvas, then window y downward.
    result.x = halfWidth * (cx / cw) + halfWidth;
    result.y = height - (halfHeight * (cy / cw) + halfHeight);
    return result;
  };
}
