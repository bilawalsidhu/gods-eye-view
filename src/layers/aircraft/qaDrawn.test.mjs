import test from 'node:test';
import assert from 'node:assert/strict';
import { aircraftQaDrawn } from './qaDrawn.js';

for (const native of [false, true]) {
  test(`heading probe copies model transforms and reads tracked glyph (${native ? 'native' : 'engine'})`, () => {
    const matrix = Float64Array.from({ length: 16 }, (_, i) => i);
    const sprite = {
      position: { x: 1, y: 2, z: 3 },
      rotation: 0.4,
      show: false,
    };
    const model = { modelMatrix: matrix, show: true, ready: true };
    const state = {
      _billboards: new Map([['a', sprite]]),
      _models: new Map([['a', model]]),
      _trackedIcao: 'a',
      _lastTrackedRotation: 0.7,
      _trackedModel: model,
      _trackedEntity: native
        ? {
            billboard: {
              rotation: {
                getValue: () => {
                  throw new Error(
                    'Probe must not evaluate a reactive property',
                  );
                },
              },
            },
          }
        : { rotation: 0.7 },
    };
    const [fleet, tracked] = aircraftQaDrawn(state);
    assert.equal(fleet.trackedRotation, 0.7);
    assert.equal(fleet.rotation, 0.4);
    assert.equal(tracked.model.matrix[12], 12);
    fleet.model.matrix[12] = -1;
    tracked.model.matrix[12] = -2;
    assert.equal(matrix[12], 12);
    assert.equal(aircraftQaDrawn(state)[1].model.matrix[12], 12);
  });
}
