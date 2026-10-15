import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsgsWaterLayer } from 'gods-eye-view/layers/usgs-water';
import { usgsWaterFixtures } from '../../../scripts/qa-usgs-water-fixtures.mjs';

const NOW = Date.UTC(2026, 9, 11, 18);
const snapshot = () => {
  const f = usgsWaterFixtures(NOW);
  return {
    observations: f.observations.map((r) => ({ id: r.id, ...r.properties })),
    stations: f.stations.map((r) => ({
      ...r.properties,
      lon: r.geometry.coordinates[0],
      lat: r.geometry.coordinates[1],
    })),
    series: f.series.map((r) => ({ ...r.properties })),
    fetchedAt: NOW,
  };
};
function harness(
  source = { getSnapshot: async () => snapshot() },
  overrides = {},
) {
  const renderers = [],
    cards = [],
    handlers = [];
  const viewer = { scene: { requestRender() {}, pick: () => null } };
  const layer = createUsgsWaterLayer({
    source,
    rendererFactory() {
      const renderer = {
        destroyed: false,
        replace(rows) {
          this.rows = rows;
        },
        setVisible() {},
        destroy() {
          this.destroyed = true;
        },
      };
      renderers.push(renderer);
      return renderer;
    },
    overlayHost: {
      setEntries(_id, entries) {
        cards.push(entries);
      },
      clearSource() {
        cards.push([]);
      },
      setVisible() {},
      hitTest: () => null,
    },
    picking: { resolvePickId: (p) => p?.id, isOwnedByOtherLayer: () => false },
    handlerFactory() {
      const h = {
        setInputAction(fn) {
          this.fn = fn;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      handlers.push(h);
      return h;
    },
    ...overrides,
  });
  layer.init(viewer);
  return { layer, viewer, renderers, cards, handlers };
}

test('one marker per site includes a null-only station, and disable fully releases display before cached re-enable', async () => {
  let calls = 0;
  const h = harness({
    getSnapshot: async () => {
      calls++;
      return snapshot();
    },
  });
  assert.equal(calls, 0);
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.renderers[0].rows.length, 2);
  assert.equal(h.layer.getStats().readingCount, 7);
  assert.equal(h.layer.getStats().numericReadingCount, 3);
  h.layer.disable();
  assert.equal(h.renderers[0].destroyed, true);
  assert.equal(h.handlers[0].destroyed, true);
  assert.equal(h.layer.getStats().count, 0);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getStats().count, 2);
  h.layer.destroy();
  assert.equal(h.layer.enable(), false);
});

test('failed refresh keeps stale sites and their original retrieval/measurement times', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail)
        throw Object.assign(new Error('USGS HTTP 429'), {
          retryAt: NOW + 60000,
        });
      return snapshot();
    },
  });
  h.layer.enable();
  await h.layer.update();
  fail = true;
  assert.equal(await h.layer.update(), false);
  const stats = h.layer.getStats();
  assert.equal(stats.stale, true);
  assert.equal(stats.count, 2);
  assert.equal(stats.lastUpdate, NOW);
  assert.equal(stats.retryAt, NOW + 60000);
  assert.equal(h.renderers[0].destroyed, false);
  h.layer.destroy();
});

test('county filter has no acquisition, selection controls expose every same-parameter series and fixed station link', async () => {
  let calls = 0;
  const opened = [];
  const h = harness(
    {
      getSnapshot: async () => {
        calls++;
        return snapshot();
      },
    },
    { openExternal: (url) => opened.push(url) },
  );
  h.layer.enable();
  await h.layer.update();
  h.viewer.scene.pick = () => ({ id: 'USGS-08100001' });
  h.handlers[0].fn({ position: { x: 10, y: 20 } });
  assert.equal(h.cards.at(-1)[0].title, 'QA Creek');
  const visited = new Set();
  for (let i = 0; i < 4; i++) {
    visited.add(h.cards.at(-1)[0].details.find((l) => l.startsWith('Series:')));
    await h.layer.setParams({ readingStep: 1 });
  }
  assert.equal(visited.size, 4);
  h.cards.at(-1)[0].activate();
  assert.deepEqual(opened, [
    'https://waterdata.usgs.gov/monitoring-location/USGS-08100001/',
  ]);
  await h.layer.setParams({ county: 'bexar' });
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getStats().readingCount, 4);
  assert.equal(h.layer.getStats().selectedId, null);
  assert.equal(calls, 1);
  await h.layer.setParams({ county: 'all' });
  assert.equal(h.layer.getStats().count, 2);
  h.layer.destroy();
});

test('disable aborts acquisition and late completion cannot reintroduce sites', async () => {
  let resolve, signal;
  const h = harness({
    getSnapshot: (request) => {
      signal = request.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  h.layer.enable();
  const loading = h.layer.update();
  h.layer.disable();
  assert.equal(signal.aborted, true);
  resolve(snapshot());
  assert.equal(await loading, false);
  assert.equal(h.renderers.length, 0);
});

test('caller cancellation during deferred renderer installation releases owned resources', async () => {
  let settle, enter;
  const entered = new Promise((r) => {
    enter = r;
  });
  const pending = {
    destroyed: false,
    replace() {
      enter();
      return new Promise((r) => {
        settle = r;
      });
    },
    setVisible() {
      assert.fail('cancelled display cannot become visible');
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const h = harness(undefined, { rendererFactory: () => pending });
  h.layer.enable();
  const controller = new AbortController();
  const loading = h.layer.update(h.viewer, { signal: controller.signal });
  await entered;
  controller.abort();
  assert.equal(pending.destroyed, true);
  settle();
  assert.equal(await loading, false);
  assert.equal(h.layer.getStats().count, 0);
  h.layer.destroy();
});
