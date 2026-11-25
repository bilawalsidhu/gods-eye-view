import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFireballSource,
  createFireballsLayer,
  describeFireball,
  fireballAgeBand,
  fireballMarkerSize,
  normalizeFireballs,
  parseFireballTime,
} from './index.js';

const FIELDS = [
  'date',
  'energy',
  'impact-e',
  'lat',
  'lat-dir',
  'lon',
  'lon-dir',
  'alt',
  'vel',
];
const PAYLOAD = {
  signature: { source: 'NASA/JPL Fireball Data API', version: '1.2' },
  count: '4',
  fields: FIELDS,
  data: [
    [
      '2026-10-04 03:14:45',
      '5.4',
      '0.18',
      '41.8',
      'S',
      '173.1',
      'W',
      '26.9',
      '13.8',
    ],
    [
      '2026-11-20 11:26:13',
      '2.2',
      '0.079',
      '37.6',
      'N',
      '161.6',
      'E',
      null,
      null,
    ],
    // No position: dropped.
    ['2026-09-11 10:18:03', '6.1', '0.2', null, null, null, null, null, null],
    [
      '2013-02-15 03:20:33',
      '375000',
      '440',
      '54.8',
      'N',
      '61.1',
      'E',
      '23.3',
      '18.6',
    ],
  ],
};
const NOW = Date.parse('2026-11-24T16:00:00Z');

test('the CNEOS table becomes signed, dated events, newest first', () => {
  const rows = normalizeFireballs(PAYLOAD);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: '20261120112613',
    time: Date.parse('2026-11-20T11:26:13Z'),
    lat: 37.6,
    lon: 161.6,
    altKm: null,
    velocityKms: null,
    radiatedEnergy: 2.2,
    impactEnergyKt: 0.079,
  });
  assert.equal(rows[1].lat, -41.8);
  assert.equal(rows[1].lon, -173.1);
  assert.equal(rows[1].altKm, 26.9);
  assert.equal(rows[2].impactEnergyKt, 440);
  assert.equal(
    parseFireballTime('2026-10-04 03:14:45'),
    Date.parse('2026-10-04T03:14:45Z'),
  );
  assert.equal(parseFireballTime('yesterday'), null);
});

test('an empty answer is empty and anything else malformed is refused', () => {
  assert.deepEqual(normalizeFireballs({ signature: {}, count: '0' }), []);
  assert.equal(normalizeFireballs({}), null);
  assert.equal(normalizeFireballs({ fields: ['date'], data: [] }), null);
  assert.equal(normalizeFireballs({ fields: FIELDS, data: {} }), null);
});

test('age bands and marker sizes follow time and impact energy', () => {
  const [recent, older, chelyabinsk] = normalizeFireballs(PAYLOAD);
  assert.equal(fireballAgeBand(recent, NOW).id, 'month');
  assert.equal(fireballAgeBand(older, NOW).id, 'year');
  assert.equal(fireballAgeBand(chelyabinsk, NOW).id, 'older');
  assert.equal(fireballMarkerSize({ impactEnergyKt: null }), 14);
  assert.equal(fireballMarkerSize(recent), 14);
  assert.equal(fireballMarkerSize({ impactEnergyKt: 1 }), 20);
  assert.equal(fireballMarkerSize(chelyabinsk), 33);
  assert.equal(fireballMarkerSize({ impactEnergyKt: 1e9 }), 40);
});

test('the card names what JPL reports and leaves out what it does not', () => {
  const [recent, older] = normalizeFireballs(PAYLOAD);
  const full = describeFireball(older);
  assert.match(full.title, /^Fireball /);
  assert.match(full.title, /2026/);
  assert.deepEqual(full.details.slice(0, 1), ['41.8°S 173.1°W']);
  assert.ok(full.details.some((line) => /0\.18 kt TNT/.test(line)));
  assert.ok(full.details.some((line) => /26\.9 km/.test(line)));
  assert.ok(full.details.some((line) => /13\.8 km\/s/.test(line)));
  const sparse = describeFireball(recent);
  assert.ok(!sparse.details.some((line) => /km\/s|Peak/.test(line)));
});

test('the source reads the same-origin proxy and reports its failures', async () => {
  const ok = createFireballSource({
    fetchImpl: async (url) => {
      assert.equal(url, '/api/fireballs/events');
      return Response.json({ fetchedAt: 5, rows: [], stale: true });
    },
  });
  assert.deepEqual(await ok.getSnapshot(), {
    rows: [],
    fetchedAt: 5,
    stale: true,
  });
  const down = createFireballSource({
    fetchImpl: async () => Response.json({}, { status: 502 }),
  });
  await assert.rejects(
    down.getSnapshot(),
    (error) => error.message === 'JPL CNEOS HTTP 502' && error.retryable,
  );
  const odd = createFireballSource({
    fetchImpl: async () => Response.json({ rows: 'x' }),
  });
  await assert.rejects(odd.getSnapshot(), /Malformed JPL CNEOS response/);
});

function fakeScene() {
  const sets = [];
  const drawOf = () => ({
    icons(spec) {
      const set = {
        spec,
        items: [],
        show: spec.show,
        set(items) {
          this.items = items;
        },
        upsert(items) {
          for (const item of items) {
            const i = this.items.findIndex(({ id }) => id === item.id);
            if (i >= 0) this.items[i] = item;
          }
        },
        dispose() {
          this.disposed = true;
        },
      };
      sets.push(set);
      return set;
    },
  });
  return { sets, drawOf, frameOf: () => ({ requestRender() {} }) };
}

test('the layer draws one marker per event, lifted to its altitude when known', async () => {
  const scene = fakeScene();
  const rows = normalizeFireballs(PAYLOAD);
  const layer = createFireballsLayer({
    source: {
      getSnapshot: async () => ({ rows, fetchedAt: NOW, stale: false }),
    },
    now: () => NOW,
    drawOf: scene.drawOf,
    frameOf: scene.frameOf,
  });
  layer.init({});
  layer.enable();
  assert.equal(await layer.update(), true);
  const [set] = scene.sets;
  assert.equal(set.show, true);
  assert.equal(set.items.length, 3);
  // Oldest first, so the newest is drawn on top.
  assert.deepEqual(
    set.items.map(({ id }) => id),
    [
      'fireball:20130215032033',
      'fireball:20261004031445',
      'fireball:20261120112613',
    ],
  );
  assert.equal(set.items[1].height, 'absolute');
  assert.equal(set.items[2].height, 'clampGround');
  assert.equal(set.items[0].size[0], 33);
  const stats = layer.getStats();
  assert.equal(stats.count, 3);
  assert.deepEqual(stats.bands, { month: 1, year: 1, older: 1 });
  const records = layer.getAnalystRecords();
  assert.equal(records.length, 3);
  const chelyabinsk = records.find(({ id }) => id === '20130215032033');
  assert.equal(chelyabinsk.key, 'fireball:20130215032033');
  assert.equal(chelyabinsk.name, 'Fireball 2013-02-15 03:20 UTC');
  assert.equal(chelyabinsk.impactEnergyKilotonsTnt, 440);
  assert.equal(chelyabinsk.speedMps, 18600);
  assert.equal(layer.getAnalystRecords(1).length, 1);
  const legend = layer.getRowControls().legend;
  assert.deepEqual(
    legend.map(({ count }) => count),
    [1, 1, 1],
  );
  layer.disable();
  assert.equal(set.show, false);
  layer.destroy();
  assert.equal(set.disposed, true);
});

test('a failed refresh keeps the drawn events; a refusal with none fails the enable', async () => {
  const scene = fakeScene();
  const rows = normalizeFireballs(PAYLOAD);
  let failure = null;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const layer = createFireballsLayer({
      source: {
        getSnapshot: async () => {
          if (failure) throw failure;
          return { rows, fetchedAt: NOW, stale: false };
        },
      },
      now: () => NOW,
      drawOf: scene.drawOf,
      frameOf: scene.frameOf,
    });
    layer.init({});
    layer.enable();
    failure = Object.assign(new Error('JPL CNEOS HTTP 404'), {
      retryable: false,
    });
    assert.equal(await layer.update(), false);
    failure = null;
    assert.equal(await layer.update(), true);
    failure = Object.assign(new Error('JPL CNEOS HTTP 502'), {
      retryable: true,
    });
    assert.equal(await layer.update(), true);
    assert.equal(scene.sets[0].items.length, 3);
    assert.equal(layer.getStats().error, 'JPL CNEOS HTTP 502');
    assert.match(layer.getRowControls().info, /HTTP 502/);
  } finally {
    console.warn = warn;
  }
});
