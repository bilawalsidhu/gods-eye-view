import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackPresentations } from './presentation.js';

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
  const viewer = {
    scene: { requestRender() {} },
    entities: {
      remove() {
        assert.fail('No entity should be acquired');
      },
    },
  };
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
  } finally {
    settle();
    globalThis.Image = priorImage;
    URL.revokeObjectURL = priorRevoke;
  }
});

test('a media pack names its marker through the label overlay, cleared on dispose', async () => {
  const published = [];
  const cleared = [];
  const added = [];
  const viewer = {
    container: {},
    scene: { requestRender() {} },
    entities: {
      add: (spec) => (added.push(spec), spec),
      remove() {},
    },
  };
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
  assert.equal(added.length, 1);
  assert.equal(added[0].label, undefined, 'no Cesium label on the marker');
  const [source, entries] = published.at(-1);
  assert.match(source, /^data-pack-labels:\d+$/);
  assert.deepEqual(
    entries.map(({ title, variant }) => ({ title, variant })),
    [{ title: 'harbour-audio', variant: 'label' }],
  );
  assert.equal(entries[0].position, added[0].position);
  assert.equal(entries[0].protected, true, 'it always draws, as before');
  handle.dispose();
  assert.deepEqual(cleared, [source]);
});

test('without an overlay host a media pack fails to load instead of losing its name', async () => {
  const removed = [];
  const viewer = {
    container: {},
    scene: { requestRender() {} },
    entities: { add: (spec) => spec, remove: (entity) => removed.push(entity) },
  };
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
  assert.equal(removed.length, 1, 'the marker it placed is removed again');
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
  const viewer = {
    container: {},
    scene: { requestRender() {} },
    entities: { add: (spec) => spec, remove() {} },
  };
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
});
