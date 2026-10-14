import test from 'node:test';
import assert from 'node:assert/strict';
import { createCabaTrafficSource } from './source.js';

const data = {
  fetchedAt: Date.UTC(2026, 9, 14),
  rows: [
    {
      type: 'Cinemómetro',
      location: 'AV. TEST',
      latitude: -34.6,
      longitude: -58.4,
    },
  ],
};

test('source is inert and forwards cancellation', async () => {
  let calls = 0;
  const controller = new AbortController();
  const source = createCabaTrafficSource({
    fetchImpl: async (url, { signal }) => {
      calls++;
      assert.equal(url, '/api/caba-traffic-enforcement');
      assert.equal(signal, controller.signal);
      return Response.json(data);
    },
  });
  assert.equal(calls, 0);
  assert.equal(
    (await source.getFeatures({ signal: controller.signal })).length,
    1,
  );
  assert.equal(calls, 1);
  controller.abort();
  await assert.rejects(source.getFeatures({ signal: controller.signal }));
  assert.equal(calls, 1);
});

test('failed, malformed and oversized responses reject', async () => {
  for (const response of [
    new Response('unavailable', { status: 502 }),
    Response.json({ rows: [] }),
    new Response('x', {
      headers: { 'content-length': String(5 * 1024 * 1024) },
    }),
  ]) {
    const source = createCabaTrafficSource({ fetchImpl: async () => response });
    await assert.rejects(source.getFeatures());
  }
});
