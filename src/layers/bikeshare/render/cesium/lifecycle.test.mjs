import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createLifecycle } from './lifecycle.js';
import { createState } from '../../state.js';

test('destroy releases the original viewer and registered collection even when passed another viewer', (t) => {
  const previous = globalThis.document;
  globalThis.document = { removeEventListener() {} };
  t.after(() => {
    globalThis.document = previous;
  });
  const noop = () => {};
  const calls = [];
  const services = {
    overlays: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
    },
    sprites: {
      registerSpriteCollection: noop,
      unregisterSpriteCollection: (...args) => calls.push(args),
      restoreSpriteOrder: noop,
    },
    picking: { registerPickOwner: noop, unregisterPickOwner: noop },
  };
  const state = createState({ services });
  const viewer = { scene: { primitives: new Cesium.PrimitiveCollection() } };
  const other = { scene: { primitives: new Cesium.PrimitiveCollection() } };
  const lifecycle = createLifecycle({
    state,
    services,
    parts: {
      selection: {
        _installClickHandler: noop,
        _clearSelection: noop,
        _onKeyDown: noop,
      },
      ingestion: { abortAllInFlight: noop },
    },
  }).methods;
  lifecycle.init(viewer);
  const collection = state._pointCollection;
  state._stationInfoCache.set('city', new Map());
  state._statusCache.set('city', {});
  lifecycle.destroy(other);
  lifecycle.destroy(other);
  assert.equal(viewer.scene.primitives.length, 0);
  assert.equal(other.scene.primitives.length, 0);
  assert.equal(collection.isDestroyed(), true);
  assert.deepEqual(calls, [['bikeshare', collection]]);
  assert.equal(state._stationInfoCache.size, 0);
  assert.equal(state._statusCache.size, 0);
});
