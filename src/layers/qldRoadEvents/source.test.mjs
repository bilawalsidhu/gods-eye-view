import test from 'node:test';
import assert from 'node:assert/strict';
import { createQldRoadEventsSource } from './source.js';

test('the source reads the same-origin proxy and returns its events', async () => {
  const calls = [];
  const source = createQldRoadEventsSource({
    fetchImpl: async (url, options) => {
      calls.push([url, options.signal]);
      return Response.json({
        events: [{ id: '1' }],
        stale: true,
        fetchedAt: 5,
      });
    },
  });
  const controller = new AbortController();
  assert.deepEqual(await source.getSnapshot({ signal: controller.signal }), {
    events: [{ id: '1' }],
    stale: true,
    fetchedAt: 5,
  });
  assert.deepEqual(calls, [['/api/qld-road-events', controller.signal]]);
});

test('the source rejects HTTP errors, malformed payloads and aborted requests', async () => {
  const failing = createQldRoadEventsSource({
    fetchImpl: async () => Response.json({ error: 'x' }, { status: 502 }),
  });
  await assert.rejects(failing.getSnapshot(), /HTTP 502/);
  const malformed = createQldRoadEventsSource({
    fetchImpl: async () => Response.json({ events: 'nope' }),
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createQldRoadEventsSource({
      fetchImpl: async () => assert.fail('must not fetch'),
    }).getSnapshot({ signal: controller.signal }),
  );
});
