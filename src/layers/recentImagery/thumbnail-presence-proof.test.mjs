import test from 'node:test';
import assert from 'node:assert/strict';
import { createThumbnailLoader } from './thumbnails.js';
test('missing or malformed presence evidence cannot prove thumbnail pixels', async () => {
  for (const header of [null, 'unknown', '', 'true', 'false']) {
    let decodes = 0;
    const loader = createThumbnailLoader({
      requestThumbnail: async () => ({
        ok: true,
        headers: { get: (key) => (key === 'Data-Present' ? header : null) },
        blob: async () => {
          decodes++;
          return new Blob(['fixture']);
        },
      }),
      createObjectUrl: () => 'blob:fixture',
    });
    loader.request(
      { key: 'fixture', product: 'S30', day: '2026-09-18' },
      { west: 0, east: 1, south: 0, north: 1 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      loader.get('fixture').status,
      header === 'true' ? 'present' : header === 'false' ? 'empty' : 'error',
    );
    assert.equal(decodes, header === 'true' ? 1 : 0);
    loader.destroy();
  }
});
