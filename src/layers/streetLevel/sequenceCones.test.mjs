import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../geo/index.js';
import { resolveFilter } from './filter.js';
import { CONE_SPRITE_ORDER } from './policy.js';
import {
  createSequenceCones,
  IMAGE_CONE_SCALE_BY_DISTANCE,
  thinImages,
} from './sequenceCones.js';
import {
  STREET_LEVEL_MAPS,
  streetLevelMap,
} from '../../testSupport/streetLevelFakes.mjs';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const SPRITES = 'street-level:test-cones';

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

/** Cones on the display of `harness` (the fake engine over Sacramento). */
function setup(harness = streetLevelMap({ view: true })) {
  const source = deferredSource();
  /** Every highlight asked of the coverage: a sequence id, or null for none. */
  const highlights = [];
  const state = {
    services: {},
    map: harness.map,
    filter: { pano: 'all', sinceDays: 0 },
    context: {
      getFilter: () => resolveFilter(state.filter),
      notify() {},
    },
    sequence: {
      selectedId: null,
      images: [],
      collection: null,
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
    spriteId: SPRITES,
    renderKey: 'test-sequence',
    onHighlight: (id) => highlights.push(id),
  });
  sequences.ensureCollections(harness.map);
  /** The cones drawn after a frame, in drawing order. */
  const shown = () => {
    harness.frame();
    return harness.spritesShown(SPRITES);
  };
  const drawn = () => shown().map((cone) => cone.pickId.split(':').at(-1));
  return { state, source, sequences, highlights, drawn, shown, harness };
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

for (const create of STREET_LEVEL_MAPS) {
  const name = create().name;

  test(`cones sit on the ground, over the scene, turned to their compass angle (${name})`, async () => {
    const harness = create();
    const { source, sequences, shown } = setup(harness);
    sequences.select('A');
    source.last('A').resolve([
      ...records('A', 2),
      {
        id: 'A-pano',
        geometry: { coordinates: [-121.488, 38.58] },
        compass_angle: 0,
        captured_at: 1_800_000_000_000,
        is_pano: true,
      },
    ]);
    await settle();
    const cones = shown();
    assert.equal(cones.length, 3);
    // Flat images and 360° rings: one sprite set each.
    const sets = harness.moverSets(SPRITES);
    assert.deepEqual(sets.map((set) => set.id).sort(), [
      `${SPRITES}:flat`,
      `${SPRITES}:pano`,
    ]);
    for (const set of sets) {
      assert.equal(set.options.depthTest, 'always');
      assert.equal(set.options.order, CONE_SPRITE_ORDER);
      assert.equal(set.options.pickable, true);
      assert.equal(set.options.sprite.sizePx, 26);
      assert.deepEqual(
        set.options.sprite.scaleByDistance,
        IMAGE_CONE_SCALE_BY_DISTANCE,
      );
    }
    const flat = cones.filter((cone) => !cone.pickId.endsWith('pano'));
    for (const cone of flat) {
      const height = geo.cartographic.fromCartesian(cone.position).height;
      assert.ok(Math.abs(height) < 1e-6, 'on the terrain (0 m here)');
      // Compass 90° from straight down, north up: a quarter turn clockwise.
      assert.ok(Math.abs(cone.rotation + Math.PI / 2) < 1e-3);
    }
    sequences.setVisible(false);
    assert.equal(shown().length, 0, 'hidden with the provider');
    sequences.setVisible(true);
    assert.equal(shown().length, 3);
    sequences.releaseCollection();
    assert.equal(harness.moverSets(SPRITES).length, 0, 'nothing left drawn');
  });
}

test('cones behind the globe are hidden, and show again from the other side', async () => {
  const harness = streetLevelMap({ view: true });
  const { source, sequences, shown } = setup(harness);
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
  const ids = () => shown().map((cone) => cone.pickId);
  assert.deepEqual(
    ids(),
    ['mly:img:A-0'],
    'the far side does not show through',
  );
  // Fly round to the other hemisphere: the two swap.
  harness.engine.fake.setPose({
    longitude: geo.math.toRadians(58.51),
    latitude: geo.math.toRadians(-38.58),
    height: 20_000_000,
  });
  assert.deepEqual(ids(), ['mly:img:A-far']);
  sequences.clearSelection();
  assert.deepEqual(ids(), []);
});

test('the cones paint once per camera move, not every frame', async () => {
  const harness = streetLevelMap({ view: true });
  const { source, sequences, shown } = setup(harness);
  sequences.select('A');
  source.last('A').resolve(records('A', 2));
  await settle();
  assert.equal(shown().length, 2);
  const commits = () =>
    harness.moverSets(SPRITES).reduce((sum, set) => sum + set.commits, 0);
  const before = commits();
  harness.engine.fake.frames(5);
  assert.equal(commits(), before, 'a still camera repaints nothing');
  // Turned where it stands.
  harness.engine.fake.setPose({
    position: harness.engine.camera.pose().position,
    heading: 1,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  harness.frame();
  assert.equal(commits(), before + 1, 'a moved camera repaints once');
  harness.engine.fake.frames(3);
  assert.equal(commits(), before + 1, 'and then rests again');
});

test('without a display the cones draw nothing and do not throw', async () => {
  const { state, source, sequences } = setup({
    map: null,
    frame() {},
    spritesShown: () => [],
  });
  state.map = null;
  sequences.ensureCollections(null);
  state.context.viewReady = () => false;
  sequences.select('A');
  source.last('A').resolve(records('A'));
  await settle();
  assert.equal(state.sequence.selectedId, 'A');
  sequences.rerender();
  sequences.setVisible(true);
  sequences.destroy();
  assert.equal(state.sequence.collection, null);
});
