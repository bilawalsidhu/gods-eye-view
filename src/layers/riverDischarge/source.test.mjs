import assert from 'node:assert/strict';
import test from 'node:test';
import { createRiverDischargeSource } from './source.js';

const box = { south: 10.123456, west: -20, north: 30, east: 40.00004 };
const row = {
  id: '30.025_31.225',
  name: 'Nile',
  lat: 30.025,
  lon: 31.225,
  p50: 900,
  p90: 2000,
  p99: 3000,
  mean: 1000,
  max: 5000,
  series: {
    time: ['2026-10-23', '2026-10-24'],
    discharge: [800, 850],
    median: [800, 840],
    min: [700, 700],
    max: [900, 950],
    p25: [780, 800],
    p75: [820, 870],
  },
};
const payload = (extra = {}) => ({
  today: '2026-10-24',
  climatology: { start: '2012-08-01', end: '2022-07-31' },
  fetchedAt: 123,
  total: 1,
  partial: false,
  points: [row],
  ...extra,
});

test('the source asks the same-origin proxy with a four-decimal box only', async () => {
  const urls = [];
  const source = createRiverDischargeSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json(payload());
    },
  });
  const outlook = await source.getOutlook(box);
  assert.deepEqual(urls, [
    '/api/river-discharge?south=10.1235&west=-20&north=30&east=40',
  ]);
  assert.equal(outlook.today, '2026-10-24');
  assert.deepEqual(outlook.climatology, { from: '2012', to: '2022' });
  assert.equal(outlook.points.length, 1);
  assert.equal(outlook.points[0].name, 'Nile');
  assert.deepEqual(outlook.points[0].series.discharge, [800, 850]);
  assert.equal(outlook.stale, false);
  await assert.rejects(source.getOutlook({ south: 1 }), TypeError);
});

test('invalid rows are dropped and reported as partial', async () => {
  const source = createRiverDischargeSource({
    fetchImpl: async () =>
      Response.json(
        payload({
          points: [row, { ...row, id: 'bad' }, { ...row, series: null }],
          stale: true,
        }),
      ),
  });
  const outlook = await source.getOutlook(box);
  assert.equal(outlook.points.length, 1);
  assert.equal(outlook.partial, true);
  assert.equal(outlook.stale, true);
});

test('failures carry the fixed forms the layer row translates', async () => {
  const fails = async (response, expected) => {
    const source = createRiverDischargeSource({
      fetchImpl: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    });
    await assert.rejects(source.getOutlook(box), (error) => {
      assert.equal(error.message, expected.message);
      if ('retryAfterMs' in expected)
        assert.equal(error.retryAfterMs, expected.retryAfterMs);
      if ('retryable' in expected)
        assert.equal(error.retryable, expected.retryable);
      return true;
    });
  };
  await fails(
    new Response('', { status: 503, headers: { 'Retry-After': '90' } }),
    { message: 'Open-Meteo HTTP 503', retryAfterMs: 90_000, retryable: true },
  );
  await fails(new Response('', { status: 429 }), {
    message: 'Open-Meteo rate limited',
    retryAfterMs: 60_000,
  });
  await fails(new Response('', { status: 400 }), {
    message: 'Open-Meteo HTTP 400',
    retryable: false,
  });
  await fails(new TypeError('fetch failed: ECONNRESET 10.0.0.1'), {
    message: 'Open-Meteo network error',
  });
  await fails(new Response('not json', { status: 200 }), {
    message: 'Malformed Open-Meteo response',
  });
  await fails(Response.json({ points: [] }), {
    message: 'Malformed Open-Meteo response',
  });
});

test('an aborted read rejects with the abort, not a feed error', async () => {
  const controller = new AbortController();
  controller.abort();
  const source = createRiverDischargeSource({
    fetchImpl: async () => Response.json(payload()),
  });
  await assert.rejects(
    source.getOutlook(box, { signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});
