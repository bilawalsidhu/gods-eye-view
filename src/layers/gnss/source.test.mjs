import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdsbGnssSource } from './source.js';

test('the source asks the same-origin proxy for the view anchor', async () => {
  const calls = [];
  const source = createAdsbGnssSource({
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({
        fetchedAt: 5,
        classifier: 'gev-nic-nacp-v1',
        rows: [{ hex: 'abc123' }],
      });
    },
  });
  const snapshot = await source.getSnapshot(
    { latitude: 50.06143, longitude: 19.93658 },
    { signal: new AbortController().signal },
  );
  assert.deepEqual(calls, ['/api/gnss-integrity?lat=50.06&lon=19.94']);
  assert.deepEqual(snapshot, {
    rows: [{ hex: 'abc123' }],
    fetchedAt: 5,
    stale: false,
    classifier: 'gev-nic-nacp-v1',
  });
});

test('the source reports stale proxy data and rejects bad input or responses', async () => {
  const reply = (body, init) => async () => Response.json(body, init);
  const stale = await createAdsbGnssSource({
    fetchImpl: reply({ rows: [], fetchedAt: 7, stale: true }),
  }).getSnapshot({ latitude: 1, longitude: 2 });
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, 7, 'a stale reply keeps its observation time');
  assert.equal(stale.classifier, null);
  // Without an observation time the rows could only be dated as new.
  for (const fetchedAt of [undefined, null, '7'])
    await assert.rejects(
      createAdsbGnssSource({
        fetchImpl: reply({ rows: [], fetchedAt }),
      }).getSnapshot({ latitude: 1, longitude: 2 }),
      /no observation time/,
    );

  await assert.rejects(
    createAdsbGnssSource({ fetchImpl: reply({}) }).getSnapshot({}),
    /view anchor/,
  );
  await assert.rejects(
    createAdsbGnssSource({
      fetchImpl: reply({ error: 'x' }, { status: 502 }),
    }).getSnapshot({ latitude: 1, longitude: 2 }),
    /HTTP 502/,
  );
  await assert.rejects(
    createAdsbGnssSource({ fetchImpl: reply({ rows: 'no' }) }).getSnapshot({
      latitude: 1,
      longitude: 2,
    }),
    /Malformed/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createAdsbGnssSource({ fetchImpl: reply({ rows: [] }) }).getSnapshot(
      { latitude: 1, longitude: 2 },
      { signal: controller.signal },
    ),
  );
});
