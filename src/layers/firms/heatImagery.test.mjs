import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeatImagery } from './heatImagery.js';

function harness() {
  const layers = [];
  const removed = [];
  const collection = {
    addImageryProvider(provider) {
      const layer = { provider, show: true, alpha: 1 };
      layers.push(layer);
      return layer;
    },
    remove(layer, destroy) {
      layers.splice(layers.indexOf(layer), 1);
      removed.push({ layer, destroy });
    },
    raiseToTop() {},
  };
  let host = { collection, kind: 'globe' };
  const cesium = {
    Rectangle: { MAX_VALUE: { max: true } },
    SingleTileImageryProvider: class {
      constructor(options) {
        this.options = options;
      }
    },
  };
  const createCanvas = (w, h) => ({
    width: w,
    height: h,
    getContext: () => ({
      createImageData: (cw, ch) => ({
        data: new Uint8ClampedArray(cw * ch * 4),
      }),
      putImageData() {},
    }),
    toDataURL: () => 'data:image/png;base64,AAAA',
  });
  const imagery = createHeatImagery({
    cesium,
    getHost: () => host,
    createCanvas,
  });
  return { imagery, layers, removed, collection, setHost: (h) => (host = h) };
}

const raster = { width: 4, height: 2, rgba: new Uint8ClampedArray(32) };

test('setRaster drapes one full-globe tile and replaces it on the next build', () => {
  const h = harness();
  h.imagery.setRaster(raster);
  assert.equal(h.layers.length, 1);
  assert.deepEqual(h.layers[0].provider.options.rectangle, { max: true });
  assert.equal(h.layers[0].provider.options.tileWidth, 4);
  h.imagery.setRaster(raster);
  assert.equal(h.layers.length, 1, 'never two heat layers');
  assert.equal(h.removed[0].destroy, true);
});

test('setShow toggles without rebuilding', () => {
  const h = harness();
  h.imagery.setRaster(raster);
  const layer = h.layers[0];
  h.imagery.setShow(false);
  assert.equal(layer.show, false);
  h.imagery.setShow(true);
  assert.equal(h.layers[0], layer);
  assert.equal(layer.show, true);
});

test('no imagery host keeps nothing draped; rehome brings it back', () => {
  const h = harness();
  h.setHost({ collection: null, kind: 'none' });
  h.imagery.setRaster(raster);
  assert.equal(h.layers.length, 0);
  h.setHost({ collection: h.collection, kind: 'globe' });
  h.imagery.rehome();
  assert.equal(h.layers.length, 1);
});

test('destroy removes the layer', () => {
  const h = harness();
  h.imagery.setRaster(raster);
  h.imagery.destroy();
  assert.equal(h.layers.length, 0);
});
