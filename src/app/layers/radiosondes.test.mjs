import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { installVueDom } from '../../testSupport/vueDom.mjs';
import { ensureGeoidReady } from '../../data/geoid.js';
import {
  activateWorldOverlayAction,
  destroyWorldOverlay,
  getOverlayPaintRect,
  getWorldOverlayDiagnostics,
  initWorldOverlay,
  subscribeWorldOverlayActions,
} from '../../overlays/worldOverlay.js';
import { createApplicationRadiosondes } from './radiosondes.js';

test('application card opens the serial tracker through the painted hit target and accessible action', async (t) => {
  const cleanup = installVueDom();
  t.after(cleanup);
  const context = new Proxy(
    {
      measureText: (value) => ({ width: String(value).length * 6 }),
    },
    {
      get: (target, key) => target[key] ?? (() => {}),
    },
  );
  t.mock.method(HTMLCanvasElement.prototype, 'getContext', () => context);
  t.mock.method(
    HTMLCanvasElement.prototype,
    'toDataURL',
    () => 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const opened = [];
  t.mock.method(window, 'open', (...args) => opened.push(args));
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('fixtures must not fetch upstream data'),
  );
  await ensureGeoidReady();
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.append(canvas);
  document.body.append(container);
  for (const element of [container, canvas]) {
    Object.defineProperties(element, {
      clientWidth: { value: 1000 },
      clientHeight: { value: 800 },
    });
    element.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
    });
  }
  const primitives = new Cesium.PrimitiveCollection();
  const viewer = {
    canvas,
    container,
    scene: {
      canvas,
      primitives,
      postRender: new Cesium.Event(),
      requestRender() {},
      pick: () => ({ id: 'radiosonde:TEST_123' }),
    },
    camera: {
      moveEnd: new Cesium.Event(),
      positionCartographic: { height: 14_000_000 },
      positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 14_000_000),
      viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      frustum: { projectionMatrix: Cesium.Matrix4.fromUniformScale(1e-8) },
    },
    creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
  };
  let click;
  const setInputAction =
    Cesium.ScreenSpaceEventHandler.prototype.setInputAction;
  t.mock.method(
    Cesium.ScreenSpaceEventHandler.prototype,
    'setInputAction',
    function (action, type) {
      if (type === Cesium.ScreenSpaceEventType.LEFT_CLICK) click = action;
      return setInputAction.call(this, action, type);
    },
  );
  const timeMs = Date.now() - 50 * 60000;
  const layer = createApplicationRadiosondes({
    groundFloor: { cachedGroundFloor: () => 100 },
    source: {
      getSnapshot: async () => ({
        frames: [
          {
            serial: 'TEST_123',
            lat: 0,
            lon: 0,
            altM: 104,
            vVelMps: -3.2,
            timeMs,
            receivedMs: timeMs,
          },
        ],
        upstream: 'live',
        fetchedAt: Date.now(),
      }),
      getTrack: async () => ({ track: [] }),
      getHistory: async () => ({ track: [] }),
    },
  });
  t.after(() => {
    layer.destroy();
    destroyWorldOverlay();
    primitives.destroy();
  });
  layer.init(viewer);
  initWorldOverlay(viewer);
  layer.enable();
  await layer.update(viewer);
  click({ position: { x: 500, y: 400 } });
  await new Promise(setImmediate);
  viewer.scene.postRender.raiseEvent();
  const sourceId = 'radiosondes-selected';
  const cardId = 'radiosondes-card:sonde:TEST_123';
  const rect = getOverlayPaintRect(sourceId, cardId);
  assert.ok(rect, 'the selected card is painted');
  assert.equal(rect.entry.interactive, true);
  assert.equal(rect.entry.details.at(-1), 'SondeHub tracker ↗ · CC BY-SA 2.0');
  let actions;
  const unsubscribe = subscribeWorldOverlayActions((value) => {
    actions = value;
  });
  t.after(unsubscribe);
  const action = actions.items.find((item) => item.label.includes('TEST_123'));
  assert.ok(action, 'the card participates in the shared keyboard target list');
  activateWorldOverlayAction(actions.owner, action.key);
  click({ position: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } });
  assert.deepEqual(opened, [
    ['https://sondehub.org/TEST_123', '_blank', 'noopener,noreferrer'],
    ['https://sondehub.org/TEST_123', '_blank', 'noopener,noreferrer'],
  ]);
  const entry = rect.entry;
  viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(180, 0, 14_000_000);
  viewer.camera.moveEnd.raiseEvent();
  viewer.scene.postRender.raiseEvent();
  assert.equal(getOverlayPaintRect(sourceId, cardId), null);
  assert.equal(
    actions.items.length,
    0,
    'hidden cards offer no accessible action',
  );
  assert.equal(
    getWorldOverlayDiagnostics().entriesBySource[sourceId],
    1,
    'hiding retains selection',
  );
  viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(0, 0, 14_000_000);
  viewer.camera.moveEnd.raiseEvent();
  viewer.scene.postRender.raiseEvent();
  assert.equal(getOverlayPaintRect(sourceId, cardId).entry, entry);
  viewer.camera.viewMatrix[12] = 2e8;
  viewer.scene.postRender.raiseEvent();
  assert.equal(
    getOverlayPaintRect(sourceId, cardId),
    null,
    'off-screen anchors do not paint',
  );
  viewer.camera.viewMatrix[12] = 0;
  viewer.scene.postRender.raiseEvent();
  assert.equal(getOverlayPaintRect(sourceId, cardId).entry, entry);
});
