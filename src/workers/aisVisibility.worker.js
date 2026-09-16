/**
 * AIS Visibility Web Worker
 *
 * Moves the 12k vessel horizon occlusion + rotation computation off the main thread.
 * Implements Cesium's EllipsoidalOccluder.isPointVisible in plain JS — no Cesium dependency.
 *
 * Input message: {
 *   positions: Array<{x: number, y: number, z: number}>,  // vessel surface positions
 *   cameraPosition: {x: number, y: number, z: number},    // camera world coords
 *   requestId: number                                      // for matching requests to responses
 * }
 *
 * Output message: {
 *   visible: Uint8Array,   // 1 = visible, 0 = occluded (TypedArray for efficiency)
 *   requestId: number
 * }
 */

// WGS84 ellipsoid semi-axes (meters)
const WGS84_A = 6378137.0;        // equatorial radius
const WGS84_F = 1 / 298.257223563; // flattening
const WGS84_B = WGS84_A * (1 - WGS84_F); // polar radius

/**
 * EllipsoidalOccluder.isPointVisible — exact port of Cesium's scaled-space
 * horizon test (`isScaledSpacePointVisible`): divide all positions by the
 * ellipsoid radii so the ellipsoid becomes the unit sphere, then a point is
 * occluded iff the camera→point ray passes the horizon cone.
 *
 * History: an earlier port used `dot(dir, normal) > h/(h+B)` with a
 * dimensionally-broken "camera height", which degenerated to `dot > 0` —
 * the OCCLUDED hemisphere — so the worker returned exactly inverted results
 * versus the main-thread Cesium occluder it was replacing (found 2026-09-13
 * by src/workers/aisVisibility.worker.test.mjs).
 *
 * @param {number} camX - Camera world X (metres).
 * @param {number} camY - Camera world Y (metres).
 * @param {number} camZ - Camera world Z (metres).
 * @param {number} px - Surface point X (metres).
 * @param {number} py - Surface point Y (metres).
 * @param {number} pz - Surface point Z (metres).
 * @returns {boolean}
 */
function isPointVisible(camX, camY, camZ, px, py, pz) {
  // Scaled space: camera and point on/above the unit sphere.
  const cvx = camX / WGS84_A;
  const cvy = camY / WGS84_A;
  const cvz = camZ / WGS84_B;
  const ptx = px / WGS84_A;
  const pty = py / WGS84_A;
  const ptz = pz / WGS84_B;

  // Horizon "distance to limb" in scaled space (≥ 0 for a camera above the surface).
  const vh = cvx * cvx + cvy * cvy + cvz * cvz - 1;

  const vtx = ptx - cvx;
  const vty = pty - cvy;
  const vtz = ptz - cvz;
  const vtDotVc = -(vtx * cvx + vty * cvy + vtz * cvz);

  const occluded = vh < 0
    ? vtDotVc > 0 // camera below the surface: only the far hemisphere is hidden
    : vtDotVc > vh
      && (vtDotVc * vtDotVc) / (vtx * vtx + vty * vty + vtz * vtz) > vh;

  return !occluded;
}

self.addEventListener('message', (e) => {
  const { positions, cameraPosition, requestId } = e.data;

  const { x: camX, y: camY, z: camZ } = cameraPosition;
  const visible = new Uint8Array(positions.length);

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    visible[i] = isPointVisible(camX, camY, camZ, pos.x, pos.y, pos.z) ? 1 : 0;
  }

  self.postMessage({ visible, requestId }, [visible.buffer]);
});
