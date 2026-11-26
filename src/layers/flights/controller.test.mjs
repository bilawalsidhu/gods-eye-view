import assert from 'node:assert/strict';
import test from 'node:test';
import { bindRenderer } from '../../render/rendererOf.js';
import { createController } from './controller.js';

const controller = () =>
  createController({ flightState: { feed: {} }, parts: {}, layer: {} });

test('the feed is asked for the flights around the camera port’s ground point', () => {
  let pose = { lon: -97.04, lat: 32.9, height: 9000 };
  const viewer = {};
  const unbind = bindRenderer(viewer, { camera: { pose: () => pose } });
  try {
    const { _flightQuery } = controller();
    assert.deepEqual(_flightQuery(viewer), {
      latitude: 32.9,
      longitude: -97.04,
    });
    pose = { lon: NaN, lat: NaN, height: NaN };
    assert.deepEqual(_flightQuery(viewer), {}, 'no ground point: no area');
    pose = { lon: -97.04, lat: NaN, height: 9000 };
    assert.deepEqual(_flightQuery(viewer), {}, 'half a ground point: none');
  } finally {
    unbind();
  }
});

test('with no viewer or camera the query names no area', () => {
  const { _flightQuery } = controller();
  assert.deepEqual(_flightQuery(null), {});
  assert.deepEqual(_flightQuery(undefined), {});
  assert.deepEqual(_flightQuery({}), {}, 'a viewer with no camera');
  assert.deepEqual(
    _flightQuery({ isDestroyed: () => true, camera: {} }),
    {},
    'a destroyed viewer',
  );
});
