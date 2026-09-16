/**
 * Detection Projection Web Worker
 *
 * Moves the O(n) screen projection loop off the main thread.
 * Handles: view-projection transform, horizon occlusion, distance computation.
 * Path2D bracket appending stays on main thread (Canvas2D is main-thread-only).
 *
 * Main-thread contract (src/data/detection.js): at most one request is
 * unanswered at a time, and an answer is reused only while the scene is
 * bit-identical to the request (projectionRequestMatches). The halfW/halfH
 * sizes computed here are ADVISORY — the consumer derives sizes through its
 * own mode-aware helper because this worker cannot see the DENSE profile.
 *
 * Input message: {
 *   objectsById: Map<id, {            // keyed by the caller's stable per-object
 *     id: string|number,              // identity hash; echoed verbatim per row —
 *                                     // cohort order may permute between frames
 *     type: string,                   // 'AIR' | 'Vessel' | etc.
 *     skipLabel: boolean,
 *     position: {x, y, z},
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
 *
 * WGS84 ellipsoid constants (matching Cesium Ellipsoid.WGS84)
 */
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

// Billboard scale-by-distance constants (must match detection.js)
const BILL_NEAR = 1000;
const BILL_NEAR_SCALE = 3.0;
const BILL_FAR = 8000000;
const BILL_FAR_SCALE = 0.5;

/**
 * Clamp a value to [min, max].
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Near-far scale for AIR reticles (same curve as flight billboards).
 * Returns a multiplier that grows the bracket as you zoom in.
 */
function nearFarScale(dist, near, nearScale, far, farScale) {
  if (dist <= near) return nearScale;
  if (dist >= far) return farScale;
  const t = (dist - near) / (far - near);
  return nearScale + (farScale - nearScale) * t;
}

/**
 * Cesium EllipsoidalOccluder.isPointVisible — exact port of the scaled-space
 * horizon test (`isScaledSpacePointVisible`): divide all positions by the
 * ellipsoid radii so the ellipsoid becomes the unit sphere, then test the
 * camera→point ray against the horizon cone.
 *
 * History: an earlier port used `dot(dir, normal) > h/(h+B)` with a
 * dimensionally-broken "camera height" that degenerated to `dot > 0` — the
 * OCCLUDED hemisphere — inverting results versus the main-thread Cesium
 * occluder (found 2026-09-13 by src/workers/detectionProjection.worker.test.mjs).
 */
function ellipsoidalIsPointVisible(camX, camY, camZ, px, py, pz) {
  const cvx = camX / WGS84_A;
  const cvy = camY / WGS84_A;
  const cvz = camZ / WGS84_B;
  const ptx = px / WGS84_A;
  const pty = py / WGS84_A;
  const ptz = pz / WGS84_B;

  const vh = cvx * cvx + cvy * cvy + cvz * cvz - 1;

  const vtx = ptx - cvx;
  const vty = pty - cvy;
  const vtz = ptz - cvz;
  const vtDotVc = -(vtx * cvx + vty * cvy + vtz * cvz);

  const occluded = vh < 0
    ? vtDotVc > 0
    : vtDotVc > vh
      && (vtDotVc * vtDotVc) / (vtx * vtx + vty * vty + vtz * vtz) > vh;

  return !occluded;
}

self.addEventListener('message', (e) => {
  const {
    objectsById,
    viewProjection,
    cameraPosition: _cameraPosition,
    width,
    height,
    camPos,
    occluderCameraPos,
    requestId,
  } = e.data;

  const {
    vp0, vp1, vp3, vp4, vp5, vp7, vp8, vp9, vp11, vp12, vp13, vp15,
  } = viewProjection;

  const cx = occluderCameraPos.x;
  const cy = occluderCameraPos.y;
  const cz = occluderCameraPos.z;

  const results = [];

  for (const obj of objectsById.values()) {
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
    let halfW, halfH;
    if (obj.type === 'AIR') {
      const bscale = nearFarScale(distance, BILL_NEAR, BILL_NEAR_SCALE, BILL_FAR, BILL_FAR_SCALE);
      halfW = clamp((isTracked ? 14 : 9) * bscale, 7, 48);
      halfH = clamp((isTracked ? 11 : 7) * bscale, 5, 38);
    } else {
      // Non-AIR sizes assume the non-DENSE profile — the worker cannot see
      // _mode, and the consumer re-derives sizes through its own mode-aware
      // helper anyway (these rows are advisory).
      halfW = isTracked ? 28 : 16;
      halfH = isTracked ? 22 : 10;
    }

    results.push({ id: obj.id, visible: true, sx, sy, distance, halfW, halfH, type: obj.type, skipLabel: obj.skipLabel });
  }

  self.postMessage({ results, requestId });
});
