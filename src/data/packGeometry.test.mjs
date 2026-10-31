// Every shipped place and neighborhood outline is a valid MultiPolygon, checked
// here by an implementation independent of the builders (which use GEOS):
// simple rings, rings that never cross, holes inside their shell, parts that
// neither overlap nor nest, and the largest part first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PLACES = new URL('./local_data/us_census_places/', import.meta.url);
const WOF = new URL('./local_data/wof_neighborhoods/', import.meta.url);
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

/** Integer rings from a delta-encoded ring. */
function deltaRing(encoded) {
  const ring = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    x += encoded[i];
    y += encoded[i + 1];
    ring.push([x, y]);
  }
  return ring;
}

/** Integer ring from an encoded polyline (lon, lat order). */
function polylineRing(encoded) {
  const ring = [];
  const last = [0, 0];
  let axis = 0;
  let i = 0;
  while (i < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(i++) - 63;
      result += (byte & 31) * 2 ** shift;
      shift += 5;
    } while (byte >= 32);
    last[axis] += result % 2 ? -(result + 1) / 2 : result / 2;
    if (axis === 1) ring.push([last[0], last[1]]);
    axis ^= 1;
  }
  return ring;
}

const orient = (a, b, c) =>
  Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const within = (a, b, p) =>
  Math.min(a[0], b[0]) <= p[0] &&
  p[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= p[1] &&
  p[1] <= Math.max(a[1], b[1]);

/** 'cross', 'overlap', 'touch' or null for two segments. */
function meet(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 && o2 && o3 && o4) return o1 !== o2 && o3 !== o4 ? 'cross' : null;
  if (!o1 && !o2) {
    const k = a[0] !== b[0] ? 0 : 1;
    const lo = Math.max(Math.min(a[k], b[k]), Math.min(c[k], d[k]));
    const hi = Math.min(Math.max(a[k], b[k]), Math.max(c[k], d[k]));
    return hi > lo ? 'overlap' : hi === lo ? 'touch' : null;
  }
  if (
    (!o1 && within(a, b, c)) ||
    (!o2 && within(a, b, d)) ||
    (!o3 && within(c, d, a)) ||
    (!o4 && within(c, d, b))
  )
    return 'touch';
  return null;
}

function twiceArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return sum;
}

/** 1 inside, 0 on the boundary, -1 outside. */
function locate(ring, p) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (!orient(a, b, p) && within(a, b, p)) return 0;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside ? 1 : -1;
}

/** A vertex of `ring` strictly inside or outside `other` (not on it). */
function side(ring, other) {
  for (const p of ring) {
    const where = locate(other, p);
    if (where) return where;
  }
  return 0;
}

/**
 * Why integer `polygons` ([[outer, ...holes], ...], open rings) are not a
 * valid MultiPolygon, or null.
 */
export function invalidReason(polygons) {
  if (!polygons.length) return 'empty';
  const segments = [];
  const areas = [];
  for (let p = 0; p < polygons.length; p++) {
    for (let r = 0; r < polygons[p].length; r++) {
      let ring = polygons[p][r];
      const [f, l] = [ring[0], ring.at(-1)];
      if (ring.length > 1 && f[0] === l[0] && f[1] === l[1])
        ring = ring.slice(0, -1);
      polygons[p][r] = ring;
      if (new Set(ring.map(String)).size < 3) return 'ring under 3 vertices';
      if (!twiceArea(ring)) return 'flat ring';
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (a[0] === b[0] && a[1] === b[1]) return 'repeated vertex';
        segments.push({
          p,
          r,
          i,
          n: ring.length,
          a,
          b,
          x0: Math.min(a[0], b[0]),
          x1: Math.max(a[0], b[0]),
        });
      }
    }
    areas.push(
      Math.abs(twiceArea(polygons[p][0])) -
        polygons[p].slice(1).reduce((s, h) => s + Math.abs(twiceArea(h)), 0),
    );
  }
  segments.sort((s, t) => s.x0 - t.x0);
  for (let x = 0; x < segments.length; x++) {
    const s = segments[x];
    for (let y = x + 1; y < segments.length; y++) {
      const t = segments[y];
      if (t.x0 > s.x1) break;
      const kind = meet(s.a, s.b, t.a, t.b);
      if (!kind) continue;
      if (s.p === t.p && s.r === t.r) {
        const gap = Math.abs(s.i - t.i);
        const adjacent = gap === 1 || gap === s.n - 1;
        if (adjacent && kind === 'touch') continue;
        return kind === 'touch'
          ? 'ring touches itself'
          : `ring ${kind}es itself`;
      }
      if (kind !== 'touch') return `rings ${kind}`;
    }
  }
  for (const [outer, ...holes] of polygons) {
    for (const hole of holes) {
      if (side(hole, outer) !== 1) return 'hole outside its shell';
      for (const other of holes)
        if (other !== hole && side(hole, other) === 1) return 'nested holes';
    }
  }
  for (let p = 0; p < polygons.length; p++)
    for (let q = 0; q < polygons.length; q++) {
      if (p === q) continue;
      const shell = polygons[p][0];
      const [outer, ...holes] = polygons[q];
      if (side(shell, outer) !== 1) continue;
      if (!holes.some((hole) => side(shell, hole) === 1))
        return 'overlapping or nested parts';
    }
  if (Math.max(...areas) > areas[0]) return 'largest part is not first';
  return null;
}

const square = (x, y, s) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];

test('the independent validator rejects what GEOS rejects', () => {
  assert.equal(invalidReason([[square(0, 0, 10)]]), null);
  assert.match(
    invalidReason([
      [
        [
          [0, 0],
          [10, 10],
          [10, 0],
          [0, 12],
        ],
      ],
    ]),
    /itself/,
  );
  // A ring that touches itself at a vertex (the Boaz failure).
  assert.match(
    invalidReason([
      [
        [
          [0, 0],
          [10, 0],
          [5, 5],
          [10, 10],
          [0, 10],
          [5, 5],
        ],
      ],
    ]),
    /itself/,
  );
  assert.match(
    invalidReason([[square(0, 0, 10)], [square(5, 5, 10)]]),
    /rings cross|overlapping/,
  );
  assert.match(
    invalidReason([[square(0, 0, 10)], [square(2, 2, 2)]]),
    /nested/,
  );
  // An island inside a lake is valid.
  assert.equal(
    invalidReason([[square(0, 0, 10), square(2, 2, 6)], [square(4, 4, 2)]]),
    null,
  );
  assert.match(
    invalidReason([[square(0, 0, 10), square(20, 20, 2)]]),
    /hole outside/,
  );
  assert.match(
    invalidReason([[square(0, 0, 2)], [square(10, 10, 5)]]),
    /largest/,
  );
  // A hole touching its shell at one vertex is valid.
  assert.equal(
    invalidReason([
      [
        square(0, 0, 10),
        [
          [0, 0],
          [4, 6],
          [6, 4],
        ],
      ],
    ]),
    null,
  );
});

test('every Census place is a valid MultiPolygon, largest part first', () => {
  const index = readJson(new URL('index.json', PLACES));
  const bad = [];
  for (const { st } of index.states)
    for (const feature of readJson(new URL(`${st}.json`, PLACES)).features) {
      const why = invalidReason(
        feature.polygons.map((poly) => poly.map(deltaRing)),
      );
      if (why) bad.push(`${feature.geoid} ${feature.name}: ${why}`);
    }
  assert.deepEqual(bad.slice(0, 10), []);
});

test('every WOF neighborhood is a valid MultiPolygon with its label inside', () => {
  const index = readJson(new URL('index.json', WOF));
  const f = 10 ** index.meta.precision;
  const bad = [];
  for (const { key } of index.tiles)
    for (const feature of readJson(new URL(`${key}.json`, WOF)).features) {
      const polygons = feature[7].map((poly) => poly.map(polylineRing));
      const why = invalidReason(polygons);
      if (why) bad.push(`${feature[0]} ${feature[1]}: ${why}`);
      const label = feature[8].map((v) => Math.round(v * f));
      const [outer, ...holes] = polygons[0];
      if (
        locate(outer, label) < 0 ||
        holes.some((hole) => locate(hole, label) > 0)
      )
        bad.push(`${feature[0]} ${feature[1]}: label outside the main part`);
    }
  assert.deepEqual(bad.slice(0, 10), []);
});
