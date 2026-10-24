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

test('street-level photos travel in the link, light their source and bring their map', async () => {
  const { streetLevelFromParams, VIEW_STREET_LEVEL_PROVIDERS } =
    await import('./index.js');
  const { decodeLayerStateParams } = await import('../data/layerState.js');
  assert.deepEqual(VIEW_STREET_LEVEL_PROVIDERS, [
    'google',
    'mapillary',
    'kartaview',
    'panoramax',
  ]);
  const view = createView({
    camera: { lat: 38.5799, lon: -121.4937, altitude_m: 400 },
    street_level: { provider: 'google' },
  });
  assert.equal(view.map, 'photoreal', 'Street View brings Google 3D');
  assert.deepEqual(view.layers, ['street-level']);
  assert.deepEqual(view.street_level, {
    provider: 'google',
    lat: 38.5799,
    lon: -121.4937,
  });
  const params = viewToParams(view);
  assert.equal(params.get('sl'), 'google,38.57990,-121.49370');
  assert.deepEqual(viewFromParams(params), view);
  const state = decodeLayerStateParams(params);
  assert.deepEqual(state.enabledLayerIds, ['street-level']);
  assert.equal(state.options['street-level'].mapillary, false);
  assert.equal(
    state.options['street-level'].providerSwitches,
    'google-1*kartaview-0*panoramax-0',
    'Street View on, KartaView off',
  );

  const mapillary = createView({
    camera: { lat: 1, lon: 2 },
    map: 'osm',
    street_level: { provider: 'mapillary', lat: 1.00001, lon: 2.00001 },
  });
  assert.equal(mapillary.map, 'osm', 'Mapillary shows on any map');
  assert.deepEqual(viewFromParams(viewToParams(mapillary)), mapillary);
  const lit = decodeLayerStateParams(viewToParams(mapillary)).options[
    'street-level'
  ];
  assert.equal(lit.mapillary, true);
  assert.equal(
    lit.providerSwitches,
    'google-0*kartaview-0*panoramax-0',
    'a Mapillary link lights Mapillary only',
  );
  const anySource = createView({
    camera: { lat: 1, lon: 2 },
    street_level: {},
  });
  assert.deepEqual(anySource.street_level, { lat: 1, lon: 2 });
  assert.equal(viewToParams(anySource).get('sl'), ',1.00000,2.00000');
  assert.deepEqual(viewFromParams(viewToParams(anySource)), anySource);

  assert.throws(
    () =>
      createView({
        camera: { lat: 1, lon: 2 },
        map: 'osm',
        street_level: { provider: 'google' },
      }),
    /photoreal/,
  );
  assert.throws(
    () =>
      createView({
        camera: { lat: 1, lon: 2 },
        street_level: { provider: 'openstreetcam' },
      }),
    /Unknown street-level source/,
  );
  assert.equal(
    streetLevelFromParams(new URLSearchParams('sl=google,x,y')),
    null,
  );
  assert.equal(streetLevelFromParams(new URLSearchParams('sl=bing,1,2')), null);
  assert.equal(streetLevelFromParams(new URLSearchParams('lat=1')), null);
  assert.equal(createView({ camera: { lat: 1, lon: 2 } }).street_level, null);
});

test('street-level photos: a tilted camera opens them where it looks, a link cannot pair them with the wrong map, and follow is refused', async () => {
  const { streetLevelFromParams } = await import('./index.js');
  // Looking north from 1,000 m at 45°: the ground point is ~1 km north.
  const tilted = createView({
    camera: {
      lat: 48.8494,
      lon: 2.2945,
      altitude_m: 1000,
      heading_deg: 0,
      pitch_deg: -45,
    },
    street_level: { provider: 'google' },
  });
  assert.ok(
    tilted.street_level.lat > 48.858 && tilted.street_level.lat < 48.859,
    String(tilted.street_level.lat),
  );
  assert.equal(tilted.street_level.lon, 2.2945);
  const down = createView({
    camera: { lat: 1, lon: 2, altitude_m: 1000 },
    street_level: {},
  });
  assert.deepEqual(down.street_level, { lat: 1, lon: 2 });
  // A hand-edited link: the photos win over the map.
  const link = viewFromParams(
    new URLSearchParams('v=2&lat=1&lon=2&map=osm&sl=google,1,2'),
  );
  assert.equal(link.map, 'photoreal');
  assert.deepEqual(link.street_level, { provider: 'google', lat: 1, lon: 2 });
  assert.throws(
    () =>
      createView({
        camera: { lat: 1, lon: 2 },
        follow: { kind: 'aircraft', id: 'a1' },
        street_level: {},
      }),
    /cannot both follow/,
  );
  // A followed link drops its photos rather than fight over the camera.
  const followed = viewFromParams(
    viewToParams(
      createView({
        camera: { lat: 1, lon: 2 },
        follow: { kind: 'satellite', id: '25544' },
      }),
    ),
  );
  assert.equal(followed.street_level, null);
  // Strict parsing: three fields, real numbers, in range, bounded length.
  for (const bad of [
    'google,1',
    'google,1,2,3',
    'google,1abc,2',
    'google,91,0',
    'google,,2',
    'google,1,2'.padEnd(65, '0'),
  ])
    assert.equal(
      streetLevelFromParams(new URLSearchParams({ sl: bad })),
      null,
      bad,
    );
});

test('the look-at default is street-scale only, follows the heading, and wraps at the antimeridian', async () => {
  const { followFromParams, streetLevelFromParams } =
    await import('./index.js');
  const at = (camera) =>
    createView({ camera, street_level: { provider: 'mapillary' } })
      .street_level;
  // Looking east from 1,000 m at 45° in Paris: ~1 km east is ~0.0137° of longitude.
  const east = at({
    lat: 48.85,
    lon: 2.2945,
    altitude_m: 1000,
    heading_deg: 90,
    pitch_deg: -45,
  });
  assert.ok(Math.abs(east.lon - (2.2945 + 0.01365)) < 0.0005, String(east.lon));
  assert.ok(Math.abs(east.lat - 48.85) < 0.0002, String(east.lat));
  // Looking west from the same place lands west.
  assert.ok(
    at({
      lat: 48.85,
      lon: 2.2945,
      altitude_m: 1000,
      heading_deg: 270,
      pitch_deg: -45,
    }).lon < 2.2945,
  );
  // At the horizon, with no altitude, or above street scale: the camera's own point.
  assert.deepEqual(at({ lat: 1, lon: 2, altitude_m: 1000, pitch_deg: 0 }), {
    provider: 'mapillary',
    lat: 1,
    lon: 2,
  });
  assert.deepEqual(at({ lat: 1, lon: 2, pitch_deg: -30 }), {
    provider: 'mapillary',
    lat: 1,
    lon: 2,
  });
  assert.deepEqual(at({ lat: 1, lon: 2, altitude_m: 50_000, pitch_deg: -30 }), {
    provider: 'mapillary',
    lat: 1,
    lon: 2,
  });
  // Across the antimeridian the longitude wraps instead of clamping.
  const wrapped = at({
    lat: 0,
    lon: 179.999,
    altitude_m: 1000,
    heading_deg: 90,
    pitch_deg: -45,
  });
  assert.ok(wrapped.lon < -179.9, String(wrapped.lon));

  // A followed link keeps its camera: the photos are dropped even when both are in the hash.
  const followed = viewToParams(
    createView({
      camera: { lat: 1, lon: 2 },
      follow: { kind: 'satellite', id: '25544' },
    }),
  );
  followed.set('sl', 'google,1.00000,2.00000');
  assert.deepEqual(followFromParams(followed), {
    kind: 'satellite',
    id: '25544',
  });
  assert.equal(viewFromParams(followed).street_level, null);
  assert.equal(followFromParams(new URLSearchParams('v=2&lat=1&lon=2')), null);

  // Strict decimal degrees: no exponents, hex, blanks or over-long values.
  for (const bad of [
    'google,1e1,2',
    'google,0x10,2',
    'google, 1,2',
    'google,1.,2',
    `google,${'1.0000000'.padEnd(60, '0')},2`,
  ])
    assert.equal(
      streetLevelFromParams(new URLSearchParams({ sl: bad })),
      null,
      bad,
    );
  assert.deepEqual(
    streetLevelFromParams(new URLSearchParams({ sl: ',-1.5,2' })),
    { lat: -1.5, lon: 2 },
  );
});

test('the look-at thresholds are pinned: 20 km up, -5° of pitch, 10 km ahead', () => {
  const at = (camera) => createView({ camera, street_level: {} }).street_level;
  const own = { lat: 1, lon: 2 };
  const moved = (point) => point.lat !== own.lat || point.lon !== own.lon;
  // Altitude ceiling, at a steep pitch that keeps the distance under 10 km.
  assert.ok(
    moved(at({ ...own, altitude_m: 19_999, pitch_deg: -70 })),
    '19,999 m applies',
  );
  assert.ok(
    !moved(at({ ...own, altitude_m: 20_001, pitch_deg: -70 })),
    '20,001 m does not',
  );
  // Pitch cutoff, at 100 m so the distance cap cannot decide it (1.4 km ahead).
  assert.ok(
    moved(at({ ...own, altitude_m: 100, pitch_deg: -6 })),
    '-6° applies',
  );
  assert.ok(
    !moved(at({ ...own, altitude_m: 100, pitch_deg: -4 })),
    '-4° does not',
  );
  // Distance cap, pinned either side of 10 km at 1,000 m: -5.8° looks 9.84 km
  // ahead, -5.6° 10.2 km.
  assert.ok(
    moved(at({ ...own, altitude_m: 1000, pitch_deg: -5.8 })),
    '9.84 km ahead applies',
  );
  assert.ok(
    !moved(at({ ...own, altitude_m: 1000, pitch_deg: -5.6 })),
    '10.2 km ahead does not',
  );
  assert.ok(
    !moved(at({ ...own, altitude_m: 10_000, pitch_deg: -30 })),
    '17 km ahead does not',
  );
  assert.ok(
    moved(at({ ...own, altitude_m: 5_000, pitch_deg: -30 })),
    '8.7 km ahead applies',
  );
  // Near-vertical stays put (no tan blow-up).
  assert.ok(!moved(at({ ...own, altitude_m: 1000, pitch_deg: -89.5 })));
  // Western wrap and the pole clamp.
  const west = at({
    lat: 0,
    lon: -179.999,
    altitude_m: 1000,
    heading_deg: 270,
    pitch_deg: -45,
  });
  assert.ok(west.lon > 179.9, String(west.lon));
  const pole = at({
    lat: 89.9995,
    lon: 0,
    altitude_m: 1000,
    heading_deg: 0,
    pitch_deg: -45,
  });
  assert.ok(pole.lat <= 90, String(pole.lat));
});

test('sl rejects a bad longitude slot and over-precise values, and no length bound hides the regex', async () => {
  const { streetLevelFromParams } = await import('./index.js');
  for (const bad of [
    'google,1,1e1',
    'google,1,0x10',
    'google,1, 2',
    'google,1,2.',
    'google,1.123456789,2',
    'google,1,2.123456789',
  ])
    assert.equal(
      streetLevelFromParams(new URLSearchParams({ sl: bad })),
      null,
      bad,
    );
  assert.deepEqual(
    streetLevelFromParams(
      new URLSearchParams({ sl: 'google,-89.12345678,179.12345678' }),
    ),
    { provider: 'google', lat: -89.12345678, lon: 179.12345678 },
  );
});

test('KartaView photos travel in a link and light KartaView alone, on any map', async () => {
  const { streetLevelFromParams } = await import('./index.js');
  const { decodeLayerStateParams } = await import('../data/layerState.js');
  const view = createView({
    camera: { lat: 52.52, lon: 13.405, altitude_m: 400 },
    map: 'osm',
    street_level: { provider: 'kartaview' },
  });
  assert.equal(view.map, 'osm', 'KartaView needs no particular map');
  assert.deepEqual(view.layers, ['street-level']);
  const params = viewToParams(view);
  assert.equal(params.get('sl'), 'kartaview,52.52000,13.40500');
  assert.deepEqual(viewFromParams(params), view);
  const lit = decodeLayerStateParams(params).options['street-level'];
  assert.equal(lit.mapillary, false);
  assert.equal(
    lit.providerSwitches,
    'google-0*kartaview-1*panoramax-0',
    'KartaView on, the others off',
  );
  assert.deepEqual(
    streetLevelFromParams(new URLSearchParams({ sl: 'kartaview,1,2' })),
    {
      provider: 'kartaview',
      lat: 1,
      lon: 2,
    },
  );
});

test('Panoramax photos travel in a link and light Panoramax alone, on any map', async () => {
  const { streetLevelFromParams } = await import('./index.js');
  const { decodeLayerStateParams } = await import('../data/layerState.js');
  const view = createView({
    camera: { lat: 48.8874, lon: 2.3495, altitude_m: 400 },
    map: 'osm',
    street_level: { provider: 'panoramax' },
  });
  assert.equal(view.map, 'osm', 'Panoramax needs no particular map');
  assert.deepEqual(view.layers, ['street-level']);
  const params = viewToParams(view);
  assert.equal(params.get('sl'), 'panoramax,48.88740,2.34950');
  assert.deepEqual(viewFromParams(params), view);
  const lit = decodeLayerStateParams(params).options['street-level'];
  assert.equal(lit.mapillary, false);
  assert.equal(
    lit.providerSwitches,
    'google-0*kartaview-0*panoramax-1',
    'Panoramax on, the others off',
  );
  assert.deepEqual(
    streetLevelFromParams(new URLSearchParams({ sl: 'panoramax,1,2' })),
    { provider: 'panoramax', lat: 1, lon: 2 },
  );
});

test('inherited and unknown style keys do not corrupt a restored view', () => {
  for (const style of [
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'unknown',
  ]) {
    const view = viewFromParams(
      new URLSearchParams({ lat: '10', lon: '20', style, map: 'osm' }),
    );
    assert.equal(view.style, null);
    assert.equal(view.map, 'osm');
    assert.equal(view.camera.lat, 10);
  }
});
