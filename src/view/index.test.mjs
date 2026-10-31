import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STYLE_URL_NAMES,
  VIEW_PROPERTIES,
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

test('a view naming the retired Snow style opens on Normal', () => {
  const camera = { lat: 1, lon: 2 };
  assert.equal(createView({ camera, style: 'snow' }).style, 'normal');
  const view = viewFromParams(new URLSearchParams('lat=1&lon=2&style=snow'));
  assert.equal(view.style, 'normal');
  assert.equal(viewToParams(view).get('style'), 'normal');
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

// Routes already accept these modes in the annotation engine. The shared view
// codec must retain that choice before any renderer or routing service sees it.
for (const mode of ['walk', 'car', 'bike']) {
  test(`route mode ${mode} is admitted by tools`, async () => {
    const { validateValue } = await import('../tools/schema.js');
    const annotation = {
      type: 'route',
      label: 'Road corridor',
      mode,
      points: [
        { latitude: 33.513, longitude: 36.292 },
        { latitude: 36.202, longitude: 37.134 },
      ],
    };
    assert.deepEqual(
      validateValue(VIEW_PROPERTIES.annotations, [annotation]),
      [],
    );
  });
  test(`route mode ${mode} survives a share link`, () => {
    const annotation = {
      type: 'route',
      mode,
      points: [
        { latitude: 33.513, longitude: 36.292 },
        { latitude: 36.202, longitude: 37.134 },
      ],
    };
    const view = createView({
      camera: { lat: 35, lon: 37 },
      annotations: [annotation],
    });
    const restored = viewFromParams(viewToParams(view));
    assert.deepEqual(restored.annotations, [annotation]);
  });
}

for (const [alias, canonical] of [
  ['driving', 'car'],
  ['drive', 'car'],
  ['cycling', 'bike'],
  ['cycle', 'bike'],
  ['bicycle', 'bike'],
  ['walking', 'walk'],
  ['foot', 'walk'],
]) {
  test(`route mode alias ${alias} canonicalizes to ${canonical} and survives share link`, () => {
    const annotation = {
      type: 'route',
      mode: alias,
      points: [
        { latitude: 33.513, longitude: 36.292 },
        { latitude: 36.202, longitude: 37.134 },
      ],
    };
    const view = createView({
      camera: { lat: 35, lon: 37 },
      annotations: [annotation],
    });
    const expected = {
      ...annotation,
      mode: canonical,
    };
    assert.deepEqual(view.annotations, [expected]);
    const restored = viewFromParams(viewToParams(view));
    assert.deepEqual(restored.annotations, [expected]);
  });
}

test('route mode remains optional and unsupported link values are discarded', async () => {
  const { validateValue } = await import('../tools/schema.js');
  const route = {
    type: 'route',
    points: [
      { latitude: 33.513, longitude: 36.292 },
      { latitude: 36.202, longitude: 37.134 },
    ],
  };
  for (const mode of [undefined, 'fly', '', null, 1]) {
    const annotation = mode === undefined ? route : { ...route, mode };
    const view = createView({
      camera: { lat: 35, lon: 37 },
      annotations: [annotation],
    });
    assert.deepEqual(viewFromParams(viewToParams(view)).annotations, [route]);
    assert.equal(
      validateValue(VIEW_PROPERTIES.annotations, [annotation]).length === 0,
      mode === undefined,
    );
  }
});

test('a mode on another annotation kind does not enter its share link', () => {
  const pin = { type: 'pin', latitude: 35, longitude: 37, label: 'A place' };
  const view = createView({
    camera: { lat: 35, lon: 37 },
    annotations: [{ ...pin, mode: 'car' }],
  });
  assert.deepEqual(viewFromParams(viewToParams(view)).annotations, [pin]);
});

for (const [mode, routedMode, word] of [
  ['car', 'car', 'drive'],
  ['driving', 'car', 'drive'],
  ['bike', 'bike', 'ride'],
  ['cycling', 'bike', 'ride'],
  ['walk', 'foot', 'walk'],
  ['walking', 'foot', 'walk'],
  [undefined, 'foot', 'walk'],
]) {
  test(`shared route mode ${mode ?? 'default'} reaches the router and label`, async (t) => {
    const { createAnnotationEngine } =
      await import('../annotations/annotationEngine.js');
    const { _resetRenderGovernorForTest } =
      await import('../renderGovernor.js');
    const oldFrame = globalThis.requestAnimationFrame;
    const oldCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    t.after(() => {
      if (oldFrame === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = oldFrame;
      if (oldCancel === undefined) delete globalThis.cancelAnimationFrame;
      else globalThis.cancelAnimationFrame = oldCancel;
      _resetRenderGovernorForTest();
    });
    const points = [
      { latitude: 33.513, longitude: 36.292 },
      { latitude: 36.202, longitude: 37.134 },
    ];
    const modes = [];
    const engine = createAnnotationEngine({
      viewer: {},
      renderer: { add() {}, remove() {}, update() {}, sync() {} },
      resolveTarget: async ({ latitude, longitude }) => ({
        lat: latitude,
        lon: longitude,
        height: 0,
      }),
      placeSearch: {
        async route(coordinates, actualMode) {
          modes.push(actualMode);
          return { geometry: coordinates, distanceM: 556000, durationS: 3600 };
        },
      },
    });
    const route = { type: 'route', points, label: 'Road corridor' };
    if (mode !== undefined) route.mode = mode;
    const view = createView({
      camera: { lat: 35, lon: 37 },
      annotations: [route],
    });
    const restored = viewFromParams(viewToParams(view));
    const result = await engine.annotate(restored.annotations);
    assert.equal(result.drawn, 1);
    assert.deepEqual(modes, [routedMode]);
    assert.equal(
      engine.list()[0].label,
      `Road corridor — 556 km · 60 min ${word}`,
    );
    engine.clear();
  });
}

// Regression: ANNOTATION_ROUTE_MODE_MAP must not expose Object.prototype
// inherited keys. mode:'constructor' and mode:'__proto__' must be treated as
// unknown modes and discarded, not surfaced as a function or object.
for (const mode of ['constructor', '__proto__']) {
  test(`route mode '${mode}' is not an inherited map key and is discarded`, () => {
    const points = [
      { latitude: 33.513, longitude: 36.292 },
      { latitude: 36.202, longitude: 37.134 },
    ];
    const view = createView({
      camera: { lat: 35, lon: 37 },
      annotations: [{ type: 'route', points, mode }],
    });
    const annotation = view.annotations[0];
    assert.equal(
      typeof annotation.mode,
      'undefined',
      `mode should be dropped, got ${typeof annotation.mode}`,
    );
    const expected = { type: 'route', points };
    assert.deepEqual(viewFromParams(viewToParams(view)).annotations, [
      expected,
    ]);
  });
}
