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

test('trail positions may be plain ECEF: the polyline still draws Cartesian3s', () => {
  const added = [];
  const viewer = {
    isDestroyed: () => false,
    entities: {
      add(definition) {
        added.push(definition);
        return definition;
      },
      remove() {},
    },
  };
  const trail = createTrail(viewer, { color: '#ffffff' });
  const given = new Cesium.Cartesian3(1, 2, 3);
  trail.setPositions([given, { x: 1, y: 2, z: 3.01 }, { x: 4, y: 5, z: 6 }]);
  const drawn = added[0].polyline.positions.getValue();
  // The near-duplicate merges; a Cartesian3 given passes through as it is.
  assert.equal(drawn.length, 2);
  assert.equal(drawn[0], given);
  assert.ok(drawn[1] instanceof Cesium.Cartesian3);
  assert.deepEqual([drawn[1].x, drawn[1].y, drawn[1].z], [4, 5, 6]);
});
