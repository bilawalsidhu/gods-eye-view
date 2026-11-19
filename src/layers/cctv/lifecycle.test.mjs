import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { resolvePickId } from '../../data/pickRegistry.js';
import { fakeInputUnderLabel } from '../../input/testDoubles.mjs';

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

/** A part whose members are `own`'s, and any other a function that does
 *  nothing. */
const inert = (own = {}) =>
  new Proxy(own, {
    get: (target, name) => (name in target ? target[name] : () => {}),
  });

test("a click a label painted over a camera's card takes never turns that camera on, and lets go of the active one", async (t) => {
  const { viewer } = viewerWithCamera();
  viewer.scene = { canvas: {}, pick: () => null };
  const fake = fakeInputUnderLabel(viewer);
  t.after(() => fake.destroy());
  const activated = [];
  const deactivated = [];
  const state = {};
  const lifecycle = createLifecycle({
    state,
    services: {
      activation: {
        activateCctvCameraFromWorldClick: (id) => activated.push(id),
      },
      picking: { resolvePickId },
      focus: {},
      render: {},
    },
    parts: {
      calibration: { loadCalibrationStore: () => new Map() },
      catalog: {
        loadCameraSources: async () => [],
        buildCatalogFromSources: () => [],
        seedCatalog: () => [],
      },
      ground: {
        resolveGroundPriors: async () => [],
        currentSurfaceRegime: () => null,
      },
      rendering: inert({ refreshHorizonCulling: () => false }),
      health: { syncHealthState: async () => {} },
      geometryQueue: inert(),
      cards: inert(),
      projection: inert(),
      presentation: inert(),
      navigation: inert(),
      hover: inert(),
      selection: {
        // The camera's own gate takes only clean clicks; these are.
        bindCctvWorldClickGesture: (input, onClick) => input.onClick(onClick),
        extractPickedCameraId: () => null,
        cctvEmptyClickDeselects: (picked, { activeCameraId }) =>
          Boolean(activeCameraId) && resolvePickId(picked) === null,
        deactivateActiveCamera: () => deactivated.push(state._activeCameraId),
      },
    },
  });
  // Init's bounded wait for ground heights never runs out here: they are in.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await lifecycle.methods.init(viewer);
  t.after(() => state._clickSubscription?.());
  state._enabled = true;
  state._activeCameraId = 'cam-0';
  state._recordById.set('cam-1', {});
  // The card of camera `cam-1` lies under every click.
  state._cctvOverlayHost = {
    hitTest: (_x, _y, { sourceId }) =>
      sourceId === CCTV_OVERLAY_SOURCE_ID ? { entryId: 'cam-1' } : null,
  };

  fake.label.over = true;
  fake.click();
  assert.deepEqual(activated, [], 'the camera under the label stays off');
  assert.deepEqual(deactivated, ['cam-0'], 'the active camera is let go');

  // Off the label, a click on the card turns its camera on.
  fake.label.over = false;
  fake.click();
  assert.deepEqual(activated, ['cam-1']);
});
