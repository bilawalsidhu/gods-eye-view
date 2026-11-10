/**
 * Caltrans live video (CCTV_CALTRANS_VIDEO=1). The HLS relay fetches a
 * camera's registered playlist server-side, so only playlists on Caltrans's
 * own streaming host may become a camera URL, and the opt-in flag means `1`
 * and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  caltransStreamUrl,
  loadCaltransSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';

const STILL = 'https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv101/tv101.jpg';
const STREAM =
  'https://wzmedia.dot.ca.gov/D4/W580_JWO_24_IC.stream/playlist.m3u8';

/** Set env vars for one test and restore them afterwards. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** One in-service District 4 camera with the given imageData. */
function serveCamera(t, imageData) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [
        {
          cctv: {
            inService: 'true',
            location: {
              latitude: '37.8044',
              longitude: '-122.2712',
              elevation: '40',
              locationName: 'TV101 -- I-880 : Test Ave',
            },
            imageData,
          },
        },
      ],
    }),
  );
}

async function loadOne(t, flag, imageData) {
  withEnv(t, { CCTV_CALTRANS_DISTRICTS: '4', CCTV_CALTRANS_VIDEO: flag });
  serveCamera(t, imageData);
  const cameras = await loadCaltransSourcesFromOpenData();
  assert.equal(cameras.length, 1);
  return cameras[0];
}

test('Caltrans stays on stills unless CCTV_CALTRANS_VIDEO is exactly 1', async (t) => {
  for (const flag of [undefined, '', '0', 'false', 'off', 'no', 'true']) {
    await t.test(`flag ${JSON.stringify(flag)}`, async (t) => {
      const camera = await loadOne(t, flag, {
        streamingVideoURL: STREAM,
        static: { currentImageURL: STILL },
      });
      assert.equal(camera.feedType, 'image');
      assert.equal(camera.url, STILL);
      assert.equal(camera.snapshotUrl, STILL);
    });
  }
});

test('CCTV_CALTRANS_VIDEO=1 registers the pinned playlist with the still as fallback', async (t) => {
  const camera = await loadOne(t, '1', {
    // The live feed writes the default port on some rows; it normalizes away.
    streamingVideoURL: STREAM.replace('.gov/', '.gov:443/'),
    static: { currentImageURL: STILL },
  });
  assert.equal(camera.feedType, 'hls');
  assert.equal(camera.url, STREAM);
  assert.equal(camera.snapshotUrl, STILL);
});

test('a stream off the Caltrans streaming host keeps the camera on stills', async (t) => {
  const refused = [
    'http://wzmedia.dot.ca.gov/D4/W580.stream/playlist.m3u8',
    'https://wzmedia.dot.ca.gov.example.com/D4/W580.stream/playlist.m3u8',
    'https://user:pw@wzmedia.dot.ca.gov/D4/W580.stream/playlist.m3u8',
    'https://wzmedia.dot.ca.gov:8443/D4/W580.stream/playlist.m3u8',
    'https://wzmedia.dot.ca.gov/D4/W580.stream/playlist.m3u8?u=http://x/',
    'https://wzmedia.dot.ca.gov/D4/../../admin/playlist.m3u8',
    'https://wzmedia.dot.ca.gov/D4/W580.stream/other.m3u8',
    'http://169.254.169.254/latest/meta-data/x.m3u8',
    'http://127.0.0.1:5173/api/x.m3u8',
    '',
    'not a url',
  ];
  for (const raw of refused) {
    await t.test(raw || '(empty)', async (t) => {
      assert.equal(caltransStreamUrl(raw), '');
      const camera = await loadOne(t, '1', {
        streamingVideoURL: raw,
        static: { currentImageURL: STILL },
      });
      assert.equal(camera.feedType, 'image');
      assert.equal(camera.url, STILL);
    });
  }
});

test('a static key that merely mentions video is not treated as a stream', async (t) => {
  const camera = await loadOne(t, '1', {
    streamingVideoURL: '',
    static: {
      currentImageURL: STILL,
      currentVideoURL: 'http://169.254.169.254/latest/meta-data/x.m3u8',
    },
  });
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.url, STILL);
});

test('the snapshot fallback is always the pinned still, never an unpinned field', async (t) => {
  const camera = await loadOne(t, '1', {
    streamingVideoURL: STREAM,
    imageURL: 'http://169.254.169.254/latest/meta-data/x.jpg',
    static: { currentImageURL: STILL },
  });
  assert.equal(camera.feedType, 'hls');
  assert.equal(camera.snapshotUrl, STILL);
});
