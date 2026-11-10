import assert from 'node:assert/strict';
import test from 'node:test';
import { createDroneAirspaceLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

// The fills set of the layer the last harness made: zone picks name it.
let fillsSetId = null;
/** A Cesium pick of a zone's fill, as the draw port makes it. */
const zonePick = (id) => ({ id: { set: fillsSetId, id } });
const liveSet = (draw, suffix) =>
  [...draw.sets.values()].find(
    (record) => !record.disposed && record.spec.id.endsWith(suffix),
  );

function harness(source, { pick = () => null, cardHit = () => null } = {}) {
  const overlay = { entries: new Map(), visible: null };
  const owners = new Map();
  const viewer = { scene: { pick } };
  const { draw } = bindFakeDraw(viewer);
  const input = fakeInput(viewer);
  const clicks = {
    handler: (click) => input.click(click.position),
    get destroyed() {
      return input.input.subscriberCount() === 0 ? 1 : 0;
    },
  };
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
    inputFor: () => input.input,
    picking: {
      resolvePickId: (picked) => picked?.id?.id ?? picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickedId) =>
        String(pickedId).startsWith('other-layer:'),
      registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
      unregisterPickOwner: (layerId) => owners.delete(layerId),
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  fillsSetId = liveSet(draw, ':fills').spec.id;
  return {
    layer,
    viewer,
    draw,
    fills: () => liveSet(draw, ':fills'),
    lines: () => liveSet(draw, ':lines'),
    overlay,
    clicks,
    owners,
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

test('each zone polygon draws as one clamped fill with its draped boundary', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: '400', typeCode: 'R', polygons: [[ring], [ring]] },
    ],
  });
  assert.equal(await h.layer.update(h.viewer), true);
  const ids = [
    'drone-airspace:310:0',
    'drone-airspace:400:0',
    'drone-airspace:400:1',
  ];
  assert.deepEqual([...h.fills().items.keys()], ids, 'zone fill missing');
  assert.deepEqual([...h.lines().items.keys()], ids, 'zone outline missing');
  assert.equal(h.fills().show, true);
  const fill = h.fills().items.get(ids[0]);
  assert.equal(fill.height, 'clampGround');
  assert.equal(fill.geometry.kind, 'polygon');
  assert.equal(fill.fill[3], 0.25);
  const line = h.lines().items.get(ids[0]);
  assert.equal(line.mode, 'draped');
  assert.equal(line.widthPx, 2);
  assert.equal(line.style.color[3], 0.9);
  assert.equal(line.positions.length, ring.length, 'the exterior ring only');
  assert.equal(h.layer.getStats().count, 2);
});

test('clicking a zone publishes its card; empty space clears it', async () => {
  let pickResult = null;
  const h = harness(
    { getSnapshot: async () => [row] },
    { pick: () => pickResult },
  );
  await h.layer.update(h.viewer);
  assert.equal(h.clicks.destroyed, 0, 'click handler missing');
  assert.equal(h.owners.size, 0);

  pickResult = zonePick('drone-airspace:310:0');
  h.clicks.handler({ position: { x: 10, y: 10 } });
  const entries = h.overlay.entries.get('drone-airspace');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'drone-airspace-card:310');
  assert.equal(entries[0].title, 'PROHIBITED · P-56');
  assert.ok(entries[0].position, 'card must carry a world anchor');

  pickResult = { id: 'other-layer:aircraft-1' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(
    h.overlay.entries.get('drone-airspace')?.length,
    1,
    'sibling-layer picks must not clear the selection',
  );

  pickResult = null;
  h.clicks.handler({ position: { x: 10, y: 10 } });
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

test('the row legend names prohibited and restricted with the disclaimer', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: '400', typeCode: 'R', type: 'Restricted' },
    ],
  });
  await h.layer.update(h.viewer);
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
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().lastUpdate, fetchedAt);
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');
  snapshot = { rows: [row], stale: false, fetchedAt: Date.now() };
  await h.layer.update(h.viewer);
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
  await h.layer.update(h.viewer);
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');
  fail = true;
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(h.layer.getStats().error, 'FAA SUA HTTP 502');
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
});

test('a boundary change alone redraws the zone; identical geometry does not', async () => {
  const moved = ring.map(([lon, lat]) => [lon + 0.5, lat]);
  let rows = [row];
  const h = harness({ getSnapshot: async () => rows });
  await h.layer.update(h.viewer);
  const [first] = h.lines().items.values();
  rows = [{ ...row, polygons: [[ring.map((point) => [...point])]] }];
  await h.layer.update(h.viewer);
  assert.equal([...h.lines().items.values()][0], first, 'same geometry kept');
  rows = [{ ...row, polygons: [[moved]] }];
  await h.layer.update(h.viewer);
  const [redrawn] = h.lines().items.values();
  assert.notEqual(redrawn, first, 'moved boundary must redraw');
  assert.notDeepEqual(redrawn.positions, first.positions);
  assert.ok(h.layer.getAnalystRecords()[0].lon > -76.6);
});
