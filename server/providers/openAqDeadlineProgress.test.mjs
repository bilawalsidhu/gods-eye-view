import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition } from './openAq.js';
import { start, loc, latestRow, fake } from './openAq.fixture.mjs';

test('viewport deadline partial: the acquisition deadline returns completed stations', async () => {
  const realTimeout = AbortSignal.timeout;
  const deadline = new AbortController();
  AbortSignal.timeout = () => deadline.signal;
  try {
    const { fetchImpl } = fake({
      clock: () => start,
      stations: () => [loc(1, 20, 0, start), loc(2, 20.5, 0, start)],
      latest: (id, { signal }) =>
        id === 1
          ? Response.json({ results: [latestRow(1, start)] })
          : new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
              setTimeout(
                () =>
                  deadline.abort(new DOMException('deadline', 'TimeoutError')),
                20,
              );
            }),
    });
    const source = createOpenAqAcquisition({
      getKey: () => 'fixture',
      now: () => start,
      fetchImpl,
    });
    let error = null,
      snap = null;
    try {
      snap = await source.getSnapshot({ view: [10, -10, 30, 10, 20, 0] });
    } catch (e) {
      error = e;
    }
    assert.equal(
      error,
      null,
      `rejected: ${error?.name} status=${error?.status}`,
    );
    assert.equal(snap.readings.length, 1);
    assert.equal(snap.partial, true);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});
