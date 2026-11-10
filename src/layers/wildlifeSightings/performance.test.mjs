import assert from 'node:assert/strict';
import test from 'node:test';
import {
  harness,
  syntheticRows,
  changePositions,
  WILDLIFE_BENCHMARK_REFRESHES,
} from '../../testSupport/wildlifeBillboardModel.mjs';

test('500 / 2,000 / 5,000 contacts write only position deltas and do no work for unchanged input', () => {
  for (const n of [500, 2000, 5000]) {
    const h = harness();
    let rows = syntheticRows(n);
    assert.equal(h.apply(rows).created, n);
    const retained = h.pointById.get(rows[1].stableId);
    for (let refresh = 0; refresh < WILDLIFE_BENCHMARK_REFRESHES; refresh++) {
      rows = changePositions(rows, refresh);
      assert.deepEqual(h.apply(rows), {
        created: 0,
        removed: 0,
        updated: n / 10,
        writes: n / 10,
      });
      assert.equal(h.pointById.get(rows[1].stableId), retained);
    }
    assert.equal(h.counters.created, n);
    assert.equal(h.counters.destroyed, 0);
    const before = { ...h.counters };
    assert.deepEqual(h.apply([...rows].reverse()), {
      created: 0,
      removed: 0,
      updated: 0,
      writes: 0,
    });
    assert.deepEqual(
      h.counters,
      before,
      'unchanged content writes and allocates nothing',
    );
  }
});

test('ten 10% membership refreshes allocate and remove exactly their delta', (t) => {
  const n = 2000;
  const h = harness();
  let rows = syntheticRows(n);
  h.apply(rows);
  const retainedId = rows[1].stableId;
  const retained = h.pointById.get(retainedId);
  for (let refresh = 0; refresh < WILDLIFE_BENCHMARK_REFRESHES; refresh++) {
    rows = rows.map((row, i) =>
      i % 10 === 0 ? { ...row, stableId: `replacement:${refresh}:${i}` } : row,
    );
    assert.deepEqual(h.apply(rows), {
      created: n / 10,
      removed: n / 10,
      updated: 0,
      writes: (n / 10) * 5,
    });
    assert.equal(h.pointById.get(retainedId), retained);
    assert.equal(h.points.size, n);
  }
  assert.equal(h.counters.created, n + (n / 10) * WILDLIFE_BENCHMARK_REFRESHES);
  assert.equal(h.counters.destroyed, (n / 10) * WILDLIFE_BENCHMARK_REFRESHES);
  t.diagnostic(
    `N=${n}, 10 refreshes: initial creates=${n}, delta creates=2000, delta removes=2000, retained billboard identity unchanged`,
  );
});

test('count, grade and name edits produce no billboard writes or resampling', () => {
  const h = harness();
  const rows = syntheticRows(500);
  h.model.update(rows);
  const before = { ...h.counters };
  assert.deepEqual(
    h.model.update(
      rows.map((row) => ({
        ...row,
        count: 1000,
        quality: 'needs_id',
        commonName: 'Synthetic name',
      })),
    ),
    { created: 0, removed: 0, updated: 0, writes: 0 },
  );
  assert.deepEqual(h.counters, before);
});

import { PerformanceObserver } from 'node:perf_hooks';
import {
  denseContinentalRendering,
  DENSE_CONTINENT_CELLS,
  DENSE_CONTINENT_ROWS,
} from './renderPerformanceFixtures.mjs';
import {
  WILDLIFE_MOVE_END_BUDGET_MS,
  WILDLIFE_WORK_UNIT,
  createWildlifeWorkQueue,
} from './performance.js';

test('dense continental moveEnd has a deterministic linear operation budget and reuses decoded metadata/coordinates', () => {
  const h = denseContinentalRendering();
  try {
    assert.equal(
      h.moveEnd(),
      'pending',
      'dense work must yield before blocking camera input',
    );
    assert.equal(
      h.metrics.projections,
      0,
      'moveEnd enqueues work without processing a tile',
    );
    const cold = h.flush();
    assert.ok(
      cold.glowPrimitives > 4000 &&
        cold.billboards > 50 &&
        cold.billboards <= DENSE_CONTINENT_ROWS,
      'benchmark exercises a dense glow with only real sampled sighting badges',
    );
    assert.equal(
      h.state.renderPipelineOperations.densityVisits,
      DENSE_CONTINENT_CELLS,
    );
    assert.equal(
      h.state.renderPipelineOperations.densityMetadataBuilds,
      DENSE_CONTINENT_CELLS,
    );
    assert.ok(cold.slices.length > 1);
    for (let move = 1; move <= 4; move++) {
      h.moveEnd(move * 3);
      const result = h.flush();
      const ops = h.state.renderPipelineOperations;
      assert.equal(ops.densityVisits, DENSE_CONTINENT_CELLS);
      assert.equal(ops.observationVisits, DENSE_CONTINENT_ROWS);
      assert.equal(ops.densityMetadataBuilds, 0);
      assert.equal(ops.densityWrites, 0);
      assert.equal(ops.densityPositionBuilds, 0);
      assert.ok(ops.densityRetirementVisits <= DENSE_CONTINENT_CELLS);
      assert.equal(ops.densityCreated, 0);
      assert.equal(ops.densityRemoved, 0);
      assert.equal(
        result.cartesianBuilds,
        0,
        'no repeated longitude/latitude trig per camera pass',
      );
      assert.ok(ops.projections <= DENSE_CONTINENT_ROWS);
      assert.ok(result.projections <= DENSE_CONTINENT_ROWS + 150);
      assert.ok(
        ops.billboardVisits <= result.billboards * 3 + WILDLIFE_WORK_UNIT,
      );
      assert.equal(
        ops.rankComparisons,
        0,
        'continental buckets never sort the source population',
      );
      assert.ok(ops.spacingTests <= result.billboards * 9);
      assert.ok(result.slices.length <= 144);
      assert.ok(result.slices.every((slice) => slice.units <= 8));
      assert.equal(
        result.publications,
        3,
        'publish overlays once after the accepted view is ready',
      );
    }
    h.moveEnd(12);
    h.flush();
    assert.equal(h.state.renderPipelineOperations.billboardWrites, 0);
    assert.equal(
      h.state.renderPipelineOperations.billboardVisits,
      h.state.renderedRows.length * 2,
      'the delta owner scans each row and retained billboard once',
    );
  } finally {
    h.destroy();
  }
});

test('superseded dense camera work is dropped and idle callbacks are removed at teardown', () => {
  const h = denseContinentalRendering();
  assert.equal(h.moveEnd(0), 'pending');
  assert.equal(h.moveEnd(12), 'pending');
  const result = h.flush();
  assert.equal(
    h.state.renderPipelineOperations.densityVisits,
    DENSE_CONTINENT_CELLS,
  );
  assert.equal(result.publications, 3);
  assert.equal(h.moveEnd(24), 'pending');
  h.destroy();
  assert.equal(h.flush().slices.length, 0);
});

test('performance marks cover each render phase and leave no accumulated entries', async () => {
  const observed = [];
  const observer = new PerformanceObserver((list) =>
    observed.push(...list.getEntries()),
  );
  observer.observe({ entryTypes: ['measure'] });
  const h = denseContinentalRendering();
  try {
    h.moveEnd();
    h.flush();
    await new Promise((resolve) => setImmediate(resolve));
    for (const phase of [
      'density',
      'bucket',
      'rank',
      'billboard-update',
      'overlay-publish',
      'moveEnd:slice',
    ])
      assert.ok(
        observed.some((entry) => entry.name === `wildlife-sightings:${phase}`),
        phase,
      );
    assert.deepEqual(
      performance
        .getEntriesByType('mark')
        .filter((entry) => entry.name.startsWith('wildlife-sightings:')),
      [],
    );
    assert.deepEqual(
      performance
        .getEntriesByType('measure')
        .filter((entry) => entry.name.startsWith('wildlife-sightings:')),
      [],
    );
    assert.equal(WILDLIFE_MOVE_END_BUDGET_MS, 4);
  } finally {
    observer.disconnect();
    h.destroy();
  }
});

test('idle work has a fixed unit ceiling even when the clock does not advance', () => {
  const callbacks = new Map();
  let id = 0;
  let slices = 0;
  let done = false;
  const queue = createWildlifeWorkQueue({
    requestIdle(fn) {
      callbacks.set(++id, fn);
      return id;
    },
    cancelIdle(handle) {
      callbacks.delete(handle);
    },
    now: () => 0,
    onSlice({ units }) {
      assert.ok(units <= 8);
      slices++;
    },
  });
  function* work() {
    for (let i = 0; i < 20; i++) yield 'bucket';
    return 42;
  }
  queue.start(work(), (result) => {
    assert.equal(result, 42);
    done = true;
  });
  assert.equal(done, false);
  while (callbacks.size) {
    const [handle, fn] = callbacks.entries().next().value;
    callbacks.delete(handle);
    fn();
  }
  assert.equal(done, true);
  assert.equal(slices, 3);
  assert.equal(queue.pending, false);
});

test('returning to a previous camera after partially applying a billboard delta still reconciles the collection', (t) => {
  // Slices end after eight units or 1 ms. A clock that advances 2 ms per read
  // makes every slice one unit, so the half-applied delta is observable.
  let clock = 0;
  t.mock.method(performance, 'now', () => (clock += 2));
  const h = denseContinentalRendering();
  try {
    h.moveEnd(0);
    h.flush();
    const originalIds = [...h.state.pointById.keys()].sort();
    const membership = () => [...h.state.pointById.keys()].sort();
    h.moveEnd(12);
    // Advance just until real billboard mutations begin, then supersede the
    // partially applied view by returning to the original camera.
    for (let i = 0; i < 5000; i++) {
      h.flush(1);
      if (JSON.stringify(membership()) !== JSON.stringify(originalIds)) break;
    }
    assert.notDeepEqual(membership(), originalIds);
    h.moveEnd(0);
    h.flush();
    assert.deepEqual(membership(), originalIds);
  } finally {
    h.destroy();
  }
});
