import test from 'node:test';
import assert from 'node:assert/strict';

import { createCogReader } from './cog.js';

const RECORD = { key: 'v1/annual/2024/10N/a.tiff' };
const WINDOW = { x0: 0, y0: 0, x1: 1, y1: 1 };

function fakeTiff() {
  return {
    getImageCount: async () => 1,
    getImage: async () => ({
      getSamplesPerPixel: () => 64,
      readRasters: async () => new Int8Array(64),
    }),
  };
}

test('a dropped connection is retried once; other failures are final', async () => {
  const opens = [];
  const failures = [new TypeError('fetch failed')];
  const reader = createCogReader({
    retryDelayMs: 0,
    open: async (url) => {
      opens.push(url);
      if (failures.length) throw failures.shift();
      return fakeTiff();
    },
  });
  assert.equal((await reader.read(RECORD, 0, WINDOW)).length, 64);
  assert.equal(opens.length, 2);

  const final = createCogReader({
    retryDelayMs: 0,
    open: async () => {
      opens.push('final');
      throw new Error('HTTP 403');
    },
  });
  await assert.rejects(final.read(RECORD, 0, WINDOW), /HTTP 403/);
  assert.equal(opens.filter((url) => url === 'final').length, 1);

  const twice = createCogReader({
    retryDelayMs: 0,
    open: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(twice.read(RECORD, 0, WINDOW), /fetch failed/);
});
