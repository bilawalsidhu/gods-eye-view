import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { createCesiumSurface } from './surface.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

function setup() {
  const viewer = createFakeViewer();
  const { surface } = createCesiumSurface(viewer);
  return { viewer, surface, scene: viewer.scene };
}

test('sampleHeight forwards the point and exclusions to the scene', () => {
  const { viewer, surface, scene } = setup();
  const place = geo.cartographic.fromDegrees(20, 10, 0);
  const exclude = [{ primitive: 1 }];
  assert.equal(surface.sampleHeight(place, exclude), 42);
  const [position, excluded] = viewer.callsOf('scene.sampleHeight')[0].args;
  assert.equal(position.longitude, place.longitude);
  assert.equal(position.latitude, place.latitude);
  assert.equal(excluded, exclude);
  scene.sampleHeight = () => undefined;
  assert.equal(surface.sampleHeight(place), undefined);
  scene.sampleHeight = () => NaN;
  assert.equal(surface.sampleHeight(place), undefined);
  scene.sampleHeight = () => {
    throw new Error('sampleHeight unsupported');
  };
  assert.equal(surface.sampleHeight(place), undefined, 'a throw is a miss');
});

test('supported flags follow the scene', () => {
  const { surface, scene } = setup();
  assert.equal(surface.supported, true);
  assert.equal(surface.clampToHeightSupported, true);
  assert.equal(surface.terrainHeightSupported, true);
  scene.sampleHeightSupported = false;
  scene.clampToHeightSupported = false;
  scene.globe = undefined;
  assert.equal(surface.supported, false);
  assert.equal(surface.clampToHeightSupported, false);
  assert.equal(surface.terrainHeightSupported, false);
  const place = geo.cartographic.fromDegrees(20, 10, 0);
  assert.equal(surface.sampleHeight(place), undefined);
  assert.equal(surface.terrainHeight(place), undefined);
  assert.equal(
    surface.clampToHeight(geo.cartesian3.fromDegrees(20, 10, 10)),
    undefined,
  );
});

test('terrainHeight asks the globe', () => {
  const { viewer, surface, scene } = setup();
  const place = geo.cartographic.fromDegrees(20, 10, 0);
  assert.equal(surface.terrainHeight(place), 12.5);
  assert.equal(viewer.callsOf('globe.getHeight')[0].args[0], place);
  scene.globe.getHeight = () => undefined;
  assert.equal(surface.terrainHeight(place), undefined);
});

test('sampleTerrainMostDetailed: 0 on the ellipsoid; a terrain without availability rejects', async () => {
  const { surface, scene } = setup();
  const place = geo.cartographic.fromDegrees(85.9, 27.9, 0);
  scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  assert.deepEqual(
    await surface.sampleTerrainMostDetailed([place, place]),
    [0, 0],
  );
  scene.terrainProvider = { availability: undefined };
  await assert.rejects(
    surface.sampleTerrainMostDetailed([place]),
    /no tile availability/,
  );
});

test('clampToHeight returns a geo value', () => {
  const { viewer, surface } = setup();
  const exclude = [];
  const clamped = surface.clampToHeight(
    geo.cartesian3.fromDegrees(20, 10, 5000),
    exclude,
  );
  assert.ok(!(clamped instanceof Cesium.Cartesian3));
  assert.equal(clamped.x, 6378200);
  assert.equal(viewer.callsOf('scene.clampToHeight')[0].args[1], exclude);
});

test('tilesLoaded follows the first visible tileset, else the shown globe', () => {
  const { viewer, surface, scene } = setup();
  assert.equal(surface.tilesLoaded(), true, 'globe loaded');
  scene.globe.tilesLoaded = false;
  assert.equal(surface.tilesLoaded(), false, 'globe streaming');
  scene.globe.show = false;
  assert.equal(surface.tilesLoaded(), true, 'nothing streams');
  const tileset = { show: true, tilesLoaded: false };
  viewer.primitiveList.push({ show: true }, tileset);
  assert.equal(surface.tilesLoaded(), false);
  tileset.tilesLoaded = true;
  assert.equal(surface.tilesLoaded(), true);
});

test('sampleHeightDetailed: tiles from sampleHeight, else terrain; no tile size', () => {
  const { surface, scene } = setup();
  const place = geo.cartographic.fromDegrees(20, 10, 0);
  assert.deepEqual(surface.sampleHeightDetailed(place), {
    height: 42,
    source: 'tiles',
  });
  scene.sampleHeight = () => undefined;
  assert.deepEqual(surface.sampleHeightDetailed(place), {
    height: 12.5,
    source: 'terrain',
  });
  assert.throws(
    () => surface.sampleHeightDetailed(place, { exclude: 'x' }),
    TypeError,
  );
});

test('an engine mover set in exclude is hidden for the sample, native objects pass', () => {
  const viewer = createFakeViewer();
  const collection = { show: true };
  const set = { id: 'flights' };
  const { surface } = createCesiumSurface(viewer, {
    engineExclude: (entry) => (entry === set ? collection : null),
  });
  const shownDuring = [];
  viewer.scene.sampleHeight = (position, excluded) => {
    shownDuring.push(collection.show, excluded);
    return 30;
  };
  const native = { primitive: 1 };
  const place = geo.cartographic.fromDegrees(20, 10, 0);
  assert.equal(surface.sampleHeight(place, [set, native]), 30);
  assert.deepEqual(shownDuring, [false, [native]]);
  assert.equal(collection.show, true, 'shown again after the sample');
  shownDuring.length = 0;
  surface.sampleHeightDetailed(place, { exclude: [set] });
  assert.deepEqual(shownDuring, [false, []]);
  assert.equal(collection.show, true);
  // clampToHeight too, and a throwing scene still shows the set again.
  viewer.scene.clampToHeight = (position, excluded) => {
    shownDuring.push(collection.show, excluded);
    throw new Error('no depth texture');
  };
  shownDuring.length = 0;
  assert.equal(
    surface.clampToHeight(geo.cartesian3.fromDegrees(20, 10, 0), [set]),
    undefined,
  );
  assert.deepEqual(shownDuring, [false, []]);
  assert.equal(collection.show, true);
});
