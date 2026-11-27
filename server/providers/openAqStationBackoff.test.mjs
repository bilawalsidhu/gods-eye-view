import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition } from './openAq.js';
import { start, loc, fake } from './openAq.fixture.mjs';

test('failed station fairness: persistent failures at the four nearest stations do not starve healthy ones', async () => {
  let clock = start;
  const asked = [];
  const { fetchImpl } = fake({
    clock: () => clock,
    stations: () =>
      Array.from({ length: 6 }, (_, i) =>
        loc(i + 1, 20 + (i + 1) * 0.5, 0, clock),
      ),
    fail: (url) => {
      const m = url.pathname.match(/locations\/(\d+)\/latest/);
      if (m) asked.push(Number(m[1]));
      return m && Number(m[1]) <= 4 ? 500 : 0;
    },
  });
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl,
  });
  const view = [10, -10, 30, 10, 20, 0];
  let snap,
    acquired = false;
  for (let i = 0; i < 8; i++) {
    let retryAt;
    try {
      snap = await source.getSnapshot({ view });
      acquired ||= snap.readings.length > 0;
      retryAt = snap.retryAt ?? clock + 60_000;
    } catch (e) {
      // Nothing acquired yet and every check failed: a retryable 503.
      if (e.status !== 503 || acquired) throw e;
      assert.ok(Number.isFinite(e.retryAt), `retryAt=${e.retryAt}`);
      retryAt = e.retryAt;
    }
    clock = Math.max(clock + 1000, retryAt + 1);
  }
  assert.ok(
    snap.readings.length >= 2,
    `readings ${snap.readings.length}; stations asked: ${asked.join(',')}`,
  );
});
