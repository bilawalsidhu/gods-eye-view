import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { constantRgba } from '../../shared/color.js';
import { createFirmsCesiumRenderer } from './cesium.js';

function harness() {
  const sources = [],
    primitives = new Cesium.PrimitiveCollection(),
    registrations = [],
    unregistered = [],
    restored = [];
  const viewer = {
    scene: {
      primitives,
      frameState: { mode: Cesium.SceneMode.SCENE3D },
      isDestroyed: () => false,
    },
    dataSources: {
      add(source) {
        sources.push(source);
      },
      remove(source, destroy) {
        const i = sources.indexOf(source);
        assert.ok(i >= 0);
        sources.splice(i, 1);
        assert.equal(destroy, true);
      },
    },
  };
  const services = {
    sprites: {
      registerSpriteCollection: (...args) => registrations.push(args),
      unregisterSpriteCollection: (...args) => unregistered.push(args),
      restoreSpriteOrder: (value) => restored.push(value),
      restoreSpriteOrderOnEnable: (id, value) => {
        assert.equal(id, 'firms');
        restored.push(value);
      },
    },
  };
  const renderer = createFirmsCesiumRenderer(null, {
    viewer,
    id: 'firms-fixture',
    services,
  });
  return {
    viewer,
    renderer,
    sources,
    primitives,
    registrations,
    unregistered,
    restored,
  };
}

test('native FIRMS renderer retains exact ground rectangle, color, metadata and translucent sprite policy', () => {
  const h = harness(),
    r = h.renderer,
    epoch = Cesium.JulianDate.fromDate(new Date(0));
  assert.equal(r.dataSource.show, false);
  r.setVisible(true);
  const entity = r.addCell({
    west: 179,
    south: 40,
    east: 180,
    north: 42,
    color: constantRgba(1, 165 / 255, 0, 0.66),
    position: geo.cartesian3.fromDegrees(179.5, 41),
    properties: { count: 7, intensity: 12.5, maxFrp: 999, night: 3 },
  });
  const rectangle = entity.rectangle.coordinates.getValue(epoch),
    color = entity.rectangle.material.color.getValue(epoch);
  assert.deepEqual(
    [rectangle.west, rectangle.south, rectangle.east, rectangle.north],
    [179, 40, 180, 42].map(Cesium.Math.toRadians),
  );
  assert.deepEqual(
    [color.red, color.green, color.blue, color.alpha],
    [1, 165 / 255, 0, 0.66],
  );
  assert.equal(
    entity.rectangle.heightReference.getValue(epoch),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  for (const [key, value] of Object.entries({
    count: 7,
    intensity: 12.5,
    maxFrp: 999,
    night: 3,
  }))
    assert.equal(entity.properties[key].getValue(epoch), value);
  const sprites = r.ensureSprites();
  assert.equal(sprites, r.ensureSprites());
  const sprite = r.addSprite({
    id: 'firms-7',
    position: geo.cartesian3.fromDegrees(179.5, 41, 105),
    image: 'fixture.png',
  });
  assert.equal(sprite.id, 'firms-7');
  assert.equal(sprite.disableDepthTestDistance, Infinity);
  assert.equal(sprite.verticalOrigin, Cesium.VerticalOrigin.CENTER);
  assert.equal(sprite.horizontalOrigin, Cesium.HorizontalOrigin.CENTER);
  assert.equal(sprites.blendOption, Cesium.BlendOption.TRANSLUCENT);
  assert.equal(h.registrations.length, 1);
  r.setVisible(false);
  assert.equal(r.dataSource.show, false);
  assert.equal(sprites.show, false);
  r.destroy();
});

test('native FIRMS destroys and unregisters only its original scene resources, once', () => {
  const h = harness(),
    r = h.renderer,
    sprites = r.ensureSprites();
  const foreign = {
    dataSources: {
      remove() {
        assert.fail('foreign scene must not own FIRMS teardown');
      },
    },
  };
  r.onEnable();
  assert.ok(h.restored.every((viewer) => viewer === h.viewer));
  r.destroy(foreign);
  r.destroy();
  assert.equal(h.sources.length, 0);
  assert.equal(h.primitives.length, 0);
  assert.equal(sprites.isDestroyed(), true);
  assert.deepEqual(h.unregistered, [['firms', sprites]]);
  assert.equal(r.ensureSprites(), null);
  r.onEnable();
  assert.equal(h.primitives.length, 0);
  assert.equal(h.registrations.length, 1);
});
