import test from 'node:test';
import assert from 'node:assert/strict';
import { createCableSessionLayer } from './session.js';

test('cables arriving during handoff belong to the incoming display', async () => {
  let resolve,
    reads = 0;
  const shown = [];
  const layer = createCableSessionLayer({
    source: {
      label: 'fixture',
      fetch: () => {
        reads++;
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
    createDisplay: (engine) => ({
      show: (dataset) => shown.push([engine, dataset]),
      destroy() {},
      hide() {},
    }),
  });
  layer.init(null, { engine: 'outgoing' });
  const pending = layer.enable();
  layer.detachRenderer();
  const handoff = layer.attachRenderer({ engine: 'incoming' });
  const dataset = { cables: { features: [] }, landingPoints: { features: [] } };
  resolve(dataset);
  await Promise.all([pending, handoff]);
  assert.deepEqual(shown, [['incoming', dataset]]);
  assert.equal(reads, 1);
  layer.destroy();
});

test('a released scene stops waiting for a stalled cable load, which stays in the session', async () => {
  let resolve;
  const shown = [];
  const layer = createCableSessionLayer({
    source: {
      label: 'fixture',
      fetch: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    createDisplay: (engine) => ({
      show: (dataset) => shown.push([engine, dataset]),
      destroy() {},
      hide() {},
    }),
  });
  layer.init(null, { engine: 'outgoing' });
  const pending = layer.enable();
  layer.detachRenderer();
  const scene = new AbortController();
  const attaching = layer.attachRenderer({
    engine: 'released',
    signal: scene.signal,
  });
  scene.abort();
  await attaching;
  layer.detachRenderer();
  const dataset = { cables: { features: [] }, landingPoints: { features: [] } };
  resolve(dataset);
  await pending;
  assert.deepEqual(shown, []);
  await layer.attachRenderer({ engine: 'next' });
  assert.deepEqual(shown, [['next', dataset]]);
  layer.destroy();
});

function deferredSource() {
  const fetches = [];
  return {
    fetches,
    source: {
      label: 'fixture',
      fetch(signal) {
        return new Promise((resolve, reject) => {
          const entry = { signal, resolve };
          fetches.push(entry);
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      },
    },
  };
}

function recordingDisplay(log) {
  return (engine) => ({
    show: (dataset) => log.push(['show', engine, dataset]),
    hide: () => log.push(['hide', engine]),
    destroy: () => log.push(['destroy', engine]),
    stats: () => ({ referenceLabelCount: 7 }),
  });
}

const DATASET = {
  cables: { features: [{}, {}] },
  landingPoints: { features: [{}] },
};

test('a disable during a load aborts it; the next enable loads once and shows once', async () => {
  const { source, fetches } = deferredSource();
  const log = [];
  const layer = createCableSessionLayer({
    source,
    createDisplay: recordingDisplay(log),
  });
  layer.init(null, { engine: 'globe' });
  const first = layer.enable();
  layer.disable();
  assert.equal(fetches[0].signal.aborted, true);
  const second = layer.enable();
  // The aborted load's late answer changes nothing.
  fetches[0].resolve(DATASET);
  await first;
  assert.equal(fetches.length, 2);
  void layer.update();
  assert.equal(fetches.length, 2, 'an update joins the load in flight');
  fetches[1].resolve(DATASET);
  await second;
  assert.deepEqual(log, [
    ['hide', 'globe'],
    ['show', 'globe', DATASET],
  ]);
  assert.equal(layer.getStats().error, null);
  layer.destroy();
});

test('a toggle-off hides the display and a toggle-on shows the dataset again without refetching', async () => {
  const { source, fetches } = deferredSource();
  const log = [];
  const layer = createCableSessionLayer({
    source,
    createDisplay: recordingDisplay(log),
  });
  layer.init(null, { engine: 'globe' });
  const loading = layer.enable();
  assert.equal(layer.getStats().loading, true);
  fetches[0].resolve(DATASET);
  await loading;
  const stats = layer.getStats();
  assert.equal(stats.count, 3);
  assert.equal(stats.referenceLabelCount, 7, "the display's stats");
  assert.equal(stats.loading, false);
  layer.disable();
  assert.equal(layer.getStats().count, 0);
  await layer.enable();
  assert.equal(fetches.length, 1, 'the dataset is kept for the session');
  assert.deepEqual(log, [
    ['show', 'globe', DATASET],
    ['hide', 'globe'],
    ['show', 'globe', DATASET],
  ]);
  layer.destroy();
  assert.deepEqual(log.slice(-2), [
    ['hide', 'globe'],
    ['destroy', 'globe'],
  ]);
});

test('a failed load reports its error, and a dataset without both collections is refused', async () => {
  const layer = createCableSessionLayer({
    source: { label: 'fixture', fetch: async () => ({ cables: {} }) },
    createDisplay: recordingDisplay([]),
  });
  layer.init(null, { engine: 'globe' });
  await layer.enable();
  assert.equal(layer.getStats().error, 'Invalid submarine cable dataset');
  layer.destroy();
  const silent = createCableSessionLayer({
    source: {
      label: 'fixture',
      fetch: async () => {
        throw new Error('');
      },
    },
    createDisplay: recordingDisplay([]),
  });
  silent.init(null, { engine: 'globe' });
  await silent.enable();
  assert.equal(silent.getStats().error, 'TeleGeography load failed');
  silent.destroy();
});
