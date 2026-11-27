/**
 * The bundled OpenAQ provider as the layer drives it: it asks per camera
 * view, so navigation, retries and timers follow the view.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initAirQualityTestLayer } from '../../testSupport/airQualityViewer.mjs';
import { createAirQualitySource } from './providers.js';
import { createAirQualityLayer } from './index.js';

const now = Date.parse('2026-10-20T10:00:00Z');

test('view-driven providers debounce navigation, abort old requests, and separate loading from empty coverage', async () => {
  let moveEnd,
    resolveOld,
    coverage = { partial: false };
  let rect = { west: 0, south: 0, east: 0.1, north: 0.1 };
  const calls = [];
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getCoverage: () => coverage,
      getSnapshot: (request) => {
        calls.push(request);
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  initAirQualityTestLayer(layer, {
    dataSources: { add() {}, remove() {} },
    camera: {
      computeViewRectangle: () => rect,
      moveEnd: {
        addEventListener(fn) {
          moveEnd = fn;
          return () => {};
        },
      },
    },
  });
  layer.enable();
  const initial = layer.update();
  assert.match(layer.getRowControls().summary.status, /Loading/);
  const resolveInitial = resolveOld;
  rect = { ...rect, west: 1, east: 1.1 };
  moveEnd();
  moveEnd();
  moveEnd();
  assert.equal(calls[0].signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(calls.length, 2);
  assert.notDeepEqual(calls[0].view, calls[1].view);
  resolveInitial([]);
  assert.equal(
    await initial,
    true,
    'supersession must not fail the manager enable transaction',
  );
  assert.match(layer.getRowControls().summary.status, /Loading/);
  coverage = { partial: true };
  resolveOld([]);
  await new Promise((resolve) => setImmediate(resolve));
  // Answered with nothing yet: a count, not Loading.
  assert.equal(layer.getRowControls().summary.status, '0 stations');
  const complete = layer.update();
  coverage = { partial: false };
  resolveOld([]);
  await complete;
  assert.equal(layer.getRowControls().summary.status, '0 stations');
  rect = { ...rect, west: 2, east: 2.1 };
  moveEnd();
  layer.disable();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(calls.length, 3, 'disable cancels pending camera refresh');
  layer.destroy();
});
test('viewport rate limits are explicit and do not disable the layer', async () => {
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getSnapshot: async () => [],
      getCoverage: () => ({ partial: true, stale: true, failureStatus: 429 }),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  initAirQualityTestLayer(layer, {
    dataSources: { add() {}, remove() {} },
    camera: {
      computeViewRectangle: () => ({
        west: 0,
        south: 0,
        east: 0.1,
        north: 0.1,
      }),
    },
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  // The budget is the network's own line; the status says what the map has.
  const controls = layer.getRowControls();
  assert.equal(controls.summary.status, '0 stations');
  assert.match(
    controls.summary.lines.find((line) => line.id === 'provider-openaq').text,
    /^OpenAQ: request budget reached/,
  );
  layer.destroy();
});

test('unresolved camera waits for a view instead of starting worldwide acquisition', async () => {
  let calls = 0;
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getSnapshot: async () => {
        calls++;
        return [];
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  initAirQualityTestLayer(layer, { dataSources: { add() {}, remove() {} } });
  layer.enable();
  try {
    assert.equal(await layer.update(), true);
    assert.equal(calls, 0);
    assert.match(layer.getRowControls().summary.status, /Loading/);
  } finally {
    layer.destroy();
  }
});

test('progressive updates and rate-limit errors retry automatically; disable and destroy cancel timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  for (const rateLimited of [false, true]) {
    let calls = 0;
    const layer = createAirQualityLayer({
      source: {
        definitions: [definition],
        getSnapshot: async () => {
          calls++;
          if (rateLimited && calls === 1)
            throw Object.assign(new Error('Provider request budget reached'), {
              retryAt: Date.now() + 2000,
            });
          return [];
        },
        getCoverage: () => ({
          partial: calls === 1,
          retryAt: calls === 1 ? Date.now() + 2000 : null,
        }),
      },
      overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    });
    initAirQualityTestLayer(layer, {
      dataSources: { add() {}, remove() {} },
      camera: {
        computeViewRectangle: () => ({
          west: 0,
          south: 0,
          east: 0.1,
          north: 0.1,
        }),
      },
    });
    layer.enable();
    try {
      assert.equal(await layer.update(), true);
      t.mock.timers.tick(1999);
      assert.equal(calls, 1);
      t.mock.timers.tick(102);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
      calls = 0;
      await layer.update();
      layer.disable();
      t.mock.timers.tick(3000);
      assert.equal(calls, 1);
      layer.enable();
      calls = 0;
      await layer.update();
    } finally {
      layer.destroy();
    }
    t.mock.timers.tick(3000);
    assert.equal(calls, 1);
  }
});

test('navigation cancels the old view retry and only refreshes the new camera', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  let moveEnd,
    rect = { west: 0, south: 0, east: 0.1, north: 0.1 };
  const calls = [];
  const definition = createAirQualitySource().definitions.find(
    (p) => p.id === 'openaq',
  );
  const layer = createAirQualityLayer({
    source: {
      definitions: [definition],
      getSnapshot: async (request) => {
        calls.push(request.view);
        return [];
      },
      getCoverage: () => ({
        retryAt: calls.length === 1 ? Date.now() + 2000 : null,
      }),
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  initAirQualityTestLayer(layer, {
    dataSources: { add() {}, remove() {} },
    camera: {
      computeViewRectangle: () => rect,
      moveEnd: {
        addEventListener(fn) {
          moveEnd = fn;
          return () => {};
        },
      },
    },
  });
  layer.enable();
  try {
    await layer.update();
    rect = { ...rect, west: 1, east: 1.1 };
    moveEnd();
    t.mock.timers.tick(401);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.notDeepEqual(calls[0], calls[1]);
    t.mock.timers.tick(3000);
    assert.equal(calls.length, 2);
  } finally {
    layer.destroy();
  }
});
