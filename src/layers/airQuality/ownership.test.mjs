import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirQualityLayer } from './index.js';
import { createEcccAirQualitySource } from './source.js';

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
  const layer = createAirQualityLayer({
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

const reading = (id, value, overrides = {}) => ({
  id: `eccc:${id}`,
  provider: 'eccc',
  scale: 'AQHI',
  value,
  band: 'low',
  stationId: id,
  name: id,
  zone: 'ont',
  lat: 43.65,
  lon: -79.38,
  observedMs: 1_700_000_000_000,
  color: '#4cc9f0',
  label: String(value),
  risk: 'Low health risk',
  note: null,
  ...overrides,
});

const staticSource = (rows) => ({ getSnapshot: async () => rows });

test('a layer requires both a snapshot source and an overlay host', () => {
  assert.throws(() => createAirQualityLayer(), /snapshot source/);
  assert.throws(
    () => createAirQualityLayer({ source: staticSource([]) }),
    /overlay host/,
  );
});

test('initialization is single-use and owns exactly one data source', () => {
  const { layer, viewer, sources } = harness(staticSource([]));
  assert.equal(sources.length, 1);
  assert.throws(() => layer.init(viewer), /already initialized/);
  layer.destroy(viewer);
  assert.equal(sources.length, 0);
});

test('a refresh renders readings and publishes an overlay cohort', async () => {
  const { layer, events } = harness(
    staticSource([reading('A', 2), reading('B', 7)]),
  );
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getStats().error, null);
  assert.equal(events.at(-1)[0], 'air-quality');
});

// ── the abort + enabled guard ──────────────────────────────────────────────

test('a response landing after disable cannot redraw the scene', async () => {
  // The failure this prevents: disable() clears the overlay, then an in-flight
  // response resolves and repopulates it behind the user's back.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { layer, events } = harness({
    getSnapshot: async ({ signal } = {}) => {
      await gate;
      signal?.throwIfAborted();
      return [reading('A', 5)];
    },
  });
  const pending = layer.update();
  layer.disable();
  const publishedBefore = events.length;
  release();
  assert.equal(await pending, false, 'a late response must not be applied');
  assert.equal(
    events.length,
    publishedBefore,
    'no overlay write after disable',
  );
  assert.equal(layer.getStats().count, 0);
});

test('disable aborts the request in flight', async () => {
  let seenSignal = null;
  const { layer } = harness({
    getSnapshot: async ({ signal } = {}) => {
      seenSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 40));
      signal?.throwIfAborted();
      return [];
    },
  });
  const pending = layer.update();
  layer.disable();
  await pending;
  assert.ok(seenSignal, 'a signal was passed through to the source');
  assert.equal(seenSignal.aborted, true);
});

test('a superseded refresh does not clobber the newer one', async () => {
  let call = 0;
  const { layer } = harness({
    getSnapshot: async ({ signal } = {}) => {
      call += 1;
      const mine = call;
      await new Promise((resolve) => setTimeout(resolve, mine === 1 ? 40 : 1));
      signal?.throwIfAborted();
      return [reading(`call-${mine}`, mine)];
    },
  });
  const first = layer.update();
  const second = layer.update();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, false, 'the superseded call reports no update');
  assert.equal(secondResult, true);
  assert.equal(layer.getAnalystRecords()[0].name, 'call-2');
});

test('update is a no-op while the layer is disabled', async () => {
  const { layer } = harness(staticSource([reading('A', 2)]));
  layer.disable();
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().count, 0);
});

// ── readout descriptor ─────────────────────────────────────────────────────

test('the readout descriptor carries the band legend and coverage', async () => {
  const { layer } = harness(staticSource([reading('A', 2), reading('B', 9)]));
  await layer.update();
  const controls = layer.getRowControls();
  assert.equal(controls.readout, true);
  assert.match(controls.summary.coverage, /Canada only/);
  assert.equal(controls.legend.categorical, true);
  assert.deepEqual(controls.legend.labels, [
    'Low',
    'Moderate',
    'High',
    'Very High',
  ]);
  assert.equal(controls.legend.colors.length, controls.legend.labels.length);
  // Worst first, and every item keyed.
  assert.deepEqual(
    controls.list.items.map((i) => i.label),
    ['B', 'A'],
  );
  assert.ok(controls.list.items.every((i) => i.id));
  assert.match(controls.summary.status, /2 stations reporting/);
});

test('the readout reports an error rather than a silent empty card', async () => {
  const { layer } = harness({
    getSnapshot: async () => {
      throw new Error('ECCC HTTP 503');
    },
  });
  await layer.update();
  assert.match(layer.getRowControls().summary.status, /503/);
});

test('row-control listeners are notified on refresh and teardown-safe', async () => {
  const { layer, viewer } = harness(staticSource([reading('A', 2)]));
  let calls = 0;
  layer.setRowControlsListener(() => {
    calls += 1;
  });
  await layer.update();
  assert.ok(calls >= 1, 'a refresh notifies the card');
  layer.destroy(viewer);
  const after = calls;
  layer.setRowControlsListener(() => {
    calls += 1;
  });
  assert.equal(calls, after);
});

// ── source contract ────────────────────────────────────────────────────────

test('the source rejects a malformed station catalog and surfaces HTTP errors', async () => {
  await assert.rejects(
    () =>
      createEcccAirQualitySource({
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ features: 'no' }),
        }),
      }).getSnapshot(),
    /Malformed AQHI station/,
  );
  await assert.rejects(
    () =>
      createEcccAirQualitySource({
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          json: async () => ({}),
        }),
      }).getSnapshot(),
    /ECCC HTTP 503/,
  );
});

test('the station catalog is cached and observations ask for latest values only', async () => {
  const urls = [];
  const source = createEcccAirQualitySource({
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () =>
          url.includes('aqhi-stations')
            ? {
                features: [
                  {
                    geometry: { type: 'Point', coordinates: [-79.38, 43.65] },
                    properties: { location_id: 'A', location_name_en: 'A' },
                  },
                ],
              }
            : { features: [] },
      };
    },
    now: () => 1_700_000_000_000,
  });
  await source.getSnapshot();
  await source.getSnapshot();
  assert.equal(urls.filter((u) => u.includes('aqhi-stations')).length, 1);
  // Without latest=true the collection returns the full history (~2,000 rows).
  assert.match(
    urls.find((u) => u.includes('observations')),
    /latest=true/,
  );
});
