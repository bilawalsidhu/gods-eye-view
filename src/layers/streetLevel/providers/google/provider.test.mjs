import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleProvider } from './index.js';
import {
  GROUND_CLICK_HINT,
  KEY_REJECTED_MESSAGE,
  creatorFrom,
  imageDateMs,
  streetViewUrl,
} from './policy.js';
import { PROVIDER_COLORS } from '../../policy.js';
import { requiresKeyIdFor, validateProviders } from '../../registry.js';
import { createMapillaryProvider } from '../mapillary/index.js';
import {
  fakeHost,
  fakeMapsLoader,
  fakeStreetViewLibrary,
} from '../../../../testSupport/googleStreetViewFakes.mjs';

const PANORAMAS = {
  fresh: { lat: 38.5816, lng: -121.4944, imageDate: '2025-06' },
  old: { lat: 38.6, lng: -121.5, imageDate: '2009-03' },
};

function setup({ key = 'browser-key', nearest = () => 'fresh' } = {}) {
  const fake = fakeStreetViewLibrary({ panoramas: PANORAMAS, nearest });
  const loader = fakeMapsLoader(fake.library);
  let apiKey = key;
  const def = createGoogleProvider({ getApiKey: () => apiKey, loader });
  const reported = [];
  let filter = { pano: 'all', sinceMs: null };
  let active = false;
  const context = {
    services: {},
    getFilter: () => filter,
    isActive: () => active,
    notify() {},
    actions: { reportError: (message) => reported.push(message) },
  };
  const created = def.create(context);
  // The core switches it on and off; mirror that for isActive().
  const instance = {
    ...created,
    activate() {
      active = true;
      created.activate();
    },
    deactivate() {
      active = false;
      created.deactivate();
    },
  };
  return {
    def,
    instance,
    fake,
    loader,
    reported,
    setFilter: (next) => (filter = next),
    setKey: (next) => (apiKey = next),
  };
}

test('the provider registers beside Mapillary, off by default, gated on the browser Maps key', () => {
  const { def } = setup();
  assert.equal(def.id, 'google');
  assert.equal(def.label, 'STREET VIEW');
  assert.equal(def.requiresKeyId, 'google-maps');
  assert.equal(def.defaultOn, false, 'every panorama is billed');
  assert.equal(def.groundClick, true);
  assert.equal(def.colors.coverage, PROVIDER_COLORS.google);
  assert.match(def.credit.html, /Street View imagery © .*Google/);
  const mapillary = createMapillaryProvider({
    source: {
      getStatus() {},
      getTile() {},
      getSequenceImages() {},
      nearestImages() {},
    },
  });
  const both = validateProviders([mapillary, def]);
  assert.equal(requiresKeyIdFor(both), null, 'each chip gates on its own key');
  assert.throws(() => createGoogleProvider({}), /getApiKey/);
});

test('status follows the browser Maps key', async () => {
  const { instance, setKey } = setup({ key: '' });
  assert.deepEqual(await instance.status(), { configured: false });
  assert.equal(instance.coverageStats().keyRequired, true);
  setKey('browser-key');
  assert.deepEqual(await instance.status(), { configured: true });
  assert.equal(instance.coverageStats().keyRequired, false);
});

test('the nearest lookup asks Google for its own outdoor imagery within 50 m', async () => {
  const { instance, fake } = setup();
  assert.equal(
    await instance.nearestImage({ lat: 38.58, lon: -121.49 }),
    'fresh',
  );
  const [request] = fake.lookups;
  assert.deepEqual(request.location, { lat: 38.58, lng: -121.49 });
  assert.equal(request.radius, 50);
  assert.deepEqual(request.sources, ['google', 'outdoor']);
  assert.equal(request.preference, 'nearest');
});

test('no panorama nearby, or one the imagery filter excludes, is null', async () => {
  const none = setup({ nearest: () => null });
  assert.equal(await none.instance.nearestImage({ lat: 0, lon: 0 }), null);

  const { instance, fake, setFilter } = setup({ nearest: () => 'old' });
  setFilter({ pano: 'all', sinceMs: Date.UTC(2020, 0, 1) });
  assert.equal(await instance.nearestImage({ lat: 0, lon: 0 }), null);
  // Every Street View panorama is 360°: FLAT asks Google nothing.
  setFilter({ pano: 'flat', sinceMs: null });
  const asked = fake.lookups.length;
  assert.equal(await instance.nearestImage({ lat: 0, lon: 0 }), null);
  assert.equal(fake.lookups.length, asked);
  setFilter({ pano: 'pano', sinceMs: null });
  assert.equal(await instance.nearestImage({ lat: 0, lon: 0 }), 'old');
});

test('an aborted lookup gives up before asking Google', async () => {
  const { instance } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    instance.nearestImage({ lat: 0, lon: 0 }, { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('a key Google refuses reads KEY REJECTED, shows why, and stops lookups', async () => {
  const { instance, loader, reported } = setup();
  instance.activate();
  assert.equal(instance.coverageStats().hint, GROUND_CLICK_HINT);
  loader.refuseKey();
  const stats = instance.coverageStats();
  assert.equal(stats.keyRejected, true);
  assert.equal(stats.error, KEY_REJECTED_MESSAGE);
  assert.equal(stats.hint, '', 'no "click a street" hint over a dead key');
  assert.deepEqual(reported, [KEY_REJECTED_MESSAGE]);
  await assert.rejects(instance.nearestImage({ lat: 0, lon: 0 }), {
    message: KEY_REJECTED_MESSAGE,
  });
  instance.destroy();
  assert.equal(loader.listenerCount(), 0, 'destroy stops listening');
});

test('the hint shows only while the provider is on', () => {
  const { instance } = setup();
  assert.equal(instance.coverageStats().hint, '');
  instance.activate();
  assert.equal(instance.coverageStats().hint, GROUND_CLICK_HINT);
  instance.deactivate();
  assert.equal(instance.coverageStats().hint, '');
});

test('image dates, photographers and deep links read the way Google writes them', () => {
  assert.equal(imageDateMs('2024-05'), Date.UTC(2024, 4, 1));
  assert.equal(imageDateMs('2024-13'), null);
  assert.equal(imageDateMs(undefined), null);
  assert.equal(creatorFrom('© 2024 Google'), 'Google');
  assert.equal(creatorFrom('From the Owner, Photo by: Ada'), 'Ada');
  assert.equal(creatorFrom(''), null);
  assert.equal(
    streetViewUrl('a b', { heading: 90.4, pitch: -9.6 }),
    'https://www.google.com/maps/@?api=1&map_action=pano&pano=a+b&heading=90&pitch=-10',
  );
});

test('a lookup Google never answers fails after the timeout, and a refused key fails it at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { NEAREST_TIMEOUT_MS, NO_ANSWER_MESSAGE } = await import('./policy.js');
  const { instance, fake, loader } = setup();
  fake.library.StreetViewService.prototype.getPanorama = () =>
    new Promise(() => {});
  const hung = instance.nearestImage({ lat: 0, lon: 0 });
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(NEAREST_TIMEOUT_MS);
  await assert.rejects(hung, { message: NO_ANSWER_MESSAGE });

  const refused = instance.nearestImage({ lat: 0, lon: 0 });
  await Promise.resolve();
  loader.refuseKey();
  await assert.rejects(refused, { message: KEY_REJECTED_MESSAGE });
  assert.equal(
    loader.listenerCount(),
    1,
    'only the provider’s own watch is left',
  );
});

test('aborting a lookup in flight gives up at once', async () => {
  const { instance, fake } = setup();
  fake.library.StreetViewService.prototype.getPanorama = () =>
    new Promise(() => {});
  const controller = new AbortController();
  const lookup = instance.nearestImage(
    { lat: 0, lon: 0 },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(lookup, { name: 'AbortError' });
});

test('a Google outage is an error, not "no imagery here"', async () => {
  const { instance, fake } = setup();
  fake.library.StreetViewService.prototype.getPanorama = () =>
    Promise.reject(
      Object.assign(new Error('UNKNOWN_ERROR'), {
        code: 'UNKNOWN_ERROR',
        endpoint: 'STREETVIEW_GET_PANORAMA',
      }),
    );
  await assert.rejects(instance.nearestImage({ lat: 0, lon: 0 }), {
    code: 'UNKNOWN_ERROR',
  });
});

test('a refusal while the provider is off reports no error over another photo', () => {
  const { instance, loader, reported } = setup();
  loader.refuseKey();
  assert.deepEqual(reported, []);
  assert.equal(
    instance.coverageStats().keyRejected,
    true,
    'its chip still says so',
  );
});

test('a since window keeps a panorama taken any time in its cut-off month', async () => {
  const { instance, setFilter } = setup({ nearest: () => 'fresh' }); // 2025-06
  setFilter({ pano: 'all', sinceMs: Date.UTC(2025, 5, 20) });
  assert.equal(await instance.nearestImage({ lat: 0, lon: 0 }), 'fresh');
  setFilter({ pano: 'all', sinceMs: Date.UTC(2025, 6, 1) });
  assert.equal(await instance.nearestImage({ lat: 0, lon: 0 }), null);
});

test('the panorama a lookup found is dated without a second lookup', async () => {
  const { instance, fake } = setup();
  await instance.nearestImage({ lat: 38.58, lon: -121.49 });
  const host = fakeHost();
  const poses = [];
  instance.viewer.onPose((pose) => poses.push(pose));
  await instance.viewer.mount(host);
  await instance.viewer.open('fresh');
  assert.equal(poses.at(-1).capturedAt, Date.UTC(2025, 5, 1));
  assert.deepEqual(
    fake.lookups.filter((request) => request.pano),
    [],
    'no getPanorama({pano}) for a panorama the lookup already described',
  );
});
