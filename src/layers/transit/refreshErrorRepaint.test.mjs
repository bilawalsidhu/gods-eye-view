// Transit: a manager tick that failed over Boston must not keep its error on
// the row the coverage repaint draws after the camera leaves for London.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createViewport } from './viewport.js';
import { createQueries } from './queries.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import { LayerPanel, layerFeedState } from '../../ui/layerPanel.js';

const rad = Math.PI / 180;
const LONDON = { lat: 51.5072, lon: -0.1276 };
const BOSTON = { lat: 42.3601, lon: -71.0589 };

function viewer(at, height) {
  return {
    camera: {
      positionCartographic: {
        height,
        latitude: at.lat * rad,
        longitude: at.lon * rad,
      },
      computeViewRectangle: () => undefined,
    },
    scene: { globe: {} },
  };
}

test('leaving a feed whose tick failed repaints its error away', async () => {
  const services = {
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
    render: { governorRequestRender() {} },
  };
  const state = createState({ services });
  const feedStatus = (feedId) => {
    if (!state._feedStatus.has(feedId))
      state._feedStatus.set(feedId, { count: 0, error: null, loading: false });
    return state._feedStatus.get(feedId);
  };
  const parts = {
    ingestion: {
      feedStatus,
      // As pollFeed's catch does when the proxy answers 503.
      pollFeed(feed) {
        Object.assign(feedStatus(feed.id), {
          error: `${feed.name} feed unavailable`,
          loading: false,
        });
        return Promise.resolve();
      },
      removeFeedVehicles() {},
      sweepAgedVehicles() {},
    },
    rendering: { requestVisibility() {}, syncRenderHold() {} },
  };
  parts.viewport = createViewport({ state, services, parts });
  const queries = createQueries({ state, parts }).methods;
  state._enabled = true;

  const lifecycle = new LayerLifecycle(null);
  lifecycle.register({
    id: 'transit',
    name: 'Transit',
    source: 'GTFS-RT',
    getStats: () => queries.getStats(),
    async update() {},
  });
  const entry = lifecycle.layers.get('transit');
  entry.enabled = true;
  entry.lifecycleState = 'enabled';
  entry.initialized = true;

  const row = () => {
    const layer = lifecycle.getAll()[0];
    return `${layerFeedState(layer.stats)} | ${LayerPanel.prototype._buildMetaText(layer)}`;
  };
  const painted = [];
  state._dataManager = {
    refreshLayerStats(layerId) {
      lifecycle.refreshLayerStats(layerId);
      painted.push(row());
    },
  };

  state._viewer = viewer(BOSTON, 4_000);
  parts.viewport.runProximityCheck();
  await lifecycle.refreshLayer('transit');
  assert.match(row(), /feed unavailable/, 'the tick recorded the failure');

  const before = painted.length;
  state._viewer = viewer(LONDON, 4_000);
  parts.viewport.runProximityCheck();
  assert.equal(queries.getStats().status, 'zoom-in');
  assert.ok(painted.length > before, 'leaving Boston repainted the row');
  assert.doesNotMatch(painted.at(-1), /feed unavailable/);
});
