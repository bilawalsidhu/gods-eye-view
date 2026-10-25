import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirTemperatureRendering } from './rendering.js';
import { field } from './fixtures.mjs';

function harness() {
  const removed = [];
  const images = [];
  const shells = [];
  const collection = {
    addImageryProvider(provider) {
      const layer = { provider };
      images.push(layer);
      return layer;
    },
    remove(layer, destroy) {
      removed.push([layer, destroy]);
    },
  };
  let host = { kind: 'globe', collection };
  const texture = {
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
    }),
    toDataURL: () => 'data:image/png;base64,AA',
  };
  const events = new EventTarget();
  const rendering = createAirTemperatureRendering({
    cesium: {
      Rectangle: { MAX_VALUE: {} },
      SingleTileImageryProvider: class {
        constructor(options) {
          this.options = options;
        }
      },
    },
    getViewer: () => ({ scene: { requestRender() {} } }),
    getHost: () => host,
    document: { createElement: () => texture },
    eventTarget: events,
    createShell: (options) => {
      const shell = {
        options,
        image: null,
        destroyed: false,
        setImage(image) {
          this.image = image;
        },
        setAlpha(value) {
          this.alpha = value;
        },
        setShow() {},
        destroy() {
          this.destroyed = true;
        },
      };
      shells.push(shell);
      return shell;
    },
  });
  rendering.attach();
  return {
    rendering,
    removed,
    images,
    shells,
    setHost: (next) => {
      host = next;
      events.dispatchEvent(new Event('gev:map-stack-changed'));
    },
  };
}

test('host switching removes globe imagery and installs a raised shell without requiring a tileset imagery collection', () => {
  // Given
  const f = harness();
  f.rendering.setField(field());
  // When
  f.setHost({ kind: 'tileset', collection: null });
  // Then
  assert.equal(f.removed[0][0], f.images[0]);
  assert.equal(f.removed[0][1], true);
  assert.ok(f.shells[0].image);
  assert.ok(f.shells[0].options.height > 0);
  assert.equal(f.rendering.getDiagnostics().host, 'shell');
  f.rendering.destroy();
  assert.equal(f.shells[0].destroyed, true);
});

test('both rendering hosts use alpha 0.6; only the hazed globe boosts saturation', () => {
  // Given
  const f = harness();
  const snapshot = field();
  // When
  f.rendering.setField(snapshot);
  assert.equal(f.images[0].alpha, 0.6);
  assert.equal(f.images[0].saturation, 2);
  f.setHost({ kind: 'tileset', collection: null });
  // Then
  const shell = f.shells[0];
  assert.equal(shell.alpha, 0.6);
  f.rendering.destroy();
});

test('a hidden host suspends the field and a later globe host restores it', () => {
  // Given
  const f = harness();
  f.rendering.setField(field());
  f.setHost({ kind: 'none', collection: null });
  assert.equal(f.rendering.getDiagnostics().imageryActive, false);
  // When
  f.setHost({
    kind: 'globe',
    collection: { addImageryProvider: () => ({}), remove() {} },
  });
  // Then
  assert.equal(f.rendering.getDiagnostics().host, 'globe');
  assert.equal(f.rendering.getDiagnostics().imageryError, null);
  f.rendering.destroy();
});

test('refresh and clear release exactly the image owned by this renderer', () => {
  // Given
  const f = harness();
  f.rendering.setField(field());
  // When
  f.rendering.setField(field([1, 2, 3, 4]));
  f.rendering.clear();
  // Then
  assert.deepEqual(
    f.removed.map(([layer]) => layer),
    f.images,
  );
  assert.equal(f.rendering.getDiagnostics().imageryActive, false);
  f.rendering.destroy();
});
