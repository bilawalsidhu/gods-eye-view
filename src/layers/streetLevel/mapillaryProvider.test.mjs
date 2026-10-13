import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createMapillaryProvider } from './mapillaryProvider.js';
import { mapillaryImageUrl } from './policy.js';
import { sequenceIdFromPick } from './coverage.js';
import { thinImages } from './sequences.js';
import { validateProviders } from './registry.js';
import {
  fakeMapillarySource,
  rayCamera,
} from '../../testSupport/streetLevelFakes.mjs';

function fakeContext(filter = { pano: 'all', sinceMs: null }) {
  const opened = [];
  return {
    opened,
    services: {},
    getFilter: () => filter,
    isActive: () => true,
    notify: () => {},
    actions: { openImage: (id) => opened.push(id) },
  };
}

test('the definition satisfies the Street Level provider contract', () => {
  const def = createMapillaryProvider({ source: fakeMapillarySource() });
  assert.doesNotThrow(() => validateProviders([def]));
  assert.equal(def.id, 'mapillary');
  assert.equal(def.label, 'MAPILLARY');
  assert.equal(def.requiresKeyId, 'mapillary');
  assert.equal(def.pickPrefix, 'mly:');
  assert.match(def.credit.html, /CC BY-SA 4\.0/);
  // One colour per source: Mapillary is green everywhere it draws.
  assert.equal(def.colors.coverage, '#05cb63');
  assert.throws(() => createMapillaryProvider({ source: {} }), /source/);
});

test('image deep links match the mapillary.com share format', () => {
  assert.equal(
    mapillaryImageUrl(1814275685699406),
    'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
  );
  assert.equal(mapillaryImageUrl('  '), 'https://www.mapillary.com/app/');
});

test('picks route sequences to selection and images to the core opener', () => {
  const context = fakeContext();
  const instance = createMapillaryProvider({
    source: fakeMapillarySource(),
  }).create(context);
  assert.equal(instance.handlePick('mly:img:77'), true);
  assert.deepEqual(context.opened, ['77']);
  assert.equal(instance.handlePick('cctv:1'), false);
  assert.deepEqual(instance.sequenceStats(), {
    selectedId: null,
    images: 0,
    loading: false,
    error: null,
  });
});

test('a line pick names its sequence; anything else is not a sequence', () => {
  assert.equal(sequenceIdFromPick('mly:seq:abc'), 'abc');
  assert.equal(sequenceIdFromPick('mly:img:abc'), null);
  assert.equal(sequenceIdFromPick(null), null);
});

test('cone thinning across the date line drops images metres apart', () => {
  const image = (id, lon) => ({ id, lon, lat: 0 });
  // A sequence driving east over ±180° with images ~1 m apart, then ~11 m on.
  const kept = thinImages(
    [
      image('a', 179.99999),
      image('b', -179.99999), // ~2 m from a, across the date line
      image('c', -179.9999), // ~11 m from a
    ],
    3,
  );
  assert.deepEqual(
    kept.map(({ id }) => id),
    ['a', 'c'],
  );
});

/** A viewer looking straight down on downtown Sacramento from 900 m. */
function streetViewer() {
  const collection = () => ({
    add: (item) => item,
    remove: () => true,
    contains: () => false,
    get length() {
      return 0;
    },
  });
  const event = () => ({ addEventListener: () => () => {} });
  const camera = Object.assign(
    rayCamera({
      lon: -121.4944,
      lat: 38.5816,
      altitude: 900,
      pitch: -90,
      width: 100,
      height: 100,
    }),
    { changed: event(), moveEnd: event() },
  );
  return {
    camera,
    scene: {
      canvas: { clientWidth: 100, clientHeight: 100 },
      globe: { show: false, ellipsoid: Cesium.Ellipsoid.WGS84 },
      primitives: collection(),
      groundPrimitives: collection(),
      preRender: event(),
      postRender: event(),
      requestRender() {},
    },
  };
}

test('coverage asks for no tiles before the key status is known, and none without a key', async (t) => {
  // Skip Cesium's one-time terrain table download for draped lines.
  t.mock.method(
    Cesium.GroundPolylinePrimitive,
    'initializeTerrainHeights',
    async () => {},
  );
  for (const configured of [false, true]) {
    let answer;
    const tiles = [];
    const source = fakeMapillarySource({
      hasToken: () => configured,
      getStatus: () => new Promise((resolve) => (answer = resolve)),
      getTile: (...args) => {
        tiles.push(args);
        return new Promise(() => {});
      },
    });
    const instance = createMapillaryProvider({ source }).create(fakeContext());
    const viewer = streetViewer();
    instance.init(viewer);
    const status = instance.status();
    instance.activate(viewer);
    assert.equal(tiles.length, 0, 'nothing before the status answers');
    answer({ configured });
    assert.deepEqual(await status, { configured });
    if (configured)
      assert.ok(tiles.length > 0, 'coverage loads as soon as the key is known');
    else {
      assert.equal(tiles.length, 0, 'a key-less install never asks');
      assert.equal(instance.coverageStats().keyRequired, true);
    }
    instance.destroy(viewer);
  }
});

test('a status the server never answers falls back to the bundled token once the core gives up', async () => {
  const source = fakeMapillarySource({
    hasToken: () => false,
    getStatus: ({ signal } = {}) =>
      new Promise((_, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason)),
      ),
  });
  const instance = createMapillaryProvider({ source }).create(fakeContext());
  const controller = new AbortController();
  const status = instance.status({ signal: controller.signal });
  controller.abort(new Error('timed out'));
  assert.deepEqual(await status, { configured: false });
  assert.equal(instance.coverageStats().keyRequired, true);
});
