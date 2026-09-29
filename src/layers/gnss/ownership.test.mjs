import assert from 'node:assert/strict';
import test from 'node:test';
import { createGnssInterferenceLayer } from './index.js';

const row = (hex, lat, degraded) => ({
  hex,
  lat,
  lon: 30.2,
  nic: degraded ? 0 : 8,
  nacp: degraded ? 0 : 10,
  gpsLost: false,
  degraded,
});

function harness(
  getSnapshot,
  { anchor = { latitude: 50, longitude: 30 } } = {},
) {
  const sources = [];
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
  let clock = 1_000;
  const anchors = [];
  const layer = createGnssInterferenceLayer({
    source: { getSnapshot },
    viewAnchor: () => {
      anchors.push(anchor);
      return anchor;
    },
    now: () => clock,
  });
  layer.init(viewer);
  return {
    layer,
    sources,
    anchors,
    advance(ms) {
      clock += ms;
    },
  };
}

test('the layer requires a snapshot source and cannot be initialized twice', () => {
  assert.throws(() => createGnssInterferenceLayer({}), TypeError);
  const { layer } = harness(async () => ({ rows: [] }));
  assert.throws(() => layer.init({ dataSources: { add() {} } }), /already/);
});

test('an enabled refresh bins the snapshot into coloured ground cells', async () => {
  const { layer, sources, anchors } = harness(async (anchor, { signal }) => {
    assert.deepEqual(anchor, { latitude: 50, longitude: 30 });
    assert.ok(signal instanceof AbortSignal);
    return {
      rows: [
        row('a1', 50.1, true),
        row('a2', 50.1, true),
        row('a3', 50.2, false),
        row('a4', 50.3, false),
        row('b1', 55.1, false),
      ],
      stale: false,
    };
  });
  assert.equal(await layer.update(), false, 'disabled layers do not fetch');
  assert.equal(anchors.length, 0);
  layer.enable();
  assert.equal(sources[0].show, true);
  assert.equal(await layer.update(), true);
  const entities = sources[0].entities.values;
  assert.equal(entities.length, 1, 'the one-aircraft cell is withheld');
  assert.equal(entities[0].id, 'gnss-interference:280:420');
  assert.ok(entities[0].rectangle);
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.error, null);
  assert.equal(stats.fallback, false);
  const { legend } = layer.getRowControls();
  assert.deepEqual(
    legend.map(({ count }) => count),
    [1, 0, 0],
  );
  assert.match(legend[0].blurb, /not a detection/);
  assert.match(legend[0].blurb, /fewer than 3 aircraft are not drawn/);
});

test('a failed refresh keeps the last cells and reports the error', async () => {
  let fail = false;
  const { layer, sources } = harness(async () => {
    if (fail) throw new Error('adsb.lol HTTP 502');
    return {
      rows: [
        row('a1', 1.1, false),
        row('a2', 1.2, false),
        row('a3', 1.3, false),
      ],
      stale: true,
    };
  });
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(sources[0].entities.values.length, 1);
  assert.equal(layer.getStats().error, 'adsb.lol HTTP 502');
  assert.equal(layer.getStats().count, 1);
});

test('observations expire with the window, and disable aborts the request in flight', async () => {
  let pending;
  const { layer, sources, advance } = harness(
    (anchor, { signal }) =>
      new Promise((resolve, reject) => {
        pending = { resolve };
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  );
  layer.enable();
  let result = layer.update();
  pending.resolve({
    rows: [row('a1', 1.1, false), row('a2', 1.2, false), row('a3', 1.3, false)],
  });
  assert.equal(await result, true);
  assert.equal(layer.getStats().count, 1);

  advance(31 * 60_000);
  result = layer.update();
  pending.resolve({ rows: [] });
  assert.equal(await result, true);
  assert.equal(layer.getStats().count, 0);
  assert.equal(sources[0].entities.values.length, 0);

  result = layer.update();
  layer.disable();
  assert.equal(await result, false);
  assert.equal(sources[0].show, false);
});

test('no view anchor means no request, and destroy releases the data source', async () => {
  let calls = 0;
  const { layer, sources } = harness(
    async () => {
      calls += 1;
      return { rows: [] };
    },
    { anchor: null },
  );
  layer.enable();
  assert.equal(
    await layer.update(),
    true,
    'a settling camera is not a failure',
  );
  assert.equal(calls, 0);
  assert.equal(layer.getStats().error, null);
  layer.destroy();
  assert.equal(sources.length, 0);
  assert.equal(layer.getStats().count, 0);
});

const threeCells = () => ({
  rows: [row('a1', 50.1, true), row('a2', 50.1, true), row('a3', 50.2, false)],
});

test('an identical snapshot leaves the drawn entities untouched', async () => {
  const { layer, sources } = harness(async () => threeCells());
  layer.enable();
  await layer.update();
  const [first] = sources[0].entities.values;
  await layer.update();
  assert.equal(sources[0].entities.values.length, 1);
  assert.equal(sources[0].entities.values[0], first);
});
