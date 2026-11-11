import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createFakeGroundHarness } from '../../testSupport/groundDisplayEngines.mjs';
import { createFirePerimetersLayer } from './index.js';

function harness(
  source,
  {
    pick = () => null,
    inciwebIndex = null,
    cardHit = () => null,
    publication = async () => ({
      createdMs: 1757000000000,
      changedMs: 1757900000000,
    }),
  } = {},
) {
  const overlay = { entries: new Map(), visible: null };
  const owners = new Map();
  const opened = [];
  const ground = createFakeGroundHarness();
  const { engine } = ground;
  // What a click picks: `scene.pick()` (null for nothing).
  const scene = { pick };
  engine.fake.script('pick', () => scene.pick() ?? undefined);
  const layer = createFirePerimetersLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        overlay.entries.set(sourceId, entries);
      },
      setVisible(sourceId, visible) {
        overlay.visible = visible;
      },
      clearSource(sourceId) {
        overlay.entries.delete(sourceId);
      },
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickedId) =>
        String(pickedId).startsWith('other-layer:'),
      registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
      unregisterPickOwner: (layerId) => owners.delete(layerId),
    },
    pointer: { isPointerFree: () => true },
    inciwebSource: inciwebIndex
      ? { getIndex: async () => inciwebIndex }
      : { getIndex: async () => [] },
    inciwebPublications: { getPublication: publication },
    openExternal: (url) => opened.push(url),
  });
  layer.init(null, { engine });
  layer.enable();
  return {
    layer,
    engine,
    ground,
    scene,
    overlay,
    owners,
    opened,
    /** The perimeters' ground set (undefined once released). */
    zones: () => ground.set('fire-perimeters'),
    /** A click through the engine's input, picking `scene.pick()`. */
    click: (event) => engine.fake.input('click', event),
  };
}

// A layer on its own fake engine, for tests that only refresh.
function plainLayer(options) {
  const layer = createFirePerimetersLayer({
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
    picking: {
      resolvePickId: () => null,
      isOwnedByOtherLayer: () => false,
      registerPickOwner() {},
      unregisterPickOwner() {},
    },
    pointer: { isPointerFree: () => true },
    openExternal: () => {},
    ...options,
  });
  layer.init(null, { engine: createFakeEngine() });
  layer.enable();
  return layer;
}

const ring = [
  [-108.1, 35.2],
  [-108.0, 35.2],
  [-108.0, 35.3],
  [-108.1, 35.2],
];
const row = {
  stableId: '2026-NMGNF-000123',
  name: 'Fixture Fire',
  acres: 512.5,
  containedPct: 40,
  state: 'US-NM',
  category: 'WF',
  discoveredTime: 1757900000000,
  updatedTime: 1757950000000,
  cause: 'Natural',
  behavior: 'Active',
  personnel: 380,
  county: 'Sandoval',
  costToDate: 4200000,
  complexity: 'Type 3 Incident',
  complexName: 'ROWE CREEK COMPLEX',
  polygons: [[ring]],
};

test('each perimeter polygon renders as one fill with its fire line', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: 'other', polygons: [[ring], [ring]] },
    ],
  });
  assert.equal(await h.layer.update(), true);
  const { items } = h.zones();
  const ids = [
    'fire-perimeter:2026-NMGNF-000123:0',
    'fire-perimeter:other:0',
    'fire-perimeter:other:1',
  ];
  assert.equal(items.length, 6, 'a fill and a fire line per polygon');
  assert.deepEqual(
    items.map(({ pickId }) => pickId),
    [...ids, ...ids],
  );
  assert.ok(items.slice(0, 3).every((item) => item.fill && !item.outline));
  assert.ok(items.slice(3).every((item) => item.outline && !item.fill));
  assert.equal(h.layer.getStats().count, 2);
});

test('late refresh cannot publish after disable or destroy', async () => {
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
    const pending = h.layer.update();
    h.layer[action]();
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable();
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    h.layer.destroy();
  }
});

test('clicking a perimeter publishes its incident card; empty space clears it', async () => {
  let pickResult = null;
  const h = harness(
    { getSnapshot: async () => [row] },
    {
      pick: () => pickResult,
    },
  );
  await h.layer.update();
  assert.equal(h.ground.listeners(), 1, 'click handler missing');
  // Deliberately NOT registered as a pick owner: sibling layers' click
  // handlers yield to owned picks before their own card hit-tests, so
  // claiming these large ground polygons would make FIRMS/vessel/CCTV
  // overlay cards inert anywhere over a perimeter.
  assert.equal(h.owners.size, 0);

  pickResult = { id: 'fire-perimeter:2026-NMGNF-000123:0' };
  h.click({ position: { x: 10, y: 10 } });
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'fire-perimeter-card:2026-NMGNF-000123');
  assert.equal(entries[0].title, 'FIRE · Fixture Fire');
  assert.ok(entries[0].position, 'card must carry a world anchor');

  pickResult = { id: 'other-layer:aircraft-1' };
  h.click({ position: { x: 10, y: 10 } });
  assert.equal(
    h.overlay.entries.get('fire-perimeters')?.length,
    1,
    'sibling-layer picks must not clear the selection',
  );

  pickResult = null;
  h.click({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('fire-perimeters')?.length ?? 0, 0);
});

test('disable removes the click handler, pick ownership, and any card', async () => {
  const h = harness(
    { getSnapshot: async () => [row] },
    { pick: () => ({ id: 'fire-perimeter:2026-NMGNF-000123:0' }) },
  );
  await h.layer.update();
  h.click({ position: { x: 10, y: 10 } });
  h.layer.disable();
  assert.equal(h.ground.listeners(), 0);
  assert.equal(h.owners.has('fire-perimeters'), false);
  assert.equal(h.overlay.entries.has('fire-perimeters'), false);
});

test('a refresh that drops the selected incident also drops its card', async () => {
  let rows = [row];
  const h = harness(
    { getSnapshot: async () => rows },
    { pick: () => ({ id: 'fire-perimeter:2026-NMGNF-000123:0' }) },
  );
  await h.layer.update();
  h.click({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('fire-perimeters').length, 1);
  rows = [{ ...row, stableId: 'different' }];
  await h.layer.update();
  assert.equal(h.overlay.entries.get('fire-perimeters')?.length ?? 0, 0);
});

test('a matched incident card carries the InciWeb line and click-through', async () => {
  const inciwebIndex = [
    {
      incident_id: '329300',
      tau: 'NMGNF Fixture Fire',
      incident_title: 'Fixture Fire',
    },
  ];
  let cardHitResult = null;
  const h = harness(
    { getSnapshot: async () => [{ ...row, name: 'Fixture' }] },
    {
      pick: () => null,
      inciwebIndex,
      cardHit: () => cardHitResult,
    },
  );
  await h.layer.update();
  // Select via a perimeter pick.
  h.scene.pick = () => ({
    id: 'fire-perimeter:2026-NMGNF-000123:0',
  });
  h.click({ position: { x: 10, y: 10 } });
  // The card publishes immediately; the link line lands once the
  // publication's currency is validated.
  assert.equal(h.overlay.entries.get('fire-perimeters').length, 1);
  await new Promise((done) => setTimeout(done, 0));
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(entries[0].details.at(-1), 'InciWeb ↗ · click card to open');

  // Clicking the card itself opens the InciWeb page.
  cardHitResult = { entryId: entries[0].id };
  h.scene.pick = () => null;
  h.click({ position: { x: 12, y: 12 } });
  assert.deepEqual(h.opened, ['https://inciweb.wildfire.gov/node/329300']);
  assert.equal(
    h.overlay.entries.get('fire-perimeters').length,
    1,
    'opening the link must not clear the selection',
  );
});

test('an unmatched incident renders no InciWeb line and card clicks stay inert', async () => {
  let cardHitResult = null;
  const h = harness(
    { getSnapshot: async () => [row] },
    {
      pick: () => ({ id: 'fire-perimeter:2026-NMGNF-000123:0' }),
      inciwebIndex: [],
      cardHit: () => cardHitResult,
    },
  );
  await h.layer.update();
  h.click({ position: { x: 10, y: 10 } });
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(
    entries[0].details.some((line) => line.includes('InciWeb')),
    false,
  );
  cardHitResult = { entryId: entries[0].id };
  h.scene.pick = () => null;
  h.click({ position: { x: 12, y: 12 } });
  assert.deepEqual(h.opened, []);
  assert.equal(h.overlay.entries.get('fire-perimeters').length, 1);
});

test('a complex member resolves to its complex page from the catalog', async () => {
  const h = harness(
    { getSnapshot: async () => [row] },
    {
      pick: () => ({ id: 'fire-perimeter:2026-NMGNF-000123:0' }),
      inciwebIndex: [
        {
          // Same state as the member fire: the state filter applies to
          // complex fallbacks too.
          incident_id: '328923',
          tau: 'NMPRD Rowe Creek Complex',
          incident_title: 'Rowe Creek Complex',
        },
      ],
    },
  );
  await h.layer.update();
  h.click({ position: { x: 10, y: 10 } });
  await new Promise((done) => setTimeout(done, 0));
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(entries[0].details.at(-1), 'InciWeb ↗ · click card to open');
});

test('a stale or unverifiable publication yields no link', async () => {
  const inciwebIndex = [
    {
      incident_id: '100',
      tau: 'NMGNF Fixture Fire',
      incident_title: 'Fixture Fire',
    },
  ];
  for (const publication of [
    // Created two years before this fire's discovery: an archived page.
    async () => ({
      createdMs: 1757900000000 - 700 * 86400000,
      changedMs: null,
    }),
    // Validation endpoint down: fail closed, no link.
    async () => {
      throw new Error('InciWeb HTTP 503');
    },
  ]) {
    const h = harness(
      { getSnapshot: async () => [row] },
      {
        pick: () => ({ id: 'fire-perimeter:2026-NMGNF-000123:0' }),
        inciwebIndex,
        publication,
      },
    );
    await h.layer.update();
    h.click({ position: { x: 10, y: 10 } });
    await new Promise((done) => setTimeout(done, 0));
    const entries = h.overlay.entries.get('fire-perimeters');
    assert.equal(entries.length, 1);
    assert.equal(
      entries[0].details.some((line) => line.includes('InciWeb')),
      false,
    );
    assert.equal(entries[0].interactive, false);
    h.layer.destroy();
  }
});

test('a hanging InciWeb index fetch never blocks the perimeter refresh', async () => {
  const h = harness({ getSnapshot: async () => [row] }, { inciwebIndex: null });
  // Replace the index source with one that never resolves.
  h.layer.destroy();
  const hanging = harness({ getSnapshot: async () => [row] });
  hanging.layer.destroy();
  const layer = plainLayer({
    source: { getSnapshot: async () => [row] },
    inciwebSource: { getIndex: () => new Promise(() => {}) },
    inciwebPublications: {
      getPublication: async () => ({ createdMs: 1, changedMs: 1 }),
    },
  });
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  layer.destroy();
});

test('an InciWeb outage never breaks the perimeter refresh', async () => {
  const h = harness({ getSnapshot: async () => [row] });
  const failing = plainLayer({
    source: { getSnapshot: async () => [row] },
    inciwebSource: {
      getIndex: async () => {
        throw new Error('InciWeb HTTP 503');
      },
    },
  });
  assert.equal(await failing.update(), true);
  assert.equal(failing.getStats().count, 1);
  failing.destroy();
  h.layer.destroy();
});

test('analyst records expose incident facts without geometry payloads', async () => {
  const h = harness({ getSnapshot: async () => [row] });
  await h.layer.update();
  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'Fixture Fire');
  assert.equal(records[0].acres, 512.5);
  assert.equal(records[0].containedPct, 40);
  assert.equal(records[0].state, 'US-NM');
  assert.equal(records[0].cause, 'Natural');
  assert.equal(records[0].behavior, 'Active');
  assert.equal(records[0].personnel, 380);
  assert.equal(records[0].county, 'Sandoval');
  assert.equal(records[0].costToDate, 4200000);
  assert.equal(records[0].complexity, 'Type 3 Incident');
  // Spatial scoping in the analyst engine requires coordinates.
  assert.ok(Math.abs(records[0].lat - 35.2333) < 0.01);
  assert.ok(Math.abs(records[0].lon - -108.0333) < 0.01);
  assert.equal('polygons' in records[0], false);
});

test('unchanged snapshots keep the drawn perimeters even if source ordering changes', async () => {
  let rows = [row, { ...row, stableId: 'other' }];
  const h = harness({ getSnapshot: async () => rows });
  await h.layer.update();
  const original = h.zones();
  const redraws = () => h.zones().commits - original.commits;
  rows = [...rows].reverse();
  await h.layer.update();
  assert.equal(redraws(), 0);
  assert.equal(h.zones().items, original.items);
  rows = rows.map((value) => ({
    ...value,
    updatedTime: value.updatedTime + 1,
  }));
  await h.layer.update();
  assert.equal(redraws(), 1);
  assert.notEqual(h.zones().items, original.items);
  rows = rows.map((value) => ({ ...value, containedPct: 100 }));
  await h.layer.update();
  assert.equal(
    redraws(),
    2,
    'incident facts can change without a new polygon timestamp',
  );
  assert.equal(h.layer.getRowControls().legend[3].count, 2);
  rows = [];
  await h.layer.update();
  assert.equal(h.zones().items.length, 0);
  h.layer.destroy();
});

test('containment legend uses the existing thresholds, colours and incident counts', async () => {
  const values = [null, -1, 0, 0.5, 49.9, 50, 99.9, 100, 101];
  const h = harness({
    getSnapshot: async () =>
      values.map((containedPct, index) => ({
        ...row,
        stableId: String(index),
        containedPct,
      })),
  });
  await h.layer.update();
  const controls = h.layer.getRowControls();
  assert.deepEqual(controls.chips, []);
  assert.deepEqual(
    controls.legend.map(({ color, count }) => [color, count]),
    [
      ['#ff3b30', 3],
      ['#ff7a00', 2],
      ['#ffb300', 2],
      ['#8bc34a', 2],
    ],
  );
  assert.ok(
    controls.legend.every(
      ({ label }) => typeof label === 'string' && label.length,
    ),
  );
  assert.equal(
    controls.legend[0].blurb,
    'Colour shows reported containment. Perimeters are simplified to about 100 m.',
  );
  h.layer.destroy();
  assert.deepEqual(
    h.layer.getRowControls().legend.map(({ count }) => count),
    [0, 0, 0, 0],
  );
});

for (const action of ['disable', 'destroy', 'selection']) {
  test(`incident-link verification aborts on ${action} and ignores late completion`, async () => {
    let finish, signal;
    let pick = { id: `fire-perimeter:${row.stableId}:0` };
    const h = harness(
      {
        getSnapshot: async () => [
          row,
          { ...row, stableId: 'other', name: 'Other Fire' },
        ],
      },
      {
        pick: () => pick,
        inciwebIndex: [
          { incident_id: '123', incident_title: row.name, tau: 'nm' },
        ],
        publication: (_id, options) => {
          signal = options.signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    );
    await h.layer.update();
    h.click({ position: { x: 1, y: 1 } });
    assert.equal(signal.aborted, false);
    if (action === 'selection') {
      pick = { id: 'fire-perimeter:other:0' };
      h.click({ position: { x: 1, y: 1 } });
    } else h.layer[action]();
    assert.equal(signal.aborted, true);
    const entries = h.overlay.entries.get('fire-perimeters');
    finish({ createdMs: row.discoveredTime, changedMs: row.updatedTime });
    await new Promise(setImmediate);
    assert.equal(h.overlay.entries.get('fire-perimeters'), entries);
    if (action !== 'destroy') h.layer.destroy();
  });
}

test('a stale snapshot reads stale, dated by its own fetch, and a fresh one clears it', async () => {
  const fetchedAt = Date.now() - 3 * 60 * 60 * 1000;
  let snapshot = { rows: [row], stale: true, fetchedAt };
  const h = harness({
    getSnapshot: async () => snapshot.rows,
    getSnapshotDetail: async () => snapshot,
  });
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().lastUpdate, fetchedAt);
  snapshot = { rows: [row], stale: false, fetchedAt: Date.now() };
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, false);
  assert.ok(h.layer.getStats().lastUpdate > fetchedAt);
});

test('a failed refresh after a stale snapshot reads as the failure, not stale', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => [row],
    getSnapshotDetail: async () => {
      if (fail) throw new Error('WFIGS HTTP 502');
      return { rows: [row], stale: true, fetchedAt: Date.now() - 60_000 };
    },
  });
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  fail = true;
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().error, 'WFIGS HTTP 502');
});

test('a selected fire retains its card and changed polygon through a scene handoff', async () => {
  const fire = { ...row, stableId: 'incident:one' };
  let geometry = fire.polygons;
  let polls = 0;
  const h = harness(
    {
      getSnapshot: async () => {
        polls++;
        return [{ ...fire, polygons: geometry }];
      },
    },
    {
      pick: () => ({ id: 'fire-perimeter:incident:one:0' }),
    },
  );
  try {
    await h.layer.update();
    h.click({ position: { x: 0, y: 0 } });
    assert.equal(
      h.overlay.entries.get('fire-perimeters')[0].id,
      'fire-perimeter-card:incident:one',
    );
    h.layer.detachRenderer();
    assert.equal(h.ground.sets(), 0);
    geometry = [[ring.map(([lon, lat]) => [lon + 0.1, lat])]];
    assert.equal(await h.layer.update(), true);
    const record = h.layer.getAnalystRecords()[0];
    assert.equal(record.id, 'incident:one');
    h.layer.attachRenderer({ engine: h.engine });
    assert.equal(h.zones().items.length, 2, 'the fill and its fire line');
    assert.equal(h.zones().items[0].rings[0][0][0], ring[0][0] + 0.1);
    assert.equal(
      h.overlay.entries.get('fire-perimeters')[0].id,
      'fire-perimeter-card:incident:one',
    );
    assert.equal(polls, 2);
  } finally {
    h.layer.destroy();
  }
});
