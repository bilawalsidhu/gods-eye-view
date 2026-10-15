import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MAP_STACKS } from '../../maps/catalog.js';
import { createDefaultMapSources } from '../../maps/defaultSources.js';
import { ESRI_ATTRIBUTION_HTML } from '../../maps/imagery.js';
import { createCesiumMaps } from './maps.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

function setup(options = {}) {
  const viewer = createFakeViewer();
  const renders = [];
  const { maps, destroy } = createCesiumMaps(viewer, {
    requestRender: (reason) => renders.push(reason),
    createImageryLayer: (provider) => ({ provider }),
    ...options,
  });
  return { viewer, maps, destroy, renders };
}

const tileset = (show = false) => ({
  show,
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  },
  destroy() {
    this.destroyed = true;
  },
});

test('creation leaves the viewer untouched', () => {
  const { viewer, maps } = setup({ tilesetRef: { current: tileset(true) } });
  assert.deepEqual(viewer.calls, []);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(maps.photorealActive(), true, 'reads the shown tileset');
});

test('setBaseImagery takes a registry source and puts its layer at the bottom', async () => {
  const { viewer, maps, renders } = setup();
  const provider = { name: 'esri' };
  const source = {
    descriptor: { id: 'esri-imagery', kind: 'esri-imagery' },
    imagery: async () => provider,
    credit: ESRI_ATTRIBUTION_HTML,
  };
  viewer.imageryList.push({ name: 'weather overlay' });
  await maps.setBaseImagery(source);
  assert.deepEqual(viewer.imageryList[0], { provider });
  assert.equal(viewer.callsOf('imageryLayers.add')[0].args[1], 0);
  assert.deepEqual(
    viewer.staticCredits.map((credit) => credit.html),
    [ESRI_ATTRIBUTION_HTML],
  );
  assert.ok(renders.length > 0);

  const osmProvider = { name: 'osm' };
  await maps.setBaseImagery({
    descriptor: { id: 'osm', kind: 'osm' },
    imagery: () => osmProvider,
  });
  const [removed, destroyLayer] = viewer.callsOf('imageryLayers.remove')[0]
    .args;
  assert.deepEqual(removed, { provider });
  assert.equal(destroyLayer, true);
  assert.deepEqual(
    viewer.imageryList.map((layer) => layer.provider?.name ?? layer.name),
    ['osm', 'weather overlay'],
  );
  assert.deepEqual(viewer.staticCredits, [], 'the Esri credit leaves with it');
});

test('setBaseImagery builds providers from plain descriptions', async () => {
  const { viewer, maps } = setup();
  await maps.setBaseImagery({ kind: 'osm' });
  assert.ok(
    viewer.imageryList[0].provider instanceof
      Cesium.OpenStreetMapImageryProvider,
  );
  await assert.rejects(
    maps.setBaseImagery({ kind: 'ion', style: 2, accessToken: '' }),
    /explicit token/,
  );
  assert.ok(
    viewer.imageryList[0].provider instanceof
      Cesium.OpenStreetMapImageryProvider,
    'a failed switch keeps the current layer',
  );
});

test('every catalog globe stack works as a registry source', async () => {
  const { viewer, maps } = setup();
  const registry = createDefaultMapSources();
  const osm = registry.sources.find(
    ({ descriptor }) => descriptor.id === 'osm',
  );
  await maps.setBaseImagery(osm);
  assert.ok(
    viewer.imageryList[0].provider instanceof
      Cesium.OpenStreetMapImageryProvider,
  );
  assert.ok(MAP_STACKS.some(({ id }) => id === 'osm'));
});

test('a superseded imagery switch is dropped', async () => {
  const { viewer, maps } = setup();
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  const first = maps.setBaseImagery({
    descriptor: { id: 'slow', kind: 'esri-imagery' },
    imagery: () => slow,
  });
  await maps.setBaseImagery({
    descriptor: { id: 'fast', kind: 'osm' },
    imagery: () => ({ name: 'fast' }),
  });
  const stale = {
    name: 'slow',
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
  release(stale);
  await first;
  assert.deepEqual(
    viewer.imageryList.map((layer) => layer.provider.name),
    ['fast'],
  );
  assert.equal(stale.destroyed, true, 'the stale provider is disposed');
});

test('setTerrain applies provider and terrain results', async () => {
  const { viewer, maps } = setup();
  await maps.setTerrain({ kind: 'ellipsoid' });
  assert.ok(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider);
  const provider = { name: 'keyless' };
  await maps.setTerrain({ id: 'keyless', create: async () => ({ provider }) });
  assert.equal(viewer.terrainProvider, provider);
  const terrain = { name: 'terrain object' };
  await maps.setTerrain({ id: 'world', create: async () => ({ terrain }) });
  assert.equal(viewer.callsOf('scene.setTerrain')[0].args[0], terrain);
  await assert.rejects(
    maps.setTerrain({ kind: 'world', accessToken: ' ' }),
    /explicit ion token/,
  );
});

test('setPhotorealTiles shows a given tileset and hides the globe; null reverses it', async () => {
  const { viewer, maps } = setup();
  const google = tileset();
  await maps.setPhotorealTiles({ tileset: google });
  assert.equal(viewer.primitiveList.includes(google), true);
  assert.equal(google.show, true);
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(maps.photorealActive(), true);
  await maps.setPhotorealTiles(null);
  assert.equal(google.show, false);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(maps.photorealActive(), false);
  await maps.setPhotorealTiles({ tileset: google });
  assert.equal(viewer.callsOf('primitives.add').length, 1, 'added once');
});

test('setPhotorealTiles(null) also hides the startup tileset', async () => {
  const startup = tileset(true);
  const { viewer, maps } = setup({ tilesetRef: () => startup });
  viewer.scene.globe.show = false;
  await maps.setPhotorealTiles(null);
  assert.equal(startup.show, false);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(maps.photorealActive(), false);
  await maps.setPhotorealTiles({ tileset: startup });
  assert.equal(startup.show, true);
  assert.equal(maps.photorealActive(), true);
});

test('setPhotorealTiles loads from credentials and owns the result', async () => {
  const loaded = tileset();
  const requests = [];
  const { viewer, maps, destroy } = setup({
    loadPhotorealTileset: async (credentials) => {
      requests.push(credentials);
      return {
        tileset: requests.length === 1 ? loaded : null,
        errors: [new Error('refused')],
      };
    },
  });
  await maps.setPhotorealTiles({ googleApiKey: 'browser-key' });
  assert.deepEqual(requests[0], { googleApiKey: 'browser-key' });
  assert.equal(loaded.show, true);
  assert.equal(maps.photorealActive(), true);
  await assert.rejects(maps.setPhotorealTiles({ cesiumToken: 'x' }), /refused/);
  assert.equal(loaded.show, true, 'a failed load keeps the current tiles');
  destroy();
  assert.equal(viewer.primitiveList.includes(loaded), false);
  assert.equal(loaded.destroyed, true);
});

test('destroy removes the engine imagery layer and its credit', async () => {
  const { viewer, maps, destroy } = setup();
  await maps.setBaseImagery({
    descriptor: { id: 'esri-imagery', kind: 'esri-imagery' },
    imagery: () => ({ name: 'esri' }),
    credit: ESRI_ATTRIBUTION_HTML,
  });
  destroy();
  assert.deepEqual(viewer.imageryList, []);
  assert.deepEqual(viewer.staticCredits, []);
});
