import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createControls } from './controls.js';

test('orbital ground focus reads the drawn height and the engine pick id', () => {
  const record = { id: 'osm:node:12', kind: 'installation', latitude: 70, longitude: 179.8 };
  const state = { enabled: true, recordById: new Map([[record.id, record]]) };
  const controls = createControls({
    state,
    services: {},
    parts: { model: { installationSurfaceHeightM: () => 126 } },
    source: {},
  }).methods;
  assert.deepEqual(controls.findByPick({ id: record.id }), {
    ...record,
    position: geo.cartesian3.fromDegrees(179.8, 70, 126),
  });
  assert.equal(controls.findByPick({ id: 'another-layer' }), null);
  assert.equal(controls.findByPick(null), null);
  state.enabled = false;
  assert.equal(controls.getById(record.id), null);
  assert.equal(controls.findByPick({ id: record.id }), null);
});

test('focus frames a selected installation through the globe engine camera', () => {
  const record = { id: 'osm:node:12', latitude: 70, longitude: 179.8 };
  let flight = null;
  const state = {
    engine: {
      camera: {
        flyToSphere: (sphere, options) => {
          flight = { sphere, options };
        },
      },
    },
    recordById: new Map([[record.id, record]]),
  };
  const controls = createControls({
    state,
    services: {},
    parts: {
      display: { selectRecord: (id) => id === record.id },
      model: { installationSurfaceHeightM: () => 126 },
    },
    source: {},
  }).methods;

  assert.equal(controls.focusById(record.id), true);
  assert.deepEqual(
    flight.sphere.center,
    geo.cartesian3.fromDegrees(179.8, 70, 126),
  );
  assert.equal(flight.sphere.radius, 18000);
  assert.deepEqual(flight.options, { duration: 1.4 });
});
