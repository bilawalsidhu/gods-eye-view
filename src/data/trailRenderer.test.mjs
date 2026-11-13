import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { CHUNK_POINTS, createTrail } from './trailRenderer.js';

test('trail visibility can change without discarding its accumulated geometry', () => {
  const added = [];
  const removed = [];
  const viewer = {
    isDestroyed: () => false,
    entities: {
      add(definition) {
        added.push(definition);
        return definition;
      },
      remove(entity) {
        removed.push(entity);
      },
    },
  };
  const trail = createTrail(viewer, { color: '#ffffff' });
  const positions = [
    new Cesium.Cartesian3(1, 2, 3),
    new Cesium.Cartesian3(4, 5, 6),
  ];

  trail.setVisible(false);
  trail.setPositions(positions);
  assert.equal(added.length, 1);
  assert.equal(added[0].show, false);
  assert.deepEqual(added[0].polyline.positions.getValue(), positions);

  trail.setVisible(true);
  assert.equal(added[0].show, true);
  assert.deepEqual(added[0].polyline.positions.getValue(), positions);

  trail.destroy();
  assert.deepEqual(removed, [added[0]]);
});

/**
 * A fake viewer. `ready` holds the frozen-chunk entities whose static
 * geometry is in the scene; `frame()` runs one post-render pass.
 */
function fakeViewer({ scene = true } = {}) {
  const added = [];
  const removed = [];
  const ready = new Set();
  let listeners = [];
  const viewer = {
    added,
    removed,
    ready,
    isDestroyed: () => false,
    entities: {
      add(definition) {
        added.push(definition);
        return definition;
      },
      remove(entity) {
        removed.push(entity);
      },
    },
    listenerCount: () => listeners.length,
    frame() {
      for (const listener of listeners.slice()) listener();
    },
  };
  if (scene) {
    viewer.scene = {
      postRender: {
        addEventListener(listener) {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((l) => l !== listener);
          };
        },
      },
    };
    viewer.dataSourceDisplay = {
      getBoundingSphere: (entity) =>
        ready.has(entity)
          ? Cesium.BoundingSphereState.DONE
          : Cesium.BoundingSphereState.PENDING,
    };
  }
  return viewer;
}

const valueOf = (positions) =>
  typeof positions?.getValue === 'function' ? positions.getValue() : positions;

/** Every line the scene can draw now: live entities with two or more points. */
function drawnRuns(viewer) {
  return viewer.added
    .filter((entity) => !viewer.removed.includes(entity))
    .map((entity) => valueOf(entity.polyline.positions))
    .filter((positions) => positions.length >= 2);
}

/** Distinct position objects across all drawn lines. */
function drawnPoints(viewer) {
  return new Set(drawnRuns(viewer).flat());
}

function line(count, offset = 0) {
  return Array.from(
    { length: count },
    (_, i) => new Cesium.Cartesian3(6_378_137 + offset, i * 1000, 0),
  );
}

test('a trail with breaks draws each segment and nothing between them', () => {
  const viewer = fakeViewer({ scene: false });
  const trail = createTrail(viewer, { color: '#ffffff' });
  const first = line(2, 0);
  const lone = line(1, 50_000);
  const second = line(3, 100_000);

  trail.setSegments([first, lone, second]);
  assert.deepEqual(
    drawnRuns(viewer).sort((a, b) => a[0].x - b[0].x),
    [first, second],
  );
  for (const entity of viewer.added) {
    assert.match(String(entity.id), /^gev-trail:/);
    assert.equal(entity.polyline.width, 2.5);
  }

  // The first segment is gone later: its geometry is released.
  trail.setSegments([second]);
  assert.deepEqual(drawnRuns(viewer), [second]);

  trail.setVisible(false);
  assert.ok(
    viewer.added
      .filter((entity) => !viewer.removed.includes(entity))
      .every((entity) => entity.show === false),
  );
  trail.destroy();
  assert.equal(new Set(viewer.removed).size, viewer.added.length);
});

test('chunks share their boundary points and only the newest chunk is dynamic', () => {
  const viewer = fakeViewer({ scene: false });
  const trail = createTrail(viewer, { color: '#ffffff' });
  const points = line(300);
  trail.setPositions(points);
  const { frozen, dynamic } = trail._chunksForTest();
  assert.deepEqual(
    frozen.map((chunk) => chunk.positions.length),
    [CHUNK_POINTS, CHUNK_POINTS],
  );
  assert.equal(frozen[0].positions.at(-1), frozen[1].positions[0]);
  assert.equal(dynamic.length, 1);
  assert.equal(frozen[1].positions.at(-1), dynamic[0][0]);
  assert.equal(dynamic[0].at(-1), points.at(-1));
  assert.equal(drawnPoints(viewer).size, points.length);
  // A frozen chunk is constant geometry, not a per-frame callback.
  for (const chunk of frozen)
    assert.ok(Array.isArray(chunk.entity.polyline.positions));
});

test('freezing a chunk keeps every point drawn, and the dynamic copy goes only once the static geometry is in', () => {
  const viewer = fakeViewer();
  const trail = createTrail(viewer, { color: '#ffffff' });
  const points = line(CHUNK_POINTS + 20);
  for (let n = 2; n <= points.length; n++) {
    trail.setPositions(points.slice(0, n));
    assert.equal(drawnPoints(viewer).size, n, `points drawn at ${n}`);
  }
  const { frozen } = trail._chunksForTest();
  assert.equal(frozen.length, 1);
  // Not in the scene yet: the chunk is still drawn by a dynamic polyline.
  viewer.frame();
  assert.equal(trail._chunksForTest().frozen[0].standIn, true);
  assert.ok(
    trail._chunksForTest().dynamic.includes(frozen[0].positions),
    'the dynamic copy stays until the static geometry is ready',
  );
  viewer.ready.add(frozen[0].entity);
  viewer.frame();
  const after = trail._chunksForTest();
  assert.equal(after.frozen[0].standIn, false);
  assert.ok(!after.dynamic.includes(frozen[0].positions));
  assert.equal(after.dynamic.length, 1);
  assert.equal(viewer.listenerCount(), 0, 'no listener once nothing waits');
  // The frozen entity is the same object: freezing built it once.
  assert.equal(after.frozen[0].entity, frozen[0].entity);
});

test('a hidden trail keeps its dynamic copy until it is shown and the static geometry is in', () => {
  const viewer = fakeViewer();
  const trail = createTrail(viewer, { color: '#ffffff' });
  trail.setVisible(false);
  trail.setPositions(line(CHUNK_POINTS + 5));
  const [chunk] = trail._chunksForTest().frozen;
  viewer.ready.add(chunk.entity);
  viewer.frame();
  assert.equal(trail._chunksForTest().frozen[0].standIn, true);
  trail.setVisible(true);
  viewer.frame();
  assert.equal(trail._chunksForTest().frozen[0].standIn, false);
});

test('dropping the oldest point rebuilds only the first chunk', () => {
  const viewer = fakeViewer({ scene: false });
  const trail = createTrail(viewer, { color: '#ffffff' });
  const points = line(400);
  trail.setPositions(points);
  const before = trail._chunksForTest().frozen;
  trail.setPositions(points.slice(1));
  const after = trail._chunksForTest().frozen;
  assert.equal(after.length, before.length);
  assert.notEqual(after[0].entity, before[0].entity);
  assert.ok(viewer.removed.includes(before[0].entity));
  for (let k = 1; k < before.length; k++)
    assert.equal(after[k].entity, before[k].entity);
  assert.equal(after[0].positions.at(-1), after[1].positions[0]);
  assert.equal(drawnPoints(viewer).size, 399);
});

test('a backfill prepended ahead of frozen chunks keeps them and joins at a shared point', () => {
  const viewer = fakeViewer({ scene: false });
  const trail = createTrail(viewer, { color: '#ffffff' });
  const live = line(300, 0);
  trail.setPositions(live);
  const before = trail._chunksForTest().frozen;
  // History older than every live point, joined as one path.
  const history = Array.from(
    { length: 200 },
    (_, i) => new Cesium.Cartesian3(6_378_137, -(200 - i) * 1000, 0),
  );
  trail.setPositions(history.concat(live));
  const after = trail._chunksForTest().frozen;
  for (const chunk of before)
    assert.ok(after.some((c) => c.entity === chunk.entity));
  for (let k = 0; k + 1 < after.length; k++)
    assert.equal(after[k].positions.at(-1), after[k + 1].positions[0]);
  assert.equal(drawnPoints(viewer).size, 500);

  // A backfill that breaks from the live trail is its own segment.
  trail.setSegments([history, live]);
  assert.equal(drawnPoints(viewer).size, 500);
  const runs = drawnRuns(viewer);
  assert.ok(
    !runs.some((run) => run.includes(history.at(-1)) && run.includes(live[0])),
    'no line across the break',
  );
});

test('clearing and re-tracking release every frozen chunk', () => {
  const viewer = fakeViewer();
  const trail = createTrail(viewer, { color: '#ffffff' });
  trail.setPositions(line(600));
  const frozen = trail._chunksForTest().frozen.map((chunk) => chunk.entity);
  assert.ok(frozen.length >= 4);
  assert.equal(viewer.listenerCount(), 1);
  trail.clear();
  for (const entity of frozen) assert.ok(viewer.removed.includes(entity));
  assert.equal(viewer.listenerCount(), 0);
  assert.equal(drawnRuns(viewer).length, 0);

  // Another aircraft: nothing of the first one survives.
  const other = line(200, 900_000);
  trail.setPositions(other);
  assert.equal(drawnPoints(viewer).size, 200);
  trail.destroy();
  assert.equal(new Set(viewer.removed).size, viewer.added.length);
  assert.equal(viewer.listenerCount(), 0);
});

test('replacing the newest point and removing points inside the trail draws exactly the new trail', () => {
  const viewer = fakeViewer({ scene: false });
  const trail = createTrail(viewer, { color: '#ffffff' });
  const points = line(400);
  trail.setPositions(points.slice());
  // A recorded point replaces the newest one; a spur point inside a frozen
  // chunk and one at a chunk boundary go.
  points[points.length - 1] = new Cesium.Cartesian3(6_378_137, 399_500, 10);
  points.splice(200, 1);
  points.splice(CHUNK_POINTS - 1, 1);
  trail.setPositions(points.slice());
  assert.deepEqual(drawnPoints(viewer), new Set(points));
  // Every drawn line runs through consecutive trail points only.
  const next = new Map(points.slice(0, -1).map((p, i) => [p, points[i + 1]]));
  for (const run of drawnRuns(viewer))
    for (let i = 1; i < run.length; i++) assert.equal(next.get(run[i - 1]), run[i]);
});
