import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleViewer } from './viewer.js';
import { DETAILS_RETRY_COOLDOWN_MS, DETAILS_TIMEOUT_MS } from './policy.js';
import {
  fakeHost,
  fakeMapsLoader,
  fakeStreetViewLibrary,
} from '../../../../testSupport/googleStreetViewFakes.mjs';

const PANORAMAS = {
  'pano-a': {
    lat: 38.5816,
    lng: -121.4944,
    imageDate: '2024-05',
    copyright: '© 2024 Google',
    description: '10th St',
  },
  'pano-b': {
    lat: 38.5817,
    lng: -121.4944,
    imageDate: '2019-08',
    copyright: 'From the Owner, Photo by: Ada',
  },
};

function setup() {
  const fake = fakeStreetViewLibrary({ panoramas: PANORAMAS });
  const loader = fakeMapsLoader(fake.library);
  const viewer = createGoogleViewer({ loader });
  const poses = [];
  viewer.onPose((pose) => poses.push(pose));
  const host = fakeHost();
  return { fake, loader, viewer, poses, host };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('opening a panorama shows it and emits a provider-neutral pose', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  assert.equal(host.children.length, 1, 'renders in its own element');
  const [panorama] = fake.built;
  assert.equal(panorama.options.fullscreenControl, false);
  assert.equal(panorama.options.addressControl, false, 'the caption has it');
  assert.equal(panorama.options.enableCloseButton, false);
  assert.equal(panorama.visible, false, 'nothing shows before an open');

  await viewer.open('pano-a');
  assert.equal(panorama.visible, true);
  await settle(); // the pose is dated once its lookup answers
  const pose = poses.at(-1);
  assert.deepEqual(
    {
      providerId: pose.providerId,
      imageId: pose.imageId,
      position: pose.position,
      isPano: pose.isPano,
      capturedAt: pose.capturedAt,
      capturedAtPrecision: pose.capturedAtPrecision,
      creator: pose.creator,
      title: pose.title,
    },
    {
      providerId: 'google',
      imageId: 'pano-a',
      position: { lon: -121.4944, lat: 38.5816 },
      isPano: true,
      capturedAt: Date.UTC(2024, 4, 1),
      capturedAtPrecision: 'month',
      creator: 'Google',
      title: '10th St',
    },
  );
  assert.match(pose.externalUrl, /map_action=pano&pano=pano-a/);
});

test('dragging the view and stepping along an arrow both emit poses; the date is looked up once per panorama', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  await viewer.open('pano-a');
  const [panorama] = fake.built;
  panorama.setPov({ heading: 90, pitch: -10 });
  await settle();
  assert.deepEqual(
    [poses.at(-1).bearing, poses.at(-1).tilt],
    [90, -10],
    'the view follows the drag',
  );
  // Google's own arrow: the panorama changes without an open.
  panorama.setPano('pano-b');
  await settle();
  await settle();
  assert.equal(poses.at(-1).imageId, 'pano-b');
  assert.equal(poses.at(-1).creator, 'Ada');
  const dateLookups = fake.lookups.filter((request) => request.pano);
  assert.deepEqual(
    dateLookups.map((request) => request.pano),
    ['pano-a', 'pano-b'],
  );
});

test('a panorama Google has no imagery for fails the open', async () => {
  const { viewer, host } = setup();
  await viewer.mount(host);
  await assert.rejects(viewer.open('gone'), /no imagery/);
});

test('a closed panorama is hidden and its late view changes emit nothing', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  await viewer.open('pano-a');
  const [panorama] = fake.built;
  viewer.close();
  assert.equal(panorama.visible, false);
  const count = poses.length;
  panorama.setPov({ heading: 180, pitch: 0 });
  await settle();
  assert.equal(poses.length, count);
});

test('an open overtaken by a newer one only shows the newer panorama', async () => {
  const { viewer, poses, host } = setup();
  await viewer.mount(host);
  const first = viewer.open('pano-a');
  const second = viewer.open('pano-b');
  await Promise.all([first, second]);
  assert.deepEqual(
    [...new Set(poses.map((pose) => pose.imageId))].at(-1),
    'pano-b',
  );
  assert.ok(!poses.some((pose) => pose.imageId === 'pano-a'));
});

test('unmounting removes the element and every listener', async () => {
  const { fake, viewer, host } = setup();
  await viewer.mount(host);
  const [panorama] = fake.built;
  assert.ok(panorama.listenerCount() > 0);
  viewer.unmount();
  assert.equal(host.children.length, 0);
  assert.equal(panorama.listenerCount(), 0);
  await assert.rejects(viewer.open('pano-a'), /not mounted/);
});

test('there is no prewarm: Google\u2019s script loads on first use only, never on another map', () => {
  const { viewer, loader } = setup();
  assert.equal(viewer.prewarm, undefined);
  assert.deepEqual(loader.imports, []);
});

test('a key Google refuses fails the open at once, not after the timeout', async () => {
  const { fake, loader, viewer, host } = setup();
  await viewer.mount(host);
  const [panorama] = fake.built;
  // Google refuses the key while the panorama loads; it never reports OK.
  panorama.setPano = (id) => {
    panorama.pano = id;
    queueMicrotask(() => loader.refuseKey());
  };
  await assert.rejects(viewer.open('pano-a'), /Maps JavaScript API is enabled/);
  await assert.rejects(viewer.open('pano-b'), /Maps JavaScript API is enabled/);
  assert.equal(loader.listenerCount(), 0, 'no auth listener is left behind');
});

test('a viewer unmounted while the library loads builds no panorama (none is billed)', async () => {
  const fake = fakeStreetViewLibrary({ panoramas: PANORAMAS });
  const loader = fakeMapsLoader(fake.library, { deferred: true });
  const viewer = createGoogleViewer({ loader });
  const host = fakeHost();
  const mounting = viewer.mount(host);
  viewer.unmount();
  loader.release();
  await assert.rejects(mounting, /unmounted/);
  assert.equal(fake.built.length, 0);
  assert.equal(host.children.length, 0);
});

test('a date that arrives after the photo was closed emits nothing', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  await viewer.open('pano-a');
  const [panorama] = fake.built;
  let answer;
  fake.library.StreetViewService.prototype.getPanorama = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  panorama.setPano('pano-b'); // Google's arrow; its date is still unknown
  await settle();
  assert.equal(poses.at(-1).imageId, 'pano-b', 'the step shows at once');
  assert.equal(
    poses.at(-1).capturedAt,
    null,
    'undated until the lookup answers',
  );
  viewer.close();
  const count = poses.length;
  answer({ data: { imageDate: '2019-08' } });
  await settle();
  assert.equal(poses.length, count);
});

test('an open never waits on the date lookup', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  fake.library.StreetViewService.prototype.getPanorama = () =>
    new Promise(() => {}); // the metadata never answers
  await viewer.open('pano-a');
  assert.equal(poses.at(-1).imageId, 'pano-a');
  viewer.unmount();
});

test('closing while a panorama loads settles the open and drops its listeners', async () => {
  const { fake, loader, viewer, host } = setup();
  await viewer.mount(host);
  const [panorama] = fake.built;
  const before = panorama.listenerCount();
  panorama.setPano = (id) => {
    panorama.pano = id; // still loading
  };
  const opening = viewer.open('pano-a');
  await settle();
  viewer.close();
  await opening;
  assert.equal(panorama.listenerCount(), before);
  assert.equal(loader.listenerCount(), 0);
});

test('a second open whose status stays OK still resolves, on the new position', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  await viewer.open('pano-a');
  assert.equal(fake.built[0].getStatus(), 'OK');
  await viewer.open('pano-b'); // OK → OK: no status_changed
  assert.equal(poses.at(-1).imageId, 'pano-b');
});

test('Google answering with a newer id for the place shows that id', async () => {
  const fake = fakeStreetViewLibrary({
    panoramas: PANORAMAS,
    substitutes: { 'old-id': 'pano-a' },
  });
  const viewer = createGoogleViewer({ loader: fakeMapsLoader(fake.library) });
  const poses = [];
  viewer.onPose((pose) => poses.push(pose));
  await viewer.mount(fakeHost());
  await viewer.open('old-id');
  assert.equal(poses.at(-1).imageId, 'pano-a');
});

test('a panorama that never shows fails after the timeout and leaves no listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { OPEN_TIMEOUT_MS, NO_ANSWER_MESSAGE } = await import('./policy.js');
  const { fake, loader, viewer, host } = setup();
  await viewer.mount(host);
  const [panorama] = fake.built;
  const before = panorama.listenerCount();
  panorama.setPano = (id) => {
    panorama.pano = id; // Google never answers
  };
  const opening = viewer.open('pano-a');
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(OPEN_TIMEOUT_MS);
  await assert.rejects(opening, { message: NO_ANSWER_MESSAGE });
  assert.equal(panorama.listenerCount(), before);
  assert.equal(loader.listenerCount(), 0);
});

test('failed details lookups cool down through repeated drags and retry after the pause', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  const getPanorama = fake.library.StreetViewService.prototype.getPanorama;
  let failures = 2;
  let calls = 0;
  fake.library.StreetViewService.prototype.getPanorama = function (request) {
    calls++;
    if (failures-- > 0) return Promise.reject(new Error('offline'));
    return getPanorama.call(this, request);
  };
  await viewer.open('pano-a');
  assert.equal(poses.at(-1).capturedAt, null, 'undated while it failed');
  assert.equal(calls, 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let heading = 0; heading < 20; heading++) {
      fake.built[0].setPov({ heading, pitch: 0 });
      await settle();
    }
    assert.equal(calls, attempt + 1, 'drags do not retry during the pause');
    assert.equal(poses.at(-1).bearing, 19, 'pose updates still follow drags');
    now += DETAILS_RETRY_COOLDOWN_MS - 1;
    fake.built[0].setPov({ heading: 20, pitch: 0 });
    await settle();
    assert.equal(calls, attempt + 1, 'still paused just before the deadline');
    now++;
    fake.built[0].setPov({ heading: 21, pitch: 0 });
    await settle();
    assert.equal(calls, attempt + 2, 'one retry at the deadline');
  }
  assert.equal(poses.at(-1).capturedAt, Date.UTC(2024, 4, 1));
  now += DETAILS_RETRY_COOLDOWN_MS;
  fake.built[0].setPov({ heading: 10, pitch: 0 });
  await settle();
  assert.equal(calls, 3, 'successful details stay cached');
});

test('a failed panorama does not delay details for another panorama', async (t) => {
  t.mock.method(Date, 'now', () => 1_000);
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  const getPanorama = fake.library.StreetViewService.prototype.getPanorama;
  const requests = [];
  fake.library.StreetViewService.prototype.getPanorama = function (request) {
    requests.push(request.pano);
    if (request.pano === 'pano-a') return Promise.reject(new Error('offline'));
    return getPanorama.call(this, request);
  };
  await viewer.open('pano-a');
  fake.built[0].setPano('pano-b');
  await settle();
  assert.deepEqual(requests, ['pano-a', 'pano-b']);
  assert.equal(poses.at(-1).creator, 'Ada');
  fake.built[0].setPano('pano-a');
  await settle();
  assert.deepEqual(
    requests,
    ['pano-a', 'pano-b'],
    'returning respects the pause',
  );
});

test('a retry after a failed open is not failed by the old panorama\u2019s status', async () => {
  const { viewer, poses, host } = setup();
  await viewer.mount(host);
  await assert.rejects(viewer.open('gone'), /no imagery/);
  // The new panorama moves first; its OK status follows.
  await viewer.open('pano-a');
  assert.equal(poses.at(-1).imageId, 'pano-a');
});

test('a details lookup that never answers times out, cools down and retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  const getPanorama = fake.library.StreetViewService.prototype.getPanorama;
  const requests = [];
  let hang = true;
  fake.library.StreetViewService.prototype.getPanorama = function (request) {
    requests.push(request.pano);
    return hang ? new Promise(() => {}) : getPanorama.call(this, request);
  };
  const opening = viewer.open('pano-a');
  await flush();
  await opening;
  assert.deepEqual(requests, ['pano-a']);
  fake.built[0].setPov({ heading: 5, pitch: 0 });
  await flush();
  assert.deepEqual(requests, ['pano-a'], 'one lookup in flight at a time');
  t.mock.timers.tick(DETAILS_TIMEOUT_MS);
  await flush();
  hang = false;
  fake.built[0].setPov({ heading: 6, pitch: 0 });
  await flush();
  assert.deepEqual(requests, ['pano-a'], 'the cooldown follows a timeout');
  t.mock.timers.tick(DETAILS_RETRY_COOLDOWN_MS);
  fake.built[0].setPov({ heading: 7, pitch: 0 });
  await flush();
  assert.deepEqual(requests, ['pano-a', 'pano-a']);
  assert.equal(poses.at(-1).capturedAt, Date.UTC(2024, 4, 1));
  assert.equal(poses.at(-1).bearing, 7);
});

test('a remount looks up again a panorama whose lookup hung', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  const getPanorama = fake.library.StreetViewService.prototype.getPanorama;
  const requests = [];
  let answerHung;
  fake.library.StreetViewService.prototype.getPanorama = function (request) {
    requests.push(request.pano);
    if (requests.length === 1)
      return new Promise((resolve) => {
        answerHung = () => resolve(getPanorama.call(this, request));
      });
    return getPanorama.call(this, request);
  };
  await viewer.open('pano-b');
  viewer.unmount();
  await viewer.mount(host);
  await viewer.open('pano-b');
  await settle();
  assert.deepEqual(requests, ['pano-b', 'pano-b']);
  assert.equal(poses.at(-1).creator, 'Ada');
  // The hung answer arriving now is for a viewer that is gone: dropped.
  const count = poses.length;
  answerHung();
  await settle();
  assert.equal(poses.length, count);
});

test('superseded panorama waits cannot steal the current close cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { OPEN_TIMEOUT_MS } = await import('./policy.js');
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const { fake, loader, viewer, host } = setup();
  await viewer.mount(host);
  const [panorama] = fake.built;
  panorama.setPano = (id) => {
    panorama.pano = id;
  };
  const first = viewer.open('pano-a');
  await flush();
  const second = viewer.open('pano-b');
  await flush();
  panorama.fire('position_changed'); // new panorama has not reached OK
  await flush();
  viewer.close();
  const remaining = loader.listenerCount();
  t.mock.timers.tick(OPEN_TIMEOUT_MS);
  await Promise.allSettled([first, second]);
  assert.equal(
    remaining,
    0,
    'close disposes every pending open without waiting 20 seconds',
  );
  assert.equal(panorama.visible, false);
});

test('unmount during details-service acquisition makes no later billed lookup', async () => {
  const fake = fakeStreetViewLibrary({ panoramas: PANORAMAS });
  const loader = fakeMapsLoader(fake.library);
  const { createGoogleProvider } = await import('./index.js');
  let release;
  const acquiring = new Promise((resolve) => {
    release = resolve;
  });
  const importLibrary = loader.importLibrary.bind(loader);
  let imports = 0;
  loader.importLibrary = async (name) => {
    if (++imports > 1) await acquiring;
    return importLibrary(name);
  };
  const provider = createGoogleProvider({
    getApiKey: () => 'fixture-key',
    loader,
  });
  const instance = provider.create({
    notify() {},
    actions: { reportError() {} },
  });
  const viewer = instance.viewer;
  await viewer.mount(fakeHost());
  await viewer.open('pano-a');
  viewer.unmount();
  release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(
    fake.lookups.length,
    0,
    'teardown invalidates the request before calling getPanorama',
  );
  instance.destroy();
});
