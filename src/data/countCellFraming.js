import { distance } from '../geo/vector.js';
import { toLonLatH } from '../geo/ellipsoid.js';
import { cameraOf, canvasOf } from '../render/rendererOf.js';
import { rangeForBoundingSphere } from './cameraFraming.js';
import { cellBounds, cellCenter, cellHalfExtents } from './countCells.js';

/** The nearest ground cell with two or more points, or the group itself if unmerged. */
function nearestPart(cell, eye) {
  let nearest = cell;
  let best = Infinity;
  for (const part of cell.parts ?? []) {
    if (part.count < 2) continue;
    const d = distance(eye, cellCenter(part));
    if (d < best) {
      best = d;
      nearest = part;
    }
  }
  return nearest;
}

/**
 * Fly to frame a count marker's group from above, including coincident
 * points. `cellPx` and `minCellM` are the caller's grouping: cells about
 * `cellPx` across on screen, never grouped below `minCellM` metres. The
 * flight ends at least as close as half that no-grouping range, so even
 * coincident points split, and never further than halfway to the group, so
 * every click gets closer. `onComplete` and `onCancel` pass to the flight.
 * @param {object} viewer
 * @param {object} cell A count cell (src/data/countCells.js).
 * @param {{cellPx: number, minCellM: number, onComplete?: Function, onCancel?: Function}} options
 * @returns {void}
 */
export function flyToCountCell(
  viewer,
  cell,
  { cellPx, minCellM, onComplete, onCancel },
) {
  const camera = cameraOf(viewer);
  const pose = camera.pose();
  const tanHalfY = Math.tan((pose.fovy || Math.PI / 3) / 2);
  const canvas = canvasOf(viewer);
  const height = canvas?.clientHeight || canvas?.height || 1;
  // Half the range where cells stop grouping, so even coincident points split.
  const closeRange = (minCellM * height) / (4 * cellPx * tanHalfY);
  const tanHalfX = tanHalfY * (pose.aspectRatio || 1);
  // Range where a cell's ground extent, times `pad`, fits the frame at the
  // depth of its highest point above the bounds centre.
  const extentRange = (target, bounds, pad = 1) => {
    const { halfWidthM, halfHeightM } = cellHalfExtents(target);
    const rise = Math.max(0, target.high - toLonLatH(bounds.center).height);
    return rise + pad * Math.max(halfWidthM / tanHalfX, halfHeightM / tanHalfY);
  };
  // The sphere fit spans the wider side, so a very wide window also needs the extent.
  const fitRange = (target, bounds) =>
    Math.max(
      closeRange,
      rangeForBoundingSphere(viewer, bounds.radius),
      extentRange(target, bounds, 1.2),
    );
  // Approach long groups in halves so every click gets closer.
  const halfway = (bounds) =>
    pose.position ? distance(pose.position, bounds.center) / 2 : Infinity;
  let bounds = cellBounds(cell);
  let range = Math.min(halfway(bounds), fitRange(cell, bounds));
  // If the group overflows the frame at that range, approach its nearest counted cell.
  if (range < extentRange(cell, bounds)) {
    const part = nearestPart(cell, pose.position);
    bounds = cellBounds(part);
    range = Math.min(halfway(bounds), fitRange(part, bounds));
  }
  camera.flyToBounds(bounds, {
    offset: { heading: 0, pitch: -Math.PI / 2, range },
    durationS: 1.2,
    easing: 'cubicInOut',
    ...(onComplete ? { onComplete } : {}),
    ...(onCancel ? { onCancel } : {}),
  });
}
