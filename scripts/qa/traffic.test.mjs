import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../../src/globe/testing/fakeEngine.js';
import { createReticleFootprint } from '../../src/layers/traffic/footprint.js';
import {
  moveTrafficCamera,
  trafficReadiness,
  whenTrafficSettled,
} from './traffic.mjs';

function fixture(t) {
  const engine = createFakeEngine({ kind: 'cesium' });
  engine.camera.setView({
    destination: { x: 6379137, y: 0, z: 0 },
    orientation: { heading: 0, pitch: -Math.PI / 12, roll: 0 },
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { __godsEyeView: { engine } };
  globalThis.document = { querySelector: () => null };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    engine.destroy();
  });
  return globalThis.window.__godsEyeView;
}

test('oblique fixture preserves collision and maximum flight height on Cesium', async (t) => {
  const app = fixture(t);
  let flight;
  let cancelled = false;
  app.viewer = {
    scene: { screenSpaceCameraController: { enableCollisionDetection: true } },
    camera: {
      cancelFlight() {
        cancelled = true;
      },
      flyTo(options) {
        flight = options;
        options.complete();
      },
    },
  };
  await moveTrafficCamera(
    { evaluate: (fn, ...args) => fn(...args) },
    { lon: 55.037, lat: 24.964, height: 276, pitch: -15 },
    1.4,
  );
  assert.equal(cancelled, true);
  assert.equal(
    app.viewer.scene.screenSpaceCameraController.enableCollisionDetection,
    false,
  );
  assert.ok(Math.abs(flight.maximumHeight - 1000) < 1e-6);
  assert.equal(flight.duration, 1.4);
  assert.equal(flight.orientation.pitch, -Math.PI / 12);
});

test('traffic readiness rejects old coverage, pending debounce and partial populations', async (t) => {
  const app = fixture(t);
  const stats = {
    count: 0,
    loading: false,
    surfacePending: 0,
    roadBounds: null,
  };
  app.dataManager = {
    layers: new Map([['traffic', { module: { getStats: () => stats } }]]),
  };
  let calls = 0;
  let disposed = 0;
  await whenTrafficSettled({
    evaluate: async () => {},
    async waitForFunction(expression) {
      const predicate = () =>
        typeof expression === 'function' ? expression() : eval(expression);
      if (++calls < 3) assert.equal(predicate(), true);
      else {
        assert.equal(
          predicate(),
          false,
          'idle before the debounce is not loaded',
        );
        stats.count = 100;
        stats.roadBounds = { coverage: { viewKey: 'old view' } };
        assert.equal(predicate(), false, 'old roads do not cover this camera');
        stats.roadBounds.coverage.viewKey =
          '0.0000000,0.0000000,0.1000000,0.0000000,-0.2617994';
        stats.loading = true;
        assert.equal(predicate(), false, 'partial road population');
        stats.loading = false;
        stats.surfacePending = 1;
        assert.equal(predicate(), false, 'unresolved surface');
        stats.surfacePending = 0;
        assert.equal(predicate(), true);
      }
      return {
        dispose: async () => {
          disposed++;
        },
      };
    },
  });
  assert.equal(disposed, 3);
});

test('traffic readiness accepts the layer footprint after rounding and tiny pose drift', (t) => {
  const app = fixture(t);
  app.engine.fake.setPose({
    latitude: (30.2672 * Math.PI) / 180,
    longitude: (-97.7431 * Math.PI) / 180,
    height: 300,
    heading: 2 * Math.PI - 1e-8,
    pitch: -Math.PI / 12,
  });
  const stats = {
    count: 100,
    loading: false,
    surfacePending: 0,
    roadBounds: createReticleFootprint()(app.engine, 300),
  };
  app.dataManager = {
    layers: new Map([['traffic', { module: { getStats: () => stats } }]]),
  };
  assert.equal(trafficReadiness().settled, true);
  app.engine.fake.setPose({
    latitude: (30.2672 * Math.PI) / 180 + 2e-8,
    longitude: (-97.7431 * Math.PI) / 180 - 2e-8,
    height: 300.1,
    heading: 1e-8,
    pitch: -Math.PI / 12 + 2e-8,
  });
  const observed = trafficReadiness();
  assert.notEqual(observed.viewKey, observed.coverageViewKey);
  assert.equal(observed.settled, true);
});

test('traffic readiness rejects changed views and malformed coverage keys', (t) => {
  const app = fixture(t);
  const stats = {
    count: 100,
    loading: false,
    surfacePending: 0,
    roadBounds: { coverage: {} },
  };
  app.dataManager = {
    layers: new Map([['traffic', { module: { getStats: () => stats } }]]),
  };
  for (const key of [
    null,
    'old view',
    '0,0,0.1,0',
    '0,0,0.1,0,NaN',
    '0,0,Infinity,0,-0.2617994',
    '0.01,0,0.1,0,-0.2617994',
    '0,0.01,0.1,0,-0.2617994',
    '0,0,0.3,0,-0.2617994',
    '0,0,0.1,0.01,-0.2617994',
    '0,0,0.1,0,-0.7853982',
  ]) {
    stats.roadBounds.coverage.viewKey = key;
    assert.equal(trafficReadiness().settled, false, String(key));
  }
});

test('traffic loading timeouts include both keys and pending work', async (t) => {
  const app = fixture(t);
  const coverageViewKey = '0.01,0,0.1,0,-0.2617994';
  app.dataManager = {
    layers: new Map([
      [
        'traffic',
        {
          module: {
            getStats: () => ({
              count: 12,
              loading: true,
              surfacePending: 2,
              roadBounds: { coverage: { viewKey: coverageViewKey } },
            }),
          },
        },
      ],
    ]),
  };
  const timeout = new Error('traffic loading timeout');
  timeout.name = 'TimeoutError';
  let calls = 0;
  await assert.rejects(
    whenTrafficSettled({
      evaluate: async (fn) => (typeof fn === 'function' ? fn() : undefined),
      async waitForFunction() {
        if (++calls === 3) throw timeout;
        return { dispose: async () => {} };
      },
    }),
    (error) => {
      assert.equal(error.cause, timeout);
      assert.match(error.message, /Readiness timeout: traffic/);
      assert.ok(
        error.message.includes(`"coverageViewKey":"${coverageViewKey}"`),
      );
      assert.ok(
        error.message.includes(
          '"viewKey":"0.0000000,0.0000000,0.1000000,0.0000000,-0.2617994"',
        ),
      );
      assert.match(error.message, /"loading":true,"surfacePending":2/);
      return true;
    },
  );
});
