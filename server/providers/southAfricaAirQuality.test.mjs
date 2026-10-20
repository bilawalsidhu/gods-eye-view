import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSaAcquisition,
  southAfricaAirQualityProxy,
} from './southAfricaAirQuality.js';

const regions = [
  {
    regionId: 2,
    name: 'Western Cape',
    stations: [
      {
        stationId: 1,
        name: 'Cape Town',
        active: true,
        location: { latitude: -33.9, longitude: 18.4 },
      },
    ],
  },
];
const latest = [
  {
    stationId: 1,
    regionData: {
      channels: [
        {
          name: 'PM2.5',
          value: 10,
          units: 'µg/m³',
          valid: true,
          active: true,
          datetime: '2026-10-20T12:00:00+02:00',
        },
      ],
    },
  },
];

test('one coalesced national acquisition uses a private session and fixed bulk paths', async () => {
  const calls = [];
  const source = createSaAcquisition({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('GetApiFromBackToken'))
        return Response.json(
          { key: 'test-session' },
          { headers: { 'Set-Cookie': 'session=test; HttpOnly' } },
        );
      assert.equal(options.headers.Cookie, 'session=test');
      assert.equal(options.headers.Authorization, 'test-session');
      assert.equal(options.redirect, 'error');
      const path = JSON.parse(options.body).url;
      return Response.json(path === 'regions' ? regions : latest);
    },
  });
  const results = await Promise.all([
    source.getSnapshot(),
    source.getSnapshot(),
  ]);
  assert.equal(calls.length, 3);
  assert.equal(results[0].stations.length, 1);
  assert.equal(results[0].readings.length, 1);
  assert.ok(!JSON.stringify(results).includes('test-session'));
  assert.match(
    JSON.parse(calls[2].options.body).url,
    /regionsIds=2&timebase=60$/,
  );
  await source.getSnapshot();
  assert.equal(calls.length, 3);
});

test('last-good fallback is marked stale, expires, and failed acquisitions back off', async () => {
  let now = 1_000_000;
  let fail = false;
  let calls = 0;
  const source = createSaAcquisition({
    now: () => now,
    fetchImpl: async (url, options) => {
      calls++;
      if (fail) throw new Error('private upstream error');
      if (url.endsWith('GetApiFromBackToken'))
        return Response.json({ key: 'secret' });
      return Response.json(
        JSON.parse(options.body).url === 'regions' ? regions : latest,
      );
    },
  });
  await source.getSnapshot();
  now += 21 * 60_000;
  fail = true;
  const stale = await source.getSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.readings.length, 1);
  const count = calls;
  await source.getSnapshot();
  assert.equal(calls, count);
  now += 7 * 3600_000;
  await assert.rejects(source.getSnapshot(), /observations unavailable/);
});

test('malformed snapshots never replace good cache', async () => {
  let now = 1;
  let malformed = false;
  const source = createSaAcquisition({
    now: () => now,
    fetchImpl: async (url, options) => {
      if (url.endsWith('GetApiFromBackToken'))
        return Response.json({ key: 'secret' });
      return Response.json(
        JSON.parse(options.body).url === 'regions'
          ? regions
          : malformed
            ? {}
            : latest,
      );
    },
  });
  await source.getSnapshot();
  malformed = true;
  now += 21 * 60_000;
  assert.equal((await source.getSnapshot()).stale, true);
});

test('route rejects arbitrary queries and writes; dev and preview both register', async () => {
  const plugin = southAfricaAirQualityProxy({
    fetchImpl: () => {
      throw Error('must not fetch');
    },
  });
  let handler;
  const middlewares = {
    use(path, fn) {
      assert.equal(path, '/api/air-quality/south-africa');
      handler = fn;
    },
  };
  plugin.configureServer({ middlewares });
  plugin.configurePreviewServer({ middlewares });
  for (const [method, url, expected] of [
    ['POST', '/', 405],
    ['GET', '/?url=evil', 400],
  ]) {
    let status;
    await handler(
      { method, url },
      {
        writeHead(code) {
          status = code;
        },
        end() {},
      },
    );
    assert.equal(status, expected);
  }
});
