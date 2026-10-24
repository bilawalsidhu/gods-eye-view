import assert from 'node:assert/strict';
import test from 'node:test';
import { createRiverGaugeSource } from './source.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('the snapshot is read from the same-origin proxy and validated', async () => {
  const urls = [];
  const source = createRiverGaugeSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return json({
        generatedAt: '2026-10-24T02:00:00.000Z',
        stale: false,
        regions: { total: 27, failed: [] },
        gauges: [
          {
            lid: 'AAIT2',
            name: 'Williamson Creek',
            lat: 30.2,
            lon: -97.8,
            observed: { stage: 1.9, stageUnit: 'ft', category: 'no_flooding' },
            forecast: null,
          },
        ],
      });
    },
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(urls, ['/api/nwps/gauges']);
  assert.equal(snapshot.gauges[0].id, 'river-gauge:AAIT2');
  assert.equal(source.label, 'NOAA NWPS · OBSERVED');
});

test('failures read in the fixed forms the layer row translates', async () => {
  const fail = (impl) =>
    createRiverGaugeSource({ fetchImpl: impl }).getSnapshot();
  await assert.rejects(
    fail(async () => json({ error: 'nwps_unavailable' }, 503)),
    { message: 'NWPS HTTP 503' },
  );
  await assert.rejects(
    fail(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:4173');
    }),
    { message: 'NWPS network error' },
  );
  await assert.rejects(
    fail(async () => new Response('<html>504</html>')),
    { message: 'Malformed NWPS response' },
  );
  await assert.rejects(
    fail(async () => json({ rows: [] })),
    {
      message: 'Malformed NWPS response',
    },
  );
});

test('a caller abort stays an abort, not a feed error', async () => {
  const controller = new AbortController();
  const source = createRiverGaugeSource({
    fetchImpl: (url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  });
  const pending = source.getSnapshot({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('detail reads only validated ids and checks the answer is that gauge', async () => {
  const urls = [];
  const source = createRiverGaugeSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return json({ lid: url.endsWith('AAIT2') ? 'AAIT2' : 'OTHR1' });
    },
  });
  assert.equal((await source.getGauge('AAIT2')).lid, 'AAIT2');
  await assert.rejects(source.getGauge('../../x'), TypeError);
  await assert.rejects(source.getGauge('aait2'), TypeError);
  await assert.rejects(source.getGauge('BBBB1'), {
    message: 'Malformed NWPS response',
  });
  assert.deepEqual(urls, ['/api/nwps/gauge/AAIT2', '/api/nwps/gauge/BBBB1']);
});
