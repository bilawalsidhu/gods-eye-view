import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackPresentations } from './presentation.js';
import { packItemId } from './geometry.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

test('abort releases an in-flight image URL before the decoder settles or the viewer is destroyed', async () => {
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const priorImage = globalThis.Image;
  const priorRevoke = URL.revokeObjectURL;
  const revoked = [];
  globalThis.Image = class {
    decode() {
      return pending;
    }
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    priorRevoke(url);
  };
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  const signalOwner = new AbortController();
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const header = new DataView(bytes.buffer);
  header.setUint32(16, 8);
  header.setUint32(20, 8);
  try {
    const rendering = createPackPresentations(viewer).image({
      pack: {},
      asset: { bytes, mimeType: 'image/png' },
      signal: signalOwner.signal,
    });
    const rejected = assert.rejects(rendering, /abort/i);
    signalOwner.abort();
    assert.equal(
      revoked.length,
      1,
      'object URL must be released synchronously with cancellation',
    );
    settle();
    await rejected;
    assert.equal(revoked.length, 1, 'late decode cannot dispose twice');
    assert.equal(draw.sets.size, 0, 'nothing is drawn');
  } finally {
    unbind();
    settle();
    globalThis.Image = priorImage;
    URL.revokeObjectURL = priorRevoke;
  }
});

test('a media pack names its marker through the label overlay, cleared on dispose', async () => {
  const published = [];
  const cleared = [];
  const viewer = { container: {} };
  const { draw, unbind } = bindFakeDraw(viewer);
  const overlayHost = {
    setEntries: (source, entries) => published.push([source, entries]),
    clearSource: (source) => cleared.push(source),
  };
  const handle = await createPackPresentations(viewer, new Map(), {
    overlayHost,
  }).media({
    pack: {
      id: 'harbour-audio',
      placement: { anchorId: 'pier' },
      attribution: { text: 'Port', license: 'CC-BY' },
    },
    anchors: [{ id: 'pier', lon: -122.39, lat: 37.79, alt: 5 }],
    asset: { bytes: new Uint8Array(4), mimeType: 'audio/mpeg' },
    signal: new AbortController().signal,
  });
  const marker = draw.find('data-pack:');
  assert.equal(marker.kind, 'points');
  const point = marker.items.get(packItemId('harbour-audio', 'media'));
  assert.deepEqual(
    { pixelSize: point.pixelSize, color: point.color },
    { pixelSize: 16, color: '#ffff00' },
  );
  const [source, entries] = published.at(-1);
  assert.match(source, /^data-pack-labels:\d+$/);
  assert.deepEqual(
    entries.map(({ title, variant }) => ({ title, variant })),
    [{ title: 'harbour-audio', variant: 'label' }],
  );
  assert.equal(entries[0].position, point.pos);
  assert.equal(entries[0].protected, true, 'it always draws, as before');
  handle.dispose();
  assert.deepEqual(cleared, [source]);
  assert.equal(marker.disposed, true);
  unbind();
});

test('without an overlay host a media pack fails to load instead of losing its name', async () => {
  const viewer = { container: {} };
  const { draw, unbind } = bindFakeDraw(viewer);
  await assert.rejects(
    createPackPresentations(viewer).media({
      pack: {
        id: 'harbour-audio',
        placement: { anchorId: 'pier' },
        attribution: { text: 'Port', license: 'CC-BY' },
      },
      anchors: [{ id: 'pier', lon: -122.39, lat: 37.79, alt: 5 }],
      asset: { bytes: new Uint8Array(4), mimeType: 'audio/mpeg' },
      signal: new AbortController().signal,
    }),
    /overlay host/,
  );
  const sets = [...draw.sets.values()];
  assert.equal(sets.length, 1);
  assert.equal(sets[0].disposed, true, 'the marker it placed is removed again');
  unbind();
});

test('two presentations of one media pack keep their labels apart, and reuse sources', async () => {
  // Like the real host, clearing a source empties it but keeps it registered.
  const sources = new Map();
  const overlayHost = {
    setEntries: (source, entries) => sources.set(source, entries),
    clearSource: (source) => sources.set(source, []),
  };
  const shown = () =>
    [...sources.values()].filter((entries) => entries.length).length;
  const viewer = { container: {} };
  const { unbind } = bindFakeDraw(viewer);
  const show = () =>
    createPackPresentations(viewer, new Map(), { overlayHost }).media({
      pack: {
        id: 'harbour-audio',
        placement: { anchorId: 'pier' },
        attribution: { text: 'Port', license: 'CC-BY' },
      },
      anchors: [{ id: 'pier', lon: -122.39, lat: 37.79, alt: 5 }],
      asset: { bytes: new Uint8Array(4), mimeType: 'audio/mpeg' },
      signal: new AbortController().signal,
    });
  const first = await show();
  const second = await show();
  assert.equal(shown(), 2);
  first.dispose();
  assert.equal(shown(), 1, "the second presentation's label stays");
  second.dispose();
  assert.equal(shown(), 0);
  const registered = sources.size;
  for (let i = 0; i < 5; i++) (await show()).dispose();
  assert.equal(sources.size, registered, 'repeat loads reuse freed sources');
  const late = await show();
  late.dispose();
  late.label({ id: 'late', position: { x: 1, y: 0, z: 0 }, title: 'late' });
  late.dispose();
  assert.equal(shown(), 0, 'a label after dispose is ignored');
  unbind();
});

test('a geometry pack draws its points, lines and polygons as sets, and its features pick by set and item', async () => {
  const viewer = { container: {} };
  const { draw, unbind } = bindFakeDraw(viewer);
  const targets = new Map();
  const ring = [
    [2, 1, 50],
    [2.1, 1, 50],
    [2.1, 1.1, 50],
    [2, 1, 50],
  ];
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'point',
          geometry: { type: 'Point', coordinates: [2, 1, 10] },
        },
        {
          type: 'Feature',
          id: 'line',
          geometry: {
            type: 'LineString',
            coordinates: [
              [2, 1],
              [2.1, 1.1],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'area',
          geometry: { type: 'Polygon', coordinates: [ring] },
        },
      ],
    }),
  );
  const handle = await createPackPresentations(viewer, targets, {
    overlayHost: { setEntries() {}, clearSource() {} },
  }).geojson({
    pack: { id: 'data', attribution: { text: 'Example', license: 'CC0' } },
    asset: { bytes, mimeType: 'application/geo+json' },
    signal: new AbortController().signal,
  });
  const byKind = Object.fromEntries(
    [...draw.sets.values()].map((record) => [record.kind, record]),
  );
  assert.deepEqual(Object.keys(byKind).sort(), ['lines', 'points', 'shapes']);
  const point = byKind.points.items.get(packItemId('data', 'point'));
  assert.deepEqual(point.pos, { lon: 2, lat: 1, height: 10 });
  assert.deepEqual(
    [point.pixelSize, point.outlineWidth, point.color, point.outlineColor],
    [12, 2, [0, 1, 1, 1], [0, 0, 0, 1]],
  );
  const line = byKind.lines.items.get(packItemId('data', 'line'));
  assert.equal(line.mode, '3d');
  assert.equal(line.widthPx, 4);
  assert.deepEqual(line.style, { kind: 'solid', color: [0, 1, 1, 1] });
  assert.equal(line.positions.length, 2);
  const area = byKind.shapes.items.get(packItemId('data', 'area'));
  assert.equal(area.geometry.perPositionHeight, true);
  assert.deepEqual(area.geometry.rings[0][1], { lon: 2.1, lat: 1, height: 50 });
  assert.deepEqual(area.fill, [0, 1, 1, 0.35]);
  assert.deepEqual(targets.get(JSON.stringify(['data', 'line'])), {
    set: byKind.lines.spec.id,
    id: packItemId('data', 'line'),
  });
  assert.equal(
    packItemId('data', 'line'),
    'data-pack:["data","line"]',
    'never a bare feature id a contact lookup could claim',
  );
  assert.equal(targets.size, 3);
  handle.dispose();
  assert.equal(targets.size, 0);
  assert.ok([...draw.sets.values()].every((record) => record.disposed));
  unbind();
});

test('an image pack draws its decoded pixels as a rectangle at its height', async () => {
  const priorImage = globalThis.Image;
  const priorDocument = globalThis.document;
  const drawn = [];
  globalThis.Image = class {
    naturalWidth = 8;
    naturalHeight = 4;
    decode() {
      return Promise.resolve();
    }
  };
  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, 'canvas');
      const canvas = {
        getContext: () => ({
          drawImage: (image, x, y) =>
            drawn.push([image, x, y, canvas.width, canvas.height]),
        }),
      };
      return canvas;
    },
  };
  const viewer = { container: {} };
  const { draw, unbind } = bindFakeDraw(viewer);
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const header = new DataView(bytes.buffer);
  header.setUint32(16, 8);
  header.setUint32(20, 4);
  try {
    const handle = await createPackPresentations(viewer, new Map(), {
      store: { publish() {} },
    }).image({
      pack: {
        id: 'overlay',
        attribution: { text: 'Example', license: 'CC0' },
        placement: { bounds: [-98, 30, -97, 31], height: 200 },
      },
      asset: { bytes, mimeType: 'image/png' },
      signal: new AbortController().signal,
    });
    const record = draw.find('data-pack:');
    assert.equal(record.kind, 'shapes');
    const item = record.items.get(packItemId('overlay', 'image'));
    assert.deepEqual(item.geometry, {
      kind: 'rectangle',
      rect: { west: -98, south: 30, east: -97, north: 31 },
      height: 200,
    });
    const { canvas, key } = item.fill.image;
    assert.deepEqual([canvas.width, canvas.height], [8, 4]);
    assert.equal(drawn.length, 1);
    assert.deepEqual(drawn[0].slice(1), [0, 0, 8, 4]);
    assert.match(key, /^blob:/);
    handle.dispose();
    assert.equal(record.disposed, true);
  } finally {
    unbind();
    globalThis.Image = priorImage;
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});
