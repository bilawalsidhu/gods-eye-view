import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSondeRenderModel } from './renderModel.js';
import { MAX_SONDES_RENDERED } from './policy.js';

const NOW_MS = 1_800_000_000_000;
// Deterministic assertions always run, including in npm test. Wall-clock
// budgets are opt-in because parallel test files compete for CPU time.
const PERF_BUDGETS = process.env.GEV_PERF_BUDGETS === '1';
const PERF_SKIP =
  'Wall-clock budgets skipped; run npm run test:perf (GEV_PERF_BUDGETS=1) in isolation';
// Timings exclude fixture construction; when enabled, even the slowest of ten
// warmed incremental refreshes must meet the budget.
// The normal 2,000-contact cap has 8 ms of the event-driven update budget.
const INCREMENTAL_UPDATE_BUDGET_MS = Object.freeze({
  500: 4,
  2000: 8,
  5000: 20,
});
const INITIAL_BUILD_BUDGET_MS = Object.freeze({ 500: 8, 2000: 16, 5000: 40 });
const BENCHMARK_REFRESHES = 10;
const BILLBOARD_WRITES_PER_UPDATE = 5;

function record(serial, patch = {}, phase = 'ascending') {
  return {
    frame: {
      serial,
      lat: 30,
      lon: -90,
      altM: 23_000,
      timeMs: NOW_MS,
      receivedMs: NOW_MS,
      tempC: -50,
      ...patch,
    },
    phase,
    track: [],
  };
}

const recordsMap = (records) =>
  new Map(records.map((value) => [value.frame.serial, value]));
const cloneRecords = (records) =>
  new Map(
    [...records].map(([id, value]) => [
      id,
      { ...value, frame: { ...value.frame } },
    ]),
  );

class FakeBillboard {
  constructor(counters) {
    this.counters = counters;
  }
  set position(value) {
    this.counters.writes++;
    this._position = value;
  }
  get position() {
    return this._position;
  }
  set image(value) {
    this.counters.writes++;
    this._image = value;
  }
  get image() {
    return this._image;
  }
  set color(value) {
    this.counters.writes++;
    this._color = value;
  }
  set scale(value) {
    this.counters.writes++;
    this._scale = value;
  }
  set show(value) {
    this.counters.writes++;
    this._show = value;
  }
}

function harness(cap) {
  const counters = { collections: 1, creates: 0, removes: 0, writes: 0 };
  const collection = new Set();
  const model = createSondeRenderModel({
    ...(cap === undefined ? {} : { cap }),
    create() {
      counters.creates++;
      const sprite = new FakeBillboard(counters);
      collection.add(sprite);
      return { sprite };
    },
    update(mark, value, selected) {
      assert.equal(mark.frame, value.frame);
      assert.equal(mark.phase, value.phase);
      assert.equal(mark.selected, selected);
      mark.sprite.position = [
        value.frame.lat,
        value.frame.lon,
        value.frame.altM,
      ];
      mark.sprite.image = mark.phase;
      mark.sprite.color = value.phase;
      mark.sprite.scale = selected ? 1.5 : 1;
      mark.sprite.show = true;
    },
    remove(mark) {
      counters.removes++;
      assert.ok(collection.delete(mark.sprite));
    },
  });
  return { model, collection, counters };
}

test('new contacts create once; equal-content clones refresh metadata with zero billboard writes', () => {
  const { model, counters, collection } = harness();
  const records = recordsMap([record('TEST456')]);
  assert.deepEqual(model.sync(records, null), {
    rendered: 1,
    total: 1,
    creates: 1,
    updates: 1,
    removes: 0,
    changed: true,
  });
  const mark = model.marks.get('TEST456');
  const writes = counters.writes;
  assert.equal(writes, BILLBOARD_WRITES_PER_UPDATE);
  const cloned = cloneRecords(records);
  assert.deepEqual(model.sync(cloned, null), {
    rendered: 1,
    total: 1,
    creates: 0,
    updates: 0,
    removes: 0,
    changed: false,
  });
  assert.equal(model.marks.get('TEST456'), mark);
  assert.equal(mark.frame, cloned.get('TEST456').frame);
  assert.equal(counters.writes, writes);
  assert.equal(collection.size, 1);

  const next = record('TEST456', {
    timeMs: NOW_MS + 1000,
    receivedMs: NOW_MS + 2000,
    tempC: -55,
    vVelMps: 5.5,
    frequencyMhz: 403.5,
  });
  assert.equal(model.sync(recordsMap([next]), null).changed, false);
  assert.equal(mark.frame, next.frame);
  assert.equal(mark.frame.tempC, -55);
  assert.equal(counters.writes, writes);
});

test('geometry signatures detect every position component, including frames mutated in place', () => {
  const { model, counters } = harness();
  const value = record('TEST456');
  const records = recordsMap([value]);
  model.sync(records, null);
  const mark = model.marks.get(value.frame.serial);
  for (const [field, next] of [
    ['lat', 31],
    ['lon', -89],
    ['altM', 24_000],
  ]) {
    value.frame[field] = next;
    assert.equal(model.sync(records, null).updates, 1, field);
    assert.deepEqual(mark.sprite.position, [
      value.frame.lat,
      value.frame.lon,
      value.frame.altM,
    ]);
  }
  assert.equal(counters.creates, 1);
  assert.equal(counters.removes, 0);
  assert.equal(counters.writes, 4 * BILLBOARD_WRITES_PER_UPDATE);
});

test('selection, phase and style revisions update retained sprites and preserve phase symbols', () => {
  const { model, counters } = harness();
  const records = recordsMap([record('AAA'), record('BBB')]);
  model.sync(records, null);
  assert.equal(model.sync(records, 'AAA').updates, 1);
  assert.equal(model.marks.get('AAA').sprite.image, 'ascending');
  assert.equal(model.sync(records, 'BBB').updates, 2);
  assert.equal(model.marks.get('AAA').sprite.image, 'ascending');
  assert.equal(model.marks.get('BBB').sprite.image, 'ascending');

  for (const phase of [
    'descending',
    'unknown',
    'landed',
    'landed-inferred',
    'signal-lost',
  ]) {
    records.get('BBB').phase = phase;
    assert.equal(model.sync(records, 'BBB').updates, 1, phase);
    assert.equal(model.marks.get('BBB').sprite.image, phase, phase);
  }
  assert.equal(model.sync(records, 'BBB', 'geoid:1/style:mono').updates, 2);
  assert.equal(model.sync(records, 'BBB', 'geoid:1/style:mono').updates, 0);
  assert.equal(counters.creates, 2);
  assert.equal(counters.removes, 0);
});

test('cap ranks selection first, then aloft, newest fix and serial; membership removes only the delta', () => {
  const { model, counters } = harness(3);
  const records = recordsMap([
    record('LANDED', { timeMs: NOW_MS + 10_000 }, 'landed'),
    record('LOST', { timeMs: NOW_MS - 9_000_000 }, 'signal-lost'),
    record('OLD', { timeMs: NOW_MS - 1000 }),
    record('CCC', {}, 'unknown'),
    record('DDD', {}, 'descending'),
    record('BBB'),
  ]);
  assert.deepEqual(model.sync(records, 'LOST'), {
    rendered: 3,
    total: 6,
    creates: 3,
    updates: 3,
    removes: 0,
    changed: true,
  });
  assert.deepEqual([...model.marks.keys()], ['LOST', 'BBB', 'CCC']);
  const retained = model.marks.get('BBB');
  assert.deepEqual(model.sync(records, null), {
    rendered: 3,
    total: 6,
    creates: 1,
    updates: 1,
    removes: 1,
    changed: true,
  });
  assert.deepEqual([...model.marks.keys()].sort(), ['BBB', 'CCC', 'DDD']);
  assert.equal(model.marks.get('BBB'), retained);

  const fresher = cloneRecords(records);
  fresher.get('OLD').frame.timeMs = NOW_MS + 1;
  assert.deepEqual(model.sync(fresher, null), {
    rendered: 3,
    total: 6,
    creates: 1,
    updates: 1,
    removes: 1,
    changed: true,
  });
  assert.deepEqual([...model.marks.keys()].sort(), ['BBB', 'CCC', 'OLD']);
  assert.equal(counters.creates, 5);
  assert.equal(counters.removes, 2);
});

test('old landed and lost contacts stay in the model; default population uses the named cap', () => {
  const { model } = harness();
  const values = Array.from({ length: MAX_SONDES_RENDERED + 1 }, (_, i) =>
    record(
      `V${String(i).padStart(7, '0')}`,
      { timeMs: NOW_MS - 2 * 60 * 60_000 },
      i % 2 ? 'landed-inferred' : 'signal-lost',
    ),
  );
  const result = model.sync(recordsMap(values), null);
  assert.equal(result.total, MAX_SONDES_RENDERED + 1);
  assert.equal(result.rendered, MAX_SONDES_RENDERED);
  assert.ok(
    [...model.marks.values()].some((mark) =>
      ['landed', 'landed-inferred'].includes(mark.phase),
    ),
  );
  assert.ok(
    [...model.marks.values()].some((mark) => mark.phase === 'signal-lost'),
  );
});

test('empty snapshots and clear remove only owned marks and retain the map and adapter population', () => {
  const { model, counters, collection } = harness();
  const marks = model.marks;
  model.sync(recordsMap([record('AAA'), record('BBB')]), null);
  assert.deepEqual(model.sync(new Map(), null), {
    rendered: 0,
    total: 0,
    creates: 0,
    updates: 0,
    removes: 2,
    changed: true,
  });
  assert.equal(model.sync(new Map(), null).changed, false);
  model.sync(recordsMap([record('CCC')]), null);
  model.clear();
  model.clear();
  assert.equal(model.marks, marks);
  assert.equal(model.marks.size, 0);
  assert.equal(collection.size, 0);
  assert.equal(counters.collections, 1);
  assert.equal(counters.creates, 3);
  assert.equal(counters.removes, 3);
});

function benchmarkFixtures(count) {
  const initial = recordsMap(
    Array.from({ length: count }, (_, i) =>
      record(`V${String(i).padStart(7, '0')}`, {
        lat: -70 + (i % 140),
        lon: -170 + (i % 340),
        altM: 1000 + i,
        timeMs: NOW_MS + (i % 37),
      }),
    ),
  );
  const changes = count / 10;
  const batches = [];
  let previous = initial;
  for (let round = 0; round < BENCHMARK_REFRESHES; round++) {
    const next = new Map(previous);
    for (let i = round * changes; i < (round + 1) * changes; i++) {
      const serial = `V${String(i).padStart(7, '0')}`;
      const value = next.get(serial);
      next.set(serial, {
        ...value,
        frame: { ...value.frame, altM: value.frame.altM + 1 },
      });
    }
    batches.push(next);
    previous = next;
  }
  return { initial, batches, changes };
}

test('ten refreshes replacing 10% of identities create and remove exactly that delta', (t) => {
  for (const count of [500, 2000, 5000]) {
    const { model, counters, collection } = harness(count);
    const { initial, changes } = benchmarkFixtures(count);
    let values = initial;
    model.sync(values, null);
    for (let round = 0; round < BENCHMARK_REFRESHES; round++) {
      values = new Map(values);
      for (const id of [...values.keys()].slice(0, changes)) values.delete(id);
      for (let i = 0; i < changes; i++) {
        const value = record(`R${round}_${i}`);
        values.set(value.frame.serial, value);
      }
      const result = model.sync(values, null);
      assert.equal(result.creates, changes);
      assert.equal(result.removes, changes);
      assert.equal(result.updates, changes);
      assert.equal(collection.size, count);
      assert.equal(counters.collections, 1);
    }
    assert.equal(counters.creates - count, BENCHMARK_REFRESHES * changes);
    assert.equal(counters.removes, BENCHMARK_REFRESHES * changes);
    t.diagnostic(
      `N=${count}; ten 10% membership refreshes: incremental creates/removes=${counters.creates - count}/${counters.removes}; retained collection count=1`,
    );
  }
});

test('render-model benchmark: 500, 2,000 and 5,000 contacts reuse billboards across ten 10% refreshes', async (t) => {
  for (const count of [500, 2000, 5000]) {
    const { initial, batches, changes } = benchmarkFixtures(count);
    const warm = harness(count);
    for (let pass = 0; pass < 3; pass++) {
      warm.model.sync(initial, null);
      for (const batch of batches) warm.model.sync(batch, null);
    }
    warm.model.clear();

    const { model, counters, collection } = harness(count);
    const buildStarted = performance.now();
    model.sync(initial, null);
    const buildMs = performance.now() - buildStarted;
    const firstSprite = model.marks.get('V0000000').sprite;
    const durations = [];
    for (const batch of batches) {
      const started = performance.now();
      const result = model.sync(batch, null);
      durations.push(performance.now() - started);
      assert.equal(result.creates, 0);
      assert.equal(result.removes, 0);
      assert.equal(result.updates, changes);
    }
    assert.equal(model.marks.get('V0000000').sprite, firstSprite);
    assert.equal(counters.collections, 1);
    assert.equal(counters.creates, count);
    assert.equal(counters.removes, 0);
    assert.equal(collection.size, count);
    assert.equal(
      counters.writes,
      (count + BENCHMARK_REFRESHES * changes) * BILLBOARD_WRITES_PER_UPDATE,
    );

    const writesBeforeUnchanged = counters.writes;
    const unchanged = model.sync(cloneRecords(batches.at(-1)), null);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.updates, 0);
    assert.equal(counters.writes, writesBeforeUnchanged);

    const replaced = new Map(batches.at(-1));
    for (let i = 0; i < changes; i++) {
      replaced.delete(`V${String(i).padStart(7, '0')}`);
      const value = record(`R${String(i).padStart(7, '0')}`);
      replaced.set(value.frame.serial, value);
    }
    const replacement = model.sync(replaced, null);
    assert.equal(replacement.creates, changes);
    assert.equal(replacement.removes, changes);
    assert.equal(replacement.updates, changes);
    assert.equal(counters.creates, count + changes);
    assert.equal(counters.removes, changes);
    assert.equal(counters.collections, 1);
    assert.equal(collection.size, count);

    const sorted = [...durations].sort((a, b) => a - b);
    const median = (sorted[4] + sorted[5]) / 2;
    const max = sorted.at(-1);
    const budget = INCREMENTAL_UPDATE_BUDGET_MS[count];
    t.diagnostic(
      `N=${count}; build=${buildMs.toFixed(3)} ms; 10% update median=${median.toFixed(3)} ms; max=${max.toFixed(3)} ms; budget=${budget} ms; ten-refresh creates=${count}, removes=0; replacement creates/removes=${changes}/${changes}; unchanged billboard writes=0`,
    );
    await t.test(
      `${count}-contact wall-clock budgets`,
      { skip: PERF_BUDGETS ? false : PERF_SKIP },
      () => {
        assert.ok(
          buildMs <= INITIAL_BUILD_BUDGET_MS[count],
          `${count}-contact initial build ${buildMs.toFixed(3)} ms exceeds ${INITIAL_BUILD_BUDGET_MS[count]} ms`,
        );
        assert.ok(
          max <= budget,
          `${count}-contact slowest update ${max.toFixed(3)} ms exceeds ${budget} ms`,
        );
      },
    );
  }
});
