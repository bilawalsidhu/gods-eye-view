import assert from 'node:assert/strict';
import test from 'node:test';
import KDBush from 'kdbush';
import { clusterScreenPoints } from './screenCluster.js';

/** A point at screen `x, y` whose world position is `x, y, 0` too. */
const at = (id, x, y, pixelSize = 13) => ({
  id,
  position: { x, y, z: 0 },
  screen: { x, y },
  pixelSize,
});

const run = (points, extra = {}) =>
  clusterScreenPoints({
    points,
    pixelRange: 42,
    minimumClusterSize: 3,
    viewHeight: 1000,
    eyeHeight: 1_000_000,
    project: (p) => ({ x: p.x, y: p.y }),
    isOccluded: () => false,
    ...extra,
  });

test('points inside a seed’s grown box cluster at their mean, the seed first', () => {
  const result = run([
    at('a', 100, 100),
    at('b', 140, 100),
    at('c', 100, 140),
    at('far', 600, 600),
  ]);
  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0].ids, ['a', 'b', 'c']);
  assert.deepEqual(result.clusters[0].position, {
    x: 340 / 3,
    y: 340 / 3,
    z: 0,
  });
  assert.deepEqual(result.single, ['far']);
});

test('fewer than the minimum stay on their own, and a box reaches half the size plus the range', () => {
  // 6.5 + 42 = 48.5 px each way from the seed.
  const edge = run([
    at('a', 100, 100),
    at('b', 148.5, 100),
    at('c', 100, 51.5),
  ]);
  assert.deepEqual(edge.clusters[0].ids, ['a', 'b', 'c']);
  const out = run([at('a', 100, 100), at('b', 148.6, 100), at('c', 100, 51.5)]);
  assert.deepEqual(out.clusters, []);
  assert.deepEqual(out.single, ['a', 'b', 'c']);
});

test('a point already clustered is not taken again by a later seed', () => {
  const result = run([
    at('a', 100, 100),
    at('b', 120, 100),
    at('c', 140, 100),
    at('d', 160, 100),
    at('e', 180, 100),
  ]);
  assert.deepEqual(
    result.clusters.map((c) => c.ids),
    [['a', 'b', 'c']],
  );
  assert.deepEqual(result.single, ['d', 'e']);
});

test('zooming in keeps last pass’s clusters still in view before seeding anew', () => {
  const points = [at('a', 100, 100), at('b', 140, 100), at('c', 100, 140)];
  const first = run(points);
  const [kept] = first.state.clusters;
  assert.equal(kept.minimumWidth, 97);
  // Closer, with the points spread past a fresh seed's box but inside the
  // kept cluster's (its box is measured from the top, the points' from the
  // bottom, as the default renderer measures them).
  const spread = [at('a', 70, 930), at('b', 200, 800), at('c', 70, 800)];
  const again = run(spread, {
    eyeHeight: 900_000,
    previous: first.state,
    project: () => ({ x: 113, y: 113 }),
  });
  assert.equal(again.clusters.length, 1);
  assert.deepEqual(again.clusters[0].position, first.clusters[0].position);
  assert.deepEqual([...again.clusters[0].ids].sort(), ['a', 'b', 'c']);

  // From higher up, the last pass is not consulted.
  const higher = run(spread, {
    eyeHeight: 1_100_000,
    previous: first.state,
    project: () => ({ x: 113, y: 113 }),
  });
  assert.deepEqual(higher.clusters, []);

  // Nor a cluster now behind the horizon.
  const hidden = run(spread, {
    eyeHeight: 900_000,
    previous: run(points).state,
    project: () => ({ x: 113, y: 113 }),
    isOccluded: () => true,
  });
  assert.deepEqual(hidden.clusters, []);
});

test('many points cluster as a scan of every point would', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const points = Array.from({ length: 600 }, (_, i) =>
    at(`p${i}`, random() * 1600, random() * 1000),
  );
  const result = run(points);
  const all = [...result.single, ...result.clusters.flatMap((c) => c.ids)];
  assert.equal(all.length, 600);
  assert.equal(new Set(all).size, 600, 'each point once');
  // Brute force, as the renderer does it.
  const done = new Set();
  const expected = [];
  const inBox = (s, o) =>
    Math.abs(o.screen.x - s.screen.x) <= 48.5 &&
    Math.abs(o.screen.y - s.screen.y) <= 48.5;
  for (const s of points) {
    if (done.has(s.id)) continue;
    done.add(s.id);
    const ids = [s.id];
    for (const o of points) if (!done.has(o.id) && inBox(s, o)) ids.push(o.id);
    if (ids.length >= 3) {
      expected.push(ids);
      ids.forEach((id) => done.add(id));
    }
  }
  // The same seeds take the same points; the order after the seed is the
  // index's, checked below.
  const seedThenSorted = (ids) => [ids[0], ...ids.slice(1).sort()];
  assert.deepEqual(
    result.clusters.map((c) => seedThenSorted(c.ids)),
    expected.map(seedThenSorted),
  );
});

test('a cluster lists its points in the reference renderer’s KDBush order, so a kept one names the same point first', () => {
  // The reference indexes the points with KDBush (64 per node, 64-bit) and
  // lists a cluster's points in the order a range query returns them.
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const points = Array.from({ length: 400 }, (_, i) =>
    at(`p${i}`, random() * 400, random() * 400),
  );
  const index = new KDBush(points.length, 64, Float64Array);
  for (const p of points) index.add(p.screen.x, 1000 - p.screen.y);
  index.finish();
  const first = run(points);
  const [kept] = first.state.clusters;
  // Closer, at once: the first kept cluster takes every unclustered point in
  // its box, in the index's order.
  // (Its box is measured from the top, the index from the bottom.)
  const coord = { x: 200, y: 800 };
  const again = run(points, {
    eyeHeight: 999_999,
    previous: first.state,
    project: () => coord,
  });
  const width = Math.max(kept.width * 1e-6, kept.minimumWidth);
  const height = Math.max(kept.height * 1e-6, kept.minimumHeight);
  const expected = index
    .range(
      coord.x - width * 0.5,
      coord.y - height * 0.5,
      coord.x + width,
      coord.y + height,
    )
    .map((i) => points[i].id);
  assert.ok(expected.length >= 3, 'the kept cluster holds');
  assert.deepEqual(again.clusters[0].ids, expected);
  const ascending = [...expected].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
  assert.notDeepEqual(expected, ascending, 'the order is not the input order');
});
