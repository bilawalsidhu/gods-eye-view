import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STREET_VIEW_DAILY_MAX_REQUESTS,
  STREET_VIEW_MAX_REQUESTS,
  STREET_VIEW_PER_CLIENT_MAX_REQUESTS,
  createStreetViewAdmission,
  processStreetViewAdmission,
  registeredStreetViewLocation,
  streetViewCapFromEnv,
} from './streetViewGuard.js';
import { cctvProxy } from '../cctv.js';

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
    { lat: 10, lon: -20, heading: 350, fov: 120, pitch: -40 },
  );
  assert.deepEqual(
    registeredStreetViewLocation({ id: 'zero', lat: 0, lon: 0 }),
    { lat: 0, lon: 0, heading: 0, fov: 80, pitch: 0 },
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
  assert.equal(await ask('a', 'a-16'), null);
  for (let i = 0; i < 16; i += 1)
    assert.equal((await ask('b', 'b-' + i))?.ok, true);
  assert.equal(await ask('c', 'c-1'), null);
  assert.equal(calls, 32);
  clock = 1000;
  assert.equal(await ask('c', 'c-1'), null, 'daily cap survives minute reset');
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
    null,
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
  assert.equal(await miss('camera-a'), null);
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
  cctvProxy().configureServer({
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
  assert.equal(streetViewCalls[0].searchParams.get('heading'), '0');
  for (let i = 1; i < 15; i += 1)
    assert.equal(await frame('camera-' + i), 'streetview');
  assert.equal(streetViewCalls.length, 15);
  assert.equal(await frame('camera-0'), 'synthetic');
  assert.equal(
    await frame('camera-15', '', { 'x-forwarded-for': '127.0.0.1' }),
    'synthetic',
  );
  assert.equal(streetViewCalls.length, 15);
  assert.equal(await frame('camera-15'), 'streetview');
  assert.equal(streetViewCalls.length, 16);
});
