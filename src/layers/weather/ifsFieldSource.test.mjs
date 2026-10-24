import assert from 'node:assert/strict';
import test from 'node:test';
import { createIfsFieldSource } from './ifsFieldSource.js';

const GRID_BYTES = 1440 * 721 * 4;

/** A source whose grid response declares `declared` bytes. */
function sourceWith(components, declared) {
  const decoded = [];
  const feed = createIfsFieldSource({
    route: '/api/field',
    errorPrefix: 'Field',
    networkError: 'Field network error',
    malformed: 'Malformed field response',
    parse: () => ({ gridUrl: '/api/field/grid/a.bin', grid: {} }),
    decode: (buffer) => (decoded.push(buffer.byteLength), {}),
    components,
    fetchImpl: async (url) =>
      url === '/api/field'
        ? Response.json({})
        : new Response(new Uint8Array(8), {
            headers: { 'content-length': String(declared) },
          }),
  });
  return { decoded, feed };
}

test('the grid read is bounded by the number of components the route serves', async () => {
  const one = sourceWith(1, GRID_BYTES + 4);
  await assert.rejects(one.feed.getSnapshot(), /Malformed field response/);
  assert.equal(one.decoded.length, 0, 'one component: refused unread');
  const two = sourceWith(2, GRID_BYTES + 4);
  await two.feed.getSnapshot();
  assert.equal(two.decoded.length, 1, 'two components: within the bound');
});
