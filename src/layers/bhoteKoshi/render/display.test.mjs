// The Bhote Koshi displays on the fake engine: the event's before and after
// images split at the engine's split position; the story through the
// engine's backend, or none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import {
  createBhoteKoshiDisplay,
  createBhoteKoshiLocatorDisplay,
} from './display.js';

const BOX = { west: 85.295, south: 28.135, east: 85.379, north: 28.292 };

test('the before and after images split left and right at alpha 0.96', async () => {
  const engine = createFakeEngine();
  const display = createBhoteKoshiDisplay(engine);
  await display.loadImages(BOX, ['pre.webp', 'post.webp'], 'Vantor');
  const layers = engine.fake.imageryLayers().map(engine.fake.imageryLayer);
  assert.deepEqual(
    layers.map(({ source, split, alpha }) => [source.url, split, alpha]),
    [
      ['pre.webp', 'left', 0.96],
      ['post.webp', 'right', 0.96],
    ],
  );
  assert.deepEqual({ ...layers[0].source.rectangle }, BOX);
  assert.equal(layers[0].source.credit, 'Vantor');
  display.setSplit(0.3);
  assert.equal(engine.imagery.splitPosition(), 0.3);
  display.setVisible(false);
  assert.ok(
    engine.fake
      .imageryLayers()
      .every((id) => engine.fake.imageryLayer(id).shown === false),
  );
  assert.equal(display.draw({ entities: { values: [] } }), null, 'no backend');
  display.destroy();
  assert.deepEqual(engine.fake.imageryLayers(), []);
});

test('an image that will not load rejects; the story draws through the backend', async () => {
  const engine = createFakeEngine();
  const stage = engine.imagery.createLayer;
  // A layer whose staged source fails, as an engine's whose image 404s.
  engine.imagery.createLayer = (options) => {
    const layer = stage(options);
    layer.setSource = async () => false;
    return layer;
  };
  const drawn = [];
  const display = createBhoteKoshiDisplay(engine, {
    drawStory: (target, data) => {
      drawn.push([target, data]);
      return { destroy() {} };
    },
  });
  await assert.rejects(
    display.loadImages(BOX, ['pre.webp', 'post.webp']),
    /imagery unavailable/,
  );
  const data = { name: 'flood' };
  assert.ok(display.draw(data));
  assert.deepEqual(drawn, [[engine, data]]);
  assert.equal(createBhoteKoshiLocatorDisplay(engine, { data }), null);
  assert.ok(
    createBhoteKoshiLocatorDisplay(engine, {
      data,
      drawStory: () => ({ destroy() {} }),
    }),
  );
});
