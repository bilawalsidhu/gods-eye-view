import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { resolveFilter } from './filter.js';
import { createSequenceCones, thinImages } from './sequenceCones.js';
import { createMarker } from './marker.js';
import { createCesiumDraw } from '../../render/cesium/draw.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { streetPorts } from '../../testSupport/streetLevelFakes.mjs';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A viewer 20,000 km over `view` (mutable), bound to a fake draw port and
 * the camera and frame ports, with its pre-render listeners.
 */
function coneViewer({ draw = fakeDrawPort() } = {}) {
  const view = { lon: -121.49, lat: 38.58, height: 20_000_000 };
  const preRender = new Set();
  const viewer = {
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
  bindRenderer(viewer, streetPorts(viewer, { camera: true, draw }));
  return { viewer, view, preRender, draw };
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

function setup({ draw: port } = {}) {
  const source = deferredSource();
  /** Every highlight asked of the coverage: a sequence id, or null for none. */
  const highlights = [];
  const { viewer, view, preRender, draw } = coneViewer(
    port ? { draw: port } : {},
  );
  const state = {
    services: {},
    viewer,
    filter: { pano: 'all', sinceDays: 0 },
    context: {
      getFilter: () => resolveFilter(state.filter),
      notify() {},
    },
    sequence: {
      selectedId: null,
      images: [],
      set: null,
      sprite: null,
      loading: false,
      error: null,
      abort: null,
    },
  };
  const sequences = createSequenceCones({
    state,
    async loadImages(sequenceId, { signal }) {
      const list = await source.getSequenceImages(sequenceId, { signal });
      return thinImages(
        list.map((record) => ({
          id: String(record.id),
          lon: record.geometry.coordinates[0],
          lat: record.geometry.coordinates[1],
          compassAngle: Number(record.compass_angle) || 0,
          capturedAt: Number(record.captured_at) || 0,
          isPano: record.is_pano === true,
        })),
      );
    },
    colors: { coverage: '#05cb63' },
    pickPrefix: 'mly:img:',
    spriteId: 'street-level:test-cones',
    renderKey: 'test-sequence',
    onHighlight: (id) => highlights.push(id),
  });
  sequences.ensureCollections(viewer);
  /** The drawn cones, in the order sent. */
  const cones = () => [
    ...(draw.find('street-level:test-cones:')?.items.values() ?? []),
  ];
  const drawn = () => cones().map((cone) => cone.id.split(':').at(-1));
  return {
    state,
    viewer,
    source,
    sequences,
    highlights,
    drawn,
    cones,
    draw,
    view,
    preRender,
  };
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

  // Clicking B again asks again, without the old error.
  sequences.select('B');
  assert.equal(source.calls.filter((c) => c.sequenceId === 'B').length, 2);
  assert.equal(state.sequence.error, null, 'not shown while B loads again');
  source.last('B').resolve(records('B'));
  await settle();
  assert.deepEqual(drawn(), ['B-0', 'B-1']);
  assert.equal(state.sequence.selectedId, 'B');
  assert.equal(state.sequence.error, null, 'cleared once B loads');
});

test('a late answer for a superseded sequence draws nothing', async () => {
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
  assert.equal(state.sequence.loading, false);
});

test('a second click on a loading sequence does not start another lookup', async () => {
  const { source, sequences } = setup();
  sequences.select('A');
  sequences.select('A');
  assert.equal(source.calls.length, 1);
  assert.equal(source.calls[0].signal.aborted, false);
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
  const { source, sequences, cones } = setup();
  sequences.select('A');
  source.last('A').resolve(records('A', 2));
  await settle();
  const items = cones();
  assert.equal(items.length, 2);
  for (const cone of items) {
    assert.equal(cone.height, 'clampGround');
    assert.equal(cone.rotationMode, 'course');
    assert.equal(cone.course, 90);
    assert.equal(cone.disableDepthTest, Number.POSITIVE_INFINITY);
    assert.deepEqual(cone.scaleByDistance, {
      near: 200,
      nearValue: 1.1,
      far: 6000,
      farValue: 0.35,
    });
  }
  assert.deepEqual(
    items.map((cone) => cone.id),
    ['mly:img:A-0', 'mly:img:A-1'],
    'each picks as its image',
  );
});

test('cones behind the globe are hidden, and show again from the other side', async () => {
  const { source, sequences, cones, view, preRender } = setup();
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
  let [near, far] = cones();
  assert.equal(near.show, true, 'the near side stays visible');
  assert.equal(far.show, false, 'the far side does not show through');
  // Fly round to the other hemisphere: the two swap.
  view.lon = 58.51;
  view.lat = -38.58;
  for (const listener of [...preRender]) listener();
  [near, far] = cones();
  assert.equal(near.show, false);
  assert.equal(far.show, true);
  sequences.clearSelection();
  assert.equal(cones().length, 0);
  assert.equal(preRender.size, 0, 'the cull listener is gone');
});

test('hiding and destroying the cones show and dispose their set', async () => {
  const { source, sequences, draw, state } = setup();
  sequences.select('A');
  source.last('A').resolve(records('A'));
  await settle();
  const set = draw.find('street-level:test-cones:');
  sequences.setVisible(false);
  assert.equal(set.show, false);
  sequences.setVisible(true);
  assert.equal(set.show, true);
  sequences.destroy();
  assert.equal(set.disposed, true);
  assert.equal(state.sequence.set, null);
});

test('the cones stay drawn over the photo marker, whichever is drawn first', async () => {
  const added = [];
  const scene = {
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    updateHeight: () => () => {},
    getHeight: () => undefined,
    primitives: {
      add: (primitive) => (added.push(primitive), primitive),
      remove: (primitive) => {
        const at = added.indexOf(primitive);
        if (at >= 0) added.splice(at, 1);
        return at >= 0;
      },
      get length() {
        return added.length;
      },
      get: (i) => added[i],
    },
    requestRender() {},
  };
  const { port } = createCesiumDraw({
    scene,
    report: (error) => assert.fail(error),
  });
  const { state, viewer, source, sequences } = setup({ draw: port });
  // As the layer starts: the marker's set first, then each provider's cones.
  const marker = createMarker({
    state: Object.assign(state, {
      marker: { set: null, sprite: null, placed: null, look: null },
    }),
  });
  marker.ensure(viewer);
  sequences.ensureCollections(viewer);
  // A sequence selected before any photo opens: its cones draw first.
  sequences.select('A');
  source.last('A').resolve(records('A'));
  await settle();
  marker.set({ lon: -121.49, lat: 38.58 }, 90);
  const order = added.map((host) => host.get(0)?.id?.id ?? null);
  assert.deepEqual(order, ['sl:pos', 'mly:img:A-0'], 'bottom to top');
  sequences.destroy(viewer);
  marker.destroy();
});
