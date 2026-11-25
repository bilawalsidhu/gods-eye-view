import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { createPortsLayer } from './index.js';

const NOW = 1_800_000_000_000;
const makePort = (id, country = 'GB', facilities = {}) => ({
  id: `wpi:${id}`,
  wpiNumber: id,
  name: `Port ${id}`,
  lat: 52,
  lon: -2,
  country,
  unlocode: 'GBXXX',
  facilities: {
    container: null,
    'solid-bulk': null,
    oil: null,
    lng: null,
    ...facilities,
  },
  source: 'NGA WPI (DOE NETL mirror)',
});

function makeSnapshot(records, version = 'snapshot-1') {
  return {
    records,
    complete: true,
    partial: false,
    stale: false,
    retrievedAt: NOW,
    mirrorLastEditAt: NOW - 1000,
    version,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(snapshots) {
  const queue = [...snapshots];
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const cards = [];
  const listeners = [];
  const requests = [];
  let onClick = null;
  const layer = createPortsLayer({
    source: {
      getSnapshot({ signal }) {
        requests.push(signal);
        return Promise.resolve(queue.shift());
      },
    },
    overlayHost: {
      setEntries(_id, entries) {
        cards.push(entries);
      },
      setVisible() {},
    },
    picking: {
      registerPickOwner() {},
      unregisterPickOwner() {},
      clickCard: () => null,
      resolvePickId: (hit) => hit.id,
      isOwnedByOtherLayer: () => false,
    },
    pointer: { isPointerFree: () => true },
    input: () => ({
      onClick(callback) {
        onClick = callback;
        const state = { removed: false };
        listeners.push(state);
        return () => {
          state.removed = true;
          onClick = null;
        };
      },
    }),
    now: () => NOW,
  });
  layer.init(viewer);
  return {
    layer,
    draw,
    cards,
    requests,
    listeners,
    click(id) {
      onClick?.({ topHit: id ? { id: `ports:${id}` } : null });
    },
    markerSet: () => draw.find('ports:'),
  };
}

test('port markers are opt-in, stable, and disposed on teardown', async () => {
  const h = harness([makeSnapshot([makePort(1), makePort(2)])]);
  assert.equal(h.markerSet().show, false);
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.equal(h.markerSet().items.size, 2);
  assert.equal(h.layer.getStats().count, 2);
  h.layer.disable();
  assert.equal(h.markerSet().show, false);
  assert.equal(h.listeners[0].removed, true);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.destroy();
  assert.equal(h.markerSet(), undefined);
});

test('country and positive-only facility filters work in visible map and panel', async () => {
  const h = harness([
    makeSnapshot([
      makePort(1, 'GB', { container: true, oil: null }),
      makePort(2, 'US', { container: false, oil: true }),
      makePort(3, 'GB', { container: null, oil: false }),
    ]),
  ]);
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getRowControls().list.items.length, 3);
  assert.equal(h.layer.getRowControls().segmented.options.length, 5);
  h.layer.setParams({ facility: 'container' });
  assert.equal(h.layer.getStats().count, 1);
  assert.deepEqual(
    h.layer.getAnalystRecords().map((r) => r.id),
    ['wpi:1'],
  );
  assert.equal(
    [...h.markerSet().items.values()].filter((record) => record.show).length,
    1,
  );
  h.layer.setParams({ country: 'US' });
  assert.equal(h.layer.getStats().count, 0);
  h.layer.setParams({ facility: 'oil' });
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getAnalystRecords()[0].id, 'wpi:2');
  h.layer.setParams({ country: '', facility: 'all' });
  assert.equal(h.layer.getStats().count, 3);
  h.layer.destroy();
});

test('click selects the exact port and hiding its facility clears card', async () => {
  const h = harness([makeSnapshot([makePort(44, 'GB', { container: true })])]);
  h.layer.enable();
  await h.layer.update();
  h.click(44);
  assert.equal(h.cards.at(-1)[0].id, 'ports-card:44');
  assert.match(h.cards.at(-1)[0].details.join('\n'), /Operator: Unavailable/);
  h.layer.setParams({ facility: 'lng' });
  assert.deepEqual(h.cards.at(-1), []);
  h.layer.destroy();
});

test('late snapshot after disable cannot re-add markers or notify', async () => {
  const late = deferred();
  const h = harness([late.promise]);
  h.layer.enable();
  const pending = h.layer.update();
  h.layer.disable();
  assert.equal(h.requests[0].aborted, true);
  late.resolve(makeSnapshot([makePort(50)]));
  assert.equal(await pending, false);
  assert.equal(h.markerSet().items.size, 0);
  h.layer.destroy();
});

test('partial data is conspicuous and stale data expires', async () => {
  const partial = {
    ...makeSnapshot([makePort(55)]),
    partial: true,
    complete: false,
    stale: true,
  };
  const h = harness([partial]);
  h.layer.enable();
  await h.layer.update();
  assert.match(h.layer.getRowControls().info, /PARTIAL/);
  assert.match(h.layer.getRowControls().info, /STALE/);
  assert.equal(h.layer.getStats().stale, true);
  h.layer.destroy();
});

test('skipped source rows are reported in the info line', async () => {
  const h = harness([
    {
      ...makeSnapshot([makePort(56)]),
      skipped: { total: 4, duplicateId: 2, fractionalId: 2 },
    },
  ]);
  h.layer.enable();
  await h.layer.update();
  assert.match(h.layer.getRowControls().info, /4 skipped/);
  h.layer.destroy();
});
