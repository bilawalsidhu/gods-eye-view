import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGhostMapsLayer } from './index.js';

function element(localName, children = [], value = '', attributes = {}) {
  const node = {
    localName,
    children,
    get textContent() {
      return value + children.map((child) => child.textContent).join('');
    },
    getAttribute: (key) => attributes[key] ?? null,
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

function documentFixture() {
  return element('document', [
    element('kml', [
      element('Document', [
        element(
          'Style',
          [
            element('IconStyle', [
              element('Icon', [element('href', [], 'icon.png')]),
            ]),
          ],
          '',
          { id: 'pin' },
        ),
        element('Placemark', [
          element('name', [], 'Test report'),
          element('styleUrl', [], '#pin'),
          element('Point', [element('coordinates', [], '12,34')]),
        ]),
      ]),
    ]),
  ]);
}

// A stored KMZ with a local icon; the XML DOM double supplies its one point.
function fixtureKmz() {
  const files = [
    ['doc.kml', '<kml/>'],
    ['icon.png', 'packed icon'],
  ];
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of files) {
    const key = Buffer.from(name);
    const bytes = Buffer.from(value);
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
    directory.writeUInt32LE(offset, 42);
    local.push(header, key, bytes);
    central.push(directory, key);
    offset += header.length + key.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

function fixture(t, { beforeFileReturns, onCreateUrl } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  globalThis.DOMParser = class {
    parseFromString() {
      return documentFixture();
    }
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'DOMParser', previous);
    else delete globalThis.DOMParser;
  });
  const created = [];
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', () => {
    const url = `blob:local-${created.length}`;
    created.push(url);
    onCreateUrl?.(layer);
    return url;
  });
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  t.mock.method(console, 'warn', () => {});
  const mounted = new Set();
  const viewer = {
    scene: { requestRender() {} },
    dataSources: {
      async add(dataSource) {
        mounted.add(dataSource);
        return dataSource;
      },
      remove(dataSource) {
        return mounted.delete(dataSource);
      },
    },
  };
  const layer = createGhostMapsLayer({
    storage: null,
    source: {
      getCatalog: async () => ({
        products: [{ id: 'cip', version: 'a'.repeat(40), defaultOn: true }],
      }),
      getFile: async () => {
        beforeFileReturns?.(layer);
        return fixtureKmz();
      },
    },
  });
  layer.init(viewer);
  layer.enable();
  t.after(() => layer.destroy());
  return { layer, viewer, mounted, created, revoked };
}

test('cancelling a file read does not allocate packed-image URLs', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t, {
    beforeFileReturns: (layer) => queueMicrotask(() => layer.disable()),
  });
  await layer.update(viewer);
  assert.equal(created.length, 0);
  assert.equal(revoked.length, 0);
  assert.equal(mounted.size, 0);
});

test('cancellation during parsing releases every packed-image URL', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t, {
    onCreateUrl: (layer) => layer.disable(),
  });
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
});

test('entity construction failure releases parsed image URLs', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t);
  t.mock.method(Cesium.EntityCollection.prototype, 'add', () => {
    throw new Error('fixture entity failure');
  });
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
  assert.equal(layer.getStats().error, 'fixture entity failure');
});

test('successful load keeps icons until the product is disabled', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t);
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.equal(revoked.length, 0);
  assert.equal(mounted.size, 1);
  assert.equal(layer.getStats().count, 1);
  layer.disable();
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
});
