import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapillaryProvider } from './index.js';
import { mapillaryImageUrl } from './policy.js';
import { sequenceIdFromPick } from '../../lineCoverage.js';
import { thinImages } from '../../sequenceCones.js';
import { validateProviders } from '../../registry.js';
import {
  SACRAMENTO_VIEW,
  cameraEngine,
  fakeMapillarySource,
  streetLevelMap,
} from '../../../../testSupport/streetLevelFakes.mjs';

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
  assert.equal(sequenceIdFromPick('mly:seq:abc', 'mly:seq:'), 'abc');
  assert.equal(sequenceIdFromPick('mly:img:abc', 'mly:seq:'), null);
  assert.equal(sequenceIdFromPick(null, 'mly:seq:'), null);
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

/** The display looking straight down on downtown Sacramento from 900 m. */
const streetMap = () =>
  streetLevelMap({ engine: cameraEngine(SACRAMENTO_VIEW) }).map;

test('coverage asks for no tiles before the key status is known, and none without a key', async () => {
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
    const map = streetMap();
    instance.init(map);
    const status = instance.status();
    instance.activate(map);
    assert.equal(tiles.length, 0, 'nothing before the status answers');
    answer({ configured });
    assert.deepEqual(await status, { configured });
    if (configured)
      assert.ok(tiles.length > 0, 'coverage loads as soon as the key is known');
    else {
      assert.equal(tiles.length, 0, 'a key-less install never asks');
      assert.equal(instance.coverageStats().keyRequired, true);
    }
    instance.destroy();
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
