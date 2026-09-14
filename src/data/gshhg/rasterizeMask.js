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

import { MASK_COASTAL, MASK_LAND, MASK_WATER, wrapLon } from '../landSeaMaskCodec.js';

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
      xs.push(x1[e] + (yc - y1[e]) * (x2[e] - x1[e]) / (y2[e] - y1[e]));
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
        base[rowBase + ((c % width) + width) % width] = fillValue;
      }
    }
  }
}

/**
 * Marks every cell a real shoreline edge passes through as coastal, sampling
 * at half-cell steps along the edge (0.0625 deg on the production grid).
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
  for (let e = 0; e < realCount; e += 1) {
    const dx = x2[e] - x1[e];
    const dy = y2[e] - y1[e];
    const steps = Math.max(1, Math.ceil(2 * Math.max(Math.abs(dx) * sx, Math.abs(dy) * sy)));
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      const col = Math.floor((wrapLon(x1[e] + dx * t) + 180) * sx) % width;
      let row = Math.floor((y1[e] + dy * t + 90) * sy);
      if (row < 0) row = 0;
      else if (row > height - 1) row = height - 1;
      coastal[row * width + col] = 1;
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
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`rasterizeMask: dimensions must be positive integers, got ${width}x${height}`);
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
