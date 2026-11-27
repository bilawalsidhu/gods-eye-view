import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition } from './openAq.js';
import { start, HOUR, loc, latestRow, fake } from './openAq.fixture.mjs';

test('overlap observation ordering: an older late response does not replace a newer shared reading', async () => {
  const clock = start;
  const pending = [];
  let catalogCalls = 0;
  const base = fake({
    clock: () => clock,
    stations: () => [loc(1, 20, 0, clock)],
    latest: () => new Promise((resolve) => pending.push(resolve)),
  });
  const fetchImpl = (raw, o) => {
    if (new URL(raw).pathname === '/v3/locations') catalogCalls++;
    return base.fetchImpl(raw, o);
  };
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const p1 = source.getSnapshot({ view: [10, -10, 30, 10, 20, 0] });
  const p2 = source.getSnapshot({ view: [11, -10, 29, 10, 20, 0] });
  for (let i = 0; i < 100 && pending.length < 2; i++)
    await new Promise(setImmediate);
  assert.equal(pending.length, 2, 'both views asked the same station');
  pending[1](Response.json({ results: [latestRow(1, clock - 60_000, 9)] }));
  await p2;
  pending[0](
    Response.json({ results: [latestRow(1, clock - HOUR - 60_000, 3)] }),
  );
  await p1;
  const third = await source.getSnapshot({ view: [12, -10, 28, 10, 20, 0] });
  console.log(
    'catalog calls for one shared page:',
    catalogCalls,
    'latest calls:',
    pending.length,
  );
  assert.equal(
    third.readings[0].value,
    9,
    `third view shows value ${third.readings[0].value}`,
  );
});
