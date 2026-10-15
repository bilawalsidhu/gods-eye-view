import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTflSourcesFromOpenData } from '../../server/providers/cctv/sources.js';
import { TFL_IMAGE_ORIGIN } from '../../server/providers/cctv/constants.js';
test('opt-in London cap can include more than 600 published cameras, while the default remains bounded', async () => {
  const previousFetch = globalThis.fetch,
    previousCap = process.env.CCTV_TFL_MAX_SOURCES;
  const catalogue = Array.from({ length: 750 }, (_, i) => ({
    id: `JamCams_${i}`,
    commonName: `Camera ${i}`,
    lat: 51.5,
    lon: -0.1,
    additionalProperties: [
      { key: 'available', value: 'true' },
      { key: 'imageUrl', value: `${TFL_IMAGE_ORIGIN}${i}.jpg` },
    ],
  }));
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(catalogue));
    process.env.CCTV_TFL_MAX_SOURCES = '1000';
    assert.equal((await loadTflSourcesFromOpenData()).length, 750);
    delete process.env.CCTV_TFL_MAX_SOURCES;
    assert.equal((await loadTflSourcesFromOpenData()).length, 250);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCap === undefined) delete process.env.CCTV_TFL_MAX_SOURCES;
    else process.env.CCTV_TFL_MAX_SOURCES = previousCap;
  }
});
