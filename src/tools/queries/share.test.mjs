import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';

test('links open the app looking straight down on the area', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'https://maps.example/view?x=1' } },
  });
  const result = await catalog.call('show_in_gods_eye_view', {
    area: { lat: 30.2672, lon: -97.7431, radius_km: 5 },
  });
  const url = new URL(result.data.url);
  assert.equal(
    url.origin + url.pathname + url.search,
    'https://maps.example/view?x=1',
  );
  assert.deepEqual(Object.fromEntries(new URLSearchParams(url.hash.slice(1))), {
    v: '2',
    lat: '30.2672',
    lon: '-97.7431',
    alt: '9091',
    heading: '0',
    pitch: '-90',
    roll: '0',
  });
  assert.equal(
    result.summary,
    `Open 5 km around 30.267, -97.743 in God's Eye View: ${url.href}`,
  );
});

test('altitude is bounded for tiny and planet-sized areas', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:4173/' } },
  });
  const tiny = await catalog.call('show_in_gods_eye_view', {
    area: { lat: 0, lon: 0, radius_km: 0.1 },
  });
  assert.equal(tiny.data.view.camera.altitude_m, 500);
  const world = await catalog.call('show_in_gods_eye_view', {
    area: { bbox: [-180, -85, 180, 85] },
  });
  assert.equal(world.data.view.camera.altitude_m, 15000000);
  const broken = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'not a url' } },
  });
  await assert.rejects(
    broken.call('show_in_gods_eye_view', {
      area: { lat: 0, lon: 0, radius_km: 1 },
    }),
    (error) => error.code === 'unavailable',
  );
});

test('links turn on the requested layers with the app share-link codec', async () => {
  const { decodeLayerStateParams } = await import('../../data/layerState.js');
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:4173/' } },
  });
  const result = await catalog.call('show_in_gods_eye_view', {
    area: { lat: 30.27, lon: -97.74, radius_km: 10 },
    layers: ['earthquakes', 'flights', 'flights'],
  });
  assert.deepEqual(result.data.view.layers, ['earthquakes', 'flights']);
  const params = new URLSearchParams(new URL(result.data.url).hash.slice(1));
  assert.deepEqual(decodeLayerStateParams(params).enabledLayerIds.sort(), [
    'earthquakes',
    'flights',
  ]);
  await assert.rejects(
    catalog.call('show_in_gods_eye_view', {
      area: { lat: 0, lon: 0, radius_km: 1 },
      layers: ['not-a-layer'],
    }),
    /must be one of/,
  );
});

test('links carry a camera, style, map and an entity to follow', async () => {
  const { viewFromParams } = await import('../../view/index.js');
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:4173/' } },
  });
  const result = await catalog.call('show_in_gods_eye_view', {
    area: { lat: 25, lon: 121, radius_km: 200 },
    camera: { pitch_deg: -40, heading_deg: 350 },
    layers: ['ais-live-vessels'],
    style: 'thermal',
    map: 'esri-imagery',
    follow: { kind: 'military_aircraft', id: 'AE1234' },
  });
  const params = new URLSearchParams(new URL(result.data.url).hash.slice(1));
  assert.equal(params.get('style'), 'flir');
  assert.deepEqual(viewFromParams(params), result.data.view);
  assert.deepEqual(result.data.view.layers, ['ais-live-vessels', 'military']);
  assert.deepEqual(result.data.view.follow, {
    kind: 'military_aircraft',
    id: 'ae1234',
  });
  assert.equal(result.data.view.camera.pitch_deg, -40);
  const camera = await catalog.call('show_in_gods_eye_view', {
    camera: { lat: 48.8584, lon: 2.2945, altitude_m: 1200, pitch_deg: -30 },
  });
  assert.equal(camera.data.view.camera.altitude_m, 1200);
  assert.match(camera.summary, /^Open 48\.858, 2\.295 in God's Eye View: /);
  await assert.rejects(
    catalog.call('show_in_gods_eye_view', { layers: ['flights'] }),
    /Give a view, an area, or a camera with lat and lon/,
  );
});

test('links can open street-level photos at the area, on the map the source needs', async () => {
  const { viewFromParams } = await import('../../view/index.js');
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:4173/' } },
  });
  const result = await catalog.call('show_in_gods_eye_view', {
    area: { lat: 38.5799, lon: -121.4937, radius_km: 1 },
    street_level: { provider: 'google' },
  });
  const { view } = result.data;
  assert.equal(view.map, 'photoreal');
  assert.deepEqual(view.layers, ['street-level']);
  assert.deepEqual(view.street_level, {
    provider: 'google',
    lat: 38.5799,
    lon: -121.4937,
  });
  const params = new URLSearchParams(new URL(result.data.url).hash.slice(1));
  assert.equal(params.get('sl'), 'google,38.57990,-121.49370');
  assert.equal(params.get('map'), 'photoreal');
  assert.deepEqual(viewFromParams(params), view);

  const point = await catalog.call('show_in_gods_eye_view', {
    view,
    street_level: { provider: 'mapillary', lat: 38.58, lon: -121.49 },
  });
  assert.deepEqual(point.data.view.street_level, {
    provider: 'mapillary',
    lat: 38.58,
    lon: -121.49,
  });
  await assert.rejects(
    catalog.call('show_in_gods_eye_view', {
      area: { lat: 0, lon: 0, radius_km: 1 },
      map: 'osm',
      street_level: { provider: 'google' },
    }),
    /photoreal/,
  );
});

test('a new area moves a passed-through view’s photos, and a tilted area still opens them at its centre', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:4173/' } },
  });
  const first = await catalog.call('show_in_gods_eye_view', {
    area: { lat: 38.5799, lon: -121.4937, radius_km: 1 },
    street_level: { provider: 'google' },
  });
  const second = await catalog.call('show_in_gods_eye_view', {
    view: first.data.view,
    area: { lat: 42.3314, lon: -83.0458, radius_km: 1 },
  });
  assert.deepEqual(second.data.view.street_level, {
    provider: 'google',
    lat: 42.3314,
    lon: -83.0458,
  });
  const tilted = await catalog.call('show_in_gods_eye_view', {
    area: { lat: 48.8584, lon: 2.2945, radius_km: 1 },
    camera: { pitch_deg: -30 },
    street_level: { provider: 'mapillary' },
  });
  assert.notEqual(
    tilted.data.view.camera.lat,
    48.8584,
    'the camera sits behind the target',
  );
  assert.deepEqual(tilted.data.view.street_level, {
    provider: 'mapillary',
    lat: 48.8584,
    lon: 2.2945,
  });
  await assert.rejects(
    catalog.call('show_in_gods_eye_view', {
      area: { lat: 0, lon: 0, radius_km: 1 },
      follow: { kind: 'aircraft', id: 'AE1234' },
      street_level: {},
    }),
    /cannot both follow/,
  );
});

test('a view passed through alone keeps its street-level photos', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:4173/' } },
  });
  const first = await catalog.call('show_in_gods_eye_view', {
    area: { lat: 38.5799, lon: -121.4937, radius_km: 1 },
    street_level: { provider: 'mapillary' },
  });
  const again = await catalog.call('show_in_gods_eye_view', {
    view: first.data.view,
  });
  assert.deepEqual(again.data.view.street_level, first.data.view.street_level);
  assert.deepEqual(again.data.view, first.data.view);
});
