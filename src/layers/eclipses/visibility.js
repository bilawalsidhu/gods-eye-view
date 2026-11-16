import { fromGeodetic, penumbralSpan, shadowFrame } from './besselian.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Barely any of the Sun's diameter covered: the edge of the partial eclipse. */
export const VISIBILITY_LEVEL = 0.01;
/**
 * How the Sun's height weighs against the magnitude where the two meet: the
 * sine of its altitude times this.
 */
const SUN_WEIGHT = 3;

/**
 * How well each node of a latitude/longitude grid sees the eclipse: above
 * zero where, at some moment, the Sun is up and the Moon covers more than
 * VISIBILITY_LEVEL of its diameter; below zero where that never happens. At
 * each moment the value is the lesser of two margins (how far inside the
 * penumbra, how far above the horizon), so it changes smoothly across both
 * the penumbra's edge and the sunrise and sunset lines, and its zero line is
 * the limit of the eclipse. Rows run south to north, columns west to east,
 * both ends included.
 */
export function visibilityGrid(eclipse, stepDeg = 1, stepMs = 120_000) {
  const span = penumbralSpan(eclipse);
  const frames = [];
  for (let ms = span.startMs; ms < span.endMs; ms += stepMs)
    frames.push(shadowFrame(eclipse, ms));
  frames.push(shadowFrame(eclipse, span.endMs));
  const rows = Math.round(180 / stepDeg) + 1;
  const columns = Math.round(360 / stepDeg) + 1;
  const values = new Float32Array(rows * columns);
  for (let row = 0; row < rows; row += 1) {
    const lat = -90 + row * stepDeg;
    for (let column = 0; column < columns; column += 1) {
      const point = fromGeodetic(lat, -180 + column * stepDeg);
      let best = -Infinity;
      for (const frame of frames) {
        const zeta = dot(point, frame.k);
        const rx = point[0] - frame.origin[0];
        const ry = point[1] - frame.origin[1];
        const rz = point[2] - frame.origin[2];
        const x = rx * frame.i[0] + ry * frame.i[1] + rz * frame.i[2];
        const y = rx * frame.j[0] + ry * frame.j[1] + rz * frame.j[2];
        const penumbra = frame.l1 - zeta * frame.tanF1;
        const umbra = frame.l2 - zeta * frame.tanF2;
        const magnitude = (penumbra - Math.hypot(x, y)) / (penumbra + umbra);
        const value = Math.min(magnitude - VISIBILITY_LEVEL, zeta * SUN_WEIGHT);
        if (value > best) best = value;
      }
      values[row * columns + column] = best;
    }
  }
  return { values, rows, columns, stepDeg };
}

/**
 * The lines where a grid's value crosses `level`, as chains of geodetic
 * points: marching squares, with the crossings on shared cell edges joined.
 */
export function contourLines({ values, rows, columns, stepDeg }, level) {
  const at = (row, column) => values[row * columns + column];
  // A crossing lies on one grid edge: 'h' edges run east from a node, 'v'
  // edges north. Its key names the edge, so neighbouring cells agree on it.
  const points = new Map();
  const crossing = (kind, row, column) => {
    const key = `${kind}${row},${column}`;
    if (!points.has(key)) {
      const a = at(row, column);
      const b = kind === 'h' ? at(row, column + 1) : at(row + 1, column);
      const t = (level - a) / (b - a);
      points.set(key, {
        lat: -90 + (row + (kind === 'v' ? t : 0)) * stepDeg,
        lon: -180 + (column + (kind === 'h' ? t : 0)) * stepDeg,
      });
    }
    return key;
  };
  const links = new Map();
  const link = (a, b) => {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      if (!links.has(from)) links.set(from, []);
      links.get(from).push(to);
    }
  };
  for (let row = 0; row < rows - 1; row += 1)
    for (let column = 0; column < columns - 1; column += 1) {
      const sw = at(row, column) >= level;
      const se = at(row, column + 1) >= level;
      const ne = at(row + 1, column + 1) >= level;
      const nw = at(row + 1, column) >= level;
      const edges = [];
      if (sw !== se) edges.push(crossing('h', row, column));
      if (se !== ne) edges.push(crossing('v', row, column + 1));
      if (nw !== ne) edges.push(crossing('h', row + 1, column));
      if (sw !== nw) edges.push(crossing('v', row, column));
      if (edges.length === 2) link(edges[0], edges[1]);
      else if (edges.length === 4) {
        // A saddle: pair the crossings round the south-west corner's side.
        link(edges[0], sw ? edges[3] : edges[1]);
        link(edges[2], sw ? edges[1] : edges[3]);
      }
    }
  // Walk each chain from an open end, then the closed loops that remain.
  const seen = new Set();
  const chains = [];
  const walk = (start) => {
    const chain = [start];
    seen.add(start);
    let current = start;
    for (;;) {
      const next = links.get(current).find((key) => !seen.has(key));
      if (!next) break;
      seen.add(next);
      chain.push(next);
      current = next;
    }
    // A loop comes back to where it started.
    if (links.get(current).includes(start) && chain.length > 2)
      chain.push(start);
    chains.push(chain.map((key) => points.get(key)));
  };
  for (const [key, to] of links)
    if (to.length === 1 && !seen.has(key)) walk(key);
  for (const key of links.keys()) if (!seen.has(key)) walk(key);
  return chains.filter((chain) => chain.length > 1);
}

/**
 * Round a line's corners: each pass cuts every corner a quarter of the way
 * along its two sides. An open line keeps its ends; a closed one stays closed.
 */
export function smoothLine(line, passes = 2) {
  let points = line;
  for (let pass = 0; pass < passes && points.length > 2; pass += 1) {
    const closed =
      points[0].lat === points.at(-1).lat &&
      points[0].lon === points.at(-1).lon;
    const cutCorners = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      cutCorners.push(
        { lat: a.lat * 0.75 + b.lat * 0.25, lon: a.lon * 0.75 + b.lon * 0.25 },
        { lat: a.lat * 0.25 + b.lat * 0.75, lon: a.lon * 0.25 + b.lon * 0.75 },
      );
    }
    points = closed
      ? [...cutCorners, cutCorners[0]]
      : [points[0], ...cutCorners, points.at(-1)];
  }
  return points;
}

/**
 * The limit of the region that sees any of the eclipse, even a partial one at
 * sunrise or sunset: one or more smooth lines of geodetic points. Stray
 * specks a cell or two across are dropped.
 */
export function visibilityLimit(eclipse, stepDeg = 1) {
  return contourLines(visibilityGrid(eclipse, stepDeg), 0)
    .filter((line) => line.length > 6)
    .map((line) => smoothLine(line));
}
