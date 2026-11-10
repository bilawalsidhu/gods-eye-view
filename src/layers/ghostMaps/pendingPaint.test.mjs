import assert from 'node:assert/strict';
import test from 'node:test';
import { createGhostMapsLayer } from './index.js';

function element(localName, children = [], value = '') {
  const node = {
    localName,
    children,
    get textContent() {
      return value + children.map((child) => child.textContent).join('');
    },
    getAttribute: () => null,
    getElementsByTagName(name) {
      return children.flatMap((child) => [
        ...(name === '*' || name === child.localName ? [child] : []),
        ...child.getElementsByTagName(name),
      ]);
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

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

/** A stored (uncompressed) KMZ holding doc.kml only. */
function kmz(name) {
  const key = Buffer.from('doc.kml');
  const bytes = Buffer.from(`<kml>${name}</kml>`);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(key.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt32LE(bytes.length, 20);
  directory.writeUInt32LE(bytes.length, 24);
  directory.writeUInt16LE(key.length, 28);
  directory.writeUInt32LE(0, 42);
  const central = Buffer.concat([directory, key]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(header.length + key.length + bytes.length, 16);
  return new Uint8Array(Buffer.concat([header, key, bytes, central, end]));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
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
          if (engine.name === 'navara') gates.push(gate);
          else gate.resolve();
          const paint = {
            engine: engine.name,
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
    layer.init(null, { engine: { name: 'cesium' } });
    layer.enable();
    t.after(() => layer.destroy());
    await layer.update();
    assert.deepEqual(names(layer), ['old event']);

    // Engine switch: the new drawing is still decoding its icons.
    layer.detachRenderer();
    const attached = layer.attachRenderer({ engine: { name: 'navara' } });
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
