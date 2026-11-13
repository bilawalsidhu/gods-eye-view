import test from 'node:test';
import assert from 'node:assert/strict';
import { createOceanRendering } from './rendering.js';

function harness() {
  const providers = [];
  class UrlTemplateImageryProvider {
    constructor(options) {
      this.options = options;
      this.listeners = [];
      this.errorEvent = {
        addEventListener: (listener) => {
          this.listeners.push(listener);
          return () => {};
        },
      };
      providers.push(this);
    }
    fail(failure) {
      for (const listener of this.listeners) listener(failure);
      return failure;
    }
  }
  const collection = {
    layers: [],
    get length() {
      return this.layers.length;
    },
    addImageryProvider(provider) {
      const layer = { imageryProvider: provider };
      this.layers.push(layer);
      return layer;
    },
    remove(layer) {
      this.layers = this.layers.filter((item) => item !== layer);
    },
    get(index) {
      return this.layers[index];
    },
  };
  const cesium = {
    UrlTemplateImageryProvider,
    WebMercatorTilingScheme: class {},
    Credit: class {},
  };
  let changes = 0;
  const rendering = createOceanRendering({
    cesium,
    getViewer: () => ({ scene: {} }),
    getHost: () => ({ kind: 'globe', collection }),
    onChange: () => changes++,
    eventTarget: null,
  });
  return { rendering, providers, changes: () => changes };
}

const product = {
  layer: 'GHRSST_L4_MUR25_Sea_Surface_Temperature',
  matrixSet: 'GoogleMapsCompatible_Level7',
  format: 'image/png',
};

test('a dropped tile is retried before the layer reports an imagery outage', async () => {
  // Given
  const f = harness();
  await f.rendering.setField(product, '2026-10-22');
  const provider = f.providers[0];
  // When the same tile fails twice, Cesium is asked to retry it each time.
  const first = provider.fail({ level: 3, x: 1, y: 2 });
  const second = provider.fail({ level: 3, x: 1, y: 2 });
  // Then
  assert.equal(first.retry, true);
  assert.equal(second.retry, true);
  assert.equal(f.rendering.getDiagnostics().imageryError, null);
  // When it fails a third time, the outage is real and reported.
  const third = provider.fail({ level: 3, x: 1, y: 2 });
  assert.notEqual(third.retry, true);
  assert.equal(
    f.rendering.getDiagnostics().imageryError,
    'Ocean imagery unavailable',
  );
});

test('retries are counted per tile, so failures spread across tiles stay quiet', async () => {
  // Given
  const f = harness();
  await f.rendering.setField(product, '2026-10-22');
  const provider = f.providers[0];
  // When
  for (let x = 0; x < 6; x++) provider.fail({ level: 4, x, y: 0 });
  // Then
  assert.equal(f.rendering.getDiagnostics().imageryError, null);
});
