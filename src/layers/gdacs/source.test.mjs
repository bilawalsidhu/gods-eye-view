import assert from 'node:assert/strict';
import test from 'node:test';
import { createGdacsSource } from './source.js';

const event = {
  id: 'TC-1001',
  type: 'TC',
  eventId: 1001,
  episodeId: 4,
  level: 'red',
  name: 'POLO-26',
  country: 'Japan',
  lon: 140.1,
  lat: 25.2,
  fromMs: 1,
  toMs: 2,
  modifiedMs: 3,
  severity: 'Typhoon',
  current: true,
  reportUrl: 'https://www.gdacs.org/report.aspx?eventid=1001&eventtype=TC',
};

test('the source reads the same-origin proxy and reports missing feeds', async () => {
  const calls = [];
  const source = createGdacsSource({
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({
        fetchedAt: 5,
        feeds: [
          { type: 'TC', fetchedAt: 5, stale: false },
          { type: 'DR', fetchedAt: null, stale: false, missing: true },
          { type: '<b>', missing: true },
        ],
        events: [event],
        stale: true,
      });
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(calls, ['/api/gdacs']);
  assert.deepEqual(snapshot, {
    events: [event],
    missing: ['DR'],
    fetchedAt: 5,
    stale: true,
  });
});

test('the source rejects failed, malformed and aborted reads', async () => {
  const reply = (body, init) => async () => Response.json(body, init);
  const fresh = await createGdacsSource({
    fetchImpl: reply({ events: [] }),
  }).getSnapshot();
  assert.deepEqual(fresh, {
    events: [],
    missing: [],
    fetchedAt: null,
    stale: false,
  });
  await assert.rejects(
    createGdacsSource({
      fetchImpl: reply({ error: 'x' }, { status: 502 }),
    }).getSnapshot(),
    /GDACS HTTP 502/,
  );
  await assert.rejects(
    createGdacsSource({ fetchImpl: reply({ events: 'no' }) }).getSnapshot(),
    /Malformed/,
  );
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  await assert.rejects(
    createGdacsSource({
      fetchImpl: async () => {
        fetched = true;
        return Response.json({ events: [] });
      },
    }).getSnapshot({ signal: controller.signal }),
  );
  assert.equal(fetched, false);
});
