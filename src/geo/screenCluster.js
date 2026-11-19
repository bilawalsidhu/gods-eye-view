/**
 * @module geo/screenCluster
 * @description Screen-space clustering of points, as the default renderer's
 * entity clustering groups them: each point not yet in a cluster, in order,
 * takes every unclustered point whose screen position falls inside its own
 * box (its pixel size grown by `pixelRange` on every side) into a cluster at
 * the mean of their world positions, when they number at least
 * `minimumClusterSize`. On a pass made closer to the ground than the last
 * one, each cluster of the last pass that is still above the horizon first
 * keeps the points inside its box, shrunk by how much closer the eye came
 * (never below the box it was seeded with); only then are new ones seeded.
 *
 * The coordinates follow that renderer's choices so that the clusters are
 * the same ones: points are boxed in window coordinates measured from the
 * bottom (`height - y`), a last pass's clusters from the top, and a kept
 * cluster's box reaches half its width left and up but its whole width
 * right and down.
 */

import KDBush from 'kdbush';

/**
 * @typedef {object} ScreenClusterPoint
 * @property {string} id
 * @property {{x: number, y: number, z: number}} position World position.
 * @property {{x: number, y: number}} screen CSS pixels from the top left.
 * @property {number} pixelSize Its drawn size, CSS pixels.
 */

/**
 * @typedef {object} ScreenClusterState What a pass leaves for the next.
 * @property {Array<{position: {x: number, y: number, z: number},
 *   width: number, height: number, minimumWidth: number,
 *   minimumHeight: number}>} clusters
 * @property {number} height The eye's height above the ground at that pass.
 */

/**
 * Cluster `points` (those shown, above the horizon and in front of the eye,
 * in their drawing order).
 * @param {object} options
 * @param {ScreenClusterPoint[]} options.points
 * @param {number} options.pixelRange
 * @param {number} options.minimumClusterSize
 * @param {number} options.viewHeight The view's height, CSS pixels.
 * @param {number} options.eyeHeight The eye's height above the ground, m.
 * @param {ScreenClusterState|null} [options.previous] The last pass's state.
 * @param {(position: object) => ({x: number, y: number}|null)} options.project
 *   Window position of a world position, CSS pixels from the top left
 *   (null behind the eye).
 * @param {(position: object) => boolean} options.isOccluded Whether the
 *   ellipsoid's horizon hides a world position.
 * @returns {{clusters: Array<{position: {x: number, y: number, z: number},
 *   ids: string[]}>, single: string[], state: ScreenClusterState}}
 *   The clusters (each with its points' ids, its seed first), the ids of the
 *   points left on their own, and the state for the next pass.
 */
export function clusterScreenPoints({
  points,
  pixelRange,
  minimumClusterSize,
  viewHeight,
  eyeHeight,
  previous = null,
  project,
  isOccluded,
}) {
  const n = points.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i].screen.x;
    ys[i] = viewHeight - points[i].screen.y;
  }
  const clustered = new Uint8Array(n);
  const index = createIndex(xs, ys);
  const clusters = [];
  const kept = [];

  if (n > 0 && previous && eyeHeight < previous.height) {
    const factor = 1 - eyeHeight / previous.height;
    for (const cluster of previous.clusters) {
      if (isOccluded(cluster.position)) continue;
      const coord = project(cluster.position);
      if (!coord) continue;
      cluster.width *= factor;
      cluster.height *= factor;
      const width = Math.max(cluster.width, cluster.minimumWidth);
      const height = Math.max(cluster.height, cluster.minimumHeight);
      const neighbors = index.range(
        coord.x - width * 0.5,
        coord.y - height * 0.5,
        coord.x + width,
        coord.y + height,
      );
      const ids = [];
      for (const j of neighbors) if (!clustered[j]) ids.push(points[j].id);
      if (ids.length >= minimumClusterSize) {
        clusters.push({ position: { ...cluster.position }, ids });
        kept.push(cluster);
        for (const j of neighbors) clustered[j] = 1;
      }
    }
  }

  const single = [];
  for (let i = 0; i < n; i++) {
    if (clustered[i]) continue;
    clustered[i] = 1;
    const seed = points[i];
    const box = pointBox(xs[i], ys[i], seed.pixelSize, pixelRange);
    let minX = box.x;
    let minY = box.y;
    let maxX = box.x + box.width;
    let maxY = box.y + box.height;
    const neighbors = index.range(
      box.x,
      box.y,
      box.x + box.width,
      box.y + box.height,
    );
    const sum = { x: seed.position.x, y: seed.position.y, z: seed.position.z };
    const ids = [seed.id];
    for (const j of neighbors) {
      if (clustered[j]) continue;
      const other = points[j];
      const near = pointBox(xs[j], ys[j], other.pixelSize, pixelRange);
      sum.x += other.position.x;
      sum.y += other.position.y;
      sum.z += other.position.z;
      minX = Math.min(minX, near.x);
      minY = Math.min(minY, near.y);
      maxX = Math.max(maxX, near.x + near.width);
      maxY = Math.max(maxY, near.y + near.height);
      ids.push(other.id);
    }
    if (ids.length >= minimumClusterSize) {
      const position = {
        x: sum.x / ids.length,
        y: sum.y / ids.length,
        z: sum.z / ids.length,
      };
      clusters.push({ position, ids });
      kept.push({
        position,
        width: maxX - minX,
        height: maxY - minY,
        minimumWidth: box.width,
        minimumHeight: box.height,
      });
      for (const j of neighbors) clustered[j] = 1;
    } else single.push(seed.id);
  }

  return { clusters, single, state: { clusters: kept, height: eyeHeight } };
}

/** A point's box: its drawn square grown by `pixelRange` on every side. */
function pointBox(x, y, size, pixelRange) {
  return {
    x: x - size * 0.5 - pixelRange,
    y: y - size * 0.5 - pixelRange,
    width: size + pixelRange * 2,
    height: size + pixelRange * 2,
  };
}

/**
 * The points' index: a KDBush tree built as the reference renderer's entity
 * clustering builds it (64 per node, 64-bit coordinates), so a range query
 * lists the same points in the same order and a cluster kept from the last
 * pass names the same station first.
 */
function createIndex(xs, ys) {
  if (!xs.length) return { range: () => [] };
  const index = new KDBush(xs.length, 64, Float64Array);
  for (let i = 0; i < xs.length; i++) index.add(xs[i], ys[i]);
  index.finish();
  return index;
}
