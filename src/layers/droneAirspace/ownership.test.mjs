import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeGroundHarness } from '../../testSupport/groundDisplayEngines.mjs';
import { createDroneAirspaceLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';

function harness(source, { pick = () => null, cardHit = () => null } = {}) {
  const overlay = { entries: new Map(), visible: null };
  const owners = new Map();
  const ground = createFakeGroundHarness();
  const { engine } = ground;
  // What a click picks: `scene.pick()` (null for nothing).
  const scene = { pick };
  engine.fake.script('pick', () => scene.pick() ?? undefined);
  const layer = createDroneAirspaceLayer({
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
    /** The zones' ground set (undefined once released). */
    zones: () => ground.set('drone-airspace'),
    /** A click through the engine's input, picking `scene.pick()`. */
    click: (event) => engine.fake.input('click', event),
  };
}

const ring = [
  [-77.04, 38.89],
  [-77.03, 38.89],
  [-77.03, 38.9],
  [-77.04, 38.89],
];
const row = {
  stableId: '310',
  name: 'P-56',
  typeCode: 'P',
  type: 'Prohibited',
  lowerAltitude: 'SFC',
  upperAltitude: '18,000 ft MSL',
  timesOfUse: 'CONTINUOUS',
  agency: null,
  city: 'WASHINGTON',
  state: 'DC',
  polygons: [[ring]],
};

test('each zone polygon renders as one fill with its outline', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: '400', typeCode: 'R', polygons: [[ring], [ring]] },
    ],
  });
  assert.equal(await h.layer.update(), true);
  const { items } = h.zones();
  const ids = [
    'drone-airspace:310:0',
    'drone-airspace:400:0',
    'drone-airspace:400:1',
  ];
  assert.equal(items.length, 6, 'a fill and an outline per polygon');
  assert.deepEqual(
    items.map(({ pickId }) => pickId),
    [...ids, ...ids],
  );
  assert.ok(items.slice(0, 3).every((item) => item.fill && !item.outline));
  assert.ok(items.slice(3).every((item) => item.outline && !item.fill));
  assert.equal(h.layer.getStats().count, 2);
});

test('clicking a zone publishes its card; empty space clears it', async () => {
  let pickResult = null;
  const h = harness(
    { getSnapshot: async () => [row] },
    { pick: () => pickResult },
  );
  await h.layer.update();
  assert.equal(h.ground.listeners(), 1, 'click handler missing');
  assert.equal(h.owners.size, 0);

  pickResult = { id: 'drone-airspace:310:0' };
  h.click({ position: { x: 10, y: 10 } });
  const entries = h.overlay.entries.get('drone-airspace');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'drone-airspace-card:310');
  assert.equal(entries[0].title, 'PROHIBITED · P-56');
  assert.ok(entries[0].position, 'card must carry a world anchor');

  pickResult = { id: 'other-layer:aircraft-1' };
  h.click({ position: { x: 10, y: 10 } });
  assert.equal(
    h.overlay.entries.get('drone-airspace')?.length,
    1,
    'sibling-layer picks must not clear the selection',
  );

  pickResult = null;
  h.click({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('drone-airspace')?.length ?? 0, 0);
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

test('the row legend names prohibited and restricted with the disclaimer', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: '400', typeCode: 'R', type: 'Restricted' },
    ],
  });
  await h.layer.update();
  const legend = h.layer.getRowControls().legend;
  assert.equal(legend[0].label, 'Prohibited (P)');
  assert.equal(legend[1].label, 'Restricted (R)');
  assert.equal(legend[0].count, 1);
  assert.equal(legend[1].count, 1);
  assert.match(legend[0].blurb, /not a substitute/);
});

test('a stale snapshot reads STALE, dated by its own fetch, and a fresh one clears it', async () => {
  const fetchedAt = Date.now() - 3 * 60 * 60 * 1000;
  let snapshot = { rows: [row], stale: true, fetchedAt };
  const h = harness({
    getSnapshot: async () => snapshot.rows,
    getSnapshotDetail: async () => snapshot,
  });
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().lastUpdate, fetchedAt);
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');
  snapshot = { rows: [row], stale: false, fetchedAt: Date.now() };
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, false);
  assert.ok(h.layer.getStats().lastUpdate > fetchedAt);
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
});

test('a failed refresh after a stale snapshot reads as the failure, not stale', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => [row],
    getSnapshotDetail: async () => {
      if (fail) throw new Error('FAA SUA HTTP 502');
      return { rows: [row], stale: true, fetchedAt: Date.now() - 60_000 };
    },
  });
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');
  fail = true;
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().error, 'FAA SUA HTTP 502');
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
});

test('a boundary change alone redraws the zone; identical geometry does not', async () => {
  const moved = ring.map(([lon, lat]) => [lon + 0.5, lat]);
  let rows = [row];
  const h = harness({ getSnapshot: async () => rows });
  await h.layer.update();
  const first = h.zones();
  rows = [{ ...row, polygons: [[ring.map((point) => [...point])]] }];
  await h.layer.update();
  assert.equal(h.zones().commits, first.commits, 'same geometry kept');
  assert.equal(h.zones().items, first.items);
  rows = [{ ...row, polygons: [[moved]] }];
  await h.layer.update();
  const redrawn = h.zones();
  assert.equal(
    redrawn.commits,
    first.commits + 1,
    'moved boundary must redraw',
  );
  assert.notDeepEqual(redrawn.items[1].rings, first.items[1].rings);
  assert.ok(h.layer.getAnalystRecords()[0].lon > -76.6);
});

test('an engine switch keeps the zones and the selected card for the next globe', async () => {
  const renderers = [];
  const layer = createDroneAirspaceLayer({
    source: { getSnapshot: async () => [row] },
    overlayHost: {
      entries: new Map(),
      setEntries(sourceId, entries) {
        this.entries.set(sourceId, entries);
      },
      setVisible() {},
      clearSource(sourceId) {
        this.entries.delete(sourceId);
      },
      hitTest: () => null,
    },
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    pointer: { isPointerFree: () => true },
    rendererFactory({ engine }) {
      const renderer = {
        engine,
        rows: [],
        visible: false,
        click: null,
        destroyed: false,
        setVisible(show) {
          renderer.visible = show;
        },
        replace(rows) {
          renderer.rows = rows;
        },
        onClick(callback) {
          renderer.click = callback;
          return () => (renderer.click = null);
        },
        pick: () => ({ id: 'drone-airspace:310:0' }),
        destroy() {
          renderer.destroyed = true;
        },
      };
      renderers.push(renderer);
      return renderer;
    },
  });
  layer.init(null, { engine: 'cesium' });
  layer.enable();
  await layer.update();
  renderers[0].click({ position: { x: 1, y: 1 } });
  layer.detachRenderer();
  assert.equal(renderers[0].destroyed, true);
  layer.attachRenderer({ engine: 'navara' });
  const [, next] = renderers;
  assert.equal(next.engine, 'navara');
  assert.equal(next.visible, true);
  assert.deepEqual(
    next.rows.map((zone) => zone.stableId),
    ['310'],
    'the next globe draws the zones without a refetch',
  );
  assert.equal(typeof next.click, 'function', 'and takes clicks');
  assert.equal(layer.getAnalystRecords().length, 1);
  layer.destroy();
  assert.equal(next.destroyed, true);
});
