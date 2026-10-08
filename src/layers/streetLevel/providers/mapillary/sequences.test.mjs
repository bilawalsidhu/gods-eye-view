import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSequences } from './sequences.js';

// The cone glyphs draw on a canvas; Node has none, so any drawing is a no-op.
const noop = () => {};
const context2d = new Proxy({}, { get: () => noop, set: () => true });
globalThis.document ??= {
  createElement: () => ({ getContext: () => context2d }),
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A billboard collection that remembers the cones on the globe. */
function cones() {
  const items = [];
  return {
    items,
    show: true,
    add(options) {
      items.push(options);
      return options;
    },
    removeAll() {
      items.length = 0;
    },
  };
}

/** A source whose sequence lookups the test answers, one call at a time. */
function deferredSource() {
  const calls = [];
  return {
    calls,
    getSequenceImages(sequenceId, { signal } = {}) {
      return new Promise((resolve, reject) => {
        calls.push({ sequenceId, signal, resolve, reject });
      });
    },
    /** The latest lookup for a sequence. */
    last(sequenceId) {
      return calls.filter((call) => call.sequenceId === sequenceId).at(-1);
    },
  };
}

/** Graph image records for a sequence, a few metres apart. */
function records(sequenceId, count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${sequenceId}-${i}`,
    geometry: { coordinates: [-121.49 + i * 0.001, 38.58] },
    compass_angle: 90,
    captured_at: 1_700_000_000_000 + i,
  }));
}

function setup() {
  const source = deferredSource();
  /** Every highlight asked of the coverage: a sequence id, or null for none. */
  const highlights = [];
  const state = {
    services: {},
    viewer: {},
    filter: { pano: 'all', sinceDays: 0 },
    notify() {},
    sequence: {
      selectedId: null,
      images: [],
      cache: new Map(),
      collection: cones(),
      loading: false,
      error: null,
      abort: null,
    },
  };
  const parts = {
    coverage: {
      highlight: (id) => highlights.push(id),
    },
  };
  const sequences = createSequences({ state, source, parts });
  const drawn = () =>
    state.sequence.collection.items.map((cone) => cone.id.split(':').at(-1));
  return { state, source, sequences, highlights, drawn };
}

test('a failed sequence load leaves no stale cones and can be retried', async () => {
  const { state, source, sequences, highlights, drawn } = setup();
  sequences.select('A');
  source.last('A').resolve(records('A'));
  await settle();
  assert.deepEqual(drawn(), ['A-0', 'A-1']);

  sequences.select('B');
  assert.deepEqual(drawn(), [], "A's cones go while B loads");
  source.last('B').reject(new Error('Sequence images unavailable'));
  await settle();
  assert.deepEqual(drawn(), [], 'nothing of A is left to click');
  assert.equal(state.sequence.loading, false);
  assert.equal(state.sequence.selectedId, null, 'B is not left highlighted');
  assert.equal(highlights.at(-1), null);
  assert.equal(state.sequence.error, 'Sequence images unavailable');

  // Clicking B again asks again.
  sequences.select('B');
  assert.equal(source.calls.filter((c) => c.sequenceId === 'B').length, 2);
  source.last('B').resolve(records('B'));
  await settle();
  assert.deepEqual(drawn(), ['B-0', 'B-1']);
  assert.equal(state.sequence.selectedId, 'B');
  assert.equal(state.sequence.error, null, 'cleared once B loads');
});

test('a late answer for a superseded sequence neither draws nor is cached', async () => {
  const { state, source, sequences, drawn } = setup();
  sequences.select('A');
  sequences.select('B');
  assert.equal(source.last('A').signal.aborted, true, 'A was cancelled');
  source.last('B').resolve(records('B'));
  await settle();
  source.last('A').resolve(records('A'));
  await settle();
  assert.deepEqual(drawn(), ['B-0', 'B-1']);
  assert.equal(state.sequence.selectedId, 'B');
  assert.equal(state.sequence.cache.has('A'), false);
  assert.equal(state.sequence.loading, false);
});

test('a second click on a loading sequence does not start another lookup', async () => {
  const { source, sequences } = setup();
  sequences.select('A');
  sequences.select('A');
  assert.equal(source.calls.length, 1);
  assert.equal(source.calls[0].signal.aborted, false);
});

test('a cached sequence is re-selected without a lookup', async () => {
  const { state, source, sequences, drawn } = setup();
  sequences.select('A');
  source.last('A').resolve(records('A'));
  await settle();
  sequences.select('B');
  source.last('B').resolve(records('B'));
  await settle();
  sequences.select('A');
  assert.equal(source.calls.length, 2, 'A came from the cache');
  assert.deepEqual(drawn(), ['A-0', 'A-1'], 'drawn at once');
  assert.equal(state.sequence.loading, false);
  assert.equal(state.sequence.selectedId, 'A');
});

test('clearSelection cancels the lookup and drops the highlight', async () => {
  const { state, source, sequences, highlights, drawn } = setup();
  sequences.select('A');
  sequences.clearSelection();
  assert.equal(source.last('A').signal.aborted, true);
  assert.deepEqual(highlights, ['A', null]);
  assert.equal(state.sequence.selectedId, null);
  assert.equal(state.sequence.loading, false);
  assert.equal(state.sequence.error, null, 'an error about it goes too');
  source.last('A').resolve(records('A'));
  await settle();
  assert.deepEqual(drawn(), [], 'the late answer draws nothing');
});

test('cones are clamped to the ground and turned to their compass angle', async () => {
  const { state, source, sequences } = setup();
  sequences.select('A');
  source.last('A').resolve(records('A', 2));
  await settle();
  const items = state.sequence.collection.items;
  assert.equal(items.length, 2);
  for (const cone of items) {
    assert.equal(cone.heightReference, Cesium.HeightReference.CLAMP_TO_GROUND);
    assert.equal(cone.rotation, -Cesium.Math.toRadians(90));
  }
});

test('cones behind the globe are hidden, and show again from the other side', async () => {
  const { state, source, sequences } = setup();
  const view = { lon: -121.49, lat: 38.58, height: 20_000_000 };
  const preRender = new Set();
  state.viewer = {
    camera: {
      get positionWC() {
        return Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height);
      },
    },
    scene: {
      preRender: {
        addEventListener(listener) {
          preRender.add(listener);
          return () => preRender.delete(listener);
        },
      },
    },
  };
  sequences.select('A');
  // One image under the camera, one near its antipode.
  source.last('A').resolve([
    ...records('A', 1),
    {
      id: 'A-far',
      geometry: { coordinates: [58.51, -38.58] },
      captured_at: 1_800_000_000_000,
    },
  ]);
  await settle();
  const [near, far] = state.sequence.collection.items;
  assert.equal(near.show, true, 'the near side stays visible');
  assert.equal(far.show, false, 'the far side does not show through');
  // Fly round to the other hemisphere: the two swap.
  view.lon = 58.51;
  view.lat = -38.58;
  for (const listener of [...preRender]) listener();
  assert.equal(near.show, false);
  assert.equal(far.show, true);
  sequences.clearSelection();
  assert.equal(preRender.size, 0, 'the cull listener is gone');
});
