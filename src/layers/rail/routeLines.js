/**
 * @module layers/rail/routeLines
 * @description Pure geometry for the Rail layer's route lines: the faint
 * network a feed's path pack draws when zoomed in, and the split of a
 * selected train's line into the part travelled and the part ahead.
 *
 * A pack lists every distinct GTFS shape, and most of them overlap: a
 * commuter network's short turns, express patterns and branches share the
 * trunk. Drawing each shape would stack hundreds of translucent lines on the
 * same track, so the network is a union: shapes are walked longest first, and
 * only the stretches no earlier shape already covered are kept. Each kept
 * stretch is then thinned to the vertices its curve needs.
 *
 * Pure: no Cesium, no DOM.
 */

/** Metres per degree of latitude (and of longitude at the equator). */
const M_PER_DEG = 111_320;
/** Coverage grid cell (m). A track within about one cell is already drawn. */
export const NETWORK_CELL_M = 40;
/** Sample spacing when walking a shape for coverage (m). */
const NETWORK_STEP_M = 40;
/** Uncovered stretches shorter than this are jitter beside a drawn track (m). */
export const NETWORK_MIN_RUN_M = 200;
/** Douglas-Peucker tolerance for the drawn stretches (m). */
export const NETWORK_SIMPLIFY_M = 10;
/** Grid key offset, so negative cell indices stay distinct. */
const KEY_OFFSET = 2 ** 21;

/** Longitude difference wrapped into (-180, 180]. */
function wrapLon(delta) {
  return ((((delta + 180) % 360) + 360) % 360) - 180;
}

/** Arc length of a flat `[lat, lon, ...]` shape in a local frame (m). */
function shapeLength(coords, kx) {
  let length = 0;
  for (let i = 2; i + 1 < coords.length; i += 2)
    length += Math.hypot(
      wrapLon(coords[i + 1] - coords[i - 1]) * kx,
      (coords[i] - coords[i - 2]) * M_PER_DEG,
    );
  return length;
}

/**
 * Douglas-Peucker on a run of local-frame points, returning kept indices.
 * Iterative, so a long run cannot overflow the stack.
 */
function simplifyIndices(xs, ys, tolerance) {
  const n = xs.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack = [0, n - 1];
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    const ax = xs[first];
    const ay = ys[first];
    const dx = xs[last] - ax;
    const dy = ys[last] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = first + 1; i < last; i++) {
      let t = len2 > 0 ? ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - xs[i];
      const ey = ay + dy * t - ys[i];
      const d2 = ex * ex + ey * ey;
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(first, worst, worst, last);
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * The category each shape is drawn in: that of the first route listing it
 * whose category is known. Shapes no classified route lists are not drawn
 * (a pack can carry shapes of routes the layer filters out).
 * @param {Record<string, number[]>} routes routeId → shape indices.
 * @param {number} shapeCount
 * @param {(routeId: string) => string|null} categoryOf
 * @returns {(string|null)[]}
 */
export function shapeCategories(routes, shapeCount, categoryOf) {
  const out = new Array(shapeCount).fill(null);
  for (const [routeId, list] of Object.entries(routes || {})) {
    if (!Array.isArray(list)) continue;
    let category;
    for (const index of list) {
      if (!Number.isInteger(index) || index < 0 || index >= shapeCount)
        continue;
      if (out[index] !== null) continue;
      if (category === undefined) category = categoryOf(routeId) || null;
      if (category) out[index] = category;
    }
  }
  return out;
}

/**
 * The union of a pack's shapes as drawable stretches, each tagged with the
 * category of the route it came from.
 *
 * @param {{shapes: ArrayLike<number>[], routes?: Record<string, number[]>}} raw
 *   A decoded path pack (the JSON body, not the indexed wrapper).
 * @param {(routeId: string) => string|null} categoryOf Route → category, or
 *   null for a route the layer does not draw.
 * @param {{cellM?: number, minRunM?: number, simplifyM?: number}} [options]
 * @returns {{lines: {category: string, coords: Float64Array}[],
 *   shapesIn: number, pointsIn: number, pointsOut: number}}
 */
export function buildRailNetworkLines(raw, categoryOf, options = {}) {
  const steps = railNetworkLineSteps(raw, categoryOf, options);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/**
 * The same union as buildRailNetworkLines(), one shape per step, so a large
 * pack can be built in slices between frames instead of in one long task.
 * @param {object} raw
 * @param {(routeId: string) => string|null} categoryOf
 * @param {object} [options]
 * @returns {Generator<void, ReturnType<typeof buildRailNetworkLines>>}
 */
export function* railNetworkLineSteps(raw, categoryOf, options = {}) {
  const cellM = options.cellM ?? NETWORK_CELL_M;
  const minRunM = options.minRunM ?? NETWORK_MIN_RUN_M;
  const simplifyM = options.simplifyM ?? NETWORK_SIMPLIFY_M;
  const shapes = Array.isArray(raw?.shapes) ? raw.shapes : [];
  const categories = shapeCategories(raw?.routes, shapes.length, categoryOf);
  let minLat = Infinity;
  let maxLat = -Infinity;
  let pointsIn = 0;
  const order = [];
  for (let index = 0; index < shapes.length; index++) {
    const coords = shapes[index];
    if (!categories[index] || !(coords?.length >= 4)) continue;
    for (let i = 0; i + 1 < coords.length; i += 2) {
      if (coords[i] < minLat) minLat = coords[i];
      if (coords[i] > maxLat) maxLat = coords[i];
    }
    pointsIn += coords.length / 2;
    order.push(index);
  }
  if (!order.length) return { lines: [], shapesIn: 0, pointsIn, pointsOut: 0 };
  const lat0 = (minLat + maxLat) / 2;
  const lon0 = shapes[order[0]][1];
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const lengths = new Map(
    order.map((index) => [index, shapeLength(shapes[index], kx)]),
  );
  order.sort((a, b) => lengths.get(b) - lengths.get(a));

  const covered = new Set();
  const lines = [];
  let pointsOut = 0;
  // Reused per shape: the densified walk in the local frame.
  let xs = [];
  let ys = [];
  let cells = [];
  const rowWidth = KEY_OFFSET * 2;
  const cellKey = (x, y) =>
    (Math.floor(x / cellM) + KEY_OFFSET) * rowWidth +
    (Math.floor(y / cellM) + KEY_OFFSET);
  // Own cell first: on an already drawn track that is almost always the hit,
  // so a covered sample costs one lookup and only new track pays for nine.
  const around = [
    -rowWidth,
    rowWidth,
    -1,
    1,
    -rowWidth - 1,
    -rowWidth + 1,
    rowWidth - 1,
    rowWidth + 1,
  ];
  const isCovered = (key) => {
    if (covered.has(key)) return true;
    for (let i = 0; i < around.length; i++)
      if (covered.has(key + around[i])) return true;
    return false;
  };

  function emit(category, from, to) {
    const runXs = xs.slice(from, to + 1);
    const runYs = ys.slice(from, to + 1);
    let length = 0;
    for (let i = 1; i < runXs.length; i++)
      length += Math.hypot(runXs[i] - runXs[i - 1], runYs[i] - runYs[i - 1]);
    if (length < minRunM) return;
    const kept = simplifyIndices(runXs, runYs, simplifyM);
    const coords = new Float64Array(kept.length * 2);
    for (let k = 0; k < kept.length; k++) {
      const i = kept[k];
      coords[2 * k] = runYs[i] / M_PER_DEG + lat0;
      let lon = runXs[i] / kx + lon0;
      if (lon > 180) lon -= 360;
      else if (lon < -180) lon += 360;
      coords[2 * k + 1] = lon;
    }
    pointsOut += kept.length;
    lines.push({ category, coords });
  }

  for (const index of order) {
    const coords = shapes[index];
    xs = [];
    ys = [];
    for (let i = 0; i + 1 < coords.length; i += 2) {
      const x = wrapLon(coords[i + 1] - lon0) * kx;
      const y = (coords[i] - lat0) * M_PER_DEG;
      if (xs.length) {
        const px = xs[xs.length - 1];
        const py = ys[ys.length - 1];
        const steps = Math.ceil(Math.hypot(x - px, y - py) / NETWORK_STEP_M);
        for (let k = 1; k < steps; k++) {
          xs.push(px + ((x - px) * k) / steps);
          ys.push(py + ((y - py) * k) / steps);
        }
      }
      xs.push(x);
      ys.push(y);
    }
    cells = new Array(xs.length);
    let runStart = -1;
    for (let i = 0; i < xs.length; i++) {
      cells[i] = cellKey(xs[i], ys[i]);
      const free = !isCovered(cells[i]);
      if (free && runStart < 0) runStart = Math.max(0, i - 1);
      else if (!free && runStart >= 0) {
        emit(categories[index], runStart, i);
        runStart = -1;
      }
    }
    if (runStart >= 0) emit(categories[index], runStart, xs.length - 1);
    // Marked after the walk, not during it: consecutive samples of one shape
    // sit in neighbouring cells, so marking as it goes would cover the shape
    // against itself.
    for (const key of cells) covered.add(key);
    yield;
  }
  return { lines, shapesIn: order.length, pointsIn, pointsOut };
}

/**
 * The fraction of a polyline, by cumulative chord length, at which arc `s`
 * of a rail path falls. The renderer draws the path's own vertices, so the
 * fraction is measured on those vertices: segment `i` of the path holds the
 * arc range `[path.s[i], path.s[i+1]]` and the same chord in the drawn line.
 *
 * @param {{n: number, s: ArrayLike<number>}} path From createRailPath.
 * @param {ArrayLike<number>} chordAt Cumulative drawn length per vertex
 *   (same length as the path), e.g. from cumulativeChords().
 * @param {number} s Arc length (m) on the path.
 * @returns {number} 0..1, or NaN when either input is unusable.
 */
export function splitFraction(path, chordAt, s) {
  if (!path || !chordAt || chordAt.length !== path.n || !Number.isFinite(s))
    return NaN;
  const total = chordAt[path.n - 1];
  if (!(total > 0)) return NaN;
  const arc = path.s;
  if (s <= arc[0]) return 0;
  if (s >= arc[path.n - 1]) return 1;
  let lo = 0;
  let hi = path.n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arc[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  const span = arc[lo + 1] - arc[lo];
  const t = span > 0 ? (s - arc[lo]) / span : 0;
  const chord = chordAt[lo] + (chordAt[lo + 1] - chordAt[lo]) * t;
  return Math.max(0, Math.min(1, chord / total));
}

/**
 * Cumulative length per vertex of a path, measured on the path's own local
 * frame (x, y). This is what splitFraction() needs when the drawn line's
 * texture coordinate runs by length, as a ground polyline's does.
 * @param {{n: number, x: ArrayLike<number>, y: ArrayLike<number>}} path
 * @returns {Float64Array}
 */
export function cumulativeChords(path) {
  const out = new Float64Array(path?.n || 0);
  for (let i = 1; i < out.length; i++)
    out[i] =
      out[i - 1] +
      Math.hypot(path.x[i] - path.x[i - 1], path.y[i] - path.y[i - 1]);
  return out;
}

/**
 * Vertex-index positions: what splitFraction() needs when the drawn line's
 * texture coordinate runs by vertex index, as a plain PolylineGeometry's does.
 * @param {{n: number}} path
 * @returns {Float64Array}
 */
export function vertexIndexChords(path) {
  const out = new Float64Array(path?.n || 0);
  for (let i = 0; i < out.length; i++) out[i] = i;
  return out;
}

/**
 * The faint network's opacity at a camera altitude: full below `fullBelowM`,
 * none above `hiddenAboveM`, linear between.
 * @param {number} altitudeM
 * @param {number} fullBelowM
 * @param {number} hiddenAboveM
 * @returns {number} 0..1
 */
export function networkAltitudeFade(altitudeM, fullBelowM, hiddenAboveM) {
  if (!Number.isFinite(altitudeM)) return 0;
  if (altitudeM <= fullBelowM) return 1;
  if (altitudeM >= hiddenAboveM) return 0;
  return (hiddenAboveM - altitudeM) / (hiddenAboveM - fullBelowM);
}
