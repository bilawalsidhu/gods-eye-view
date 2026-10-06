import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyVegvesenGroundHeights,
  clearKartverketHeightCache,
  fetchKartverketHeights,
  kartverketBackoffMs,
  loadVegvesenSourcesFromOpenData,
  vegvesenCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_VEGVESEN_CCTV_URL,
  KARTVERKET_HEIGHT_URL,
  KARTVERKET_CONCURRENCY,
  KARTVERKET_FAILURE_BACKOFF_MS,
  KARTVERKET_MAX_POINTS,
  KARTVERKET_NULL_TTL_MS,
  KARTVERKET_USER_AGENT,
  VEGVESEN_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/** One `datex_3_1:CctvSimple` feature, shaped like the live OGC payload. */
const feature = (props = {}, coordinates = [5.459189, 61.832706]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: {
    stillImageUrl: 'https://kamera.atlas.vegvesen.no/api/images/3000063_1',
    cameraId: '3000063_1',
    roadNumber: 'F614',
    'status.stillImageAvailability': 'videoOrImagesAvailable',
    orientationDescription: 'Svelgen',
    description: 'Langesi',
    ...props,
  },
});

test('a Vegvesen feature maps to a source on the pinned frame host', () => {
  const source = vegvesenCameraToSource(feature());
  assert.equal(source.id, 'no-vegvesen-3000063_1');
  assert.equal(source.name, 'F614 Langesi → Svelgen');
  assert.equal(source.city, 'Norway');
  assert.equal(source.cityId, 'norway');
  assert.equal(source.provider, 'Statens vegvesen');
  assert.equal(source.lat, 61.832706);
  assert.equal(source.lon, 5.459189);
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.sourceKind, 'vegvesen-datex');
  assert.equal(source.code, 'LANGESI');
  assert.ok(source.url.startsWith(VEGVESEN_IMAGE_ORIGIN));
  assert.equal(source.snapshotUrl, source.url);
});

test('cameras that publish HLS get live video with the still as fallback', (t) => {
  const video = {
    videoServiceLevel: 1,
    videoEncodingStandard: 'hls',
    videoUrl: 'https://kamera.vegvesen.no/public/3000063_1/manifest.m3u8',
  };
  const source = vegvesenCameraToSource(feature(video));
  assert.equal(source.feedType, 'hls');
  assert.equal(source.url, video.videoUrl);
  assert.equal(
    source.snapshotUrl,
    'https://kamera.atlas.vegvesen.no/api/images/3000063_1',
  );
  // A manifest anywhere but the camera's own path stays a still.
  const offPath = vegvesenCameraToSource(
    feature({ ...video, videoUrl: 'https://evil.test/x/manifest.m3u8' }),
  );
  assert.equal(offPath.feedType, 'image');
  assert.equal(offPath.url, offPath.snapshotUrl);
  // The kill switch keeps every camera on stills.
  const saved = process.env.CCTV_VEGVESEN_VIDEO;
  t.after(() => {
    if (saved === undefined) delete process.env.CCTV_VEGVESEN_VIDEO;
    else process.env.CCTV_VEGVESEN_VIDEO = saved;
  });
  process.env.CCTV_VEGVESEN_VIDEO = '0';
  assert.equal(vegvesenCameraToSource(feature(video)).feedType, 'image');
});

test('faulty cameras, off-host frames and bad geometry are dropped', () => {
  assert.equal(
    vegvesenCameraToSource(
      feature({
        'status.stillImageAvailability':
          'videoOrImagesUnavailableDueToCameraFault',
      }),
    ),
    null,
  );
  assert.equal(
    vegvesenCameraToSource(
      feature({ stillImageUrl: 'https://evil.test/api/images/3000063_1' }),
    ),
    null,
  );
  // The frame URL must be exactly the camera's own image path.
  assert.equal(
    vegvesenCameraToSource(
      feature({
        stillImageUrl: 'https://kamera.atlas.vegvesen.no/api/images/999_1',
      }),
    ),
    null,
  );
  assert.equal(vegvesenCameraToSource(feature({ cameraId: '../x' })), null);
  // Copenhagen: a plausible coordinate, but outside the Norway box.
  assert.equal(vegvesenCameraToSource(feature({}, [12.57, 55.68])), null);
  assert.equal(vegvesenCameraToSource(feature({}, [5.4])), null);
  assert.equal(vegvesenCameraToSource(null), null);
});

test('the loader dedupes, and failures degrade to an empty pack', async (t) => {
  clearKartverketHeightCache();
  t.after(clearKartverketHeightCache);
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({
      type: 'FeatureCollection',
      features: [
        feature(),
        feature(),
        feature(
          {
            cameraId: '0629001_1',
            stillImageUrl:
              'https://kamera.atlas.vegvesen.no/api/images/0629001_1',
            description: 'Oslo S',
          },
          [10.752, 59.911],
        ),
      ],
    });
  });
  const cameras = await loadVegvesenSourcesFromOpenData();
  // The catalog first; the rest is the Kartverket height lookup.
  assert.equal(requested[0], DEFAULT_VEGVESEN_CCTV_URL);
  assert.ok(
    requested.slice(1).every((url) => url.startsWith(KARTVERKET_HEIGHT_URL)),
  );
  // Nearest-to-anchor first: Oslo leads.
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['no-vegvesen-0629001_1', 'no-vegvesen-3000063_1'],
  );

  fetchMock.mock.mockImplementation(
    async () => new Response('nope', { status: 503 }),
  );
  assert.deepEqual(await loadVegvesenSourcesFromOpenData(), []);
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadVegvesenSourcesFromOpenData(), []);
});

const runCatalog = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === DEFAULT_VEGVESEN_CCTV_URL) {
      return Response.json({
        type: 'FeatureCollection',
        features: [feature()],
      });
    }
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_VEGVESEN_ENABLED;
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
};

test('the Vegvesen lane is wired into the catalog', async (t) => {
  await withEnv({}, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.ok(requested.includes(DEFAULT_VEGVESEN_CCTV_URL));
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'norway').map((s) => s.id),
      ['no-vegvesen-3000063_1'],
    );
  });
});

test('CCTV_VEGVESEN_ENABLED=0 keeps the lane from being loaded', async (t) => {
  await withEnv({ CCTV_VEGVESEN_ENABLED: '0' }, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.equal(requested.includes(DEFAULT_VEGVESEN_CCTV_URL), false);
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'norway'),
      [],
    );
  });
});

/** Answer a Kartverket request the way the live API does: echo every point,
 * with the height `heightFor(x, y)` returns (null = outside coverage). */
const kartverketResponse = (url, heightFor) => {
  const points = JSON.parse(new URL(url).searchParams.get('punkter'));
  return Response.json({
    koordsys: 4258,
    punkter: points.map(([x, y]) => ({ x, y, z: heightFor(x, y) })),
  });
};

/** Cameras at distinct Norwegian positions. */
const cameraAt = (i) => ({
  id: `no-vegvesen-${i}`,
  lat: 60 + i * 0.001,
  lon: 7 + i * 0.001,
  groundElevationM: 150,
});

const withHeightsEnv = (t) => {
  const saved = process.env.CCTV_VEGVESEN_HEIGHTS;
  delete process.env.CCTV_VEGVESEN_HEIGHTS;
  clearKartverketHeightCache();
  t.after(() => {
    clearKartverketHeightCache();
    if (saved === undefined) delete process.env.CCTV_VEGVESEN_HEIGHTS;
    else process.env.CCTV_VEGVESEN_HEIGHTS = saved;
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

const sentPoints = (url) =>
  JSON.parse(new URL(url).searchParams.get('punkter'));

test('Kartverket heights come in batches of 20, matched by echoed coordinates', async (t) => {
  withHeightsEnv(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requested.push(String(url));
    assert.ok(String(url).startsWith(KARTVERKET_HEIGHT_URL));
    assert.equal(init.headers['User-Agent'], KARTVERKET_USER_AGENT);
    // Reply in reverse order: matching must not depend on list position.
    const response = kartverketResponse(url, (x) =>
      x > 7.04 ? null : Math.round((x - 7) * 10000),
    );
    const body = await response.json();
    body.punkter.reverse();
    return Response.json(body);
  });
  const { heights, failure } = await fetchKartverketHeights(
    Array.from({ length: 50 }, (_, i) => cameraAt(i)),
  );
  assert.equal(failure, null);
  // One pass, no retries: 20 + 20 + 10.
  assert.deepEqual(
    requested.map((url) => sentPoints(url).length),
    [KARTVERKET_MAX_POINTS, 20, 10],
  );
  for (const url of requested) {
    assert.equal(new URL(url).searchParams.get('koordsys'), '4258');
  }
  assert.equal(heights.size, 50);
  assert.equal(heights.get('7.010000,60.010000'), 100);
  // Past x = 7.04 the API has no height: recorded as null, never as 0.
  assert.equal(heights.get('7.049000,60.049000'), null);
});

test('only the points a request asked about are recorded', async (t) => {
  withHeightsEnv(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    const points = sentPoints(url);
    return Response.json({
      koordsys: 4258,
      punkter: [
        ...points.map(([x, y]) => ({ x, y, z: 10 })),
        { x: 7.5, y: 60.5, z: 999 }, // never asked
      ],
    });
  });
  const { heights } = await fetchKartverketHeights([cameraAt(0)]);
  assert.deepEqual([...heights.entries()], [['7.000000,60.000000', 10]]);
});

test('either water marker counts as the surface', async (t) => {
  withHeightsEnv(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    const [a, b, c] = sentPoints(url);
    return Response.json({
      koordsys: 4258,
      punkter: [
        {
          x: a[0],
          y: a[1],
          z: -547.1,
          datakilde: 'dybdekurver',
          terreng: null,
        },
        { x: b[0], y: b[1], z: -9.2, datakilde: 'dtm1', terreng: 'Havflate' },
        {
          x: c[0],
          y: c[1],
          z: -0.2,
          datakilde: 'dtm1',
          terreng: 'ÅpentOmråde',
        },
      ],
    });
  });
  const { heights } = await fetchKartverketHeights([
    cameraAt(0),
    cameraAt(1),
    cameraAt(2),
  ]);
  assert.equal(heights.get('7.000000,60.000000'), 0);
  assert.equal(heights.get('7.001000,60.001000'), 0);
  // A quay just below the datum on land data stays as measured.
  assert.equal(heights.get('7.002000,60.002000'), -0.2);
});

test('heights outside -20..2500 m and points outside Norway are not used', async (t) => {
  withHeightsEnv(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    const zs = [-20, -20.5, 2500, 2500.5];
    const points = sentPoints(url);
    return Response.json({
      koordsys: 4258,
      punkter: points.map(([x, y], i) => ({ x, y, z: zs[i] })),
    });
  });
  const { heights } = await fetchKartverketHeights([
    cameraAt(0),
    cameraAt(1),
    cameraAt(2),
    cameraAt(3),
    { lat: 55.68, lon: 12.57 }, // Copenhagen: never sent
  ]);
  assert.equal(requested.length, 1);
  assert.equal(sentPoints(requested[0]).length, 4);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) =>
      heights.get(
        `${(7 + i * 0.001).toFixed(6)},${(60 + i * 0.001).toFixed(6)}`,
      ),
    ),
    [-20, null, 2500, null],
  );
});

test('no more than eight requests are in flight', async (t) => {
  withHeightsEnv(t);
  let inFlight = 0;
  let peak = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return kartverketResponse(url, () => 1);
  });
  const { heights } = await fetchKartverketHeights(
    Array.from({ length: 400 }, (_, i) => cameraAt(i)),
  );
  assert.equal(heights.size, 400);
  assert.equal(peak, KARTVERKET_CONCURRENCY);
});

test('a transport failure stops the lookup: no retries, no new requests', async (t) => {
  withHeightsEnv(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('busy', {
      status: 429,
      headers: { 'Retry-After': '120' },
    });
  });
  const { heights, failure } = await fetchKartverketHeights(
    Array.from({ length: 400 }, (_, i) => cameraAt(i)),
  );
  // The first wave is already in flight when the first failure lands; nothing
  // after it starts, and no point is resent.
  assert.equal(calls, KARTVERKET_CONCURRENCY);
  assert.equal(heights.size, 0);
  assert.deepEqual(failure, { status: 429, retryAfter: '120' });
});

test('the lookup deadline bounds a hanging service', async (t) => {
  withHeightsEnv(t);
  t.mock.method(
    globalThis,
    'fetch',
    (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
  );
  const started = Date.now();
  const { heights, failure } = await fetchKartverketHeights([cameraAt(0)], {
    timeoutMs: 30,
  });
  assert.ok(Date.now() - started < 2000);
  assert.equal(heights.size, 0);
  assert.equal(failure.status, null);
});

test('Retry-After sets the backoff, bounded to [1 min, 1 h]', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  assert.equal(kartverketBackoffMs('120', now), 120_000);
  assert.equal(kartverketBackoffMs('5', now), 60_000);
  assert.equal(kartverketBackoffMs('86400', now), 3_600_000);
  assert.equal(
    kartverketBackoffMs('Mon, 06 Oct 2026 12:05:00 GMT', now),
    300_000,
  );
  assert.equal(kartverketBackoffMs(null, now), KARTVERKET_FAILURE_BACKOFF_MS);
  assert.equal(kartverketBackoffMs('soon', now), KARTVERKET_FAILURE_BACKOFF_MS);
});

test('heights are cached, and misses are not asked again until they expire', async (t) => {
  withHeightsEnv(t);
  let clock = 1_000_000;
  const now = () => clock;
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(sentPoints(url).length);
    return kartverketResponse(url, (x) => (x < 7.002 ? 1043.26 : null));
  });
  const cameras = [cameraAt(0), cameraAt(1), cameraAt(5)];
  assert.equal(await applyVegvesenGroundHeights(cameras, { now }), 2);
  assert.deepEqual(
    cameras.map((c) => c.groundElevationM),
    [1043.3, 1043.3, 150],
  );
  // The next refresh asks nothing: heights and the miss are both cached.
  assert.equal(
    await applyVegvesenGroundHeights([cameraAt(0), cameraAt(1), cameraAt(5)], {
      now,
    }),
    2,
  );
  assert.deepEqual(asked, [3]);
  // Once the miss expires, only that point is asked again.
  clock += KARTVERKET_NULL_TTL_MS + 1;
  await applyVegvesenGroundHeights([cameraAt(0), cameraAt(5)], { now });
  assert.deepEqual(asked, [3, 1]);
});

test('after a failure no lookup starts until the backoff ends', async (t) => {
  withHeightsEnv(t);
  let clock = 1_000_000;
  const now = () => clock;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  const cameras = [cameraAt(0)];
  assert.equal(await applyVegvesenGroundHeights(cameras, { now }), 0);
  assert.equal(cameras[0].groundElevationM, 150);
  assert.equal(fetchMock.mock.callCount(), 1);

  // Refreshes inside the backoff cost nothing.
  clock += KARTVERKET_FAILURE_BACKOFF_MS - 1;
  assert.equal(await applyVegvesenGroundHeights([cameraAt(0)], { now }), 0);
  assert.equal(fetchMock.mock.callCount(), 1);

  // After it, the failed point is asked again.
  clock += 2;
  fetchMock.mock.mockImplementation(async (url) =>
    kartverketResponse(url, () => 321),
  );
  const later = [cameraAt(0)];
  assert.equal(await applyVegvesenGroundHeights(later, { now }), 1);
  assert.equal(later[0].groundElevationM, 321);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('CCTV_VEGVESEN_HEIGHTS=0 skips the lookup', async (t) => {
  withHeightsEnv(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) =>
    kartverketResponse(url, () => 5),
  );
  process.env.CCTV_VEGVESEN_HEIGHTS = '0';
  const cameras = [cameraAt(0)];
  assert.equal(await applyVegvesenGroundHeights(cameras), 0);
  assert.equal(cameras[0].groundElevationM, 150);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('a slow lookup does not hold the catalog; the next refresh applies it', async (t) => {
  withHeightsEnv(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    await gate;
    return kartverketResponse(url, () => 812);
  });
  const first = [cameraAt(0)];
  assert.equal(await applyVegvesenGroundHeights(first, { waitMs: 20 }), 0);
  assert.equal(first[0].groundElevationM, 150);
  release();
  // The lookup kept running and filled the cache for the next refresh.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = [cameraAt(0)];
  assert.equal(await applyVegvesenGroundHeights(next, { waitMs: 20 }), 1);
  assert.equal(next[0].groundElevationM, 812);
});

test('the loader applies Kartverket heights to the cameras it returns', async (t) => {
  withHeightsEnv(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith(KARTVERKET_HEIGHT_URL)) {
      return kartverketResponse(url, () => 987.6);
    }
    return Response.json({ type: 'FeatureCollection', features: [feature()] });
  });
  const cameras = await loadVegvesenSourcesFromOpenData();
  assert.deepEqual(
    cameras.map((c) => [c.id, c.groundElevationM]),
    [['no-vegvesen-3000063_1', 987.6]],
  );
});
