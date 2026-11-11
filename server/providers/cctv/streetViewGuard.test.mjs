import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STREET_VIEW_DAILY_MAX_REQUESTS,
  STREET_VIEW_DEFERRED,
  STREET_VIEW_MAX_REQUESTS,
  STREET_VIEW_PER_CLIENT_MAX_REQUESTS,
  createStreetViewAdmission,
  processStreetViewAdmission,
  registeredStreetViewLocation,
  streetViewCapFromEnv,
} from './streetViewGuard.js';
import { cctvProxy } from '../cctv.js';
import { cctvFallbackHeadingFromId } from '../../../src/sources/cctvPose.js';

test('only catalog cameras with valid coordinates can reach Google', () => {
  for (const invalid of [
    null,
    { id: 'x', lat: null, lon: 0 },
    { id: 'x', lat: '', lon: 0 },
    { id: 'x', lat: '  ', lon: 0 },
    { id: 'x', lat: 0, lon: '' },
    { id: 'x', lat: 91, lon: 0 },
    { id: 'x', lat: 0, lon: 181 },
    { id: 'x', lat: 'bad', lon: 0 },
    { id: 'x', lat: Infinity, lon: 0 },
    { lat: 10, lon: 20 },
  ]) {
    assert.equal(registeredStreetViewLocation(invalid), null);
  }
  assert.deepEqual(
    registeredStreetViewLocation({
      id: 'registered',
      lat: 10,
      lon: -20,
      headingDeg: -10,
      fovDeg: 900,
      pitchDeg: -900,
    }),
    { lat: 10, lon: -20, heading: 350, fov: 120, pitch: -55 },
  );
  assert.deepEqual(
    registeredStreetViewLocation({ id: 'zero', lat: 0, lon: 0 }),
    { lat: 0, lon: 0, heading: 0, fov: 74, pitch: -17 },
  );
  assert.equal(cctvFallbackHeadingFromId('camera-0'), 135);
  assert.deepEqual(
    registeredStreetViewLocation({
      id: 'camera-0',
      lat: 35,
      lon: 139,
      headingDeg: null,
      pitchDeg: '',
      fovDeg: ' ',
    }),
    { lat: 35, lon: 139, heading: 135, fov: 74, pitch: -17 },
  );
});

test('operator configuration cannot accidentally disable the quota', () => {
  assert.equal(streetViewCapFromEnv(undefined, 32), 32);
  assert.equal(streetViewCapFromEnv('invalid', 32), 32);
  assert.equal(streetViewCapFromEnv('999999999', 32), 32);
  assert.equal(streetViewCapFromEnv('15', 32), 15);
  assert.equal(streetViewCapFromEnv('0', 32), 0);
  assert.throws(() => createStreetViewAdmission({ globalMax: -1 }), TypeError);
  assert.throws(() => createStreetViewAdmission({ maxPending: 0 }), TypeError);
});

test('client, process and daily caps allow a 15-camera burst', async () => {
  let clock = 0;
  let calls = 0;
  const admission = createStreetViewAdmission({
    now: () => clock,
    windowMs: 1000,
    dailyWindowMs: 10_000,
    perClientMax: 16,
    globalMax: 32,
    dailyMax: 32,
    successCooldownMs: 0,
  });
  const ask = (client, id) =>
    admission.run({
      client,
      cameraKey: id,
      fetchFrame: async () => {
        calls += 1;
        return { ok: true };
      },
    });
  for (let i = 0; i < 15; i += 1)
    assert.equal((await ask('a', 'a-' + i))?.ok, true);
  assert.equal((await ask('a', 'a-15'))?.ok, true);
  assert.strictEqual(await ask('a', 'a-16'), STREET_VIEW_DEFERRED);
  for (let i = 0; i < 16; i += 1)
    assert.equal((await ask('b', 'b-' + i))?.ok, true);
  assert.strictEqual(await ask('c', 'c-1'), STREET_VIEW_DEFERRED);
  assert.equal(calls, 32);
  clock = 1000;
  assert.strictEqual(
    await ask('c', 'c-1'),
    STREET_VIEW_DEFERRED,
    'daily cap survives minute reset',
  );
  clock = 10_000;
  assert.equal((await ask('c', 'c-1'))?.ok, true);
  assert.equal(calls, 33);
  assert.equal(STREET_VIEW_PER_CLIENT_MAX_REQUESTS, 16);
  assert.equal(STREET_VIEW_MAX_REQUESTS, 32);
  assert.equal(STREET_VIEW_DAILY_MAX_REQUESTS, 512);
});

test('concurrent misses coalesce without a completed-image cache', async () => {
  let clock = 10;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const admission = createStreetViewAdmission({
    now: () => clock,
    successCooldownMs: 100,
    failureCooldownMs: 200,
  });
  const first = admission.run({
    client: 'client-a',
    cameraKey: 'a:registered-pose',
    fetchFrame: async () => {
      calls += 1;
      await gate;
      return { ok: true, body: Buffer.from('test-frame') };
    },
  });
  const others = Array.from({ length: 9 }, () =>
    admission.run({
      client: 'client-b',
      cameraKey: 'a:registered-pose',
      fetchFrame: () => {
        throw new Error('coalesced request must not fetch');
      },
    }),
  );
  assert.equal(admission.stats().coalesced, 9);
  assert.equal(admission.stats().attempts, 1);
  release();
  const frames = await Promise.all([first, ...others]);
  assert.equal(calls, 1);
  assert.equal(
    frames.every((result) => result?.ok),
    true,
  );
  assert.equal(
    await admission.run({
      client: 'client-a',
      cameraKey: 'a:registered-pose',
      fetchFrame: () => {
        throw new Error('cooldown should block');
      },
    }),
    STREET_VIEW_DEFERRED,
  );
  clock = 110;
  const another = await admission.run({
    client: 'client-a',
    cameraKey: 'a:registered-pose',
    fetchFrame: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  assert.equal(another?.ok, true);
  assert.equal(calls, 2, 'no completed response byte cache is retained');
});

test('failed camera cooldown does not block other cameras', async () => {
  let clock = 0;
  let calls = 0;
  const admission = createStreetViewAdmission({
    now: () => clock,
    failureCooldownMs: 200,
    successCooldownMs: 100,
  });
  const miss = (cameraKey) =>
    admission.run({
      client: 'viewer',
      cameraKey,
      fetchFrame: async () => {
        calls += 1;
        return null;
      },
    });
  assert.equal(await miss('camera-a'), null);
  assert.strictEqual(await miss('camera-a'), STREET_VIEW_DEFERRED);
  assert.equal(calls, 1);
  assert.equal(await miss('camera-b'), null);
  assert.equal(calls, 2);
  clock = 200;
  assert.equal(await miss('camera-a'), null);
  assert.equal(calls, 3);
  assert.equal(admission.stats().failures, 3);
});

test('one process-wide admission service is shared by plugin instances', () => {
  assert.strictEqual(
    processStreetViewAdmission(),
    processStreetViewAdmission(),
  );
});

test('frame route protects catalog pose, 15 cameras and forwarded requests', async (t) => {
  const names = [
    'CCTV_SOURCES_JSON',
    'CCTV_SOURCES_FILE',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
  ];
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.CCTV_SOURCES_JSON = JSON.stringify(
    Array.from({ length: 16 }, (_, index) => ({
      id: 'camera-' + index,
      name: 'Fixture camera ' + index,
      lat: 30.2672 + index / 1000,
      lon: -97.7431,
      feedType: 'image',
    })),
  );
  process.env.CCTV_SOURCES_FILE = 'not-a-real-cctv-source.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-only-street-view-key';

  const originalFetch = globalThis.fetch;
  const streetViewCalls = [];
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (
      target.hostname === 'maps.googleapis.com' &&
      target.pathname === '/maps/api/streetview'
    ) {
      streetViewCalls.push(target);
      return new Response(Buffer.from('fake-jpeg'), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response('not found', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });

  let handler;
  cctvProxy({
    streetViewAdmission: createStreetViewAdmission(),
  }).configureServer({
    middlewares: {
      use: (_route, middleware) => {
        handler = middleware;
      },
    },
  });
  const frame = (id, query = '', headers = {}) =>
    new Promise((resolve, reject) => {
      let source = null;
      const response = {
        writeHead(_status, received) {
          source = received['X-CCTV-Source'];
        },
        end() {
          resolve(source);
        },
      };
      const request = {
        url: '/frame/' + id + query,
        method: 'GET',
        headers,
        socket: { remoteAddress: '127.0.0.1' },
        on() {},
      };
      Promise.resolve(handler(request, response)).catch(reject);
    });

  assert.equal(await frame('unknown', '?lat=48.8584&lon=2.2945'), 'synthetic');
  assert.equal(streetViewCalls.length, 0);
  assert.equal(
    await frame('camera-0', '?lat=48.8584&lon=2.2945&heading=199'),
    'streetview',
  );
  assert.equal(
    streetViewCalls[0].searchParams.get('location'),
    '30.2672,-97.7431',
  );
  assert.equal(streetViewCalls[0].searchParams.get('heading'), '135');
  assert.equal(streetViewCalls[0].searchParams.get('pitch'), '-17');
  assert.equal(
    await frame('camera-15', '', { 'x-forwarded-for': '127.0.0.1' }),
    'synthetic',
  );
  assert.equal(streetViewCalls.length, 1);
  for (let i = 1; i < 15; i += 1)
    assert.equal(await frame('camera-' + i), 'streetview');
  assert.equal(streetViewCalls.length, 15);
  // Successful images are not retained: a new lookup consumes another slot.
  assert.equal(await frame('camera-0'), 'streetview');
  assert.equal(streetViewCalls.length, 16);
  assert.equal(await frame('camera-15'), 'deferred');
  assert.equal(streetViewCalls.length, 16);
});

test('rolling daily budget never doubles across the period boundary', async () => {
  let clock = 99;
  const admission = createStreetViewAdmission({
    now: () => clock,
    windowMs: 100,
    dailyWindowMs: 1000,
    perClientMax: 10,
    globalMax: 10,
    dailyMax: 2,
  });
  const request = (id) =>
    admission.run({
      client: 'viewer',
      cameraKey: id,
      fetchFrame: async () => ({ ok: true }),
    });
  assert.equal((await request('a'))?.ok, true);
  clock = 100;
  assert.equal((await request('b'))?.ok, true);
  clock = 199;
  assert.strictEqual(await request('c'), STREET_VIEW_DEFERRED);
  clock = 1099;
  assert.equal((await request('c'))?.ok, true);
  assert.strictEqual(await request('d'), STREET_VIEW_DEFERRED);
  clock = 1100;
  assert.equal((await request('d'))?.ok, true);
});

test('15 concurrent different cameras are bounded by eight pending slots', async () => {
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const admission = createStreetViewAdmission({
    perClientMax: 16,
    globalMax: 32,
    maxPending: 8,
  });
  const promises = Array.from({ length: 15 }, (_, index) =>
    admission.run({
      client: 'same-viewer',
      cameraKey: 'camera-' + index,
      fetchFrame: async () => {
        calls += 1;
        await gate;
        return { ok: true };
      },
    }),
  );
  assert.equal(admission.stats().attempts, 8);
  assert.equal(admission.stats().pending, 8);
  assert.equal(admission.stats().denied, 7);
  release();
  const results = await Promise.all(promises);
  assert.equal(results.filter((result) => result?.ok).length, 8);
  assert.equal(
    results.filter((result) => result === STREET_VIEW_DEFERRED).length,
    7,
  );
  assert.equal(calls, 8);
});

test('two mounted CCTV plugins use the same process Street View budget', async (t) => {
  const names = [
    'CCTV_SOURCES_JSON',
    'CCTV_SOURCES_FILE',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
  ];
  const beforeEnv = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.CCTV_SOURCES_JSON = JSON.stringify(
    ['shared-a', 'shared-b'].map((id) => ({
      id,
      name: id,
      lat: 30.2672,
      lon: -97.7431,
      feedType: 'image',
    })),
  );
  process.env.CCTV_SOURCES_FILE = 'not-a-real-cctv-source.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-only-street-view-key';

  const originalFetch = globalThis.fetch;
  let googleCalls = 0;
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (
      target.hostname === 'maps.googleapis.com' &&
      target.pathname === '/maps/api/streetview'
    ) {
      googleCalls += 1;
      return new Response(Buffer.from('fake-jpeg'), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response('not found', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (beforeEnv[name] === undefined) delete process.env[name];
      else process.env[name] = beforeEnv[name];
    }
  });

  const mount = () => {
    let handler;
    cctvProxy().configureServer({
      middlewares: {
        use: (_route, middleware) => {
          handler = middleware;
        },
      },
    });
    return handler;
  };
  const firstPlugin = mount();
  const secondPlugin = mount();
  const frame = (handler, cameraId) =>
    new Promise((resolve, reject) => {
      let status;
      let source;
      const response = {
        writeHead(code, headers) {
          status = code;
          source = headers['X-CCTV-Source'];
        },
        end() {
          resolve({ status, source });
        },
      };
      const request = {
        url: '/frame/' + cameraId,
        method: 'GET',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
        on() {},
      };
      Promise.resolve(handler(request, response)).catch(reject);
    });

  const shared = processStreetViewAdmission();
  const attemptsBefore = shared.stats().attempts;
  assert.deepEqual(await frame(firstPlugin, 'shared-a'), {
    status: 200,
    source: 'streetview',
  });
  assert.deepEqual(await frame(secondPlugin, 'shared-b'), {
    status: 200,
    source: 'streetview',
  });
  assert.equal(googleCalls, 2);
  assert.equal(
    shared.stats().attempts - attemptsBefore,
    2,
    'both plugin routes must charge the process-owned admission service',
  );
});
