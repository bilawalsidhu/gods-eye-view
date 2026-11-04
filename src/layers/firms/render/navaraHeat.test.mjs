import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirmsHeatDrape } from './navaraHeat.js';

function harness() {
  const effects = [];
  const requests = [];
  const view = {
    registered: [],
    registerEffect(key) {
      view.registered.push(key);
    },
    addEffect(config) {
      const handle = {
        config,
        visible: config.visible,
        deleted: false,
        update(next) {
          handle.visible = next.visible;
        },
        delete() {
          handle.deleted = true;
        },
      };
      effects.push(handle);
      return handle;
    },
  };
  const engine = { render: { request: (reason) => requests.push(reason) } };
  const drape = createFirmsHeatDrape(engine, {
    view,
    EffectDesc: class {},
    NavaraEffect: class {},
  });
  return { drape, view, effects, requests };
}

const raster = (alpha) => ({
  width: 4,
  height: 2,
  rgba: new Uint8ClampedArray(4 * 2 * 4).fill(alpha),
});

test('the heatmap drape draws only a painted, shown raster above zero opacity', () => {
  const h = harness();
  assert.deepEqual(h.view.registered, ['gevFirmsHeat']);
  assert.equal(h.drape.hasRaster(), false);
  assert.equal(h.effects.length, 0, 'nothing to draw before a raster');
  h.drape.setRaster(raster(200));
  assert.equal(h.drape.hasRaster(), true);
  assert.equal(h.effects.length, 1);
  const [effect] = h.effects;
  const owner = effect.config.gevFirmsHeat.owner;
  assert.equal(owner.texture.image.width, 4);
  assert.equal(owner.texture.image.height, 2);
  assert.equal(effect.visible, true);
  h.drape.setOpacity(0);
  assert.equal(effect.visible, false, 'faded out under the markers');
  h.drape.setOpacity(0.5);
  assert.equal(effect.visible, true);
  assert.equal(owner.opacity, 0.5);
  h.drape.setShow(false);
  assert.equal(effect.visible, false, 'the layer is off');
  h.drape.setShow(true);
  // A new raster replaces the texture in the same pass.
  const first = owner.texture;
  let disposed = false;
  first.dispose = () => (disposed = true);
  h.drape.setRaster(raster(100));
  assert.equal(disposed, true);
  assert.notEqual(owner.texture, first);
  assert.equal(h.effects.length, 1);
  assert.ok(h.requests.length > 0, 'every change asks for a frame');
  h.drape.destroy();
  assert.equal(effect.deleted, true);
  assert.equal(owner.texture, null);
  assert.equal(h.drape.hasRaster(), false);
  h.drape.setRaster(raster(50));
  assert.equal(h.effects.length, 1, 'a destroyed drape draws nothing again');
});
