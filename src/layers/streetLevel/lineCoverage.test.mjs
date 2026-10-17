import assert from 'node:assert/strict';
import test from 'node:test';
import { createLineCoverage } from './lineCoverage.js';
import {
  coverageViewer,
  tileCentre,
} from '../../testSupport/streetLevelFakes.mjs';
import { until } from '../../testSupport/kartaViewFakes.mjs';

const TUNING = Object.freeze({
  maxTiles: 9,
  overviewMaxTiles: 0,
  maxSequences: 900,
  lineWidthPx: 2,
  overviewPointPx: 2,
  moveDebounceMs: 10,
  viewRangeMinM: 2_500,
  viewRangePerHeight: 10,
  viewNearM: 1_000,
});

/**
 * Line coverage over one tile holding one line, on a viewer looking down from
 * `height`. `fetchTile` answers with that line unless `fail` says otherwise.
 */
function setup(
  t,
  {
    zoomFor,
    messages = { rateLimited: 'busy' },
    passes,
    fail,
    decoded = null,
    tuning = TUNING,
    overviewPointSize = null,
  } = {},
) {
  const centre = tileCentre(-121.4944, 38.5816);
  const viewer = coverageViewer(
    { lon: centre.lon, lat: centre.lat, height: 900 },
    t,
  );
  const state = {
    viewer,
    services: {},
    keyRequired: false,
    keyRejected: false,
    context: {
      getFilter: () => ({ pano: 'all', sinceMs: null }),
      isActive: () => true,
      notify() {},
      getSurface: () => 'draped',
      groundCaster: null,
      meshSampler: null,
    },
    coverage: {
      zoom: null,
      kind: null,
      tiles: new Map(),
      stale: new Map(),
      staleTimer: null,
      pending: new Map(),
      lastError: null,
      holdUntil: 0,
      holdTimer: null,
      debounceTimer: null,
      removeCameraListener: null,
      terrainReady: Promise.resolve(),
      hint: '',
    },
    sequence: { selectedId: null },
  };
  const asked = [];
  const coverage = createLineCoverage({
    state,
    fetchTile: async (tile) => {
      asked.push(tile);
      if (fail) throw fail;
      if (decoded) return decoded(centre, tile);
      return {
        sequences: [
          {
            id: 'line-1',
            parts: [
              [
                [centre.lon - 0.001, centre.lat],
                [centre.lon + 0.001, centre.lat],
              ],
            ],
            capturedAt: 0,
            isPano: false,
          },
        ],
        overview: [],
      };
    },
    zoomFor:
      zoomFor ??
      ((height) =>
        Number.isFinite(height) && height <= 6_000
          ? { zoom: 14, kind: 'sequence' }
          : null),
    colors: { coverage: '#635bff', selected: '#00e5ff' },
    pickPrefix: 'test:line:',
    renderKey: 'test-coverage',
    tuning,
    messages,
    ...(passes ? { passes } : {}),
    ...(overviewPointSize ? { overviewPointSize } : {}),
  });
  t.after(() => {
    coverage.clear();
    coverage.resetErrors();
  });
  return { viewer, state, coverage, asked };
}

test('above the zoom range the provider’s own “zoom in” hint shows; without one, the generic hint', (t) => {
  const tooHigh = 'zoom in to see test coverage';
  const high = setup(t, { messages: { rateLimited: 'busy', tooHigh } });
  high.viewer.view.height = 7_000;
  high.coverage.refresh();
  assert.equal(high.state.coverage.hint, tooHigh);
  assert.equal(high.state.coverage.zoom, null);
  assert.equal(high.asked.length, 0, 'nothing is asked from up there');
  const generic = setup(t);
  generic.viewer.view.height = 7_000;
  generic.coverage.refresh();
  assert.notEqual(generic.state.coverage.hint, tooHigh);
  assert.match(generic.state.coverage.hint, /Point the camera/);
});

test('a provider’s passes() decides which lines are drawn and counted', async (t) => {
  const all = setup(t, { passes: () => true });
  all.coverage.refresh();
  assert.ok(await until(() => all.state.coverage.tiles.size === 1));
  assert.equal(all.coverage.sequenceCount(), 1, 'control: the line is drawn');
  const none = setup(t, { passes: () => false });
  none.coverage.refresh();
  assert.ok(await until(() => none.state.coverage.tiles.size === 1));
  assert.equal(none.coverage.sequenceCount(), 0, 'filtered out');
});

test('a refused key without its own message keeps the error it came with', async (t) => {
  const refused = Object.assign(new Error('the source refused the key'), {
    keyRejected: true,
  });
  const { state, coverage } = setup(t, { fail: refused });
  coverage.refresh();
  assert.ok(await until(() => state.keyRejected === true));
  assert.equal(state.coverage.lastError, 'the source refused the key');
});

/** Three lines in one tile: an old long one, then two newer short ones. */
function threeLines(centre) {
  const line = (id, capturedAt, span) => ({
    id,
    parts: [
      [
        [centre.lon - span, centre.lat],
        [centre.lon + span, centre.lat],
      ],
    ],
    capturedAt,
    isPano: false,
  });
  return {
    sequences: [
      line('old-long', 1, 0.002),
      line('new-short', 2, 0.0002),
      line('newer-short', 3, 0.0001),
    ],
    overview: [],
  };
}

test('the per-tile cap keeps the newest lines, or the provider’s own order with keepOrder', async (t) => {
  const capped = { ...TUNING, maxTiles: 1, maxSequences: 2 };
  const drawnIds = (state) =>
    [...state.coverage.tiles.values()].flatMap((tile) => [
      ...tile.sequences.keys(),
    ]);
  const newest = setup(t, { decoded: threeLines, tuning: capped });
  newest.coverage.refresh();
  assert.ok(await until(() => newest.state.coverage.tiles.size === 1));
  assert.deepEqual(drawnIds(newest.state).sort(), ['new-short', 'newer-short']);
  const kept = setup(t, {
    decoded: threeLines,
    tuning: { ...capped, keepOrder: true },
  });
  kept.coverage.refresh();
  assert.ok(await until(() => kept.state.coverage.tiles.size === 1));
  assert.deepEqual(drawnIds(kept.state), ['old-long', 'new-short']);
});

test('overview points take the provider’s size, each its own', async (t) => {
  const { state, coverage, viewer } = setup(t, {
    zoomFor: () => ({ zoom: 3, kind: 'overview' }),
    tuning: { ...TUNING, overviewMaxTiles: 4 },
    decoded: (centre) => ({
      sequences: [],
      overview: [
        { id: 'a', lon: centre.lon, lat: centre.lat, weight: 1 },
        { id: 'b', lon: centre.lon + 0.01, lat: centre.lat, weight: 50_000 },
      ],
    }),
    overviewPointSize: (point) => (point.weight > 1 ? 7 : 3),
  });
  coverage.refresh();
  assert.ok(await until(() => state.coverage.tiles.size > 0));
  const sizes = [];
  for (const primitive of viewer.scene.primitives.items)
    for (let i = 0; i < (primitive.length ?? 0); i++)
      sizes.push(primitive.get(i).pixelSize);
  assert.deepEqual(sizes.sort(), [3, 7]);
});

test('a point budget skips lines past it, and a shorter one later may still fit', async (t) => {
  const { state, coverage } = setup(t, {
    tuning: {
      ...TUNING,
      maxTiles: 1,
      maxSequences: 10,
      maxPoints: 5,
      keepOrder: true,
    },
    decoded: (centre) => {
      const line = (id, n) => ({
        id,
        parts: [
          Array.from({ length: n }, (_, i) => [
            centre.lon - 0.001 + i * 0.0001,
            centre.lat,
          ]),
        ],
        capturedAt: 0,
        isPano: false,
      });
      return {
        sequences: [line('three', 3), line('four', 4), line('two', 2)],
        overview: [],
      };
    },
  });
  coverage.refresh();
  assert.ok(await until(() => state.coverage.tiles.size === 1));
  const [tile] = state.coverage.tiles.values();
  assert.deepEqual([...tile.sequences.keys()], ['three', 'two']);
});

/** A line of `n` points, its id unique to the tile. */
function pointsLine(id, n, tile, centre) {
  return {
    id,
    parts: [
      Array.from({ length: n }, (_, i) => [
        centre.lon - 0.001 + i * 0.00001,
        centre.lat,
      ]),
    ],
    capturedAt: 0,
    isPano: false,
  };
}

test('the point budget is shared: a sparse tile keeps its few, a dense one gets the rest', async (t) => {
  const tuning = {
    ...TUNING,
    maxTiles: 9,
    maxSequences: 900,
    maxPoints: 90,
    keepOrder: true,
  };
  const { state, coverage } = setup(t, {
    // Street zoom far enough in that several tiles are in view.
    zoomFor: () => ({ zoom: 18, kind: 'sequence' }),
    tuning,
    decoded: (centre, tile) => {
      const dense = tile.x % 2 === 0 && tile.y % 2 === 0;
      const lines = dense
        ? Array.from({ length: 30 }, (_, i) =>
            pointsLine(`d${tile.x}/${tile.y}/${i}`, 5, tile, centre),
          )
        : [pointsLine(`s${tile.x}/${tile.y}`, 2, tile, centre)];
      return { sequences: lines, overview: [] };
    },
  });
  coverage.refresh();
  assert.ok(
    await until(
      () => state.coverage.tiles.size > 1 && !state.coverage.pending.size,
    ),
  );
  const entries = [...state.coverage.tiles.values()];
  const drawn = (entry) => entry.pointsDrawn;
  const total = entries.reduce((sum, entry) => sum + drawn(entry), 0);
  assert.ok(total <= tuning.maxPoints, `within the budget: ${total}`);
  const sparse = entries.filter((entry) => entry.pointDemand === 2);
  const dense = entries.filter((entry) => entry.pointDemand === 150);
  assert.ok(sparse.length && dense.length, 'both kinds in view');
  for (const entry of sparse)
    assert.equal(drawn(entry), 2, 'a sparse tile keeps all');
  const fair = Math.floor(tuning.maxPoints / tuning.maxTiles);
  const left = tuning.maxPoints - sparse.length * 2;
  for (const entry of dense)
    assert.ok(
      drawn(entry) > fair || dense.length * fair >= left,
      `a dense tile gets more than the even share: ${drawn(entry)}`,
    );
  assert.ok(
    total > tuning.maxPoints - 5 * dense.length,
    'little budget unused',
  );
});

test('a selected sequence the budget left out is drawn, highlighted', async (t) => {
  const { state, coverage } = setup(t, {
    tuning: {
      ...TUNING,
      maxTiles: 1,
      maxSequences: 10,
      maxPoints: 5,
      keepOrder: true,
    },
    decoded: (centre, tile) => ({
      sequences: [
        pointsLine('long', 5, tile, centre),
        pointsLine('short', 3, tile, centre),
      ],
      overview: [],
    }),
  });
  coverage.refresh();
  assert.ok(await until(() => state.coverage.tiles.size === 1));
  const [tile] = state.coverage.tiles.values();
  assert.deepEqual([...tile.sequences.keys()], ['long']);
  state.sequence.selectedId = 'short';
  coverage.recolorSequence('short', true);
  assert.deepEqual([...tile.sequences.keys()].sort(), ['long', 'short']);
});

/** Count the line primitives a coverage adds to the scene. */
function countAdds(viewer) {
  const counts = { added: 0 };
  for (const collection of [
    viewer.scene.groundPrimitives,
    viewer.scene.primitives,
  ]) {
    const add = collection.add.bind(collection);
    collection.add = (primitive) => {
      counts.added++;
      return add(primitive);
    };
  }
  return counts;
}

test('a tile redrawn for a new share keeps its old lines until the new ones are ready', async (t) => {
  const tuning = {
    ...TUNING,
    maxTiles: 9,
    maxSequences: 900,
    maxPoints: 90,
    keepOrder: true,
  };
  const { state, coverage, viewer } = setup(t, {
    zoomFor: () => ({ zoom: 18, kind: 'sequence' }),
    tuning,
    decoded: (centre, tile) => {
      const dense = tile.x % 2 === 0 && tile.y % 2 === 0;
      return {
        sequences: dense
          ? Array.from({ length: 30 }, (_, i) =>
              pointsLine(`d${tile.x}/${tile.y}/${i}`, 5, tile, centre),
            )
          : [pointsLine(`s${tile.x}/${tile.y}`, 2, tile, centre)],
        overview: [],
      };
    },
  });
  coverage.refresh();
  assert.ok(
    await until(
      () => state.coverage.tiles.size > 1 && !state.coverage.pending.size,
    ),
  );
  const redrawn = [...state.coverage.tiles.values()].filter(
    (entry) => entry.swap,
  );
  assert.ok(redrawn.length > 0, 'a dense tile took a bigger share');
  for (const entry of redrawn)
    for (const { primitive } of entry.swap.old)
      assert.ok(
        viewer.scene.groundPrimitives.items.has(primitive) ||
          viewer.scene.primitives.items.has(primitive),
        'the old lines are still on the globe while the new ones build',
      );
});

test('a second redraw while a swap still builds keeps the lines on screen', async (t) => {
  const { state, coverage, viewer } = setup(t, {
    zoomFor: () => ({ zoom: 18, kind: 'sequence' }),
    tuning: {
      ...TUNING,
      maxTiles: 9,
      maxSequences: 900,
      maxPoints: 90,
      keepOrder: true,
    },
    decoded: (centre, tile) => {
      const dense = tile.x % 2 === 0 && tile.y % 2 === 0;
      return {
        sequences: dense
          ? Array.from({ length: 30 }, (_, i) =>
              pointsLine(`d${tile.x}/${tile.y}/${i}`, 5, tile, centre),
            )
          : [pointsLine(`s${tile.x}/${tile.y}`, 2, tile, centre)],
        overview: [],
      };
    },
  });
  coverage.refresh();
  assert.ok(
    await until(
      () => state.coverage.tiles.size > 1 && !state.coverage.pending.size,
    ),
  );
  // A tile mid-swap (its new lines never become ready here) with a line
  // the cap left out: selecting that line redraws the tile again.
  const entry = [...state.coverage.tiles.values()].find(
    (tile) =>
      tile.swap &&
      tile.sequenceList.some((sequence) => !tile.sequences.has(sequence.id)),
  );
  assert.ok(entry, 'a swapping tile with a line left out');
  const onScreen = [...entry.swap.old];
  const building = entry.primitives.map(({ primitive }) => primitive);
  const left = entry.sequenceList.find(
    (sequence) => !entry.sequences.has(sequence.id),
  );
  state.sequence.selectedId = left.id;
  coverage.recolorSequence(left.id, true);
  assert.ok(entry.sequences.has(left.id), 'the selected line is drawn');
  const onGlobe = (primitive) =>
    viewer.scene.groundPrimitives.items.has(primitive) ||
    viewer.scene.primitives.items.has(primitive);
  for (const { primitive } of onScreen)
    assert.ok(
      onGlobe(primitive),
      'the lines on screen stay until the new ones are ready',
    );
  for (const primitive of building)
    assert.ok(!onGlobe(primitive), 'the first swap’s unready lines are gone');
  assert.ok(entry.swap, 'still swapping');
});

test('a selected line outside the cap does not make its tile redraw on every settle, nor does one the filter hides', async (t) => {
  let pano = 'all';
  const { state, coverage, viewer } = setup(t, {
    tuning: {
      ...TUNING,
      maxTiles: 1,
      maxSequences: 10,
      maxPoints: 5,
      keepOrder: true,
    },
    decoded: (centre, tile) => ({
      sequences: [
        pointsLine('long', 5, tile, centre),
        { ...pointsLine('short', 3, tile, centre), isPano: true },
      ],
      overview: [],
    }),
  });
  state.context.getFilter = () => ({ pano, sinceMs: null });
  coverage.refresh();
  assert.ok(await until(() => state.coverage.tiles.size === 1));
  state.sequence.selectedId = 'short';
  coverage.recolorSequence('short', true);
  const counts = countAdds(viewer);
  for (let i = 0; i < 3; i++) {
    coverage.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(counts.added, 0, 'settles redraw nothing');
  // A selection the filter hides is not drawn, so it is not redrawn for.
  pano = 'flat';
  coverage.rebuild();
  const after = countAdds(viewer);
  for (let i = 0; i < 3; i++) coverage.recolorSequence('short', true);
  assert.equal(after.added, 0);
});

test('small share increases add up: a retained tile redraws once its share has grown past the threshold since its last draw', async (t) => {
  const tuning = {
    ...TUNING,
    maxTiles: 1,
    maxSequences: 900,
    maxPoints: 100,
    keepOrder: true,
  };
  const { state, coverage } = setup(t, {
    tuning,
    decoded: (centre, tile) => ({
      sequences: Array.from({ length: 30 }, (_, i) =>
        pointsLine(`l${i}`, 4, tile, centre),
      ),
      overview: [],
    }),
  });
  coverage.refresh();
  assert.ok(
    await until(
      () => state.coverage.tiles.size === 1 && !state.coverage.pending.size,
    ),
  );
  const [tile] = state.coverage.tiles.values();
  assert.equal(tile.pointsDrawn, 100);
  const settle = async () => {
    coverage.refresh();
    await until(() => !state.coverage.pending.size);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  // +8%: under the threshold, nothing is redrawn.
  tuning.maxPoints = 108;
  await settle();
  assert.equal(tile.pointsDrawn, 100);
  // +8% again: +16% since the tile was last drawn, so it is redrawn.
  tuning.maxPoints = 116;
  await settle();
  assert.equal(tile.pointsDrawn, 116, 'the grown share is drawn');
});
