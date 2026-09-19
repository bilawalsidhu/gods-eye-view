import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverCctvCameras } from './cctvDiscovery.js';
import { CctvControls } from './cctvControls.js';

const cameras = [
  {
    id: 'vancouver',
    city: 'Vancouver',
    name: 'Bridge',
    lat: 49.28,
    lon: -123.12,
  },
  {
    id: 'cape-far',
    city: 'Cape Town',
    name: 'Harbour',
    provider: 'Traffic',
    lat: -33.8,
    lon: 18.5,
  },
  {
    id: 'cape-near',
    city: 'Cape Town',
    name: 'Centre',
    provider: 'Traffic',
    lat: -33.92,
    lon: 18.42,
  },
];
const view = {
  west: 18,
  east: 19,
  south: -34.5,
  north: -33,
  center: { lat: -33.92, lon: 18.42 },
};
test('Cape Town view excludes Vancouver and orders local cameras by distance', () => {
  const found = discoverCctvCameras(cameras, { view });
  assert.deepEqual(
    found.cameras.map((c) => c.id),
    ['cape-near', 'cape-far'],
  );
  assert.equal(found.cameras[0].distanceKm, 0);
  assert.equal(found.localIds.has('vancouver'), false);
});
test('search matches multiple words across city, camera and provider; global scope is explicit', () => {
  assert.deepEqual(
    discoverCctvCameras(cameras, {
      view,
      query: 'CAPE traffic harb',
    }).cameras.map((c) => c.id),
    ['cape-far'],
  );
  assert.equal(
    discoverCctvCameras(cameras, { view, query: 'Vancouver' }).cameras.length,
    0,
  );
  assert.equal(
    discoverCctvCameras(cameras, { view, scope: 'all', query: 'Vancouver' })
      .cameras[0].id,
    'vancouver',
  );
});
test('empty and unavailable map views never silently fall back to worldwide results', () => {
  assert.equal(discoverCctvCameras(cameras).cameras.length, 0);
  assert.equal(
    discoverCctvCameras(cameras, { view: { ...view, south: 0, north: 1 } })
      .cameras.length,
    0,
  );
});
test('view filtering handles the date line', () => {
  const found = discoverCctvCameras(
    [
      { id: 'east', lat: 0, lon: 179 },
      { id: 'west', lat: 0, lon: -179 },
      { id: 'away', lat: 0, lon: 0 },
    ],
    {
      view: {
        west: 170,
        east: -170,
        south: -10,
        north: 10,
        center: { lat: 0, lon: 179 },
      },
    },
  );
  assert.deepEqual(
    found.cameras.map((c) => c.id),
    ['east', 'west'],
  );
});
test('map changes refresh discovery, navigation stays in results, and disposal removes listener', () => {
  let mapView = view;
  let update;
  let removed = 0;
  let selected;
  const controls = new CctvControls({
    elements: {},
    cctv: {
      selectCamera(id) {
        selected = id;
        return true;
      },
    },
    actions: {
      isEnabled: () => true,
      readMapView: () => mapView,
      subscribeMapView(callback) {
        update = callback;
        return () => removed++;
      },
    },
  });
  controls.connect();
  controls._cctvState = { cameras, activeCameraId: 'vancouver' };
  controls.cycleDiscoveredCamera(1);
  assert.equal(selected, 'cape-near');
  mapView = { ...view, south: 0, north: 1 };
  update();
  assert.equal(controls.cycleDiscoveredCamera(1), null);
  controls.destroy();
  assert.equal(removed, 1);
});
