import assert from 'node:assert/strict';
import test from 'node:test';
import { createEarthquakesLayer } from './index.js';
import { createUsgsEarthquakeSource } from './source.js';
import { EARTHQUAKE_MARK_MAGNITUDE, earthquakeMarkLabel } from './model.js';
import { worldClock } from '../../time/worldClock.js';
function harness(source) {
  const sources = [];
  const events = [];
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createEarthquakesLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events };
}
const row = {
  stableId: 'event-a',
  usgsId: 'event-a',
  lon: 30,
  lat: 20,
  depthKm: 3,
  mag: 4,
  place: 'Fixture',
  time: 1000,
};
test('late refresh cannot publish after disable, re-enable, or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});
test('two displays own separate data sources and destruction', async () => {
  const a = harness({ getSnapshot: async () => [row] });
  const b = harness({ getSnapshot: async () => [] });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  b.layer.destroy();
});
test('USGS body completion honors cancellation even with an uncooperative transport', async () => {
  const abort = new AbortController();
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { features: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
test('the timeline marks only strong quakes, while the layer is on', async () => {
  assert.equal(EARTHQUAKE_MARK_MAGNITUDE, 6);
  const rows = [
    { ...row, stableId: 'small', mag: 4.5, time: 1_000 },
    { ...row, stableId: 'strong', usgsId: 'us-strong', mag: 6, time: 5_000 },
    {
      ...row,
      stableId: 'great',
      usgsId: 'us-great',
      mag: 7.2,
      place: '  113 km  SSE of Lata, Solomon Islands region of the Pacific ',
      time: 3_000,
    },
    { ...row, stableId: 'untimed', mag: 6.5, time: null },
  ];
  let snapshot = rows;
  const h = harness({ getSnapshot: async () => snapshot });
  assert.equal(worldClock.coverage(), null, 'nothing loaded, no time to show');
  let changes = 0;
  const unsubscribe = worldClock.subscribe(() => changes++);
  await h.layer.update(h.viewer);
  // Every quake is drawn; only M6 and up are marks, spanning their own time.
  assert.equal(h.sources[0].entities.values.length, 4);
  // Each labelled with its magnitude and, cut short, its place.
  assert.deepEqual(worldClock.coverage(), {
    start: 3_000,
    end: 5_000,
    marks: [3_000, 5_000],
    markDetails: [
      {
        time: 3_000,
        label: 'M7.2 · 113 km SSE of Lata, Solomon Islands reg…',
        id: 'us-great',
        kind: 'earthquake',
      },
      {
        time: 5_000,
        label: 'M6.0 · Fixture',
        id: 'us-strong',
        kind: 'earthquake',
      },
    ],
  });
  const told = changes;
  await h.layer.update(h.viewer);
  assert.equal(changes, told, 'the same strong quakes are not told again');
  snapshot = rows.slice(0, 1);
  await h.layer.update(h.viewer);
  assert.equal(worldClock.coverage(), null, 'small shakes alone cover no time');
  snapshot = rows;
  await h.layer.update(h.viewer);
  h.layer.disable(h.viewer);
  assert.equal(worldClock.coverage(), null, 'off, no time to show');
  h.layer.enable(h.viewer);
  assert.deepEqual(worldClock.coverage().marks, [3_000, 5_000]);
  h.layer.destroy();
  assert.equal(worldClock.coverage(), null);
  unsubscribe();
});

test('a strong quake with no place is labelled with its magnitude alone', () => {
  assert.equal(earthquakeMarkLabel({ mag: 6.44, place: null }), 'M6.4');
  assert.equal(earthquakeMarkLabel({ mag: 6, place: '   ' }), 'M6.0');
  assert.equal(
    earthquakeMarkLabel({ mag: 8.1, place: 'Off the coast' }),
    'M8.1 · Off the coast',
  );
});
