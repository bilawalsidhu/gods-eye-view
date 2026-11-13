import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BORDER_WAITS_OVERLAY_SOURCE_ID,
  createBorderWaitsLayer,
} from './index.js';
import { normalizeBorderWaitSnapshot } from './records.js';
import { cbpPort, cbpPedestrianPort, FIXTURE_LOCATIONS } from './fixture.mjs';

const ROWS = normalizeBorderWaitSnapshot(
  [cbpPort(), cbpPedestrianPort()],
  FIXTURE_LOCATIONS,
).rows;

function harness({ snapshots = [{ rows: ROWS, stale: false }] } = {}) {
  const overlay = { entries: null, visible: null, cleared: 0 };
  const owners = new Map();
  let click = null;
  let pickResult = null;
  let fetches = 0;
  const viewer = {
    dataSources: {
      added: [],
      add(source) {
        this.added.push(source);
      },
      remove(source) {
        this.added = this.added.filter((candidate) => candidate !== source);
      },
    },
    scene: { pick: () => pickResult },
  };
  const layer = createBorderWaitsLayer({
    source: {
      async getSnapshot() {
        const next = snapshots[Math.min(fetches, snapshots.length - 1)];
        fetches++;
        if (next instanceof Error) throw next;
        return next;
      },
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, BORDER_WAITS_OVERLAY_SOURCE_ID);
        overlay.entries = entries;
      },
      setVisible(sourceId, visible) {
        overlay.visible = visible;
      },
      clearSource() {
        overlay.entries = null;
        overlay.cleared++;
      },
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(action) {
        click = action;
      },
      destroy() {
        click = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickId) =>
        [...owners].some(([owner, owns]) => owner !== layerId && owns(pickId)),
      registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
      unregisterPickOwner: (layerId) => owners.delete(layerId),
    },
  });
  return {
    layer,
    viewer,
    overlay,
    owners,
    click: (id) => {
      pickResult = id ? { id: { id } } : null;
      click({ position: { x: 1, y: 1 } });
    },
    get fetches() {
      return fetches;
    },
  };
}

test('an enabled layer draws one marker and one minute label per crossing', async () => {
  const h = harness();
  h.layer.init(h.viewer);
  assert.equal(h.layer.id, 'border-waits');
  assert.equal(
    await h.layer.update(),
    false,
    'a disabled layer does not fetch',
  );
  assert.equal(h.fetches, 0);
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  const [dataSource] = h.viewer.dataSources.added;
  assert.equal(dataSource.show, true);
  assert.deepEqual(dataSource.entities.values.map(({ id }) => id).sort(), [
    'border-waits:250407',
    'border-waits:380001',
  ]);
  assert.deepEqual(
    h.overlay.entries.map(({ id, title }) => `${id}:${title}`),
    ['border-waits-label:250407:75 min', 'border-waits-label:380001:5 min'],
  );
  assert.ok(h.overlay.entries.every(({ position }) => position));
  assert.deepEqual(h.layer.getStats(), {
    count: 2,
    lastUpdate: h.layer.getStats().lastUpdate,
    error: null,
    stale: false,
  });
  const legend = h.layer.getRowControls().legend;
  assert.deepEqual(
    legend.map(({ label, count }) => `${label}:${count}`),
    [
      'Under 15 min:1',
      '15–29 min:0',
      '30–59 min:0',
      '60 min or more:1',
      'Closed:0',
      'No wait reported:0',
    ],
  );
});

test('clicking a crossing opens its card; clicking empty space closes it', async () => {
  const h = harness();
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.owners.get('border-waits')('border-waits:380001'), true);
  assert.equal(h.owners.get('border-waits')('border-waits:999999'), false);

  h.click('border-waits:380001');
  const card = h.overlay.entries.at(-1);
  assert.equal(card.id, 'border-waits-card:380001');
  assert.equal(card.title, 'BORDER · Detroit · Ambassador Bridge');
  assert.ok(card.position);

  // A sibling layer's pick leaves the selection alone.
  h.owners.set('flights', (id) => id === 'aircraft:abc');
  h.click('aircraft:abc');
  assert.equal(h.overlay.entries.at(-1).id, 'border-waits-card:380001');

  h.click(null);
  assert.ok(
    h.overlay.entries.every(({ id }) => !id.startsWith('border-waits-card:')),
  );
});

test('a stale refresh keeps the markers and labels the open card', async () => {
  const h = harness({
    snapshots: [
      { rows: ROWS, stale: false },
      { rows: ROWS, stale: true },
    ],
  });
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update();
  h.click('border-waits:250407');
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().error, null);
  assert.equal(
    h.overlay.entries.at(-1).details.at(-1),
    'CBP unreachable · showing the last update',
  );
});

test('a failed refresh reports an error and keeps the last crossings', async () => {
  const h = harness({
    snapshots: [{ rows: ROWS, stale: false }, new Error('CBP HTTP 502')],
  });
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update();
  assert.equal(await h.layer.update(), false);
  assert.equal(h.layer.getStats().error, 'CBP HTTP 502');
  assert.equal(h.viewer.dataSources.added[0].entities.values.length, 2);
});

test('disable and destroy release the click handler, pick owner and overlay', async () => {
  const h = harness();
  h.layer.init(h.viewer);
  h.layer.enable();
  await h.layer.update();
  h.click('border-waits:380001');
  h.layer.disable();
  assert.equal(h.owners.has('border-waits'), false);
  assert.equal(h.overlay.entries, null);
  assert.equal(h.overlay.visible, false);
  assert.equal(h.viewer.dataSources.added[0].show, false);
  assert.deepEqual(h.layer.getAnalystRecords(), []);

  h.layer.enable();
  await h.layer.update();
  assert.deepEqual(
    h.layer
      .getAnalystRecords()
      .map(({ id, delayMinutes }) => [id, delayMinutes]),
    [
      ['380001', 5],
      ['250407', 75],
    ],
  );
  h.layer.destroy();
  assert.equal(h.viewer.dataSources.added.length, 0);
  assert.equal(h.owners.has('border-waits'), false);
  assert.equal(h.layer.getStats().count, 0);
  assert.throws(() => createBorderWaitsLayer({}), /snapshot source/);
});
