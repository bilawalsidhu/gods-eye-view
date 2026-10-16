import test from 'node:test';
import assert from 'node:assert/strict';
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
      googleSearchRequested: true,
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
          loadArea: () => ({ box, coverage: {} }),
          clearUnavailableRetry() {},
          scheduleUnavailableRetry() {},
        },
        model: { installationWithinViewport: () => true },
        rendering: { renderRecords() {}, warmInstallationFloors() {} },
      },
    });
    await ingestion.loadInstallations();
    assert.equal(searches.length, 1);
    const { latitude, longitude, radiusM } = searches[0];
    assert.ok(Math.abs(latitude + 16.9) < 1e-9);
    assert.ok(Math.abs(longitude - centre) < 1e-9, `longitude ${longitude}`);
    // The width, not the height, sets the radius.
    assert.equal(radiusM, 22000);
  });
