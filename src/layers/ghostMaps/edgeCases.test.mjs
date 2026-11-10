import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import {
  element,
  kmz,
  deferred,
} from '../../testSupport/ghostMapsFixtures.mjs';
// Edge cases for s2-ghostmaps:
// change the KMZ edition and the engine before parsing finishes; only the
// selected edition is shown, and a bad archive does not erase the working one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGhostMapsLayer } from './index.js';

// The XML double turns `<kml>NAME</kml>` into one placemark called NAME.
function documentFor(xml) {
  const name = /<kml>(.*)<\/kml>/.exec(xml)?.[1] ?? 'unnamed';
  return element('document', [
    element('kml', [
      element('Document', [
        element('Placemark', [
          element('name', [], name),
          element('Point', [element('coordinates', [], '12,34')]),
        ]),
      ]),
    ]),
  ]);
}

const catalog = (version) => ({
  products: [{ id: 'cip', version, defaultOn: true }],
});

/** A scene-less renderer double that records live paints per engine. */
function fakeRenderer(name, live) {
  return {
    name,
    requestRender() {},
    onClick: () => () => {},
    draw(id, features) {
      const paint = {
        engine: name,
        id,
        names: [...features.values()].map((feature) => feature.name),
        ready: Promise.resolve(),
        drop(index) {
          paint.names = [...features]
            .filter(([key]) => key !== index)
            .map(([, feature]) => feature.name);
        },
        destroy() {
          live.delete(paint);
        },
      };
      live.add(paint);
      return paint;
    },
    destroy() {},
  };
}

function harness(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  globalThis.DOMParser = class {
    parseFromString(xml) {
      return documentFor(xml);
    }
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'DOMParser', previous);
    else delete globalThis.DOMParser;
  });
  t.mock.method(console, 'warn', () => {});
  const files = new Map();
  const live = new Set();
  let listener = null;
  const layer = createGhostMapsLayer({
    storage: null,
    createRenderer: (engine) => fakeRenderer(engine.kind, live),
    source: {
      getCatalog: async () => catalog('v1'),
      getFile: (_id, version) => files.get(version).promise,
      subscribe(onCatalog) {
        listener = onCatalog;
        return () => {};
      },
    },
  });
  layer.init(null, { engine: createFakeEngine({ kind: 'cesium' }) });
  layer.enable();
  t.after(() => layer.destroy());
  const file = (version) => {
    const pending = deferred();
    files.set(version, pending);
    return pending;
  };
  const push = (next) => listener(next);
  return { layer, live, file, push };
}

const names = (layer) => layer.getAnalystRecords().map((record) => record.name);
const painted = (live) =>
  [...live].map((paint) => `${paint.engine}:${paint.names.join(',')}`);

test('edge:s2-ghostmaps: an edition and engine change mid-parse shows only the selected edition', async (t) => {
  const { layer, live, file, push } = harness(t);
  file('v1').resolve(kmz('edition one'));
  await layer.update();
  assert.deepEqual(names(layer), ['edition one']);

  // v2 is still downloading when v3 is published and the engine is swapped.
  const v2 = file('v2');
  const v3 = file('v3');
  push(catalog('v2'));
  await new Promise(setImmediate);
  push(catalog('v3'));
  layer.detachRenderer();
  await layer.attachRenderer({ engine: createFakeEngine({ kind: 'navara' }) });
  v2.resolve(kmz('edition two'));
  v3.resolve(kmz('edition three'));
  // Let the queued syncs settle.
  for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);

  assert.deepEqual(names(layer), ['edition three']);
  assert.deepEqual(painted(live), ['navara:edition three']);
  assert.equal(layer.getStats().loading, false);
  assert.equal(layer.getStats().error, null);
});

test('edge:s2-ghostmaps: a bad archive keeps the working edition on the globe', async (t) => {
  const { layer, live, file, push } = harness(t);
  file('v1').resolve(kmz('working edition'));
  await layer.update();
  assert.deepEqual(painted(live), ['cesium:working edition']);

  const broken = file('v2');
  push(catalog('v2'));
  // The engine changes while the broken file is still on its way.
  layer.detachRenderer();
  await layer.attachRenderer({ engine: createFakeEngine({ kind: 'navara' }) });
  broken.resolve(new Uint8Array([1, 2, 3, 4]));
  for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);

  assert.deepEqual(names(layer), ['working edition']);
  assert.deepEqual(painted(live), ['navara:working edition']);
  assert.ok(layer.getStats().error, 'the failed edition is reported');
  const chip = layer.getRowControls().chips[0];
  assert.equal(chip.state, 'error');
});
