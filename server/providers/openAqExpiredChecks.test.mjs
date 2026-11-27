import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition } from './openAq.js';
import { start, loc, fake } from './openAq.fixture.mjs';

test('expired viewport backlog: a due backlog keeps a progressive retry scheduled', async () => {
  let clock = start;
  const { fetchImpl, calls } = fake({
    clock: () => clock,
    stations: () =>
      Array.from({ length: 12 }, (_, i) => loc(i + 1, 20 + i * 0.1, 0, clock)),
  });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [10, -10, 30, 10, 20, 0];
  let snap;
  for (let i = 0; i < 6; i++) {
    snap = await source.getSnapshot({ view });
    if (!snap.partial) break;
    clock += 8001;
  }
  assert.equal(snap.partial, false);
  clock += 21 * 60_000;
  const before = calls.length;
  snap = await source.getSnapshot({ view });
  assert.ok(
    snap.retryAt !== null && snap.retryAt - clock <= 10_000,
    `refreshed ${calls.length - before} of 12 due; partial=${snap.partial} retryAt=${snap.retryAt === null ? null : snap.retryAt - clock}`,
  );
});
