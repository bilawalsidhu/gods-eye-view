import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { MESH_CELL_DEG } from '../../meshSampler.js';
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
  const colours = [];
  const errors = [];
  const state = {
    services: {},
    viewer: {},
    context: {
      notify() {},
      getFilter: () => ({ pano: 'all', sinceMs: null }),
      getSurface: () => 'draped',
      groundCaster: null,
      meshSampler: null,
      actions: { reportError: (message) => errors.push(message) },
    },
    sequence: {
      selectedId: null,
      images: [],
      cache: new Map(),
      collection: cones(),
      loading: false,
      abort: null,
    },
  };
  const parts = {
    coverage: {
      recolorSequence: (id, selected) => colours.push([id, selected]),
    },
  };
  const sequences = createSequences({ state, source, parts });
  const drawn = () =>
    state.sequence.collection.items.map((cone) => cone.id.split(':').at(-1));
  return { state, source, sequences, colours, errors, drawn };
}

test('a failed sequence load leaves no stale cones and can be retried', async () => {
  const { state, source, sequences, colours, errors, drawn } = setup();
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
  assert.deepEqual(colours.at(-1), ['B', false]);
  assert.deepEqual(errors, [null, 'Sequence images unavailable']);

  // Clicking B again asks again.
  sequences.select('B');
  assert.equal(source.calls.filter((c) => c.sequenceId === 'B').length, 2);
  source.last('B').resolve(records('B'));
  await settle();
  assert.deepEqual(drawn(), ['B-0', 'B-1']);
  assert.equal(state.sequence.selectedId, 'B');
  assert.equal(errors.at(-1), null, 'the error is cleared once B loads');
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

test('clearSelection cancels the lookup and uncolours the sequence', async () => {
  const { state, source, sequences, colours, errors, drawn } = setup();
  sequences.select('A');
  sequences.clearSelection();
  assert.equal(source.last('A').signal.aborted, true);
  assert.deepEqual(colours, [
    ['A', true],
    ['A', false],
  ]);
  assert.equal(state.sequence.selectedId, null);
  assert.equal(state.sequence.loading, false);
  assert.equal(errors.at(-1), null, 'an error about it goes too');
  source.last('A').resolve(records('A'));
  await settle();
  assert.deepEqual(drawn(), [], 'the late answer draws nothing');
});

/**
 * Terrain mode with bare earth at 10 m, a mesh sampler the test drives, and
 * cones that log every change made to them.
 */
function terrainSetup() {
  const context = setup();
  const { state } = context;
  const mesh = new Map();
  const cell = (lon, lat) =>
    `${Math.round(lon / MESH_CELL_DEG)},${Math.round(lat / MESH_CELL_DEG)}`;
  let announce = null;
  state.context.getSurface = () => 'terrain';
  state.context.groundCaster = {
    groundAt: () => 10,
    prepare: async () => true,
  };
  state.context.meshSampler = {
    request() {},
    meshAt: (lon, lat) => mesh.get(cell(lon, lat)),
    onSampled: (listener) => {
      announce = listener;
      return () => (announce = null);
    },
  };
  const changes = [];
  const items = [];
  state.sequence.collection = {
    items,
    show: true,
    add(options) {
      changes.push(['add', options.id]);
      const cone = new Proxy(options, {
        set(target, key, value) {
          changes.push([key, target.id]);
          target[key] = value;
          return true;
        },
      });
      items.push(cone);
      return cone;
    },
    removeAll() {
      changes.push(['removeAll']);
      items.length = 0;
    },
  };
  // Created again, so it listens to this sampler.
  const sequences = createSequences({
    state,
    source: context.source,
    parts: { coverage: { recolorSequence() {} } },
  });
  /** Sample the mesh under a point, then announce it as the sampler does. */
  function sample(lon, lat, height) {
    const centre = [
      Math.round(lon / MESH_CELL_DEG) * MESH_CELL_DEG,
      Math.round(lat / MESH_CELL_DEG) * MESH_CELL_DEG,
    ];
    mesh.set(cell(lon, lat), height);
    announce([centre]);
  }
  const heightOf = (cone) =>
    Cesium.Cartographic.fromCartesian(cone.position).height;
  return { ...context, sequences, changes, items, sample, heightOf };
}

test('a mesh sample away from the selected sequence changes no cone', async () => {
  const { source, sequences, changes, items, sample } = terrainSetup();
  sequences.select('A');
  source.last('A').resolve(records('A', 3));
  await settle();
  assert.equal(items.length, 3);
  changes.length = 0;
  sample(-121.3, 38.7, 12); // a street elsewhere in the tile
  assert.deepEqual(changes, [], 'nothing rebuilt or moved');
});

test('a mesh sample under a cone moves that cone in place, and no other', async () => {
  const { source, sequences, changes, items, sample, heightOf } =
    terrainSetup();
  sequences.select('A');
  source.last('A').resolve(records('A', 3));
  await settle();
  const before = items.map(heightOf);
  changes.length = 0;
  // The road under the second image is 2.5 m above the bare earth.
  sample(-121.489, 38.58, 12.5);
  assert.ok(
    changes.every(([, id]) => id === 'mly:img:A-1'),
    `only A-1 changed: ${JSON.stringify(changes)}`,
  );
  assert.ok(
    changes.some(([key]) => key === 'position'),
    'A-1 moved',
  );
  assert.equal(
    changes.some(([key]) => key === 'removeAll' || key === 'add'),
    false,
    'the collection is not rebuilt',
  );
  const after = items.map(heightOf);
  assert.ok(
    Math.abs(after[1] - 13.5) < 0.01,
    `A-1 stands on the road (${after[1]})`,
  );
  assert.deepEqual([after[0], after[2]], [before[0], before[2]]);
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
