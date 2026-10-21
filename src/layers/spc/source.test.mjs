import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpcOutlookSource } from './source.js';
import { NOW, feature, payload } from './fixtures.test-support.mjs';

test('source uses fixed same-origin product route, normalizes and propagates cancellation', async () => {
  const controller = new AbortController();
  let requestSignal;
  const source = createSpcOutlookSource({
    fetchImpl: async (url, { signal }) => {
      assert.equal(url, '/api/spc-outlooks/day2-categorical');
      requestSignal = signal;
      return Response.json({ ...payload(feature()), stale: true });
    },
  });
  const snapshot = await source.getSnapshot({
    product: 'day2-categorical',
    signal: controller.signal,
  });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.fetchedAt, NOW);
  controller.abort();
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(source.getSnapshot({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('source rejects invalid products, upstream errors, invalid clocks and malformed bodies', async () => {
  const source = createSpcOutlookSource({
    fetchImpl: () => {
      throw new Error('must not fetch');
    },
  });
  await assert.rejects(
    source.getSnapshot({ product: '../bad' }),
    /Invalid SPC product/,
  );
  for (const response of [
    new Response('private', { status: 502 }),
    Response.json({}),
    Response.json({ ...payload(feature()), fetchedAt: undefined }),
    new Response('not json'),
  ]) {
    await assert.rejects(
      createSpcOutlookSource({ fetchImpl: async () => response }).getSnapshot(),
    );
  }
});
