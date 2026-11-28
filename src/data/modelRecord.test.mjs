import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createModelRecord,
  modelIsRendering,
  placeModel,
} from './modelRecord.js';

test('a placed model has the frame the Cesium renderer poses it in', () => {
  for (const [lon, lat, height] of [
    [-97.7, 30.2, 300],
    [10, -60, 1000],
    [179, 89.9, 0],
  ])
    for (const heading of [0, 0.5, 2, 4, -1]) {
      const at = Cesium.Cartesian3.fromDegrees(lon, lat, height);
      const expected = Cesium.Transforms.headingPitchRollToFixedFrame(
        at,
        new Cesium.HeadingPitchRoll(heading, 0, 0),
        Cesium.Ellipsoid.WGS84,
        undefined,
        new Cesium.Matrix4(),
      );
      const record = createModelRecord({ specKey: 'a@1', bellyM: 0 });
      placeModel(record, { x: at.x, y: at.y, z: at.z }, heading);
      const frame = record.matrix;
      for (let i = 0; i < 16; i++)
        assert.ok(
          Math.abs(frame[i] - expected[i]) < (i >= 12 ? 1e-6 : 1e-12),
          `${lon},${lat} @ ${heading}: element ${i}`,
        );
    }
});

test('a record renders only once ready and shown', () => {
  const record = createModelRecord({ specKey: 'a@1', bellyM: 2 });
  assert.equal(record.ready, false);
  assert.equal(modelIsRendering(record), false);
  record.show = true;
  assert.equal(modelIsRendering(record), false);
  record.ready = true;
  assert.equal(modelIsRendering(record), true);
  const at = { x: 1, y: 2, z: 6_400_000 };
  placeModel(record, at, 0.3);
  at.x = 99;
  assert.equal(record.position.x, 1, 'the position is copied');
  assert.equal(record.matrix[12], 1);
  assert.equal(record.heading, 0.3);
  assert.equal(modelIsRendering(null), false);
});
