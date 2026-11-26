import assert from 'node:assert/strict';
import test from 'node:test';
import { createReferenceSources } from './src/sources/reference.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('the public reference air-quality source answers an unqualified getSnapshot with the available network', async (t) => {
  const saved = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = saved;
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('openaq'))
      return json({
        schemaVersion: 1,
        readings: [
          {
            id: 'openaq:delhi:PM2.5',
            name: 'Delhi',
            parameter: 'PM2.5',
            value: 50,
            observedMs: Date.now() - 60_000,
          },
        ],
      });
    return json({}, 428);
  };
  const source = createReferenceSources()['air-quality'];
  const readings = await source.getSnapshot({});
  assert.equal(readings.length, 1);
  assert.equal((await source.getSnapshot({ provider: 'openaq' })).length, 1);
});
