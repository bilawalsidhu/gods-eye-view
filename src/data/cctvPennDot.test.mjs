import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import {
  CAMERA_CODE_MAX_CHARS,
  normalizeSourceItem,
} from '../../server/providers/cctv/normalize.js';
import {
  pennDotCameraToSources,
  loadPennDotSources,
  createPennDotStreamResolver,
  fetchPennDotMedia,
} from '../../server/providers/cctv/penndot.js';

const base = 'https://pa-se3.arcadis-ivds.com:8200/chan-4206/index.m3u8';

test('511PA media carries its required public-player origin headers only on the registered CDN', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response('ok');
  };
  const init = {
    redirect: 'error',
    headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
  };
  await fetchPennDotMedia(base, init, fetchImpl);
  assert.equal(calls[0].init.headers.Origin, 'https://511pa.com');
  assert.equal(calls[0].init.headers.Referer, 'https://511pa.com/');
  assert.equal(calls[0].init.redirect, 'error');
  await fetchPennDotMedia('https://camera.example/other.m3u8', init, fetchImpl);
  assert.equal(calls[1].init, init);
  await fetchPennDotMedia(
    base.replace('pa-se3.', 'pa-se3.evil.'),
    init,
    fetchImpl,
  );
  assert.equal(calls[2].init, init);
});
const site = (patch = {}) => ({
  id: 3803,
  visible: true,
  county: 'Chester',
  cameraName: 'CAM06061CM223',
  location: 'US-202 @ PA-3/ WEST CHESTER PIKE',
  latLng: {
    geography: {
      coordinateSystemId: 4326,
      wellKnownText: 'POINT (-75.5815 39.9672)',
    },
  },
  images: [
    {
      id: 5852,
      videoUrl: base,
      videoDisabled: false,
      disabled: false,
      blocked: false,
      description: 'Traffic closest to camera is traveling Northbound',
    },
  ],
  ...patch,
});

async function withEnv(values, run) {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, values);
    return await run();
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('511PA uses published WGS84 coordinates and separate image ids; traffic direction is not a heading', () => {
  const [camera] = pennDotCameraToSources(site());
  assert.equal(camera.id, '511pa-5852');
  assert.equal(camera.lat, 39.9672);
  assert.equal(camera.lon, -75.5815);
  assert.equal(camera.city, 'Chester County, PA');
  assert.equal(camera.url, base);
  assert.equal(camera.snapshotUrl, 'https://511pa.com/map/Cctv/5852');
  assert.equal(camera.headingDeg, undefined);
  assert.equal(camera.headingConfidence, 'unknown');
  assert.match(camera.credit, /Northbound/);
});

test('511PA map labels use published roads and intersections instead of asset keys', () => {
  const [camera] = pennDotCameraToSources(
    site({ location: 'US-202 @ PAOLI PIKE' }),
  );
  assert.equal(camera.name, 'US-202 @ PAOLI PIKE');
  assert.equal(camera.code, 'US-202 @ PAOLI PIKE');
  assert.equal(normalizeSourceItem(camera).code, 'US-202 @ PAOLI PIKE');
  assert.equal(camera.id, '511pa-5852');

  const [long] = pennDotCameraToSources(site());
  assert.equal(long.name, 'US-202 @ PA-3/ WEST CHESTER PIKE');
  assert.equal(long.code, 'US-202 @ PA-3/ WEST CHESTER…');
  assert.ok(long.code.length <= CAMERA_CODE_MAX_CHARS);
  assert.equal(normalizeSourceItem(long).name, long.name);
});

test('511PA labels use roadway when location is blank or repeats an asset key', () => {
  for (const location of [
    undefined,
    null,
    '',
    '   ',
    'CAM06061CM223',
    ' CAM12029PORTABLE ',
  ]) {
    const [camera] = pennDotCameraToSources(
      site({ location, roadway: ' US 202 ' }),
    );
    assert.equal(camera.name, 'US 202');
    assert.equal(camera.code, 'US 202');
  }
  const [fallback] = pennDotCameraToSources(
    site({ location: '', roadway: '', cameraName: 'CAM06061CM223' }),
  );
  assert.equal(fallback.name, 'CAM06061CM223');
  const [unnamed] = pennDotCameraToSources(
    site({ location: null, roadway: null, cameraName: null }),
  );
  assert.equal(unnamed.name, 'Pennsylvania traffic camera');
});

test('offline video falls back to snapshots; blocked views, malformed ids and bad geometry are omitted', () => {
  for (const image of [
    { id: 5852 },
    { id: 5852, videoUrl: base, videoDisabled: true },
    { id: 5852, videoUrl: 'https://evil.example/index.m3u8' },
    { id: 5852, videoUrl: base.replace('pa-se3.', 'pa-se3.evil.') },
  ]) {
    const [camera] = pennDotCameraToSources(site({ images: [image] }));
    assert.equal(camera.feedType, 'image');
    assert.equal(camera.url, camera.snapshotUrl);
  }
  for (const image of [
    { id: '../5852' },
    { id: 0 },
    { id: 5852, blocked: true },
    { id: 5852, disabled: true },
  ])
    assert.deepEqual(pennDotCameraToSources(site({ images: [image] })), []);
  for (const patch of [
    { visible: false },
    { latLng: null },
    {
      latLng: {
        geography: {
          coordinateSystemId: 3857,
          wellKnownText: 'POINT (-75.5 40)',
        },
      },
    },
    {
      latLng: {
        geography: {
          coordinateSystemId: 4326,
          wellKnownText: 'POINT (-97 30)',
        },
      },
    },
  ])
    assert.deepEqual(pennDotCameraToSources(site(patch)), []);
});

test('county filtering works; statewide pagination defaults to all and prioritizes regional anchors under a cap', async () => {
  await withEnv(
    { CCTV_511PA_COUNTIES: 'Chester', CCTV_511PA_MAX_SOURCES: '2000' },
    async () => {
      const cameras = await loadPennDotSources({
        fetchImpl: async (url, init) => {
          assert.equal(init.redirect, 'error');
          const query = JSON.parse(new URL(url).searchParams.get('query'));
          assert.equal(query.columns[0].search.value, 'Chester');
          return Response.json({
            recordsFiltered: 2,
            data: [site(), site({ county: 'Delaware' })],
          });
        },
      });
      assert.equal(cameras.length, 1);
    },
  );
  await withEnv(
    { CCTV_511PA_COUNTIES: '', CCTV_511PA_MAX_SOURCES: '2' },
    async () => {
      const starts = [];
      const cameras = await loadPennDotSources({
        fetchImpl: async (url) => {
          const query = JSON.parse(new URL(url).searchParams.get('query'));
          starts.push(query.start);
          const data =
            query.start === 0
              ? Array.from({ length: 100 }, (_, i) =>
                  site({
                    county: 'Bedford',
                    latLng: {
                      geography: {
                        coordinateSystemId: 4326,
                        wellKnownText: 'POINT (-78 40)',
                      },
                    },
                    images: [{ id: i + 1 }],
                  }),
                )
              : [site()];
          return Response.json({ recordsFiltered: 101, data });
        },
      });
      assert.deepEqual(starts, [0, 100]);
      assert.equal(cameras.available, 101);
      assert.equal(cameras.length, 2);
      assert.equal(cameras[0].id, '511pa-5852');
    },
  );
});

test('33 configured counties each with one page do not drop the statewide pack', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const counties = Array.from({ length: 33 }, (_, i) => `County${i + 1}`);
  const requested = [];
  await withEnv(
    {
      CCTV_511PA_COUNTIES: counties.join(','),
      CCTV_511PA_MAX_SOURCES: '2000',
    },
    async () => {
      const cameras = await loadPennDotSources({
        fetchImpl: async (url) => {
          const query = JSON.parse(new URL(url).searchParams.get('query'));
          assert.equal(query.start, 0);
          const county = query.columns[0].search.value;
          const index = counties.indexOf(county);
          assert.ok(index >= 0);
          requested.push(county);
          return Response.json({
            recordsFiltered: 1,
            data: [site({ county, images: [{ id: 6000 + index }] })],
          });
        },
      });
      assert.equal(cameras.length, counties.length);
      assert.equal(new Set(cameras.map((camera) => camera.id)).size, 33);
    },
  );
  assert.deepEqual(requested, counties);
});

test('catalog failures, redirects, excessive bodies and stalled pagination return no partial pack', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await withEnv({ CCTV_511PA_COUNTIES: 'Chester' }, async () => {
    for (const makeResponse of [
      () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.example' },
        }),
      () => new Response('x'.repeat(1024 * 1024 + 1)),
      () => Response.json({ recordsFiltered: 1, data: [] }),
      () => Response.json({ recordsFiltered: 10001, data: [site()] }),
      () => {
        throw new Error('offline');
      },
    ])
      assert.deepEqual(
        await loadPennDotSources({ fetchImpl: async () => makeResponse() }),
        [],
      );
  });
});

test('511PA pack is opt-in and disabling it prevents catalog requests', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('https://511pa.com/List/GetData/Cameras?')) {
      calls++;
      return Response.json({ recordsFiltered: 1, data: [site()] });
    }
    throw new Error('offline fixture');
  });
  await withEnv(
    {
      CCTV_511PA_ENABLED: '1',
      CCTV_511PA_COUNTIES: 'Chester',
      CCTV_FORCE_AUSTIN: '1',
      CCTV_SOURCES_JSON: '',
      CCTV_SOURCES_FILE: '/nonexistent/cctv.json',
    },
    async () => {
      const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
      assert.equal(sources.find((s) => s.id === '511pa-5852').pack, '511pa');
      assert.equal(calls, 1);
      process.env.CCTV_511PA_ENABLED = '0';
      await createCctvCatalog({ sourceRoot: '/nonexistent' })();
      assert.equal(calls, 1);
      delete process.env.CCTV_511PA_ENABLED;
      await createCctvCatalog({ sourceRoot: '/nonexistent' })();
      assert.equal(calls, 1, 'unset flag must not contact 511PA');
    },
  );
});

test('public video token exchange is pinned, cached and renewed on demand', async () => {
  let clock = 1;
  let exchanges = 0;
  const resolve = createPennDotStreamResolver({
    now: () => clock,
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, 'error');
      if (url.startsWith('https://511pa.com/Camera/GetVideoUrl?')) {
        assert.equal(new URL(url).searchParams.get('imageId'), '5852');
        assert.equal(new URL(url).searchParams.get('_'), String(clock));
        return Response.json({
          token: '00000000-0000-4000-8000-000000000000',
          sourceId: '1587',
          systemSourceId: 'PennDOT',
        });
      }
      assert.equal(
        url,
        'https://pa.arcadis-ivds.com/api/SecureTokenUri/GetSecureTokenUriBySourceId',
      );
      assert.equal(init.method, 'POST');
      assert.equal(JSON.parse(init.body).sourceId, '1587');
      exchanges++;
      return Response.json(`?token=${String(exchanges).repeat(64)}`);
    },
  });
  const [first, concurrent] = await Promise.all([
    resolve(base, undefined, '511pa-5852'),
    resolve(base, undefined, '511pa-5852'),
  ]);
  assert.equal(first, concurrent);
  assert.equal(exchanges, 1);
  assert.equal(await resolve(base, undefined, '511pa-5852'), first);
  clock += 30000;
  assert.notEqual(await resolve(base, undefined, '511pa-5852'), first);
  assert.equal(exchanges, 2);
  assert.equal(await resolve(base, undefined, 'other-camera'), base);
  assert.equal(
    await resolve('https://evil.example/index.m3u8', undefined, '511pa-5852'),
    'https://evil.example/index.m3u8',
  );
});

test('token responses cannot redirect playback to an arbitrary host or supply an unbounded body', async () => {
  for (const suffix of [
    'https://evil.example/x',
    '?token=x',
    '?token=' + 'a'.repeat(64) + '&redirect=evil',
  ]) {
    const resolve = createPennDotStreamResolver({
      fetchImpl: async (url) =>
        url.startsWith('https://511pa.com/')
          ? Response.json({
              token: '00000000-0000-4000-8000-000000000000',
              sourceId: '1587',
              systemSourceId: 'PennDOT',
            })
          : Response.json(suffix),
    });
    await assert.rejects(resolve(base, undefined, '511pa-5852'));
  }
  const resolve = createPennDotStreamResolver({
    fetchImpl: async () => new Response('x'.repeat(16 * 1024 + 1)),
  });
  await assert.rejects(resolve(base, undefined, '511pa-5852'));
});

test('public token rate limits honor Retry-After across cameras without repeated upstream requests', async () => {
  let clock = 1000;
  let calls = 0;
  const resolve = createPennDotStreamResolver({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });
    },
  });
  await assert.rejects(resolve(base, undefined, '511pa-5852'));
  await assert.rejects(resolve(base, undefined, '511pa-5853'), /rate limited/);
  clock += 119000;
  await assert.rejects(resolve(base, undefined, '511pa-5852'), /rate limited/);
  assert.equal(calls, 1);
  clock += 1000;
  await assert.rejects(resolve(base, undefined, '511pa-5852'));
  assert.equal(calls, 2);
});
