import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyVegvesenGroundHeights,
  clearKartverketHeightCache,
  fetchKartverketHeights,
  loadVegvesenSourcesFromOpenData,
  vegvesenCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_VEGVESEN_CCTV_URL,
  KARTVERKET_HEIGHT_URL,
  KARTVERKET_MAX_POINTS,
  KARTVERKET_RETRY_POINTS,
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

test('Kartverket heights come in batches of 50, matched by echoed coordinates', async (t) => {
  withHeightsEnv(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    assert.ok(String(url).startsWith(KARTVERKET_HEIGHT_URL));
    // Reply in reverse order: matching must not depend on list position.
    const response = kartverketResponse(url, (x) =>
      x > 7.05 ? null : Math.round((x - 7) * 10000),
    );
    const body = await response.json();
    body.punkter.reverse();
    return Response.json(body);
  });
  const points = Array.from({ length: 120 }, (_, i) => cameraAt(i));
  const heights = await fetchKartverketHeights(points);
  const sizes = requested.map(
    (url) => JSON.parse(new URL(url).searchParams.get('punkter')).length,
  );
  // Three full batches, then one retry pass over the 69 points with no height.
  assert.deepEqual(sizes.slice(0, 3), [KARTVERKET_MAX_POINTS, 50, 20]);
  assert.equal(
    sizes.slice(3).reduce((a, b) => a + b, 0),
    69,
  );
  assert.ok(sizes.slice(3).every((n) => n <= KARTVERKET_RETRY_POINTS));
  for (const url of requested) {
    assert.equal(new URL(url).searchParams.get('koordsys'), '4258');
  }
  // Points past x = 7.05 have no height (outside coverage) and are left out.
  assert.equal(heights.size, 51);
  assert.equal(heights.get('7.010000,60.010000'), 100);
});

test('points a full batch answers null for are retried once in small batches', async (t) => {
  withHeightsEnv(t);
  const sizes = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const points = JSON.parse(new URL(url).searchParams.get('punkter'));
    sizes.push(points.length);
    // A full batch drops the first two points; a small batch answers them,
    // except the one point that has no data at all.
    const full = points.length > KARTVERKET_RETRY_POINTS;
    return kartverketResponse(url, (x) => {
      if (Math.abs(x - 7.002) < 1e-9) return null;
      if (full && x < 7.002) return null;
      return 500;
    });
  });
  const heights = await fetchKartverketHeights(
    Array.from({ length: 60 }, (_, i) => cameraAt(i)),
  );
  assert.deepEqual(sizes, [50, 10, 3]);
  assert.equal(heights.size, 59);
  assert.equal(heights.get('7.000000,60.000000'), 500);
  assert.equal(heights.has('7.002000,60.002000'), false);
});

test('a sea-floor depth counts as the water surface', async (t) => {
  withHeightsEnv(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    const points = JSON.parse(new URL(url).searchParams.get('punkter'));
    return Response.json({
      koordsys: 4258,
      punkter: points.map(([x, y], i) =>
        i === 0
          ? { x, y, z: -547.1, datakilde: 'dybdekurver', terreng: 'Havflate' }
          : { x, y, z: -0.2, datakilde: 'dtm1', terreng: 'ÅpentOmråde' },
      ),
    });
  });
  const heights = await fetchKartverketHeights([cameraAt(0), cameraAt(1)]);
  // Under a bridge: the surface, not the sea floor. A quay just below the
  // datum on land data stays as measured.
  assert.equal(heights.get('7.000000,60.000000'), 0);
  assert.equal(heights.get('7.001000,60.001000'), -0.2);
});

test('implausible heights and points outside Norway are ignored', async (t) => {
  withHeightsEnv(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return kartverketResponse(url, () => 99999);
  });
  const heights = await fetchKartverketHeights([
    cameraAt(1),
    { lat: 55.68, lon: 12.57 }, // Copenhagen: never sent
  ]);
  assert.equal(heights.size, 0);
  // The first pass and its one retry, each carrying only the Norway point.
  assert.equal(requested.length, 2);
  for (const url of requested) {
    assert.equal(
      JSON.parse(new URL(url).searchParams.get('punkter')).length,
      1,
    );
  }
});

test('cameras get their terrain height, and a refresh reuses the cache', async (t) => {
  withHeightsEnv(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls += 1;
    return kartverketResponse(url, (x) => (x < 7.002 ? 1043.26 : null));
  });
  const cameras = [cameraAt(0), cameraAt(1), cameraAt(5)];
  assert.equal(await applyVegvesenGroundHeights(cameras), 2);
  assert.deepEqual(
    cameras.map((c) => c.groundElevationM),
    [1043.3, 1043.3, 150],
  );
  // One full pass plus one retry for the point with no height.
  assert.equal(calls, 2);
  // Same positions on the next catalog refresh: answered from the cache.
  const again = [cameraAt(0), cameraAt(1)];
  assert.equal(await applyVegvesenGroundHeights(again), 2);
  assert.equal(calls, 2);
});

test('a failed or disabled lookup keeps the flat prior', async (t) => {
  withHeightsEnv(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('offline');
  });
  const cameras = [cameraAt(0)];
  assert.equal(await applyVegvesenGroundHeights(cameras), 0);
  assert.equal(cameras[0].groundElevationM, 150);

  fetchMock.mock.mockImplementation(
    async () => new Response('nope', { status: 503 }),
  );
  assert.equal(await applyVegvesenGroundHeights(cameras), 0);
  assert.equal(cameras[0].groundElevationM, 150);

  process.env.CCTV_VEGVESEN_HEIGHTS = '0';
  fetchMock.mock.resetCalls();
  assert.equal(await applyVegvesenGroundHeights(cameras), 0);
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
