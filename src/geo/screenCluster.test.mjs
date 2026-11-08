import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.deepEqual(
    result.clusters.map((c) => c.ids),
    expected,
  );
});
