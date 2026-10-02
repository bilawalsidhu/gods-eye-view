/**
 * Path import: bring a long recorded track under a vertex ceiling.
 *
 * A GPS logger writes a point a second, so a day's hike is tens of thousands of
 * points, nearly all of them on a straight line between their neighbours. The
 * board draws a mark as one draped polyline, and nothing about a track at globe
 * or valley scale needs more than a couple of thousand vertices.
 *
 * Visvalingam–Whyatt: every interior point is scored by the area of the
 * triangle it makes with its two neighbours — how much the line would move if
 * the point were gone — and the least significant point is removed, repeatedly,
 * until the path fits. That keeps the switchbacks and corners and drops the
 * points that lie on the line anyway, which a uniform every-Nth sample gets
 * exactly backwards. It is also O(n log n) whatever the input looks like; the
 * better-known Douglas–Peucker is quadratic on a zigzag, and an imported file
 * is not input anyone here chose.
 *
 * No Cesium, no DOM.
 */

/**
 * Once a path is being simplified at all, points that move the line by less
 * than this (square metres of triangle) go too: they are GPS jitter on a
 * straight leg, not shape.
 */
const NEGLIGIBLE_AREA_M2 = 1;

/**
 * @param {Array<[number, number]>} points [lon, lat] pairs, all finite.
 * @param {number} maxPoints Ceiling on the returned length (at least 2).
 * @returns {Array<[number, number]>} The same array when it already fits;
 *   otherwise a new one, in order, that keeps the first and last points.
 */
export function simplifyPath(points, maxPoints) {
  const limit = Math.max(2, Math.floor(Number(maxPoints) || 0));
  if (!Array.isArray(points) || points.length <= limit) return points;

  const count = points.length;
  const { xs, ys } = project(points);
  const prev = new Int32Array(count);
  const next = new Int32Array(count);
  const area = new Float64Array(count);
  const removed = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  const triangle = (i) =>
    Math.abs(
      (xs[prev[i]] - xs[i]) * (ys[next[i]] - ys[i]) -
        (xs[next[i]] - xs[i]) * (ys[prev[i]] - ys[i]),
    ) / 2;

  // Binary min-heap of interior point indices, ordered by current area. An
  // entry whose point was rescored since it was pushed is stale; it is
  // recognised on the way out by its recorded area and skipped.
  const heapIndex = [];
  const heapArea = [];
  const push = (index, value) => {
    let at = heapIndex.length;
    heapIndex.push(index);
    heapArea.push(value);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (heapArea[parent] <= heapArea[at]) break;
      swap(heapIndex, heapArea, parent, at);
      at = parent;
    }
  };
  const pop = () => {
    const top = [heapIndex[0], heapArea[0]];
    const lastIndex = heapIndex.pop();
    const lastArea = heapArea.pop();
    if (heapIndex.length) {
      heapIndex[0] = lastIndex;
      heapArea[0] = lastArea;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let least = at;
        if (left < heapArea.length && heapArea[left] < heapArea[least])
          least = left;
        if (right < heapArea.length && heapArea[right] < heapArea[least])
          least = right;
        if (least === at) break;
        swap(heapIndex, heapArea, least, at);
        at = least;
      }
    }
    return top;
  };

  for (let i = 1; i < count - 1; i += 1) {
    area[i] = triangle(i);
    push(i, area[i]);
  }

  let remaining = count;
  while (heapIndex.length) {
    const [index, value] = pop();
    if (removed[index] || value !== area[index]) continue; // stale entry
    if (remaining <= limit && value >= NEGLIGIBLE_AREA_M2) break;
    removed[index] = 1;
    remaining -= 1;
    const before = prev[index];
    const after = next[index];
    next[before] = after;
    prev[after] = before;
    // A neighbour's significance never drops below the point just removed, so
    // removing a run of small points cannot quietly erase a large feature.
    for (const neighbour of [before, after]) {
      if (neighbour <= 0 || neighbour >= count - 1) continue;
      area[neighbour] = Math.max(triangle(neighbour), value);
      push(neighbour, area[neighbour]);
    }
  }

  return points.filter((_, index) => !removed[index]);
}

function swap(indices, areas, a, b) {
  const index = indices[a];
  indices[a] = indices[b];
  indices[b] = index;
  const value = areas[a];
  areas[a] = areas[b];
  areas[b] = value;
}

/**
 * Local metre grid around the path: longitudes made continuous from the first
 * point (so a track across the antimeridian is not 360° wide) and scaled by the
 * cosine of the mean latitude.
 */
function project(points) {
  const reference = points[0][0];
  let latSum = 0;
  for (const point of points) latSum += point[1];
  const kx = 111320 * Math.cos(((latSum / points.length) * Math.PI) / 180);
  const ky = 111320;
  const xs = new Float64Array(points.length);
  const ys = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    let lon = points[i][0];
    while (lon - reference > 180) lon -= 360;
    while (lon - reference < -180) lon += 360;
    xs[i] = lon * kx;
    ys[i] = points[i][1] * ky;
  }
  return { xs, ys };
}
