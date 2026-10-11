import test from 'node:test';
import assert from 'node:assert/strict';
import { createInfrastructureSource } from './infrastructureData.js';
const body = JSON.stringify({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [10, 20] },
  properties: { name: 'Fixture' },
});
test('aborted infrastructure reads cannot leak or poison the cache', async () => {
  let release;
  let calls = 0;
  const controller = new AbortController();
  const source = createInfrastructureSource({
    fetchImpl: async () => {
      calls++;
      return {
        ok: true,
        text: () =>
          calls === 1
            ? new Promise((r) => (release = r))
            : Promise.resolve(body),
      };
    },
  });
  const pending = source.getRecords('local-dams', {
    signal: controller.signal,
  });
  while (!release) await Promise.resolve();
  controller.abort();
  release(body);
  await assert.rejects(pending, { name: 'AbortError' });
  const records = await source.getRecords('local-dams');
  assert.equal(records.length, 1);
  assert.equal(calls, 2);
  await assert.rejects(
    source.getRecords('local-dams', { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal((await source.getRecords('local-dams'))[0].name, 'Fixture');
});
