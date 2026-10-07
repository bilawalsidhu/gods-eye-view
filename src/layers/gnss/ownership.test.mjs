import assert from 'node:assert/strict';
import test from 'node:test';
import { createGnssIntegrityLayer } from './index.js';

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
  { anchor: initialAnchor = { latitude: 50, longitude: 30 } } = {},
) {
  let anchor = initialAnchor;
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
  const layer = createGnssIntegrityLayer({
    // The real source refuses an undated snapshot; stubs default to a fresh one.
    source: {
      async getSnapshot(...args) {
        const snapshot = await getSnapshot(...args);
        return { ageMs: 0, ...snapshot };
      },
    },
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
    now: () => clock,
    setAnchor(value) {
      anchor = value;
    },
  };
}

const MIN = 60_000;
const threeHealthy = () => [
  row('a1', 1.1, false),
  row('a2', 1.2, false),
  row('a3', 1.3, false),
];

test('the layer requires a snapshot source and cannot be initialized twice', () => {
  assert.throws(() => createGnssIntegrityLayer({}), TypeError);
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

test('the visible layer leads with low navigation accuracy and exposes its provenance', async () => {
  const { layer } = harness(async () => ({ rows: [], stale: false }));
  assert.equal(layer.id, 'gnss-interference', 'the share-link id is unchanged');
  assert.equal(layer.name, 'GNSS Integrity');
  assert.doesNotMatch(layer.name, /interference|jamming/i);
  const { legend } = layer.getRowControls();
  assert.deepEqual(
    legend.map(({ label }) => label),
    ['Over 10% low accuracy', '2–10% low accuracy', 'Under 2% low accuracy'],
  );
  const { blurb } = legend[0];
  assert.match(
    blurb,
    /^Share of ADS-B aircraft reporting low navigation accuracy/,
  );
  assert.match(blurb, /NIC < 7 or NACp < 8/);
  assert.match(blurb, /GEV threshold/);
  assert.match(blurb, /not a published interference test/);
  assert.match(blurb, /gpsjam\.org's formula and 2% \/ 10% bands/);
  assert.match(blurb, /navigation-integrity anomalies/);
  // Interference appears only as the secondary, hedged reading.
  assert.ok(
    blurb.indexOf('navigation-integrity anomalies') <
      blurb.indexOf('Suspected jamming or spoofing'),
  );
  assert.equal(layer.provenance.classifier.id, 'gev-nic-nacp-v1');
  assert.equal(layer.provenance.classifier.definedBy, 'GEV');
  assert.equal(layer.provenance.classifier.validated, false);
  assert.equal(layer.provenance.aggregation.source, 'https://gpsjam.org/faq');
  assert.deepEqual(layer.provenance.window, {
    minutes: 30,
    scope: 'visited-view',
    cellDeg: 0.5,
    minAircraft: 3,
    definedBy: 'GEV',
  });
  assert.equal(layer.provenance.interpretation.validated, false);
  assert.equal(layer.getStats().provenance, layer.provenance);
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

test('a replayed stale snapshot keeps its observation age and expires on time', async () => {
  // The proxy keeps answering with the snapshot it observed at t=1000.
  const { layer, sources, advance, now } = harness(async () => ({
    rows: threeHealthy(),
    ageMs: now() - 1_000,
    stale: true,
  }));
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  advance(29 * MIN);
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  advance(2 * MIN);
  assert.equal(
    await layer.update(),
    true,
    'the replay is not an error, only no evidence',
  );
  assert.equal(
    layer.getStats().count,
    0,
    'the replay did not restart the window',
  );
  assert.equal(sources[0].entities.values.length, 0);
});

test('cells expire during prolonged fetch failures', async () => {
  let fail = false;
  const { layer, sources, advance } = harness(async () => {
    if (fail) throw new Error('adsb.lol HTTP 502');
    return { rows: threeHealthy() };
  });
  layer.enable();
  await layer.update();
  fail = true;
  advance(20 * MIN);
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().count, 1, 'still inside the window');
  advance(11 * MIN);
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().count, 0);
  assert.equal(sources[0].entities.values.length, 0);
  assert.equal(layer.getStats().error, 'adsb.lol HTTP 502');
});

test('cells expire while no view anchor is available', async () => {
  let calls = 0;
  const { layer, sources, advance, setAnchor } = harness(async () => {
    calls += 1;
    return { rows: threeHealthy() };
  });
  layer.enable();
  await layer.update();
  setAnchor(null);
  advance(20 * MIN);
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  advance(11 * MIN);
  assert.equal(await layer.update(), true);
  assert.equal(calls, 1, 'no anchor means no request');
  assert.equal(layer.getStats().count, 0);
  assert.equal(sources[0].entities.values.length, 0);
  assert.equal(layer.getStats().error, null);
});

test('re-enabling after a long disable does not show cells past the window', async () => {
  const { layer, sources, advance } = harness(async () => ({
    rows: threeHealthy(),
  }));
  layer.enable();
  await layer.update();
  assert.equal(sources[0].entities.values.length, 1);
  layer.disable();
  advance(31 * MIN);
  layer.enable();
  assert.equal(layer.getStats().count, 0);
  assert.equal(sources[0].entities.values.length, 0);
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
