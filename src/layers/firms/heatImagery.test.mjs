import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeatImagery } from './heatImagery.js';
import { buildHeatRaster } from '../../data/firmsHeatRaster.js';
import { HEAT_RASTER } from './policy.js';

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

test('setOpacity fades the same layer and survives a rebuild', () => {
  const h = harness();
  h.imagery.setRaster(raster);
  const layer = h.layers[0];
  h.imagery.setOpacity(0);
  assert.equal(layer.alpha, 0);
  assert.equal(layer.show, true, 'a faded layer stays mapped');
  h.imagery.setOpacity(0.25);
  assert.equal(h.layers[0], layer);
  assert.equal(layer.alpha, 0.25);
  h.imagery.setRaster(raster);
  assert.equal(h.layers[0].alpha, 0.25, 'a rebuilt layer keeps the fade');
  h.imagery.setOpacity(7);
  assert.equal(h.layers[0].alpha, 1);
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

test('the shipped raster paints a lone weak fire as a distinct spot', () => {
  // A hot cluster elsewhere sets the scale, as Africa does on real data.
  const fires = [{ lat: 0, lon: 0, frp: 5 }];
  for (let i = 0; i < 40; i++) {
    fires.push({ lat: -10 + (i % 5) * 0.1, lon: 25 + i * 0.05, frp: 300 });
  }
  const r = buildHeatRaster(fires, HEAT_RASTER);
  const y = Math.floor((90 / 180) * r.height);
  const painted = [];
  for (let x = 0; x < r.width; x++) {
    const lon = ((x + 0.5) / r.width) * 360 - 180;
    if (Math.abs(lon) < 5 && r.rgba[(y * r.width + x) * 4 + 3] > 0) {
      painted.push(x);
    }
  }
  const kmPerPx = 40075 / r.width;
  assert.ok(painted.length > 0, 'the weak fire still shows');
  assert.ok(
    painted.length * kmPerPx <= 100,
    `spot ${Math.round(painted.length * kmPerPx)} km wide`,
  );
});
