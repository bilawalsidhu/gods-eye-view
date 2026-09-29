import assert from 'node:assert/strict';
import test from 'node:test';
import { createRadiationSource } from './source.js';

const reading = {
  id: 'safecast-2894022651',
  source: 'safecast',
  name: 'Kōriyama',
  country: 'JP',
  lon: 140.3675,
  lat: 37.3579,
  usvh: 0.5,
  cpm: 167,
  atMs: 2,
};

test('the source reads the same-origin proxy and reports missing feeds', async () => {
  const calls = [];
  const source = createRadiationSource({
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({
        fetchedAt: 5,
        feeds: [
          { source: 'safecast', fetchedAt: 5, stale: false },
          { source: 'bfs', fetchedAt: null, stale: false, missing: true },
          { source: '<b>', missing: true },
        ],
        readings: [reading],
        stale: true,
      });
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(calls, ['/api/radiation']);
  assert.deepEqual(snapshot, {
    readings: [reading],
    missing: ['bfs'],
    fetchedAt: 5,
    stale: true,
  });
});

test('the source rejects failed, malformed and aborted reads', async () => {
  const reply = (body, init) => async () => Response.json(body, init);
  const fresh = await createRadiationSource({
    fetchImpl: reply({ readings: [] }),
  }).getSnapshot();
  assert.deepEqual(fresh, {
    readings: [],
    missing: [],
    fetchedAt: null,
    stale: false,
  });
  await assert.rejects(
    createRadiationSource({
      fetchImpl: reply({ error: 'x' }, { status: 502 }),
    }).getSnapshot(),
    /Radiation HTTP 502/,
  );
  await assert.rejects(
    createRadiationSource({
      fetchImpl: reply({ readings: 'no' }),
    }).getSnapshot(),
    /Malformed/,
  );
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  await assert.rejects(
    createRadiationSource({
      fetchImpl: async () => {
        fetched = true;
        return Response.json({ readings: [] });
      },
    }).getSnapshot({ signal: controller.signal }),
  );
  assert.equal(fetched, false);
});
