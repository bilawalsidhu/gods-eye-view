import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { createSpcOutlooksLayer } from './index.js';
import { normalizeSpcOutlook, SPC_MAX_AGE_MS } from './records.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import { NOW, feature, collection, ring } from './fixtures.test-support.mjs';

const snapshot = (features = [feature()], product = 'day1-categorical') =>
  normalizeSpcOutlook(collection(...features), { product, fetchedAt: NOW });
function harness(source = { getSnapshot: async () => snapshot() }) {
  const sources = [],
    timers = new Map();
  const captureListeners = new Map();
  let clock = NOW,
    click,
    destroyedHandlers = 0,
    pick = null,
    pointerFree = true,
    overlayHit = null;
  const viewer = {
    scene: {
      requestRender() {},
      pick: () => pick,
      canvas: {
        addEventListener(event, fn) {
          captureListeners.set(event, fn);
        },
        removeEventListener(event) {
          captureListeners.delete(event);
        },
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
      },
    },
    dataSources: {
      add(value) {
        sources.push(value);
        return Promise.resolve(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createSpcOutlooksLayer({
    source,
    now: () => clock,
    setTimer(callback, delay) {
      const id = Symbol();
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    isPointerFree: () => pointerFree,
    hitTestOverlay: () => overlayHit,
    eventHandlerFactory: () => ({
      setInputAction(fn) {
        click = fn;
      },
      destroy() {
        click = null;
        destroyedHandlers++;
      },
    }),
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    sources,
    timers,
    captureListeners,
    release: () =>
      captureListeners.get('pointerup')?.({ clientX: 1, clientY: 2 }),
    setClock: (v) => {
      clock = v;
    },
    setPick: (v) => {
      pick = v;
    },
    click: () => click?.({ position: { x: 1, y: 2 } }),
    setPointerFree: (v) => {
      pointerFree = v;
    },
    setOverlayHit: (v) => {
      overlayHit = v;
    },
    destroyedHandlers: () => destroyedHandlers,
  };
}

test('Cesium fills retain risk-band holes; all exterior/interior boundaries drape on terrain and 3D', async () => {
  const hole = ring(-98, 32, 2);
  const h = harness({
    getSnapshot: async () =>
      snapshot([
        feature(
          {},
          {
            type: 'MultiPolygon',
            coordinates: [[ring(), hole], [ring(-80, 30, 1)]],
          },
        ),
      ]),
  });
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.filter((e) => e.polygon).length, 2);
  assert.equal(entities.filter((e) => e.polyline).length, 3);
  const polygon = entities.find((e) => e.polygon).polygon;
  assert.equal(polygon.hierarchy.getValue().holes.length, 1);
  assert.equal(
    polygon.classificationType.getValue(),
    C.ClassificationType.BOTH,
  );
  assert.equal(
    polygon.height,
    undefined,
    'must not lift forecast above terrain',
  );
  assert.equal(polygon.material.color.getValue().alpha, 0.35);
  for (const entity of entities.filter((e) => e.polyline)) {
    assert.equal(entity.polyline.clampToGround.getValue(), true);
    assert.equal(
      entity.polyline.classificationType.getValue(),
      C.ClassificationType.BOTH,
    );
  }
  assert.equal(h.layer.getStats().count, 1);
  h.layer.destroy();
  assert.equal(h.sources.length, 0);
  assert.equal(h.timers.size, 0);
});

test('map selection shows hazard, risk, issue/validity and official source, without claiming pointer/overlay clicks', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  h.setPick({ id: h.sources[0].entities.values[0] });
  h.setPointerFree(false);
  h.click();
  assert.equal(h.layer.getRowControls().summary.result, undefined);
  h.setPointerFree(true);
  h.setOverlayHit({ sourceId: 'vessels' });
  h.click();
  assert.equal(h.layer.getRowControls().summary.result, undefined);
  h.setOverlayHit(null);
  h.click();
  const controls = h.layer.getRowControls();
  assert.match(controls.summary.result.label, /Categorical/);
  assert.equal(controls.summary.result.lines[0].text, 'Marginal');
  assert.match(controls.summary.result.lines[1].text, /UTC/);
  assert.match(controls.summary.result.lines[2].text, /UTC/);
  assert.equal(
    controls.summary.actions[0].href,
    'https://www.spc.noaa.gov/products/outlook/day1otlk.html',
  );
  assert.match(
    controls.summary.lines.find((l) => l.id === 'disclaimer').text,
    /not an active NWS warning/,
  );
  h.setPick(null);
  h.click();
  assert.equal(h.layer.getRowControls().summary.result, undefined);
  h.layer.destroy();
});

test('release-time overlay hit survives an earlier sibling handler clearing hit boxes', async () => {
  const h = harness();
  h.layer.enable();
  await h.layer.update();
  h.setPick({ id: h.sources[0].entities.values[0] });
  h.setOverlayHit({ sourceId: 'vessels' });
  h.release();
  // The vessel bubble handler consumes its card and synchronously rebuilds overlays.
  h.setOverlayHit(null);
  h.click();
  assert.equal(h.layer.getRowControls().summary.result, undefined);
  h.release();
  h.click();
  assert.ok(
    h.layer.getRowControls().summary.result,
    'ordinary map release still selects',
  );
  h.layer.disable();
  assert.equal(h.captureListeners.size, 0);
  h.layer.destroy();
});

test('loading, empty, stale, expired and unavailable states preserve enabled retries', async () => {
  let next = snapshot(),
    fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('private');
      return next;
    },
  });
  h.layer.enable();
  const first = h.layer.update();
  assert.equal(h.layer.getStats().loading, true);
  await first;
  fail = true;
  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().stale, true);
  assert.ok(h.sources[0].entities.values.length);
  h.setClock(NOW + SPC_MAX_AGE_MS);
  await h.layer.update();
  assert.equal(h.layer.getStats().status, 'unavailable');
  assert.equal(h.sources[0].entities.values.length, 0);
  h.setClock(NOW);
  fail = false;
  next = snapshot([]);
  await h.layer.update();
  assert.equal(h.layer.getStats().empty, true);
  next = { ...snapshot(), validUntil: NOW };
  await h.layer.update();
  assert.equal(h.layer.getStats().status, 'expired');
  assert.equal(h.sources[0].entities.values.length, 0);
  h.layer.destroy();
});

test('expiry removes geometry exactly at validity or bounded age even without another poll', async () => {
  for (const lifetime of [1000, SPC_MAX_AGE_MS]) {
    const next = { ...snapshot(), validUntil: NOW + lifetime };
    const h = harness({ getSnapshot: async () => next });
    h.layer.enable();
    await h.layer.update();
    assert.equal(h.timers.size, 1);
    const timer = [...h.timers.values()][0];
    assert.equal(timer.delay, lifetime);
    h.setClock(NOW + lifetime);
    timer.callback();
    assert.equal(h.sources[0].entities.values.length, 0);
    assert.equal(h.layer.getStats().count, 0);
    h.layer.destroy();
  }
});

test('disable/destroy/superseded product abort ownership; late data cannot resurrect geometry', async () => {
  for (const action of ['disable', 'destroy', 'product']) {
    const pending = [];
    const h = harness({
      getSnapshot: ({ signal, product }) =>
        new Promise((resolve) => pending.push({ signal, product, resolve })),
    });
    h.layer.enable();
    const updating = h.layer.update();
    if (action === 'product')
      h.layer.setParams({ day: 'day2', type: 'tornado' });
    else h.layer[action]();
    assert.equal(pending[0].signal.aborted, true);
    pending[0].resolve(snapshot());
    assert.equal(await updating, false);
    assert.equal(h.layer.getStats().count, 0);
    if (action === 'product') {
      assert.equal(pending[1].product, 'day2-tornado');
      pending[1].resolve(snapshot([], 'day2-tornado'));
      await new Promise(setImmediate);
    }
    h.layer.destroy();
    assert.equal(h.sources.length, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('ordinary lifecycle leaves failed source enabled for manager refresh and cleans up', async () => {
  let fail = true;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('network');
      return snapshot();
    },
  });
  const manager = new LayerLifecycle(h.viewer);
  // This test initialized the real layer above; keep manager init idempotent at this seam only.
  manager.register({ ...h.layer, init() {} });
  assert.equal(await manager.setEnabled(h.layer.id, true), true);
  assert.equal(manager.isEnabled(h.layer.id), true);
  assert.equal(h.layer.getStats().status, 'unavailable');
  fail = false;
  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().count, 1);
  await manager.setEnabled(h.layer.id, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.destroyedHandlers(), 1);
  await manager.destroyLayer(h.layer.id);
});
