import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import * as picking from '../../data/pickRegistry.js';
import { createAirAccidentsLayer, markerPixelSize } from './index.js';

const accident = (id, extra = {}) => ({
  id,
  name: id,
  lat: 10,
  lon: 20,
  date: '1990-01-01',
  fatalities: null,
  approximate: false,
  ...extra,
});

const snapshot = (records, extra = {}) => ({
  records,
  fetchedAt: 1,
  complete: true,
  ...extra,
});

function harness(snapshots) {
  const cards = [];
  const handlers = [];
  let pickResult = null;
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const queue = [...snapshots];
  const layer = createAirAccidentsLayer({
    source: { getSnapshot: () => Promise.resolve(queue.shift()) },
    overlayHost: {
      setEntries: (_source, entries) => cards.push(entries),
      setVisible() {},
      hitTest: () => null,
    },
    input: () => ({
      onClick(callback) {
        const handler = {
          click: () =>
            callback({
              screenPosition: { x: 1, y: 1 },
              topHit: pickResult
                ? { set: 'air-accidents:markers', id: pickResult }
                : null,
            }),
          removed: false,
        };
        handlers.push(handler);
        return () => {
          handler.removed = true;
        };
      },
    }),
    picking,
    pointer: { isPointerFree: () => true },
    openExternal: () => {},
  });
  layer.init(viewer);
  const set = () => draw.find('air-accidents:markers');
  return {
    layer,
    set,
    items: () => {
      const s = set();
      return s && !s.disposed ? [...s.items.values()] : [];
    },
    handlers,
    cards,
    pick(id) {
      pickResult = id ? `air-accident:${id}` : null;
    },
  };
}

test('markers live in one draw set, shown only while the layer is on', async () => {
  const h = harness([snapshot([accident('Q1'), accident('Q2')])]);
  assert.ok(h.set());
  assert.equal(h.set().show, false);
  h.layer.enable();
  assert.equal(h.set().show, true);
  assert.equal(await h.layer.update(), true);
  assert.equal(h.items().length, 2);
  h.layer.disable();
  assert.equal(h.set().show, false);
  assert.equal(h.handlers[0].removed, true);
  h.layer.destroy();
  assert.equal(h.set(), undefined, 'the set is disposed');
});

test('markers grow with the toll, the worst drawn last, over terrain', async () => {
  const h = harness([
    snapshot([
      accident('Q1', { fatalities: 300 }),
      accident('Q2', { fatalities: 2 }),
    ]),
  ]);
  h.layer.enable();
  await h.layer.update();
  const items = h.items();
  assert.deepEqual(
    items.map((item) => item.id),
    ['air-accident:Q2', 'air-accident:Q1'],
  );
  const size = markerPixelSize(300);
  assert.deepEqual(items[1].size, [size, size]);
  assert.equal(items[1].disableDepthTest, Number.POSITIVE_INFINITY);
});

test('the period filter hides markers outside it', async () => {
  const h = harness([
    snapshot([
      accident('Q1', { date: '1950-01-01' }),
      accident('Q2', { date: '2000-01-01' }),
    ]),
  ]);
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ from: 1990, to: 2010 });
  const shown = Object.fromEntries(
    h.items().map((item) => [item.id, item.show]),
  );
  assert.deepEqual(shown, {
    'air-accident:Q1': false,
    'air-accident:Q2': true,
  });
  assert.equal(h.layer.getStats().count, 1);
});

test('a click on a marker opens its card; a click on nothing closes it', async () => {
  const h = harness([snapshot([accident('Q1')])]);
  h.layer.enable();
  await h.layer.update();
  h.pick('Q1');
  h.handlers[0].click();
  assert.equal(h.cards.at(-1)[0].id, 'air-accident-card:Q1');
  h.pick(null);
  h.handlers[0].click();
  assert.deepEqual(h.cards.at(-1), []);
  h.layer.destroy();
});
