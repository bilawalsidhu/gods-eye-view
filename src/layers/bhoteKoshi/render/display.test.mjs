// The Bhote Koshi imagery and story lifetimes on the fake engine.
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
  assert.ok(display.draw({ entities: { values: [] } }));
  display.destroy();
  assert.deepEqual(engine.fake.imageryLayers(), []);
});

test('an image that will not load rejects; story displays release their frame listeners', async () => {
  const engine = createFakeEngine();
  const stage = engine.imagery.createLayer;
  // A layer whose staged source fails, as an engine's whose image 404s.
  engine.imagery.createLayer = (options) => {
    const layer = stage(options);
    layer.setSource = async () => false;
    return layer;
  };
  const display = createBhoteKoshiDisplay(engine);
  await assert.rejects(
    display.loadImages(BOX, ['pre.webp', 'post.webp']),
    /imagery unavailable/,
  );
  const data = { name: 'flood', entities: { values: [] } };
  const before = engine.frames.preRender.numberOfListeners;
  const story = display.draw(data);
  const locator = createBhoteKoshiLocatorDisplay(engine, { data });
  assert.equal(engine.frames.preRender.numberOfListeners, before + 4);
  story.destroy();
  locator.destroy();
  assert.equal(engine.frames.preRender.numberOfListeners, before);
  display.draw(data);
  display.destroy();
  assert.equal(engine.frames.preRender.numberOfListeners, before);
});
