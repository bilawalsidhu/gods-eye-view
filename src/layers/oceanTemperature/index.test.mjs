import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as input from '../../data/inputOwnership.js';
import { createOceanTemperatureLayer } from './index.js';
import { PRODUCTS } from './source.js';
import { intervalLabel } from './controls.js';
import { createOceanProvider, createOceanRendering } from './rendering.js';

const dates = ['2026-10-17', '2026-10-18', '2026-10-20'];
const product = (mode, available = dates) => ({
  layer: PRODUCTS[mode],
  matrixSet: 'GoogleMapsCompatible_Level6',
  dates: available,
  latest: available.at(-1),
});
const palette = [
  { rgb: [107, 0, 219], low: -Infinity, high: -3 },
  { rgb: [202, 202, 183], low: 0, high: 0.1 },
  { rgb: [128, 0, 0], low: 3, high: Infinity },
];
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(sourceOverrides = {}) {
  const fields = [];
  const entities = new Set();
  const labels = new Map();
  let clears = 0;
  const source = {
    metadata: async () => ({
      anomaly: product('anomaly'),
      sst: product('sst', ['2026-10-17', '2026-10-20']),
    }),
    palette: async () => palette,
    tileUrl: async () => 'https://example.test/tile.png',
    ...sourceOverrides,
  };
  const layer = createOceanTemperatureLayer({
    source,
    input,
    overlayHost: {
      setEntries: (id, entries) => labels.set(id, entries),
      clearSource: (id) => labels.delete(id),
      setVisible() {},
    },
    createRendering: () => ({
      setField: async (...args) => fields.push(args),
      clear: () => clears++,
      rehome() {},
      getDiagnostics: () => ({}),
      destroy() {},
    }),
  });
  layer.init({
    entities: {
      add(entity) {
        entities.add(entity);
        return entity;
      },
      remove: (entity) => entities.delete(entity),
    },
    scene: {},
  });
  return { layer, fields, entities, labels, clears: () => clears };
}

test('actual Cesium provider uses the advertised Web Mercator matrix, credit and correct URL', () => {
  const provider = createOceanProvider(
    Cesium,
    product('anomaly'),
    dates.at(-1),
  );
  assert.ok(provider instanceof Cesium.UrlTemplateImageryProvider);
  assert.ok(provider.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
  assert.equal(provider.maximumLevel, 6);
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.tileHeight, 256);
  assert.match(
    provider.url,
    /Anomalies\/default\/2026-10-20\/GoogleMapsCompatible_Level6\/\{z\}\/\{y\}\/\{x\}.png$/,
  );
  assert.match(provider.credit.html, /PO.DAAC/);
});

test('layer uses gap-safe dates, switches product without inventing dates, and exposes real palette', async () => {
  const f = fixture();
  f.layer.enable();
  assert.equal(await f.layer.update(), true);
  assert.equal(f.layer.getParams().date, '2026-10-20');
  f.layer.setParams({ step: -1 });
  await settle();
  assert.equal(f.layer.getParams().date, '2026-10-18');
  f.layer.setParams({ mode: 'sst' });
  await settle();
  assert.equal(f.layer.getParams().date, '2026-10-17');
  assert.equal(f.fields.at(-1)[0].layer, PRODUCTS.sst);
  f.layer.setParams({ date: '2026-10-19' });
  assert.equal(f.layer.getParams().date, '2026-10-17');
  f.layer.setParams({ latest: true });
  await settle();
  assert.equal(f.layer.getParams().date, '2026-10-20');
  const controls = f.layer.getPanelControls();
  assert.equal(controls.readout, true);
  assert.equal(controls.legend[0].color, '#6b00db');
  assert.equal(controls.legend[0].label, '≤-3');
  assert.equal(controls.legend.at(-1).label, '≥3');
  assert.ok(
    controls.summary.settings.some(({ chips }) =>
      chips.some(({ id }) => id === 'nino34'),
    ),
  );
  f.layer.destroy();
});

test('pre-enable share parameters restore date, mode and labelled region; disable removes it', async () => {
  const f = fixture();
  f.layer.setParams({ date: '2026-10-17', mode: 'sst', showNino34: true });
  assert.equal(f.entities.size, 0);
  f.layer.enable();
  await f.layer.update();
  assert.equal(f.layer.getParams().date, '2026-10-17');
  assert.equal(f.entities.size, 1);
  assert.equal(f.labels.get('ocean-temperature')[0].title, 'Niño 3.4 region');
  assert.equal(f.labels.get('ocean-temperature')[0].variant, 'label');
  assert.deepEqual(
    f.labels.get('ocean-temperature')[0].position,
    Cesium.Cartesian3.fromDegrees(-145, 6),
  );
  f.layer.setParams({ showNino34: true });
  assert.equal(f.entities.size, 1);
  assert.equal(f.labels.get('ocean-temperature').length, 1);
  f.layer.setParams({ pick: true });
  assert.equal(input.pointerOwner(), 'ocean-temperature');
  f.layer.disable();
  assert.equal(input.pointerOwner(), null);
  assert.equal(f.entities.size, 0);
  assert.equal(f.labels.size, 0);
  assert.equal(f.layer.getStats().loading, false);
  f.layer.destroy();
});

test('late metadata cannot resurrect disabled imagery and failed acquisition clears it', async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const f = fixture({ metadata: () => pending });
  f.layer.enable();
  const update = f.layer.update();
  f.layer.disable();
  resolve({ anomaly: product('anomaly') });
  assert.equal(await update, false);
  assert.equal(f.fields.length, 0);
  f.layer.destroy();
  const failed = fixture({
    palette: async () => {
      throw new Error('network');
    },
  });
  failed.layer.enable();
  await failed.layer.update();
  assert.match(failed.layer.getStats().error, /unavailable/);
  assert.equal(failed.fields.length, 0);
  assert.ok(failed.clears() > 0);
  failed.layer.destroy();
});

test('published interval formatting never substitutes ±2 or a midpoint', () => {
  assert.equal(
    intervalLabel({ low: 2, high: 2.1, kind: 'range' }),
    '[2, 2.1) °C',
  );
  assert.equal(
    intervalLabel({ low: -Infinity, high: -3, kind: 'below' }),
    'At or below -3 °C',
  );
  assert.equal(
    intervalLabel({ low: 3, high: Infinity, kind: 'above' }),
    'At or above 3 °C',
  );
  assert.equal(intervalLabel(null), 'No ocean data at this point');
});

test('point inspection decodes native pixels and reports land, unknown colors and poles as unavailable', async () => {
  let rgba = [128, 0, 0, 255];
  const tiles = [];
  const layer = createOceanTemperatureLayer({
    source: {
      metadata: async () => ({ anomaly: product('anomaly') }),
      palette: async () => palette,
      tileUrl: async (mode, date, tile) => {
        tiles.push({ mode, date, tile });
        return 'https://example.test/ocean.png';
      },
    },
    cesium: {
      ...Cesium,
      Resource: class {
        async fetchImage() {
          return {};
        }
      },
    },
    document: {
      addEventListener() {},
      removeEventListener() {},
      createElement: () => ({
        getContext: () => ({
          drawImage() {},
          getImageData: () => ({ data: rgba }),
        }),
      }),
    },
    createRendering: () => ({
      setField() {},
      clear() {},
      destroy() {},
      getDiagnostics: () => ({}),
    }),
  });
  layer.init({ scene: {} });
  layer.enable();
  await layer.update();
  const read = async (point = { lon: -145, lat: 0 }) => {
    layer.setParams({ point });
    await settle();
    return layer.getPanelControls().summary.result.lines[0].text;
  };
  assert.equal(await read(), 'At or above 3 °C');
  assert.equal(tiles[0].tile.z, 6);
  rgba = [107, 0, 219, 255];
  assert.equal(await read(), 'At or below -3 °C');
  rgba = [202, 202, 183, 255];
  assert.equal(await read(), '[0, 0.1) °C');
  for (const color of [
    [0, 0, 0, 0],
    [255, 255, 255, 255],
    [202, 202, 183, 100],
  ]) {
    rgba = color;
    assert.equal(await read(), 'No ocean data at this point');
  }
  const count = tiles.length;
  assert.equal(await read({ lon: 0, lat: 89 }), 'No ocean data at this point');
  assert.equal(tiles.length, count);
  layer.destroy();
});

test('globe imagery uses layer alpha and moves cleanly to no-host and back', async () => {
  const collection = new Cesium.ImageryLayerCollection();
  let host = { kind: 'globe', collection };
  const rendering = createOceanRendering({
    cesium: Cesium,
    getViewer: () => ({ scene: { requestRender() {} } }),
    getHost: () => host,
    onChange() {},
    eventTarget: null,
  });
  await rendering.setField(product('anomaly'), dates.at(-1));
  assert.equal(collection.length, 1);
  assert.equal(collection.get(0).alpha, 0.6);
  host = { kind: 'none', collection: null };
  rendering.rehome();
  assert.equal(collection.length, 0);
  assert.equal(rendering.getDiagnostics().imageryActive, false);
  assert.match(rendering.getDiagnostics().imageryError, /Hidden/);
  host = { kind: 'globe', collection };
  rendering.rehome();
  assert.equal(collection.length, 1);
  assert.equal(rendering.getDiagnostics().host, 'globe');
  rendering.destroy();
  assert.equal(collection.length, 0);
});

test('tiles host builds a geographic shell at 0.6 opacity and never adds tileset imagery', async () => {
  const draws = [];
  const surfaces = [];
  let requests = 0;
  class Provider {
    constructor({ url }) {
      this.url = url;
    }
    fetchImage(options) {
      requests++;
      assert.match(this.url, /\/3\/[0-7]\/[0-7]\.png$/);
      assert.equal(options.flipY, false);
      assert.equal(options.preferImageBitmap, false);
      return Promise.resolve({});
    }
  }
  let smoothed = 0;
  const document = {
    createElement: () => ({
      getContext: () => ({
        drawImage: (...args) => draws.push(args),
        getImageData: (x, y, w, h) => ({
          data: new Uint8ClampedArray(w * h * 4),
        }),
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => smoothed++,
      }),
    }),
  };
  const rendering = createOceanRendering({
    cesium: { ...Cesium, Resource: Provider },
    document,
    getViewer: () => ({ scene: { requestRender() {} } }),
    getHost: () => ({ kind: 'tileset', collection: {} }),
    onChange() {},
    eventTarget: null,
    createShell: (options) => {
      const surface = {
        options,
        setImage(image) {
          this.image = image;
        },
        setAlpha(alpha) {
          this.alpha = alpha;
        },
        setShow(show) {
          this.show = show;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      surfaces.push(surface);
      return surface;
    },
  });
  await rendering.setField(product('anomaly'), dates.at(-1));
  // Level 3: 64 tiles, each smoothed with its neighbours, into a 2048 px
  // square mosaic and a 2048 x 1024 equirectangular image.
  assert.equal(requests, 64);
  assert.equal(smoothed, 64);
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].alpha, 0.6);
  assert.equal(surfaces[0].image.width, 2048);
  assert.equal(surfaces[0].image.height, 1024);
  assert.equal(rendering.getDiagnostics().host, 'shell');
  assert.ok(draws.length > 960);
  rendering.destroy();
  assert.equal(surfaces[0].destroyed, true);
});

test('the shell retries a failing GIBS tile and survives one that keeps failing', async () => {
  const attempts = new Map();
  const draws = [];
  const surfaces = [];
  let requests = 0;
  class Provider {
    constructor({ url }) {
      this.url = url;
    }
    fetchImage(options) {
      requests++;
      const tile = this.url
        .match(/\/3\/(\d)\/(\d)\.png$/)
        .slice(1)
        .join('/');
      attempts.set(tile, (attempts.get(tile) ?? 0) + 1);
      // 6/7 fails once then loads; 7/7 always fails (a GIBS 500).
      if (tile === '6/7' && attempts.get(tile) === 1)
        return Promise.reject(new Error('500'));
      if (tile === '7/7') return Promise.reject(new Error('500'));
      assert.match(this.url, /\/3\/[0-7]\/[0-7]\.png$/);
      assert.equal(options.flipY, false);
      assert.equal(options.preferImageBitmap, false);
      return Promise.resolve({});
    }
  }
  let smoothed = 0;
  const document = {
    createElement: () => ({
      getContext: () => ({
        drawImage: (...args) => draws.push(args),
        getImageData: (x, y, w, h) => ({
          data: new Uint8ClampedArray(w * h * 4),
        }),
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => smoothed++,
      }),
    }),
  };
  const rendering = createOceanRendering({
    cesium: { ...Cesium, Resource: Provider },
    document,
    getViewer: () => ({ scene: { requestRender() {} } }),
    getHost: () => ({ kind: 'tileset', collection: {} }),
    onChange() {},
    eventTarget: null,
    createShell: (options) => {
      const surface = {
        options,
        setImage(image) {
          this.image = image;
        },
        setAlpha(alpha) {
          this.alpha = alpha;
        },
        setShow(show) {
          this.show = show;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      surfaces.push(surface);
      return surface;
    },
  });
  await rendering.setField(product('anomaly'), dates.at(-1));
  assert.equal(attempts.get('6/7'), 2);
  assert.equal(attempts.get('7/7'), 3);
  assert.equal(requests, 64 + 1 + 2);
  // Every tile is drawn: the one that never loaded keeps only the edges its
  // neighbours smooth into it, and is otherwise transparent.
  assert.equal(smoothed, 64);
  assert.equal(surfaces.length, 1);
  assert.equal(rendering.getDiagnostics().imageryError, null);
  rendering.destroy();
  assert.equal(surfaces[0].destroyed, true);
});
