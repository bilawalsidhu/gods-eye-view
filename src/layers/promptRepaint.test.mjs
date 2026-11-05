// When the camera changes which coverage prompt a Transit or
// Bike Share row shows, the layer asks the panel to repaint at once, instead
// of leaving the old prompt up until the manager's next tick (Transit 15 s,
// Bike Share 60 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState as createBikeState } from './bikeshare/state.js';
import { createControls as createBikeControls } from './bikeshare/controls.js';
import { createModel as createBikeModel } from './bikeshare/model.js';
import { createViewport as createBikeViewport } from './bikeshare/viewport.js';
import { createState as createTransitState } from './transit/state.js';
import { createViewport as createTransitViewport } from './transit/viewport.js';
import { createQueries as createTransitQueries } from './transit/queries.js';

const rad = Math.PI / 180;
const LONDON = { lat: 51.5072, lon: -0.1276 };
const BOSTON = { lat: 42.3601, lon: -71.0589 };

const services = () => ({
  overlays: {
    setOverlayEntries() {},
    setOverlaySourceVisible() {},
    clearOverlaySource() {},
  },
  render: { governorRequestRender() {} },
});

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

function spyManager() {
  const dm = { repaints: 0 };
  dm.refreshLayerStats = () => {
    dm.repaints++;
  };
  return dm;
}

test('Bike Share: flying from London into Boston repaints the prompt row', async () => {
  const svc = services();
  const state = createBikeState({ services: svc });
  const parts = {
    queries: { collectDetectableStations: () => [] },
    model: createBikeModel({ state, services: svc, parts: {}, source: null }),
    ingestion: {
      abortInFlight() {},
      loadCityStationInfo: async () => new Map(),
      loadCityStationStatus: async () => new Map(),
    },
    rendering: {
      removeCityPoints() {},
      ensureCityPoints() {},
      applyStatusToPoints() {},
    },
  };
  parts.viewport = createBikeViewport({
    state,
    services: svc,
    parts,
    source: null,
  });
  const { methods } = createBikeControls({
    state,
    services: svc,
    parts,
    source: {},
  });
  state._enabled = true;
  const dm = spyManager();
  methods.attachDataManager(dm);

  state._viewer = viewer(LONDON, 8_000);
  await parts.viewport.runProximityCheck();
  assert.equal(methods.getStats().status, 'zoom-in');

  const before = dm.repaints;
  state._viewer = viewer(BOSTON, 3_000);
  await parts.viewport.runProximityCheck();
  assert.equal(methods.getStats().status, undefined, 'Boston is covered');
  assert.ok(dm.repaints > before, 'the row was asked to repaint');
});

test('Transit: leaving Boston for London repaints the row', () => {
  const svc = services();
  const state = createTransitState({ services: svc });
  const parts = {
    ingestion: {
      feedStatus: () => ({ count: 0 }),
      pollFeed() {},
      removeFeedVehicles() {},
      sweepAgedVehicles() {},
    },
    rendering: { requestVisibility() {}, syncRenderHold() {} },
  };
  parts.viewport = createTransitViewport({ state, services: svc, parts });
  const queries = createTransitQueries({ state, parts }).methods;
  state._enabled = true;
  const dm = spyManager();
  state._dataManager = dm;

  state._viewer = viewer(BOSTON, 4_000);
  parts.viewport.runProximityCheck();
  assert.ok(state._activeFeeds.size > 0, 'Boston has a feed');
  state._lastUpdate = Date.now();

  const before = dm.repaints;
  state._viewer = viewer(LONDON, 4_000);
  parts.viewport.runProximityCheck();
  assert.equal(queries.getStats().status, 'zoom-in');
  assert.ok(dm.repaints > before, 'the row was asked to repaint');
});
