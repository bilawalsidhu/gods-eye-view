// Reproduction: a viewer refused for HLS capacity is shown its fallback frame
// under a badge that still reads the shared live health ("LIVE · OK").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HLS_LIMITS } from '../../server/providers/cctv/stream.js';
import { mountCctvProvider } from '../testSupport/cctvProviderHarness.mjs';
import { presentCctvSourceBadge } from '../ui/cctvFrames.js';
import { presentCctvPanel } from '../ui/cctvPresentation.js';

const SAME_ORIGIN = { host: 'localhost:4173', 'sec-fetch-site': 'same-origin' };
const PLAYLIST =
  '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXTINF:2,\nc.ts\n';
const lease = (index) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const camera = (id) => ({
  id,
  name: id,
  lat: 30.27,
  lon: -97.74,
  feedType: 'hls',
  url: `https://cams.upstream.invalid/${id}/list.m3u8`,
});

test('a capacity-refused viewer is not shown its fallback frame as live and ok', async (t) => {
  assert.equal(HLS_LIMITS.sessions, 2);
  const { call, health } = mountCctvProvider(t, {
    cameras: ['cam-a', 'cam-b', 'cam-c'].map(camera),
    fetch: async (url) =>
      new Response(String(url).endsWith('.m3u8') ? PLAYLIST : 'abc'),
  });
  const open = (id, index) =>
    call(`/media/${id}?lease=${lease(index)}`, SAME_ORIGIN);
  // cam-c played earlier and was released: its row is live/ok.
  assert.equal((await open('cam-c', 0)).statusCode, 200);
  assert.equal(
    (await call(`/media/cam-c?lease=${lease(0)}`, SAME_ORIGIN, 'DELETE'))
      .statusCode,
    204,
  );
  // Two other viewers now hold both camera sessions.
  assert.equal((await open('cam-a', 1)).statusCode, 200);
  assert.equal((await open('cam-b', 2)).statusCode, 200);
  // The cam-c viewer is refused and falls back to the frame.
  const refused = await open('cam-c', 3);
  assert.equal(refused.statusCode, 503);
  const frame = await call('/frame/cam-c', SAME_ORIGIN);
  assert.equal(frame.statusCode, 200);
  assert.equal(frame.headers['X-CCTV-Source'], 'synthetic');
  assert.match(frame.body, /UPSTREAM UNAVAILABLE/);
  const row = await health('cam-c');
  // The badge the panel derives for this viewer, in image (fallback) mode.
  const shown = {
    feedType: 'hls',
    isVideo: false,
    sourceKind: row?.sourceKind || 'configured',
    sourceStatus: row?.status || 'unknown',
    sourceMessage: row?.message || '',
  };
  const badge = presentCctvSourceBadge(shown, true, {
    loading: false,
    error: false,
    hasFrame: true,
  });
  assert.notEqual(
    badge.label,
    'LIVE · OK',
    `fallback frame (${frame.headers['X-CCTV-Source']}) labelled ${badge.label}; health message "${row?.message}"`,
  );
  const { meta } = presentCctvPanel(
    {
      enabled: true,
      activeCameraId: 'cam-c',
      activeCamera: {
        ...shown,
        id: 'cam-c',
        city: 'Austin',
        headingDeg: 0,
        fovDeg: 60,
        rangeM: 100,
      },
    },
    true,
  );
  assert.doesNotMatch(meta, /Live HLS connected/);
});
