import test from 'node:test';
import assert from 'node:assert/strict';
import { createAbyssLayer } from './index.js';
import { BATHYMETRY_PRODUCTS } from './model.js';

function createMockViewer() {
  const dataSources = [];
  const imageryLayers = [];

  return {
    dataSources: {
      add: (ds) => dataSources.push(ds),
      remove: (ds) => {
        const idx = dataSources.indexOf(ds);
        if (idx !== -1) dataSources.splice(idx, 1);
      },
    },
    imageryLayers: {
      addImageryProvider: (provider) => {
        const layer = { provider, show: true, alpha: 1 };
        imageryLayers.push(layer);
        return layer;
      },
      remove: (layer) => {
        const idx = imageryLayers.indexOf(layer);
        if (idx !== -1) imageryLayers.splice(idx, 1);
      },
    },
    scene: {
      canvas: {
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      pick: () => null,
    },
    camera: {
      flyTo: () => {},
    },
    _mockDataSources: dataSources,
    _mockImageryLayers: imageryLayers,
  };
}

function createMockSource() {
  return {
    getBathymetryConfig: () => ({
      url: 'https://wms.gebco.net/mapserv?',
      layer: 'GEBCO_LATEST_2',
      format: 'image/jpeg',
      version: '1.3.0',
    }),
    getVentsSnapshot: async () => [
      {
        id: 'vent-1',
        kind: 'vent',
        name: 'Axial Seamount',
        lon: -130.0,
        lat: 45.9,
        activity: 'active',
        depthM: 1500,
        tectonicSetting: 'MOR',
        spreadingRate: 'intermediate',
        source: 'NOAA PMEL',
      },
    ],
    getExpeditionsSnapshot: async () => [
      {
        id: 'dive-1',
        kind: 'dive',
        cruiseDiveId: 'EX1605_D1',
        name: 'Okeanos Dive 1',
        lon: 166.5,
        lat: 19.3,
        platform: 'Deep Discoverer',
        vessel: 'NOAA Ship Okeanos Explorer',
        year: 2016,
        depthM: 3000,
        source: 'NOAA Ocean Exploration',
      },
    ],
    getDiveTrack: async () => ({
      id: 'track-EX1605_D1',
      cruiseDiveId: 'EX1605_D1',
      lengthM: 1200,
      paths: [[[166.5, 19.3], [166.51, 19.31]]],
    }),
  };
}

test('createAbyssLayer exposes expected metadata and defaults', () => {
  const layer = createAbyssLayer({ source: createMockSource() });
  assert.equal(layer.id, 'abyss');
  assert.equal(layer.name, 'ABYSS — Deep Sea');
  assert.equal(layer.icon, '🌊');
  assert.equal(layer.showInTogglePanel, true);
  assert.equal(layer.updateInterval, 300_000);
});

test('createAbyssLayer lifecycle: init, enable, update, disable, destroy', async () => {
  const viewer = createMockViewer();
  const source = createMockSource();
  const layer = createAbyssLayer({
    source,
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: () => {},
      destroy: () => {},
    }),
  });

  layer.init(viewer);
  assert.equal(viewer._mockDataSources.length, 2); // features and dive tracks

  layer.enable(viewer);
  const updated = await layer.update(viewer);
  assert.equal(updated, true);

  const controls = layer.getRowControls();
  assert.ok(controls.summary.stats.includes('2 Exploration Sites'));
  assert.ok(controls.chips.some((c) => c.id === 'bathymetry-toggle'));
  assert.ok(controls.legend.length > 0);

  layer.disable(viewer);
  layer.destroy();
});

test('selecting a different ROV dive clears the previous dive track', async () => {
  const viewer = createMockViewer();
  const source = createMockSource();
  const firstDive = (await source.getExpeditionsSnapshot())[0];
  const secondDive = {
    ...firstDive,
    id: 'dive-2',
    cruiseDiveId: 'EX1605_D2',
    name: 'Okeanos Dive 2',
  };
  const firstTrack = await source.getDiveTrack();
  source.getDiveTrack = async ({ cruiseDiveId }) =>
    cruiseDiveId === firstDive.cruiseDiveId ? firstTrack : null;

  let pickedRecord = firstDive;
  let onClick = null;
  viewer.scene.pick = () => ({ id: { __gevAbyssRecord: pickedRecord } });
  const layer = createAbyssLayer({
    source,
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(action) {
        onClick = action;
      },
      destroy() {},
    }),
  });

  layer.init(viewer);
  layer.enable(viewer);
  const trackEntities = viewer._mockDataSources[1].entities;

  onClick({ position: { x: 10, y: 10 } });
  await Promise.resolve();
  assert.equal(trackEntities.values.length, 1);
  assert.ok(layer.getRowControls().summary.detail.trackLength);

  pickedRecord = secondDive;
  onClick({ position: { x: 10, y: 10 } });
  assert.equal(layer.getSelectedFeature().id, secondDive.id);
  assert.equal(trackEntities.values.length, 0);
  assert.equal(layer.getRowControls().summary.detail.trackLength, null);

  await Promise.resolve();
  assert.equal(trackEntities.values.length, 0);
  layer.destroy();
});

test('createAbyssLayer allows changing params (bathymetry product & subsea filter)', () => {
  const viewer = createMockViewer();
  const source = createMockSource();
  const layer = createAbyssLayer({
    source,
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: () => {},
      destroy: () => {},
    }),
  });

  layer.init(viewer);
  layer.enable(viewer);

  layer.setLayerParams({
    bathymetryProduct: BATHYMETRY_PRODUCTS.SHADED_RELIEF,
    subseaFeaturesFilter: 'vents',
  });

  const params = layer.getParams();
  assert.equal(params.bathymetryProduct, BATHYMETRY_PRODUCTS.SHADED_RELIEF);
  assert.equal(params.subseaFeaturesFilter, 'vents');

  const controls = layer.getRowControls();
  const reliefChip = controls.chips.find((c) => c.id === 'product-relief');
  assert.ok(reliefChip);
  assert.equal(reliefChip.active, true);

  layer.destroy();
});
