import test from 'node:test';
import assert from 'node:assert/strict';
import { GeoDataPlotter } from './geoDataPlotter.js';

test('GeoDataPlotter parses GeoJSON and CSV, styles with holographics and notifies AI', async () => {
  const addedDataSources = [];
  const removedDataSources = [];
  let zoomTarget = null;

  globalThis.Cesium = {
    Color: {
      fromCssColorString: (str) => ({ str }),
    },
    GeoJsonDataSource: {
      load: async (data, opts) => ({
        _data: data,
        _opts: opts,
      }),
    },
  };

  const mockViewer = {
    dataSources: {
      add: (ds) => addedDataSources.push(ds),
      remove: (ds) => removedDataSources.push(ds),
    },
    zoomTo: (ds) => {
      zoomTarget = ds;
    },
  };

  const messages = [];
  const mockAi = {
    appendMessage: (role, msg) => messages.push({ role, msg }),
  };

  const cues = [];
  const plotter = new GeoDataPlotter({
    viewer: mockViewer,
    aiController: mockAi,
    documentRef: { addEventListener: () => {}, removeEventListener: () => {} },
    playCue: (cue) => cues.push(cue),
  });

  // 1. Plot GeoJSON string
  const geoJsonSample = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.75, 35.68] },
        properties: { name: 'Tokyo Outpost' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [139.77, 35.69] },
        properties: { name: 'Akihabara Station' },
      },
    ],
  });

  const resGeo = await plotter.plotText(geoJsonSample, {
    name: 'Tokyo Targets',
    ext: 'geojson',
  });
  assert.equal(resGeo.ok, true);
  assert.equal(resGeo.featureCount, 2);
  assert.equal(addedDataSources.length, 1);
  assert.equal(cues.includes('data'), true);
  assert.ok(messages.some((m) => m.msg.includes('Tokyo Targets')));

  // 2. Plot CSV string
  const csvSample = `name,lat,lon,type
Yokohama Port,35.44,139.64,maritime
Haneda Airport,35.54,139.77,aviation`;

  const resCsv = await plotter.plotText(csvSample, {
    name: 'Kanto Hubs.csv',
    ext: 'csv',
  });
  assert.equal(resCsv.ok, true);
  assert.equal(addedDataSources.length, 2);
  assert.equal(resCsv.featureCount, 2);
  assert.ok(messages.some((m) => m.msg.includes('Kanto Hubs')));

  // 3. Clear all plotted datasets
  plotter.clearAll();
  assert.equal(removedDataSources.length, 2);
  assert.ok(
    messages.some((m) => m.msg.includes('Cleared all custom plotted datasets')),
  );
});
