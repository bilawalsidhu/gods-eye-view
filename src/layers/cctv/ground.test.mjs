import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGround } from './ground.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

function setup(record) {
  const calls = { culling: 0, geometry: [], notify: 0 };
  const state = {
    _viewer: null,
    _recordById: new Map([[record.camera.id, record]]),
  };
  const parts = {
    rendering: {
      refreshHorizonCulling: () => (calls.culling++, true),
      moveCameraIcon() {},
    },
    geometryQueue: { enqueueViewGeometry() {} },
    presentation: { notifyListeners: () => calls.notify++ },
    geometry: {
      // Same choice as geometry.updateRecordGeometry on a globe with a cold floor cell.
      updateRecordGeometry(r) {
        calls.geometry.push(
          ground.groundPriorAltFor(r) + r.camera.mountHeightM,
        );
      },
    },
  };
  const ground = createGround({
    state,
    services: {
      ground: { resolveGroundFloorCells: async () => {} },
      terrain: { resolveEllipsoidalGround: async () => [] },
    },
    parts,
  });
  return { ground, calls };
}

test('a late geoid fallback leaves a drawn-terrain height in place', () => {
  const camera = {
    id: 'a',
    lat: 42,
    lon: -118,
    mountHeightM: 8,
    absoluteHeightM: 1880,
  };
  const record = {
    camera,
    position: fromDegrees(camera.lon, camera.lat, 1880),
    frustumGeometry: {},
    frustumPositions: {},
    groundSamples: {},
    groundResolved: {},
    groundPrior: { ellipsoid: 1872, source: 'drawn-terrain', rangeM: 2000 },
  };
  const { ground, calls } = setup(record);
  ground.applyLateGroundPriors(
    [record],
    [{ ellipsoid: 0, source: 'geoid-fallback' }],
  );

  assert.equal(record.groundPrior.source, 'drawn-terrain');
  assert.ok(!calls.geometry.includes(8), 'mount not lowered to the fallback');
});
