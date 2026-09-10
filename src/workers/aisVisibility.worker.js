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
const WGS84_A2 = WGS84_A * WGS84_A;
const WGS84_B2 = WGS84_B * WGS84_B;
const WGS84_A2_INV = 1 / WGS84_A2;
const WGS84_B2_INV = 1 / WGS84_B2;

/**
 * Compute the outward surface normal at a point on the WGS84 ellipsoid.
 * @param {number} x @param {number} y @param {number} z
 * @returns {{nx: number, ny: number, nz: number, mag: number}}
 */
function computeSurfaceNormal(x, y, z) {
  const nx = x * WGS84_A2_INV;
  const ny = y * WGS84_A2_INV;
  const nz = z * WGS84_B2_INV;
  const mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return { nx: nx / mag, ny: ny / mag, nz: nz / mag, mag };
}

/**
 * EllipsoidalOccluder.isPointVisible — returns true if the point is above the horizon
 * as seen from the camera position.
 *
 * From Cesium EllipsoidalOccluder.js:
 * A point is visible if dot(normalize(cameraToPoint), downwardAtPoint) >
 * (cameraHeight / (cameraHeight + ellipsoidRadiiSquared.z))
 *
 * @param {number} camX @param {number} camY @param {number} camZ  — camera position
 * @param {number} px @param {number} py @param {number} pz        — surface position
 * @returns {boolean}
 */
function isPointVisible(camX, camY, camZ, px, py, pz) {
  // Camera to point vector
  const dx = px - camX;
  const dy = py - camY;
  const dz = pz - camZ;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist === 0) return true; // camera at point — visible

  const invDist = 1 / dist;
  // Normalized direction from camera to point
  const dirX = dx * invDist;
  const dirY = dy * invDist;
  const dirZ = dz * invDist;

  // Surface normal at the point
  const { nx, ny, nz } = computeSurfaceNormal(px, py, pz);

  // Dot product — positive means point is "above" the local horizon
  const dot = dirX * nx + dirY * ny + dirZ * nz;

  // Camera height above ellipsoid at camera position
  const { mag: camDist } = computeSurfaceNormal(camX, camY, camZ);
  const cameraHeight = camDist - Math.sqrt(
    (camX * camX / WGS84_A2) + (camY * camY / WGS84_A2) + (camZ * camZ / WGS84_B2)
  );

  // Visibility threshold from Cesium
  const threshold = cameraHeight / (cameraHeight + WGS84_B);

  return dot > threshold;
}

self.onmessage = (e) => {
  const { positions, cameraPosition, requestId } = e.data;

  const { x: camX, y: camY, z: camZ } = cameraPosition;
  const visible = new Uint8Array(positions.length);

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    visible[i] = isPointVisible(camX, camY, camZ, pos.x, pos.y, pos.z) ? 1 : 0;
  }

  self.postMessage({ visible, requestId }, [visible.buffer]);
};
