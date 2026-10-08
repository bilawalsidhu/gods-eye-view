import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadVegvesenSourcesFromOpenData,
  vegvesenCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_VEGVESEN_CCTV_URL,
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
  assert.deepEqual(requested, [DEFAULT_VEGVESEN_CCTV_URL]);
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
