import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeatImagery } from './heatImagery.js';
import { buildHeatRaster } from '../../data/firmsHeatRaster.js';
import { HEAT_RASTER } from './policy.js';

function harness() {
  const layers = [];
  const removed = [];
  // The renderer's globe port, reduced to its imagery.
  const globe = {
    imagery: {
      add(spec) {
        const layer = {
          spec,
          show: true,
          alpha: 1,
          remove() {
            layers.splice(layers.indexOf(layer), 1);
            removed.push(layer);
          },
        };
        layers.push(layer);
        return layer;
      },
    },
  };
  let host = { globe, kind: 'globe' };
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
    getHost: () => host,
    createCanvas,
  });
  return {
    imagery,
    layers,
    removed,
    globe,
    setHost: (h) => (host = h),
  };
}

const raster = { width: 4, height: 2, rgba: new Uint8ClampedArray(32) };

test('setRaster drapes one full-globe tile and replaces it on the next build', () => {
  const h = harness();
  h.imagery.setRaster(raster);
  assert.equal(h.layers.length, 1);
  assert.equal(h.layers[0].spec.kind, 'single-image');
  assert.deepEqual(h.layers[0].spec.rectangle, {
    west: -180,
    south: -90,
    east: 180,
    north: 90,
  });
  assert.equal(h.layers[0].spec.url, 'data:image/png;base64,AAAA');
  assert.equal(h.layers[0].spec.zOrder, 0.5, 'over the other imagery');
  const first = h.layers[0];
  h.imagery.setRaster(raster);
  assert.equal(h.layers.length, 1, 'never two heat layers');
  assert.deepEqual(h.removed, [first]);
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
  h.setHost({ globe: h.globe, kind: 'none' });
  h.imagery.setRaster(raster);
  assert.equal(h.layers.length, 0);
  h.setHost({ globe: h.globe, kind: 'globe' });
  h.imagery.rehome();
  assert.equal(h.layers.length, 1);
  // The same surface: nothing is draped again.
  const kept = h.layers[0];
  h.imagery.rehome();
  assert.equal(h.layers[0], kept);
  // The map stack moves to 3D tiles: draped again, once.
  h.setHost({ globe: h.globe, kind: 'tileset' });
  h.imagery.rehome();
  assert.equal(h.layers.length, 1);
  assert.notEqual(h.layers[0], kept);
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
