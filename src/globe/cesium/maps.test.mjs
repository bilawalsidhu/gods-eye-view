import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { MAP_STACKS } from '../../maps/catalog.js';
import { createDefaultMapSources } from '../../maps/defaultSources.js';
import { ESRI_ATTRIBUTION_HTML } from './mapImagery.js';
import { createCesiumCredits } from './credits.js';
import { createCesiumMaps } from './maps.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

function setup(options = {}) {
  const viewer = createFakeViewer();
  const renders = [];
  const { maps, destroy } = createCesiumMaps(viewer, {
    requestRender: (reason) => renders.push(reason),
    createImageryLayer: (provider) => ({ provider }),
    credits: createCesiumCredits(viewer).credits,
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
  const { viewer, maps, destroy } = setup();
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
  assert.equal(stale.destroyed, false, 'the stale provider stays cached');
  destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stale.destroyed, true, 'destroy disposes cached providers');
});

test('re-applying the same source keeps the live layer and its provider', async () => {
  const { viewer, maps } = setup();
  let built = 0;
  const esri = {
    descriptor: { id: 'esri-imagery', kind: 'esri-imagery' },
    imagery: async () => ({ name: `esri ${++built}` }),
    credit: ESRI_ATTRIBUTION_HTML,
  };
  await maps.setBaseImagery(esri);
  const live = viewer.imageryList[0];
  await maps.setBaseImagery(esri);
  assert.equal(built, 1, 'the provider is cached per source');
  assert.equal(viewer.imageryList[0], live, 'no bare-globe rebuild');
  assert.equal(viewer.callsOf('imageryLayers.add').length, 1);
  assert.equal(viewer.callsOf('imageryLayers.remove').length, 0);
  await maps.setBaseImagery({
    descriptor: { id: 'osm', kind: 'osm' },
    imagery: () => ({ name: 'osm' }),
  });
  await maps.setBaseImagery(esri);
  assert.equal(built, 1);
  assert.equal(viewer.imageryList[0].provider.name, 'esri 1');
});

test('a failed provider keeps the current layer and can be retried', async () => {
  const { viewer, maps } = setup();
  await maps.setBaseImagery({
    descriptor: { id: 'osm', kind: 'osm' },
    imagery: () => ({ name: 'osm' }),
  });
  let attempts = 0;
  const flaky = {
    descriptor: { id: 'esri-imagery', kind: 'esri-imagery' },
    imagery: async () => {
      if (++attempts === 1) throw new Error('Esri metadata refused');
      return { name: 'esri' };
    },
    credit: ESRI_ATTRIBUTION_HTML,
  };
  await assert.rejects(maps.setBaseImagery(flaky), /metadata refused/);
  assert.deepEqual(
    viewer.imageryList.map((layer) => layer.provider.name),
    ['osm'],
  );
  assert.deepEqual(viewer.staticCredits, []);
  await maps.setBaseImagery(flaky);
  assert.equal(attempts, 2, 'the failure was not cached');
  assert.equal(viewer.imageryList[0].provider.name, 'esri');
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

test('terrainRevision counts every terrain the globe takes', async () => {
  const { viewer, maps, destroy } = setup();
  assert.equal(maps.terrainRevision(), 0);
  await maps.setTerrain({ kind: 'ellipsoid' });
  assert.equal(maps.terrainRevision(), 1);
  // A fallback applied by other code counts too.
  viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  assert.equal(maps.terrainRevision(), 2);
  destroy();
  viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  assert.equal(maps.terrainRevision(), 2, 'not counted after destroy');
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

const esriSource = (provider = { name: 'esri' }) => ({
  descriptor: { id: 'esri-imagery', kind: 'esri-imagery' },
  imagery: () => provider,
  credit: ESRI_ATTRIBUTION_HTML,
});
const credits = (viewer) => viewer.staticCredits.map((credit) => credit.html);

test('setPhotorealTiles(null) clears the photoreal credit and restores the base imagery', async () => {
  const { viewer, maps } = setup();
  const provider = { name: 'esri' };
  await maps.setBaseImagery(esriSource(provider));
  await maps.setPhotorealTiles({ tileset: tileset(), credit: 'Google' });
  assert.deepEqual(viewer.imageryList, []);
  assert.deepEqual(credits(viewer), ['Google']);
  await maps.setPhotorealTiles(null);
  assert.deepEqual(viewer.imageryList, [{ provider }], 'base layer back');
  assert.deepEqual(credits(viewer), [ESRI_ATTRIBUTION_HTML]);
  assert.equal(viewer.scene.globe.show, true);
});

test('setPhotorealTiles(null) before any base imagery shows no credit', async () => {
  const { viewer, maps } = setup();
  await maps.setPhotorealTiles({ tileset: tileset(), credit: 'Google' });
  await maps.setPhotorealTiles(null);
  assert.deepEqual(credits(viewer), []);
  assert.deepEqual(viewer.imageryList, []);
});

test('base imagery then setPhotorealTiles(null) keeps the base layer and its credit', async () => {
  const { viewer, maps } = setup();
  const provider = { name: 'esri' };
  await maps.setPhotorealTiles({ tileset: tileset(), credit: 'Google' });
  await maps.setBaseImagery(esriSource(provider));
  await maps.setPhotorealTiles(null);
  assert.deepEqual(viewer.imageryList, [{ provider }]);
  assert.equal(viewer.callsOf('imageryLayers.add').length, 1, 'not rebuilt');
  assert.deepEqual(credits(viewer), [ESRI_ATTRIBUTION_HTML]);
});

test('a newer photoreal switch supersedes a pending imagery switch', async () => {
  const { viewer, maps } = setup();
  let resolve;
  const pending = maps.setBaseImagery({
    descriptor: { id: 'slow', kind: 'osm' },
    imagery: () => new Promise((done) => (resolve = done)),
    credit: 'slow credit',
  });
  await maps.setPhotorealTiles({ tileset: tileset(), credit: 'Google' });
  resolve({ name: 'slow' });
  await pending;
  assert.deepEqual(viewer.imageryList, []);
  assert.deepEqual(credits(viewer), ['Google']);
  assert.equal(viewer.scene.globe.show, false);
});

test('switching between two tilesets hides the one shown before', async () => {
  const { maps } = setup();
  const first = tileset();
  const second = tileset();
  await maps.setPhotorealTiles({ tileset: first });
  await maps.setPhotorealTiles({ tileset: second });
  assert.equal(first.show, false);
  assert.equal(second.show, true);
  await maps.setPhotorealTiles(null);
  assert.equal(second.show, false);
});

test('a source with a ready provider is shown as is and stays its caller’s', async () => {
  const { viewer, maps, destroy } = setup();
  let destroyed = 0;
  const provider = { name: 'owned', destroy: () => destroyed++ };
  const source = {
    descriptor: { id: 'osm', kind: 'osm' },
    provider,
    credit: 'c',
  };
  await maps.setBaseImagery(source);
  assert.deepEqual(viewer.imageryList, [{ provider }]);
  const other = { name: 'other' };
  await maps.setBaseImagery({ ...source, provider: other });
  assert.deepEqual(
    viewer.imageryList,
    [{ provider: other }],
    'not cached by id',
  );
  destroy();
  assert.equal(destroyed, 0, 'the engine does not dispose a caller provider');
});

test('releasePhotorealTiles forgets a tileset and removes it from the scene', async () => {
  const { viewer, maps } = setup();
  const owned = tileset();
  await maps.setPhotorealTiles({ tileset: owned });
  await maps.setPhotorealTiles(null);
  maps.releasePhotorealTiles({ tileset: owned });
  assert.equal(viewer.primitiveList.includes(owned), false);
  assert.equal(maps.photorealActive(), false);
  owned.show = true;
  assert.equal(
    maps.photorealActive(),
    false,
    'no longer one of the engine tilesets',
  );
  maps.releasePhotorealTiles({ tileset: owned });
  assert.equal(viewer.callsOf('primitives.remove').length, 1, 'idempotent');
});

test('releasePhotorealTiles leaves a tileset the engine did not add in the scene', async () => {
  const { viewer, maps } = setup();
  const startup = tileset(true);
  viewer.primitiveList.push(startup);
  await maps.setPhotorealTiles({ tileset: startup });
  maps.releasePhotorealTiles({ tileset: startup });
  assert.equal(viewer.primitiveList.includes(startup), true);
});

test('current names the sources on screen as passed', async () => {
  const { maps } = setup();
  assert.deepEqual(maps.current(), { baseImagery: null, photoreal: null });
  const esri = esriSource();
  const tiles = { tileset: tileset(), credit: 'Google' };
  await maps.setBaseImagery(esri);
  assert.deepEqual(maps.current(), { baseImagery: esri, photoreal: null });
  await maps.setPhotorealTiles(tiles);
  assert.equal(maps.current().photoreal, tiles);
  assert.equal(maps.current().baseImagery, null);
  await maps.setPhotorealTiles(null);
  assert.equal(maps.current().baseImagery, esri);
  assert.equal(maps.current().photoreal, null);
  await maps.setPhotorealTiles(tiles);
  maps.releasePhotorealTiles(tiles);
  assert.equal(maps.current().photoreal, null, 'a released source is gone');
});

test('maps.errors bridges terrain failures, follows fallback providers and detaches on destroy', async () => {
  const { viewer, maps, destroy } = setup();
  const failures = [];
  maps.errors.addEventListener((error) => failures.push(error));
  const first = { errorEvent: new Cesium.Event() };
  const source = { kind: 'keyless', create: () => ({ provider: first }) };
  await maps.setTerrain(source);
  const revision = maps.terrainRevision();
  first.errorEvent.raiseEvent({ error: { statusCode: 503 } });
  assert.deepEqual(failures, [{ source, kind: 'terrain', status: 503 }]);
  const fallback = { errorEvent: new Cesium.Event() };
  viewer.terrainProvider = fallback;
  assert.ok(maps.terrainRevision() > revision);
  first.errorEvent.raiseEvent({ statusCode: 401 });
  fallback.errorEvent.raiseEvent({ statusCode: 429 });
  assert.deepEqual(failures, [
    { source, kind: 'terrain', status: 503 },
    { source, kind: 'terrain', status: 429 },
  ]);
  destroy();
  assert.equal(first.errorEvent.numberOfListeners, 0);
  assert.equal(fallback.errorEvent.numberOfListeners, 0);
});
