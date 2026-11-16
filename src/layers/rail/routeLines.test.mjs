// The Rail layer's route-line geometry: the network union a path pack draws
// as faint lines, and where a selected train's line splits into the part
// travelled and the part ahead; and, on a whole layer, how the selected
// train's line is drawn and released.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_RELEASE_AFTER_MS, railTrainKey } from './policy.js';
import { SCHEDULE_RETRY_FIRST_MS } from './schedules.js';
import {
  BOSTON,
  railLayerHarness as harness,
  railTrain as train,
} from '../../testSupport/railLayerHarness.mjs';
import {
  NETWORK_MIN_RUN_M,
  buildRailNetworkLines,
  cumulativeChords,
  networkAltitudeFade,
  railNetworkLineSteps,
  shapeCategories,
  splitFraction,
  vertexIndexChords,
} from './routeLines.js';
import {
  createRailPath,
  pointAtS,
  projectOnPath,
} from '../../data/railPaths.js';

const M_PER_DEG = 111_320;
const LAT = 42.36;
const KX = M_PER_DEG * Math.cos((LAT * Math.PI) / 180);

/** A flat [lat, lon, ...] line due east from `lon0`, one vertex per `stepM`. */
function eastLine(lon0, lengthM, stepM = 100, lat = LAT) {
  const out = [];
  for (let d = 0; d <= lengthM + 1e-6; d += stepM) out.push(lat, lon0 + d / KX);
  return out;
}

/** Total length of a flat line (m), measured like the module does. */
function lengthOf(coords) {
  let length = 0;
  for (let i = 2; i < coords.length; i += 2)
    length += Math.hypot(
      (coords[i + 1] - coords[i - 1]) * KX,
      (coords[i] - coords[i - 2]) * M_PER_DEG,
    );
  return length;
}

const everyRoute = () => 'regional';

test('shape categories come from the first classified route listing them', () => {
  const categories = shapeCategories(
    { bus: [0], 'CR-A': [1, 2], 'CR-B': [2, 3], bad: [99, -1, 'x'] },
    4,
    (route) =>
      route === 'bus' ? null : route === 'CR-A' ? 'local' : 'national',
  );
  assert.deepEqual(categories, [null, 'local', 'local', 'national']);
});

test('overlapping shapes are drawn once: a short turn adds nothing', () => {
  const full = eastLine(-71.2, 20_000);
  const shortTurn = eastLine(-71.2, 8_000, 250); // other vertex spacing too
  const result = buildRailNetworkLines(
    { shapes: [shortTurn, full], routes: { r: [0, 1] } },
    everyRoute,
  );
  assert.equal(result.shapesIn, 2);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].category, 'regional');
  // The longest shape is walked first, so the one line spans all of it.
  assert.ok(Math.abs(lengthOf(result.lines[0].coords) - 20_000) < 60);
  // A straight track keeps only its ends.
  assert.equal(result.lines[0].coords.length, 4);
  assert.ok(result.pointsOut < result.pointsIn);
});

test('a branch adds only the stretch the trunk does not already cover', () => {
  const trunk = eastLine(-71.2, 20_000);
  // Shares the trunk's first 10 km, then turns north for 5 km.
  const branch = eastLine(-71.2, 10_000);
  const turnLon = branch[branch.length - 1];
  for (let d = 100; d <= 5_000; d += 100)
    branch.push(LAT + d / M_PER_DEG, turnLon);
  const result = buildRailNetworkLines(
    { shapes: [trunk, branch], routes: { a: [0], b: [1] } },
    (route) => (route === 'a' ? 'local' : 'regional'),
  );
  assert.equal(result.lines.length, 2);
  const [first, second] = result.lines;
  assert.equal(first.category, 'local');
  assert.equal(second.category, 'regional');
  const branchLength = lengthOf(second.coords);
  // The new stretch is the 5 km spur, joined to the trunk by a sample or so.
  assert.ok(branchLength > 4_900 && branchLength < 5_200, String(branchLength));
});

test('a parallel track beside a drawn one is jitter, not a new line', () => {
  const a = eastLine(-71.2, 10_000);
  const b = eastLine(-71.2, 9_000, 100, LAT + 15 / M_PER_DEG); // 15 m north
  const result = buildRailNetworkLines(
    { shapes: [a, b], routes: { r: [0, 1] } },
    everyRoute,
  );
  assert.equal(result.lines.length, 1);
});

test('uncovered stretches shorter than the minimum run are dropped', () => {
  const trunk = eastLine(-71.2, 10_000);
  // Leaves the trunk for a stub shorter than the minimum, then ends.
  const stub = eastLine(-71.2, 5_000);
  const endLon = stub[stub.length - 1];
  const stubM = NETWORK_MIN_RUN_M / 2;
  for (let d = 20; d <= stubM; d += 20) stub.push(LAT - d / M_PER_DEG, endLon);
  const result = buildRailNetworkLines(
    { shapes: [trunk, stub], routes: { r: [0, 1] } },
    everyRoute,
  );
  assert.equal(result.lines.length, 1);
});

test('shapes of routes the layer does not draw are left out', () => {
  const result = buildRailNetworkLines(
    { shapes: [eastLine(-71.2, 5_000)], routes: { bus: [0] } },
    () => null,
  );
  assert.deepEqual(result.lines, []);
  assert.equal(result.shapesIn, 0);
  assert.deepEqual(buildRailNetworkLines(null, everyRoute).lines, []);
});

test('the step builder yields once per shape and ends with the same union', () => {
  const raw = {
    shapes: [
      eastLine(-71.2, 20_000),
      eastLine(-71.2, 8_000),
      eastLine(-71.3, 3_000),
    ],
    routes: { r: [0, 1, 2] },
  };
  const steps = railNetworkLineSteps(raw, everyRoute);
  let yields = 0;
  let next = steps.next();
  while (!next.done) {
    yields += 1;
    next = steps.next();
  }
  assert.equal(yields, 3);
  assert.deepEqual(
    next.value.lines.map((line) => Array.from(line.coords)),
    buildRailNetworkLines(raw, everyRoute).lines.map((line) =>
      Array.from(line.coords),
    ),
  );
});

test('the split falls where the train is on its line, by drawn length', () => {
  // An L-shaped line: 3 km east, then 1 km north, with uneven vertices.
  const coords = eastLine(-71.2, 3_000, 500);
  const cornerLon = coords[coords.length - 1];
  for (let d = 100; d <= 1_000; d += 100)
    coords.push(LAT + d / M_PER_DEG, cornerLon);
  const path = createRailPath(coords);
  const chords = cumulativeChords(path);
  assert.equal(chords.length, path.n);
  assert.ok(Math.abs(chords[path.n - 1] - path.length) < 1e-6);

  // A train reported 1.5 km along, a little off the track.
  const hit = projectOnPath(path, LAT + 8 / M_PER_DEG, -71.2 + 1_500 / KX);
  assert.ok(Math.abs(hit.s - 1_500) < 1);
  const fraction = splitFraction(path, chords, hit.s);
  assert.ok(Math.abs(fraction - 1_500 / 4_000) < 1e-3);

  // The drawn point at the split is the train's point on the line.
  const at = pointAtS(path, fraction * path.length);
  assert.ok(Math.abs(at.lon - (-71.2 + 1_500 / KX)) < 1e-6);

  // Ends and out-of-range arcs clamp; bad input is NaN, not a guess.
  assert.equal(splitFraction(path, chords, -50), 0);
  assert.equal(splitFraction(path, chords, path.length + 50), 1);
  assert.ok(Number.isNaN(splitFraction(path, chords, NaN)));
  assert.ok(Number.isNaN(splitFraction(path, new Float64Array(2), 10)));
  assert.ok(Number.isNaN(splitFraction(null, chords, 10)));
});

test('by vertex index, the split follows a line drawn per vertex', () => {
  // Vertices at 0, 500, 2500 m: by index the middle vertex is halfway.
  const coords = [LAT, -71.2, LAT, -71.2 + 500 / KX, LAT, -71.2 + 2_500 / KX];
  const path = createRailPath(coords);
  const byIndex = vertexIndexChords(path);
  assert.deepEqual(Array.from(byIndex), [0, 1, 2]);
  assert.ok(Math.abs(splitFraction(path, byIndex, 500) - 0.5) < 1e-9);
  // 1500 m is halfway along the second segment: index 1.5 of 2.
  assert.ok(Math.abs(splitFraction(path, byIndex, 1_500) - 0.75) < 1e-9);
  // By length the same arc is 0.6 of the line.
  assert.ok(
    Math.abs(splitFraction(path, cumulativeChords(path), 1_500) - 0.6) < 1e-6,
  );
});

test('the network fades out between its two altitudes', () => {
  assert.equal(networkAltitudeFade(15_000, 150_000, 200_000), 1);
  assert.equal(networkAltitudeFade(150_000, 150_000, 200_000), 1);
  assert.equal(networkAltitudeFade(175_000, 150_000, 200_000), 0.5);
  assert.equal(networkAltitudeFade(200_000, 150_000, 200_000), 0);
  assert.equal(networkAltitudeFade(3_000_000, 150_000, 200_000), 0);
  assert.equal(networkAltitudeFade(Infinity, 150_000, 200_000), 0);
  assert.equal(networkAltitudeFade(NaN, 150_000, 200_000), 0);
});

test('the selected train’s line is its trip’s shape, else its route’s longest', async (t) => {
  const pack = {
    version: 1,
    feedId: 'mbta-rail',
    shapes: [eastLine(-71.08, 3000), eastLine(-71.08, 3000, 3000, LAT + 0.01)],
    dist: [[], []],
    shapeSources: ['operator', 'operator'],
    trips: { 'trip-T1': 0 },
    routes: { R1: [0], R2: [1] },
  };
  const app = harness(t, { paths: { 'mbta-rail': pack } });
  app.feeds.set('mbta-rail', () => [
    train('T1', LAT, -71.07, { routeId: 'R1' }),
    train('T2', LAT + 0.01, -71.07, { routeId: 'R2' }),
  ]);
  await app.enable();
  for (const [id, shapeIndex, vertices] of [
    ['T1', 0, 31],
    ['T2', 1, 2],
  ]) {
    const key = railTrainKey('mbta-rail', id);
    app.parts().selection.selectTrain(key);
    const { route } = app.layer.getRouteDisplayStats();
    assert.equal(
      route?.id,
      `${key}
mbta-rail
${shapeIndex}`,
      id,
    );
    assert.equal(route.vertices, vertices, id);
  }
});

/** A one-shape Boston pack for mbta-rail. */
const BOSTON_PACK = Object.freeze({
  version: 1,
  feedId: 'mbta-rail',
  shapes: [eastLine(-71.08, 3000)],
  dist: [[]],
  trips: {},
  routes: { R1: [0] },
});
const OCEAN = { lat: 30, lon: -40 };
const mbtaPaths = (app) =>
  app.requestedPaths.filter((id) => id === 'mbta-rail').length;

test('a path pack the server cannot read now is asked for again on a stepped delay', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const paths = { 'mbta-rail': 503 };
  const app = harness(t, { paths });
  app.feeds.set('mbta-rail', () => []);
  await app.enable();
  assert.equal(mbtaPaths(app), 1);
  await app.poll();
  assert.equal(mbtaPaths(app), 1, 'not on every poll');
  t.mock.timers.tick(SCHEDULE_RETRY_FIRST_MS);
  await app.poll();
  assert.equal(mbtaPaths(app), 2, 'again after 30 s');
  // The second failure waits twice as long.
  t.mock.timers.tick(SCHEDULE_RETRY_FIRST_MS);
  await app.poll();
  assert.equal(mbtaPaths(app), 2);
  paths['mbta-rail'] = BOSTON_PACK;
  t.mock.timers.tick(SCHEDULE_RETRY_FIRST_MS);
  await app.poll();
  assert.equal(mbtaPaths(app), 3);
  assert.equal(app.state()._pathPacks.get('mbta-rail').status, 'ready');
});

test('a feed out of use for ten minutes gives back its network and packs', async (t) => {
  const app = harness(t, { paths: { 'mbta-rail': BOSTON_PACK } });
  app.feeds.set('mbta-rail', () => []);
  await app.enable();
  t.mock.timers.tick(0);
  assert.ok(app.state()._networks.has('mbta-rail'));
  assert.equal(app.state()._pathPacks.get('mbta-rail').status, 'ready');
  // Away from Boston: kept for a quick return...
  await app.moveCamera(OCEAN);
  assert.ok(!app.state()._activeFeeds.has('mbta-rail'));
  t.mock.timers.tick(FEED_RELEASE_AFTER_MS - 60_000);
  await app.poll();
  assert.ok(app.state()._networks.has('mbta-rail'));
  assert.ok(app.state()._pathPacks.has('mbta-rail'));
  // ...and released after ten minutes out of use.
  t.mock.timers.tick(60_000);
  await app.poll();
  assert.ok(!app.state()._networks.has('mbta-rail'));
  assert.ok(!app.state()._pathPacks.has('mbta-rail'));
  // Back in Boston, the pack loads again.
  await app.moveCamera(BOSTON);
  assert.equal(mbtaPaths(app), 2);
});

test('a feed in use keeps its network however long it runs', async (t) => {
  const app = harness(t, { paths: { 'mbta-rail': BOSTON_PACK } });
  app.feeds.set('mbta-rail', () => []);
  await app.enable();
  t.mock.timers.tick(0);
  for (let i = 0; i < 3; i += 1) {
    t.mock.timers.tick(FEED_RELEASE_AFTER_MS);
    await app.poll();
  }
  assert.ok(app.state()._networks.has('mbta-rail'));
  assert.equal(mbtaPaths(app), 1);
});

test('with the layer off, its feeds are released after ten minutes', async (t) => {
  const app = harness(t, { paths: { 'mbta-rail': BOSTON_PACK } });
  app.feeds.set('mbta-rail', () => []);
  await app.enable();
  t.mock.timers.tick(0);
  app.layer.disable(app.viewer);
  assert.ok(app.state()._networks.has('mbta-rail'), 'kept for a quick return');
  t.mock.timers.tick(FEED_RELEASE_AFTER_MS);
  assert.ok(!app.state()._networks.has('mbta-rail'));
  assert.ok(!app.state()._pathPacks.has('mbta-rail'));
});
