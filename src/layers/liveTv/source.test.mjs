import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveTvSource } from './source.js';

const country = {
  code: 'PL',
  name: 'Poland',
  lon: 19.4,
  lat: 52.1,
  channels: 1,
};
const channel = {
  id: 'News.pl',
  name: 'News',
  categories: ['news'],
  streams: [{ url: 'https://news.example/live.m3u8', quality: '', labels: [] }],
};

test('the snapshot reads the same-origin index and sanitizes it', async () => {
  const urls = [];
  const source = createLiveTvSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({
        fetchedAt: 1_700_000_000_000,
        stale: true,
        countries: [country, { code: 'bad' }],
      });
    },
  });
  assert.deepEqual(await source.getSnapshot(), {
    countries: [country],
    fetchedAt: 1_700_000_000_000,
    stale: true,
  });
  assert.deepEqual(urls, ['/api/live-tv']);
});

test('a country page is requested by code and must answer for that code', async () => {
  const urls = [];
  let answer = 'PL';
  const source = createLiveTvSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({ code: answer, channels: [channel] });
    },
  });
  assert.deepEqual(await source.getCountry('PL'), {
    code: 'PL',
    channels: [channel],
  });
  answer = 'DE';
  await assert.rejects(source.getCountry('PL'), /Malformed/);
  await assert.rejects(source.getCountry('../PL'), TypeError);
  assert.deepEqual(urls, [
    '/api/live-tv/country/PL',
    '/api/live-tv/country/PL',
  ]);
});

test('HTTP failures, malformed bodies and aborts reject', async () => {
  const failing = createLiveTvSource({
    fetchImpl: async () => new Response('{}', { status: 502 }),
  });
  await assert.rejects(failing.getSnapshot(), /HTTP 502/);
  await assert.rejects(failing.getCountry('PL'), /HTTP 502/);
  const malformed = createLiveTvSource({
    fetchImpl: async () => Response.json({ countries: 'nope' }),
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed/);
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const aborted = createLiveTvSource({
    fetchImpl: async () => {
      called = true;
      return Response.json({});
    },
  });
  await assert.rejects(aborted.getSnapshot({ signal: controller.signal }));
  assert.equal(called, false);
});
