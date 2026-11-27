import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createMapillaryProvider } from './index.js';
import { mapillaryImageUrl } from './policy.js';
import { sequenceIdFromPick } from '../../lineCoverage.js';
import { thinImages } from '../../sequenceCones.js';
import { validateProviders } from '../../registry.js';
import {
  fakeMapillarySource,
  rayCamera,
  streetPorts,
} from '../../../../testSupport/streetLevelFakes.mjs';
import { bindRenderer } from '../../../../render/rendererOf.js';

function fakeContext(filter = { pano: 'all', sinceMs: null }) {
  const opened = [];
  const nearest = [];
  let selected;
  let cancelled = 0;
  return {
    opened,
    nearest,
    get sequenceId() {
      return selected;
    },
    get cancelled() {
      return cancelled;
    },
    services: {},
    getFilter: () => filter,
    isActive: () => true,
    notify: () => {},
    actions: {
      openImage: (id) => opened.push(id),
      openNearest: (point, sequenceId) => {
        selected = sequenceId;
        nearest.push(point);
      },
      cancelNearest: () => cancelled++,
    },
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

/** A viewer looking straight down on downtown Sacramento from 900 m. */
function streetViewer() {
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
  const viewer = {
    camera,
    scene: {
      canvas: { clientWidth: 100, clientHeight: 100 },
      globe: { show: false, ellipsoid: Cesium.Ellipsoid.WGS84 },
      preRender: event(),
      postRender: event(),
      requestRender() {},
    },
  };
  bindRenderer(viewer, streetPorts(viewer, { camera: true }));
  return viewer;
}

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

/** A graph image record at a point. */
const imageAt = (id, lon, lat, extra = {}) => ({
  id,
  is_pano: false,
  captured_at: 10,
  geometry: { type: 'Point', coordinates: [lon, lat] },
  ...extra,
});

test('nearestImage opens the closest image that passes the filter, not the first the API returned', async () => {
  const requests = [];
  const answer = [
    imageAt('far', 2.0004, 1), // ~45 m east
    imageAt('near-pano', 2.00002, 1, { is_pano: true }), // ~2 m, a panorama
    imageAt('near', 2.00005, 1), // ~5 m east
    imageAt('mid', 2, 1.0002), // ~22 m north
  ];
  const source = fakeMapillarySource({
    nearestImages: async (query, options) => {
      requests.push({ query, options });
      return answer;
    },
  });
  const { signal } = new AbortController();
  const flat = createMapillaryProvider({ source }).create(
    fakeContext({ pano: 'flat', sinceMs: null }),
  );
  assert.equal(await flat.nearestImage({ lat: 1, lon: 2 }, { signal }), 'near');
  assert.equal(requests[0].options.signal, signal, 'the core can abort it');
  assert.deepEqual(requests[0].query, { lat: 1, lon: 2 });
  const any = createMapillaryProvider({ source }).create(fakeContext());
  assert.equal(await any.nearestImage({ lat: 1, lon: 2 }), 'near-pano');
  const tooOld = createMapillaryProvider({ source }).create(
    fakeContext({ pano: 'all', sinceMs: 100 }),
  );
  assert.equal(await tooOld.nearestImage({ lat: 1, lon: 2 }), null);
});

/** A Mapillary provider over `answer`, on a viewer, recording the sequences it loads. */
function lineClickSetup(answer, filter) {
  const loaded = [];
  const asked = [];
  const source = fakeMapillarySource({
    nearestImages: async (query) => {
      asked.push(query);
      return answer;
    },
    getSequenceImages: async (sequenceId) => {
      loaded.push(sequenceId);
      return [];
    },
  });
  const context = fakeContext(filter);
  const instance = createMapillaryProvider({ source }).create(context);
  instance.init(streetViewer());
  return { context, instance, loaded, asked };
}

const CLICK = { lon: 2, lat: 1 };
const atClick = { groundPoint: () => ({ ...CLICK }) };
const lineAnswer = [
  imageAt('other-near', 2.00002, 1, { sequence: 'B' }), // ~2 m, another sequence
  imageAt('own-far', 2.0003, 1, { sequence: 'A' }), // ~33 m
  imageAt('own', 2.0001, 1, { sequence: 'A' }), // ~11 m
];

test('a line click opens its own sequence’s image nearest the click and still draws its cones', async () => {
  const { context, instance, loaded, asked } = lineClickSetup(lineAnswer);
  assert.equal(instance.handlePick('mly:seq:A', atClick), true);
  assert.deepEqual(context.nearest, [CLICK], 'the core looks up the click');
  assert.deepEqual(loaded, ['A'], 'the clicked sequence is drawn');
  assert.deepEqual(context.opened, [], 'no image picked directly');
  // The core then asks the provider at the click point.
  assert.equal(
    await instance.nearestImage(CLICK, { sequenceId: context.sequenceId }),
    'own',
  );
  assert.equal(asked.length, 1, 'one request, as any nearest search');
  // Only that lookup: the next one at the same point is a plain one.
  assert.equal(await instance.nearestImage(CLICK), 'other-near');
});

test('a line click falls back to the nearest image when its sequence has none in range', async () => {
  const { instance } = lineClickSetup(lineAnswer);
  assert.equal(instance.handlePick('mly:seq:C', atClick), true);
  assert.equal(await instance.nearestImage(CLICK), 'other-near');
});

test('a line click over the sky opens nothing', async () => {
  const { context, instance } = lineClickSetup(lineAnswer);
  assert.equal(
    instance.handlePick('mly:seq:A', { groundPoint: () => null }),
    true,
  );
  assert.equal(instance.handlePick('mly:seq:A'), true, 'no click data');
  assert.equal(context.cancelled, 2);
  assert.deepEqual(context.nearest, []);
  assert.deepEqual(context.opened, []);
});

test('a cone click still opens its own image, with no lookup', () => {
  const { context, instance } = lineClickSetup(lineAnswer);
  assert.equal(instance.handlePick('mly:img:77', atClick), true);
  assert.deepEqual(context.opened, ['77']);
  assert.deepEqual(context.nearest, []);
});

test('a line click keeps to the imagery filter', async () => {
  const answer = [
    imageAt('own-pano', 2.00001, 1, { sequence: 'A', is_pano: true }),
    imageAt('own-flat', 2.0002, 1, { sequence: 'A' }),
    imageAt('own-new', 2.0003, 1, { sequence: 'A', captured_at: 500 }),
    imageAt('other-new', 2.00005, 1, { sequence: 'B', captured_at: 500 }),
  ];
  const flat = lineClickSetup(answer, { pano: 'flat', sinceMs: null });
  flat.instance.handlePick('mly:seq:A', atClick);
  assert.equal(
    await flat.instance.nearestImage(CLICK, {
      sequenceId: flat.context.sequenceId,
    }),
    'own-flat',
  );
  const recent = lineClickSetup(answer, { pano: 'all', sinceMs: 100 });
  recent.instance.handlePick('mly:seq:A', atClick);
  assert.equal(
    await recent.instance.nearestImage(CLICK, {
      sequenceId: recent.context.sequenceId,
    }),
    'own-new',
  );
  const none = lineClickSetup(answer, { pano: 'all', sinceMs: 1000 });
  none.instance.handlePick('mly:seq:A', atClick);
  assert.equal(
    await none.instance.nearestImage(CLICK, {
      sequenceId: none.context.sequenceId,
    }),
    null,
  );
});

test('a line lookup uses the imagery filter selected while it was waiting', async () => {
  const answer = [
    imageAt('pano', 2.00002, 1, { sequence: 'A', is_pano: true }),
    imageAt('flat', 2.0002, 1, { sequence: 'A' }),
  ];
  const pending = Promise.withResolvers();
  let filter = { pano: 'all', sinceMs: null };
  const context = { ...fakeContext(), getFilter: () => filter };
  const source = fakeMapillarySource({ nearestImages: () => pending.promise });
  const provider = createMapillaryProvider({ source }).create(context);
  const opening = provider.nearestImage(CLICK, { sequenceId: 'A' });
  filter = { pano: 'flat', sinceMs: null };
  pending.resolve(answer);
  assert.equal(await opening, 'flat');
});

test('a Nearby line row asks for its own sequence first', async () => {
  const { instance } = lineClickSetup(lineAnswer);
  assert.equal(await instance.nearestImage(CLICK, { sequenceId: 'A' }), 'own');
  assert.equal(
    await instance.nearestImage(CLICK, { sequenceId: 'C' }),
    'other-near',
  );
});

test('a line pick still uses the area lookup when drawn coordinates disagree', async () => {
  let queries = 0;
  const source = fakeMapillarySource({
    getSequenceImages: async () => [imageAt('drawn', 2, 1, { sequence: 'A' })],
    nearestImages: async () => {
      queries++;
      return [imageAt('accepted', 2, 1, { sequence: 'A' })];
    },
  });
  const instance = createMapillaryProvider({ source }).create(fakeContext());
  instance.init(streetViewer());
  await instance.selectSequence('A');
  assert.equal(
    await instance.nearestImage(CLICK, { sequenceId: 'A' }),
    'accepted',
  );
  assert.equal(queries, 1);
});

test('a crowded crossing shares the clicked sequence read before choosing a different line', async () => {
  const sequence = Promise.withResolvers();
  let reads = 0;
  const source = fakeMapillarySource({
    nearestImages: async () =>
      Array.from({ length: 100 }, (_, i) =>
        imageAt(String(i), 2, 1, { sequence: 'other' }),
      ),
    getSequenceImages: () => {
      reads++;
      return sequence.promise;
    },
  });
  const context = fakeContext({ pano: 'flat', sinceMs: null });
  const instance = createMapillaryProvider({ source }).create(context);
  instance.init(streetViewer());
  instance.handlePick('mly:seq:A', atClick);
  const result = instance.nearestImage(CLICK, {
    sequenceId: context.sequenceId,
  });
  sequence.resolve([
    imageAt('pano', 2, 1, { is_pano: true }),
    imageAt('distant', 2.01, 1),
    imageAt('own', 2.00002, 1),
  ]);
  assert.equal(await result, 'own');
  assert.equal(reads, 1);
  assert.equal(
    await instance.nearestImage({ lon: 2.02, lat: 1 }, { sequenceId: 'A' }),
    '0',
  );
});
