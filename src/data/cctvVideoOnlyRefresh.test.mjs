import { test } from 'node:test';
import assert from 'node:assert/strict';
import cctvLayer, { _setCctvCoverageStateForTest } from './cctv.js';

test('a video-only camera with no still path reports no still refresh', (t) => {
  t.after(() => _setCctvCoverageStateForTest({ enabled: false }));
  _setCctvCoverageStateForTest({
    records: [
      {
        camera: {
          id: 'de-1',
          name: 'DelDOT 1',
          feedType: 'hls',
          hasSnapshot: false,
          headingDeg: 10,
          frameRefreshMs: Number.NaN,
        },
      },
      {
        camera: {
          id: 'hybrid',
          feedType: 'hls',
          hasSnapshot: true,
          frameRefreshMs: 30_000,
        },
      },
      {
        camera: {
          id: 'atx-1',
          name: 'Lamar',
          feedType: 'image',
          headingDeg: 10,
          frameRefreshMs: 15_000,
        },
      },
    ],
  });
  assert.equal(
    cctvLayer.cameraDetails('de-1').refreshMs,
    null,
    'no still frames, no still refresh',
  );
  assert.equal(cctvLayer.cameraDetails('hybrid').refreshMs, 30_000);
  assert.equal(
    cctvLayer.cameraDetails('atx-1').refreshMs,
    15_000,
    'a still camera keeps its interval',
  );
});
