import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeatherSource,
  validateWeatherSnapshot,
  weatherImageUrl,
  weatherTileUrl,
  WEATHER_IMAGE_SIZES,
} from './source.js';
const time = '2026-09-16T02:00:00.000Z';
const snapshot = () => ({
  schemaVersion: 1,
  product: 'radar',
  bounds: { west: -130, south: 20, east: -60, north: 55 },
  times: [time],
  latest: time,
  tileSize: 256,
  maxLevel: 6,
  tilingScheme: 'geographic',
});
test('observed source accepts bounded exact times and refuses malformed or unsorted frames', () => {
  assert.equal(validateWeatherSnapshot(snapshot(), 'radar').latest, time);
  for (const bad of [
    { times: [time, time] },
    { product: 'other' },
    { times: Array(14).fill(time) },
    { latest: 'tomorrow' },
    { maxLevel: 20 },
    { bounds: { west: -999, south: 0, east: 1, north: 1 } },
  ])
    assert.throws(
      () => validateWeatherSnapshot({ ...snapshot(), ...bad }, 'radar'),
      /Malformed/,
    );
});
test('weather tile URLs are same origin and ignore upstream templates', async () => {
  const calls = [];
  const source = createWeatherSource({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        ...snapshot(),
        tileTemplate: 'https://example.invalid/{z}',
      });
    },
  });
  const result = await source.getSnapshot({ product: 'radar' });
  assert.match(
    weatherTileUrl(result.product, result.latest),
    /^\/api\/weather\/tile\?product=radar&time=2026/,
  );
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].url, '/api/weather/manifest?product=radar');
});
test('source aborts before acquisition and caps streamed manifest bytes', async () => {
  let calls = 0;
  const source = createWeatherSource({
    fetchImpl: async () => {
      calls++;
      return new Response(' '.repeat(17000));
    },
  });
  await assert.rejects(source.getSnapshot({ signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  assert.equal(calls, 0);
  await assert.rejects(source.getSnapshot(), /too large/);
});

test('weather tile URLs carry only supported optional pixel sizes', () => {
  assert.equal(
    new URL(
      weatherTileUrl('radar', time),
      'https://example.test',
    ).searchParams.has('size'),
    false,
  );
  for (const size of [256, 512, 1024]) {
    const url = new URL(
      weatherTileUrl('lightning', time, { size }),
      'https://example.test',
    );
    assert.equal(url.searchParams.get('size'), String(size));
    assert.equal(url.searchParams.get('time'), time);
  }
  for (const size of [0, 257, 2048, '1024', null])
    assert.throws(() => weatherTileUrl('radar', time, { size }), /tile size/);
});

test('whole-extent image URLs are same origin and omit the default largest size', () => {
  for (const [product, width] of [
    ['radar', 4096],
    ['clouds-regional', 4096],
    ['clouds', 2048],
    ['lightning', 2048],
  ]) {
    assert.deepEqual(WEATHER_IMAGE_SIZES[product], {
      width,
      height: width / 2,
    });
    assert.equal(
      weatherImageUrl(product, time),
      `/api/weather/image?product=${product}&time=${encodeURIComponent(time)}`,
    );
    assert.equal(
      weatherImageUrl(product, time, { width, height: width / 2 }),
      weatherImageUrl(product, time),
    );
    assert.equal(
      new URL(
        weatherImageUrl(product, time, { width: 1024, height: 512 }),
        'https://example.test',
      ).searchParams.get('size'),
      '1024x512',
    );
  }
  for (const size of [
    { width: 4096, height: 2048 },
    { width: 2048, height: 2048 },
    { width: 512, height: 256 },
    { width: '1024', height: 512 },
  ])
    assert.throws(() => weatherImageUrl('lightning', time, size), /size/);
  assert.throws(() => weatherImageUrl('other', time), /frame/);
  assert.throws(() => weatherImageUrl('radar', 'latest'), /frame/);
});
