import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';
import { createIngestion } from './ingestion.js';

// Taveuni, Fiji: Cesium reports a view across 180° with west > east. Each view
// is 0.4° wide and 0.2° tall; the last one does not cross 180°.
for (const [west, east, centre] of [
  [179.7, -179.9, 179.9],
  [179.9, -179.7, -179.9],
  [179.5, 179.9, 179.7],
])
  test(`a nearby search is centred on the view at ${centre}`, async () => {
    const box = { south: -17, west, north: -16.8, east };
    const searches = [];
    const state = {
      enabled: true,
      viewer: {},
      records: [],
    };
    const ingestion = createIngestion({
      state,
      source: {
        getMappedSites: async () => ({ records: [], wide: true }),
        searchNearby: async (query) => {
          searches.push(query);
          return { places: [] };
        },
      },
      services: {
        render: { governorRequestRender() {} },
        ground: { resolveGroundFloorCellsBounded: async () => {} },
      },
      parts: {
        viewport: {
          loadArea: () => ({ box, coverage: { kind: 'viewport' } }),
          clearUnavailableRetry() {},
          scheduleUnavailableRetry() {},
        },
        model: { installationWithinViewport: () => true },
        rendering: { renderRecords() {}, warmInstallationFloors() {} },
      },
    });
    await ingestion.loadInstallations({ searchPlaces: true });
    assert.equal(searches.length, 1);
    const { latitude, longitude, radiusM } = searches[0];
    assert.ok(Math.abs(latitude + 16.9) < 1e-9);
    assert.ok(Math.abs(longitude - centre) < 1e-9, `longitude ${longitude}`);
    // The width, not the height, sets the radius.
    assert.equal(radiusM, 22000);
  });

test('a withdrawn viewport request cannot send a later position or authorize a retry', async () => {
  const state = { enabled: true, viewer: {}, records: [] };
  const box = { west: 1, east: 1.1, south: 2, north: 2.1 };
  let first = true;
  let placeCalls = 0;
  const ingestion = createIngestion({
    state,
    source: {
      async getMappedSites() {
        if (first) {
          first = false;
          state.contextAnchor = { latitude: 3, longitude: 4 };
          state.abort.abort();
        }
        return { records: [], wide: true };
      },
      async searchNearby() {
        placeCalls++;
        return { places: [] };
      },
    },
    services: {
      render: { governorRequestRender() {} },
      ground: { resolveGroundFloorCellsBounded: async () => {} },
    },
    parts: {
      viewport: {
        loadArea: () => ({
          box,
          coverage: { kind: state.contextAnchor ? 'subject' : 'viewport' },
        }),
        clearUnavailableRetry() {},
        scheduleUnavailableRetry() {},
      },
      rendering: { renderRecords() {}, warmInstallationFloors() {} },
    },
  });
  const { methods } = createControls({
    state,
    parts: { ingestion },
    services: {},
    source: {},
  });
  await methods.searchNearby();
  await ingestion.loadInstallations();
  assert.equal(placeCalls, 0);
});
