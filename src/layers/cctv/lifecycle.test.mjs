import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';

function viewerWithCamera() {
  const camera = fakeCameraPort();
  const viewer = {};
  bindRenderer(viewer, { camera: camera.port });
  return { viewer, camera };
}

function lifecycleFor(state) {
  const passes = [];
  const lifecycle = createLifecycle({
    state,
    services: {
      sprites: {},
      activation: {},
      picking: {},
      focus: {},
      render: {},
    },
    parts: {
      rendering: {
        refreshHorizonCulling: () => {
          passes.push('view');
          return false;
        },
      },
      geometryQueue: { enqueueViewGeometry() {} },
      cards: { refreshAmbientCards() {} },
      presentation: { notifyListeners() {} },
      navigation: { reopenNearestCamera() {} },
    },
  });
  return { lifecycle, passes };
}

test('the view listeners follow the camera port and let go on teardown', () => {
  const first = viewerWithCamera();
  const state = { _viewer: first.viewer, _enabled: false };
  const { lifecycle, passes } = lifecycleFor(state);
  const counts = (camera) => [
    camera.listenerCount('moveStart'),
    camera.listenerCount('moveEnd'),
  ];

  lifecycle.attachViewListeners();
  assert.deepEqual(counts(first.camera), [1, 1]);
  first.camera.emit('moveStart');
  assert.equal(state._cameraMoving, true, 'hover pauses while moving');
  first.camera.emit('moveEnd');
  assert.equal(state._cameraMoving, false);
  assert.deepEqual(passes, ['view'], 'a settled move reruns the view pass');

  // A re-init on the same viewer keeps its listeners.
  lifecycle.attachViewListeners();
  assert.deepEqual(counts(first.camera), [1, 1]);

  // One on a new viewer moves them to its camera.
  const second = viewerWithCamera();
  state._viewer = second.viewer;
  first.camera.emit('moveStart');
  lifecycle.attachViewListeners();
  assert.equal(state._cameraMoving, false, 'the old move is forgotten');
  assert.deepEqual(counts(first.camera), [0, 0]);
  assert.deepEqual(counts(second.camera), [1, 1]);

  lifecycle.detachViewListeners();
  assert.deepEqual(counts(second.camera), [0, 0]);
  assert.equal(state._viewListenerCamera, null);
});
