/**
 * Detection Projection Web Worker
 *
 * Moves the O(n) screen projection loop off the main thread.
 * Handles: view-projection transform, horizon occlusion, distance computation.
 * Path2D bracket appending stays on main thread (Canvas2D is main-thread-only).
 *
 * Input message: {
 *   objects: Array<{
 *     id: string|number,
 *     type: string,           // 'AIR' | 'Vessel' | etc.
 *     skipLabel: boolean,
 *     position: {x, y, z},
 *     distanceScale?: number  // for AIR type scaling
 *   }>,
 *   viewProjection: {
 *     vp0, vp1, vp2, vp3, vp4, vp5, vp6, vp7, vp8, vp9, vp10, vp11, vp12, vp13, vp14, vp15
 *   },
 *   cameraPosition: {x, y, z},
 *   width: number,
 *   height: number,
 *   camPos: {x, y, z},
 *   occluderCameraPos: {x, y, z},
 *   requestId: number
 * }
 *
 * Output message: {
 *   results: Array<{
 *     id, sx, sy, visible, distance, halfW, halfH, type, skipLabel
 *   }>,
 *   requestId: number
 * }
 */

export {}; // make this file a module so its block-scoped constants are isolated

// WGS84 ellipsoid constants (matching Cesium Ellipsoid.WGS84)
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_A2 = WGS84_A * WGS84_A;
const WGS84_B2 = WGS84_B * WGS84_B;
const WGS84_A2_INV = 1 / WGS84_A2;
const WGS84_B2_INV = 1 / WGS84_B2;

// Billboard scale-by-distance constants (must match detection.js)
const BILL_NEAR = 1000;
const BILL_NEAR_SCALE = 3.0;
const BILL_FAR = 8000000;
const BILL_FAR_SCALE = 0.5;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface DetectionObject {
  id: string | number;
  type: string;
  skipLabel: boolean;
  position: Vec3 | null;
  distanceScale?: number;
}

interface ViewProjection {
  vp0: number; vp1: number; vp2: number; vp3: number;
  vp4: number; vp5: number; vp6: number; vp7: number;
  vp8: number; vp9: number; vp10: number; vp11: number;
  vp12: number; vp13: number; vp14: number; vp15: number;
}

interface DetectionProjectionMessage {
  objects: DetectionObject[];
  viewProjection: ViewProjection;
  cameraPosition: Vec3;
  width: number;
  height: number;
  camPos: Vec3;
  occluderCameraPos: Vec3;
  requestId: number;
}

interface ProjectionResult {
  id: string | number;
  sx: number;
  sy: number;
  visible: boolean;
  distance: number;
  halfW: number;
  halfH: number;
  type: string;
  skipLabel: boolean;
}

/**
 * Clamp a value to [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Near-far scale for AIR reticles (same curve as flight billboards).
 * Returns a multiplier that grows the bracket as you zoom in.
 */
function nearFarScale(dist: number, near: number, nearScale: number, far: number, farScale: number): number {
  if (dist <= near) return nearScale;
  if (dist >= far) return farScale;
  const t = (dist - near) / (far - near);
  return nearScale + (farScale - nearScale) * t;
}

interface SurfaceNormal { nx: number; ny: number; nz: number; mag: number; }

/**
 * Cesium EllipsoidalOccluder.isPointVisible — pure JS reimplementation.
 * A point is visible if dot(normalize(cameraToPoint), downwardAtPoint) >
 * (cameraHeight / (cameraHeight + ellipsoidRadiiSquared.z))
 */
function computeSurfaceNormal(x: number, y: number, z: number): SurfaceNormal {
  const nx = x * WGS84_A2_INV;
  const ny = y * WGS84_A2_INV;
  const nz = z * WGS84_B2_INV;
  const mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return { nx: nx / mag, ny: ny / mag, nz: nz / mag, mag };
}

function ellipsoidalIsPointVisible(camX: number, camY: number, camZ: number, px: number, py: number, pz: number): boolean {
  const dx = px - camX;
  const dy = py - camY;
  const dz = pz - camZ;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist === 0) return true;

  const invDist = 1 / dist;
  const dirX = dx * invDist;
  const dirY = dy * invDist;
  const dirZ = dz * invDist;

  const { nx, ny, nz } = computeSurfaceNormal(px, py, pz);
  const dot = dirX * nx + dirY * ny + dirZ * nz;

  const { mag: camDist } = computeSurfaceNormal(camX, camY, camZ);
  const cameraHeight = camDist - Math.sqrt(
    (camX * camX / WGS84_A2) + (camY * camY / WGS84_A2) + (camZ * camZ / WGS84_B2),
  );
  const threshold = cameraHeight / (cameraHeight + WGS84_B);

  return dot > threshold;
}

self.onmessage = (e: MessageEvent<DetectionProjectionMessage>) => {
  const {
    objects,
    viewProjection,
    camPos,
    occluderCameraPos,
    width,
    height,
    requestId,
  } = e.data;

  const {
    vp0, vp1, vp3, vp4, vp5, vp7, vp8, vp9, vp11, vp12, vp13, vp15,
  } = viewProjection;

  const cx = occluderCameraPos.x;
  const cy = occluderCameraPos.y;
  const cz = occluderCameraPos.z;

  const results: ProjectionResult[] = [];

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    const pos = obj.position;
    if (!pos) continue;

    const { x: px, y: py, z: pz } = pos;

    // Horizon occlusion test
    if (!ellipsoidalIsPointVisible(cx, cy, cz, px, py, pz)) {
      results.push({ id: obj.id, visible: false, sx: 0, sy: 0, distance: 0, halfW: 0, halfH: 0, type: obj.type, skipLabel: obj.skipLabel });
      continue;
    }

    // View-projection clipping
    const clipW = vp3 * px + vp7 * py + vp11 * pz + vp15;
    if (clipW <= 0) {
      results.push({ id: obj.id, visible: false, sx: 0, sy: 0, distance: 0, halfW: 0, halfH: 0, type: obj.type, skipLabel: obj.skipLabel });
      continue;
    }

    const invW = 1 / clipW;
    const sx = ((vp0 * px + vp4 * py + vp8 * pz + vp12) * invW * 0.5 + 0.5) * width;
    const sy = (0.5 - (vp1 * px + vp5 * py + vp9 * pz + vp13) * invW * 0.5) * height;

    // Distance from camera
    const dx = px - camPos.x;
    const dy = py - camPos.y;
    const dz = pz - camPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Compute bracket half-sizes (same logic as detection.js main thread)
    const isTracked = obj.skipLabel;
    let halfW: number;
    let halfH: number;
    if (obj.type === 'AIR') {
      const bscale = nearFarScale(distance, BILL_NEAR, BILL_NEAR_SCALE, BILL_FAR, BILL_FAR_SCALE);
      halfW = clamp((isTracked ? 14 : 9) * bscale, 7, 48);
      halfH = clamp((isTracked ? 11 : 7) * bscale, 5, 38);
    } else {
      // MODE_DENSE detection.js: isTracked?28:11 / isTracked?22:7; default: 16/10
      // Worker doesn't have access to _mode, so use default values (16/10)
      // Detection 100% DENSE path is not the common case; the perf win is SPARSE/BALANCED
      halfW = isTracked ? 28 : 16;
      halfH = isTracked ? 22 : 10;
    }

    results.push({ id: obj.id, visible: true, sx, sy, distance, halfW, halfH, type: obj.type, skipLabel: obj.skipLabel });
  }

  self.postMessage({ results, requestId });
};
