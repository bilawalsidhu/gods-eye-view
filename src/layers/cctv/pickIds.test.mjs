import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';
import { CCTV_HELPER_PICK_ID } from './pickIds.js';
import { GIZMO_ID_PREFIX } from '../../data/cctvGizmo.js';

function controlsWith(cameras) {
  const state = {
    _recordById: new Map(cameras.map((camera) => [camera.id, { camera }])),
  };
  return createControls({
    state,
    services: { render: {}, activation: {} },
    parts: {},
    source: {},
  }).methods;
}

const camera = {
  id: 'drivebc-17',
  name: 'Hwy 1 at Main',
  lat: 49.2,
  lon: -123.1,
};

test('every helper geometry role maps to its camera id', () => {
  const methods = controlsWith([camera]);
  for (const role of [
    'ray-tl',
    'ray-tr',
    'ray-br',
    'ray-bl',
    'cap',
    'plane',
    'plane-label',
  ]) {
    assert.equal(
      methods.recordIdForPick(`cctv-drivebc-17-${role}`),
      'drivebc-17',
      role,
    );
  }
});

test('a camera id maps to itself', () => {
  assert.equal(
    controlsWith([camera]).recordIdForPick('drivebc-17'),
    'drivebc-17',
  );
});

test('unknown cameras, unknown roles and gizmo ids map to nothing', () => {
  const methods = controlsWith([camera]);
  assert.equal(methods.recordIdForPick('cctv-other-plane'), null);
  assert.equal(methods.recordIdForPick('cctv-drivebc-17-frame'), null);
  assert.equal(methods.recordIdForPick(`${GIZMO_ID_PREFIX}drivebc-17`), null);
  assert.equal(methods.recordIdForPick(null), null);
});

test('a camera id that itself contains dashes still maps through a role suffix', () => {
  const methods = controlsWith([{ id: 'a-b-c' }]);
  assert.equal(methods.recordIdForPick('cctv-a-b-c-ray-br'), 'a-b-c');
  assert.equal(
    CCTV_HELPER_PICK_ID.exec('cctv-a-b-c-plane-label')?.[1],
    'a-b-c',
  );
});

test('the camera card reads its name and position', () => {
  const methods = controlsWith([camera]);
  assert.deepEqual(methods.findByQuery('drivebc-17'), {
    name: 'Hwy 1 at Main',
    latitude: 49.2,
    longitude: -123.1,
  });
  assert.equal(methods.findByQuery('cctv-drivebc-17-plane'), null);
});
