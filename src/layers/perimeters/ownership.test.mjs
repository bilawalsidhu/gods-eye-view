import assert from 'node:assert/strict';
import test from 'node:test';
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
  const sources = [];
  const overlay = { entries: new Map(), visible: null };
  const clicks = { handler: null, destroyed: 0 };
  const owners = new Map();
  const opened = [];
  const viewer = {
    scene: { pick },
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
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
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(callback) {
        clicks.handler = callback;
      },
      destroy() {
        clicks.destroyed += 1;
        clicks.handler = null;
      },
    }),
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
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, overlay, clicks, owners, opened };
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

test('each perimeter polygon renders as one filled entity with its fire line', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: 'other', polygons: [[ring], [ring]] },
    ],
  });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 3);
  assert.equal(entities[0].id, 'fire-perimeter:2026-NMGNF-000123:0');
  assert.ok(entities[0].polygon, 'perimeter fill missing');
  assert.ok(entities[0].polyline, 'fire line missing');
  assert.equal(entities[1].id, 'fire-perimeter:other:0');
  assert.equal(entities[2].id, 'fire-perimeter:other:1');
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
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    h.layer.destroy(h.viewer);
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
  await h.layer.update(h.viewer);
  assert.equal(typeof h.clicks.handler, 'function', 'click handler missing');
  // Deliberately NOT registered as a pick owner: sibling layers' click
  // handlers yield to owned picks before their own card hit-tests, so
  // claiming these large ground polygons would make FIRMS/vessel/CCTV
  // overlay cards inert anywhere over a perimeter.
  assert.equal(h.owners.size, 0);

  pickResult = { id: 'fire-perimeter:2026-NMGNF-000123:0' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'fire-perimeter-card:2026-NMGNF-000123');
  assert.equal(entries[0].title, 'FIRE · Fixture Fire');
  assert.ok(entries[0].position, 'card must carry a world anchor');

  pickResult = { id: 'other-layer:aircraft-1' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(
    h.overlay.entries.get('fire-perimeters')?.length,
    1,
    'sibling-layer picks must not clear the selection',
  );

  pickResult = null;
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('fire-perimeters')?.length ?? 0, 0);
});

test('disable removes the click handler, pick ownership, and any card', async () => {
  const h = harness(
    { getSnapshot: async () => [row] },
    { pick: () => ({ id: 'fire-perimeter:2026-NMGNF-000123:0' }) },
  );
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
  h.layer.disable(h.viewer);
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.owners.has('fire-perimeters'), false);
  assert.equal(h.overlay.entries.has('fire-perimeters'), false);
});

test('a refresh that drops the selected incident also drops its card', async () => {
  let rows = [row];
  const h = harness(
    { getSnapshot: async () => rows },
    { pick: () => ({ id: 'fire-perimeter:2026-NMGNF-000123:0' }) },
  );
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('fire-perimeters').length, 1);
  rows = [{ ...row, stableId: 'different' }];
  await h.layer.update(h.viewer);
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
  await h.layer.update(h.viewer);
  // Select via a perimeter pick.
  h.viewer.scene.pick = () => ({
    id: 'fire-perimeter:2026-NMGNF-000123:0',
  });
  h.clicks.handler({ position: { x: 10, y: 10 } });
  // The card publishes immediately; the link line lands once the
  // publication's currency is validated.
  assert.equal(h.overlay.entries.get('fire-perimeters').length, 1);
  await new Promise((done) => setTimeout(done, 0));
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(entries[0].details.at(-1), 'InciWeb ↗ · click card to open');

  // Clicking the card itself opens the InciWeb page.
  cardHitResult = { entryId: entries[0].id };
  h.viewer.scene.pick = () => null;
  h.clicks.handler({ position: { x: 12, y: 12 } });
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
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
  const entries = h.overlay.entries.get('fire-perimeters');
  assert.equal(
    entries[0].details.some((line) => line.includes('InciWeb')),
    false,
  );
  cardHitResult = { entryId: entries[0].id };
  h.viewer.scene.pick = () => null;
  h.clicks.handler({ position: { x: 12, y: 12 } });
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
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
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
    await h.layer.update(h.viewer);
    h.clicks.handler({ position: { x: 10, y: 10 } });
    await new Promise((done) => setTimeout(done, 0));
    const entries = h.overlay.entries.get('fire-perimeters');
    assert.equal(entries.length, 1);
    assert.equal(
      entries[0].details.some((line) => line.includes('InciWeb')),
      false,
    );
    assert.equal(entries[0].interactive, false);
    h.layer.destroy(h.viewer);
  }
});

test('a hanging InciWeb index fetch never blocks the perimeter refresh', async () => {
  const h = harness({ getSnapshot: async () => [row] }, { inciwebIndex: null });
  // Replace the index source with one that never resolves.
  h.layer.destroy(h.viewer);
  const hanging = harness({ getSnapshot: async () => [row] });
  hanging.layer.destroy(hanging.viewer);
  const sources = [];
  const viewer = {
    scene: { pick: () => null },
    dataSources: {
      add: (v) => sources.push(v),
      remove: (v) => sources.splice(sources.indexOf(v), 1),
    },
  };
  const layer = createFirePerimetersLayer({
    source: { getSnapshot: async () => [row] },
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
    picking: {
      resolvePickId: () => null,
      isOwnedByOtherLayer: () => false,
      registerPickOwner() {},
      unregisterPickOwner() {},
    },
    pointer: { isPointerFree: () => true },
    inciwebSource: { getIndex: () => new Promise(() => {}) },
    inciwebPublications: {
      getPublication: async () => ({ createdMs: 1, changedMs: 1 }),
    },
    openExternal: () => {},
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(layer.getStats().count, 1);
  layer.destroy(viewer);
});

test('an InciWeb outage never breaks the perimeter refresh', async () => {
  const h = harness({ getSnapshot: async () => [row] });
  const failing = createFirePerimetersLayer({
    source: { getSnapshot: async () => [row] },
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
    picking: {
      resolvePickId: () => null,
      isOwnedByOtherLayer: () => false,
      registerPickOwner() {},
      unregisterPickOwner() {},
    },
    pointer: { isPointerFree: () => true },
    inciwebSource: {
      getIndex: async () => {
        throw new Error('InciWeb HTTP 503');
      },
    },
    openExternal: () => {},
  });
  const viewer = {
    scene: { pick: () => null },
    dataSources: { add() {}, remove() {} },
  };
  failing.init(viewer);
  failing.enable(viewer);
  assert.equal(await failing.update(viewer), true);
  assert.equal(failing.getStats().count, 1);
  failing.destroy(viewer);
  h.layer.destroy(h.viewer);
});

test('analyst records expose incident facts without geometry payloads', async () => {
  const h = harness({ getSnapshot: async () => [row] });
  await h.layer.update(h.viewer);
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

test('unchanged snapshots retain entity identity even if source ordering changes', async () => {
  let rows = [row, { ...row, stableId: 'other' }];
  const h = harness({ getSnapshot: async () => rows });
  await h.layer.update();
  const original = [...h.sources[0].entities.values];
  let removals = 0;
  const entities = h.sources[0].entities;
  const removeAll = entities.removeAll.bind(entities);
  entities.removeAll = () => {
    removals++;
    removeAll();
  };
  rows = [...rows].reverse();
  await h.layer.update();
  assert.equal(removals, 0);
  assert.equal(entities.values[0], original[0]);
  rows = rows.map((value) => ({
    ...value,
    updatedTime: value.updatedTime + 1,
  }));
  await h.layer.update();
  assert.equal(removals, 1);
  assert.notEqual(entities.values[0], original[0]);
  rows = rows.map((value) => ({ ...value, containedPct: 100 }));
  await h.layer.update();
  assert.equal(
    removals,
    2,
    'incident facts can change without a new polygon timestamp',
  );
  assert.equal(h.layer.getRowControls().legend[3].count, 2);
  rows = [];
  await h.layer.update();
  assert.equal(entities.values.length, 0);
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
    h.clicks.handler({ position: { x: 1, y: 1 } });
    assert.equal(signal.aborted, false);
    if (action === 'selection') {
      pick = { id: 'fire-perimeter:other:0' };
      h.clicks.handler({ position: { x: 1, y: 1 } });
    } else h.layer[action]();
    assert.equal(signal.aborted, true);
    const entries = h.overlay.entries.get('fire-perimeters');
    finish({ createdMs: row.discoveredTime, changedMs: row.updatedTime });
    await new Promise(setImmediate);
    assert.equal(h.overlay.entries.get('fire-perimeters'), entries);
    if (action !== 'destroy') h.layer.destroy();
  });
}
