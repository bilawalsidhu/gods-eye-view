// A CAMS paint previously took 67–80 ms. A 25 ms budget leaves room for
// Node timing noise around a 16 ms paint. Run the budgets with npm run test:perf.
import assert from 'node:assert/strict';
import test from 'node:test';
import { perfBudgetTestOptions } from './scripts/run-perf-tests.mjs';
import { createFieldDrawing } from './src/layers/airQuality/fieldDrawing.js';
import {
  FIELD_IDS,
  paintField,
  readFieldManifest,
} from './src/layers/airQuality/field.js';
import {
  EEA_HOURLY_BANDS,
  EEA_HOURLY_LIMITS,
} from './src/layers/airQuality/interpretation.js';

const regionGrids = (r) =>
  Object.fromEntries(
    FIELD_IDS.map((id) => [
      id,
      Uint16Array.from(
        { length: r.width * r.height },
        (_, i) => ((i * 7) % 600) + 10,
      ),
    ]),
  );

const time = (fn) => {
  fn();
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[2];
};

function camsField() {
  const global = {
    width: 900,
    height: 451,
    lon0: 0,
    lat0: 90,
    step: 0.4,
    wrap: true,
    steps: [0],
  };
  const europe = {
    width: 701,
    height: 421,
    lon0: -25,
    lat0: 72,
    step: 0.1,
    steps: [0],
    rectangle: { west: -25.05, south: 29.95, east: 45.05, north: 72.05 },
  };
  const manifest = readFieldManifest({
    run: '2026-11-20T00:00:00Z',
    scale: { pm25: 20, pm10: 10, o3: 50, no2: 50, so2: 20, co: 500, aqi: 10 },
    global,
    europe,
  });
  const grids = { global: regionGrids(global), europe: regionGrids(europe) };
  const scale = { bands: EEA_HOURLY_BANDS, limits: EEA_HOURLY_LIMITS['PM2.5'] };
  return { manifest, grids, scale };
}

test(
  'CAMS-sized paint (900x451 wrapped + 701x421 inset) takes at most 25 ms',
  perfBudgetTestOptions(),
  () => {
    const { manifest, grids, scale } = camsField();
    const withInset = time(() => paintField(manifest, grids, 'pm25', scale));
    const globalOnly = time(() =>
      paintField(manifest, { global: grids.global }, 'pm25', scale),
    );
    console.log(
      `paintField median: with inset ${withInset.toFixed(1)} ms, global only ${globalOnly.toFixed(1)} ms`,
    );
    assert.ok(
      withInset <= 25,
      `paintField took ${withInset.toFixed(1)} ms on the main thread`,
    );
  },
);

function drawingHarness(t) {
  const previous = globalThis.document;
  const canvases = [];
  globalThis.document = {
    createElement() {
      const canvas = {
        getContext: () => ({
          createImageData: (w, h) => ({
            data: new Uint8ClampedArray(w * h * 4),
          }),
          putImageData() {},
        }),
        toDataURL: () => assert.fail('encoded a field canvas'),
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  t.after(() => {
    globalThis.document = previous;
  });
  const specs = [];
  const drawing = createFieldDrawing({
    getViewer: () => ({}),
    getHost: () => ({
      kind: 'globe',
      collection: {
        add(spec) {
          specs.push(spec);
          return { remove() {} };
        },
      },
    }),
  });
  t.after(() => drawing.dispose());
  return { drawing, canvases, specs };
}

test('a cache hit paints nothing and encodes nothing', (t) => {
  const { drawing, canvases, specs } = drawingHarness(t);
  const { manifest, grids, scale } = camsField();
  const paint = t.mock.fn(() => paintField(manifest, grids, 'pm25', scale));
  for (const key of ['A', 'B', 'A', 'B']) assert.ok(drawing.show(key, paint));
  assert.equal(paint.mock.callCount(), 2);
  assert.equal(canvases.length, 4);
  assert.equal(specs.length, 8);
  for (const [i, spec] of specs.entries()) {
    assert.equal(spec.image, canvases[i % 4]);
    assert.equal('url' in spec, false);
  }
});

test(
  'a cached CAMS-sized field switch takes at most 2 ms',
  perfBudgetTestOptions(),
  (t) => {
    const { drawing } = drawingHarness(t);
    const { manifest, grids, scale } = camsField();
    const paint = () => paintField(manifest, grids, 'pm25', scale);
    const start = performance.now();
    assert.ok(drawing.show('A', paint));
    const miss = performance.now() - start;
    assert.ok(drawing.show('B', paint));
    let key = 'B';
    const hit = time(() => {
      key = key === 'B' ? 'A' : 'B';
      assert.ok(drawing.show(key, paint));
    });
    console.log(
      `Field drawing: miss ${miss.toFixed(1)} ms, median hit ${hit.toFixed(3)} ms`,
    );
    assert.ok(hit <= 2, `cache hit took ${hit.toFixed(3)} ms`);
  },
);
