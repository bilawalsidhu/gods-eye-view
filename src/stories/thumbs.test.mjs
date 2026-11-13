import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { drawThumb, thumbLevel } from './thumbs.js';

function fakeProvider(images = true) {
  const asked = [];
  return {
    asked,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    maximumLevel: 10,
    requestImage(x, y, level) {
      asked.push([x, y, level]);
      return Promise.resolve(images ? {} : undefined);
    },
  };
}

function fakeCanvas(t) {
  const drawn = [];
  const original = document.createElement.bind(document);
  t.mock.method(document, 'createElement', (name) => {
    const el = original(name);
    if (name === 'canvas') {
      el.getContext = () => ({
        fillRect() {},
        drawImage: (...args) => drawn.push(args),
      });
      el.toDataURL = () => 'data:image/jpeg;base64,AAAA';
    }
    return el;
  });
  return drawn;
}

test('a story’s range picks a zoom level within the provider’s', () => {
  assert.equal(thumbLevel(1.6e7, { maximumLevel: 10 }), 1);
  assert.equal(thumbLevel(160000, { maximumLevel: 10 }), 8);
  assert.equal(thumbLevel(500, { maximumLevel: 10 }), 10);
});

test('a card is drawn from the 2 × 2 tiles around the place', async (t) => {
  const drawn = fakeCanvas(t);
  const provider = fakeProvider();
  const url = await drawThumb(provider, {
    lat: 28.05,
    lon: 85.6,
    range: 160000,
  });
  assert.equal(url, 'data:image/jpeg;base64,AAAA');
  assert.equal(provider.asked.length, 4);
  assert.ok(provider.asked.every(([, , level]) => level === 8));
  assert.equal(drawn.length, 4);
});

test('no imagery, no card: the placeholder stays', async (t) => {
  fakeCanvas(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = fakeProvider(false);
  const pending = drawThumb(provider, { lat: 0, lon: 0, range: 1.6e7 });
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    t.mock.timers.tick(1000);
  }
  assert.equal(await pending, '');
  assert.equal(await drawThumb({}, { lat: 0, lon: 0 }), '');
});
