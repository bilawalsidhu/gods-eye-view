/**
 * @file Even-odd scanline rasterizer: GSHHG polygons -> three-state mask grid.
 *
 * Levels fill in ascending order with parity by level (L1/L3/L5 land, L2/L4
 * water). Every real shoreline edge additionally marks the cells it passes
 * through as coastal, and coastal wins over any interior fill — a sub-cell
 * island therefore rasterizes as coastal-only. Ring longitudes are unwrapped
 * into a continuous sequence and interior columns are written mod width, so
 * dateline- and Greenwich-crossing rings need no special casing. A ring whose
 * closing edge carries a net +-360 offset encircles a pole (Antarctica ice
 * front is the only such ring in GSHHG); it is closed through the south pole
 * with artificial seam edges that fill but never mark coastal.
 *
 * @module data/gshhg/rasterizeMask
 */

import {
  MASK_COASTAL,
  MASK_LAND,
  MASK_WATER,
  wrapLon,
} from '../landSeaMaskCodec.js';

/** Fill parity by GSHHG level: land, lake, island-in-lake, pond, ice front. */
const LEVEL_FILL = new Map([
  [1, MASK_LAND],
  [2, MASK_WATER],
  [3, MASK_LAND],
  [4, MASK_WATER],
  [5, MASK_LAND],
]);

/**
 * Unwraps a ring's longitudes: each vertex is wrapLon-normalized, then kept
 * continuous by undoing any consecutive jump > 180 deg with a +-360 shift.
 * `net` is the closing offset in whole turns — 0 for an ordinary ring, +-1
 * for a ring that encircles a pole.
 * @param {Float64Array} points - [lon0, lat0, lon1, lat1, ...] degrees.
 * @returns {{lons: Float64Array, lats: Float64Array, net: number}}
 */
function unwrapRing(points) {
  const n = points.length / 2;
  const lons = new Float64Array(n);
  const lats = new Float64Array(n);
  let prevW = wrapLon(points[0]);
  lons[0] = prevW;
  lats[0] = points[1];
  for (let i = 1; i < n; i += 1) {
    const w = wrapLon(points[i * 2]);
    let delta = w - prevW;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    lons[i] = lons[i - 1] + delta;
    lats[i] = points[i * 2 + 1];
    prevW = w;
  }
  let deltaClose = lons[0] - prevW;
  if (deltaClose > 180) deltaClose -= 360;
  else if (deltaClose < -180) deltaClose += 360;
  const net = Math.round((lons[n - 1] + deltaClose - lons[0]) / 360);
  if (net !== 0) {
    // The pole seam drops straight down vertex 0's meridian. Started at the
    // southernmost vertex nothing of the ring lies below it, so the seam
    // crosses no shoreline; from any other vertex it can cut through a bay
    // and flip the ocean behind it to land.
    let south = 0;
    for (let i = 1; i < n; i += 1) if (lats[i] < lats[south]) south = i;
    if (south !== 0) {
      const rotated = new Float64Array(points.length);
      rotated.set(points.subarray(south * 2));
      rotated.set(points.subarray(0, south * 2), points.length - south * 2);
      return unwrapRing(rotated);
    }
  }
  return { lons, lats, net };
}

/**
 * Assembles the ring's edge list in unwrapped coordinates. Real edges (the
 * vertex chain plus the closing edge back to vertex 0's continuation) come
 * first; for a pole-encircling ring three artificial seam edges follow: drop
 * to lat -90 at the continuation, run along -90, rise back at vertex 0. The
 * two vertical seams sit exactly 360 deg apart, so even-odd fill covers every
 * column south of the ring; the horizontal seam at -90 lies below every
 * cell-center latitude and contributes no crossings.
 * @param {{lons: Float64Array, lats: Float64Array, net: number}} ring
 * @returns {{x1: number[], y1: number[], x2: number[], y2: number[],
 *   realCount: number}} Edges e span (x1[e], y1[e]) -> (x2[e], y2[e]);
 *   indices < realCount are real shoreline, the rest artificial seams.
 */
function buildEdges(ring) {
  const { lons, lats, net } = ring;
  const n = lons.length;
  const xClose = lons[0] + net * 360;
  const x1 = [];
  const y1 = [];
  const x2 = [];
  const y2 = [];
  for (let i = 0; i + 1 < n; i += 1) {
    x1.push(lons[i]);
    y1.push(lats[i]);
    x2.push(lons[i + 1]);
    y2.push(lats[i + 1]);
  }
  x1.push(lons[n - 1]);
  y1.push(lats[n - 1]);
  x2.push(xClose);
  y2.push(lats[0]);
  const realCount = x1.length;
  if (net !== 0) {
    x1.push(xClose, xClose, lons[0]);
    y1.push(lats[0], -90, -90);
    x2.push(xClose, lons[0], lons[0]);
    y2.push(-90, -90, lats[0]);
  }
  return { x1, y1, x2, y2, realCount };
}

/**
 * Even-odd scanline fill at cell-center latitudes. Edges are bucketed by the
 * rows whose center they cross (active-edge table), keeping large polygons
 * sub-quadratic. Crossing rule is half-open — an edge crosses yc iff
 * (lat1 <= yc) !== (lat2 <= yc) — so shared vertices never double-count.
 * Interior columns are written mod width (dateline correctness).
 * @param {Uint8Array} base - width*height land/water grid, mutated.
 * @param {number} width
 * @param {number} height
 * @param {{x1: number[], y1: number[], x2: number[], y2: number[]}} edges
 * @param {number} fillValue - MASK_LAND or MASK_WATER.
 */
function fillPolygon(base, width, height, edges, fillValue) {
  const sx = width / 360;
  const sy = height / 180;
  const { x1, y1, x2, y2 } = edges;
  const buckets = new Array(height);
  let minRow = height;
  let maxRow = -1;
  for (let e = 0; e < x1.length; e += 1) {
    const lo = Math.min(y1[e], y2[e]);
    const hi = Math.max(y1[e], y2[e]);
    if (lo === hi) continue; // horizontal edges never satisfy the crossing rule
    // Rows whose center satisfies lo <= yc < hi, yc = (row + 0.5)/sy - 90.
    let r0 = Math.ceil((lo + 90) * sy - 0.5);
    let r1 = Math.ceil((hi + 90) * sy - 0.5) - 1;
    if (r0 < 0) r0 = 0;
    if (r1 > height - 1) r1 = height - 1;
    for (let r = r0; r <= r1; r += 1) {
      if (!buckets[r]) buckets[r] = [];
      buckets[r].push(e);
    }
    if (r0 < minRow) minRow = r0;
    if (r1 > maxRow) maxRow = r1;
  }
  const xs = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    const bucket = buckets[row];
    if (!bucket) continue;
    const yc = (row + 0.5) / sy - 90;
    xs.length = 0;
    for (const e of bucket) {
      xs.push(x1[e] + ((yc - y1[e]) * (x2[e] - x1[e])) / (y2[e] - y1[e]));
    }
    xs.sort((a, b) => a - b);
    const rowBase = row * width;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Fill columns whose center lies in [xs[k], xs[k+1]]:
      // center(col) = (col + 0.5)/sx - 180.
      const c0 = Math.ceil((xs[k] + 180) * sx - 0.5);
      let c1 = Math.floor((xs[k + 1] + 180) * sx - 0.5);
      // A full-turn interval (polar cap) may overrun by one column of FP
      // slack; cap it so every column is written exactly once.
      if (c1 - c0 >= width) c1 = c0 + width - 1;
      for (let c = c0; c <= c1; c += 1) {
        base[rowBase + (((c % width) + width) % width)] = fillValue;
      }
    }
  }
}

/**
 * Marks every cell crossed by a real shoreline edge using grid traversal.
 * Corner crossings conservatively mark both side cells. Grid-aligned edges
 * use the same half-open cell membership as maskStateAt.
 * Artificial pole seams (indices >= realCount) are skipped: the seam is not
 * shoreline. Accumulates across all polygons of all levels.
 * @param {Uint8Array} coastal - width*height flag grid, mutated.
 * @param {number} width
 * @param {number} height
 * @param {{x1: number[], y1: number[], x2: number[], y2: number[],
 *   realCount: number}} edges
 */
function markCoastal(coastal, width, height, edges) {
  const sx = width / 360;
  const sy = height / 180;
  const { x1, y1, x2, y2, realCount } = edges;
  const mark = (col, row) => {
    const wrappedCol = ((col % width) + width) % width;
    const clampedRow = Math.max(0, Math.min(height - 1, row));
    coastal[clampedRow * width + wrappedCol] = 1;
  };
  for (let e = 0; e < realCount; e += 1) {
    // Keep columns unwrapped until writing so a dateline crossing takes the
    // short path. The polar closure edges are outside realCount.
    const startX = (x1[e] + 180) * sx;
    const startY = (y1[e] + 90) * sy;
    const endX = (x2[e] + 180) * sx;
    const endY = (y2[e] + 90) * sy;
    const dx = endX - startX;
    const dy = endY - startY;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    let col = Math.floor(startX);
    let row = Math.floor(startY);
    const deltaX = dx === 0 ? Infinity : 1 / Math.abs(dx);
    const deltaY = dy === 0 ? Infinity : 1 / Math.abs(dy);
    let nextX =
      dx === 0 ? Infinity : ((stepX > 0 ? col + 1 : col) - startX) / dx;
    let nextY =
      dy === 0 ? Infinity : ((stepY > 0 ? row + 1 : row) - startY) / dy;
    mark(col, row);
    mark(Math.floor(endX), Math.floor(endY));
    // At most one crossing per row/column boundary, plus endpoint contacts.
    // The explicit bound also prevents a stalled floating-point increment
    // from turning a malformed input into an infinite loop.
    const maxCrossings =
      Math.abs(Math.floor(endX) - col) + Math.abs(Math.floor(endY) - row) + 2;
    for (let k = 0; k < maxCrossings; k += 1) {
      // Endpoints were marked using floor above; a negative-direction
      // crossing at t=1 must not step into a cell beyond the segment.
      if (Math.min(nextX, nextY) >= 1) break;
      if (nextX === nextY) {
        // A corner touches the two side cells as well as the diagonal one.
        mark(col + stepX, row);
        mark(col, row + stepY);
        col += stepX;
        row += stepY;
        nextX += deltaX;
        nextY += deltaY;
      } else if (nextX < nextY) {
        col += stepX;
        nextX += deltaX;
      } else {
        row += stepY;
        nextY += deltaY;
      }
      mark(col, row);
    }
  }
}

/**
 * Rasterizes parsed GSHHG polygons onto a width x height three-state grid.
 * Row 0 is the lat band starting at -90, col 0 the lon band starting at
 * -180; cell membership matches maskStateAt in the codec.
 * @param {Array<{level: number, points: Float64Array}>} polygons - Parsed
 *   GSHHG records (only `level` and `points` are read, any input order);
 *   levels outside 1..5 are ignored.
 * @param {{width: number, height: number}} grid - Cells per 360 deg lon and
 *   180 deg lat; both positive integers.
 * @returns {Uint8Array} width*height row-major states: MASK_WATER |
 *   MASK_LAND | MASK_COASTAL.
 */
export function rasterizeMask(polygons, { width, height }) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(
      `rasterizeMask: dimensions must be positive integers, got ${width}x${height}`,
    );
  }
  const base = new Uint8Array(width * height); // all MASK_WATER
  const coastal = new Uint8Array(width * height);
  const filled = polygons
    .filter((p) => LEVEL_FILL.has(p.level) && p.points.length >= 4)
    .sort((a, b) => a.level - b.level);
  for (const p of filled) {
    const edges = buildEdges(unwrapRing(p.points));
    if (p.points.length >= 6) {
      fillPolygon(base, width, height, edges, LEVEL_FILL.get(p.level));
    }
    markCoastal(coastal, width, height, edges);
  }
  const states = new Uint8Array(width * height);
  for (let i = 0; i < states.length; i += 1) {
    states[i] = coastal[i] ? MASK_COASTAL : base[i];
  }
  return states;
}
