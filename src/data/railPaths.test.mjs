import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_PATH_PACK_VERSION,
  createRailPath,
  createRailPathPack,
  pointAtS,
  projectOnPath,
} from './railPaths.js';

const M_PER_DEG = 111_320;

/** An L: 1 km east along the equator, then 1 km north. */
function lPath() {
  const dLon = 1000 / M_PER_DEG;
  return createRailPath([0, 0, 0, dLon, dLon, dLon]);
}

/**
 * A hairpin: 2 km east along lat 0, a 100 m step north, then 2 km back west.
 * The two legs are parallel and 100 m apart, like the two sides of a loop.
 */
function hairpin() {
  const d = 1 / M_PER_DEG;
  return createRailPath([0, 0, 0, 2000 * d, 100 * d, 2000 * d, 100 * d, 0]);
}

test('a path measures its arc length in metres', () => {
  const path = lPath();
  assert.equal(path.n, 3);
  assert.ok(Math.abs(path.length - 2000) < 0.5, String(path.length));
  assert.equal(createRailPath([0, 0]), null, 'one point is not a path');
  assert.equal(createRailPath([0, 0, Number.NaN, 1]), null);
  assert.equal(createRailPath(null), null);
});

test('given distances are used, and bad ones are measured instead', () => {
  const coords = [0, 0, 0, 0.01, 0, 0.02];
  assert.deepEqual([...createRailPath(coords, [0, 5, 10]).s], [0, 5, 10]);
  const measured = createRailPath(coords, [0, 10, 5]);
  assert.ok(Math.abs(measured.s[2] - 2 * 0.01 * M_PER_DEG) < 0.5);
  const wrongSize = createRailPath(coords, [0, 1]);
  assert.ok(wrongSize.s[1] > 1000);
});

test('projection finds the arc and the offset from the line', () => {
  const path = lPath();
  const d = 1 / M_PER_DEG;
  const hit = projectOnPath(path, 20 * d, 500 * d);
  assert.ok(Math.abs(hit.s - 500) < 0.5, String(hit.s));
  assert.ok(Math.abs(hit.offsetM - 20) < 0.5, String(hit.offsetM));
  assert.equal(hit.index, 0);
  const second = projectOnPath(path, 300 * d, 1030 * d);
  assert.ok(Math.abs(second.s - 1300) < 0.5, String(second.s));
  assert.ok(Math.abs(second.offsetM - 30) < 0.5);
  assert.equal(second.index, 1);
  const beyond = projectOnPath(path, 2000 * d, 1000 * d);
  assert.ok(Math.abs(beyond.s - 2000) < 0.5, 'clamped to the end');
  assert.ok(Math.abs(beyond.offsetM - 1000) < 1);
  assert.equal(projectOnPath(path, Number.NaN, 0), null);
  assert.equal(projectOnPath(null, 0, 0), null);
});

test('a hint keeps the projection on its own side of a loop', () => {
  const path = hairpin();
  const d = 1 / M_PER_DEG;
  // 45 m north of the outbound leg, 55 m south of the return leg: the
  // whole-path answer is the outbound leg...
  const point = [45 * d, 1000 * d];
  const free = projectOnPath(path, ...point);
  assert.ok(Math.abs(free.s - 1000) < 1, String(free.s));
  // ...but a train known to be on the return leg stays on it.
  const hinted = projectOnPath(path, ...point, 3100, 500);
  assert.ok(Math.abs(hinted.s - 3100) < 1, String(hinted.s));
  assert.ok(Math.abs(hinted.offsetM - 55) < 0.5);
});

test('the whole-path search agrees with a brute-force scan on a long path', () => {
  const coords = [];
  for (let i = 0; i < 500; i++)
    coords.push(40 + Math.sin(i / 20) * 0.01, -74 + i * 0.001);
  const path = createRailPath(coords);
  for (const [lat, lon] of [
    [40.004, -73.9],
    [40.02, -73.75],
    [39.99, -73.6],
  ]) {
    const fast = projectOnPath(path, lat, lon);
    let best = Infinity;
    for (let i = 0; i < path.n - 1; i++) {
      const hit = projectOnPath(
        path,
        lat,
        lon,
        (path.s[i] + path.s[i + 1]) / 2,
        0,
      );
      best = Math.min(best, hit.offsetM);
    }
    assert.ok(
      Math.abs(fast.offsetM - best) < 1e-6,
      `${fast.offsetM} vs ${best}`,
    );
  }
});

test('the point at an arc length carries the direction of travel', () => {
  const path = lPath();
  const d = 1 / M_PER_DEG;
  const east = pointAtS(path, 250);
  assert.ok(Math.abs(east.lon - 250 * d) < 1e-9);
  assert.equal(east.lat, 0);
  assert.ok(Math.abs(east.bearingDeg - 90) < 1e-6, String(east.bearingDeg));
  const north = pointAtS(path, 1500);
  assert.ok(Math.abs(north.lat - 500 * d) < 1e-6);
  assert.ok(
    Math.abs(north.bearingDeg - 0) < 1e-6 ||
      Math.abs(north.bearingDeg - 360) < 1e-6,
  );
  const out = {};
  assert.equal(pointAtS(path, -50, out), out, 'writes into the caller scratch');
  assert.equal(out.lat, 0);
  assert.equal(out.lon, 0);
  assert.ok(Math.abs(pointAtS(path, 9e9).lat - 1000 * d) < 1e-9);
  assert.equal(pointAtS(path, Number.NaN), null);
});

test('a pack resolves trips and routes to shapes and builds paths lazily', () => {
  const raw = {
    version: RAIL_PATH_PACK_VERSION,
    feedId: 'grt-ion',
    shapes: [
      [43.4, -80.5, 43.41, -80.5],
      [43.4, -80.5, 43.4, -80.49],
    ],
    dist: [
      [0, 1113.2],
      [0, 808.9],
    ],
    trips: { t1: 0, t2: 1, bad: 7 },
    routes: { 301: [0, 1, 9] },
  };
  const pack = createRailPathPack(raw);
  assert.equal(pack.feedId, 'grt-ion');
  assert.equal(pack.shapeCount, 2);
  assert.equal(pack.shapeForTrip('t1'), 0);
  assert.equal(pack.shapeForTrip('bad'), null, 'out-of-range index');
  assert.equal(pack.shapeForTrip('constructor'), null, 'no prototype keys');
  assert.equal(pack.shapeForTrip(''), null);
  assert.deepEqual(pack.shapesForRoute('301'), [0, 1]);
  assert.deepEqual(pack.shapesForRoute('302'), []);
  const path = pack.pathAt(1);
  assert.equal(path.length, 808.9);
  assert.equal(pack.pathAt(1), path, 'built once');
  assert.equal(pack.pathAt(5), null);
  for (const broken of [
    null,
    { ...raw, version: 2 },
    { ...raw, feedId: 3 },
    { ...raw, dist: [] },
  ])
    assert.throws(() => createRailPathPack(broken), TypeError);
});
