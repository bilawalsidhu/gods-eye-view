import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QLDTRAFFIC_URL,
  QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID,
  createQldRoadEventsLayer,
  qldRoadEventIdFromPick,
} from './index.js';

const crash = {
  id: '10',
  category: 'crash',
  type: 'Crash',
  road: 'Pacific Motorway',
  lastUpdatedMs: null,
  startMs: null,
  anchor: [153.2, -27.7],
  points: [
    [153.2, -27.7],
    [153.21, -27.71],
  ],
  lines: [],
};
const works = {
  id: '20',
  category: 'roadworks',
  type: 'Roadworks',
  lastUpdatedMs: null,
  startMs: null,
  anchor: [152.5, -27.5],
  points: [],
  lines: [
    [
      [152.4, -27.5],
      [152.6, -27.5],
    ],
    [
      [152.4, -27.6],
      [152.6, -27.6],
    ],
  ],
};

function harness(snapshots, { pick = () => null, cardHit = () => null } = {}) {
  const queue = [...snapshots];
  const overlay = { entries: new Map(), visible: null };
  const clicks = { handler: null, destroyed: 0 };
  const owners = new Map();
  const opened = [];
  const preRender = new Set();
  const sources = [];
  const viewer = {
    camera: { positionWC: { x: 0, y: 0, z: 0 } },
    scene: {
      pick,
      requestRender() {},
      preRender: {
        addEventListener(fn) {
          preRender.add(fn);
          return () => preRender.delete(fn);
        },
      },
    },
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
  };
  let fetches = 0;
  const layer = createQldRoadEventsLayer({
    source: {
      async getSnapshot({ signal }) {
        fetches++;
        signal.throwIfAborted();
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return next;
      },
    },
    overlayHost: {
      setEntries: (id, entries) => overlay.entries.set(id, entries),
      setVisible: (id, visible) => (overlay.visible = visible),
      clearSource: (id) => overlay.entries.delete(id),
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => (clicks.handler = callback),
      destroy() {
        clicks.destroyed++;
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, id) => String(id).startsWith('other:'),
      registerPickOwner: (id, predicate) => owners.set(id, predicate),
      unregisterPickOwner: (id) => owners.delete(id),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    sources,
    overlay,
    clicks,
    owners,
    opened,
    preRender,
    fetches: () => fetches,
  };
}

test('pick ids resolve only for this layer', () => {
  assert.equal(qldRoadEventIdFromPick('qld-road-event:42'), '42');
  assert.equal(qldRoadEventIdFromPick('qld-road-event:42:line:3'), '42');
  assert.equal(qldRoadEventIdFromPick('fire-perimeter:42'), null);
  assert.equal(qldRoadEventIdFromPick(42), null);
  assert.equal(qldRoadEventIdFromPick('qld-road-event:'), null);
});

test('a snapshot renders markers and lines, legend counts and stats', async () => {
  const h = harness([{ events: [crash, works], stale: false }]);
  assert.equal(await h.layer.update(), false, 'disabled layers never fetch');
  assert.equal(h.fetches(), 0);
  h.layer.enable();
  assert.ok(h.owners.has('qld-road-events'));
  assert.equal(await h.layer.update(), true);
  const diagnostics = h.layer.getDiagnostics();
  // crash: two markers; roadworks: two lines + anchor marker.
  assert.equal(diagnostics.entities, 5);
  assert.equal(diagnostics.markers, 3);
  assert.equal(diagnostics.horizonListener, true);
  assert.equal(h.preRender.size, 1);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.error, null);
  assert.equal(stats.stale, false);
  const legend = h.layer.getRowControls().legend;
  assert.equal(legend[0].label, 'Crash');
  assert.equal(legend[0].count, 1);
  assert.ok(legend[0].blurb);
  assert.equal(legend.find((row) => row.label === 'Roadworks').count, 1);
  assert.equal(
    legend.find((row) => row.label === 'Other'),
    undefined,
    'other only appears when present',
  );
});

test('clicking an event opens its card; the card opens QLDTraffic', async () => {
  let hit = null;
  let picked = null;
  const h = harness([{ events: [crash, works] }], {
    pick: () => picked,
    cardHit: () => hit,
  });
  h.layer.enable();
  await h.layer.update();
  picked = { id: 'qld-road-event:20:line:1' };
  h.clicks.handler({ position: { x: 1, y: 1 } });
  const [card] = h.overlay.entries.get(QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID);
  assert.equal(card.id, 'qld-road-event-card:20');
  assert.equal(h.layer.getDiagnostics().selectedId, '20');
  assert.equal(card.activate(), true);
  assert.deepEqual(h.opened, [QLDTRAFFIC_URL]);

  hit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.opened.length, 2);
  hit = null;

  picked = { id: 'other:aircraft' };
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(
    h.layer.getDiagnostics().selectedId,
    '20',
    'sibling picks keep selection',
  );

  picked = null;
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.layer.getDiagnostics().selectedId, null);
  assert.deepEqual(
    h.overlay.entries.get(QLD_ROAD_EVENTS_OVERLAY_SOURCE_ID),
    [],
  );
});

test('a refresh that drops the selected event clears its card', async () => {
  const h = harness([{ events: [crash, works] }, { events: [works] }], {
    pick: () => ({ id: 'qld-road-event:10' }),
  });
  h.layer.enable();
  await h.layer.update();
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.layer.getDiagnostics().selectedId, '10');
  await h.layer.update();
  assert.equal(h.layer.getDiagnostics().selectedId, null);
  assert.equal(h.layer.getStats().count, 1);
});

test('failures keep the last snapshot and report the error; stale is surfaced', async () => {
  const h = harness([
    { events: [crash] },
    new Error('QLDTraffic HTTP 502'),
    { events: [crash], stale: true },
  ]);
  h.layer.enable();
  await h.layer.update();
  assert.equal(await h.layer.update(), false);
  assert.equal(h.layer.getStats().error, 'QLDTraffic HTTP 502');
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getDiagnostics().entities, 2);
  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().error, null);
});

test('disable and destroy release handlers, listeners, owners and the data source', async () => {
  const h = harness([{ events: [crash] }]);
  h.layer.enable();
  await h.layer.update();
  h.layer.disable();
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.preRender.size, 0);
  assert.equal(h.owners.size, 0);
  assert.equal(h.overlay.visible, false);
  assert.equal(await h.layer.update(), false);
  h.layer.enable();
  assert.equal(h.preRender.size, 1);
  h.layer.destroy();
  assert.equal(h.preRender.size, 0);
  assert.equal(h.sources.length, 0);
  assert.equal(h.layer.getStats().count, 0);
  assert.throws(() => createQldRoadEventsLayer({}), TypeError);
});
