import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTrail } from './trailRenderer.js';

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

// --- Branch floor (cycle 4): the quiet exits and dedupe contract -------------

function makeViewer({ destroyed = false } = {}) {
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    viewer: {
      isDestroyed: () => destroyed,
      entities: {
        add(def) { added.push(def); return def; },
        remove(entity) { removed.push(entity); },
      },
    },
  };
}

test('a destroyed or missing viewer silently ignores every geometry update', () => {
  const { viewer } = makeViewer({ destroyed: true });
  const trail = createTrail(viewer, { color: '#ffffff' });
  trail.setPositions([new Cesium.Cartesian3(1, 2, 3), new Cesium.Cartesian3(4, 5, 6)]);
  // No entity was created and nothing threw.
  trail.destroy();
  // A null viewer never creates an entity either.
  const orphan = createTrail(null, { color: '#ffffff' });
  orphan.setPositions([]);
  orphan.setVisible(false);
  orphan.destroy();
});

test('fewer than two distinct positions clears the trail; near-duplicates merge', () => {
  const { viewer, added } = makeViewer();
  const trail = createTrail(viewer, { color: '#ff0000' });
  // Dedupe keeps first-of-run: zero-length segments add nothing.
  trail.setPositions([
    new Cesium.Cartesian3(0, 0, 0),
    new Cesium.Cartesian3(0, 0, 0.05), // distanceSq 0.0025 < 0.01 → merged
    new Cesium.Cartesian3(10, 0, 0),
    null, // junk entries are dropped, not crashes
  ]);
  assert.equal(added.length, 1, 'the entity is created lazily on the first real geometry');
  const geometry = added[0].polyline.positions.getValue();
  assert.equal(geometry.length, 2, 'merged duplicate + dropped null leave the two real points');
  // Sub-threshold run collapses to fewer than 2 → the trail empties (entity stays).
  trail.setPositions([new Cesium.Cartesian3(1, 1, 1), new Cesium.Cartesian3(1, 1, 1)]);
  assert.equal(added[0].polyline.positions.getValue().length, 0);
  // A non-array argument behaves as an empty update.
  trail.setPositions(undefined);
  assert.equal(added[0].polyline.positions.getValue().length, 0);
});

test('destroy is idempotent and swallows a viewer teardown race', () => {
  const { viewer, removed } = makeViewer();
  const trail = createTrail(viewer, { color: '#00ff00' });
  trail.setPositions([new Cesium.Cartesian3(0, 0, 0), new Cesium.Cartesian3(1, 1, 1)]);
  trail.destroy();
  assert.equal(removed.length, 1);
  trail.setPositions([new Cesium.Cartesian3(2, 2, 2), new Cesium.Cartesian3(3, 3, 3)]);
  assert.equal(removed.length, 1, 'a destroyed trail never re-creates geometry');
  // A second destroy must not remove twice or throw.
  trail.destroy();
  assert.equal(removed.length, 1);
  // An entity-removal throw during viewer teardown is swallowed.
  const hostile = makeViewer();
  hostile.viewer.entities.remove = () => { throw new Error('torn down'); };
  const hostileTrail = createTrail(hostile.viewer, { color: '#0000ff' });
  hostileTrail.setPositions([new Cesium.Cartesian3(0, 0, 0), new Cesium.Cartesian3(1, 1, 1)]);
  hostileTrail.destroy();
});
