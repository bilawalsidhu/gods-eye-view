import assert from 'node:assert/strict';
import test from 'node:test';
import { createWildlifeSource } from './source.js';

const STORKS = 21231406;
const animal = {
  id: `${STORKS}:A`,
  study: STORKS,
  name: 'A',
  taxon: 'Ciconia ciconia',
  track: [[8, 48, 1_700_000_000_000]],
};

test('the snapshot reads the same-origin route and sanitizes it', async () => {
  const urls = [];
  const source = createWildlifeSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({
        fetchedAt: 1_700_000_000_000,
        studies: [
          { id: STORKS, status: 'fresh' },
          { id: 1, status: 'ok' },
        ],
        animals: [animal, { id: 'bad' }],
        pending: [],
      });
    },
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(urls, ['/api/wildlife']);
  assert.equal(snapshot.fetchedAt, 1_700_000_000_000);
  assert.deepEqual(
    snapshot.studies.map(({ id, status }) => [id, status]),
    [[STORKS, 'fresh']],
  );
  assert.deepEqual(snapshot.animals, [animal]);
});

test('HTTP failures, malformed bodies and aborts reject', async () => {
  const failing = createWildlifeSource({
    fetchImpl: async () => new Response('{}', { status: 502 }),
  });
  await assert.rejects(failing.getSnapshot(), /HTTP 502/);
  const malformed = createWildlifeSource({
    fetchImpl: async () => Response.json({ studies: 'nope' }),
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed/);
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const aborted = createWildlifeSource({
    fetchImpl: async () => {
      called = true;
      return Response.json({});
    },
  });
  await assert.rejects(aborted.getSnapshot({ signal: controller.signal }));
  assert.equal(called, false);
});
