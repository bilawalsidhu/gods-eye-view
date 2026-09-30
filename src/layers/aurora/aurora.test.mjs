import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOvation } from '../../../server/providers/aurora.js';
import { createAuroraSource, validateAuroraSnapshot } from './source.js';
import {
  createAuroraRaster,
  createAuroraRendering,
  AURORA_SHELL_STACK,
} from './rendering.js';
import { createAuroraLayer } from './index.js';

function payload() {
  const coordinates = [];
  for (let lon = 0; lon < 360; lon++)
    for (let lat = -90; lat <= 90; lat++)
      coordinates.push([lon, lat, lat === -90 ? 25 : lat === 90 ? 75 : lat === 0 ? 0.5 : 0]);
  return {
    'Observation Time': '2026-09-25T12:00:00Z',
    'Forecast Time': '2026-09-25T13:00:00Z',
    coordinates,
  };
}

test('normalizes the complete OVATION grid including both poles', () => {
  const result = normalizeOvation(payload());
  assert.deepEqual(result.coordinateOrder, [
    'longitude',
    'latitude',
    'probability',
  ]);
  assert.equal(result.probabilities.length, 360 * 181);
  assert.equal(result.probabilities[0], 25);
  assert.equal(result.probabilities.at(-1), 75);
  assert.equal(result.probabilities[90 * 360], 0.5);
  assert.deepEqual(result.horizonMinutes, { min: 30, max: 90, variable: true });
  assert.equal(validateAuroraSnapshot(result), result);
});

test('raster preserves both hemispheres and flips rows for canvas north-up', () => {
  const result = normalizeOvation(payload());
  const raster = createAuroraRaster(result);
  assert.equal(raster.width, 360);
  assert.equal(raster.height, 181);
  const northAlpha = raster.rgba[3];
  const southAlpha = raster.rgba[(180 * 360) * 4 + 3];
  assert.ok(northAlpha > southAlpha);
});

test('rejects a short grid rather than implying missing cells are zero', () => {
  const value = payload();
  value.coordinates.pop();
  assert.throws(() => normalizeOvation(value), /Invalid OVATION forecast/);
});

test('rejects duplicate cells instead of silently dropping a hemisphere cell', () => {
  const value = payload();
  value.coordinates.at(-1)[0] = 0;
  value.coordinates.at(-1)[1] = -90;
  assert.throws(() => normalizeOvation(value), /Invalid OVATION forecast/);
});

test('client source accepts an explicit unavailable response and keeps the proxy reason', async () => {
  const unavailable = {
    schemaVersion: 1,
    product: 'ovation-aurora',
    unavailable: true,
    stale: true,
    reason: 'NOAA SWPC OVATION forecast unavailable',
  };
  const source = createAuroraSource({
    fetchImpl: async (url, options) => {
      assert.equal(url, '/api/aurora/forecast');
      assert.equal(options.cache, 'no-store');
      return new Response(JSON.stringify(unavailable), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.deepEqual(await source.getSnapshot(), unavailable);
});

test('presents variable forecast horizon and uncertainty, never observation certainty', async () => {
  const layer = createAuroraLayer({
    feed: { getSnapshot: async () => normalizeOvation(payload()) },
    createRendering: () => ({
      setField() {},
      setAlpha() {},
      rehome() {},
      clear() {},
      destroy() {},
      getDiagnostics: () => ({}),
    }),
    eventTarget: null,
  });
  layer.init({ imageryLayers: {}, scene: {} });
  layer.enable();
  await layer.update();
  const controls = layer.getRowControls();
  assert.match(controls.summary.label, /FORECAST/);
  assert.equal(controls.summary.coverage, 'Both hemispheres · 1° grid');
  assert.equal(controls.summary.horizon, 'Variable 30–90 min forecast');
  assert.equal(controls.summary.uncertainty, 'Modeled probability, not guaranteed visibility');
  assert.match(controls.info, /30–90 min horizon/);
  assert.match(controls.info, /Clouds, darkness, local light pollution, and model uncertainty/);
  assert.match(controls.info, /not a guarantee/);
  assert.doesNotMatch(controls.info, /Latest observation/);
  assert.equal(controls.legend[0].label, '0%');
  assert.equal(controls.legend[0].color, 'rgba(0,0,0,0)');
  assert.deepEqual(layer.getStats(), {
    count: 65_160,
    countLabel: '360×181 grid cells',
    lastUpdate: Date.parse('2026-09-25T12:00:00.000Z'),
    loading: false,
    error: null,
    stale: false,
    source: 'NOAA SWPC OVATION · FORECAST',
    validTime: '2026-09-25T13:00:00.000Z',
  });
});

test('preserves the last valid raster when a later response is explicitly unavailable', async () => {
  const valid = normalizeOvation(payload());
  const unavailable = {
    schemaVersion: 1,
    product: 'ovation-aurora',
    unavailable: true,
    stale: true,
    reason: 'NOAA SWPC OVATION forecast unavailable',
  };
  const responses = [valid, unavailable];
  const calls = { fields: [], clears: 0 };
  const layer = createAuroraLayer({
    feed: { getSnapshot: async () => responses.shift() },
    createRendering: () => ({
      setField(value) { calls.fields.push(value); },
      setAlpha() {},
      rehome() {},
      clear() { calls.clears += 1; },
      destroy() {},
      getDiagnostics: () => ({ imageryActive: true }),
    }),
    eventTarget: null,
  });
  layer.init({ imageryLayers: {}, scene: {} });
  layer.enable();
  await layer.update();
  await layer.update();
  assert.deepEqual(calls.fields, [valid]);
  assert.equal(calls.clears, 0);
  assert.equal(layer.getStats().count, 65_160);
  assert.equal(layer.getStats().error, unavailable.reason);
  assert.match(layer.getRowControls().summary.status, /unavailable/);
});
test('the field is drawn as a raised stack on every host, never draped', () => {
  // The aurora is emission near 100 km, not a surface property, so it must not
  // be draped on the globe the way radar and cloud imagery are. Two things are
  // pinned here because only a browser would otherwise catch them: that no host
  // takes a draped path, and that the stack really has vertical extent.
  const snapshot = { grid: { nx: 4, ny: 3 }, probabilities: new Array(12).fill(50) };
  for (const kind of ['globe', 'tileset']) {
    const built = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
      }),
      toDataURL: () => 'data:image/png;base64,AAAA',
    };
    const collection = {
      addImageryProvider: () => assert.fail(`${kind} draped the aurora on imagery`),
    };
    const rendering = createAuroraRendering({
      viewer: { scene: { requestRender: () => {} } },
      cesium: {
        Rectangle: { MAX_VALUE: Symbol('rectangle') },
        Credit: class {},
        SingleTileImageryProvider: class {
          constructor() {
            assert.fail(`${kind} built a draped imagery provider`);
          }
        },
      },
      getHost: () => ({ kind, collection }),
      createCanvas: () => canvas,
      createSurface: (options) => {
        built.push(options);
        return { setImage() {}, setAlpha() {}, destroy() {} };
      },
    });
    rendering.setField(snapshot);

    assert.equal(built.length, AURORA_SHELL_STACK.length, `${kind} shell count`);
    const heights = built.map((o) => o.height);
    assert.deepEqual(heights, [...heights].sort((a, b) => a - b), 'ascending');
    assert.ok(heights[0] >= 90_000, 'the curtain starts in the E-region');
    assert.ok(
      heights.at(-1) - heights[0] >= 150_000,
      'the curtain has real vertical extent, not a token offset',
    );
    assert.equal(rendering.getDiagnostics().error, null);
  }
});

test('stacked shell opacity composites to roughly one shell, so depth does not double the brightness', () => {
  // Alpha compositing is 1 - product(1 - a). If the weights were spent as a
  // few strong shells the oval would both saturate from above and read as
  // venetian blinds at the limb.
  const composite =
    1 - AURORA_SHELL_STACK.reduce((acc, { weight }) => acc * (1 - weight), 1);
  assert.ok(composite > 0.75 && composite < 1.05, `composite ${composite}`);
  for (const { weight } of AURORA_SHELL_STACK)
    assert.ok(weight > 0 && weight <= 0.5, `weight ${weight} stays a wash`);
});
