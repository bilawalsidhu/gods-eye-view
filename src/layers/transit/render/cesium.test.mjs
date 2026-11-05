import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTransitCesiumRenderer } from './cesium.js';

test('failed native bank registration releases both acquired collections', () => {
  const acquired = [],
    registered = new Map();
  const primitives = new Cesium.PrimitiveCollection();
  const renderer = createTransitCesiumRenderer({
    state: {},
    services: {
      sprites: {
        registerSpriteCollection(id, collection) {
          acquired.push(collection);
          registered.set(id, collection);
          if (id === 'transit-motion') throw new Error('registration failed');
        },
        unregisterSpriteCollection: (id) => registered.delete(id),
      },
    },
  });
  renderer.attach({ scene: { primitives } });
  assert.throws(() => renderer.createMarkers(), /registration failed/);
  assert.equal(primitives.length, 0);
  assert.equal(registered.size, 0);
  assert.equal(acquired.length, 2);
  assert.ok(acquired.every((collection) => collection.isDestroyed()));
  renderer.destroy();
  primitives.destroy();
});

test('failed scene insertion also destroys the uninserted collection', (t) => {
  let acquired;
  t.mock.method(Cesium.BillboardCollection.prototype, 'destroy', function () {
    acquired = this;
    this.isDestroyed = () => true;
  });
  const renderer = createTransitCesiumRenderer({
    state: {},
    services: { sprites: { unregisterSpriteCollection() {} } },
  });
  renderer.attach({
    scene: {
      primitives: {
        add() {
          throw new Error('insertion failed');
        },
        remove() {
          return false;
        },
      },
    },
  });
  assert.throws(() => renderer.createMarkers(), /insertion failed/);
  assert.ok(acquired?.isDestroyed());
  renderer.destroy();
});
