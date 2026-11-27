import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition } from './openAq.js';
import { start, HOUR, loc, fake } from './openAq.fixture.mjs';

test('catalog metadata precedence: revisiting a view after a day keeps all active stations eligible', async () => {
  let clock = start;
  const stations = () =>
    Array.from({ length: 8 }, (_, i) => loc(i + 1, 19.6 + i * 0.1, 0, clock));
  const { fetchImpl } = fake({ clock: () => clock, stations });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [19, -1, 21, 1, 20, 0];
  let snap;
  for (let i = 0; i < 6; i++) {
    snap = await source.getSnapshot({ view });
    if (!snap.partial) break;
    clock += 8001;
  }
  assert.equal(snap.partial, false);
  assert.equal(snap.readings.length, 8);
  clock += 24 * HOUR;
  const first = await source.getSnapshot({ view });
  clock += 61_000;
  const second = await source.getSnapshot({ view });
  assert.equal(
    second.eligible,
    8,
    `eligible: first pass ${first.eligible}, second pass ${second.eligible}; readings ${second.readings.length}`,
  );
});
