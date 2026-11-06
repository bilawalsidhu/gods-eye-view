// BIKESHARE COVERAGE STATUS — a view with no system says so.
//
// With no system in range (London, Tokyo) the layer says why instead of
// "never", and keeps no date for data it no longer draws.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createControls } from './controls.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { GBFS_CITY_REGISTRY } from './registry.js';

const LONDON = { lat: 51.5072, lon: -0.1276 };

function makeLayer() {
  const services = {
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
    render: { governorRequestRender() {} },
  };
  const state = createState({ services });
  const parts = {
    queries: { collectDetectableStations: () => [] },
    model: createModel({ state, services, parts: {}, source: null }),
    ingestion: { abortInFlight() {} },
    rendering: { removeCityPoints() {} },
  };
  parts.viewport = createViewport({ state, services, parts, source: null });
  const { methods } = createControls({ state, services, parts, source: {} });
  state._enabled = true;
  return { state, methods, viewport: parts.viewport };
}

/** A viewer looking straight down at `at` from `height` metres. */
function viewerAt(at, height) {
  const rad = Math.PI / 180;
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

test('above the altitude gate the row says how low to fly', async () => {
  const { state, methods, viewport } = makeLayer();
  state._viewer = viewerAt(LONDON, 2_000_000);
  await viewport.runProximityCheck();

  const stats = methods.getStats();
  assert.equal(stats.status, 'zoom-in');
  assert.equal(stats.statusMessage, 'Fly below 48 km to a covered city');
  assert.equal(stats.error, undefined);
});

test('a city with no system says so and counts the ones there are', async () => {
  const { state, methods, viewport } = makeLayer();
  state._viewer = viewerAt(LONDON, 8_000);
  await viewport.runProximityCheck();

  const stats = methods.getStats();
  assert.equal(stats.status, 'zoom-in');
  assert.equal(
    stats.statusMessage,
    `No bike share here yet · ${GBFS_CITY_REGISTRY.length} systems available`,
  );
  assert.equal(stats.count, 0);
});

test('a city with a system in range is not given the prompt', () => {
  const { state, methods } = makeLayer();
  state._altitudeGateEnabled = true;
  state._activeCityIds.add('boston-bluebikes');

  assert.equal(methods.getStats().status, undefined);
});

test('a loading or failed city reports itself, not the prompt', () => {
  const { state, methods } = makeLayer();
  state._altitudeGateEnabled = true;
  state._loading = true;
  assert.equal(methods.getStats().status, undefined);

  // A city that failed is dropped from range, and still owns the row.
  state._loading = false;
  state._failedCityIds.add('boston-bluebikes');
  const stats = methods.getStats();
  assert.equal(stats.status, undefined);
  assert.equal(stats.error, 'GBFS fetch error');
});

test('a disabled layer reports no prompt', () => {
  const { state, methods } = makeLayer();
  state._enabled = false;
  assert.equal(methods.getStats().status, undefined);
});

test('leaving every system behind drops the date of the data it drew', async () => {
  for (const height of [8_000, 2_000_000]) {
    const { state, methods, viewport } = makeLayer();
    state._lastUpdate = Date.now();
    // Boston's stations were drawn and dated; the camera moves to London.
    state._activeCityIds.add('boston-bluebikes');
    state._cityRuntime.set('boston-bluebikes', {});
    state._viewer = viewerAt(LONDON, height);
    await viewport.runProximityCheck();

    assert.equal(state._activeCityIds.size, 0);
    assert.equal(methods.getStats().lastUpdate, null, `at ${height} m`);
  }
});
