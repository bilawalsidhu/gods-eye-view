import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import {
  element,
  kmz,
  deferred,
} from '../../testSupport/ghostMapsFixtures.mjs';
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
          element(
            'description',
            [],
            '<table><tr><td>Date</td><td>2026-01-10</td></tr></table>',
          ),
          element('Point', [element('coordinates', [], '12,34')]),
        ]),
      ]),
    ]),
  ]);
}

const catalog = (version) => ({
  products: [{ id: 'cip', version, defaultOn: true }],
});
const names = (layer) => layer.getAnalystRecords().map((record) => record.name);

const DAY = 86400_000;

for (const action of ['expire', 'disable']) {
  test(`${action} removes a drawing while its icons decode`, async (t) => {
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
    let clock = Date.UTC(2026, 0, 12);
    const live = new Set();
    const gates = [];
    const layer = createGhostMapsLayer({
      storage: null,
      now: () => clock,
      createRenderer: (engine) => ({
        requestRender() {},
        onClick: () => () => {},
        draw(id, features) {
          const gate = deferred();
          if (engine.kind === 'navara') gates.push(gate);
          else gate.resolve();
          const paint = {
            engine: engine.kind,
            names: [...features.values()].map((feature) => feature.name),
            dropped: [],
            ready: gate.promise,
            drop(index) {
              paint.dropped.push(index);
              paint.names = [];
              return true;
            },
            destroy() {
              live.delete(paint);
            },
          };
          live.add(paint);
          return paint;
        },
        destroy() {},
      }),
      source: {
        getCatalog: async () => catalog('v1'),
        getFile: async () => kmz('old event'),
      },
    });
    layer.init(null, { engine: createFakeEngine({ kind: 'cesium' }) });
    layer.enable();
    t.after(() => layer.destroy());
    await layer.update();
    assert.deepEqual(names(layer), ['old event']);

    // Engine switch: the new drawing is still decoding its icons.
    layer.detachRenderer();
    const attached = layer.attachRenderer({
      engine: createFakeEngine({ kind: 'navara' }),
    });
    await new Promise(setImmediate);
    assert.equal(gates.length, 1);
    // The event leaves its age window; the expiry pass runs meanwhile.
    if (action === 'expire') {
      clock += 30 * DAY;
      await layer.update();
    } else {
      layer.disable();
      assert.equal(
        live.size,
        0,
        'disabled drawings are removed before decoding finishes',
      );
    }
    assert.deepEqual(names(layer), [], 'the record is expired');
    gates[0].resolve();
    await attached;
    for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);

    const drawn = [...live].filter((paint) => paint.names.length);
    assert.deepEqual(
      drawn.map((paint) => `${paint.engine}:${paint.names.join(',')}`),
      [],
      'no drawing keeps the expired event',
    );
  });
}
