import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STYLE_URL_NAMES,
  createView,
  viewFromParams,
  viewToParams,
  viewUrl,
} from './index.js';

test('a view round-trips through share-link parameters', () => {
  const view = createView({
    camera: {
      lat: 35.68,
      lon: 139.76,
      altitude_m: 300000,
      heading_deg: 15,
      pitch_deg: -45,
    },
    layers: ['earthquakes', 'ais-live-vessels'],
    style: 'retro',
    map: 'osm',
    follow: { kind: 'aircraft', id: 'AE1234' },
  });
  const params = viewToParams(view);
  assert.equal(params.get('style'), 'crt');
  assert.equal(params.get('map'), 'osm');
  assert.deepEqual(viewFromParams(params), view);
  assert.deepEqual(view.layers, ['ais-live-vessels', 'earthquakes', 'flights']);
  const satellite = createView({
    camera: { lat: 0, lon: 0 },
    follow: { kind: 'satellite', id: '25544' },
  });
  assert.deepEqual(viewFromParams(viewToParams(satellite)).follow, {
    kind: 'satellite',
    id: '25544',
  });
});

test('views have defaults, bounds, and reject what links cannot carry', () => {
  const view = createView({ camera: { lat: 91, lon: 10, altitude_m: 1 } });
  assert.deepEqual(view.camera, {
    lat: 90,
    lon: 10,
    altitude_m: 50,
    heading_deg: 0,
    pitch_deg: -90,
  });
  assert.equal(view.style, null);
  const params = viewToParams(view);
  assert.equal(params.has('style'), false);
  assert.equal(params.has('l'), false);
  assert.throws(() => createView({ camera: {} }), /lat and lon/);
  assert.throws(
    () => createView({ camera: { lat: 0, lon: 0 }, style: 'sepia' }),
    /Unknown view style/,
  );
  assert.throws(
    () =>
      createView({
        camera: { lat: 0, lon: 0 },
        follow: { kind: 'ship', id: '1' },
      }),
    /Cannot follow a ship/,
  );
  assert.equal(viewFromParams(new URLSearchParams('style=crt')), null);
  assert.equal(
    new URL(viewUrl('https://maps.example/app', view)).hash.slice(1),
    params.toString(),
  );
});

test('views use the same style names as the app share links', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../sharelink.js', import.meta.url), 'utf8'),
  );
  assert.match(source, /const STYLE_TO_URL = STYLE_URL_NAMES;/);
  assert.equal(STYLE_URL_NAMES.retro, 'crt');
});

test('annotations travel in the link, keeping only what the app draws', async () => {
  const { annotationsFromParams } = await import('./index.js');
  const view = createView({
    camera: { lat: 25, lon: 121 },
    annotations: [
      { type: 'pin', target: 'Taipei 101', label: 'Taipei 101', color: 'red' },
      {
        type: 'arrow',
        latitude: 24,
        longitude: 119,
        toLatitude: 25,
        toLongitude: 121,
      },
      {
        type: 'route',
        points: [
          { latitude: 1, longitude: 2 },
          { latitude: 3, longitude: 4 },
        ],
        screenX: 0.5,
      },
      { type: 'pin' },
      { type: 'sparkle', target: 'x' },
      { type: 'label', latitude: 200, longitude: 0, target: 'Here' },
    ],
  });
  assert.equal(view.annotations.length, 4);
  assert.equal(view.annotations[2].screenX, undefined);
  assert.deepEqual(view.annotations[3], { type: 'label', target: 'Here' });
  const params = viewToParams(view);
  assert.ok(params.has('an'));
  assert.deepEqual(viewFromParams(params), view);
  assert.deepEqual(
    annotationsFromParams(new URLSearchParams('an=not json')),
    [],
  );
  const many = createView({
    camera: { lat: 0, lon: 0 },
    annotations: Array.from({ length: 30 }, () => ({
      type: 'label',
      target: 'x'.repeat(200),
      label: 'y'.repeat(120),
    })),
  });
  assert.equal(many.annotations.length, 24);
  // Too long for a link: the view keeps them, the link leaves them out.
  assert.equal(viewToParams(many).has('an'), false);
});
