// The weather display on the fake engine: draped frames as staged
// geographic tiles, a refreshed credit in place, raised shells on 3D tiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { WEATHER_SHELL_HEIGHTS } from '../shellRendering.js';
import { WEATHER_IMAGERY_ORDER, createWeatherDisplay } from './display.js';

const T1 = '2026-11-07T12:00:00.000Z';
const T2 = '2026-11-07T12:10:00.000Z';
const BOUNDS = { west: -130, south: 20, east: -60, north: 55 };
const snapshot = (product, extra = {}) => ({
  schemaVersion: 1,
  product,
  bounds: BOUNDS,
  times: [T1, T2],
  latest: T2,
  tileSize: 256,
  maxLevel: 6,
  tilingScheme: 'geographic',
  ...extra,
});
const layerOf = (engine) => {
  const [id] = engine.fake.imageryLayers();
  return id ? engine.fake.imageryLayer(id) : undefined;
};

test('a draped frame is the product’s geographic tiles, staged over the shown one', async () => {
  const engine = createFakeEngine();
  const display = createWeatherDisplay(engine, {});
  display.setAlpha(0.8);
  assert.equal(await display.setFrame(snapshot('radar'), T1), true);
  const first = layerOf(engine);
  assert.equal(first.source.kind, 'tiles');
  assert.equal(first.source.scheme, 'geographic');
  assert.equal(first.source.maxLevel, 6);
  assert.equal(first.source.transform, null);
  assert.match(first.source.url, /\/api\/weather\/tile\?product=radar&time=/);
  assert.match(first.source.url, /&z=\{z\}&x=\{x\}&y=\{y\}&size=256$/);
  assert.deepEqual({ ...first.source.rectangle }, BOUNDS);
  assert.equal(first.source.credit, 'NOAA nowCOAST · NWS/OAR MRMS');
  assert.equal(first.alpha, 0.8);
  assert.equal(first.options.order, WEATHER_IMAGERY_ORDER.radar);
  assert.equal(display.getDiagnostics().time, T1);
  // The next frame replaces it in the same layer.
  assert.equal(await display.setFrame(snapshot('radar'), T2), true);
  assert.equal(engine.fake.imageryLayers().length, 1);
  assert.match(layerOf(engine).source.url, /12%3A10/);
  // A refreshed manifest's credit, in place.
  display.updateSnapshot(
    snapshot('radar', { display: { credit: 'NOAA MRMS · refreshed' } }),
  );
  assert.equal(layerOf(engine).source.credit, 'NOAA MRMS · refreshed');
  assert.match(layerOf(engine).source.url, /12%3A10/);
  display.setHidden(true);
  assert.equal(layerOf(engine).shown, false);
  display.clear();
  assert.deepEqual(engine.fake.imageryLayers(), []);
});

test('the regional infrared masks each tile; a newer frame wins over one loading', async () => {
  const engine = createFakeEngine();
  const display = createWeatherDisplay(engine, {});
  const older = display.setFrame(snapshot('clouds-regional'), T1, {
    infrared: 100,
  });
  const newer = display.setFrame(snapshot('clouds-regional'), T2, {
    infrared: 100,
  });
  assert.equal(await older, false);
  assert.equal(await newer, true);
  const { source } = layerOf(engine);
  assert.equal(typeof source.transform, 'function');
  assert.match(source.url, /product=clouds-regional/);
});

test('with no surface the frame waits; on 3D tiles it is a raised shell at the product’s height', async () => {
  const engine = createFakeEngine();
  let surface = 'none';
  engine.imagery.surface = () => surface;
  const canvases = [];
  const display = createWeatherDisplay(engine, {
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])),
    decodeImage: async () => ({ width: 4096, height: 2048, close() {} }),
    createCanvas: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  assert.equal(await display.setFrame(snapshot('radar'), T1), false);
  assert.deepEqual(engine.fake.imageryLayers(), []);
  surface = 'tiles';
  display.rehome();
  assert.equal(await display.setFrame(snapshot('radar'), T1), true);
  const shell = layerOf(engine);
  assert.equal(shell.raise, WEATHER_SHELL_HEIGHTS.radar);
  assert.equal(shell.source.kind, 'image');
  assert.equal(shell.source.image, canvases[0]);
  assert.deepEqual({ ...shell.source.rectangle }, BOUNDS);
  assert.equal(display.getDiagnostics().host, 'shell');
  // Back on the globe: the shown frame is staged again as tiles.
  surface = 'globe';
  display.rehome();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const draped = layerOf(engine);
  assert.equal(draped.raise, null);
  assert.equal(draped.source.kind, 'tiles');
  display.clear();
});
