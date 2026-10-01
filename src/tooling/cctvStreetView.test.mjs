import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cctvProxy } from '../../server/providers/cctv.js';

// T3 (NEW-HIGH-1): the CCTV frame route's Street View fallback spends the
// server's Google key. It must only ever look at server-registered cameras,
// never at client-chosen coordinates, and it must be throttled and cached.

function install(plugin, hook = 'configureServer') {
  let handler;
  plugin[hook]({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  return async (url, remoteAddress = '198.51.100.20') => {
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler(
      { url, method: 'GET', headers: {}, socket: { remoteAddress } },
      res,
    );
    return res;
  };
}

const CAMERAS = [
  {
    id: 'paris-1',
    name: 'Fixture camera one',
    lat: 30.27,
    lon: -97.74,
    headingDeg: 135,
    pitchDeg: -12,
    fovDeg: 60,
    feedType: 'image',
  },
  {
    id: 'paris-2',
    name: 'Fixture camera two',
    lat: 30.28,
    lon: -97.75,
    headingDeg: 45,
    feedType: 'image',
  },
];

function setup(t, env = {}) {
  for (const name of [
    'CCTV_SOURCES_FILE',
    'CCTV_SOURCES_JSON',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
    'GOOGLE_MAPS_API_KEY',
    'GEV_RATELIMIT_GOOGLE_PER_MIN',
    'WEBSITE_INSTANCE_ID',
    'GEV_STREETVIEW_CACHE_TTL_MS',
  ]) {
    const previous = process.env[name];
    if (name in env) process.env[name] = env[name];
    else delete process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const root = mkdtempSync(path.join(tmpdir(), 'gev-cctv-sv-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(
    path.join(root, 'config/cctv_sources.austin.json'),
    JSON.stringify(CAMERAS),
  );
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls.push(new URL(String(raw)));
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  });
  return { call: install(cctvProxy({ sourceRoot: root })), calls };
}

test('T3/T4: an unknown camera id never reaches Street View, even with coordinates', async (t) => {
  const { call, calls } = setup(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
  });
  const res = await call(
    '/frame/anything?lat=48.85&lon=2.35&heading=90&fov=90&pitch=0',
  );
  // T4: a camera dropped by a catalog refresh (or a client CAMERA_SEEDS
  // fallback id) gets the synthetic frame, not a broken <img>.
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/svg+xml');
  assert.equal(res.headers['X-CCTV-Source'], 'synthetic');
  assert.equal(calls.length, 0);
  assert.equal(String(res.body).includes('server-fixture-key'), false);
});

test('T4: the unknown-id synthetic frame escapes the client label and city', async (t) => {
  const { call, calls } = setup(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
  });
  const res = await call(
    `/frame/ghost?label=${encodeURIComponent('<script>x</script>')}&city=${encodeURIComponent('A&B"')}`,
  );
  assert.equal(res.status, 200);
  const svg = String(res.body);
  assert.equal(svg.includes('<script>'), false);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /A&amp;B/);
  assert.equal(calls.length, 0);
});

test('T3: unknown camera ids do not grow the health map', async (t) => {
  const { call } = setup(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
  });
  for (let i = 0; i < 5; i += 1) {
    await call(`/frame/ghost-${i}?lat=1&lon=2`);
    await call(`/media/ghost-media-${i}`);
  }
  const { cameras } = JSON.parse((await call('/health')).body);
  assert.deepEqual(cameras, []);
});

test('T3: a known camera uses its registered pose and ignores query coordinates', async (t) => {
  const { call, calls } = setup(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
  });
  const registered = JSON.parse((await call('/sources')).body).sources.find(
    (source) => source.id === 'paris-1',
  );
  const res = await call(
    '/frame/paris-1?lat=48.85&lon=2.35&heading=7&fov=33&pitch=5',
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-CCTV-Source'], 'streetview');
  assert.equal(calls.length, 1);
  const sv = calls[0];
  assert.equal(sv.hostname, 'maps.googleapis.com');
  assert.equal(
    sv.searchParams.get('location'),
    `${registered.lat},${registered.lon}`,
  );
  assert.equal(sv.searchParams.get('heading'), String(registered.headingDeg));
  assert.notEqual(sv.searchParams.get('heading'), '7');
  assert.notEqual(sv.searchParams.get('fov'), '33');
  assert.notEqual(sv.searchParams.get('pitch'), '5');
});

test('T3: Street View frames are not cached by default (Google terms)', async (t) => {
  const { call, calls } = setup(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
  });
  const first = await call('/frame/paris-1');
  const second = await call('/frame/paris-1?ts=2');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(calls.length, 2);
});

test('T3: GEV_STREETVIEW_CACHE_TTL_MS opts in to a per-camera cache', async (t) => {
  const { call, calls } = setup(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
    GEV_STREETVIEW_CACHE_TTL_MS: '60000',
  });
  const first = await call('/frame/paris-1');
  const second = await call('/frame/paris-1?ts=2');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers['X-CCTV-Source'], 'streetview');
  assert.deepEqual(second.body, first.body);
  assert.equal(calls.length, 1);
});

test('T3/T4: the Street View fallback honours GEV_RATELIMIT_GOOGLE_PER_MIN per client', async (t) => {
  const { call, calls } = setup(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
    GEV_RATELIMIT_GOOGLE_PER_MIN: '1',
  });
  const first = await call('/frame/paris-1', '198.51.100.30');
  assert.equal(first.status, 200);
  // T4: over budget falls through to the synthetic frame, not a 429.
  const limited = await call('/frame/paris-2', '198.51.100.30');
  assert.equal(limited.status, 200);
  assert.equal(limited.headers['X-CCTV-Source'], 'synthetic');
  assert.equal(limited.headers['Content-Type'], 'image/svg+xml');
  assert.equal(calls.length, 1);
  // A different client has its own bucket.
  const other = await call('/frame/paris-2', '198.51.100.31');
  assert.equal(other.status, 200);
  assert.equal(other.headers['X-CCTV-Source'], 'streetview');
  assert.equal(calls.length, 2);
});

test('T4: an opted-in Street View cache entry expires after its TTL', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const { call, calls } = setup(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
    GEV_STREETVIEW_CACHE_TTL_MS: '1000',
  });
  await call('/frame/paris-1');
  t.mock.timers.tick(999);
  await call('/frame/paris-1');
  assert.equal(calls.length, 1, 'still cached inside the TTL');
  t.mock.timers.tick(1);
  const refreshed = await call('/frame/paris-1');
  assert.equal(refreshed.headers['X-CCTV-Source'], 'streetview');
  assert.equal(calls.length, 2, 'expired entry is fetched again');
});

test('T4: the Street View cache holds at most 256 cameras, evicting the oldest', async (t) => {
  const many = Array.from({ length: 257 }, (_, i) => ({
    id: `bulk-${i}`,
    name: `Bulk ${i}`,
    lat: 30 + i / 1000,
    lon: -97,
    headingDeg: 0,
    feedType: 'image',
  }));
  const { call, calls } = setup(t, {
    GOOGLE_MAPS_SERVER_API_KEY: 'server-fixture-key',
    GEV_STREETVIEW_CACHE_TTL_MS: '600000',
    CCTV_SOURCES_JSON: JSON.stringify(many),
  });
  for (const camera of many) await call(`/frame/${camera.id}`);
  assert.equal(calls.length, 257);
  await call('/frame/bulk-256');
  assert.equal(calls.length, 257, 'the newest entry is still cached');
  await call('/frame/bulk-1');
  assert.equal(calls.length, 257, 'the second-oldest entry survived');
  await call('/frame/bulk-0');
  assert.equal(calls.length, 258, 'the oldest entry was evicted');
});
