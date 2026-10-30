import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeRecentImagerySnapshot,
  diffRecentImageryFrames,
  summarizeSiteBox,
} from './analysis.js';

test('diffRecentImageryFrames reports changed pixels and the strongest region', () => {
  const before = new Uint8ClampedArray(4 * 4 * 4);
  const after = new Uint8ClampedArray(before);
  for (const pixel of [0, 1, 4, 5]) {
    after[pixel * 4] = 100;
  }

  const result = diffRecentImageryFrames(before, after, {
    width: 4,
    height: 4,
    threshold: 40,
    blockSize: 2,
  });

  assert.equal(result.changedPixels, 4);
  assert.equal(result.changedPct, 25);
  assert.equal(result.hotspot, 'north-west');
});

test('summarizeSiteBox measures the Recent Imagery box without another map layer', () => {
  const site = summarizeSiteBox({ west: -97.75, south: 30.25, east: -97.74, north: 30.26 });

  assert.equal(site.ok, true);
  assert.ok(site.areaM2 > 900_000 && site.areaM2 < 1_200_000);
  assert.ok(site.hectares > 90 && site.hectares < 120);
});

test('analyzeRecentImagerySnapshot compares the current A and B images', async () => {
  const snapshot = {
    mode: 'ab',
    box: { west: -98, south: 30, east: -97, north: 31 },
    pins: {
      a: { key: 'a', product: 'S30', day: '2026-10-01' },
      b: { key: 'b', product: 'S30', day: '2026-10-17' },
    },
  };
  const frames = {
    a: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) },
    b: { width: 1, height: 1, data: new Uint8ClampedArray([90, 0, 0, 255]) },
  };

  const result = await analyzeRecentImagerySnapshot(snapshot, {
    loadFrame: async (_url, candidate) => frames[candidate.key],
  });

  assert.equal(result.ok, true);
  assert.equal(result.changedPct, 100);
  assert.equal(result.before.day, '2026-10-01');
  assert.equal(result.after.day, '2026-10-17');
  assert.equal(result.site.ok, true);
});

test('analyzeRecentImagerySnapshot rejects HTTP 200 images marked Data-Present false', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalBitmap = globalThis.createImageBitmap;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: (name) => (name === 'Data-Present' ? 'false' : null) },
    blob: async () => ({}),
  });
  globalThis.createImageBitmap = async () => {
    assert.fail('no-data responses must not be decoded');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.createImageBitmap = originalBitmap;
  });

  const result = await analyzeRecentImagerySnapshot({
    mode: 'ab',
    box: { west: -98, south: 30, east: -97, north: 31 },
    pins: {
      a: { product: 'S30', day: '2026-10-01' },
      b: { product: 'S30', day: '2026-10-17' },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /unavailable/i);
});

test('analyzeRecentImagerySnapshot forwards cancellation to both image requests', async () => {
  const controller = new AbortController();
  const seen = [];
  const analysis = analyzeRecentImagerySnapshot(
    {
      mode: 'ab',
      box: { west: -98, south: 30, east: -97, north: 31 },
      pins: {
        a: { product: 'S30', day: '2026-10-01' },
        b: { product: 'S30', day: '2026-10-17' },
      },
    },
    {
      signal: controller.signal,
      loadFrame: (_url, candidate, { signal }) => {
        seen.push([candidate.day, signal]);
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
    },
  );
  controller.abort();

  await assert.rejects(analysis, { name: 'AbortError' });
  assert.deepEqual(
    seen.map(([day, signal]) => [day, signal.aborted]),
    [
      ['2026-10-01', true],
      ['2026-10-17', true],
    ],
  );
});
