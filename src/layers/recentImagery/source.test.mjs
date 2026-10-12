import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentImagerySource } from './source.js';

test('imagery source routes catalog, thumbnails and tiles through supplied adapters', async () => {
  const controller = new AbortController();
  const query = { box: { west: 0, east: 1, south: 0, north: 1 }, signal: controller.signal };
  const candidate = { product: 'S30', day: '2026-10-01' };
  const calls = [];
  const fetchImpl = async (...args) => { calls.push(args); return new Response('image'); };
  const source = createRecentImagerySource({
    fetchImpl,
    search: async (request) => {
      assert.equal(request.fetchImpl, fetchImpl);
      assert.equal(request.signal, controller.signal);
      assert.equal(request.box, query.box);
      return [candidate];
    },
    thumbnailUrl: ({ product, day, width }) => `https://imagery.example/${product}/${day}/${width}`,
    tileTemplate: (product, day) => `https://tiles.example/${product}/${day}/{z}/{x}/{y}`,
    credit: 'Example imagery',
  });
  assert.deepEqual(await source.searchHls(query), [candidate]);
  assert.equal(await (await source.getThumbnail(candidate, query.box, { signal: controller.signal })).text(), 'image');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://imagery.example/S30/2026-10-01/256');
  assert.equal(calls[0][1].signal, controller.signal);
  assert.equal(source.getTileTemplate(candidate.product, candidate.day), 'https://tiles.example/S30/2026-10-01/{z}/{x}/{y}');
  assert.equal(source.credit, 'Example imagery');
});

test('cancelled thumbnail acquisition does not return stale responses or retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const source = createRecentImagerySource({
    thumbnailUrl: () => 'https://imagery.example/thumbnail',
    fetchImpl: async () => { calls++; controller.abort(); return new Response('image'); },
  });
  await assert.rejects(source.getThumbnail({}, {}, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(source.getThumbnail({}, {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
