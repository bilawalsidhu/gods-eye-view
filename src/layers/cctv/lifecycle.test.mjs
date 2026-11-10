import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';
import { createNavigation } from './navigation.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';

function setup(t, { failMarkers = false } = {}) {
  const noop = () => {};
  const services = {
    overlays: {
      clearSource: noop,
      hitTest: noop,
      setEntries: noop,
      setVisible: noop,
    },
    activation: {},
    picking: { unregisterPickOwner: noop },
    focus: {},
    render: { releaseContinuousRender: noop },
  };
  const state = createState({ services });
  const pending = [];
  const renderers = [];
  const parts = {
    geometryQueue: { stopGeometryLoadQueue: noop },
    cards: { teardownAmbientCards: noop, handleVisibilityChange: noop },
    projection: { clearProjectionOverlay: noop, stopProjectionLoop: noop },
    geometry: { destroyCoverageEntities: noop },
    calibration: { loadCalibrationStore: () => new Map() },
    catalog: {
      loadCameraSources: () => new Promise((resolve) => pending.push(resolve)),
    },
  };
  const rendererFactory = () => {
    const renderer = {
      owner: null,
      released: false,
      releases: 0,
      hideCredit() {},
      attach(owner) {
        this.owner = owner;
      },
      createMarkers() {
        if (failMarkers) throw new Error('marker allocation failed');
      },
      destroy() {
        if (!this.released) {
          this.released = true;
          this.releases++;
        }
      },
    };
    renderers.push(renderer);
    return renderer;
  };
  const layer = createLifecycle({
    state,
    services,
    parts,
    rendererFactory,
  }).methods;
  t.after(() => layer.destroy());
  return { state, pending, parts, layer, renderers };
}

test('repeated initialization rejects without replacing the current CCTV owner', async (t) => {
  const h = setup(t);
  const owner = {};
  const starting = h.layer.init(owner);
  const stopped = assert.rejects(starting, { name: 'AbortError' });
  await assert.rejects(h.layer.init({}), /already initialized/);
  assert.equal(h.renderers.length, 1);
  assert.equal(h.parts.renderer.owner, owner);
  assert.equal(h.parts.renderer.released, false);
  h.layer.destroy({});
  h.pending[0]([]);
  await stopped;
  assert.equal(h.renderers[0].releases, 1);
});

test('a retired init rejection cannot destroy the newer CCTV owner', async (t) => {
  const h = setup(t);
  const first = assert.rejects(h.layer.init({}), { name: 'AbortError' });
  h.layer.destroy();
  const owner = {};
  const second = assert.rejects(h.layer.init(owner), { name: 'AbortError' });
  const current = h.parts.renderer;
  h.pending[0]([]);
  await first;
  assert.equal(h.parts.renderer, current);
  assert.equal(current.owner, owner);
  assert.equal(current.released, false);
  assert.equal(h.state._sourceAbort.signal.aborted, false);
  h.layer.destroy();
  h.pending[1]([]);
  await second;
  assert.deepEqual(
    h.renderers.map((renderer) => renderer.releases),
    [1, 1],
  );
});

test('initial resource failure disposes its owner and leaves initialization retryable', async (t) => {
  const h = setup(t, { failMarkers: true });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(h.layer.init({}), /marker allocation failed/);
    assert.equal(h.parts.renderer, null);
    assert.equal(h.state._sourceAbort.signal.aborted, true);
  }
  assert.deepEqual(
    h.renderers.map((renderer) => renderer.releases),
    [1, 1],
  );
});

test('destroy releases focus-appearance callbacks even without prior disable', (t) => {
  const h = setup(t);
  let released = 0;
  h.state._removeFocusAppearListener = () => released++;
  h.layer.destroy();
  h.layer.destroy();
  assert.equal(released, 1);
});

test('enabling CCTV opens nearest to the engine camera and preserves a restored selection', (t) => {
  const { state, parts, layer } = setup(t);
  const engine = createFakeEngine({ latitude: 0, longitude: 1 });
  t.after(() => engine.destroy());
  state._records = [
    { camera: { id: 'far', lat: 0, lon: 0 } },
    { camera: { id: 'near', lat: 0, lon: 180 / Math.PI } },
  ];
  parts.renderer = {
    cameraCartographic: () => engine.camera.pose().cartographic,
    destroy() {},
    hideCredit() {},
  };
  parts.model = {
    haversineKm: (_lat, lon, _otherLat, otherLon) => Math.abs(lon - otherLon),
  };
  parts.navigation = createNavigation({ state, parts });
  layer.showRenderer = () => {};
  layer.enable();
  assert.equal(state._activeCameraId, 'near');
  assert.equal(state._openingCameraProvisional, true);
  state._activeCameraId = 'far';
  state._openingCameraProvisional = false;
  layer.enable();
  assert.equal(state._activeCameraId, 'far');
  assert.equal(state._openingCameraProvisional, false);
  state._enabled = false;
});
