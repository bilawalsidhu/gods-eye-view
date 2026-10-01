import assert from 'node:assert/strict';
import test from 'node:test';
import { createTemperatureSampler, sampleTileUrl } from './sampler.js';
import { TILE_PIXELS } from './tiles.js';

const COLORMAP = `<ColorMap units="K">
  <ColorMapEntry rgb="64,64,64" transparent="true" label="Fill" />
  <ColorMapEntry rgb="0,179,255" value="[249.80,250.40)" />
  <ColorMapEntry rgb="255,205,0" value="[309.80,310.40)" />
</ColorMap>`;

/** A tile whose every pixel is one colour, as ImageData would arrive. */
function solidTile(r, g, b, a = 255) {
  const data = new Uint8ClampedArray(TILE_PIXELS * TILE_PIXELS * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { data, width: TILE_PIXELS, height: TILE_PIXELS };
}

const colormapFetch = async () => new Response(COLORMAP);

test('the sample tile URL carries the date and the Web Mercator matrix set', () => {
  const url = sampleTileUrl('2026-08-01', { level: 6, tileX: 5, tileY: 3 });
  assert.ok(url.includes('/wmts/epsg3857/best/'));
  // The monthly mean is published on the Level6 matrix set only.
  assert.ok(
    url.includes(
      '/MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day/default/2026-08-01/GoogleMapsCompatible_Level6/6/3/5.png',
    ),
  );
});

test('a clear-sky pixel reads as the range the product quantised it into', async () => {
  const sampler = createTemperatureSampler({
    fetchImpl: colormapFetch,
    loadPixels: async () => solidTile(255, 205, 0),
  });
  const result = await sampler.sample({
    latitude: 25,
    longitude: 2,
    date: '2026-09-06',
  });
  assert.equal(result.outcome, 'measured');
  assert.equal(result.stop.lowK, 309.8);
  assert.equal(result.stop.colorDistance, 0);
  assert.ok(result.resolutionM > 0);
});

test('a transparent pixel is reported as having no value, not as the nearest colour', async () => {
  const sampler = createTemperatureSampler({
    fetchImpl: colormapFetch,
    loadPixels: async () => solidTile(64, 64, 64, 0),
  });
  const result = await sampler.sample({
    latitude: -3,
    longitude: -60,
    date: '2026-09-06',
  });
  assert.equal(result.outcome, 'no-value');
  assert.equal(result.stop, null);
});

test('a missing tile is distinguished from a pixel with no value', async () => {
  const sampler = createTemperatureSampler({
    fetchImpl: colormapFetch,
    loadPixels: async () => null,
  });
  const result = await sampler.sample({
    latitude: 25,
    longitude: 2,
    date: '2026-09-06',
  });
  assert.equal(result.outcome, 'no-tile');
});

test('a point outside Web Mercator is refused before any request is spent', async () => {
  let fetched = 0;
  const sampler = createTemperatureSampler({
    fetchImpl: async () => {
      fetched += 1;
      return new Response(COLORMAP);
    },
    loadPixels: async () => solidTile(0, 179, 255),
  });
  const result = await sampler.sample({
    latitude: 89,
    longitude: 0,
    date: '2026-09-06',
  });
  assert.equal(result.outcome, 'outside-projection');
  assert.equal(fetched, 0);
});

test('the colour map is fetched once across many samples', async () => {
  let fetches = 0;
  const sampler = createTemperatureSampler({
    fetchImpl: async () => {
      fetches += 1;
      return new Response(COLORMAP);
    },
    loadPixels: async () => solidTile(0, 179, 255),
  });
  for (let i = 0; i < 4; i += 1)
    await sampler.sample({ latitude: 10 + i, longitude: 20, date: '2026-09-06' });
  assert.equal(fetches, 1);
});

test('repeated clicks in one area reuse the cached tile', async () => {
  let loads = 0;
  const sampler = createTemperatureSampler({
    fetchImpl: colormapFetch,
    loadPixels: async () => {
      loads += 1;
      return solidTile(0, 179, 255);
    },
  });
  // Two points inside the same level-6 tile.
  await sampler.sample({ latitude: 51.5, longitude: -0.12, date: '2026-09-06' });
  await sampler.sample({ latitude: 51.5, longitude: -0.1, date: '2026-09-06' });
  assert.equal(loads, 1);
  sampler.reset();
  await sampler.sample({ latitude: 51.5, longitude: -0.12, date: '2026-09-06' });
  assert.equal(loads, 2);
});

test('a failed colour map does not poison every later sample', async () => {
  let attempts = 0;
  const sampler = createTemperatureSampler({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response('nope', { status: 503 });
      return new Response(COLORMAP);
    },
    loadPixels: async () => solidTile(0, 179, 255),
  });
  await assert.rejects(
    sampler.sample({ latitude: 10, longitude: 20, date: '2026-09-06' }),
    /Colour map HTTP 503/,
  );
  const second = await sampler.sample({
    latitude: 10,
    longitude: 20,
    date: '2026-09-06',
  });
  assert.equal(second.outcome, 'measured');
  assert.equal(attempts, 2);
});

test('cancellation stops a sample before it is admitted', async () => {
  const controller = new AbortController();
  const sampler = createTemperatureSampler({
    fetchImpl: colormapFetch,
    loadPixels: async () => {
      controller.abort();
      return solidTile(0, 179, 255);
    },
  });
  await assert.rejects(
    sampler.sample({
      latitude: 10,
      longitude: 20,
      date: '2026-09-06',
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});
