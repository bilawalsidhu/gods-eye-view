import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaterQualitySource } from './source.js';
import { DEFAULT_FAMILY } from './policy.js';

const box = { south: 34.0, west: -79.2, north: 35.4, east: -77.8 };

test('site reads validate the viewport before spending a request', async () => {
  const calls = [];
  const source = createWaterQualitySource({
    fetchImpl: async (url) => {
      calls.push(new URL(url, 'https://example.test'));
      return Response.json({ sites: [] });
    },
  });
  for (const invalid of [
    null,
    { ...box, east: Infinity },
    { ...box, north: 91 },
    { ...box, south: 36 },
    { ...box, east: -60 },
  ])
    await assert.rejects(
      source.getStations(invalid),
      /bounded water-quality viewport/,
    );
  assert.equal(calls.length, 0);
  await source.getStations(box, { family: 'pfas', sinceYears: 3 });
  assert.equal(calls[0].pathname, '/api/water-quality/sites');
  assert.equal(calls[0].searchParams.get('south'), '34.00000');
  assert.equal(calls[0].searchParams.get('family'), 'pfas');
  assert.equal(calls[0].searchParams.get('sinceYears'), '3');
});

test('an unlisted analyte family can never reach the proxy', async () => {
  const calls = [];
  const source = createWaterQualitySource({
    fetchImpl: async (url) => {
      calls.push(new URL(url, 'https://example.test'));
      return Response.json({ sites: [], measurements: [] });
    },
  });
  await source.getStations(box, { family: 'Organics, PFAS; drop table' });
  await source.getResults('SITE-1', { family: '../../etc' });
  // Falls back to the configured default rather than to whatever was asked.
  for (const call of calls)
    assert.equal(call.searchParams.get('family'), DEFAULT_FAMILY);
});

test('malformed snapshots are never accepted as empty success', async () => {
  const source = createWaterQualitySource({
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(
    source.getStations(box),
    /Malformed water-quality site snapshot/,
  );
  await assert.rejects(
    source.getResults('SITE-1'),
    /Malformed water-quality result snapshot/,
  );
  await assert.rejects(
    source.getResults('   '),
    /monitoring site identifier is required/,
  );
});

test('site reads normalize counts, saturation and the sampling window', async () => {
  const source = createWaterQualitySource({
    fetchImpl: async () =>
      Response.json({
        sites: [
          {
            id: 'WATERKEEPER-CAP-1',
            name: 'Cape Fear River',
            latitude: 34.79584,
            longitude: -78.80513,
            resultCount: 12,
          },
        ],
        totalSiteCount: 42,
        saturated: true,
        sampledSince: '2021-09-18',
        status: 'cached',
      }),
  });
  const payload = await source.getStations(box);
  assert.equal(payload.sites[0].name, 'Cape Fear River');
  assert.equal(payload.totalSiteCount, 42);
  assert.equal(payload.saturated, true);
  assert.equal(payload.sampledSince, '2021-09-18');
  assert.equal(payload.status, 'cached');
});

test('upstream failures carry a classified reason rather than a bare message', async () => {
  const source = createWaterQualitySource({
    fetchImpl: async () =>
      Response.json(
        { error: 'Water quality monitoring data is temporarily unavailable', reason: 'rate_limited' },
        { status: 503 },
      ),
  });
  await assert.rejects(source.getStations(box), (error) => {
    assert.equal(error.failureReason, 'rate_limited');
    return true;
  });
});

test('result parsing respects cancellation before the payload is admitted', async () => {
  const controller = new AbortController();
  const source = createWaterQualitySource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { measurements: [] };
      },
    }),
  });
  await assert.rejects(
    source.getResults('SITE-1', { signal: controller.signal }),
    { name: 'AbortError' },
  );
});
